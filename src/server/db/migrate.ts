/**
 * Migracje bazy: pliki db/migrations/NNNN_*.sql wykonywane po kolei, każdy w transakcji.
 * Zastosowane migracje i ich sumy kontrolne zapisywane są w schema_migrations —
 * zmiana już zastosowanego pliku zatrzymuje migrację (ochrona przed rozjechaniem schematu).
 *
 * Migracje uruchamia rola właściciela schematu (MIGRATION_DATABASE_URL).
 * Aplikacja działa na osobnej roli (APP_DB_USER) bez prawa DELETE i bez obchodzenia RLS.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { PoolLike } from './types.ts';

export interface MigrateOptions {
  migrationsDir: string;
  appRole?: string;
  appRolePassword?: string;
  log?: (msg: string) => void;
}

export async function migrate(pool: PoolLike, opts: MigrateOptions): Promise<string[]> {
  const log = opts.log ?? (() => {});
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    await client.query('SELECT pg_advisory_lock(727001)');
    const done = new Map(
      (await client.query<{ name: string; checksum: string }>('SELECT name, checksum FROM schema_migrations')).rows.map(
        (r) => [r.name, r.checksum],
      ),
    );
    const files = fs.readdirSync(opts.migrationsDir).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
    for (const file of files) {
      const sql = fs.readFileSync(path.join(opts.migrationsDir, file), 'utf8');
      const checksum = crypto.createHash('sha256').update(sql).digest('hex');
      const prev = done.get(file);
      if (prev) {
        if (prev !== checksum) throw new Error(`Migracja ${file} została zmieniona po zastosowaniu (suma kontrolna się nie zgadza)`);
        continue;
      }
      log(`→ ${file}`);
      await client.query('BEGIN');
      try {
        await client.query(sql + '\n;SELECT 1');
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [file, checksum]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`Migracja ${file} nie powiodła się: ${(e as Error).message}`);
      }
      applied.push(file);
    }
    if (opts.appRole) await grantAppRole(client, opts.appRole, opts.appRolePassword, log);
    await client.query('SELECT pg_advisory_unlock(727001)');
  } finally {
    client.release();
  }
  return applied;
}

async function grantAppRole(
  client: { query: PoolLike['query'] },
  role: string,
  password: string | undefined,
  log: (m: string) => void,
) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(role)) throw new Error(`Nieprawidłowa nazwa roli: ${role}`);
  const exists = (await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])).rowCount;
  if (!exists) {
    if (!password) throw new Error(`Rola ${role} nie istnieje — ustaw APP_DB_PASSWORD, aby ją utworzyć`);
    const { rows } = await client.query<{ sql: string }>(
      "SELECT format('CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE', $1::text, $2::text) AS sql",
      [role, password],
    );
    await client.query(rows[0].sql);
    log(`Utworzono rolę aplikacji ${role}`);
  } else if (password) {
    // hasło roli aplikacji może być zmieniane przy każdym uruchomieniu (rotacja)
    const { rows } = await client.query<{ sql: string }>(
      "SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L', $1::text, $2::text) AS sql",
      [role, password],
    );
    await client.query(rows[0].sql);
  }
  const r = `"${role}"`;
  await client.query(`
    GRANT USAGE ON SCHEMA public TO ${r};
    GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO ${r};
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${r};
    REVOKE ALL ON schema_migrations, workspace_counters FROM ${r};
    REVOKE INSERT, UPDATE ON audit_log, car_status_history, workspaces, roles FROM ${r};
    REVOKE UPDATE ON error_log FROM ${r};
    GRANT DELETE ON sessions TO ${r};
    -- tokeny Dysku i dziennik kopii: wyłącznie połączenie administracyjne serwera
    REVOKE ALL ON system_integrations, backup_runs FROM ${r};
    REVOKE INSERT, UPDATE ON system_settings FROM ${r};
    SELECT 1`);
  log(`Uprawnienia roli ${role} zaktualizowane`);
}

/** Sprawdza, czy rola aplikacji nie omija RLS (superuser, BYPASSRLS albo właściciel tabel). */
export async function checkAppRoleIsRestricted(pool: PoolLike): Promise<string | null> {
  const { rows } = await pool.query<{ rolsuper: boolean; rolbypassrls: boolean; owns: boolean; who: string }>(`
    SELECT r.rolsuper, r.rolbypassrls, current_user AS who,
           EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'cars' AND tableowner = current_user) AS owns
    FROM pg_roles r WHERE r.rolname = current_user`);
  const r = rows[0];
  if (r.rolsuper || r.rolbypassrls) return `Rola ${r.who} omija Row-Level Security (superuser/BYPASSRLS)`;
  if (r.owns) return `Rola ${r.who} jest właścicielem tabel — RLS nie jest dla niej egzekwowane`;
  return null;
}
