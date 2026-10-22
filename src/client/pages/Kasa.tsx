import { useState, type FormEvent } from 'react';
import { KASA_TYPES, type CarList, type KasaOperation, type KasaTyp, type KasaView } from '../../shared/types.ts';
import { api, ApiError } from '../api.ts';
import { Link, useLocation } from '../router.tsx';
import { useApp } from '../state.tsx';
import { Empty, ErrorBox, Field, Icon, Modal, Money, Spinner, date, dateTime, money, useLoad, useToast } from '../ui.tsx';
import { PeriodPicker, periodParams } from './Costs.tsx';
import { today } from './CostForm.tsx';

const MANUAL: Array<{ typ: KasaTyp; label: string; hint: string }> = [
  { typ: 'wplata', label: 'Wpłata', hint: 'gotówka wpłacona do kasy (np. z banku)' },
  { typ: 'wyplata', label: 'Wypłata', hint: 'gotówka wyjęta z kasy (np. wpłata do banku)' },
  { typ: 'przychod', label: 'Przychód', hint: 'gotówka otrzymana (np. zaliczka za auto)' },
  { typ: 'korekta', label: 'Korekta', hint: 'wyrównanie różnicy po przeliczeniu kasy' },
];

export function KasaPage() {
  const app = useApp();
  const { search } = useLocation();
  const params = new URLSearchParams();
  periodParams(search, params);
  const qs = params.toString();
  const { data, error, loading, reload } = useLoad(() => api.get<KasaView>(`/api/kasa?${qs}`), [qs]);
  const [adding, setAdding] = useState(false);
  const canEdit = app.can('kasa.edit');

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Kasa</h1>
          <p className="muted">Gotówka · dziennik tylko do dopisywania, błędy poprawia się korektą</p>
        </div>
        {canEdit && (
          <button className="btn btn-primary" onClick={() => setAdding(true)}>
            <Icon name="plus" /> Operacja kasowa
          </button>
        )}
      </div>

      {error && <ErrorBox error={error} onRetry={reload} />}
      {loading && !data && <Spinner />}
      {data && (
        <>
          <section className="money-row four" aria-label="Stan kasy">
            <div className="money-tile accent">
              <span className="tile-label">Aktualna kasa</span>
              <span className="money-value">{money(data.aktualna)}</span>
              <span className="muted small">operacje potwierdzone</span>
            </div>
            <div className="money-tile">
              <span className="tile-label">Wpływy w okresie</span>
              <span className="money-value">{money(data.wplywy)}</span>
            </div>
            <div className="money-tile">
              <span className="tile-label">Wypływy w okresie</span>
              <span className="money-value">{money(data.wyplywy)}</span>
            </div>
            <div className="money-tile">
              <span className="tile-label">Saldo początkowe</span>
              <span className="money-value">{money(data.saldoPoczatkowe)}</span>
              <span className="muted small">od {date(data.dataPoczatkowa)}</span>
            </div>
          </section>

          {data.canSetInitial && <InitialBalance view={data} onSaved={reload} />}

          <div className="toolbar">
            <PeriodPicker />
            <span className="muted small">
              {data.total} {data.total === 1 ? 'operacja' : 'operacji'} w okresie · wydatki gotówkowe dodaje się w{' '}
              <Link to="/koszty">Kosztach</Link>
            </span>
          </div>

          {data.items.length === 0 ? (
            <Empty icon="wallet" title="Brak operacji w tym okresie">
              Wydatek opłacony gotówką w Kosztach pojawi się tu automatycznie.
            </Empty>
          ) : (
            <Ledger items={data.items} />
          )}
        </>
      )}

      {adding && (
        <KasaOperationModal
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            reload();
          }}
        />
      )}
    </div>
  );
}

function TypBadge({ typ }: { typ: KasaTyp }) {
  return <span className={`kasa-typ t-${typ}`}>{KASA_TYPES[typ]}</span>;
}

function OpisCell({ o }: { o: KasaOperation }) {
  return (
    <>
      <span>{o.opis}</span>
      <span className="muted small">
        {o.costNumer !== null && (
          <>
            {' · '}
            <Link to={`/koszty?okres=wszystko&q=${o.costNumer}`}>koszt nr {o.costNumer}</Link>
          </>
        )}
        {o.car && (
          <>
            {' · '}
            <Link to={`/samochody/${o.car.id}`}>auto #{o.car.numer}</Link>
          </>
        )}
      </span>
    </>
  );
}

