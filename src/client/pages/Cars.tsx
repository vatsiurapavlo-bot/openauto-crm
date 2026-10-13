import { useEffect, useState } from 'react';
import type { Car, CarList } from '../../shared/types.ts';
import { toCents, toDecimalString } from '../../shared/money.ts';
import { api } from '../api.ts';
import { navigate, setSearchParams, useLocation } from '../router.tsx';
import { useApp } from '../state.tsx';
import { CarNumber, CarThumb, Empty, ErrorBox, Icon, Money, Spinner, StatusBadge, date, money, num, useLoad, cssVar } from '../ui.tsx';
import { CarFormModal } from './CarForm.tsx';

export interface CarsPreset {
  title: string;
  status?: string;
  view?: 'rozliczone';
}

const SORTS: Array<[string, string]> = [
  ['numer:desc', 'Najnowsze (numer)'],
  ['numer:asc', 'Najstarsze (numer)'],
  ['zmiana:desc', 'Ostatnio zmienione'],
  ['marka:asc', 'Marka A–Z'],
  ['rok:desc', 'Rocznik: najnowsze'],
  ['cena:asc', 'Cena: rosnąco'],
  ['cena:desc', 'Cena: malejąco'],
  ['przebieg:asc', 'Przebieg: najmniejszy'],
  ['data_zakupu:desc', 'Data zakupu'],
];

export function NewCarButton() {
  const app = useApp();
  const [open, setOpen] = useState(false);
  if (!app.can('cars.create')) return null;
  return (
    <>
      <button className="btn btn-primary" onClick={() => setOpen(true)}>
        <Icon name="plus" /> Dodaj samochód
      </button>
      {open && (
        <CarFormModal
          onClose={() => setOpen(false)}
          onSaved={(car) => {
            setOpen(false);
            navigate(`/samochody/${car.id}`);
          }}
        />
      )}
    </>
  );
}

