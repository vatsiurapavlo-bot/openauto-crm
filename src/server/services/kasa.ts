/**
 * Etap 3 — Kasa (gotówka). Dziennik tylko do dopisywania; saldo liczone z dziennika (widok kasa_ledger).
 * Wydatki gotówkowe powstają wyłącznie z Kosztów (trigger w bazie). Ręcznie: wpłata, wypłata, przychód, korekta.
 */
import { z } from 'zod';
import { toCents, toDecimalString, type MoneyError } from '../../shared/money.ts';
import { carLabel, type KasaOperation, type KasaTyp, type KasaView } from '../../shared/types.ts';
import { badRequest, conflict, forbidden } from '../http/core.ts';
import { type Ctx, can, requirePerm } from './context.ts';
import { parseOrThrow } from './cars.ts';
import { isoDate, positiveMoney } from './costs.ts';

const dec = (v: string | null) => toDecimalString(toCents(v ?? '0'));

export interface KasaFilters {
  od?: string;
  do?: string;
  limit?: number;
  offset?: number;
}

async function queryLedger(ctx: Ctx, where: string, params: unknown[], tail: string): Promise<KasaOperation[]> {
  const { rows } = await ctx.q.query(
    `SELECT l.id, l.numer, l.data::text AS data, l.typ, l.kwota, l.opis, l.car_id, l.cost_id, l.saldo_po_operacji,
            l.created_at, u.full_name AS created_by_name, k.numer AS cost_numer,
            c.numer AS car_numer, c.marka, c.model, c.rok_produkcji
     FROM kasa_ledger l
     LEFT JOIN users u ON u.id = l.created_by
     LEFT JOIN costs k ON k.id = l.cost_id
     LEFT JOIN cars c ON c.id = l.car_id
     ${where}
     ORDER BY l.data DESC, l.numer DESC ${tail}`,
    params,
  );
  return rows.map((r: any) => ({
    id: r.id,
    numer: Number(r.numer),
    data: r.data,
    typ: r.typ,
    kwota: dec(r.kwota),
    opis: r.opis,
    car:
      r.car_numer == null
        ? null
        : {
            id: r.car_id,
            numer: Number(r.car_numer),
            label: carLabel({ numer: Number(r.car_numer), marka: r.marka, model: r.model, rokProdukcji: r.rok_produkcji }),
          },
    costId: r.cost_id,
    // numer kosztu tylko dla ról z dostępem do Kosztów (RLS) — reszta widzi samą operację
    costNumer: r.cost_numer == null ? null : Number(r.cost_numer),
    saldoPoOperacji: dec(r.saldo_po_operacji),
    createdBy: r.created_by_name,
    createdAt: new Date(r.created_at).toISOString(),
  }));
}

export async function getKasa(ctx: Ctx, f: KasaFilters): Promise<KasaView> {
  requirePerm(ctx, 'kasa.view');
  const acc = await ctx.q.query<{ saldo_poczatkowe: string; data_poczatkowa: string; aktualna: string; ops: string }>(
    `SELECT a.saldo_poczatkowe, a.data_poczatkowa::text AS data_poczatkowa,
            a.saldo_poczatkowe + coalesce((SELECT sum(kwota) FROM kasa_operations o
                                           WHERE o.workspace_id = a.workspace_id AND o.potwierdzona), 0) AS aktualna,
            (SELECT count(*) FROM kasa_operations o WHERE o.workspace_id = a.workspace_id) AS ops
     FROM kasa_accounts a WHERE a.workspace_id = app_workspace()`,
  );
  const a = acc.rows[0];
  if (!a) throw forbidden('Brak kasy w tej przestrzeni');

  const where: string[] = [];
  const params: unknown[] = [];
  if (f.od && isoDate.safeParse(f.od).success) {
    params.push(f.od);
    where.push(`l.data >= $${params.length}::date`);
  }
  if (f.do && isoDate.safeParse(f.do).success) {
    params.push(f.do);
    where.push(`l.data <= $${params.length}::date`);
  }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const limit = Math.min(Math.max(f.limit ?? 200, 1), 1000);
  const offset = Math.min(Math.max(f.offset ?? 0, 0), 1_000_000);
  // saldo po operacji liczone w widoku na CAŁYM dzienniku, filtr okresu dopiero potem
  const items = await queryLedger(ctx, w, params, `LIMIT ${limit} OFFSET ${offset}`);
  const sums = await ctx.q.query<{ n: string; plus: string; minus: string }>(
    `SELECT count(*) AS n, coalesce(sum(kwota) FILTER (WHERE kwota > 0), 0) AS plus,
            coalesce(sum(kwota) FILTER (WHERE kwota < 0), 0) AS minus
     FROM kasa_operations l ${w}`,
    params,
  );
  return {
    saldoPoczatkowe: dec(a.saldo_poczatkowe),
    dataPoczatkowa: a.data_poczatkowa,
    aktualna: dec(a.aktualna),
    canSetInitial: Number(a.ops) === 0 && can(ctx, 'kasa.edit'),
    items,
    total: Number(sums.rows[0].n),
    wplywy: dec(sums.rows[0].plus),
    wyplywy: dec(sums.rows[0].minus),
  };
}