function Ledger({ items }: { items: KasaOperation[] }) {
  return (
    <>
      <div className="table-wrap desktop-only">
        <table className="table">
          <thead>
            <tr>
              <th>Data</th>
              <th>Nr</th>
              <th>Typ</th>
              <th>Opis</th>
              <th className="r">Kwota</th>
              <th className="r">Saldo po operacji</th>
              <th>Dodał(a)</th>
            </tr>
          </thead>
          <tbody>
            {items.map((o) => (
              <tr key={o.id}>
                <td>{date(o.data)}</td>
                <td className="mono">{o.numer}</td>
                <td>
                  <TypBadge typ={o.typ} />
                </td>
                <td>
                  <OpisCell o={o} />
                </td>
                <td className="r">
                  <Money value={o.kwota} signed />
                </td>
                <td className="r">{money(o.saldoPoOperacji)}</td>
                <td className="small muted" title={dateTime(o.createdAt)}>
                  {o.createdBy ?? 'system'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="row-cards mobile-list">
        {items.map((o) => (
          <li key={o.id}>
            <div>
              <span className="rc-top">
                <span className="rc-title">
                  <TypBadge typ={o.typ} />
                </span>
                <Money value={o.kwota} signed />
              </span>
              <span className="rc-sub small">
                <OpisCell o={o} />
              </span>
              <span className="rc-sub muted small">
                {date(o.data)} · nr {o.numer} · saldo {money(o.saldoPoOperacji)}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

function newKey() {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

function KasaOperationModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [typ, setTyp] = useState<KasaTyp>('wplata');
  const [kierunek, setKierunek] = useState<'plus' | 'minus' | ''>('');
  const [kwota, setKwota] = useState('');
  const [data, setData] = useState(today());
  const [opis, setOpis] = useState('');
  const [carId, setCarId] = useState('');
  const [clientKey] = useState(newKey);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);
  const cars = useLoad(() => api.get<CarList>('/api/cars?view=all&limit=500&sort=numer&dir=desc'), []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    setFormError('');
    try {
      const op = await api.post<KasaOperation>('/api/kasa', {
        typ,
        kwota,
        ...(typ === 'korekta' && kierunek ? { kierunek } : {}),
        data,
        opis,
        carId: carId || null,
        clientKey,
      });
      toast(`${KASA_TYPES[op.typ]}: ${money(op.kwota)} · saldo ${money(op.saldoPoOperacji)}`);
      onSaved();
    } catch (err) {
      const ae = err as ApiError;
      setErrors(ae.fields ?? {});
      setFormError(ae.message);
    } finally {
      setBusy(false);
    }
  }

  const selected = MANUAL.find((m) => m.typ === typ)!;
  return (
    <Modal title="Operacja kasowa" onClose={onClose}>
      <form className="form" onSubmit={submit} noValidate>
        <div className="chips" role="group" aria-label="Typ operacji">
          {MANUAL.map((m) => (
            <button type="button" key={m.typ} className={'chip' + (typ === m.typ ? ' on' : '')} onClick={() => setTyp(m.typ)}>
              {m.label}
            </button>
          ))}
        </div>
        <p className="muted small">{selected.hint}. Wydatek opłacony gotówką dodaj w Kosztach — kasa zmniejszy się automatycznie.</p>
        <div className="form-grid one">
          {typ === 'korekta' && (
            <Field label="Korekta *" error={errors.kierunek}>
              <div className="seg" role="group" aria-label="Kierunek korekty">
                <button type="button" className={kierunek === 'plus' ? 'on' : ''} onClick={() => setKierunek('plus')}>
                  + zwiększa kasę
                </button>
                <button type="button" className={kierunek === 'minus' ? 'on' : ''} onClick={() => setKierunek('minus')}>
                  − zmniejsza kasę
                </button>
              </div>
            </Field>
          )}
          <Field label="Kwota (zł) *" error={errors.kwota}>
            <input inputMode="decimal" placeholder="0,00" value={kwota} onChange={(e) => setKwota(e.target.value)} />
          </Field>
          <Field label="Data *" error={errors.data}>
            <input type="date" value={data} onChange={(e) => setData(e.target.value)} />
          </Field>
          <Field label="Opis *" error={errors.opis} hint="np. „Wpłata z konta firmowego”, „Zaliczka za auto #12”">
            <input value={opis} onChange={(e) => setOpis(e.target.value)} maxLength={300} />
          </Field>
          <Field label="Samochód (opcjonalnie)" error={errors.carId}>
            <select value={carId} onChange={(e) => setCarId(e.target.value)}>
              <option value="">—</option>
              {cars.data?.items.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
        {formError && (
          <div className="error-box" role="alert">
            <Icon name="alert" />
            <span>{formError}</span>
          </div>
        )}
        <div className="form-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Anuluj
          </button>
          <button className="btn btn-primary" disabled={busy}>
            {busy ? 'Zapisywanie…' : 'Zapisz operację'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function InitialBalance({ view, onSaved }: { view: KasaView; onSaved: () => void }) {
  const toast = useToast();
  const [saldo, setSaldo] = useState(view.saldoPoczatkowe === '0.00' ? '' : view.saldoPoczatkowe.replace('.', ','));
  const [data, setData] = useState(view.dataPoczatkowa);
  const [errors, setErrors] = useState<Record<string, string>>({});
  async function submit(e: FormEvent) {
    e.preventDefault();
    setErrors({});
    try {
      await api.post('/api/kasa/saldo-poczatkowe', { saldo: saldo || '0', data });
      toast('Zapisano saldo początkowe');
      onSaved();
    } catch (err) {
      const ae = err as ApiError;
      setErrors(Object.keys(ae.fields).length ? ae.fields : { saldo: ae.message });
    }
  }
  return (
    <section className="panel hint-panel">
      <header className="panel-head">
        <h2>Saldo początkowe kasy</h2>
      </header>
      <p className="muted small">
        Ile gotówki jest w kasie na start? Można to ustawić tylko przed pierwszą operacją — później różnice poprawia się korektą.
      </p>
      <form className="form inline-form" onSubmit={submit}>
        <Field label="Saldo (zł)" error={errors.saldo}>
          <input inputMode="decimal" placeholder="0,00" value={saldo} onChange={(e) => setSaldo(e.target.value)} />
        </Field>
        <Field label="Na dzień" error={errors.data}>
          <input type="date" value={data} onChange={(e) => setData(e.target.value)} />
        </Field>
        <button className="btn btn-primary">Zapisz saldo</button>
      </form>
    </section>
  );
}
