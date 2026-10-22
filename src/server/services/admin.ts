import { z } from 'zod';
import { FUEL_TYPES, GEARBOX_TYPES, PURCHASE_TYPES, type Me, type Meta } from '../../shared/types.ts';
import { ROLE_LABELS } from '../../shared/permissions.ts';
import { hashPassword, validatePasswordStrength, verifyPassword } from '../auth/password.ts';
import { LoginRateLimiter, revokeAllUserSessions } from '../auth/sessions.ts';
import { HttpError } from '../http/core.ts';

// Zmiana hasła wymaga podania obecnego — ograniczamy liczbę prób (5 / 15 min na użytkownika)
const passwordChangeLimiter = new LoginRateLimiter({ pair: 5, ip: 5, email: 5 });
import { badRequest, conflict } from '../http/core.ts';
import { type Ctx, requirePerm } from './context.ts';
import { parseOrThrow } from './cars.ts';

export function me(ctx: Ctx): Omit<Me, 'mode' | 'environment'> {
  const s = ctx.session;
  return {
    user: { id: s.userId, email: s.email, fullName: s.fullName },
    workspace: { id: s.workspaceId, code: s.workspaceCode, name: s.workspaceName },
    role: s.role,
    mustChangePassword: s.mustChangePassword,
    roleName: ROLE_LABELS[s.role] ?? s.role,
    permissions: [...ctx.perms].sort(),
  };
}

export async function getMeta(ctx: Ctx): Promise<Meta> {
  // zapytania kolejno — jedno połączenie transakcji nie wykonuje zapytań równolegle
  const { rows: statuses } = await ctx.q.query(
    `SELECT id, kind, system_code AS "systemCode", name, color, sort_order AS "sortOrder",
            is_closed AS "isClosed", is_default AS "isDefault", active
     FROM car_statuses ORDER BY kind, sort_order, name`,
  );
  const { rows: countries } = await ctx.q.query(
    `SELECT trim(code) AS code, name, currency, active FROM countries ORDER BY sort_order, name`,
  );
  const { rows: costCategories } = await ctx.q.query(
    `SELECT id, system_code AS "systemCode", name, active FROM cost_categories ORDER BY sort_order, name`,
  );
  const { rows: vatRates } = await ctx.q.query(
    `SELECT id, label, rate::text AS rate, active FROM vat_rates
     WHERE valid_from <= CURRENT_DATE AND (valid_to IS NULL OR valid_to >= CURRENT_DATE) ORDER BY sort_order, rate`,
  );
  // RLS: rola bez kasa.view nie widzi wiersza → null
  const kasa = await ctx.q.query<{ d: string }>('SELECT data_poczatkowa::text AS d FROM kasa_accounts');
  return {
    statuses,
    countries,
    costCategories,
    vatRates,
    kasaOd: kasa.rows[0]?.d ?? null,
    voiceEnabled: false, // ustawiane w app.ts (zależy od konfiguracji serwera)
    fuelTypes: FUEL_TYPES,
    gearboxTypes: GEARBOX_TYPES,
    purchaseTypes: PURCHASE_TYPES,
  };
}

export async function listUsers(ctx: Ctx) {
  requirePerm(ctx, 'users.manage');
  const { rows } = await ctx.q.query(
    `SELECT u.id, u.email, u.full_name AS "fullName", m.role_code AS role, m.active AND u.is_active AS active,
            u.last_login_at AS "lastLoginAt", m.created_at AS "createdAt"
     FROM workspace_members m JOIN users u ON u.id = m.user_id
     ORDER BY m.created_at`,
  );
  return rows.map((r: any) => ({ ...r, roleName: ROLE_LABELS[r.role] ?? r.role }));
}

const createUserSchema = z
  .object({
    email: z.string().trim().toLowerCase().email('Nieprawidłowy e-mail').max(200),
    fullName: z.string().trim().min(2, 'Podaj imię i nazwisko').max(120),
    role: z.string().regex(/^[a-z_]+$/),
    password: z.string().max(200),
  })
  .strict();

