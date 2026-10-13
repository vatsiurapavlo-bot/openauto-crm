/**
 * Testy API end-to-end (HTTP → serwer → PostgreSQL z RLS).
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDatabase, seedWorkspace, statusId, type Seeded, type TestDb } from '../helpers/db.ts';
import { ApiClient, startServer } from '../helpers/server.ts';

let t: TestDb;
let A: Seeded;
let srv: Awaited<ReturnType<typeof startServer>>;
const users: Record<string, ApiClient> = {};

before(async () => {
  t = await createTestDatabase();
  A = await seedWorkspace(t.owner);
  srv = await startServer(t.app);
  for (const role of Object.keys(A.users)) {
    users[role] = await new ApiClient(srv.base).login(A.users[role].email, A.users[role].password);
  }
});
after(async () => {
  await srv?.close();
  await t?.drop();
});

const newCar = (extra: Record<string, unknown> = {}) => ({
  marka: 'Volkswagen',
  model: 'Tiguan',
  rokProdukcji: 2011,
  vin: 'wvgzzz5nzbw000001',
  przebiegKm: 187000,
  rodzajPaliwa: 'Diesel',
  krajZakupu: 'NL',
  cenaA: '42 900',
  finance: { wartoscAuta: '31500,00', uslugiAukcjiNetto: '450' },
  ...extra,
});

describe('Logowanie i sesje', () => {
  test('bez sesji → 401; złe hasło → 401; poprawne → dane użytkownika i uprawnienia', async () => {
    const anon = new ApiClient(srv.base);
    assert.equal((await anon.get('/api/cars')).status, 401);
    const bad = await anon.post('/api/auth/login', { email: A.users.owner.email, password: 'zle-haslo-1234' });
    assert.equal(bad.status, 401);
    const me = await users.owner.get('/api/auth/me');
    assert.equal(me.status, 200);
    assert.equal(me.body.workspace.name, 'OpenAuto');
    assert.equal(me.body.role, 'owner');
    assert.ok(me.body.permissions.includes('kasa.view'));
    const serwis = await users.serwis.get('/api/auth/me');
    assert.deepEqual(serwis.body.permissions, ['cars.status', 'cars.view']);
  });

  test('ciasteczko sesji: HttpOnly, SameSite; token nie jest zapisany w bazie wprost', async () => {
    const res = await fetch(srv.base + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'openauto' },
      body: JSON.stringify({ email: A.users.viewer.email, password: A.users.viewer.password }),
    });
    const cookie = res.headers.get('set-cookie')!;
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    const token = cookie.split(';')[0].split('=')[1];
    const leaked = await t.owner.query('SELECT count(*)::int AS n FROM sessions WHERE token_hash::text LIKE $1', ['%' + token + '%']);
    assert.equal(leaked.rows[0].n, 0);
  });

  test('wylogowanie unieważnia sesję po stronie serwera', async () => {
    const c = await new ApiClient(srv.base).login(A.users.viewer.email, A.users.viewer.password);
    const stolen = c.cookie;
    assert.equal((await c.post('/api/auth/logout')).status, 200);
    const replay = new ApiClient(srv.base);
    replay.cookie = stolen;
    assert.equal((await replay.get('/api/auth/me')).status, 401);
  });

  test('ochrona CSRF: zapis bez nagłówka aplikacji → 403', async () => {
    const r = await users.owner.req('POST', '/api/cars', newCar(), { 'X-Requested-With': '' });
    assert.equal(r.status, 403);
  });

  test('blokada po wielu nieudanych próbach logowania', async () => {
    const c = new ApiClient(srv.base);
    let last = 0;
    for (let i = 0; i < 11; i++) last = (await c.post('/api/auth/login', { email: 'nieistnieje@x.pl', password: 'zle' + i })).status;
    assert.equal(last, 429);
  });

  test('dezaktywowany użytkownik traci dostęp natychmiast', async () => {
    const c = await new ApiClient(srv.base).login(A.users.lakiernia.email, A.users.lakiernia.password);
    await t.owner.query('UPDATE workspace_members SET active = false WHERE user_id = $1', [A.users.lakiernia.id]);
    assert.equal((await c.get('/api/cars')).status, 401);
    await t.owner.query('UPDATE workspace_members SET active = true WHERE user_id = $1', [A.users.lakiernia.id]);
  });
});

describe('Samochody', () => {
  let car: any;

  test('dodanie auta: automatyczny Numer auta, normalizacja VIN, kwoty dokładne', async () => {
    const r = await users.owner.post('/api/cars', newCar());
    assert.equal(r.status, 200, JSON.stringify(r.body));
    car = r.body;
    assert.equal(car.numer, 1);
    assert.equal(car.label, '1 — Volkswagen Tiguan 2011');
    assert.equal(car.vin, 'WVGZZZ5NZBW000001');
    assert.equal(car.cenaA, '42900.00');
    assert.equal(car.finance.wartoscAuta, '31500.00');
    assert.equal(car.finance.zyskAPrognoza, '11400.00');
    const w = await statusId(t.owner, A.workspaceId, 'logistic', 'w_drodze');
    assert.equal(car.displayStatusId, w); // domyślnie W drodze
  });

  test('walidacja: błędy pól po polsku; duplikat VIN → 409', async () => {
    const bad = await users.owner.post('/api/cars', { marka: '', model: 'X', vin: 'IOQ', cenaA: '12.345' });
    assert.equal(bad.status, 400);
    assert.ok(bad.body.error.details.fields.marka);
    assert.ok(bad.body.error.details.fields.vin);
    assert.ok(bad.body.error.details.fields.cenaA);
    const dup = await users.owner.post('/api/cars', newCar());
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error.code, 'duplicate_vin');
    const country = await users.owner.post('/api/cars', newCar({ vin: null, krajZakupu: 'XX' }));
    assert.equal(country.status, 400);
  });

  test('wyszukiwanie, filtry i sortowanie', async () => {
    await users.manager.post('/api/cars', { marka: 'Skoda', model: 'Octavia', rokProdukcji: 2016, rodzajPaliwa: 'Benzyna', cenaA: '35000' });
    await users.manager.post('/api/cars', { marka: 'Audi', model: 'A4', rokProdukcji: 2014, cenaA: '28000' });
    const byText = await users.owner.get('/api/cars?q=octa');
    assert.deepEqual(byText.body.items.map((c: any) => c.model), ['Octavia']);
    const byNumber = await users.owner.get('/api/cars?q=1');
    assert.ok(byNumber.body.items.some((c: any) => c.numer === 1));
    const byVin = await users.owner.get('/api/cars?q=BW000001');
    assert.equal(byVin.body.total, 1);
    const byYear = await users.owner.get('/api/cars?rokOd=2013&rokDo=2015');
    assert.deepEqual(byYear.body.items.map((c: any) => c.marka), ['Audi']);
    const sorted = await users.owner.get('/api/cars?sort=cena&dir=asc');
    assert.deepEqual(sorted.body.items.map((c: any) => c.cenaA), ['28000.00', '35000.00', '42900.00']);
    const injection = await users.owner.get("/api/cars?sort=numer;DROP TABLE cars&q=%' OR 1=1 --");
    assert.equal(injection.status, 200);
    assert.equal(injection.body.total, 0);
  });

  test('edycja z blokadą optymistyczną: drugi użytkownik ze starą wersją dostaje 409', async () => {
    const a = await users.owner.patch(`/api/cars/${car.id}`, { version: car.version, kolor: 'Srebrny' });
    assert.equal(a.status, 200);
    assert.equal(a.body.version, car.version + 1);
    const b = await users.manager.patch(`/api/cars/${car.id}`, { version: car.version, kolor: 'Czarny' });
    assert.equal(b.status, 409);
    assert.equal(b.body.error.code, 'stale_version');
    car = a.body;
  });

  test('równoczesna edycja przez dwóch użytkowników — wygrywa dokładnie jeden', async () => {
    const [x, y] = await Promise.all([
      users.owner.patch(`/api/cars/${car.id}`, { version: car.version, notatka: 'A' }),
      users.manager.patch(`/api/cars/${car.id}`, { version: car.version, notatka: 'B' }),
    ]);
    assert.deepEqual([x.status, y.status].sort(), [200, 409]);
    car = (await users.owner.get(`/api/cars/${car.id}`)).body;
  });

  test('zmiana statusu + historia z użytkownikiem', async () => {
    const naPlacu = await statusId(t.owner, A.workspaceId, 'logistic', 'na_placu');
    const r = await users.manager.post(`/api/cars/${car.id}/status`, { kind: 'logistic', statusId: naPlacu, version: car.version });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    car = r.body.car;
    assert.equal(car.displayStatusId, naPlacu);
    const h = await users.owner.get(`/api/cars/${car.id}/history`);
    assert.equal(h.body[0].toStatusId, naPlacu);
    assert.equal(h.body[0].changedBy, 'Test manager');
  });

  test('Rozliczone: auto znika z aktywnych, zostaje w zakładce Rozliczone, nic nie jest kasowane', async () => {
    const rozl = await statusId(t.owner, A.workspaceId, 'settlement', 'rozliczone');
    // Sprzedawca nie może rozliczać
    const denied = await users.sprzedawca.post(`/api/cars/${car.id}/status`, { kind: 'settlement', statusId: rozl, version: car.version });
    assert.equal(denied.status, 403);
    const fin = await users.owner.patch(`/api/cars/${car.id}`, { version: car.version, finance: { cenaSprzedazyFaktyczna: '41000' } });
    car = fin.body;
    const r = await users.owner.post(`/api/cars/${car.id}/status`, { kind: 'settlement', statusId: rozl, version: car.version });
    assert.equal(r.status, 200);
    assert.equal(r.body.car.displayStatusId, rozl);
    const active = await users.owner.get('/api/cars');
    assert.ok(!active.body.items.some((c: any) => c.id === car.id));
    const closed = await users.owner.get('/api/cars?view=rozliczone');
    assert.deepEqual(closed.body.items.map((c: any) => c.id), [car.id]);
    const stillThere = await t.owner.query('SELECT deleted_at FROM cars WHERE id = $1', [car.id]);
    assert.equal(stillThere.rows[0].deleted_at, null);
    car = r.body.car;
  });
});

describe('Uprawnienia egzekwowane przez serwer', () => {
  test('Sprzedawca: widzi auta i ceny ofertowe, ale nie dane finansowe; nie dodaje aut', async () => {
    const list = await users.sprzedawca.get('/api/cars?view=all');
    assert.equal(list.status, 200);
    assert.ok(list.body.items.length > 0);
    for (const c of list.body.items) assert.equal(c.finance, undefined);
    assert.ok(list.body.items.some((c: any) => c.cenaA));
    assert.equal((await users.sprzedawca.post('/api/cars', { marka: 'X', model: 'Y' })).status, 403);
    // próba przemycenia finansów w edycji
    const one = list.body.items[0];
    const r = await users.sprzedawca.patch(`/api/cars/${one.id}`, { version: one.version, finance: { wartoscAuta: '1' } });
    assert.equal(r.status, 403);
  });

  test('Serwis: widzi tylko auta w Serwisie, bez finansów; po oddaniu auta traci do niego dostęp', async () => {
    const serwisSt = await statusId(t.owner, A.workspaceId, 'logistic', 'serwis');
    const naPlacu = await statusId(t.owner, A.workspaceId, 'logistic', 'na_placu');
    const c = (await users.owner.post('/api/cars', { marka: 'Toyota', model: 'Corolla', logisticStatusId: serwisSt })).body;
    const list = await users.serwis.get('/api/cars');
    assert.deepEqual(list.body.items.map((x: any) => x.id), [c.id]);
    assert.equal(list.body.items[0].finance, undefined);
    assert.equal((await users.serwis.get('/api/dashboard')).status, 403);
    assert.equal((await users.serwis.patch(`/api/cars/${c.id}`, { version: c.version, cenaA: '1' })).status, 403);
    const moved = await users.serwis.post(`/api/cars/${c.id}/status`, { kind: 'logistic', statusId: naPlacu, version: c.version });
    assert.equal(moved.status, 200);
    assert.equal(moved.body.car, null); // auto poza zakresem roli
    assert.equal((await users.serwis.get(`/api/cars/${c.id}`)).status, 404);
  });

  test('Viewer i Księgowość: brak zarządzania użytkownikami', async () => {
    assert.equal((await users.viewer.get('/api/users')).status, 403);
    assert.equal((await users.ksiegowosc.get('/api/users')).status, 403);
    assert.equal((await users.viewer.get('/api/audit')).status, 403);
  });
});

describe('Dashboard', () => {
  test('Właściciel: liczby aut, wartości i kasa; Sprzedawca: bez danych finansowych', async () => {
    const d = await users.owner.get('/api/dashboard');
    assert.equal(d.status, 200);
    assert.equal(d.body.counts.rozliczone, 1);
    assert.equal(d.body.counts.wDrodze, 2); // Skoda, Audi
    assert.equal(d.body.counts.naPlacu, 1); // Toyota oddana z serwisu
    assert.equal(d.body.finance.zyskFaktyczny, '9500.00'); // 41000 − 31500 (bez kosztów — Etap 3)
    assert.equal(d.body.finance.zyskFaktycznyLiczbaAut, 1);
    assert.equal(d.body.kasa.aktualna, '0.00');
    const s = await users.sprzedawca.get('/api/dashboard');
    assert.equal(s.body.finance, null);
    assert.equal(s.body.kasa, null);
    assert.equal(s.body.kosztyRazem, null);
  });
});

describe('Użytkownicy i dziennik zmian', () => {
  test('Właściciel tworzy konto; słabe hasło odrzucone; nowy użytkownik może się zalogować', async () => {
    const weak = await users.owner.post('/api/users', { email: 'nowy@openauto.pl', fullName: 'Jan Nowy', role: 'serwis', password: 'abc' });
    assert.equal(weak.status, 400);
    const ok = await users.owner.post('/api/users', {
      email: 'Nowy@OpenAuto.pl',
      fullName: 'Jan Nowy',
      role: 'serwis',
      password: 'Mechanik-2026',
    });
    assert.equal(ok.status, 200);
    const fresh = await new ApiClient(srv.base).login('nowy@openauto.pl', 'Mechanik-2026');
    // hasło tymczasowe: dostęp tylko do zmiany hasła
    const blocked = await fresh.get('/api/cars');
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.error.code, 'password_change_required');
    assert.equal((await fresh.get('/api/auth/me')).body.mustChangePassword, true);
    const same = await fresh.post('/api/auth/password', { currentPassword: 'Mechanik-2026', newPassword: 'Mechanik-2026' });
    assert.equal(same.status, 400);
    const changed = await fresh.post('/api/auth/password', { currentPassword: 'Mechanik-2026', newPassword: 'Moje-wlasne-haslo-7' });
    assert.equal(changed.status, 200);
    assert.equal((await fresh.get('/api/cars')).status, 200);
    const manager = await users.manager.post('/api/users', { email: 'x@y.pl', fullName: 'X Y', role: 'owner', password: 'Haslo-12345' });
    assert.equal(manager.status, 403);
  });

  test('dziennik pokazuje kto i co zmienił', async () => {
    const log = await users.owner.get('/api/audit?entity=cars');
    const change = log.body.find((e: any) => e.changes.some((c: any) => c.field === 'kolor'));
    assert.equal(change.userName, 'Test owner');
    assert.deepEqual(
      change.changes.find((c: any) => c.field === 'kolor'),
      { field: 'kolor', from: null, to: 'Srebrny' },
    );
    const logins = await users.owner.get('/api/audit?entity=auth');
    assert.ok(logins.body.some((e: any) => e.action === 'LOGIN'));
  });

  test('zgadywanie obecnego hasła przy zmianie hasła jest ograniczone', async () => {
    const c = await new ApiClient(srv.base).login(A.users.viewer.email, A.users.viewer.password);
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await c.post('/api/auth/password', { currentPassword: 'zgaduje-' + i, newPassword: 'Nowe-haslo-2026' })).status);
    assert.deepEqual(codes, [400, 400, 400, 400, 400, 429]);
  });

  test('równoległe próby logowania nie omijają limitu', async () => {
    const attempts = await Promise.all(
      Array.from({ length: 30 }, () =>
        fetch(srv.base + '/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'openauto' },
          body: JSON.stringify({ email: 'cel-ataku@openauto.test', password: 'zgadywane' }),
        }).then((r) => r.status),
      ),
    );
    assert.ok(attempts.filter((s) => s === 401).length <= 10, `sprawdzono hasło ${attempts.filter((s) => s === 401).length} razy`);
    assert.ok(attempts.includes(429));
  });

  test('błędny adres nie powoduje błędu serwera ani wpisu w dzienniku błędów', async () => {
    const before = await t.owner.query<{ n: string }>('SELECT count(*) AS n FROM error_log');
    for (const p of ['/%E0', '/api/cars/%E0']) assert.equal((await users.owner.get(p)).status, 400, p);
    const after = await t.owner.query<{ n: string }>('SELECT count(*) AS n FROM error_log');
    assert.equal(after.rows[0].n, before.rows[0].n);
  });

  test('zmiana własnego hasła wylogowuje inne sesje', async () => {
    const other = await new ApiClient(srv.base).login(A.users.ksiegowosc.email, A.users.ksiegowosc.password);
    const mine = await new ApiClient(srv.base).login(A.users.ksiegowosc.email, A.users.ksiegowosc.password);
    const r = await mine.post('/api/auth/password', { currentPassword: A.users.ksiegowosc.password, newPassword: 'Nowe-haslo-2026' });
    assert.equal(r.status, 200);
    assert.equal((await other.get('/api/auth/me')).status, 401);
    assert.equal((await mine.get('/api/auth/me')).status, 200);
  });
});
