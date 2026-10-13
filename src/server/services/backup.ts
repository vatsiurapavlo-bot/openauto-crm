/**
 * Automatyczne, zaszyfrowane kopie zapasowe bazy na Google Drive.
 *
 *  1. pg_dump (format custom) — połączeniem administracyjnym (pełna baza, bez filtrów RLS),
 *  2. szyfrowanie AES-256-GCM kluczem z OPENAUTO_MASTER_KEY,
 *  3. wysłanie do "OpenAuto CRM/Backups" na Dysku,
 *  4. usunięcie najstarszych kopii ponad limit (domyślnie 60).
 *
 * Każde uruchomienie zapisywane jest w backup_runs. Równoległe uruchomienia blokuje
 * advisory lock w PostgreSQL. Odtworzenie: src/server/cli/restore.ts.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PoolLike } from '../db/types.ts';
import { decrypt, encrypt, masterKeyStatus } from '../crypto/secrets.ts';
import { DriveClient, type GoogleConfig } from '../integrations/google/drive.ts';

const LOCK_ID = 727002;
export const BACKUP_EXTENSION = '.oabak';

export interface BackupRun {
  id: number;
  trigger: 'auto' | 'manual';
  status: 'running' | 'ok' | 'error';
  startedAt: string;
  finishedAt: string | null;
  fileName: string | null;
  sizeBytes: number | null;
  error: string | null;
}

export interface DriveConnection {
  accountEmail: string | null;
  folders: Record<string, string>;
  connectedAt: string;
  lastError: string | null;
}

export interface BackupStatus {
  enabled: boolean;
  scheduleEnabled: boolean;
  masterKey: 'ok' | 'missing' | 'too_short';
  googleConfigured: boolean;
  drive: DriveConnection | null;
  pgDump: { available: boolean; version: string | null; compatible: boolean | null; message?: string };
  keep: number;
  runs: BackupRun[];
  lastOk: string | null;
}

export interface BackupOptions {
  adminPool: PoolLike;
  adminUrl: string;
  google: GoogleConfig | null;
  keep?: number;
  scheduleEnabled?: boolean;
  /** Godzina (czas polski), od której wolno zrobić codzienną kopię */
  hour?: number;
  log?: (msg: string) => void;
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv, limit = 2_000_000_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let size = 0;
    let err = '';
    child.stdout.on('data', (d: Buffer) => {
      size += d.length;
      if (size > limit) child.kill();
      else out.push(d);
    });
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.on('error', (e) => reject(e));
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`${cmd} zakończył się błędem (${code}): ${err.trim().slice(0, 500)}`));
    });
  });
}

/** Rozbija adres bazy na argumenty pg_dump / pg_restore; hasło idzie przez zmienną środowiskową. */
export function pgConnArgs(url: string): { args: string[]; env: NodeJS.ProcessEnv } {
  const u = new URL(url);
  const env: NodeJS.ProcessEnv = { ...process.env, PGPASSWORD: decodeURIComponent(u.password) };
  const ssl = u.searchParams.get('sslmode');
  if (ssl) env.PGSSLMODE = ssl;
  return {
    args: [
      '--host', u.hostname,
      '--port', u.port || '5432',
      '--username', decodeURIComponent(u.username),
      '--dbname', decodeURIComponent(u.pathname.slice(1)),
    ],
    env,
  };
}

export async function pgDumpVersion(): Promise<string | null> {
  try {
    const out = await run('pg_dump', ['--version'], process.env);
    return /(\d+)(\.\d+)?/.exec(out.toString())?.[0] ?? null;
  } catch {
    return null;
  }
}

export function backupFileName(d = new Date()) {
  const p = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Warsaw',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
  return `openauto-backup-${p.replace(' ', '_').replace(':', '')}${BACKUP_EXTENSION}`;
}

export class BackupService {
  private timer: NodeJS.Timeout | null = null;
  readonly keep: number;
  private log: (m: string) => void;

  constructor(private opts: BackupOptions) {
    this.keep = opts.keep ?? 60;
    this.log = opts.log ?? ((m) => console.log(m));
  }

