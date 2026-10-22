/**
 * Testy schematu na prawdziwym PostgreSQL: numeracja, niezmienność, RLS, historia, audyt, kasa.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDatabase, seedWorkspace, statusId, type Seeded, type TestDb } from '../helpers/db.ts';
import { ALL_PERMISSIONS } from '../../src/shared/permissions.ts';
import type { Queryable } from '../../src/server/db/index.ts';

let t: TestDb;
let A: Seeded;
let B: Seeded; // druga przestrzeń (przyszłe AB Auto)

before(async () => {
  t = await createTestDatabase();
  A = await seedWorkspace(t.owner, 'openauto');
  B = await seedWorkspace(t.owner, 'abauto');
  // kasa prowadzona „od zawsze” w A — testy nie zależą od dnia uruchomienia
  await t.owner.query("UPDATE kasa_accounts SET data_poczatkowa = '2000-01-01' WHERE workspace_id = $1", [A.workspaceId]);
});
after(async () => t?.drop());

const as = <T>(s: Seeded, role: string, fn: (q: Queryable) => Promise<T>) =>
  t.app.tx({ workspaceId: s.workspaceId, userId: s.users[role].id }, fn);

async function insertCar(s: Seeded, role: string, marka = 'Volkswagen', model = 'Tiguan', extra: Record<string, unknown> = {}) {
  const ws = s.workspaceId;
  const cols = ['workspace_id', 'marka', 'model', 'logistic_status_id', 'sales_status_id', 'settlement_status_id', ...Object.keys(extra)];
  const vals: unknown[] = [
    ws,
    marka,
    model,
    extra.logistic_status_id ?? (await statusId(t.owner, ws, 'logistic', 'w_drodze')),
    await statusId(t.owner, ws, 'sales', 'przygotowanie'),
    await statusId(t.owner, ws, 'settlement', 'otwarte'),
  ];
  for (const k of Object.keys(extra)) if (k !== 'logistic_status_id') vals.push(extra[k]);
  if ('logistic_status_id' in extra) cols.splice(cols.lastIndexOf('logistic_status_id'), 1);
  return as(s, role, async (q) => {
    const r = await q.query<{ id: string; numer: string }>(
      `INSERT INTO cars (${cols.join(',')}) VALUES (${vals.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING id, numer`,
      vals,
    );
    return { id: r.rows[0].id, numer: Number(r.rows[0].numer) };
  });
}

describe('Numer auta', () => {
  test('kolejne numery 1, 2, 3 — osobno dla każdej przestrzeni', async () => {
    const a1 = await insertCar(A, 'owner');
    const a2 = await insertCar(A, 'owner', 'Skoda', 'Octavia');
    const b1 = await insertCar(B, 'owner', 'Audi', 'A4');
    assert.equal(a1.numer, 1);
    assert.equal(a2.numer, 2);
    assert.equal(b1.numer, 1);
  });

  test('numer nadaje baza — wartość podana przez klienta jest ignorowana', async () => {
    const ws = A.workspaceId;
    const r = await as(A, 'owner', async (q) =>
      q.query<{ numer: string }>(
        `INSERT INTO cars (workspace_id, numer, marka, model, logistic_status_id, sales_status_id, settlement_status_id)
         VALUES ($1, 999, 'BMW', 'X3', $2, $3, $4) RETURNING numer`,
        [ws, await statusId(t.owner, ws, 'logistic', 'na_placu'), await statusId(t.owner, ws, 'sales', 'przygotowanie'), await statusId(t.owner, ws, 'settlement', 'otwarte')],
      ),
    );
    assert.notEqual(Number(r.rows[0].numer), 999);
  });

  test('numer jest niezmienny', async () => {
    const c = await insertCar(A, 'owner');
    await assert.rejects(
      as(A, 'owner', (q) => q.query('UPDATE cars SET numer = 5000 WHERE id = $1', [c.id])),
      /niezmienne/,
    );
  });

  test('numery nie są używane ponownie po archiwizacji ani po wycofanej transakcji', async () => {
    const c = await insertCar(A, 'owner');
    await as(A, 'owner', (q) => q.query('UPDATE cars SET deleted_at = now() WHERE id = $1', [c.id]));
    // rola aplikacji nie ma prawa DELETE — fizyczne usunięcie jest niemożliwe
    await assert.rejects(as(A, 'owner', (q) => q.query('DELETE FROM cars WHERE id = $1', [c.id])), /permission denied/);
    const next = await insertCar(A, 'owner');
    assert.equal(next.numer, c.numer + 1);
  });

  test('równoległe dodawanie przez wielu użytkowników daje unikalne, ciągłe numery', async () => {
    const before = await insertCar(A, 'owner');
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => insertCar(A, i % 2 ? 'owner' : 'manager', 'Kia', 'Ceed ' + i)),
    );
    const nums = results.map((r) => r.numer).sort((a, b) => a - b);
    assert.equal(new Set(nums).size, 20);
    assert.deepEqual(nums, Array.from({ length: 20 }, (_, i) => before.numer + 1 + i));
  });
});

describe('Row-Level Security', () => {
  test('przestrzenie są od siebie odizolowane (OpenAuto nie widzi AB Auto)', async () => {
    const bCar = await insertCar(B, 'owner', 'Mazda', 'CX-5');
    const seen = await as(A, 'owner', (q) => q.query('SELECT id FROM cars WHERE id = $1', [bCar.id]));
    assert.equal(seen.rowCount, 0);
    // nie można też wstawić auta do cudzej przestrzeni
    const wsB = B.workspaceId;
    await assert.rejects(
      as(A, 'owner', async (q) =>
        q.query(
          `INSERT INTO cars (workspace_id, marka, model, logistic_status_id, sales_status_id, settlement_status_id)
           VALUES ($1, 'X', 'Y', $2, $3, $4)`,
          [wsB, await statusId(t.owner, wsB, 'logistic', 'w_drodze'), await statusId(t.owner, wsB, 'sales', 'przygotowanie'), await statusId(t.owner, wsB, 'settlement', 'otwarte')],
        ),
      ),
      /row-level security/,
    );
  });

  test('bez kontekstu sesji rola aplikacji nie widzi żadnych aut', async () => {
    const r = await t.app.tx(null, (q) => q.query('SELECT count(*)::int AS n FROM cars'));
    assert.equal(r.rows[0].n, 0);
  });

  test('dane finansowe auta widzą tylko role z cars.finance.view', async () => {
    const c = await insertCar(A, 'owner', 'Ford', 'Kuga');
    await as(A, 'manager', (q) =>
      q.query('INSERT INTO car_finance (car_id, workspace_id, wartosc_auta) VALUES ($1, $2, 41000)', [c.id, A.workspaceId]),
    );
    const visible = async (role: string) =>
      (await as(A, role, (q) => q.query('SELECT wartosc_auta FROM car_finance WHERE car_id = $1', [c.id]))).rowCount;
    assert.equal(await visible('owner'), 1);
    assert.equal(await visible('ksiegowosc'), 1);
    assert.equal(await visible('sprzedawca'), 0);
    assert.equal(await visible('serwis'), 0);
    assert.equal(await visible('viewer'), 0);
    await assert.rejects(
      as(A, 'sprzedawca', (q) =>
        q.query('INSERT INTO car_finance (car_id, workspace_id, wartosc_auta) VALUES ($1, $2, 1)', [c.id, A.workspaceId]),
      ),
      /row-level security/,
    );
  });

  test('Serwis widzi tylko auta w statusie Serwis i może zmienić tylko status', async () => {
    const serwisId = await statusId(t.owner, A.workspaceId, 'logistic', 'serwis');
    const naPlacuId = await statusId(t.owner, A.workspaceId, 'logistic', 'na_placu');
    const inService = await insertCar(A, 'owner', 'Toyota', 'RAV4', { logistic_status_id: serwisId });
    const onLot = await insertCar(A, 'owner', 'Opel', 'Astra', { logistic_status_id: naPlacuId });
    const ids = (await as(A, 'serwis', (q) => q.query<{ id: string }>('SELECT id FROM cars'))).rows.map((r) => r.id);
    assert.ok(ids.includes(inService.id));
    assert.ok(!ids.includes(onLot.id));
    // Lakiernia nie widzi auta w serwisie
    const lak = await as(A, 'lakiernia', (q) => q.query('SELECT id FROM cars WHERE id = $1', [inService.id]));
    assert.equal(lak.rowCount, 0);
    // zmiana innych pól — zablokowana w bazie
    await assert.rejects(
      as(A, 'serwis', (q) => q.query(`UPDATE cars SET cena_a = 1 WHERE id = $1`, [inService.id])),
      /Brak uprawnień do edycji/,
    );
    // rozliczenie — zablokowane
    const rozl = await statusId(t.owner, A.workspaceId, 'settlement', 'rozliczone');
    await assert.rejects(
      as(A, 'serwis', (q) => q.query('UPDATE cars SET settlement_status_id = $2 WHERE id = $1', [inService.id, rozl])),
      /rozliczania/,
    );
    // bezpośredni UPDATE poza zakres roli blokuje RLS (nowy wiersz byłby niewidoczny)
    await assert.rejects(
      as(A, 'serwis', (q) => q.query('UPDATE cars SET logistic_status_id = $2 WHERE id = $1', [inService.id, naPlacuId])),
      /row-level security/,
    );
    // zmiana statusu przez funkcję bazy — dozwolona (auto wraca na plac i znika z widoku Serwisu)
    const upd = await as(A, 'serwis', (q) =>
      q.query<{ v: number }>('SELECT app_change_car_status($1, $2, $3, $4) AS v', [inService.id, 'logistic', naPlacuId, 1]),
    );
    assert.equal(upd.rows[0].v, 2);
    // ponowna zmiana: auta już nie widać → "nie znaleziono", a nie dostęp do cudzego auta
    await assert.rejects(
      as(A, 'serwis', (q) => q.query('SELECT app_change_car_status($1, $2, $3, $4)', [inService.id, 'logistic', serwisId, 2])),
      /Nie znaleziono/,
    );
    // Serwis nie zmienia statusu sprzedaży (np. na „Sprzedany”) — ani funkcją, ani bezpośrednio
    const sold = await statusId(t.owner, A.workspaceId, 'sales', 'sprzedany');
    const another = await insertCar(A, 'owner', 'Mazda', '3', { logistic_status_id: serwisId });
    await assert.rejects(
      as(A, 'serwis', (q) => q.query('SELECT app_change_car_status($1, $2, $3, $4)', [another.id, 'sales', sold, 1])),
      /statusu sprzedaży/,
    );
    await assert.rejects(
      as(A, 'serwis', (q) => q.query('UPDATE cars SET sales_status_id = $2 WHERE id = $1', [another.id, sold])),
      /Brak uprawnień do edycji/,
    );
    // nieaktualna wersja → konflikt
    await assert.rejects(
      as(A, 'owner', (q) => q.query('SELECT app_change_car_status($1, $2, $3, $4)', [inService.id, 'logistic', serwisId, 1])),
      /Nieaktualna wersja/,
    );
    const after = await as(A, 'serwis', (q) => q.query('SELECT id FROM cars WHERE id = $1', [inService.id]));
    assert.equal(after.rowCount, 0);
  });

  test('Viewer nie może dodawać ani edytować aut', async () => {
    const ws = A.workspaceId;
    await assert.rejects(
      as(A, 'viewer', async (q) =>
        q.query(
          `INSERT INTO cars (workspace_id, marka, model, logistic_status_id, sales_status_id, settlement_status_id)
           VALUES ($1, 'X', 'Y', $2, $3, $4)`,
          [ws, await statusId(t.owner, ws, 'logistic', 'w_drodze'), await statusId(t.owner, ws, 'sales', 'przygotowanie'), await statusId(t.owner, ws, 'settlement', 'otwarte')],
        ),
      ),
      /row-level security/,
    );
    const c = await insertCar(A, 'owner');
    const r = await as(A, 'viewer', (q) => q.query("UPDATE cars SET notatka = 'x' WHERE id = $1", [c.id]));
    assert.equal(r.rowCount, 0); // wiersz niewidoczny dla UPDATE
  });

  test('kasa i koszty niedostępne dla Sprzedawcy', async () => {
    for (const table of ['kasa_operations', 'costs', 'kasa_accounts', 'audit_log']) {
      const r = await as(A, 'sprzedawca', (q) => q.query(`SELECT count(*)::int AS n FROM ${table}`));
      assert.equal(r.rows[0].n, 0, table);
    }
    const own = await as(A, 'owner', (q) => q.query('SELECT count(*)::int AS n FROM kasa_accounts'));
    assert.equal(own.rows[0].n, 1);
  });
});

describe('Historia statusów i audyt', () => {
  test('każda zmiana statusu zapisuje datę, godzinę i użytkownika', async () => {
    const c = await insertCar(A, 'owner', 'Honda', 'Civic');
    const naPlacu = await statusId(t.owner, A.workspaceId, 'logistic', 'na_placu');
    await as(A, 'manager', (q) => q.query('UPDATE cars SET logistic_status_id = $2 WHERE id = $1', [c.id, naPlacu]));
    const { rows } = await t.owner.query(
      `SELECT kind, from_status_id, to_status_id, changed_by FROM car_status_history WHERE car_id = $1 ORDER BY id`,
      [c.id],
    );
    assert.equal(rows.length, 4); // 3 statusy przy utworzeniu + zmiana
    const last = rows[3];
    assert.equal(last.kind, 'logistic');
    assert.equal(last.to_status_id, naPlacu);
    assert.equal(last.changed_by, A.users.manager.id);
  });

  test('audyt zapisuje kto i co zmienił, bez hashy haseł', async () => {
    const c = await insertCar(A, 'owner', 'Fiat', '500');
    await as(A, 'manager', (q) => q.query("UPDATE cars SET notatka = 'po myjni' WHERE id = $1", [c.id]));
    const { rows } = await t.owner.query(
      "SELECT user_id, before->>'notatka' AS b, after->>'notatka' AS a FROM audit_log WHERE entity = 'cars' AND entity_id = $1 AND action = 'UPDATE'",
      [c.id],
    );
    assert.equal(rows[0].user_id, A.users.manager.id);
    assert.equal(rows[0].a, 'po myjni');
    const leaks = await t.owner.query("SELECT count(*)::int AS n FROM audit_log WHERE after ? 'password_hash' OR before ? 'password_hash'");
    assert.equal(leaks.rows[0].n, 0);
    // rola aplikacji nie może dopisywać ani zmieniać audytu
    await assert.rejects(as(A, 'owner', (q) => q.query('UPDATE audit_log SET action = $1', ['X'])), /permission denied/);
  });

  test('blokada optymistyczna: wersja rośnie przy każdej zmianie', async () => {
    const c = await insertCar(A, 'owner');
    await as(A, 'owner', (q) => q.query("UPDATE cars SET kolor = 'czarny' WHERE id = $1", [c.id]));
    const r = await as(A, 'owner', (q) => q.query<{ version: number }>('SELECT version FROM cars WHERE id = $1', [c.id]));
    assert.equal(r.rows[0].version, 2);
  });
});

describe('Koszty i Kasa (Etap 3)', () => {
  const cat = (s: Seeded, code: string) =>
    t.owner.query<{ id: string }>('SELECT id FROM cost_categories WHERE workspace_id = $1 AND system_code = $2', [s.workspaceId, code])
      .then((r) => r.rows[0].id);
  async function addCost(s: Seeded, role: string, v: { brutto: string; sposob: string; car?: string; opis?: string; data?: string }) {
    const c = await cat(s, 'transport');
    return as(s, role, async (q) =>
      (
        await q.query<{ id: string; numer: string; version: number }>(
          `INSERT INTO costs (workspace_id, data, opis, category_id, kwota_netto, kwota_vat, kwota_brutto, sposob_platnosci, car_id)
           VALUES ($1, coalesce($6::date, CURRENT_DATE), $2, $3, $4, 0, $4, $5, $7) RETURNING id, numer, version`,
          [s.workspaceId, v.opis ?? 'Dostawa', c, v.brutto, v.sposob, v.data ?? null, v.car ?? null],
        )
      ).rows[0],
    );
  }
  const ops = (costId: string) =>
    t.owner
      .query<{ typ: string; kwota: string; cost_version: number; created_by: string }>(
        'SELECT typ, kwota, cost_version, created_by FROM kasa_operations WHERE cost_id = $1 ORDER BY numer',
        [costId],
      )
      .then((r) => r.rows);
  const aktualna = (s: Seeded) =>
    t.owner
      .query<{ s: string }>(
        `SELECT a.saldo_poczatkowe + coalesce((SELECT sum(kwota) FROM kasa_operations o WHERE o.workspace_id = a.workspace_id AND o.potwierdzona), 0) AS s
         FROM kasa_accounts a WHERE a.workspace_id = $1`,
        [s.workspaceId],
      )
      .then((r) => r.rows[0].s);

  test('koszt gotówką → automatyczny wydatek w kasie; przelew → kasa bez zmian', async () => {
    const car = await insertCar(A, 'owner', 'Audi', 'A4');
    const before = Number(await aktualna(A));
    const g = await addCost(A, 'manager', { brutto: '1500.00', sposob: 'gotowka', car: car.id, opis: 'Dostawa' });
    const p = await addCost(A, 'manager', { brutto: '800.00', sposob: 'przelew', car: car.id });
    assert.deepEqual(
      (await ops(g.id)).map((o) => [o.typ, o.kwota, o.cost_version, o.created_by]),
      [['wydatek', '-1500.00', 1, A.users.manager.id]],
    );
    assert.equal((await ops(p.id)).length, 0);
    assert.equal(Number(await aktualna(A)), before - 1500);
    const op = await t.owner.query<{ opis: string; car_id: string }>('SELECT opis, car_id FROM kasa_operations WHERE cost_id = $1', [g.id]);
    assert.equal(op.rows[0].car_id, car.id);
    assert.match(op.rows[0].opis, new RegExp(`Koszt nr ${g.numer}: Dostawa`));
  });

  test('edycja i anulowanie: korekty różnicy, bez podwójnego obciążenia, saldo zgodne', async () => {
    const before = Number(await aktualna(A));
    const c = await addCost(A, 'owner', { brutto: '1000.00', sposob: 'gotowka' });
    const upd = (sql: string) => as(A, 'owner', (q) => q.query(`UPDATE costs SET ${sql} WHERE id = $1`, [c.id]));
    await upd("opis = 'Dostawa z Niemiec'"); // bez zmiany kwoty → brak operacji
    assert.equal((await ops(c.id)).length, 1);
    await upd('kwota_netto = 1200, kwota_brutto = 1200'); // −200
    await upd("sposob_platnosci = 'przelew'"); // +1200 (zwrot do kasy)
    await upd("sposob_platnosci = 'gotowka'"); // −1200
    await upd('cancelled_at = now()'); // +1200
    const list = await ops(c.id);
    assert.deepEqual(
      list.map((o) => [o.typ, o.kwota, o.cost_version]),
      [
        ['wydatek', '-1000.00', 1],
        ['korekta', '-200.00', 3],
        ['korekta', '1200.00', 4],
        ['korekta', '-1200.00', 5],
        ['korekta', '1200.00', 6],
      ],
    );
    assert.equal(list.reduce((a, o) => a + Number(o.kwota), 0), 0, 'anulowany koszt nie obciąża kasy');
    assert.equal(Number(await aktualna(A)), before);
    // anulowany koszt jest zamknięty
    await assert.rejects(upd("opis = 'x'"), /Anulowanego kosztu/);
  });

  test('ponowny zapis tej samej wersji nie tworzy drugiej operacji (idempotencja)', async () => {
    const c = await addCost(A, 'owner', { brutto: '300.00', sposob: 'gotowka' });
    // symulacja „synchronizacji”: koszt zapisany ponownie bez zmian kwoty
    await as(A, 'owner', (q) => q.query('UPDATE costs SET kwota_brutto = kwota_brutto WHERE id = $1', [c.id]));
    await as(A, 'owner', (q) => q.query('UPDATE costs SET kwota_brutto = kwota_brutto WHERE id = $1', [c.id]));
    assert.deepEqual((await ops(c.id)).map((o) => o.kwota), ['-300.00']);
    // ręczne dopisanie operacji „udającej” koszt jest zablokowane
    await assert.rejects(
      as(A, 'owner', (q) =>
        q.query(
          `INSERT INTO kasa_operations (workspace_id, data, typ, kwota, opis, cost_id, cost_version, idempotency_key)
           VALUES ($1, CURRENT_DATE, 'wydatek', -300, 'x', $2, 9, 'reczny')`,
          [A.workspaceId, c.id],
        ),
      ),
      /row-level security/,
    );
  });

  test('numer, wersja i autor kosztu nadaje baza; pola systemowe niezmienne', async () => {
    const c = await addCost(A, 'ksiegowosc', { brutto: '50.00', sposob: 'karta' });
    const row = await t.owner.query<{ version: number; created_by: string }>('SELECT version, created_by FROM costs WHERE id = $1', [c.id]);
    assert.equal(row.rows[0].version, 1);
    assert.equal(row.rows[0].created_by, A.users.ksiegowosc.id);
    await assert.rejects(as(A, 'owner', (q) => q.query('UPDATE costs SET numer = 999 WHERE id = $1', [c.id])), /nie można zmieniać/);
    await assert.rejects(
      as(A, 'owner', (q) => q.query('UPDATE costs SET created_by = $2 WHERE id = $1', [c.id, A.users.owner.id])),
      /nie można zmieniać/,
    );
    await as(A, 'owner', (q) => q.query("UPDATE costs SET opis = 'Paliwo' WHERE id = $1", [c.id]));
    const v = await t.owner.query<{ version: number }>('SELECT version FROM costs WHERE id = $1', [c.id]);
    assert.equal(v.rows[0].version, 2);
  });

  test('koszt nie może wskazywać auta, kategorii ani stawki VAT z innej przestrzeni', async () => {
    const carB = await insertCar(B, 'owner', 'Skoda', 'Octavia');
    await assert.rejects(addCost(A, 'owner', { brutto: '10.00', sposob: 'przelew', car: carB.id }), /Nie znaleziono samochodu/);
    const catB = await cat(B, 'inne');
    await assert.rejects(
      as(A, 'owner', (q) =>
        q.query(
          `INSERT INTO costs (workspace_id, data, opis, category_id, kwota_netto, kwota_vat, kwota_brutto, sposob_platnosci)
           VALUES ($1, CURRENT_DATE, 'x', $2, 10, 0, 10, 'przelew')`,
          [A.workspaceId, catB],
        ),
      ),
      /kategoria/,
    );
    const vatB = await t.owner.query<{ id: string }>('SELECT id FROM vat_rates WHERE workspace_id = $1 LIMIT 1', [B.workspaceId]);
    const c = await addCost(A, 'owner', { brutto: '10.00', sposob: 'przelew' });
    await assert.rejects(
      as(A, 'owner', (q) => q.query('UPDATE costs SET vat_rate_id = $2 WHERE id = $1', [c.id, vatB.rows[0].id])),
      /stawka VAT/,
    );
  });

  test('kwoty: brutto = netto + VAT, brutto dodatnie', async () => {
    const c = await cat(A, 'inne');
    const ins = (n: number, v: number, b: number) =>
      as(A, 'owner', (q) =>
        q.query(
          `INSERT INTO costs (workspace_id, data, opis, category_id, kwota_netto, kwota_vat, kwota_brutto, sposob_platnosci)
           VALUES ($1, CURRENT_DATE, 'x', $2, $3, $4, $5, 'przelew')`,
          [A.workspaceId, c, n, v, b],
        ),
      );
    await assert.rejects(ins(100, 23, 124), /check constraint/);
    await assert.rejects(ins(-100, 0, -100), /check constraint/);
    await assert.rejects(ins(0, 0, 0), /check constraint/);
  });

  test('ręczne operacje: tylko z kasa.edit, bez „wydatku”; dziennik niezmienny', async () => {
    const op = (role: string, typ: string, kwota: number) =>
      as(A, role, (q) =>
        q.query(
          `INSERT INTO kasa_operations (workspace_id, data, typ, kwota, opis, idempotency_key)
           VALUES ($1, CURRENT_DATE, $2, $3, 'Wpłata do kasy', $4)`,
          [A.workspaceId, typ, kwota, 'manual:' + Math.random()],
        ),
      );
    await op('manager', 'wplata', 5000);
    await assert.rejects(op('ksiegowosc', 'wplata', 100), /row-level security/); // costs.edit, ale bez kasa.edit
    await assert.rejects(op('owner', 'wydatek', -100), /row-level security/);
    await assert.rejects(op('owner', 'wplata', -100), /check constraint/);
    const last = await t.owner.query<{ id: string }>("SELECT id FROM kasa_operations WHERE typ = 'wplata' ORDER BY numer DESC LIMIT 1");
    const upd = await as(A, 'owner', (q) => q.query('UPDATE kasa_operations SET kwota = 1 WHERE id = $1', [last.rows[0].id]));
    assert.equal(upd.rowCount, 0);
    await assert.rejects(t.owner.query('UPDATE kasa_operations SET kwota = 1 WHERE id = $1', [last.rows[0].id]), /nie można zmieniać/);
    await assert.rejects(t.owner.query('DELETE FROM kasa_operations WHERE id = $1', [last.rows[0].id]), /nie można zmieniać/);
  });

  test('saldo po operacji liczone z dziennika; saldo początkowe tylko przed pierwszą operacją', async () => {
    // przestrzeń B: jeszcze bez operacji → saldo początkowe można ustawić
    await as(B, 'owner', (q) => q.query("UPDATE kasa_accounts SET saldo_poczatkowe = 2000, data_poczatkowa = '2026-01-01'"));
    // koszt gotówkowy sprzed dnia rozpoczęcia kasy jest już w saldzie początkowym → bez operacji
    const old = await addCost(B, 'owner', { brutto: '900.00', sposob: 'gotowka', data: '2025-12-20' });
    assert.equal((await ops(old.id)).length, 0);
    await addCost(B, 'owner', { brutto: '500.00', sposob: 'gotowka', data: '2026-01-10' });
    await addCost(B, 'owner', { brutto: '200.00', sposob: 'gotowka', data: '2026-01-05' }); // wcześniejsza data
    const ledger = await as(B, 'owner', (q) =>
      q.query<{ kwota: string; saldo_po_operacji: string }>('SELECT kwota, saldo_po_operacji FROM kasa_ledger ORDER BY data, numer'),
    );
    assert.deepEqual(
      ledger.rows.map((r) => [r.kwota, r.saldo_po_operacji]),
      [
        ['-200.00', '1800.00'],
        ['-500.00', '1300.00'],
      ],
    );
    assert.equal(await aktualna(B), '1300.00');
    await assert.rejects(as(B, 'owner', (q) => q.query('UPDATE kasa_accounts SET saldo_poczatkowe = 0')), /przed pierwszą operacją/);
    // przeniesienie daty kosztu na „przed rozpoczęciem kasy” zwraca gotówkę korektą
    const moved = await addCost(B, 'owner', { brutto: '100.00', sposob: 'gotowka', data: '2026-02-01' });
    await as(B, 'owner', (q) => q.query("UPDATE costs SET data = '2025-12-31' WHERE id = $1", [moved.id]));
    assert.deepEqual((await ops(moved.id)).map((o) => [o.typ, o.kwota]), [['wydatek', '-100.00'], ['korekta', '100.00']]);
  });

  test('ręczna operacja nie może zająć klucza operacji kosztu', async () => {
    const c = await addCost(A, 'owner', { brutto: '10.00', sposob: 'gotowka' });
    await assert.rejects(
      as(A, 'owner', (q) =>
        q.query(
          `INSERT INTO kasa_operations (workspace_id, data, typ, kwota, opis, idempotency_key)
           VALUES ($1, CURRENT_DATE, 'korekta', 1, 'x', $2)`,
          [A.workspaceId, `cost:${c.id}:v2`],
        ),
      ),
      /row-level security/,
    );
  });

  test('stawka VAT kosztu nie zmienia się po zmianie słownika ani bezpośrednim zapisem', async () => {
    const r23 = await t.owner.query<{ id: string }>("SELECT id FROM vat_rates WHERE workspace_id = $1 AND label = '23%'", [A.workspaceId]);
    const c = await addCost(A, 'owner', { brutto: '123.00', sposob: 'przelew' });
    await as(A, 'owner', (q) =>
      q.query('UPDATE costs SET vat_rate_id = $2, kwota_netto = 100, kwota_vat = 23 WHERE id = $1', [c.id, r23.rows[0].id]),
    );
    await as(A, 'owner', (q) => q.query('UPDATE costs SET stawka_vat = 0.5 WHERE id = $1', [c.id]));
    const s1 = await t.owner.query<{ s: string }>('SELECT stawka_vat::text AS s FROM costs WHERE id = $1', [c.id]);
    assert.equal(s1.rows[0].s, '0.2300');
  });
});

test('lista uprawnień w kodzie = lista nadawana przez bazę roli Właściciel', async () => {
  const { rows } = await t.owner.query<{ permission: string }>(
    "SELECT permission FROM role_permissions WHERE workspace_id = $1 AND role_code = 'owner' ORDER BY 1",
    [A.workspaceId],
  );
  assert.deepEqual(rows.map((r) => r.permission), [...ALL_PERMISSIONS].sort());
});

test('migracje są idempotentne — ponowne uruchomienie niczego nie zmienia', async () => {
  const { migrate } = await import('../../src/server/db/migrate.ts');
  const applied = await migrate(t.owner, { migrationsDir: 'db/migrations' });
  assert.deepEqual(applied, []);
});
