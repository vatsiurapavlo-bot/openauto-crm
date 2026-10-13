/**
 * Testy działają na prawdziwym PostgreSQL. Każdy plik testów dostaje świeżą bazę:
 *  - migracje uruchamia rola właściciela (bez superusera),
 *  - aplikacja łączy się rolą bez uprawnień właściciela → RLS jest egzekwowane.
 *
 * TEST_ADMIN_DATABASE_URL — połączenie z uprawnieniami do tworzenia baz i ról,
 * np. postgres://postgres:haslo@127.0.0.1:5432/postgres
 */
import path from 'node:path';
import crypto from 'node:crypto';
import { Database, createPool, type PoolLike } from '../../src/server/db/index.ts';
import { migrate } from '../../src/server/db/migrate.ts';
import { hashPassword } from '../../src/server/auth/password.ts';

const adminUrl = process.env.TEST_ADMIN_DATABASE_URL;
if (!adminUrl) {
  throw new Error('Ustaw TEST_ADMIN_DATABASE_URL (np. postgres://postgres:haslo@127.0.0.1:5432/postgres) — testy tworzą własne bazy');
}
export const ADMIN_URL: string = adminUrl;
const OWNER_ROLE = 'oa_test_owner';
const APP_ROLE = 'oa_test_app';
const ROLE_PW = 'test-only-password-1';

let driverPromise: Promise<string> | null = null;
export function driver(): Promise<string> {
  driverPromise ??= (async () => {
    if (process.env.DB_DRIVER) return process.env.DB_DRIVER;
    try {
      const moduleName = 'pg';
      await import(moduleName);
      return 'pg';
    } catch {
      return 'wire';
    }
  })();
  return driverPromise;
}

function withDb(url: string, db: string, user?: string, pw?: string) {
  const u = new URL(url);
  u.pathname = '/' + db;
  if (user) {
    u.username = user;
    u.password = pw ?? '';
  }
  return u.toString();
}

export interface TestDb {
  name: string;
  ownerUrl: string;
  appUrl: string;
  owner: PoolLike;
  app: Database;
  drop(): Promise<void>;
}

export async function createTestDatabase(): Promise<TestDb> {
  const drv = await driver();
  const admin = await createPool(ADMIN_URL, drv, 1);
  const name = 'oa_test_' + crypto.randomBytes(5).toString('hex');
  for (const role of [OWNER_ROLE, APP_ROLE]) {
    const exists = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
    if (!exists.rowCount) {
      await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${ROLE_PW}' NOSUPERUSER NOBYPASSRLS`);
    }
  }
  await admin.query(`CREATE DATABASE ${name} OWNER ${OWNER_ROLE}`);
  await admin.end();

  const ownerUrl = withDb(ADMIN_URL, name, OWNER_ROLE, ROLE_PW);
  const appUrl = withDb(ADMIN_URL, name, APP_ROLE, ROLE_PW);
  const owner = await createPool(ownerUrl, drv, 4);
  await migrate(owner, { migrationsDir: path.resolve('db/migrations'), appRole: APP_ROLE });
  const app = new Database(await createPool(appUrl, drv, 12));

  return {
    name,
    ownerUrl,
    appUrl,
    owner,
    app,
    async drop() {
      await app.end();
      await owner.end();
      const a = await createPool(ADMIN_URL, drv, 1);
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.end();
    },
  };
}

export interface Seeded {
  workspaceId: string;
  users: Record<string, { id: string; email: string; password: string }>;
}

const ROLES = ['owner', 'administrator', 'manager', 'sprzedawca', 'serwis', 'lakiernia', 'ksiegowosc', 'viewer'];

/** Tworzy przestrzeń (jak `npm run setup`) i po jednym użytkowniku na rolę. */
export async function seedWorkspace(owner: PoolLike, code = 'openauto'): Promise<Seeded> {
  const ws = await owner.query<{ id: string }>('INSERT INTO workspaces (code, name) VALUES ($1, $2) RETURNING id', [
    code,
    code === 'openauto' ? 'OpenAuto' : code,
  ]);
  const workspaceId = ws.rows[0].id;
  await owner.query('SELECT init_workspace($1)', [workspaceId]);
  const users: Seeded['users'] = {};
  const password = 'Haslo-testowe-123';
  const hash = await hashPassword(password);
  for (const role of ROLES) {
    const email = `${role}@${code}.test`;
    const u = await owner.query<{ id: string }>(
      'INSERT INTO users (email, full_name, password_hash) VALUES ($1, $2, $3) RETURNING id',
      [email, `Test ${role}`, hash],
    );
    await owner.query('INSERT INTO workspace_members (workspace_id, user_id, role_code) VALUES ($1, $2, $3)', [
      workspaceId,
      u.rows[0].id,
      role,
    ]);
    users[role] = { id: u.rows[0].id, email, password };
  }
  return { workspaceId, users };
}

export async function statusId(owner: PoolLike, workspaceId: string, kind: string, code: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    'SELECT id FROM car_statuses WHERE workspace_id = $1 AND kind = $2 AND system_code = $3',
    [workspaceId, kind, code],
  );
  return rows[0].id;
}
