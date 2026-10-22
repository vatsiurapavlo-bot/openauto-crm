/** Google Drive i kopie zapasowe — dostępne tylko dla ról z uprawnieniem backup.manage (Właściciel, Administrator). */
import type { AnthropicConfig } from '../integrations/anthropic/cost-parser.ts';
import type { PoolLike } from '../db/types.ts';
import type { SessionInfo } from '../auth/sessions.ts';
import { HttpError, badRequest } from '../http/core.ts';
import { decrypt, encrypt, masterKeyStatus, signState, verifyState } from '../crypto/secrets.ts';
import { DriveClient, authorizationUrl, exchangeCode, revokeToken, type GoogleConfig } from '../integrations/google/drive.ts';
import type { BackupService } from './backup.ts';
import type { Ctx } from './context.ts';

export interface SystemDeps {
  backup: BackupService | null;
  google: GoogleConfig | null;
  adminPool: PoolLike | null;
  /** Claude API — rozpoznawanie podyktowanych kosztów; null = funkcja wyłączona */
  anthropic?: AnthropicConfig | null;
}

/**
 * Dysk i kopie dotyczą całej instalacji (wszystkich przestrzeni), więc zarządza nimi wyłącznie
 * Właściciel głównej przestrzeni (najstarszej — OpenAuto), a nie każdy z uprawnieniem backup.manage.
 */
async function requireInstallationOwner(session: SessionInfo, perms: Set<string>, deps: SystemDeps) {
  if (!perms.has('backup.manage') || session.role !== 'owner') {
    throw new HttpError(403, 'Kopiami i Google Drive zarządza tylko Właściciel', 'forbidden');
  }
  if (!deps.adminPool) return;
  const { rows } = await deps.adminPool.query<{ id: string }>('SELECT id FROM workspaces ORDER BY created_at LIMIT 1');
  if (rows[0]?.id !== session.workspaceId) {
    throw new HttpError(403, 'Kopiami zarządza Właściciel głównej przestrzeni roboczej', 'forbidden');
  }
}

const unavailable = (what: string) => new HttpError(503, `${what} — brak połączenia administracyjnego z bazą`, 'unavailable');

export async function backupStatus(ctx: Ctx, deps: SystemDeps) {
  await requireInstallationOwner(ctx.session, ctx.perms, deps);
  if (!deps.backup) throw unavailable('Kopie zapasowe niedostępne');
  return deps.backup.status();
}

export async function runBackupNow(ctx: Ctx, deps: SystemDeps) {
  await requireInstallationOwner(ctx.session, ctx.perms, deps);
  if (!deps.backup) throw unavailable('Kopie zapasowe niedostępne');
  try {
    return await deps.backup.run('manual', ctx.session.userId);
  } catch (e: any) {
    throw new HttpError(e?.message === 'Kopia zapasowa już trwa' ? 409 : 502, e?.message ?? 'Kopia nie powiodła się');
  }
}

export async function googleConnectUrl(ctx: Ctx, deps: SystemDeps) {
  await requireInstallationOwner(ctx.session, ctx.perms, deps);
  if (!deps.google) {
    throw badRequest('Google nie jest skonfigurowany: ustaw GOOGLE_CLIENT_ID i GOOGLE_CLIENT_SECRET w Railway (instrukcja, krok 5).');
  }
  if (masterKeyStatus() !== 'ok') throw badRequest('Najpierw ustaw OPENAUTO_MASTER_KEY (instrukcja, krok 3).');
  const state = signState({ u: ctx.session.userId, s: ctx.session.sessionId });
  return { url: authorizationUrl(deps.google, state) };
}

/** Powrót z Google po udzieleniu zgody. Zwraca ścieżkę, na którą przekierować przeglądarkę. */
export async function googleCallback(session: SessionInfo | null, query: URLSearchParams, deps: SystemDeps, perms: Set<string>): Promise<string> {
  const fail = (code: string) => `/ustawienia?drive=${code}`;
  if (!session) return '/';
  try {
    await requireInstallationOwner(session, perms, deps);
  } catch {
    return fail('brak-uprawnien');
  }
  if (query.get('error')) return fail('anulowano');
  const state = verifyState<{ u: string; s: string }>(query.get('state') ?? '');
  if (!state || state.u !== session.userId || state.s !== session.sessionId) return fail('niewazny-link');
  if (!deps.google || !deps.adminPool) return fail('brak-konfiguracji');
  const code = query.get('code');
  if (!code) return fail('blad');
  try {
    const { refreshToken, email } = await exchangeCode(deps.google, code);
    const folders = await new DriveClient(deps.google, refreshToken).ensureStructure();
    await deps.adminPool.query(
      `INSERT INTO system_integrations (provider, account_email, encrypted_token, folders, connected_by)
       VALUES ('google_drive', $1, $2, $3, $4)
       ON CONFLICT (provider) DO UPDATE SET account_email = EXCLUDED.account_email, encrypted_token = EXCLUDED.encrypted_token,
         folders = EXCLUDED.folders, connected_by = EXCLUDED.connected_by, connected_at = now(), last_error = NULL, last_error_at = NULL`,
      [email, encrypt(Buffer.from(refreshToken, 'utf8'), 'token'), folders, session.userId],
    );
    return '/ustawienia?drive=polaczono';
  } catch (e: any) {
    console.error('Google Drive — łączenie nieudane:', e?.message ?? e);
    return fail('blad');
  }
}

