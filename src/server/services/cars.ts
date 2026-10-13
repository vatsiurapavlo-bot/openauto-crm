import { z } from 'zod';
import { toCents, toDecimalString, MoneyError } from '../../shared/money.ts';
import { type Car, type CarList, type StatusHistoryEntry, type StatusKind, carLabel } from '../../shared/types.ts';
import { badRequest, conflict, forbidden, notFound } from '../http/core.ts';
import { type Ctx, can, requirePerm } from './context.ts';

// ---------------------------------------------------------------------------
// Walidacja danych wejściowych
// ---------------------------------------------------------------------------

const text = (max = 200) =>
  z
    .string()
    .max(max)
    .nullish()
    .transform((v) => (v == null || v.trim() === '' ? null : v.trim()));

const int = (min: number, max: number) => z.number().int().min(min).max(max).nullish().transform((v) => v ?? null);

const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Data w formacie RRRR-MM-DD')
  .nullish()
  .or(z.literal(''))
  .transform((v) => (v ? v : null));

const country = z
  .string()
  .regex(/^[A-Z]{2}$/, 'Kod kraju: 2 wielkie litery')
  .nullish()
  .or(z.literal(''))
  .transform((v) => (v ? v : null));

const money = z
  .union([z.string(), z.number()])
  .nullish()
  .transform((v, c) => {
    if (v === null || v === undefined || v === '') return null;
    try {
      const cents = toCents(v);
      if (cents < 0n) {
        c.addIssue({ code: z.ZodIssueCode.custom, message: 'Kwota nie może być ujemna' });
        return z.NEVER;
      }
      if (cents >= 1_000_000_000_000n * 100n) {
        c.addIssue({ code: z.ZodIssueCode.custom, message: 'Kwota zbyt duża' });
        return z.NEVER;
      }
      return toDecimalString(cents);
    } catch (e) {
      c.addIssue({ code: z.ZodIssueCode.custom, message: (e as MoneyError).message });
      return z.NEVER;
    }
  });

const fxRate = z
  .union([z.string(), z.number()])
  .nullish()
  .transform((v, c) => {
    if (v === null || v === undefined || v === '') return null;
    const s = String(v).replace(',', '.');
    if (!/^\d{1,8}(\.\d{1,6})?$/.test(s) || Number(s) <= 0) {
      c.addIssue({ code: z.ZodIssueCode.custom, message: 'Kurs: liczba dodatnia, maks. 6 miejsc po przecinku' });
      return z.NEVER;
    }
    return s;
  });

const carFields = {
  marka: z.string().trim().min(1, 'Marka jest wymagana').max(60),
  model: z.string().trim().min(1, 'Model jest wymagany').max(80),
  wersja: text(120),
  rokProdukcji: int(1900, 2100),
  vin: z
    .string()
    .nullish()
    .transform((v) => (v ? v.trim().toUpperCase().replace(/\s/g, '') : null))
    .refine((v) => v === null || /^[A-HJ-NPR-Z0-9]{11,17}$/.test(v), 'VIN: 11–17 znaków, bez liter I, O, Q'),
  numerRejestracyjny: text(20),
  przebiegKm: int(0, 5_000_000),
  pojemnoscCm3: int(0, 20_000),
  mocKm: int(0, 3_000),
  rodzajPaliwa: text(40),
  skrzyniaBiegow: text(40),
  kolor: text(40),
  dataZakupu: date,
  dataPrzyjazdu: date,
  dataSprzedazy: date,
  typZakupu: text(40),
  krajZakupu: country,
  krajRejestracji: country,
  krajLokalizacji: country,
  krajSprzedawcy: country,
  krajFaktury: country,
  cenaA: money,
  cenaB: money,
  notatka: text(5000),
};

const financeFields = {
  wartoscAuta: money,
  walutaZakupu: z.string().regex(/^[A-Z]{3}$/).optional(),
  cenaZakupuWaluta: money,
  kursWaluty: fxRate,
  uslugiAukcjiNetto: money,
  vatNaUslugi: money,
  akcyzaPcc: money,
  trybZakupu: z.enum(['vat_marza', 'vat_23', 'vat_wdt', 'bez_vat', 'inne']).nullish().transform((v) => v ?? null),
  trybSprzedazy: z.enum(['vat_marza', 'vat_23', 'inne']).nullish().transform((v) => v ?? null),
  kwotaNabyciaVatMarza: money,
  cenaSprzedazyFaktyczna: money,
};

