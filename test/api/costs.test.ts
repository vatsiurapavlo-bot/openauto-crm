/**
 * Etap 3 — API Kosztów i Kasy (HTTP → serwer → PostgreSQL z RLS i triggerami).
 * Testy z ТЗ p. 13: 6 dodanie kosztu, 7 obciążenie kasy gotówką, 8 brak podwójnego obciążenia,
 * 9 edycja kosztu, 10 poprawne saldo kasy.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createTestDatabase, seedWorkspace, type Seeded, type TestDb } from '../helpers/db.ts';
import { ApiClient, startServer } from '../helpers/server.ts';

let t: TestDb;
let A: Seeded;
let srv: Awaited<ReturnType<typeof startServer>>;
const u: Record<string, ApiClient> = {};
let meta: any;
let carId: string;

before(async () => {
  t = await createTestDatabase();
  A = await seedWorkspace(t.owner);
  srv = await startServer(t.app);
  for (const role of Object.keys(A.users)) u[role] = await new ApiClient(srv.base).login(A.users[role].email, A.users[role].password);
  meta = (await u.owner.get('/api/meta')).body;
  const car = await u.owner.post('/api/cars', { marka: 'Audi', model: 'A6', rokProdukcji: 2018, finance: { wartoscAuta: '50000' } });
  carId = car.body.id;
});
after(async () => {
  await srv?.close();
  await t?.drop();
});

const cat = (code: string) => meta.costCategories.find((c: any) => c.systemCode === code).id;
const vat = (label: string) => meta.vatRates.find((v: any) => v.label === label).id;
const key = () => crypto.randomUUID();
const cost = (extra: Record<string, unknown> = {}) => ({
  data: '2026-10-01',
  opis: 'Dostawa',
  categoryId: cat('transport'),
  carId,
  vatRateId: vat('0%'),
  kwota: '1500',
  kwotaTyp: 'brutto',
  sposobPlatnosci: 'gotowka',
  czyFaktura: false,
  ...extra,
});
const kasaNow = async () => (await u.owner.get('/api/kasa')).body;

describe('Koszty', () => {
  test('słowniki w meta: 8 kategorii z ТЗ i stawki 0% / 23%', () => {
    assert.deepEqual(
      meta.costCategories.map((c: any) => c.name),
      ['Transport', 'Serwis', 'Lakiernia', 'Części', 'Aukcja', 'Opłaty', 'Akcyza', 'Inne'],
    );
    assert.deepEqual(meta.vatRates.map((v: any) => v.label), ['0%', '23%']);
  });

  test('dodanie kosztu gotówką → automatyczny wydatek w Kasie (przykład z ТЗ: Dostawa 1500 PLN)', async () => {
    const before = (await kasaNow()).aktualna;
    const r = await u.manager.post('/api/costs', cost({ clientKey: key() }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.kwotaBrutto, '1500.00');
    assert.equal(r.body.wplywNaKase, '-1500.00');
    assert.equal(r.body.car.id, carId);
    const k = await kasaNow();
    assert.equal(Number(k.aktualna), Number(before) - 1500);
    const op = k.items.find((o: any) => o.costId === r.body.id);
    assert.equal(op.typ, 'wydatek');
    assert.equal(op.kwota, '-1500.00');
    assert.equal(op.car.id, carId);
    assert.equal(op.costNumer, r.body.numer);
    // koszt wliczony do finansów auta
    const car = await u.owner.get(`/api/cars/${carId}`);
    assert.ok(Number(car.body.finance.kosztyRazem) >= 1500);
  });

  test('przelew nie zmienia kasy; VAT 23% liczony z netto i z brutto', async () => {
    const before = (await kasaNow()).aktualna;
    const net = await u.owner.post('/api/costs', cost({ kwota: '1000', kwotaTyp: 'netto', vatRateId: vat('23%'), sposobPlatnosci: 'przelew', czyFaktura: true, numerFaktury: 'FV/1/2026' }));
    assert.deepEqual([net.body.kwotaNetto, net.body.kwotaVat, net.body.kwotaBrutto], ['1000.00', '230.00', '1230.00']);
    assert.equal(net.body.vatDoOdliczenia, true, 'faktura z VAT → domyślnie do odliczenia');
    assert.equal(net.body.wplywNaKase, '0.00');
    const gross = await u.owner.post('/api/costs', cost({ kwota: '123,00', kwotaTyp: 'brutto', vatRateId: vat('23%'), sposobPlatnosci: 'karta' }));
    assert.deepEqual([gross.body.kwotaNetto, gross.body.kwotaVat, gross.body.kwotaBrutto], ['100.00', '23.00', '123.00']);
    assert.equal((await kasaNow()).aktualna, before);
  });

  test('ten sam formularz wysłany dwa razy → jeden koszt i jedno obciążenie kasy', async () => {
    const before = Number((await kasaNow()).aktualna);
    const k = key();
    const [a, b] = await Promise.all([
      u.owner.post('/api/costs', cost({ kwota: '77', clientKey: k })),
      u.owner.post('/api/costs', cost({ kwota: '77', clientKey: k })),
    ]);
    const c = await u.owner.post('/api/costs', cost({ kwota: '77', clientKey: k }));
    const ids = new Set([a, b, c].filter((r) => r.status === 200).map((r) => r.body.id));
    assert.equal(ids.size, 1);
    assert.equal(Number((await kasaNow()).aktualna), before - 77);
  });

  test('edycja: zmiana kwoty i sposobu płatności → korekty; blokada wersji; anulowanie oddaje gotówkę', async () => {
    const before = Number((await kasaNow()).aktualna);
    const c = (await u.owner.post('/api/costs', cost({ kwota: '500' }))).body;
    const e1 = await u.owner.patch(`/api/costs/${c.id}`, { ...cost({ kwota: '650' }), version: c.version });
    assert.equal(e1.status, 200, JSON.stringify(e1.body));
    assert.equal(e1.body.wplywNaKase, '-650.00');
    const stale = await u.manager.patch(`/api/costs/${c.id}`, { ...cost({ kwota: '1' }), version: c.version });
    assert.equal(stale.status, 409);
    const e2 = await u.owner.patch(`/api/costs/${c.id}`, { ...cost({ kwota: '650', sposobPlatnosci: 'przelew' }), version: e1.body.version });
    assert.equal(e2.body.wplywNaKase, '0.00');
    assert.equal(Number((await kasaNow()).aktualna), before);
    const e3 = await u.owner.patch(`/api/costs/${c.id}`, { ...cost({ kwota: '650' }), version: e2.body.version });
    assert.equal(Number((await kasaNow()).aktualna), before - 650);
    const cancelled = await u.owner.post(`/api/costs/${c.id}/cancel`, { version: e3.body.version });
    assert.ok(cancelled.body.cancelledAt);
    assert.equal(cancelled.body.wplywNaKase, '0.00');
    assert.equal(Number((await kasaNow()).aktualna), before);
    const ops = (await kasaNow()).items.filter((o: any) => o.costId === c.id).map((o: any) => [o.typ, o.kwota]).reverse();
    assert.deepEqual(ops, [
      ['wydatek', '-500.00'],
      ['korekta', '-150.00'],
      ['korekta', '650.00'],
      ['korekta', '-650.00'],
      ['korekta', '650.00'],
    ]);
    const again = await u.owner.patch(`/api/costs/${c.id}`, { ...cost(), version: cancelled.body.version });
    assert.equal(again.status, 400);
    // lista: anulowane domyślnie ukryte
    const list = await u.owner.get('/api/costs');
    assert.ok(!list.body.items.some((i: any) => i.id === c.id));
    const all = await u.owner.get('/api/costs?status=cancelled');
    assert.ok(all.body.items.some((i: any) => i.id === c.id));
  });

  test('walidacja: kwota, data, kategoria, stawka i auto z innej przestrzeni, pola dodatkowe', async () => {
    const bad = async (extra: Record<string, unknown>, field: string) => {
      const r = await u.owner.post('/api/costs', cost(extra));
      assert.equal(r.status, 400, field + ' ' + JSON.stringify(r.body));
      assert.ok(r.body.error.details?.fields?.[field], `${field}: ${JSON.stringify(r.body)}`);
    };
    await bad({ kwota: '0' }, 'kwota');
    await bad({ kwota: '-10' }, 'kwota');
    await bad({ kwota: '12,345' }, 'kwota');
    await bad({ kwota: 'abc' }, 'kwota');
    await bad({ data: '2026-02-30' }, 'data');
    await bad({ data: '1999-12-31' }, 'data');
    await bad({ opis: ' ' }, 'opis');
    await bad({ categoryId: crypto.randomUUID() }, 'categoryId');
    await bad({ vatRateId: crypto.randomUUID() }, 'vatRateId');
    await bad({ carId: crypto.randomUUID() }, 'carId');
    const extra = await u.owner.post('/api/costs', { ...cost(), kwotaBrutto: '1' });
    assert.equal(extra.status, 400);
    // auto innej przestrzeni — niewidoczne
    const B = await seedWorkspace(t.owner, 'abauto');
    const ownerB = await new ApiClient(srv.base).login(B.users.owner.email, B.users.owner.password);
    const carB = await ownerB.post('/api/cars', { marka: 'Skoda', model: 'Fabia' });
    await bad({ carId: carB.body.id }, 'carId');
    // koszty B niewidoczne w A
    await ownerB.post('/api/costs', {
      ...cost({ carId: carB.body.id, categoryId: (await ownerB.get('/api/meta')).body.costCategories[0].id, vatRateId: null }),
    });
    const listA = await u.owner.get('/api/costs?status=all');
    assert.ok(!listA.body.items.some((i: any) => i.carId === carB.body.id));
  });

  test('uprawnienia: Sprzedawca i Serwis bez Kosztów/Kasy; Księgowość dodaje koszt gotówką bez prawa do kasy', async () => {
    for (const role of ['sprzedawca', 'serwis', 'viewer']) {
      assert.equal((await u[role].get('/api/costs')).status, 403, role);
      assert.equal((await u[role].post('/api/costs', cost())).status, 403, role);
      assert.equal((await u[role].get('/api/kasa')).status, 403, role);
    }
    const before = Number((await kasaNow()).aktualna);
    const r = await u.ksiegowosc.post('/api/costs', cost({ kwota: '40' }));
    assert.equal(r.status, 200);
    assert.equal(Number((await kasaNow()).aktualna), before - 40, 'obciążenie kasy tworzy baza');
    const manual = await u.ksiegowosc.post('/api/kasa', { typ: 'wplata', kwota: '100', data: '2026-10-01', opis: 'Wpłata', clientKey: key() });
    assert.equal(manual.status, 403);
  });

  test('filtry: auto, koszty firmy, kategoria, sposób, okres, szukanie; sumy netto/VAT/brutto', async () => {
    await u.owner.post('/api/costs', cost({ carId: null, opis: 'Czynsz za plac', categoryId: cat('oplaty'), kwota: '2000', sposobPlatnosci: 'przelew', data: '2026-09-15' }));
    const firma = await u.owner.get('/api/costs?zakres=firma');
    assert.ok(firma.body.items.length >= 1);
    assert.ok(firma.body.items.every((i: any) => i.carId === null));
    const byCar = await u.owner.get(`/api/costs?car=${carId}`);
    assert.ok(byCar.body.items.every((i: any) => i.carId === carId));
    const sep = await u.owner.get('/api/costs?od=2026-09-01&do=2026-09-30');
    assert.ok(sep.body.items.every((i: any) => i.data.startsWith('2026-09')));
    const q = await u.owner.get('/api/costs?q=czynsz');
    assert.equal(q.body.items[0].opis, 'Czynsz za plac');
    const s = q.body.sum;
    assert.equal(Number(s.brutto), Number(s.netto) + Number(s.vat));
    const inj = await u.owner.get(`/api/costs?q=${encodeURIComponent("%' OR 1=1 --")}&kategoria=x&sposob=y&limit=99999999`);
    assert.equal(inj.status, 200);
    assert.equal(inj.body.items.length, 0);
  });
});

describe('Kasa', () => {
  test('ręczne operacje: wpłata (+), wypłata (−), korekta z kierunkiem; saldo po operacji; idempotencja', async () => {
    const before = Number((await kasaNow()).aktualna);
    const k = key();
    const w = await u.manager.post('/api/kasa', { typ: 'wplata', kwota: '10 000', data: '2026-10-02', opis: 'Wpłata z banku', clientKey: k });
    assert.equal(w.status, 200, JSON.stringify(w.body));
    assert.equal(w.body.kwota, '10000.00');
    const dup = await u.manager.post('/api/kasa', { typ: 'wplata', kwota: '10 000', data: '2026-10-02', opis: 'Wpłata z banku', clientKey: k });
    assert.equal(dup.body.id, w.body.id, 'drugie wysłanie = ta sama operacja');
    const out = await u.manager.post('/api/kasa', { typ: 'wyplata', kwota: '300', data: '2026-10-02', opis: 'Wypłata zaliczki', clientKey: key() });
    assert.equal(out.body.kwota, '-300.00');
    const kor = await u.owner.post('/api/kasa', { typ: 'korekta', kwota: '0,50', kierunek: 'minus', data: '2026-10-02', opis: 'Różnica przy liczeniu', clientKey: key() });
    assert.equal(kor.body.kwota, '-0.50');
    const noDir = await u.owner.post('/api/kasa', { typ: 'korekta', kwota: '1', data: '2026-10-02', opis: 'x y z', clientKey: key() });
    assert.equal(noDir.status, 400);
    const exp = await u.owner.post('/api/kasa', { typ: 'wydatek', kwota: '1', data: '2026-10-02', opis: 'x y z', clientKey: key() });
    assert.equal(exp.status, 400, 'wydatek gotówkowy tylko przez Koszty');
    const view = await kasaNow();
    assert.equal(Number(view.aktualna), before + 10000 - 300 - 0.5);
    // saldo najnowszej operacji = aktualna kasa
    assert.equal(view.items[0].saldoPoOperacji, view.aktualna);
    // kolejne salda spójne: saldo[i] = saldo[i+1] + kwota[i]
    for (let i = 0; i < view.items.length - 1; i++) {
      const cur = view.items[i];
      const prev = view.items[i + 1];
      assert.equal(Math.round((Number(prev.saldoPoOperacji) + Number(cur.kwota)) * 100), Math.round(Number(cur.saldoPoOperacji) * 100));
    }
  });

  test('saldo początkowe tylko przed pierwszą operacją', async () => {
    assert.equal((await kasaNow()).canSetInitial, false);
    const r = await u.owner.post('/api/kasa/saldo-poczatkowe', { saldo: '5000', data: '2026-01-01' });
    assert.equal(r.status, 400);
    const C = await seedWorkspace(t.owner, 'nowa');
    const ownerC = await new ApiClient(srv.base).login(C.users.owner.email, C.users.owner.password);
    assert.equal((await ownerC.get('/api/kasa')).body.canSetInitial, true);
    const set = await ownerC.post('/api/kasa/saldo-poczatkowe', { saldo: '5 000,00', data: '2026-01-01' });
    assert.equal(set.status, 200);
    assert.equal(set.body.aktualna, '5000.00');
    assert.equal((await ownerC.get('/api/kasa')).body.saldoPoczatkowe, '5000.00');
  });
});