  async connection(): Promise<(DriveConnection & { token: Buffer }) | null> {
    const { rows } = await this.opts.adminPool.query(
      `SELECT account_email, folders, connected_at, last_error, encrypted_token
       FROM system_integrations WHERE provider = 'google_drive'`,
    );
    const r: any = rows[0];
    if (!r) return null;
    return {
      accountEmail: r.account_email,
      folders: r.folders,
      connectedAt: new Date(r.connected_at).toISOString(),
      lastError: r.last_error,
      token: r.encrypted_token,
    };
  }

  async drive(): Promise<{ client: DriveClient; folders: Record<string, string> }> {
    if (!this.opts.google) throw new Error('Google Drive nie jest skonfigurowany (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)');
    const c = await this.connection();
    if (!c) throw new Error('Google Drive nie jest połączony — połącz go w Ustawieniach');
    const refresh = decrypt(Buffer.from(c.token), 'token').toString('utf8');
    return { client: new DriveClient(this.opts.google, refresh), folders: c.folders };
  }

  async status(): Promise<BackupStatus> {
    const [conn, version, serverV, runs, last] = await Promise.all([
      this.connection(),
      pgDumpVersion(),
      this.opts.adminPool.query<{ v: string }>("SELECT current_setting('server_version_num') AS v"),
      this.opts.adminPool.query(
        `SELECT id, trigger, status, started_at, finished_at, file_name, size_bytes, error
         FROM backup_runs ORDER BY started_at DESC LIMIT 15`,
      ),
      this.opts.adminPool.query<{ t: Date | null }>("SELECT max(finished_at) AS t FROM backup_runs WHERE status = 'ok'"),
    ]);
    const serverMajor = Math.floor(Number(serverV.rows[0].v) / 10000);
    const dumpMajor = version ? Number(version.split('.')[0]) : null;
    const compatible = dumpMajor === null ? null : dumpMajor >= serverMajor;
    const list: BackupRun[] = runs.rows.map((r: any) => ({
      id: Number(r.id),
      trigger: r.trigger,
      status: r.status,
      startedAt: new Date(r.started_at).toISOString(),
      finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : null,
      fileName: r.file_name,
      sizeBytes: r.size_bytes === null ? null : Number(r.size_bytes),
      error: r.error,
    }));
    const key = masterKeyStatus();
    return {
      enabled: key === 'ok' && !!conn && !!this.opts.google && compatible === true,
      scheduleEnabled: this.opts.scheduleEnabled ?? false,
      masterKey: key,
      googleConfigured: !!this.opts.google,
      drive: conn ? { accountEmail: conn.accountEmail, folders: conn.folders, connectedAt: conn.connectedAt, lastError: conn.lastError } : null,
      pgDump: {
        available: version !== null,
        version,
        compatible,
        message:
          version === null
            ? 'Brak programu pg_dump w kontenerze'
            : compatible === false
              ? `pg_dump ${version} jest starszy niż serwer PostgreSQL ${serverMajor}`
              : undefined,
      },
      keep: this.keep,
      runs: list,
      lastOk: last.rows[0].t ? new Date(last.rows[0].t).toISOString() : null,
    };
  }

