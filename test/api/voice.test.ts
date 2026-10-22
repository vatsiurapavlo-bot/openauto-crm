/**
 * Dyktowanie kosztów: tekst → (atrapa) Claude → weryfikacja i dopasowanie auta po stronie serwera.
 * Nic nie jest zapisywane — wynik to propozycja do formularza.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDatabase, seedWorkspace, type Seeded, type TestDb } from '../helpers/db.ts';
import { ApiClient, startServer } from '../helpers/server.ts';
import { startFakeAnthropic } from '../helpers/fake-anthropic.ts';

let t: TestDb;
let A: Seeded;
let srv: Awaited<ReturnType<typeof startServer>>;
let off: Awaited<ReturnType<typeof startServer>>;
let fake: Awaited<ReturnType<typeof startFakeAnthropic>>;
const u: Record<string, ApiClient> = {};
let meta: any;
const cars: Record<string, { id: string; numer: number }> = {};

const base = {
  kwota: null,
  kwota_typ: null,
  stawka_vat: null,
  sposob_platnosci: null,
  kategoria: null,
  data: null,
  opis: null,
  auto: null,
  czy_faktura: null,
  numer_faktury: null,
};

before(async () => {
  t = await createTestDatabase();
  A = await seedWorkspace(t.owner);
  fake = await startFakeAnthropic();
  srv = await startServer(t.app, 'dist/public', {
    backup: null,
    google: null,
    adminPool: null,
    anthropic: { apiKey: 'test-key-123', baseUrl: fake.base, model: 'claude-haiku-5-5', timeoutMs: 5000 },
  });
  off = await startServer(t.app); // bez klucza — funkcja wyłączona
  for (const role of Object.keys(A.users)) u[role] = await new ApiClient(srv.base).login(A.users[role].email, A.users[role].password);
  meta = (await u.owner.get('/api/meta')).body;
  for (const [k, body] of Object.entries({
    golf1: { marka: 'Volkswagen', model: 'Golf', numerRejestracyjny: 'WE 4F2K1', vin: 'WVWZZZ1KZ8W000123' },
    golf2: { marka: 'Volkswagen', model: 'Golf', numerRejestracyjny: 'PO 777AB' },
    audi: { marka: 'Audi', model: 'A4' },
  })) {
    const r = await u.owner.post('/api/cars', body);
    cars[k] = { id: r.body.id, numer: r.body.numer };
  }
});
after(async () => {
  await srv?.close();
  await off?.close();
  await fake?.close();
  await t?.drop();
});

const cat = (code: string) => meta.costCategories.find((c: any) => c.systemCode === code).id;
const parse = (text: string, who = 'owner') => u[who].post('/api/costs/parse', { text });

describe('Dyktowanie kosztów', () => {
  test('wyłączone bez klucza API: brak przycisku i 404', async () => {
    const c = await new ApiClient(off.base).login(A.users.owner.email, A.users.owner.password);
    assert.equal((await c.get('/api/meta')).body.voiceEnabled, false);
    assert.equal((await c.post('/api/costs/parse', { text: 'paliwo 100 zł' })).status, 404);
    assert.equal(meta.voiceEnabled, true);
  });

  test('tylko role z prawem dodawania kosztów', async () => {
    for (const role of ['viewer', 'sprzedawca', 'serwis']) {
      assert.equal((await u[role].get('/api/meta')).body.voiceEnabled, false, role);
      assert.equal((await parse('paliwo 100 zł', role)).status, 403, role);
    }
    assert.equal((await u.ksiegowosc.get('/api/meta')).body.voiceEnabled, true);
  });

  test('„paliwo 250 zł gotówką auto N” → propozycja z autem po numerze; nic nie zapisano', async () => {
    fake.state.input = {
      ...base,
      kwota: '250',
      kwota_typ: 'brutto',
      sposob_platnosci: 'gotowka',
      kategoria: 'inne',
      data: '2026-10-01',
      opis: 'Paliwo',
      auto: { numer: cars.audi.numer, rejestracja: null, vin_koncowka: null, marka_model: null },
    };
    const before = await t.owner.query<{ n: string }>('SELECT count(*) AS n FROM costs');
    const r = await parse(`Paliwo dwieście pięćdziesiąt złotych gotówką, auto ${cars.audi.numer}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.draft, {
      kwota: '250',
      kwotaTyp: 'brutto',
      sposobPlatnosci: 'gotowka',
      categoryId: cat('inne'),
      data: '2026-10-01',
      opis: 'Paliwo',
      carId: cars.audi.id,
    });
    assert.equal(r.body.car.status, 'found');
    assert.deepEqual(r.body.uwagi, []);
    const after = await t.owner.query<{ n: string }>('SELECT count(*) AS n FROM costs');
    assert.equal(after.rows[0].n, before.rows[0].n, 'rozpoznanie niczego nie zapisuje');
  });

  test('do Claude trafia tylko tekst, data i słowniki — bez listy aut; klucz w nagłówku', async () => {
    fake.state.input = { ...base, kwota: '10' };
    await parse('test prywatności 10 zł');
    const { headers, body } = fake.state.last!;
    assert.equal(headers['x-api-key'], 'test-key-123');
    assert.equal(headers['anthropic-version'], '2023-06-01');
    assert.equal(body.model, 'claude-haiku-5-5');
    assert.deepEqual(body.tool_choice, { type: 'tool', name: 'zapisz_koszt' });
    assert.deepEqual(body.messages, [{ role: 'user', content: 'test prywatności 10 zł' }]);
    const sent = JSON.stringify(body);
    for (const secret of ['WE 4F2K1', 'WVWZZZ1KZ8W000123', 'PO 777AB', A.users.owner.email]) assert.ok(!sent.includes(secret), secret);
    assert.match(body.system, /Transport/);
  });

  test('auto po rejestracji (spacje, małe litery) i po końcówce VIN', async () => {
    fake.state.input = { ...base, kwota: '1', auto: { numer: null, rejestracja: 'we4f2 k1', vin_koncowka: null, marka_model: null } };
    assert.equal((await parse('we 4f2 k1')).body.draft.carId, cars.golf1.id);
    fake.state.input = { ...base, kwota: '1', auto: { numer: null, rejestracja: null, vin_koncowka: '000123', marka_model: null } };
    assert.equal((await parse('vin 000123')).body.draft.carId, cars.golf1.id);
  });

  test('kilka pasujących aut → bez wyboru, lista do kliknięcia; brak auta → uwaga', async () => {
    fake.state.input = { ...base, kwota: '1', auto: { numer: null, rejestracja: null, vin_koncowka: null, marka_model: 'Volkswagen Golf' } };
    const amb = (await parse('golf')).body;
    assert.equal(amb.car.status, 'ambiguous');
    assert.equal(amb.draft.carId, undefined);
    assert.deepEqual(amb.car.candidates.map((c: any) => c.id).sort(), [cars.golf1.id, cars.golf2.id].sort());
    assert.ok(amb.uwagi.some((x: string) => /kilka aut/.test(x)));
    fake.state.input = { ...base, kwota: '1', auto: { numer: 99999, rejestracja: null, vin_koncowka: null, marka_model: null } };
    const none = (await parse('auto 99999')).body;
    assert.equal(none.car.status, 'not_found');
    assert.ok(none.uwagi.some((x: string) => /Nie znaleziono auta/.test(x)));
  });

  test('auto innej przestrzeni nie jest dopasowane', async () => {
    const B = await seedWorkspace(t.owner, 'abauto');
    const ownerB = await new ApiClient(srv.base).login(B.users.owner.email, B.users.owner.password);
    await ownerB.post('/api/cars', { marka: 'Skoda', model: 'Superb', numerRejestracyjny: 'KR 99999' });
    fake.state.input = { ...base, kwota: '1', auto: { numer: null, rejestracja: 'KR 99999', vin_koncowka: null, marka_model: null } };
    assert.equal((await parse('kr 99999')).body.car.status, 'not_found');
  });

  test('błędne pola z modelu są odrzucane, a nie zapisywane w propozycji', async () => {
    fake.state.input = {
      ...base,
      kwota: 'dużo',
      kwota_typ: 'cokolwiek',
      stawka_vat: '99%',
      sposob_platnosci: 'bitcoin',
      kategoria: 'nieistnieje',
      data: '2031-01-01',
      opis: '',
      auto: 'nie obiekt',
    };
    const r = (await parse('coś niezrozumiałego')).body;
    assert.deepEqual(r.draft, { kwotaTyp: 'brutto' });
    assert.ok(r.uwagi.some((x: string) => /kwoty/.test(x)));
    assert.ok(r.uwagi.some((x: string) => /sposobu płatności/.test(x)));
    assert.ok(r.uwagi.some((x: string) => /kategorię/.test(x)));
    assert.ok(r.uwagi.some((x: string) => /daty/.test(x)));
    fake.state.input = { ...base, kwota: '-50' };
    assert.equal((await parse('minus pięćdziesiąt')).body.draft.kwota, undefined);
    fake.state.input = { ...base, kwota: '1234.5', kwota_typ: 'netto', stawka_vat: '23%', czy_faktura: true, numer_faktury: 'FV/1' };
    const ok = (await parse('netto z fakturą')).body.draft;
    assert.equal(ok.kwota, '1234,50');
    assert.equal(ok.kwotaTyp, 'netto');
    assert.equal(ok.vatRateId, meta.vatRates.find((v: any) => v.label === '23%').id);
    assert.equal(ok.numerFaktury, 'FV/1');
  });

  test('awaria usługi lub brak odpowiedzi narzędzia → czytelny błąd 502, bez szczegółów technicznych', async () => {
    fake.state.status = 529;
    const a = await parse('paliwo 100');
    assert.equal(a.status, 502);
    assert.match(a.body.error.message, /wpisać koszt ręcznie/);
    assert.ok(!JSON.stringify(a.body).includes('test-key-123'));
    fake.state.status = 200;
    fake.state.input = null;
    const b = await parse('paliwo 100');
    assert.equal(b.status, 502);
  });

  test('walidacja tekstu', async () => {
    assert.equal((await u.owner.post('/api/costs/parse', { text: 'a' })).status, 400);
    assert.equal((await u.owner.post('/api/costs/parse', { text: 'x'.repeat(601) })).status, 400);
    assert.equal((await u.owner.post('/api/costs/parse', { text: 'paliwo', extra: 1 })).status, 400);
  });
});
