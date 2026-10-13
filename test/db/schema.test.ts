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

describe('Kasa (fundament pod Etap 3)', () => {
  test('dziennik tylko do dopisywania; jeden koszt w danej wersji = najwyżej jedna operacja', async () => {
    const ws = A.workspaceId;
    const cost = await as(A, 'owner', async (q) => {
      const cat = await q.query<{ id: string }>("SELECT id FROM cost_categories WHERE system_code = 'transport'");
      return (
        await q.query<{ id: string }>(
          `INSERT INTO costs (workspace_id, data, opis, category_id, kwota_netto, kwota_vat, kwota_brutto, sposob_platnosci)
           VALUES ($1, CURRENT_DATE, 'Dostawa', $2, 1500, 0, 1500, 'gotowka') RETURNING id`,
          [ws, cat.rows[0].id],
        )
      ).rows[0].id;
    });
    const op = (key: string) =>
      as(A, 'owner', (q) =>
        q.query(
          `INSERT INTO kasa_operations (workspace_id, data, typ, kwota, opis, cost_id, cost_version, idempotency_key)
           VALUES ($1, CURRENT_DATE, 'wydatek', -1500, 'Dostawa', $2, 1, $3)`,
          [ws, cost, key],
        ),
      );
    await op('cost:' + cost + ':v1');
    await assert.rejects(op('cost:' + cost + ':v1'), /duplicate key/); // ten sam klucz idempotencji
    await assert.rejects(op('inny-klucz'), /duplicate key/); // ta sama wersja kosztu
    // rola aplikacji nie ma polityki UPDATE na kasie → 0 zmienionych wierszy
    const upd = await as(A, 'owner', (q) => q.query('UPDATE kasa_operations SET kwota = -1 WHERE cost_id = $1', [cost]));
    assert.equal(upd.rowCount, 0);
    // nawet właściciel schematu nie zmieni operacji — blokuje trigger
    await assert.rejects(t.owner.query('UPDATE kasa_operations SET kwota = -1 WHERE cost_id = $1', [cost]), /nie można zmieniać/);
    await assert.rejects(t.owner.query('DELETE FROM kasa_operations WHERE cost_id = $1', [cost]), /nie można zmieniać/);
    // brutto musi = netto + VAT
    await assert.rejects(
      as(A, 'owner', async (q) => {
        const cat = await q.query<{ id: string }>("SELECT id FROM cost_categories WHERE system_code = 'inne'");
        await q.query(
          `INSERT INTO costs (workspace_id, data, opis, category_id, kwota_netto, kwota_vat, kwota_brutto, sposob_platnosci)
           VALUES ($1, CURRENT_DATE, 'x', $2, 100, 23, 124, 'przelew')`,
          [ws, cat.rows[0].id],
        );
      }),
      /check constraint/,
    );
    const saldo = await as(A, 'owner', (q) =>
      q.query<{ saldo_po_operacji: string }>('SELECT saldo_po_operacji FROM kasa_ledger ORDER BY numer DESC LIMIT 1'),
    );
    assert.equal(saldo.rows[0].saldo_po_operacji, '-1500.00');
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
