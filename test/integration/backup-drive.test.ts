/**
 * Google Drive + kopie zapasowe: połączenie OAuth, struktura folderów, kopia (pg_dump → szyfrowanie → Dysk),
 * odtworzenie do nowej bazy, limit liczby kopii, uprawnienia. Google zastąpiony atrapą (test/helpers/fake-google.ts).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDatabase, seedWorkspace, ADMIN_URL, driver, type Seeded, type TestDb } from '../helpers/db.ts';
import { ApiClient, startServer } from '../helpers/server.ts';
import { startFakeGoogle } from '../helpers/fake-google.ts';
import { BackupService, restoreFromSealed, pgDumpVersion } from '../../src/server/services/backup.ts';
import { googleConfig } from '../../src/server/integrations/google/drive.ts';
import { createPool } from '../../src/server/db/index.ts';
import { decrypt } from '../../src/server/crypto/secrets.ts';

let t: TestDb;
let A: Seeded;
let google: Awaited<ReturnType<typeof startFakeGoogle>>;
let srv: Awaited<ReturnType<typeof startServer>>;
let backup: BackupService;
let owner: ApiClient;
const KEY = 'integration-master-key-0123456789-abcdefgh';

before(async () => {
  process.env.OPENAUTO_MASTER_KEY = KEY;
  t = await createTestDatabase();
  A = await seedWorkspace(t.owner);
  google = await startFakeGoogle();
  const gcfg = googleConfig('http://openauto.test', google.env as any)!;
  backup = new BackupService({ adminPool: t.owner, adminUrl: t.ownerUrl, google: gcfg, keep: 2, log: () => {} });
  srv = await startServer(t.app, 'dist/public', { backup, google: gcfg, adminPool: t.owner });
  owner = await new ApiClient(srv.base).login(A.users.owner.email, A.users.owner.password);
  await owner.post('/api/cars', { marka: 'Volkswagen', model: 'Tiguan', vin: 'WVGZZZ5NZBW000001', cenaA: '42900' });
  await owner.post('/api/cars', { marka: 'Skoda', model: 'Octavia', cenaA: '35000' });
});
after(async () => {
  await srv?.close();
  await google?.close();
  await t?.drop();
});

test('status przed połączeniem: Dysk niepołączony, klucz OK, kopie wyłączone', async () => {
  const r = await owner.get('/api/system/backup');
  assert.equal(r.status, 200);
  assert.equal(r.body.masterKey, 'ok');
  assert.equal(r.body.googleConfigured, true);
  assert.equal(r.body.drive, null);
  assert.equal(r.body.enabled, false);
});

test('kopiami i Dyskiem zarządza wyłącznie Właściciel (nie Administrator, nie Manager)', async () => {
  for (const role of ['manager', 'administrator']) {
    const m = await new ApiClient(srv.base).login(A.users[role].email, A.users[role].password);
    assert.equal((await m.get('/api/system/backup')).status, 403, role);
    assert.equal((await m.post('/api/system/backup/run')).status, 403, role);
    assert.equal((await m.post('/api/integrations/google/connect')).status, 403, role);
    assert.equal((await m.post('/api/integrations/google/disconnect')).status, 403, role);
  }
});

test('połączenie Google Drive: zgoda → powrót → folder "OpenAuto CRM" z podfolderami, token zaszyfrowany', async () => {
  const c = await owner.post('/api/integrations/google/connect');
  assert.equal(c.status, 200);
  const url = new URL(c.body.url);
  assert.equal(url.searchParams.get('scope')?.includes('auth/drive.file'), true);
  assert.equal(url.searchParams.get('access_type'), 'offline');
  const state = url.searchParams.get('state')!;

  // podrobiony state → odrzucony
  const bad = await owner.get(`/api/integrations/google/callback?code=good-code&state=${encodeURIComponent(state + 'x')}`);
  assert.equal(bad.location, '/ustawienia?drive=niewazny-link');
  // state innego użytkownika (inna sesja) → odrzucony
  const other = await new ApiClient(srv.base).login(A.users.owner.email, A.users.owner.password);
  const foreign = await other.get(`/api/integrations/google/callback?code=good-code&state=${encodeURIComponent(state)}`);
  assert.equal(foreign.location, '/ustawienia?drive=niewazny-link');

  const ok = await owner.get(`/api/integrations/google/callback?code=good-code&state=${encodeURIComponent(state)}`);
  assert.equal(ok.status, 302);
  assert.equal(ok.location, '/ustawienia?drive=polaczono');

  const names = [...google.files.values()].map((f) => f.name).sort();
  assert.deepEqual(names, ['Backups', 'Dokumenty', 'Excel', 'Faktury', 'OpenAuto CRM', 'Samochody', 'Zdjęcia']);
  const { rows } = await t.owner.query('SELECT encrypted_token, account_email FROM system_integrations');
  assert.equal(rows[0].account_email, 'crm@example.com');
  assert.ok(!Buffer.from(rows[0].encrypted_token).toString('latin1').includes('refresh-secret-1'), 'token nie może być jawny');
  const audit = await t.owner.query("SELECT after::text AS a FROM audit_log WHERE entity = 'system_integrations'");
  assert.ok(audit.rows.length > 0 && audit.rows.every((r: any) => !r.a.includes('encrypted_token')));
  // rola aplikacji nie ma dostępu do tokenów
  await assert.rejects(
    t.app.tx({ workspaceId: A.workspaceId, userId: A.users.owner.id }, (q) => q.query('SELECT * FROM system_integrations')),
    /permission denied/,
  );
});

test('kopia na żądanie: plik na Dysku jest zaszyfrowany i da się z niego odtworzyć bazę', async (tt) => {
  if (!(await pgDumpVersion())) return tt.skip('brak pg_dump');
  const r = await owner.post('/api/system/backup/run');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, 'ok');
  assert.match(r.body.fileName, /^openauto-backup-\d{4}-\d{2}-\d{2}_\d{4}\.oabak$/);

  const backupsFolder = [...google.files.values()].find((f) => f.name === 'Backups')!;
  const file = [...google.files.values()].find((f) => f.parent === backupsFolder.id)!;
  assert.ok(file.data!.subarray(0, 6).equals(Buffer.from('OAENC1')));
  assert.ok(!file.data!.includes(Buffer.from('Octavia')), 'dane nie mogą być czytelne bez klucza');
  assert.ok(decrypt(file.data!, 'backup').subarray(0, 5).equals(Buffer.from('PGDMP')));

  // odtworzenie do zupełnie nowej bazy
  const drv = await driver();
  const admin = await createPool(ADMIN_URL, drv, 1);
  const name = t.name + '_restore';
  await admin.query(`CREATE DATABASE ${name} OWNER oa_test_owner`);
  try {
    const target = new URL(t.ownerUrl);
    target.pathname = '/' + name;
    await restoreFromSealed(file.data!, target.toString());
    const p = await createPool(target.toString(), drv, 1);
    const cars = await p.query<{ marka: string; numer: string }>('SELECT marka, numer FROM cars ORDER BY numer');
    assert.deepEqual(cars.rows.map((c) => c.marka), ['Volkswagen', 'Skoda']);
    const counter = await p.query<{ last_value: string }>("SELECT last_value FROM workspace_counters WHERE name = 'car'");
    assert.equal(counter.rows[0].last_value, '2', 'licznik numerów odtworzony — numery nie powtórzą się');
    await p.end();
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  }
});

test('nie więcej kopii niż limit (najstarsze usuwane); równoległa kopia odrzucona', async (tt) => {
  if (!(await pgDumpVersion())) return tt.skip('brak pg_dump');
  await backup.run('manual');
  await backup.run('manual');
  const backupsFolder = [...google.files.values()].find((f) => f.name === 'Backups')!;
  const inFolder = [...google.files.values()].filter((f) => f.parent === backupsFolder.id);
  assert.equal(inFolder.length, 2);

  const results = await Promise.allSettled([backup.run('manual'), backup.run('manual')]);
  assert.ok(results.some((r) => r.status === 'rejected' && /już trwa/.test(String((r as any).reason?.message))));
  const st = await owner.get('/api/system/backup');
  assert.equal(st.body.enabled, true);
  assert.ok(st.body.lastOk);
  assert.ok(st.body.runs.length >= 4);
});

test('harmonogram: kopia automatyczna raz na dobę, po 2:00 czasu polskiego', async () => {
  await t.owner.query("DELETE FROM backup_runs WHERE trigger = 'auto'");
  assert.equal(await backup.isDue(new Date('2026-10-14T23:30:00Z')), false); // 01:30 w Polsce
  assert.equal(await backup.isDue(new Date('2026-10-15T01:30:00Z')), true); // 03:30
  await t.owner.query("INSERT INTO backup_runs (trigger, status, started_at) VALUES ('auto', 'ok', '2026-10-15T01:00:00Z')");
  assert.equal(await backup.isDue(new Date('2026-10-15T08:00:00Z')), false);
  assert.equal(await backup.isDue(new Date('2026-10-16T01:30:00Z')), true);
  await t.owner.query("DELETE FROM backup_runs WHERE trigger = 'auto'");
});

test('odłączenie Dysku unieważnia token u Google', async () => {
  const r = await owner.post('/api/integrations/google/disconnect');
  assert.equal(r.status, 200);
  assert.deepEqual(google.revoked, ['refresh-secret-1']);
  const st = await owner.get('/api/system/backup');
  assert.equal(st.body.drive, null);
});

test('kontrola przed uruchomieniem: bez spełnienia warunków nie można zatwierdzić; banner „tryb testowy”', async () => {
  const me = await owner.get('/api/auth/me');
  assert.equal(me.body.mode, 'test');
  const r = await owner.get('/api/system/launch');
  assert.equal(r.status, 200);
  assert.equal(r.body.ready, false); // brak HTTPS w teście, Dysk odłączony w poprzednim teście
  const ids = r.body.checks.map((c: any) => c.id);
  for (const id of ['https', 'cookies', 'db-role', 'owner-password', 'master-key', 'drive', 'backup-fresh']) assert.ok(ids.includes(id), id);
  assert.equal(r.body.checks.find((c: any) => c.id === 'db-role').ok, true);
  const noManual = await owner.post('/api/system/launch/confirm', {});
  assert.equal(noManual.status, 400);
  const blocked = await owner.post('/api/system/launch/confirm', { railwayBackups: true, dbPrivate: true, keyStored: true });
  assert.equal(blocked.status, 409);
  const m = await new ApiClient(srv.base).login(A.users.administrator.email, A.users.administrator.password);
  assert.equal((await m.get('/api/system/launch')).status, 403);
  const settings = await t.owner.query("SELECT count(*)::int AS n FROM system_settings");
  assert.equal(settings.rows[0].n, 0);
});

test('kontrola przed uruchomieniem: gdy wszystko spełnione — Właściciel zatwierdza, tryb produkcyjny', async (tt) => {
  if (!(await pgDumpVersion())) return tt.skip('brak pg_dump');
  const gcfg = googleConfig('https://openauto.test', google.env as any)!;
  const prodBackup = new BackupService({ adminPool: t.owner, adminUrl: t.ownerUrl, google: gcfg, scheduleEnabled: true, log: () => {} });
  const prod = await startServer(t.app, 'dist/public', { backup: prodBackup, google: gcfg, adminPool: t.owner }, {
    trustProxy: true,
    secureCookies: true,
    environmentName: 'production',
    isProduction: true,
  });
  try {
    const c = await new ApiClient(prod.base).login(A.users.owner.email, A.users.owner.password);
    const https = { 'X-Forwarded-Proto': 'https' };
    const url = new URL((await c.req('POST', '/api/integrations/google/connect', {}, https)).body.url);
    await c.req('GET', `/api/integrations/google/callback?code=good-code&state=${encodeURIComponent(url.searchParams.get('state')!)}`, undefined, https);
    await c.req('POST', '/api/system/backup/run', {}, https);
    const check = await c.req('GET', '/api/system/launch', undefined, https);
    const failed = check.body.checks.filter((x: any) => x.critical && !x.ok).map((x: any) => x.id);
    assert.deepEqual(failed, []);
    assert.equal(check.body.ready, true);
    const ok = await c.req('POST', '/api/system/launch/confirm', { railwayBackups: true, dbPrivate: true, keyStored: true }, https);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal((await c.req('GET', '/api/auth/me', undefined, https)).body.mode, 'production');
    const row = await t.owner.query("SELECT updated_by FROM system_settings WHERE key = 'production_confirmed'");
    assert.equal(row.rows[0].updated_by, A.users.owner.id);
  } finally {
    await prod.close();
  }
});
