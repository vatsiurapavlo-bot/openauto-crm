import { useEffect, useState } from 'react';
import { PAYMENT_METHODS, type Cost, type CostList } from '../../shared/types.ts';
import { api } from '../api.ts';
import { Link, setSearchParams, useLocation } from '../router.tsx';
import { useApp } from '../state.tsx';
import { Empty, ErrorBox, Icon, Spinner, date, money, useLoad } from '../ui.tsx';
import { CostFormModal } from './CostForm.tsx';

/** Zakresy dat: bieżący miesiąc, poprzedni, rok, wszystko */
export function periodRange(p: string): { od?: string; do?: string } {
  const now = new Date();
  const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  if (p === 'miesiac') return { od: iso(new Date(now.getFullYear(), now.getMonth(), 1)), do: iso(new Date(now.getFullYear(), now.getMonth() + 1, 0)) };
  if (p === 'poprzedni') return { od: iso(new Date(now.getFullYear(), now.getMonth() - 1, 1)), do: iso(new Date(now.getFullYear(), now.getMonth(), 0)) };
  if (p === 'rok') return { od: `${now.getFullYear()}-01-01`, do: `${now.getFullYear()}-12-31` };
  return {};
}

export const PERIODS: Array<[string, string]> = [
  ['miesiac', 'Ten miesiąc'],
  ['poprzedni', 'Poprzedni miesiąc'],
  ['rok', 'Ten rok'],
  ['wszystko', 'Wszystko'],
  ['wlasny', 'Własny zakres'],
];