export const kasaOperationSchema = z
  .object({
    typ: z.enum(['wplata', 'wyplata', 'przychod', 'korekta']),
    /** Kwota bez znaku; znak wynika z typu, a dla korekty — z pola kierunek */
    kwota: positiveMoney,
    kierunek: z.enum(['plus', 'minus']).optional(),
    data: isoDate,
    opis: z.string().trim().min(3, 'Opisz operację (min. 3 znaki)').max(300),
    carId: z.string().uuid().nullish().transform((v) => v ?? null),
    clientKey: z.string().min(8).max(100).regex(/^[\w-]+$/),
  })
  .strict()
  .refine((d) => d.typ !== 'korekta' || !!d.kierunek, { message: 'Wybierz, czy korekta zwiększa czy zmniejsza kasę', path: ['kierunek'] });

const SIGN: Record<string, 1n | -1n> = { wplata: 1n, przychod: 1n, wyplata: -1n };

export async function addKasaOperation(ctx: Ctx, input: unknown): Promise<KasaOperation> {
  requirePerm(ctx, 'kasa.view', 'kasa.edit');
  const d = parseOrThrow(kasaOperationSchema, input);
  if (d.carId) {
    const { rowCount } = await ctx.q.query('SELECT 1 FROM cars WHERE id = $1 AND deleted_at IS NULL', [d.carId]);
    if (!rowCount) throw badRequest('Nie znaleziono samochodu', { fields: { carId: 'Nie znaleziono samochodu' } });
  }
  const sign = d.typ === 'korekta' ? (d.kierunek === 'minus' ? -1n : 1n) : SIGN[d.typ];
  const kwota = toDecimalString(d.kwota * sign);
  const key = 'manual:' + d.clientKey;
  try {
    await ctx.q.query(
      `INSERT INTO kasa_operations (workspace_id, data, typ, kwota, opis, car_id, sposob_platnosci, idempotency_key)
       VALUES (app_workspace(), $1, $2, $3, $4, $5, 'gotowka', $6)
       ON CONFLICT (workspace_id, idempotency_key) DO NOTHING`,
      [d.data, d.typ as KasaTyp, kwota, d.opis, d.carId, key],
    );
  } catch (e: any) {
    if (e?.code === '42501') throw forbidden('Brak uprawnień do operacji kasowych');
    throw e;
  }
  const [op] = await queryLedger(ctx, 'WHERE l.idempotency_key = $1', [key], 'LIMIT 1');
  if (!op) throw conflict('Nie udało się zapisać operacji');
  return op;
}

export const initialBalanceSchema = z
  .object({
    saldo: z.union([z.string(), z.number()]).transform((v, c) => {
      try {
        const cents = toCents(v);
        if (cents < 0n) {
          c.addIssue({ code: z.ZodIssueCode.custom, message: 'Saldo początkowe nie może być ujemne' });
          return z.NEVER;
        }
        return toDecimalString(cents);
      } catch (e) {
        c.addIssue({ code: z.ZodIssueCode.custom, message: (e as MoneyError).message });
        return z.NEVER;
      }
    }),
    data: isoDate,
  })
  .strict();

export async function setInitialBalance(ctx: Ctx, input: unknown): Promise<KasaView> {
  requirePerm(ctx, 'kasa.view', 'kasa.edit');
  const d = parseOrThrow(initialBalanceSchema, input);
  try {
    const r = await ctx.q.query('UPDATE kasa_accounts SET saldo_poczatkowe = $1, data_poczatkowa = $2 WHERE workspace_id = app_workspace()', [
      d.saldo,
      d.data,
    ]);
    if (r.rowCount === 0) throw forbidden('Brak uprawnień');
  } catch (e: any) {
    if (e?.code === '23514') throw badRequest(e.message);
    throw e;
  }
  return getKasa(ctx, {});
}