  /** Wykonuje kopię. Rzuca błąd, jeśli inna kopia właśnie trwa. */
  async run(trigger: 'auto' | 'manual', userId: string | null = null): Promise<BackupRun> {
    const lockClient = await this.opts.adminPool.connect();
    let runId: number | null = null;
    try {
      const lock = await lockClient.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [LOCK_ID]);
      if (!lock.rows[0].ok) throw new Error('Kopia zapasowa już trwa');
      try {
        const ins = await lockClient.query<{ id: string }>(
          'INSERT INTO backup_runs (trigger, created_by) VALUES ($1, $2) RETURNING id',
          [trigger, userId],
        );
        runId = Number(ins.rows[0].id);
        const { client, folders } = await this.drive();
        if (!folders.Backups) throw new Error('Brak folderu Backups na Dysku — połącz Dysk ponownie');

        const { args, env } = pgConnArgs(this.opts.adminUrl);
        const dump = await run('pg_dump', ['--format=custom', '--no-owner', '--no-privileges', ...args], env);
        if (dump.length < 1024) throw new Error('Kopia jest podejrzanie mała — przerwano');
        const sealed = encrypt(dump, 'backup');
        const sha256 = crypto.createHash('sha256').update(sealed).digest('hex');
        const name = backupFileName();
        const fileId = await client.upload(name, folders.Backups, 'application/octet-stream', sealed);

        await lockClient.query(
          `UPDATE backup_runs SET status = 'ok', finished_at = now(), file_name = $2, drive_file_id = $3,
             size_bytes = $4, sha256 = $5 WHERE id = $1`,
          [runId, name, fileId, sealed.length, sha256],
        );
        await lockClient.query("UPDATE system_integrations SET last_error = NULL, last_error_at = NULL WHERE provider = 'google_drive'");
        await this.prune(client, folders.Backups).catch((e) => this.log(`Kopie: nie udało się usunąć starych plików: ${e.message}`));
        this.log(`Kopia zapasowa ${name} (${Math.round(sealed.length / 1024)} KB) zapisana na Dysku`);
      } catch (e: any) {
        const msg = String(e?.message ?? e).slice(0, 1000);
        if (runId !== null) {
          await lockClient.query(`UPDATE backup_runs SET status = 'error', finished_at = now(), error = $2 WHERE id = $1`, [runId, msg]);
        }
        await lockClient
          .query("UPDATE system_integrations SET last_error = $1, last_error_at = now() WHERE provider = 'google_drive'", [msg])
          .catch(() => {});
        throw e;
      } finally {
        await lockClient.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]);
      }
      const { rows } = await lockClient.query(
        'SELECT id, trigger, status, started_at, finished_at, file_name, size_bytes, error FROM backup_runs WHERE id = $1',
        [runId],
      );
      const r: any = rows[0];
      return {
        id: Number(r.id),
        trigger: r.trigger,
        status: r.status,
        startedAt: new Date(r.started_at).toISOString(),
        finishedAt: r.finished_at && new Date(r.finished_at).toISOString(),
        fileName: r.file_name,
        sizeBytes: Number(r.size_bytes),
        error: r.error,
      };
    } finally {
      lockClient.release();
    }
  }

  /** Zostawia `keep` najnowszych kopii; usuwa tylko pliki kopii utworzone przez aplikację. */
  private async prune(client: DriveClient, folderId: string) {
    const files = (await client.list(folderId)).filter((f) => f.name.endsWith(BACKUP_EXTENSION));
    files.sort((a, b) => (b.createdTime ?? '').localeCompare(a.createdTime ?? ''));
    for (const f of files.slice(this.keep)) await client.remove(f.id);
  }

  /** Czy należy dziś zrobić automatyczną kopię */
  async isDue(now = new Date()): Promise<boolean> {
    const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Warsaw', hour: '2-digit', hourCycle: 'h23' }).format(now));
    if (hour < (this.opts.hour ?? 2)) return false;
    const { rows } = await this.opts.adminPool.query<{ n: string }>(
      `SELECT count(*) AS n FROM backup_runs
       WHERE trigger = 'auto' AND started_at > $1::timestamptz - interval '20 hours'
         AND (status = 'ok' OR status = 'running' OR started_at > $1::timestamptz - interval '1 hour')`,
      [now.toISOString()],
    );
    return Number(rows[0].n) === 0;
  }

  startScheduler(intervalMs = 10 * 60 * 1000) {
    if (!this.opts.scheduleEnabled || this.timer) return;
    const tick = async () => {
      try {
        if (masterKeyStatus() !== 'ok' || !(await this.connection())) return;
        if (await this.isDue()) await this.run('auto');
      } catch (e: any) {
        this.log(`Automatyczna kopia nie powiodła się: ${e?.message ?? e}`);
      }
    };
    this.timer = setInterval(() => void tick(), intervalMs);
    this.timer.unref();
    setTimeout(() => void tick(), 60_000).unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

/**
 * Odtworzenie bazy z zaszyfrowanej kopii: odszyfrowanie → pg_restore (--clean) do bazy docelowej.
 * Po odtworzeniu należy uruchomić migracje (nadają uprawnienia roli aplikacji) — robi to start.ts / restore.ts.
 */
export async function restoreFromSealed(sealed: Buffer, targetUrl: string, masterKey?: string) {
  const dump = decrypt(sealed, 'backup', masterKey);
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'oa-restore-')), 'kopia.dump');
  fs.writeFileSync(tmp, dump, { mode: 0o600 });
  try {
    const { args, env } = pgConnArgs(targetUrl);
    await run('pg_restore', ['--clean', '--if-exists', '--no-owner', '--no-privileges', '--exit-on-error', ...args, tmp], env);
  } finally {
    fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
  }
}