export async function googleDisconnect(ctx: Ctx, deps: SystemDeps) {
  await requireInstallationOwner(ctx.session, ctx.perms, deps);
  if (!deps.adminPool) throw unavailable('Odłączenie niemożliwe');
  const { rows } = await deps.adminPool.query<{ encrypted_token: Buffer }>(
    "SELECT encrypted_token FROM system_integrations WHERE provider = 'google_drive'",
  );
  if (rows[0] && deps.google) {
    try {
      await revokeToken(deps.google, decrypt(Buffer.from(rows[0].encrypted_token), 'token').toString('utf8'));
    } catch {
      /* token mógł już wygasnąć — usuwamy i tak */
    }
  }
  await deps.adminPool.query("DELETE FROM system_integrations WHERE provider = 'google_drive'");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Kontrola przed uruchomieniem z prawdziwymi danymi + zatwierdzenie przez Właściciela
// ---------------------------------------------------------------------------

export interface LaunchCheck {
  id: string;
  label: string;
  ok: boolean;
  critical: boolean;
  detail?: string;
}

export interface LaunchEnv {
  secureRequest: boolean;
  secureCookies: boolean;
  environmentName: string | null;
  isProduction: boolean;
  dbRoleProblem: string | null;
}

export async function launchConfirmation(pool: { query: PoolLike['query'] }) {
  const { rows } = await pool.query<{ value: any; updated_at: Date }>(
    "SELECT value, updated_at FROM system_settings WHERE key = 'production_confirmed'",
  );
  return rows[0] ? { at: new Date(rows[0].updated_at).toISOString(), by: rows[0].value?.by ?? null } : null;
}

export async function launchChecks(ctx: Ctx, deps: SystemDeps, env: LaunchEnv) {
  await requireInstallationOwner(ctx.session, ctx.perms, deps);
  const checks: LaunchCheck[] = [];
  const add = (id: string, label: string, ok: boolean, detail?: string, critical = true) =>
    checks.push({ id, label, ok, detail, critical });

  add('https', 'Połączenie szyfrowane (HTTPS)', env.secureRequest);
  add('cookies', 'Ciasteczko sesji tylko przez HTTPS', env.secureCookies);
  add('environment', 'Środowisko produkcyjne (nie podgląd zmian)', env.environmentName ? env.environmentName === 'production' : env.isProduction,
    env.environmentName ?? (env.isProduction ? 'production' : 'development'));
  add('db-role', 'Baza egzekwuje uprawnienia (RLS)', env.dbRoleProblem === null, env.dbRoleProblem ?? 'rola openauto_app bez omijania RLS');

  const { rows } = await ctx.q.query<{ must_change_password: boolean }>('SELECT must_change_password FROM users WHERE id = $1', [
    ctx.session.userId,
  ]);
  add('owner-password', 'Właściciel ustawił własne hasło', rows[0]?.must_change_password === false);
  add('bootstrap-var', 'Usunięto zmienną BOOTSTRAP_OWNER_PASSWORD w Railway', !process.env.BOOTSTRAP_OWNER_PASSWORD,
    process.env.BOOTSTRAP_OWNER_PASSWORD ? 'hasło startowe nadal zapisane w zmiennych' : undefined, false);

  if (deps.backup) {
    const st = await deps.backup.status();
    add('master-key', 'Klucz szyfrowania kopii (OPENAUTO_MASTER_KEY)', st.masterKey === 'ok');
    add('drive', 'Google Drive połączony', !!st.drive, st.drive?.accountEmail ?? undefined);
    add('pg-dump', 'Narzędzie kopii zgodne z bazą', st.pgDump.compatible === true, st.pgDump.message ?? st.pgDump.version ?? undefined);
    add('schedule', 'Automatyczna kopia codzienna', st.scheduleEnabled);
    const age = st.lastOk ? (Date.now() - Date.parse(st.lastOk)) / 3.6e6 : Infinity;
    add('backup-fresh', 'Udana kopia z ostatnich 26 godzin', age < 26, st.lastOk ?? 'jeszcze nie było');
  } else {
    add('backup', 'Kopie zapasowe dostępne', false, 'brak połączenia administracyjnego');
  }
  const confirmed = deps.adminPool ? await launchConfirmation(deps.adminPool) : null;
  return { checks, ready: checks.every((c) => c.ok || !c.critical), confirmed };
}

export async function confirmLaunch(ctx: Ctx, deps: SystemDeps, env: LaunchEnv, body: unknown) {
  const manual = (body ?? {}) as Record<string, unknown>;
  if (manual.railwayBackups !== true || manual.dbPrivate !== true || manual.keyStored !== true) {
    throw badRequest('Potwierdź wszystkie punkty sprawdzane ręcznie');
  }
  const result = await launchChecks(ctx, deps, env);
  if (!result.ready) {
    const failed = result.checks.filter((c) => c.critical && !c.ok).map((c) => c.label);
    throw new HttpError(409, `Nie wszystkie kontrole są spełnione: ${failed.join(', ')}`, 'checks_failed');
  }
  await deps.adminPool!.query(
    `INSERT INTO system_settings (key, value, updated_by) VALUES ('production_confirmed', $1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [{ by: ctx.session.fullName, email: ctx.session.email, checks: result.checks.map((c) => `${c.ok ? '✓' : '✗'} ${c.label}`) }, ctx.session.userId],
  );
  return { ok: true };
}
