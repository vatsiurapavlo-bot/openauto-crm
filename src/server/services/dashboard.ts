import type { DashboardData } from '../../shared/types.ts';
import { toCents, toDecimalString } from '../../shared/money.ts';
import { type Ctx, can, requirePerm } from './context.ts';
import { listCars } from './cars.ts';

const dec = (v: string | null) => toDecimalString(toCents(v ?? '0'));

export async function getDashboard(ctx: Ctx): Promise<DashboardData> {
  requirePerm(ctx, 'dashboard.view');

  const { rows: statusRows } = await ctx.q.query<{ status_id: string; code: string | null; n: string; closed: boolean }>(
    `SELECT CASE WHEN st.is_closed THEN c.settlement_status_id ELSE c.logistic_status_id END AS status_id,
            CASE WHEN st.is_closed THEN st.system_code ELSE ls.system_code END AS code,
            st.is_closed AS closed, count(*) AS n
     FROM cars c
     JOIN car_statuses st ON st.id = c.settlement_status_id
     JOIN car_statuses ls ON ls.id = c.logistic_status_id
     WHERE c.deleted_at IS NULL
     GROUP BY 1, 2, 3`,
  );
  const byCode = (code: string) =>
    statusRows.filter((r) => !r.closed && r.code === code).reduce((s, r) => s + Number(r.n), 0);

  const { rows: saleRows } = await ctx.q.query<{ n: string }>(
    `SELECT count(*) AS n FROM cars c
     JOIN car_statuses st ON st.id = c.settlement_status_id AND NOT st.is_closed
     JOIN car_statuses ss ON ss.id = c.sales_status_id AND ss.system_code = 'w_sprzedazy'
     WHERE c.deleted_at IS NULL`,
  );

  const counts = {
    wSprzedazy: Number(saleRows[0].n),
    wDrodze: byCode('w_drodze'),
    serwis: byCode('serwis'),
    lakiernia: byCode('lakiernia'),
    naPlacu: byCode('na_placu'),
    problem: byCode('problem'),
    aktywne: statusRows.filter((r) => !r.closed).reduce((s, r) => s + Number(r.n), 0),
    rozliczone: statusRows.filter((r) => r.closed).reduce((s, r) => s + Number(r.n), 0),
  };

  const withCosts = can(ctx, 'costs.view');
  let finance: DashboardData['finance'] = null;
  if (can(ctx, 'cars.finance.view')) {
    const costsExpr = withCosts
      ? '(SELECT coalesce(sum(k.kwota_brutto), 0) FROM costs k WHERE k.car_id = c.id AND k.cancelled_at IS NULL)'
      : '0';
    const { rows } = await ctx.q.query(
      `WITH x AS (
         SELECT st.is_closed, c.cena_a, f.wartosc_auta, f.cena_sprzedazy_faktyczna, ${costsExpr} AS koszty
         FROM cars c
         JOIN car_statuses st ON st.id = c.settlement_status_id
         LEFT JOIN car_finance f ON f.car_id = c.id
         WHERE c.deleted_at IS NULL)
       SELECT
         coalesce(sum(wartosc_auta) FILTER (WHERE NOT is_closed), 0) AS wartosc,
         coalesce(sum(koszty) FILTER (WHERE NOT is_closed), 0) AS koszty,
         coalesce(sum(cena_a - wartosc_auta - koszty) FILTER (WHERE NOT is_closed AND cena_a IS NOT NULL AND wartosc_auta IS NOT NULL), 0) AS zysk_ocz,
         count(*) FILTER (WHERE NOT is_closed AND cena_a IS NOT NULL AND wartosc_auta IS NOT NULL) AS zysk_ocz_n,
         coalesce(sum(cena_sprzedazy_faktyczna - wartosc_auta - koszty) FILTER (WHERE is_closed AND cena_sprzedazy_faktyczna IS NOT NULL AND wartosc_auta IS NOT NULL), 0) AS zysk_fakt,
         count(*) FILTER (WHERE is_closed AND cena_sprzedazy_faktyczna IS NOT NULL AND wartosc_auta IS NOT NULL) AS zysk_fakt_n
       FROM x`,
    );
    const r: any = rows[0];
    finance = {
      wartoscAut: dec(r.wartosc),
      kosztyAktywnych: dec(r.koszty),
      zyskOczekiwany: dec(r.zysk_ocz),
      zyskOczekiwanyLiczbaAut: Number(r.zysk_ocz_n),
      zyskFaktyczny: dec(r.zysk_fakt),
      zyskFaktycznyLiczbaAut: Number(r.zysk_fakt_n),
    };
  }

  let kosztyRazem: string | null = null;
  if (withCosts) {
    const { rows } = await ctx.q.query<{ s: string }>(
      'SELECT coalesce(sum(kwota_brutto), 0) AS s FROM costs WHERE cancelled_at IS NULL',
    );
    kosztyRazem = dec(rows[0].s);
  }

  let kasa: DashboardData['kasa'] = null;
  if (can(ctx, 'kasa.view')) {
    const { rows: bal } = await ctx.q.query<{ s: string }>(
      `SELECT a.saldo_poczatkowe + coalesce((SELECT sum(kwota) FROM kasa_operations o
                                             WHERE o.workspace_id = a.workspace_id AND o.potwierdzona), 0) AS s
       FROM kasa_accounts a WHERE a.workspace_id = app_workspace()`,
    );
    const { rows: ops } = await ctx.q.query(
      `SELECT l.id, l.numer, l.data, l.typ, l.kwota, l.opis, l.saldo_po_operacji, c.numer AS car_numer
       FROM kasa_ledger l LEFT JOIN cars c ON c.id = l.car_id
       ORDER BY l.data DESC, l.numer DESC LIMIT 8`,
    );
    kasa = {
      aktualna: dec(bal[0]?.s ?? '0'),
      ostatnieOperacje: ops.map((o: any) => ({
        id: o.id,
        numer: Number(o.numer),
        data: o.data,
        typ: o.typ,
        kwota: dec(o.kwota),
        opis: o.opis,
        carNumer: o.car_numer === null ? null : Number(o.car_numer),
        saldoPoOperacji: dec(o.saldo_po_operacji),
      })),
    };
  }

  const recent = await listCars(ctx, { view: 'active', sort: 'zmiana', dir: 'desc', limit: 6 });

  return {
    counts,
    byStatus: statusRows.map((r) => ({ statusId: r.status_id, count: Number(r.n) })),
    finance,
    kosztyRazem,
    kasa,
    recentCars: recent.items,
  };
}