export function CarsPage({ preset }: { preset: CarsPreset }) {
  const app = useApp();
  const { search } = useLocation();
  const isClosedView = preset.view === 'rozliczone';
  const layout = search.get('widok') ?? (isClosedView ? 'lista' : 'karty');
  const sortKey = search.get('sort') ? `${search.get('sort')}:${search.get('dir') ?? 'desc'}` : 'numer:desc';
  const statusFilter = preset.status ?? search.get('status') ?? '';
  const [q, setQ] = useState(search.get('q') ?? '');
  const [showFilters, setShowFilters] = useState(
    !!(search.get('rokOd') || search.get('rokDo') || search.get('paliwo') || search.get('kraj') || search.get('sales')),
  );

  // wyszukiwanie z opóźnieniem — nie wysyłamy zapytania przy każdym znaku
  useEffect(() => {
    const t = setTimeout(() => {
      if ((search.get('q') ?? '') !== q) setSearchParams({ q: q || undefined });
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const params = new URLSearchParams();
  params.set('view', isClosedView ? 'rozliczone' : 'active');
  if (statusFilter) params.set('status', statusFilter);
  for (const k of ['q', 'sort', 'dir', 'rokOd', 'rokDo', 'paliwo', 'kraj', 'sales']) {
    const v = search.get(k);
    if (v) params.set(k, v);
  }
  const qs = params.toString();
  const { data, error, loading, reload } = useLoad(() => api.get<CarList>(`/api/cars?${qs}`), [qs]);

  const logisticStatuses = app.meta.statuses.filter((s) => s.kind === 'logistic' && s.active);
  const salesStatuses = app.meta.statuses.filter((s) => s.kind === 'sales' && s.active);
  const fin = app.can('cars.finance.view');

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{preset.title}</h1>
          <p className="muted">
            {data ? `${data.total} ${plural(data.total)}` : ' '}
            {isClosedView && ' · sprzedane i rozliczone finansowo'}
          </p>
        </div>
        {!isClosedView && <NewCarButton />}
      </div>

      <div className="toolbar">
        <div className="search">
          <Icon name="search" />
          <input
            type="search"
            placeholder="Szukaj: numer, marka, model, VIN, rejestracja…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Szukaj samochodów"
          />
        </div>
        <select
          className="select"
          value={sortKey}
          onChange={(e) => {
            const [sort, dir] = e.target.value.split(':');
            setSearchParams({ sort, dir });
          }}
          aria-label="Sortowanie"
        >
          {SORTS.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        <button className={'btn btn-ghost' + (showFilters ? ' on' : '')} onClick={() => setShowFilters((s) => !s)}>
          <Icon name="filter" /> Filtry
        </button>
        <div className="seg" role="group" aria-label="Widok">
          <button className={layout === 'karty' ? 'on' : ''} onClick={() => setSearchParams({ widok: 'karty' })} title="Karty" aria-label="Widok kart">
            <Icon name="grid" />
          </button>
          <button className={layout === 'lista' ? 'on' : ''} onClick={() => setSearchParams({ widok: 'lista' })} title="Lista" aria-label="Widok listy">
            <Icon name="list" />
          </button>
        </div>
      </div>

      {!preset.status && !isClosedView && (
        <div className="chips" role="group" aria-label="Status">
          <button className={'chip' + (!statusFilter ? ' on' : '')} onClick={() => setSearchParams({ status: undefined })}>
            Wszystkie aktywne
          </button>
          {logisticStatuses.map((s) => {
            const code = s.systemCode ?? s.id;
            return (
              <button
                key={s.id}
                className={'chip' + (statusFilter === code ? ' on' : '')}
                style={cssVar(s.color)}
                onClick={() => setSearchParams({ status: statusFilter === code ? undefined : code })}
              >
                <span className="badge-dot" />
                {s.name}
              </button>
            );
          })}
        </div>
      )}

      {showFilters && (
        <div className="filters">
          <label className="field">
            <span className="field-label">Rocznik od</span>
            <input inputMode="numeric" value={search.get('rokOd') ?? ''} onChange={(e) => setSearchParams({ rokOd: e.target.value.replace(/\D/g, '') })} />
          </label>
          <label className="field">
            <span className="field-label">Rocznik do</span>
            <input inputMode="numeric" value={search.get('rokDo') ?? ''} onChange={(e) => setSearchParams({ rokDo: e.target.value.replace(/\D/g, '') })} />
          </label>
          <label className="field">
            <span className="field-label">Paliwo</span>
            <select value={search.get('paliwo') ?? ''} onChange={(e) => setSearchParams({ paliwo: e.target.value })}>
              <option value="">Wszystkie</option>
              {app.meta.fuelTypes.map((f) => (
                <option key={f}>{f}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">Kraj (zakup / lokalizacja)</span>
            <select value={search.get('kraj') ?? ''} onChange={(e) => setSearchParams({ kraj: e.target.value })}>
              <option value="">Wszystkie</option>
              {app.meta.countries.filter((c) => c.active).map((c) => (
                <option key={c.code} value={c.code}>
                  {c.name} ({c.code})
                </option>
              ))}
            </select>
          </label>
          {!isClosedView && (
            <label className="field">
              <span className="field-label">Sprzedaż</span>
              <select value={search.get('sales') ?? ''} onChange={(e) => setSearchParams({ sales: e.target.value })}>
                <option value="">Wszystkie</option>
                {salesStatuses.map((s) => (
                  <option key={s.id} value={s.systemCode ?? s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => setSearchParams({ rokOd: undefined, rokDo: undefined, paliwo: undefined, kraj: undefined, sales: undefined })}
          >
            Wyczyść filtry
          </button>
        </div>
      )}

      {error && <ErrorBox error={error} onRetry={reload} />}
      {loading && !data && <Spinner />}
      {data && data.items.length === 0 && (
        <Empty title={isClosedView ? 'Brak rozliczonych samochodów' : 'Brak samochodów'}>
          {search.get('q') || showFilters ? 'Zmień wyszukiwanie lub filtry.' : isClosedView ? 'Rozliczone auta trafią tutaj automatycznie.' : 'Dodaj pierwszy samochód.'}
        </Empty>
      )}
      {data && data.items.length > 0 && (
        <div className={loading ? 'is-loading' : ''}>
          {layout === 'lista' ? (
            isClosedView ? <ClosedTable cars={data.items} fin={fin} /> : <CarTable cars={data.items} fin={fin} />
          ) : (
            <div className="card-grid">
              {data.items.map((c) => (
                <CarCard key={c.id} car={c} fin={fin} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const plural = (n: number) => (n === 1 ? 'samochód' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? 'samochody' : 'samochodów');

export function CarCard({ car, fin }: { car: Car; fin: boolean }) {
  const app = useApp();
  const st = app.status(car.displayStatusId);
  const sales = app.status(car.salesStatusId);
  const sub = [car.rokProdukcji, car.wersja, car.rodzajPaliwa].filter(Boolean).join(' · ');
  return (
    <article
      className="car-card"
      style={cssVar(st?.color)}
      onClick={() => navigate(`/samochody/${car.id}`)}
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && navigate(`/samochody/${car.id}`)}
      aria-label={car.label}
    >
      <div className="car-card-media">
        <CarThumb car={car} color={st?.color} />
        <CarNumber car={car} />
        <StatusBadge status={st} small />
      </div>
      <div className="car-card-body">
        <h3>
          {car.marka} {car.model}
        </h3>
        <p className="muted small">{sub || '—'}</p>
        <dl className="specs">
          <div>
            <dt>Przebieg</dt>
            <dd>{num(car.przebiegKm, 'km')}</dd>
          </div>
          <div>
            <dt>Kraj</dt>
            <dd>{car.krajZakupu ?? '—'}</dd>
          </div>
          <div>
            <dt>VIN</dt>
            <dd className="mono">{car.vin ? '…' + car.vin.slice(-6) : '—'}</dd>
          </div>
        </dl>
        <div className="car-card-foot">
          <div>
            <span className="tiny muted">Cena A</span>
            <strong className="price">{money(car.cenaA)}</strong>
          </div>
          {sales?.systemCode !== 'przygotowanie' && <StatusBadge status={sales} small />}
        </div>
        {fin && car.finance && (
          <div className="car-card-fin">
            <span>
              Wartość <b>{money(car.finance.wartoscAuta, false)}</b>
            </span>
            <span>
              Zysk A <Money value={car.finance.zyskAPrognoza} signed />
            </span>
          </div>
        )}
      </div>
    </article>
  );
}

function CarTable({ cars, fin }: { cars: Car[]; fin: boolean }) {
  const app = useApp();
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Nr</th>
            <th aria-label="Zdjęcie" />
            <th>Samochód</th>
            <th className="r">Rok</th>
            <th className="r">Przebieg</th>
            <th>Paliwo</th>
            <th>VIN</th>
            <th>Status</th>
            <th className="r">Cena A</th>
            {fin && <th className="r">Wartość</th>}
            {fin && <th className="r">Zysk A</th>}
          </tr>
        </thead>
        <tbody>
          {cars.map((c) => (
            <tr key={c.id} onClick={() => navigate(`/samochody/${c.id}`)} className="clickable">
              <td>
                <CarNumber car={c} />
              </td>
              <td className="thumb-cell">
                <CarThumb car={c} color={app.status(c.displayStatusId)?.color} />
              </td>
              <td>
                <strong>
                  {c.marka} {c.model}
                </strong>
                {c.wersja && <div className="muted small">{c.wersja}</div>}
              </td>
              <td className="r">{c.rokProdukcji ?? '—'}</td>
              <td className="r">{num(c.przebiegKm, 'km')}</td>
              <td>{c.rodzajPaliwa ?? '—'}</td>
              <td className="mono small">{c.vin ?? '—'}</td>
              <td>
                <StatusBadge status={app.status(c.displayStatusId)} small />
              </td>
              <td className="r">{money(c.cenaA)}</td>
              {fin && <td className="r">{money(c.finance?.wartoscAuta)}</td>}
              {fin && (
                <td className="r">
                  <Money value={c.finance?.zyskAPrognoza} signed />
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Rozliczone: kolumny z p. 8 założeń. VAT — Etap 4. */
function ClosedTable({ cars, fin }: { cars: Car[]; fin: boolean }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Nr</th>
            <th aria-label="Zdjęcie" />
            <th>Samochód</th>
            <th>Data zakupu</th>
            <th>Data sprzedaży</th>
            {fin && <th className="r">Cena zakupu</th>}
            {fin && <th className="r">Cena sprzedaży</th>}
            {fin && <th className="r">Koszty</th>}
            {fin && <th className="r">VAT</th>}
            {fin && <th className="r">Zysk</th>}
          </tr>
        </thead>
        <tbody>
          {cars.map((c) => {
            const f = c.finance;
            const zysk =
              f?.cenaSprzedazyFaktyczna && f.wartoscAuta
                ? subtract(f.cenaSprzedazyFaktyczna, f.wartoscAuta, f.kosztyRazem ?? '0')
                : null;
            return (
              <tr key={c.id} onClick={() => navigate(`/samochody/${c.id}`)} className="clickable">
                <td>
                  <CarNumber car={c} />
                </td>
                <td className="thumb-cell">
                  <CarThumb car={c} color="#2563EB" />
                </td>
                <td>
                  <strong>
                    {c.marka} {c.model}
                  </strong>{' '}
                  <span className="muted">{c.rokProdukcji}</span>
                </td>
                <td>{date(c.dataZakupu)}</td>
                <td>{date(c.dataSprzedazy)}</td>
                {fin && <td className="r">{money(f?.wartoscAuta)}</td>}
                {fin && <td className="r">{money(f?.cenaSprzedazyFaktyczna)}</td>}
                {fin && <td className="r">{money(f?.kosztyRazem)}</td>}
                {fin && (
                  <td className="r muted" title="Rozliczenie VAT — Etap 4">
                    E4
                  </td>
                )}
                {fin && (
                  <td className="r">
                    <Money value={zysk} signed />
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function subtract(a: string, ...rest: string[]) {
  return toDecimalString(rest.reduce((acc, v) => acc - toCents(v), toCents(a)));
}