const financeSchema = z.object(financeFields).partial().strict();

export const createCarSchema = z
  .object({
    ...carFields,
    logisticStatusId: z.string().uuid().optional(),
    salesStatusId: z.string().uuid().optional(),
    finance: financeSchema.optional(),
  })
  .strict(); // pola opcjonalne są .nullish(), więc wymagane są tylko marka i model

export const updateCarSchema = z
  .object({ ...carFields, finance: financeSchema })
  .partial()
  .extend({ version: z.number().int().positive() })
  .strict();

const CAR_COLUMNS: Record<string, string> = {
  marka: 'marka',
  model: 'model',
  wersja: 'wersja',
  rokProdukcji: 'rok_produkcji',
  vin: 'vin',
  numerRejestracyjny: 'numer_rejestracyjny',
  przebiegKm: 'przebieg_km',
  pojemnoscCm3: 'pojemnosc_cm3',
  mocKm: 'moc_km',
  rodzajPaliwa: 'rodzaj_paliwa',
  skrzyniaBiegow: 'skrzynia_biegow',
  kolor: 'kolor',
  dataZakupu: 'data_zakupu',
  dataPrzyjazdu: 'data_przyjazdu',
  dataSprzedazy: 'data_sprzedazy',
  typZakupu: 'typ_zakupu',
  krajZakupu: 'kraj_zakupu',
  krajRejestracji: 'kraj_rejestracji',
  krajLokalizacji: 'kraj_lokalizacji',
  krajSprzedawcy: 'kraj_sprzedawcy',
  krajFaktury: 'kraj_faktury',
  cenaA: 'cena_a',
  cenaB: 'cena_b',
  notatka: 'notatka',
};

const FINANCE_COLUMNS: Record<string, string> = {
  wartoscAuta: 'wartosc_auta',
  walutaZakupu: 'waluta_zakupu',
  cenaZakupuWaluta: 'cena_zakupu_waluta',
  kursWaluty: 'kurs_waluty',
  uslugiAukcjiNetto: 'uslugi_aukcji_netto',
  vatNaUslugi: 'vat_na_uslugi',
  akcyzaPcc: 'akcyza_pcc',
  trybZakupu: 'tryb_zakupu',
  trybSprzedazy: 'tryb_sprzedazy',
  kwotaNabyciaVatMarza: 'kwota_nabycia_vat_marza',
  cenaSprzedazyFaktyczna: 'cena_sprzedazy_faktyczna',
};

export function parseOrThrow<T>(schema: z.ZodType<T, any, any>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) {
    const fields: Record<string, string> = {};
    for (const i of r.error.issues) fields[i.path.join('.') || '_'] = i.message;
    throw badRequest('Popraw zaznaczone pola', { fields });
  }
  return r.data;
}

// ---------------------------------------------------------------------------
// Odczyt
// ---------------------------------------------------------------------------

function selectSql(ctx: Ctx) {
  const fin = can(ctx, 'cars.finance.view');
  const costs = can(ctx, 'costs.view');
  const costsExpr = costs
    ? `(SELECT coalesce(sum(k.kwota_brutto), 0) FROM costs k WHERE k.car_id = c.id AND k.cancelled_at IS NULL)`
    : 'NULL::numeric';
  return `
    SELECT c.*,
           CASE WHEN st.is_closed THEN c.settlement_status_id ELSE c.logistic_status_id END AS display_status_id,
           ph.url AS main_photo_url
           ${
             fin
               ? `, f.wartosc_auta, coalesce(f.waluta_zakupu, 'PLN') AS waluta_zakupu, f.cena_zakupu_waluta, f.kurs_waluty,
                  f.uslugi_aukcji_netto, f.vat_na_uslugi, f.akcyza_pcc, f.tryb_zakupu, f.tryb_sprzedazy,
                  f.kwota_nabycia_vat_marza, f.cena_sprzedazy_faktyczna,
                  ${costsExpr} AS koszty_razem,
                  c.cena_a - f.wartosc_auta - coalesce(${costsExpr}, 0) AS zysk_a,
                  c.cena_b - f.wartosc_auta - coalesce(${costsExpr}, 0) AS zysk_b`
               : ''
           }
    FROM cars c
    JOIN car_statuses st ON st.id = c.settlement_status_id
    LEFT JOIN files ph ON ph.id = c.main_photo_file_id
    ${fin ? 'LEFT JOIN car_finance f ON f.car_id = c.id' : ''}`;
}

