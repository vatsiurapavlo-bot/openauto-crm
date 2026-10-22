/**
 * Etap 3 — Koszty.
 * Kwoty liczy serwer (netto/VAT/brutto ze stawki), klient podaje jedną kwotę i jej rodzaj.
 * Operacje w kasie dla płatności gotówką tworzy baza (trigger costs_kasa) — ten moduł ich nie zapisuje.
 */
import { z } from 'zod';
import { toCents, toDecimalString, type MoneyError } from '../../shared/money.ts';
import { fromGross, fromNet } from '../../shared/vat.ts';
import { carLabel, type Cost, type CostList, type PaymentMethod } from '../../shared/types.ts';
import { badRequest, conflict, forbidden, notFound } from '../http/core.ts';
import { type Ctx, requirePerm } from './context.ts';
import { isUuid, parseOrThrow } from './cars.ts';

const MAX_CENTS = 100_000_000_00n; // 100 mln zł — więcej to na pewno pomyłka

const optText = (max: number) =>
  z
    .string()
    .max(max)
    .nullish()
    .transform((v) => (v == null || v.trim() === '' ? null : v.trim()));

export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Data w formacie RRRR-MM-DD')
  .refine((v) => {
    const d = new Date(v + 'T00:00:00Z');
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) return false;
    const year = d.getUTCFullYear();
    return year >= 2000 && d.getTime() <= Date.now() + 366 * 24 * 3600 * 1000;
  }, 'Nieprawidłowa data');