/** Właściciel / administrator tworzy konto z hasłem tymczasowym (zaproszenia linkiem — Etap 6). */
export async function createUser(ctx: Ctx, input: unknown) {
  requirePerm(ctx, 'users.manage');
  const data = parseOrThrow(createUserSchema, input);
  const weak = validatePasswordStrength(data.password);
  if (weak) throw badRequest(weak, { fields: { password: weak } });
  if (data.role === 'owner' && ctx.session.role !== 'owner') throw badRequest('Tylko właściciel może nadać rolę Właściciel');
  const role = await ctx.q.query('SELECT 1 FROM roles WHERE workspace_id = app_workspace() AND code = $1', [data.role]);
  if (!role.rowCount) throw badRequest('Nieznana rola');

  const existing = await ctx.q.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [data.email]);
  let userId = existing.rows[0]?.id;
  if (userId) {
    const member = await ctx.q.query('SELECT 1 FROM workspace_members WHERE workspace_id = app_workspace() AND user_id = $1', [userId]);
    if (member.rowCount) throw conflict('Ten użytkownik już ma dostęp do tej przestrzeni');
    // Konto z tym e-mailem istnieje w innej przestrzeni. Nie dołączamy go po cichu — hasło ustawił ktoś inny,
    // a e-mail nie musi należeć do osoby, którą chcesz dodać. Dostęp do kolejnej przestrzeni: zaproszenie (Etap 6).
    throw new HttpError(
      409,
      'Konto z tym e-mailem już istnieje w innej przestrzeni roboczej. Podaj inny e-mail albo dodaj tę osobę przez zaproszenie.',
      'conflict',
      { fields: { email: 'Konto już istnieje' } },
    );
  } else {
    const hash = await hashPassword(data.password);
    const ins = await ctx.q.query<{ id: string }>(
      // hasło tymczasowe od właściciela — użytkownik musi je zmienić przy pierwszym logowaniu
      'INSERT INTO users (email, full_name, password_hash, must_change_password) VALUES ($1, $2, $3, true) RETURNING id',
      [data.email, data.fullName, hash],
    );
    userId = ins.rows[0].id;
  }
  await ctx.q.query('INSERT INTO workspace_members (workspace_id, user_id, role_code) VALUES (app_workspace(), $1, $2)', [
    userId,
    data.role,
  ]);
  return { id: userId, email: data.email, fullName: data.fullName, role: data.role };
}

const changePasswordSchema = z.object({ currentPassword: z.string().max(200), newPassword: z.string().max(200) }).strict();

export async function changeOwnPassword(ctx: Ctx, input: unknown) {
  const data = parseOrThrow(changePasswordSchema, input);
  const key = ctx.session.userId;
  if (!passwordChangeLimiter.tryAttempt(key, key)) throw new HttpError(429, 'Zbyt wiele prób. Spróbuj za 15 minut.');
  const { rows } = await ctx.q.query<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [
    ctx.session.userId,
  ]);
  if (!(await verifyPassword(data.currentPassword, rows[0]?.password_hash ?? null))) {
    await ctx.q.query('SELECT app_log_auth_event($1, $2, $3, $4)', [
      ctx.session.workspaceId,
      ctx.session.userId,
      'LOGIN_FAILED',
      { reason: 'zmiana_hasla' },
    ]);
    throw badRequest('Obecne hasło jest nieprawidłowe', { fields: { currentPassword: 'Nieprawidłowe hasło' } });
  }
  const weak = validatePasswordStrength(data.newPassword);
  if (weak) throw badRequest(weak, { fields: { newPassword: weak } });
  if (data.newPassword === data.currentPassword) {
    throw badRequest('Nowe hasło musi być inne niż obecne', { fields: { newPassword: 'Takie samo jak obecne' } });
  }
  passwordChangeLimiter.success(key, key);
  await ctx.q.query('UPDATE users SET password_hash = $2, must_change_password = false WHERE id = $1', [
    ctx.session.userId,
    await hashPassword(data.newPassword),
  ]);
  await revokeAllUserSessions(ctx.q, ctx.session.userId, ctx.session.sessionId);
  await ctx.q.query('SELECT app_log_auth_event($1, $2, $3, $4)', [ctx.session.workspaceId, ctx.session.userId, 'PASSWORD_CHANGED', {}]);
}