function mapCar(r: any, withFinance: boolean): Car {
  const car: Car = {
    id: r.id,
    numer: Number(r.numer),
    label: '',
    marka: r.marka,
    model: r.model,
    wersja: r.wersja,
    rokProdukcji: r.rok_produkcji,
    vin: r.vin,
    numerRejestracyjny: r.numer_rejestracyjny,
    przebiegKm: r.przebieg_km,
    pojemnoscCm3: r.pojemnosc_cm3,
    mocKm: r.moc_km,
    rodzajPaliwa: r.rodzaj_paliwa,
    skrzyniaBiegow: r.skrzynia_biegow,
    kolor: r.kolor,
    dataZakupu: r.data_zakupu,
    dataPrzyjazdu: r.data_przyjazdu,
    dataSprzedazy: r.data_sprzedazy,
    typZakupu: r.typ_zakupu,
    krajZakupu: r.kraj_zakupu,
    krajRejestracji: r.kraj_rejestracji,
    krajLokalizacji: r.kraj_lokalizacji,
    krajSprzedawcy: r.kraj_sprzedawcy,
    krajFaktury: r.kraj_faktury,
    cenaA: r.cena_a,
    cenaB: r.cena_b,
    logisticStatusId: r.logistic_status_id,
    salesStatusId: r.sales_status_id,
    settlementStatusId: r.settlement_status_id,
    displayStatusId: r.display_status_id,
    notatka: r.notatka,
    mainPhotoUrl: r.main_photo_url ?? null,
    version: r.version,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  };
  car.label = carLabel(car);
  if (withFinance) {
    car.finance = {
      wartoscAuta: r.wartosc_auta,
      walutaZakupu: r.waluta_zakupu,
      cenaZakupuWaluta: r.cena_zakupu_waluta,
      kursWaluty: r.kurs_waluty,
      uslugiAukcjiNetto: r.uslugi_aukcji_netto,
      vatNaUslugi: r.vat_na_uslugi,
      akcyzaPcc: r.akcyza_pcc,
      trybZakupu: r.tryb_zakupu,
      trybSprzedazy: r.tryb_sprzedazy,
      kwotaNabyciaVatMarza: r.kwota_nabycia_vat_marza,
      cenaSprzedazyFaktyczna: r.cena_sprzedazy_faktyczna,
      kosztyRazem: r.koszty_razem === null ? null : toDecimalString(toCents(r.koszty_razem)),
      zyskAPrognoza: r.zysk_a === null ? null : toDecimalString(toCents(r.zysk_a)),
      zyskBPrognoza: r.zysk_b === null ? null : toDecimalString(toCents(r.zysk_b)),
    };
  }
  return car;
}

