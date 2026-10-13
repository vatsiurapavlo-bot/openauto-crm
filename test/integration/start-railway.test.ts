/**
 * Symulacja startu na Railway: jeden adres DATABASE_URL (jak ${{Postgres.DATABASE_URL}}), brak ręcznych kroków.
 * Sprawdza: migracje, rolę aplikacji bez omijania RLS, pierwszego właściciela ze zmiennych, restart bez zmian.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import { ADMIN_URL, driver } from '../helpers/db.ts';
import { ApiClient } from '../helpers/server.ts';
import { createPool, type PoolLike } from '../../src/server/db/index.ts';

const dbName = 'oa_start_' + crypto.randomBytes(4).toString('hex');
const port = 3900 + Math.floor(Math.random() * 90);
let admin: PoolLike;
let child: ChildProcess | null = null;
let logs = '';

const dbUrl = () => {
  const u = new URL(ADMIN_URL);
  u.pathname = '/' + dbName;
  return u.toString();
};

async function start() {
  logs = '';
  const { NODE_TEST_CONTEXT: _ignored, ...parentEnv } = process.env; // proces potomny nie jest testem
  child = spawn(process.execPath, ['--import', 'tsx', 'src/server/start.ts'], {
    env: {
      MIGRATION_DATABASE_URL: undefined,
      ...parentEnv,
      NODE_ENV: 'production',
      SECURE_COOKIES: '0',
      PORT: String(port),
      DATABASE_URL: dbUrl(),
      DB_DRIVER: await driver(),
      APP_DB_USER: 'oa_start_app',
      OPENAUTO_MASTER_KEY: 'start-test-master-key-0123456789-abcdefgh',
      BOOTSTRAP_OWNER_EMAIL: 'Szef@OpenAuto.test',
      BOOTSTRAP_OWNER_PASSWORD: 'Pierwsze-haslo-2026',
      BOOTSTRAP_OWNER_NAME: 'Szef Firmy',
      RAILWAY_ENVIRONMENT_NAME: 'pr-1',
      RAILWAY_PUBLIC_DOMAIN: 'openauto-test.up.railway.app',
      PUBLIC_DIR: 'dist/public',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout!.on('data', (d) => (logs += d));
  child.stderr!.on('data', (d) => (logs += d));
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (child.exitCode !== null) throw new Error('Serwer zakończył pracę:\n' + logs);
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return;
    } catch {
      /* jeszcze startuje */
    }
  }
  throw new Error('Serwer nie wystartował:\n' + logs);
}

async function stop() {
  if (!child) return;
  const c = child;
  child = null;
  await new Promise<void>((r) => {
    c.once('exit', () => r());
    c.kill('SIGTERM');
  });
}

before(async () => {
  admin = await createPool(ADMIN_URL, await driver(), 1);
  await admin.query(`CREATE DATABASE ${dbName}`);
});
after(async () => {
  await stop();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.query('DROP ROLE IF EXISTS oa_start_app');
  await admin.end();
});

test('pierwszy start: migracje, rola aplikacji z RLS, konto właściciela ze zmiennych', async () => {
  await start();
  assert.match(logs, /Zastosowano migracje: 0001_init.sql, 0002_drive_backups.sql/);
  assert.match(logs, /Utworzono konto Właściciela szef@openauto.test/);
  assert.match(logs, /tryb: test, środowisko: pr-1/);
  // NODE_ENV=production: serwer zatrzymałby się, gdyby rola omijała RLS — działa, więc rola jest ograniczona
  const c = await new ApiClient(`http://127.0.0.1:${port}`).login('szef@openauto.test', 'Pierwsze-haslo-2026');
  const me = await c.get('/api/auth/me');
  assert.equal(me.body.role, 'owner');
  assert.equal(me.body.mode, 'test');
  const conns = await admin.query<{ usename: string }>(
    'SELECT DISTINCT usename FROM pg_stat_activity WHERE datname = $1 AND usename IS NOT NULL',
    [dbName],
  );
  assert.ok(conns.rows.some((r) => r.usename === 'oa_start_app'));
});

test('restart (nowe wdrożenie): bez ponownych migracji, bez drugiego właściciela, logowanie działa', async () => {
  await stop();
  await start();
  assert.match(logs, /Baza jest aktualna/);
  assert.doesNotMatch(logs, /Utworzono konto/);
  const p = await createPool(dbUrl(), await driver(), 1);
  const users = await p.query<{ n: string }>('SELECT count(*) AS n FROM users');
  await p.end();
  assert.equal(users.rows[0].n, '1');
  await new ApiClient(`http://127.0.0.1:${port}`).login('szef@openauto.test', 'Pierwsze-haslo-2026');
});

test('za proxy Railway: blokada logowania liczy adres z X-Real-IP, nie z podrobionego X-Forwarded-For', async () => {
  const base = `http://127.0.0.1:${port}`;
  const attempt = (ip: string, fwd: string) =>
    fetch(base + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'openauto', 'X-Real-IP': ip, 'X-Forwarded-For': fwd },
      body: JSON.stringify({ email: `x${Math.random()}@x.pl`, password: 'zle-haslo' }),
    }).then((r) => r.status);
  let last = 0;
  // 50 prób z jednego adresu, za każdym razem inny podrobiony X-Forwarded-For
  for (let i = 0; i < 51; i++) last = await attempt('203.0.113.7', `10.0.0.${i}`);
  assert.equal(last, 429);
  assert.equal(await attempt('198.51.100.1', '10.0.0.1'), 401, 'inny klient nie jest blokowany');
});