const changeEmailSchema = z
  .object({
    currentPassword: z.string().max(200),
    newEmail: z.string().trim().toLowerCase().email('Nieprawidłowy e-mail').max(200),
  })
  .strict();

/**
 * Zmiana własnego adresu e-mail (loginu). Wymaga obecnego hasła; ten sam limit prób co zmiana hasła.
 * Po zmianie pozostałe sesje użytkownika są wylogowane (jak przy zmianie hasła).
 */
export async function changeOwnEmail(ctx: Ctx, input: unknown): Promise<{ email: string }> {
  const data = parseOrThrow(changeEmailSchema, input);
  const key = ctx.session.userId;
  if (!passwordChangeLimiter.tryAttempt(key, key)) throw new HttpError(429, 'Zbyt wiele prób. Spróbuj za 15 minut.');
  const { rows } = await ctx.q.query<{ password_hash: string; email: string }>(
    'SELECT password_hash, email FROM users WHERE id = $1',
    [ctx.session.userId],
  );
  if (!(await verifyPassword(data.currentPassword, rows[0]?.password_hash ?? null))) {
    await ctx.q.query('SELECT app_log_auth_event($1, $2, $3, $4)', [
      ctx.session.workspaceId,
      ctx.session.userId,
      'LOGIN_FAILED',
      { reason: 'zmiana_emaila' },
    ]);
    throw badRequest('Obecne hasło jest nieprawidłowe', { fields: { currentPassword: 'Nieprawidłowe hasło' } });
  }
  const oldEmail = rows[0].email;
  // Każda nieudana próba (także „ten sam” / „zajęty”) zużywa limit — nie da się masowo sprawdzać,
  // które adresy mają konto. Licznik zerujemy dopiero po udanej zmianie.
  if (data.newEmail === oldEmail) {
    throw badRequest('To jest Twój obecny e-mail', { fields: { newEmail: 'Taki sam jak obecny' } });
  }
  const taken = () =>
    new HttpError(409, 'Ten e-mail jest już używany przez inne konto', 'conflict', { fields: { newEmail: 'Zajęty' } });
  if ((await ctx.q.query('SELECT 1 FROM users WHERE email = $1', [data.newEmail])).rowCount) throw taken();
  try {
    await ctx.q.query('UPDATE users SET email = $2 WHERE id = $1', [ctx.session.userId, data.newEmail]);
  } catch (e) {
    if ((e as { code?: string }).code === '23505') throw taken(); // równoczesna zmiana na ten sam adres
    throw e;
  }
  await revokeAllUserSessions(ctx.q, ctx.session.userId, ctx.session.sessionId);
  await ctx.q.query('SELECT app_log_email_changed($1)', [{ from: oldEmail, to: data.newEmail }]);
  passwordChangeLimiter.success(key, key);
  return { email: data.newEmail };
}

export async function listAudit(ctx: Ctx, opts: { entity?: string; entityId?: string; limit?: number }) {
  requirePerm(ctx, 'audit.view');
  const { rows } = await ctx.q.query(
    `SELECT a.id, a.action, a.entity, a.entity_id AS "entityId", a.before, a.after, a.at, u.full_name AS "userName"
     FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
     WHERE ($1::text IS NULL OR a.entity = $1) AND ($2::text IS NULL OR a.entity_id = $2)
     ORDER BY a.at DESC, a.id DESC LIMIT $3`,
    [opts.entity ?? null, opts.entityId ?? null, Math.min(opts.limit ?? 100, 500)],
  );
  return rows.map((r: any) => ({ ...r, id: Number(r.id), changes: diff(r.before, r.after) }));
}

function diff(before: any, after: any): Array<{ field: string; from: unknown; to: unknown }> {
  if (!before || !after) return [];
  const skip = new Set(['version', 'updated_at']);
  return Object.keys(after)
    .filter((k) => !skip.has(k) && JSON.stringify(before[k]) !== JSON.stringify(after[k]))
    .map((k) => ({ field: k, from: before[k], to: after[k] }));
}