export interface CarFilters {
  view?: 'active' | 'rozliczone' | 'all';
  status?: string; // system_code lub id statusu logistycznego
  salesStatus?: string;
  q?: string;
  marka?: string;
  rokOd?: number;
  rokDo?: number;
  kraj?: string;
  paliwo?: string;
  sort?: string;
  dir?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

const SORTS: Record<string, string> = {
  numer: 'c.numer',
  marka: 'lower(c.marka), lower(c.model)',
  rok: 'c.rok_produkcji',
  cena: 'c.cena_a',
  przebieg: 'c.przebieg_km',
  data_zakupu: 'c.data_zakupu',
  zmiana: 'c.updated_at',
};

export async function listCars(ctx: Ctx, f: CarFilters): Promise<CarList> {
  requirePerm(ctx, 'cars.view');
  const where: string[] = ['c.deleted_at IS NULL'];
  const params: unknown[] = [];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const view = f.view ?? 'active';
  if (view === 'active') where.push('NOT st.is_closed');
  if (view === 'rozliczone') where.push('st.is_closed');
  if (f.status) {
    where.push(
      `c.logistic_status_id IN (SELECT id FROM car_statuses WHERE kind = 'logistic' AND (system_code = ${p(f.status)} OR id::text = ${p(f.status)}))`,
    );
  }
  if (f.salesStatus) {
    where.push(
      `c.sales_status_id IN (SELECT id FROM car_statuses WHERE kind = 'sales' AND (system_code = ${p(f.salesStatus)} OR id::text = ${p(f.salesStatus)}))`,
    );
  }
  if (f.q?.trim()) {
    const term = f.q.trim();
    const like = p('%' + term.replace(/[\\%_]/g, (m) => '\\' + m) + '%');
    const numeric = /^\d{1,15}$/.test(term) ? ` OR c.numer = ${p(Number(term))}` : '';
    where.push(
      `(c.marka ILIKE ${like} OR c.model ILIKE ${like} OR (c.marka || ' ' || c.model) ILIKE ${like} OR c.vin ILIKE ${like}
        OR c.numer_rejestracyjny ILIKE ${like} OR c.wersja ILIKE ${like}${numeric})`,
    );
  }
  if (f.marka) where.push(`lower(c.marka) = lower(${p(f.marka)})`);
  if (f.rokOd) where.push(`c.rok_produkcji >= ${p(f.rokOd)}`);
  if (f.rokDo) where.push(`c.rok_produkcji <= ${p(f.rokDo)}`);
  if (f.kraj) where.push(`(c.kraj_zakupu = ${p(f.kraj)} OR c.kraj_lokalizacji = ${p(f.kraj)})`);
  if (f.paliwo) where.push(`c.rodzaj_paliwa = ${p(f.paliwo)}`);

  const sortCol = SORTS[f.sort ?? 'numer'] ?? SORTS.numer;
  const dir = f.dir === 'asc' ? 'ASC' : 'DESC';
  const limit = Math.min(Math.max(f.limit ?? 200, 1), 500);
  const offset = Math.max(f.offset ?? 0, 0);
  const whereSql = where.join(' AND ');

  const { rows } = await ctx.q.query(
    `${selectSql(ctx)} WHERE ${whereSql} ORDER BY ${sortCol} ${dir} NULLS LAST, c.numer DESC LIMIT ${limit} OFFSET ${offset}`,
    params,
  );
  const count = await ctx.q.query<{ n: string }>(
    `SELECT count(*) AS n FROM cars c JOIN car_statuses st ON st.id = c.settlement_status_id WHERE ${whereSql}`,
    params,
  );
  const fin = can(ctx, 'cars.finance.view');
  return { items: rows.map((r) => mapCar(r, fin)), total: Number(count.rows[0].n) };
}

export async function getCar(ctx: Ctx, id: string): Promise<Car> {
  requirePerm(ctx, 'cars.view');
  if (!isUuid(id)) throw notFound('Nie znaleziono samochodu');
  const { rows } = await ctx.q.query(`${selectSql(ctx)} WHERE c.id = $1 AND c.deleted_at IS NULL`, [id]);
  if (!rows[0]) throw notFound('Nie znaleziono samochodu');
  return mapCar(rows[0], can(ctx, 'cars.finance.view'));
}

// ---------------------------------------------------------------------------
// Zapis
// ---------------------------------------------------------------------------

async function assertCountries(ctx: Ctx, values: Array<string | null | undefined>) {
  const codes = [...new Set(values.filter((v): v is string => !!v))];
  if (!codes.length) return;
  const { rows } = await ctx.q.query<{ code: string }>(
    'SELECT code FROM countries WHERE workspace_id = app_workspace() AND code = ANY($1::text[])',
    [codes],
  );
  const known = new Set(rows.map((r) => r.code.trim()));
  const missing = codes.filter((c) => !known.has(c));
  if (missing.length) throw badRequest(`Nieznany kraj: ${missing.join(', ')} — dodaj go w Ustawienia → Kraje i aukcje`);
}

async function defaultStatus(ctx: Ctx, kind: StatusKind): Promise<string> {
  const { rows } = await ctx.q.query<{ id: string }>(
    'SELECT id FROM car_statuses WHERE workspace_id = app_workspace() AND kind = $1 AND is_default AND active',
    [kind],
  );
  if (!rows[0]) throw new Error(`Brak domyślnego statusu: ${kind}`);
  return rows[0].id;
}

async function upsertFinance(ctx: Ctx, carId: string, fin: Record<string, unknown>) {
  const entries = Object.entries(fin).filter(([k, v]) => FINANCE_COLUMNS[k] && v !== undefined);
  if (!entries.length) return;
  requirePerm(ctx, 'cars.finance.edit');
  const cols = entries.map(([k]) => FINANCE_COLUMNS[k]);
  const values = entries.map(([, v]) => v);
  const ph = values.map((_, i) => `$${i + 3}`);
  await ctx.q.query(
    `INSERT INTO car_finance (car_id, workspace_id, ${cols.join(', ')}, updated_by)
     VALUES ($1, app_workspace(), ${ph.join(', ')}, $2)
     ON CONFLICT (car_id) DO UPDATE SET ${cols.map((c) => `${c} = EXCLUDED.${c}`).join(', ')},
       updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [carId, ctx.session.userId, ...values],
  );
}

function mapDbError(e: any): never {
  if (e?.code === '23505' && String(e.constraint).includes('vin')) {
    throw conflict('Samochód z tym numerem VIN już istnieje', 'duplicate_vin');
  }
  if (e?.code === '42501') throw forbidden(e.message?.startsWith('Brak') ? e.message : 'Brak uprawnień');
  throw e;
}

export async function createCar(ctx: Ctx, input: unknown): Promise<Car> {
  requirePerm(ctx, 'cars.create');
  const data = parseOrThrow(createCarSchema, input) as Record<string, any>;
  if (data.finance && Object.keys(data.finance).length) requirePerm(ctx, 'cars.finance.edit');
  await assertCountries(ctx, [data.krajZakupu, data.krajRejestracji, data.krajLokalizacji, data.krajSprzedawcy, data.krajFaktury]);

  const cols = ['workspace_id', 'created_by', 'logistic_status_id', 'sales_status_id', 'settlement_status_id'];
  const vals: unknown[] = [
    ctx.session.workspaceId,
    ctx.session.userId,
    data.logisticStatusId ?? (await defaultStatus(ctx, 'logistic')),
    data.salesStatusId ?? (await defaultStatus(ctx, 'sales')),
    await defaultStatus(ctx, 'settlement'),
  ];
  for (const [k, col] of Object.entries(CAR_COLUMNS)) {
    if (data[k] !== undefined) {
      cols.push(col);
      vals.push(data[k]);
    }
  }
  const id = crypto.randomUUID();
  cols.unshift('id');
  vals.unshift(id);
  try {
    await ctx.q.query(
      `INSERT INTO cars (${cols.join(', ')}) VALUES (${vals.map((_, i) => `$${i + 1}`).join(', ')})`,
      vals,
    );
    if (data.finance) await upsertFinance(ctx, id, data.finance);
  } catch (e) {
    mapDbError(e);
  }
  return getCar(ctx, id);
}

async function currentVersion(ctx: Ctx, id: string): Promise<number> {
  const { rows } = await ctx.q.query<{ version: number }>(
    'SELECT version FROM cars WHERE id = $1 AND deleted_at IS NULL',
    [id],
  );
  if (!rows[0]) throw notFound('Nie znaleziono samochodu');
  return rows[0].version;
}

function staleError() {
  return conflict('Ktoś inny zmienił ten samochód w międzyczasie. Odśwież dane i spróbuj ponownie.', 'stale_version');
}

export async function updateCar(ctx: Ctx, id: string, input: unknown): Promise<Car> {
  if (!isUuid(id)) throw notFound('Nie znaleziono samochodu');
  const data = parseOrThrow(updateCarSchema, input) as Record<string, any>;
  const carEntries = Object.entries(CAR_COLUMNS).filter(([k]) => data[k] !== undefined);
  if (carEntries.length) requirePerm(ctx, 'cars.edit');
  if (data.finance && Object.keys(data.finance).length) requirePerm(ctx, 'cars.finance.edit');
  await assertCountries(ctx, [data.krajZakupu, data.krajRejestracji, data.krajLokalizacji, data.krajSprzedawcy, data.krajFaktury]);

  const version = await currentVersion(ctx, id);
  if (version !== data.version) throw staleError();
  try {
    // Zawsze podbijamy wersję (także przy zmianie samych finansów) — blokada optymistyczna
    const sets = carEntries.map(([k, col], i) => `${col} = $${i + 3}`);
    const res = await ctx.q.query(
      `UPDATE cars SET ${sets.length ? sets.join(', ') : 'updated_at = now()'} WHERE id = $1 AND version = $2`,
      [id, data.version, ...carEntries.map(([k]) => data[k])],
    );
    if (res.rowCount === 0) throw staleError();
    if (data.finance) await upsertFinance(ctx, id, data.finance);
  } catch (e) {
    mapDbError(e);
  }
  return getCar(ctx, id);
}

export const statusChangeSchema = z
  .object({
    kind: z.enum(['logistic', 'sales', 'settlement']),
    statusId: z.string().uuid(),
    version: z.number().int().positive(),
  })
  .strict();

/** Zmiana statusu. Zwraca auto po zmianie, albo null jeśli rola przestała je widzieć (np. Serwis oddał auto). */
export async function changeStatus(ctx: Ctx, id: string, input: unknown): Promise<Car | null> {
  if (!isUuid(id)) throw notFound('Nie znaleziono samochodu');
  const data = parseOrThrow(statusChangeSchema, input);
  if (!can(ctx, 'cars.status') && !can(ctx, 'cars.edit')) throw forbidden();
  if (data.kind === 'settlement') requirePerm(ctx, 'cars.settle');
  try {
    // Uprawnienia, widoczność i wersję sprawdza ponownie funkcja w bazie
    await ctx.q.query('SELECT app_change_car_status($1, $2, $3, $4)', [id, data.kind, data.statusId, data.version]);
  } catch (e: any) {
    if (e?.code === 'OA409') throw staleError();
    if (e?.code === 'P0002') throw notFound('Nie znaleziono samochodu');
    if (e?.code === '23514') throw badRequest('Nieprawidłowy status');
    mapDbError(e);
  }
  try {
    return await getCar(ctx, id);
  } catch (e: any) {
    if (e?.status === 404) return null;
    throw e;
  }
}

export async function archiveCar(ctx: Ctx, id: string, version: number): Promise<void> {
  requirePerm(ctx, 'cars.delete');
  const current = await currentVersion(ctx, id);
  if (current !== version) throw staleError();
  try {
    await ctx.q.query('UPDATE cars SET deleted_at = now(), deleted_by = $2 WHERE id = $1 AND version = $3', [
      id,
      ctx.session.userId,
      version,
    ]);
  } catch (e) {
    mapDbError(e);
  }
}

export async function carHistory(ctx: Ctx, id: string): Promise<StatusHistoryEntry[]> {
  requirePerm(ctx, 'cars.view');
  await getCar(ctx, id); // 404 / brak dostępu
  const { rows } = await ctx.q.query(
    `SELECT h.kind, h.from_status_id, h.to_status_id, h.changed_at, u.full_name
     FROM car_status_history h LEFT JOIN users u ON u.id = h.changed_by
     WHERE h.car_id = $1 ORDER BY h.changed_at DESC, h.id DESC`,
    [id],
  );
  return rows.map((r: any) => ({
    kind: r.kind,
    fromStatusId: r.from_status_id,
    toStatusId: r.to_status_id,
    changedAt: new Date(r.changed_at).toISOString(),
    changedBy: r.full_name,
  }));
}

export function isUuid(s: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}