/** Data operacji/kosztu: najwyżej tydzień do przodu (data z przyszłego roku to prawie zawsze pomyłka). */
export const entryDate = isoDate.refine((v) => {
  const limit = new Date(Date.now() + 8 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  return v <= limit;
}, 'Data nie może być późniejsza niż tydzień od dziś');

export const positiveMoney = z.union([z.string(), z.number()]).transform((v, c) => {
  try {
    const cents = toCents(v);
    if (cents <= 0n) {
      c.addIssue({ code: z.ZodIssueCode.custom, message: 'Kwota musi być większa od zera' });
      return z.NEVER;
    }
    if (cents > MAX_CENTS) {
      c.addIssue({ code: z.ZodIssueCode.custom, message: 'Kwota zbyt duża' });
      return z.NEVER;
    }
    return cents;
  } catch (e) {
    c.addIssue({ code: z.ZodIssueCode.custom, message: (e as MoneyError).message });
    return z.NEVER;
  }
});

const costFields = {
  data: entryDate,
  opis: z.string().trim().min(2, 'Opisz koszt (min. 2 znaki)').max(300),
  categoryId: z.string().uuid('Wybierz kategorię'),
  carId: z.string().uuid().nullish().transform((v) => v ?? null),
  vatRateId: z.string().uuid().nullish().transform((v) => v ?? null),
  /** Kwota wpisana przez użytkownika i jej rodzaj — pozostałe liczy serwer */
  kwota: positiveMoney,
  kwotaTyp: z.enum(['netto', 'brutto']),
  sposobPlatnosci: z.enum(['gotowka', 'przelew', 'karta', 'inne']),
  czyFaktura: z.boolean().default(false),
  numerFaktury: optText(100),
  vatDoOdliczenia: z.boolean().optional(),
  notatka: optText(2000),
};

export const createCostSchema = z
  .object({ ...costFields, clientKey: z.string().min(8).max(100).regex(/^[\w-]+$/).optional() })
  .strict();
export const updateCostSchema = z.object({ ...costFields, version: z.number().int().positive() }).strict();

type CostInput = z.infer<typeof createCostSchema>;

/**
 * Kwoty netto / VAT / brutto. Nowo wybrana stawka musi być aktywna i obowiązywać dziś (słownik tej przestrzeni,
 * przez RLS). Przy edycji z tą samą stawką liczymy stawką zapisaną w koszcie — późniejsza zmiana słownika
 * nie przelicza po cichu starych kosztów.
 */
async function amounts(ctx: Ctx, d: Pick<CostInput, 'vatRateId' | 'kwota' | 'kwotaTyp'>, keep?: { vatRateId: string | null; stawka: string }) {
  let rate = '0';
  if (d.vatRateId && keep && keep.vatRateId === d.vatRateId) {
    rate = keep.stawka;
  } else if (d.vatRateId) {
    const { rows } = await ctx.q.query<{ rate: string }>(
      `SELECT rate::text AS rate FROM vat_rates WHERE id = $1 AND active
         AND valid_from <= (now() AT TIME ZONE 'Europe/Warsaw')::date
         AND (valid_to IS NULL OR valid_to >= (now() AT TIME ZONE 'Europe/Warsaw')::date)`,
      [d.vatRateId],
    );
    if (!rows[0]) throw badRequest('Nieprawidłowa stawka VAT', { fields: { vatRateId: 'Wybierz stawkę' } });
    rate = rows[0].rate;
  }
  const r = d.kwotaTyp === 'netto' ? fromNet(d.kwota, rate) : fromGross(d.kwota, rate);
  if (r.brutto > MAX_CENTS) throw badRequest('Kwota zbyt duża', { fields: { kwota: 'Kwota zbyt duża' } });
  return { netto: toDecimalString(r.netto), vat: toDecimalString(r.vat), brutto: toDecimalString(r.brutto), rate };
}

function mapDbError(e: any): never {
  if (e?.code === '42501') throw forbidden('Brak uprawnień');
  if (e?.code === '23503' && /samochodu/.test(e.message)) throw badRequest(e.message, { fields: { carId: e.message } });
  if (e?.code === '23503' && /kategoria/.test(e.message)) throw badRequest(e.message, { fields: { categoryId: e.message } });
  if (e?.code === '23503' && /stawka/.test(e.message)) throw badRequest(e.message, { fields: { vatRateId: e.message } });
  throw e;
}

const SELECT = `
  SELECT k.id, k.numer, k.data::text AS data, k.opis, k.category_id, cc.name AS category_name, k.vat_rate_id,
         k.stawka_vat::text AS stawka_vat, k.kwota_netto, k.kwota_vat, k.kwota_brutto, k.vat_do_odliczenia,
         k.sposob_platnosci, k.czy_faktura, k.numer_faktury, k.notatka, k.car_id, k.version, k.created_at,
         k.updated_at, k.cancelled_at, u.full_name AS created_by_name,
         c.numer AS car_numer, c.marka, c.model, c.rok_produkcji,
         (SELECT coalesce(sum(o.kwota), 0) FROM kasa_operations o WHERE o.cost_id = k.id) AS wplyw
  FROM costs k
  JOIN cost_categories cc ON cc.id = k.category_id
  LEFT JOIN cars c ON c.id = k.car_id
  LEFT JOIN users u ON u.id = k.created_by`;

function mapCost(r: any): Cost {
  return {
    id: r.id,
    numer: Number(r.numer),
    data: r.data,
    opis: r.opis,
    categoryId: r.category_id,
    categoryName: r.category_name,
    vatRateId: r.vat_rate_id,
    stawkaVat: r.stawka_vat,
    kwotaNetto: toDecimalString(toCents(r.kwota_netto)),
    kwotaVat: toDecimalString(toCents(r.kwota_vat)),
    kwotaBrutto: toDecimalString(toCents(r.kwota_brutto)),
    vatDoOdliczenia: r.vat_do_odliczenia,
    sposobPlatnosci: r.sposob_platnosci as PaymentMethod,
    czyFaktura: r.czy_faktura,
    numerFaktury: r.numer_faktury,
    notatka: r.notatka,
    carId: r.car_id,
    // auto niewidoczne dla roli (RLS) → brak etykiety, ale koszt dalej przypisany
    car: r.car_numer == null ? null : { id: r.car_id, numer: Number(r.car_numer), label: carLabel({ numer: Number(r.car_numer), marka: r.marka, model: r.model, rokProdukcji: r.rok_produkcji }) },
    version: r.version,
    createdBy: r.created_by_name,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
    cancelledAt: r.cancelled_at ? new Date(r.cancelled_at).toISOString() : null,
    wplywNaKase: toDecimalString(toCents(r.wplyw)),
  };
}

export interface CostFilters {
  od?: string;
  do?: string;
  carId?: string;
  /** 'firma' = koszty ogólne (bez auta) */
  zakres?: 'firma';
  categoryId?: string;
  sposob?: string;
  q?: string;
  status?: 'active' | 'cancelled' | 'all';
  limit?: number;
  offset?: number;
}

export async function listCosts(ctx: Ctx, f: CostFilters): Promise<CostList> {
  requirePerm(ctx, 'costs.view');
  const where: string[] = [];
  const params: unknown[] = [];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const status = f.status ?? 'active';
  if (status === 'active') where.push('k.cancelled_at IS NULL');
  if (status === 'cancelled') where.push('k.cancelled_at IS NOT NULL');
  if (f.od && isoDate.safeParse(f.od).success) where.push(`k.data >= ${p(f.od)}::date`);
  if (f.do && isoDate.safeParse(f.do).success) where.push(`k.data <= ${p(f.do)}::date`);
  if (f.carId && isUuid(f.carId)) where.push(`k.car_id = ${p(f.carId)}`);
  if (f.zakres === 'firma') where.push('k.car_id IS NULL');
  if (f.categoryId && isUuid(f.categoryId)) where.push(`k.category_id = ${p(f.categoryId)}`);
  if (f.sposob && ['gotowka', 'przelew', 'karta', 'inne'].includes(f.sposob)) where.push(`k.sposob_platnosci = ${p(f.sposob)}`);
  if (f.q && f.q.trim()) {
    const term = `%${f.q.trim().slice(0, 100).replace(/[\\%_]/g, (m) => '\\' + m)}%`;
    const numer = /^\d{1,9}$/.test(f.q.trim()) ? Number(f.q.trim()) : null;
    where.push(
      `(k.opis ILIKE ${p(term)} OR k.numer_faktury ILIKE $${params.length} OR k.notatka ILIKE $${params.length}` +
        (numer !== null ? ` OR k.numer = ${p(numer)} OR c.numer = $${params.length}` : '') +
        ')',
    );
  }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const limit = Math.min(Math.max(f.limit ?? 100, 1), 500);
  const offset = Math.min(Math.max(f.offset ?? 0, 0), 1_000_000);
  const { rows } = await ctx.q.query(`${SELECT} ${w} ORDER BY k.data DESC, k.numer DESC LIMIT ${limit} OFFSET ${offset}`, params);
  const agg = await ctx.q.query<{ n: string; netto: string; vat: string; brutto: string; gotowka: string }>(
    `SELECT count(*) AS n, coalesce(sum(k.kwota_netto), 0) AS netto, coalesce(sum(k.kwota_vat), 0) AS vat,
            coalesce(sum(k.kwota_brutto), 0) AS brutto,
            coalesce(sum(k.kwota_brutto) FILTER (WHERE k.sposob_platnosci = 'gotowka'), 0) AS gotowka
     FROM costs k LEFT JOIN cars c ON c.id = k.car_id ${w}`,
    params,
  );
  const a = agg.rows[0];
  const dec = (v: string) => toDecimalString(toCents(v));
  return {
    items: rows.map(mapCost),
    total: Number(a.n),
    sum: { netto: dec(a.netto), vat: dec(a.vat), brutto: dec(a.brutto), gotowka: dec(a.gotowka) },
  };
}

export async function getCost(ctx: Ctx, id: string): Promise<Cost> {
  requirePerm(ctx, 'costs.view');
  if (!isUuid(id)) throw notFound('Nie znaleziono kosztu');
  const { rows } = await ctx.q.query(`${SELECT} WHERE k.id = $1`, [id]);
  if (!rows[0]) throw notFound('Nie znaleziono kosztu');
  return mapCost(rows[0]);
}

/** Auto musi być widoczne dla użytkownika (RLS na cars) — nie przypisujemy kosztu „w ciemno”. */
async function assertCarVisible(ctx: Ctx, carId: string | null) {
  if (!carId) return;
  const { rowCount } = await ctx.q.query('SELECT 1 FROM cars WHERE id = $1 AND deleted_at IS NULL', [carId]);
  if (!rowCount) throw badRequest('Nie znaleziono samochodu', { fields: { carId: 'Nie znaleziono samochodu' } });
}

export async function createCost(ctx: Ctx, input: unknown): Promise<Cost> {
  requirePerm(ctx, 'costs.view', 'costs.edit');
  const d = parseOrThrow(createCostSchema, input);
  await assertCarVisible(ctx, d.carId);
  const a = await amounts(ctx, d);
  const vatDoOdliczenia = d.vatDoOdliczenia ?? (d.czyFaktura && toCents(a.vat) > 0n);
  let id: string | undefined;
  try {
    const { rows } = await ctx.q.query<{ id: string }>(
      `INSERT INTO costs (workspace_id, data, opis, category_id, car_id, vat_rate_id, stawka_vat, kwota_netto, kwota_vat,
                          kwota_brutto, vat_do_odliczenia, sposob_platnosci, czy_faktura, numer_faktury, notatka, client_key)
       VALUES (app_workspace(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       ON CONFLICT (workspace_id, client_key) WHERE client_key IS NOT NULL DO NOTHING
       RETURNING id`,
      [d.data, d.opis, d.categoryId, d.carId, d.vatRateId, a.rate, a.netto, a.vat, a.brutto, vatDoOdliczenia,
       d.sposobPlatnosci, d.czyFaktura, d.numerFaktury, d.notatka, d.clientKey ?? null],
    );
    id = rows[0]?.id;
  } catch (e) {
    mapDbError(e);
  }
  if (!id) {
    // ten sam formularz wysłany drugi raz — zwracamy zapisany wcześniej koszt, bez drugiego obciążenia kasy
    const { rows } = await ctx.q.query<{ id: string }>('SELECT id FROM costs WHERE client_key = $1', [d.clientKey]);
    if (!rows[0]) throw conflict('Ten formularz został już zapisany');
    id = rows[0].id;
  }
  return getCost(ctx, id);
}

function staleError() {
  return conflict('Ktoś inny zmienił ten koszt w międzyczasie. Odśwież dane i spróbuj ponownie.', 'stale_version');
}

async function currentCost(ctx: Ctx, id: string) {
  if (!isUuid(id)) throw notFound('Nie znaleziono kosztu');
  const { rows } = await ctx.q.query<{
    version: number;
    cancelled_at: string | null;
    car_id: string | null;
    vat_rate_id: string | null;
    stawka_vat: string;
  }>(
    'SELECT version, cancelled_at, car_id, vat_rate_id, stawka_vat::text AS stawka_vat FROM costs WHERE id = $1',
    [id],
  );
  if (!rows[0]) throw notFound('Nie znaleziono kosztu');
  if (rows[0].cancelled_at) throw badRequest('Ten koszt jest anulowany — nie można go zmieniać');
  return rows[0];
}

export async function updateCost(ctx: Ctx, id: string, input: unknown): Promise<Cost> {
  requirePerm(ctx, 'costs.view', 'costs.edit');
  const d = parseOrThrow(updateCostSchema, input);
  const cur = await currentCost(ctx, id);
  if (cur.version !== d.version) throw staleError();
  if (d.carId !== cur.car_id) await assertCarVisible(ctx, d.carId);
  const a = await amounts(ctx, d, { vatRateId: cur.vat_rate_id, stawka: cur.stawka_vat });
  const vatDoOdliczenia = d.vatDoOdliczenia ?? (d.czyFaktura && toCents(a.vat) > 0n);
  try {
    const res = await ctx.q.query(
      `UPDATE costs SET data = $3, opis = $4, category_id = $5, car_id = $6, vat_rate_id = $7, stawka_vat = $8,
              kwota_netto = $9, kwota_vat = $10, kwota_brutto = $11, vat_do_odliczenia = $12, sposob_platnosci = $13,
              czy_faktura = $14, numer_faktury = $15, notatka = $16
       WHERE id = $1 AND version = $2 AND cancelled_at IS NULL`,
      [id, d.version, d.data, d.opis, d.categoryId, d.carId, d.vatRateId, a.rate, a.netto, a.vat, a.brutto,
       vatDoOdliczenia, d.sposobPlatnosci, d.czyFaktura, d.numerFaktury, d.notatka],
    );
    if (res.rowCount === 0) throw staleError();
  } catch (e) {
    mapDbError(e);
  }
  return getCost(ctx, id);
}

export const cancelCostSchema = z.object({ version: z.number().int().positive() }).strict();

/** Anulowanie zamiast usuwania: koszt zostaje w historii, a gotówka wraca do kasy korektą. */
export async function cancelCost(ctx: Ctx, id: string, input: unknown): Promise<Cost> {
  requirePerm(ctx, 'costs.view', 'costs.edit');
  const d = parseOrThrow(cancelCostSchema, input);
  const cur = await currentCost(ctx, id);
  if (cur.version !== d.version) throw staleError();
  try {
    const res = await ctx.q.query('UPDATE costs SET cancelled_at = now() WHERE id = $1 AND version = $2 AND cancelled_at IS NULL', [
      id,
      d.version,
    ]);
    if (res.rowCount === 0) throw staleError();
  } catch (e) {
    mapDbError(e);
  }
  return getCost(ctx, id);
}