export function PeriodPicker() {
  const { search } = useLocation();
  const okres = search.get('okres') ?? 'miesiac';
  return (
    <>
      <select className="select" value={okres} onChange={(e) => setSearchParams({ okres: e.target.value, od: undefined, do: undefined })} aria-label="Okres">
        {PERIODS.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
      {okres === 'wlasny' && (
        <span className="date-range">
          <input type="date" aria-label="Od" value={search.get('od') ?? ''} onChange={(e) => setSearchParams({ od: e.target.value })} />
          <span className="muted">–</span>
          <input type="date" aria-label="Do" value={search.get('do') ?? ''} onChange={(e) => setSearchParams({ do: e.target.value })} />
        </span>
      )}
    </>
  );
}

export function periodParams(search: URLSearchParams, params: URLSearchParams) {
  const okres = search.get('okres') ?? 'miesiac';
  const r = okres === 'wlasny' ? { od: search.get('od') ?? undefined, do: search.get('do') ?? undefined } : periodRange(okres);
  if (r.od) params.set('od', r.od);
  if (r.do) params.set('do', r.do);
}

export function CostsPage() {
  const app = useApp();
  const { search } = useLocation();
  const [q, setQ] = useState(search.get('q') ?? '');
  const [editing, setEditing] = useState<Cost | 'new' | null>(null);
  const [showFilters, setShowFilters] = useState(!!(search.get('kategoria') || search.get('sposob') || search.get('zakres') || search.get('status')));

  useEffect(() => {
    const t = setTimeout(() => {
      if ((search.get('q') ?? '') !== q) setSearchParams({ q: q || undefined });
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const params = new URLSearchParams();
  periodParams(search, params);
  for (const k of ['q', 'kategoria', 'sposob', 'zakres', 'status']) {
    const v = search.get(k);
    if (v) params.set(k, v);
  }
  const qs = params.toString();
  const { data, error, loading, reload } = useLoad(() => api.get<CostList>(`/api/costs?${qs}`), [qs]);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Koszty</h1>
          <p className="muted">{data ? `${data.total} ${data.total === 1 ? 'koszt' : 'kosztów'} w wybranym okresie` : ' '}</p>
        </div>
        {app.can('costs.edit') && (
          <button className="btn btn-primary" onClick={() => setEditing('new')}>
            <Icon name="plus" /> Dodaj koszt
          </button>
        )}
      </div>

      <div className="toolbar">
        <div className="search">
          <Icon name="search" />
          <input type="search" placeholder="Szukaj: opis, nr faktury, nr kosztu lub auta…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Szukaj kosztów" />
        </div>
        <PeriodPicker />
        <button className={'btn btn-ghost' + (showFilters ? ' on' : '')} onClick={() => setShowFilters((s) => !s)}>
          <Icon name="filter" /> Filtry
        </button>
      </div>

      {showFilters && (
        <div className="filters">
          <label className="field">
            <span className="field-label">Kategoria</span>
            <select value={search.get('kategoria') ?? ''} onChange={(e) => setSearchParams({ kategoria: e.target.value })}>
              <option value="">Wszystkie</option>
              {app.meta.costCategories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">Sposób płatności</span>
            <select value={search.get('sposob') ?? ''} onChange={(e) => setSearchParams({ sposob: e.target.value })}>
              <option value="">Wszystkie</option>
              {Object.entries(PAYMENT_METHODS).map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">Przypisanie</span>
            <select value={search.get('zakres') ?? ''} onChange={(e) => setSearchParams({ zakres: e.target.value })}>
              <option value="">Auta i firma</option>
              <option value="firma">Tylko koszty ogólne firmy</option>
            </select>
          </label>
          <label className="field">
            <span className="field-label">Status</span>
            <select value={search.get('status') ?? ''} onChange={(e) => setSearchParams({ status: e.target.value })}>
              <option value="">Aktywne</option>
              <option value="cancelled">Anulowane</option>
              <option value="all">Wszystkie</option>
            </select>
          </label>
        </div>
      )}

      {data && (
        <section className="money-row four" aria-label="Podsumowanie">
          <SumTile label="Razem brutto" value={data.sum.brutto} accent />
          <SumTile label="Netto" value={data.sum.netto} />
          <SumTile label="VAT" value={data.sum.vat} />
          <SumTile label="Zapłacone gotówką" value={data.sum.gotowka} sub="odjęte z kasy" />
        </section>
      )}

      {error && <ErrorBox error={error} onRetry={reload} />}
      {loading && !data && <Spinner />}
      {data && data.items.length === 0 && (
        <Empty icon="receipt" title="Brak kosztów w tym okresie">
          {app.can('costs.edit') ? 'Dodaj pierwszy koszt przyciskiem „Dodaj koszt”.' : 'Zmień okres lub filtry.'}
        </Empty>
      )}
      {data && data.items.length > 0 && <CostTable items={data.items} onOpen={(c) => setEditing(c)} />}
      {data && data.total > data.items.length && (
        <p className="muted small">Pokazano {data.items.length} z {data.total}. Zawęź okres lub filtry, aby zobaczyć resztę.</p>
      )}

      {editing && (
        <CostFormModal
          cost={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      )}
    </div>
  );
}

function SumTile({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: boolean }) {
  return (
    <div className={'money-tile' + (accent ? ' accent' : '')}>
      <span className="tile-label">{label}</span>
      <span className="money-value">{money(value)}</span>
      {sub && <span className="muted small">{sub}</span>}
    </div>
  );
}

export function CostTable({ items, onOpen, hideCar }: { items: Cost[]; onOpen: (c: Cost) => void; hideCar?: boolean }) {
  return (
    <>
      <div className="table-wrap desktop-only">
        <table className="table">
          <thead>
            <tr>
              <th>Nr</th>
              <th>Data</th>
              <th>Opis</th>
              <th>Kategoria</th>
              {!hideCar && <th>Samochód</th>}
              <th>Płatność</th>
              <th className="r">Netto</th>
              <th className="r">VAT</th>
              <th className="r">Brutto</th>
            </tr>
          </thead>
          <tbody>
            {items.map((c) => (
              <tr key={c.id} className={'clickable' + (c.cancelledAt ? ' cancelled' : '')} onClick={() => onOpen(c)}>
                <td className="mono">{c.numer}</td>
                <td>{date(c.data)}</td>
                <td>
                  <strong>{c.opis}</strong>
                  {c.numerFaktury && <div className="muted small">FV {c.numerFaktury}</div>}
                  {c.cancelledAt && <div className="small neg-text">anulowany</div>}
                </td>
                <td>{c.categoryName}</td>
                {!hideCar && (
                  <td onClick={(e) => e.stopPropagation()}>
                    {c.car ? <Link to={`/samochody/${c.car.id}`}>{c.car.label}</Link> : c.carId ? <span className="muted">auto niedostępne</span> : <span className="muted">firma</span>}
                  </td>
                )}
                <td>
                  <PayBadge c={c} />
                </td>
                <td className="r">{money(c.kwotaNetto)}</td>
                <td className="r">{money(c.kwotaVat)}</td>
                <td className="r">
                  <strong>{money(c.kwotaBrutto)}</strong>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="row-cards mobile-list">
        {items.map((c) => (
          <li key={c.id} className={c.cancelledAt ? 'cancelled' : ''}>
            <button type="button" onClick={() => onOpen(c)}>
              <span className="rc-top">
                <span className="rc-title">{c.opis}</span>
                <strong className="num">{money(c.kwotaBrutto)}</strong>
              </span>
              <span className="rc-sub muted small">
                nr {c.numer} · {date(c.data)} · {c.categoryName}
                {!hideCar && (c.car ? ` · #${c.car.numer}` : c.carId ? '' : ' · firma')}
              </span>
              <span className="rc-sub">
                <PayBadge c={c} />
                {c.cancelledAt && <span className="small neg-text"> anulowany</span>}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

function PayBadge({ c }: { c: Cost }) {
  return (
    <span className={'pay-badge' + (c.sposobPlatnosci === 'gotowka' ? ' cash' : '')}>
      {c.sposobPlatnosci === 'gotowka' && <Icon name="wallet" size={12} />} {PAYMENT_METHODS[c.sposobPlatnosci]}
    </span>
  );
}

/** Panel kosztów na karcie auta */
export function CarCostsPanel({ carId, onChanged }: { carId: string; onChanged?: () => void }) {
  const app = useApp();
  const { data, error, reload } = useLoad(() => api.get<CostList>(`/api/costs?car=${carId}&limit=200`), [carId]);
  const [editing, setEditing] = useState<Cost | 'new' | null>(null);
  return (
    <section className="panel">
      <header className="panel-head">
        <h2>
          <Icon name="receipt" size={15} /> Koszty auta
        </h2>
        {app.can('costs.edit') && (
          <button className="btn btn-ghost btn-sm" onClick={() => setEditing('new')}>
            <Icon name="plus" size={14} /> Dodaj koszt
          </button>
        )}
      </header>
      {error && <ErrorBox error={error} onRetry={reload} />}
      {data && data.items.length === 0 && <p className="muted small">Brak kosztów przypisanych do tego auta.</p>}
      {data && data.items.length > 0 && (
        <>
          <CostTable items={data.items} onOpen={(c) => setEditing(c)} hideCar />
          <p className="small cost-total">
            Razem: <strong>{money(data.sum.brutto)}</strong> brutto · netto {money(data.sum.netto)} · VAT {money(data.sum.vat)}
          </p>
        </>
      )}
      {editing && (
        <CostFormModal
          cost={editing === 'new' ? undefined : editing}
          lockCarId={editing === 'new' ? carId : undefined}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
            onChanged?.();
          }}
        />
      )}
    </section>
  );
}

