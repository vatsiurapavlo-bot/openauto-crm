import { useState } from 'react';
import type { Car, CarStatus, StatusHistoryEntry, StatusKind } from '../../shared/types.ts';
import { api, ApiError } from '../api.ts';
import { Link, navigate } from '../router.tsx';
import { useApp } from '../state.tsx';
import { CarNumber, CarThumb, ErrorBox, Icon, Money, Spinner, StatusBadge, date, dateTime, money, num, useLoad, useToast, cssVar } from '../ui.tsx';
import { CarFormModal } from './CarForm.tsx';
import { CarCostsPanel } from './Costs.tsx';

const KIND_LABEL: Record<StatusKind, string> = {
  logistic: 'Status logistyczny',
  sales: 'Status sprzedaży',
  settlement: 'Status rozliczenia',
};

const TRYB: Record<string, string> = {
  vat_marza: 'VAT-marża',
  vat_23: 'Faktura VAT 23%',
  vat_wdt: 'WNT / 0% UE',
  bez_vat: 'Bez VAT',
  inne: 'Inne',
};

export function CarDetailPage({ id }: { id: string }) {
  const app = useApp();
  const toast = useToast();
  const { data: car, error, loading, reload, setData } = useLoad(() => api.get<Car>(`/api/cars/${id}`), [id]);
  const history = useLoad(() => api.get<StatusHistoryEntry[]>(`/api/cars/${id}/history`), [id, car?.version]);
  const [editing, setEditing] = useState(false);
  const [busyKind, setBusyKind] = useState<StatusKind | null>(null);

  if (error) {
    return (
      <div className="page">
        <BackLink />
        <ErrorBox error={error} onRetry={(error as ApiError).status === 404 ? undefined : reload} />
      </div>
    );
  }
  if (loading && !car) return <Spinner />;
  if (!car) return null;

  const st = app.status(car.displayStatusId);
  const canStatus = app.can('cars.status') || app.can('cars.edit');

  async function changeStatus(kind: StatusKind, statusId: string) {
    if (!car) return;
    const target = app.status(statusId);
    if (kind === 'settlement' && target?.isClosed && !confirm('Oznaczyć samochód jako rozliczony? Zniknie z listy aktywnych (zostanie w zakładce Rozliczone).')) {
      return;
    }
    setBusyKind(kind);
    try {
      const r = await api.post<{ car: Car | null }>(`/api/cars/${car.id}/status`, { kind, statusId, version: car.version });
      toast(`${KIND_LABEL[kind]}: ${target?.name}`);
      if (r.car) setData(r.car);
      else navigate('/samochody'); // rola nie widzi już auta (np. Serwis oddał je na plac)
    } catch (e) {
      toast((e as Error).message, 'error');
      if ((e as ApiError).status === 409) reload();
    } finally {
      setBusyKind(null);
    }
  }

  const f = car.finance;
  return (
    <div className="page">
      <BackLink />
      <div className="detail-head" style={cssVar(st?.color)}>
        <CarThumb car={car} color={st?.color} />
        <div className="detail-title">
          <div className="detail-kicker">
            <CarNumber car={car} />
            <StatusBadge status={st} />
          </div>
          <h1>
            {car.marka} {car.model} <span className="muted">{car.rokProdukcji}</span>
          </h1>
          <p className="muted">{[car.wersja, car.vin && `VIN ${car.vin}`, car.numerRejestracyjny].filter(Boolean).join(' · ') || '—'}</p>
        </div>
        <div className="detail-actions">
          {(app.can('cars.edit') || app.can('cars.finance.edit')) && (
            <button className="btn btn-primary" onClick={() => setEditing(true)}>
              Edytuj
            </button>
          )}
        </div>
      </div>

      <section className="status-strip" aria-label="Statusy">
        {(['logistic', 'sales', 'settlement'] as StatusKind[]).map((kind) => {
          const current = app.status(kind === 'logistic' ? car.logisticStatusId : kind === 'sales' ? car.salesStatusId : car.settlementStatusId);
          const allowed =
            canStatus &&
            (kind !== 'settlement' || app.can('cars.settle')) &&
            (kind !== 'sales' || app.can('cars.edit'));
          return (
            <StatusPicker
              key={kind}
              label={KIND_LABEL[kind]}
              current={current}
              options={app.meta.statuses.filter((s) => s.kind === kind && s.active)}
              disabled={!allowed || busyKind !== null}
              busy={busyKind === kind}
              onPick={(id) => void changeStatus(kind, id)}
            />
          );
        })}
      </section>

      <div className="detail-grid">
        <section className="panel">
          <header className="panel-head">
            <h2>Dane samochodu</h2>
          </header>
          <dl className="kv">
            <KV k="Numer auta" v={String(car.numer)} />
            <KV k="Marka / model" v={`${car.marka} ${car.model}`} />
            <KV k="Wersja" v={car.wersja} />
            <KV k="Rok produkcji" v={car.rokProdukcji} />
            <KV k="VIN" v={car.vin} mono />
            <KV k="Nr rejestracyjny" v={car.numerRejestracyjny} mono />
            <KV k="Przebieg" v={num(car.przebiegKm, 'km')} />
            <KV k="Pojemność" v={num(car.pojemnoscCm3, 'cm³')} />
            <KV k="Moc" v={num(car.mocKm, 'KM')} />
            <KV k="Paliwo" v={car.rodzajPaliwa} />
            <KV k="Skrzynia" v={car.skrzyniaBiegow} />
            <KV k="Kolor" v={car.kolor} />
          </dl>
        </section>

        <section className="panel">
          <header className="panel-head">
            <h2>Zakup i sprzedaż</h2>
          </header>
          <dl className="kv">
            <KV k="Typ zakupu" v={car.typZakupu} />
            <KV k="Data zakupu" v={date(car.dataZakupu)} />
            <KV k="Data przyjazdu" v={date(car.dataPrzyjazdu)} />
            <KV k="Data sprzedaży" v={date(car.dataSprzedazy)} />
            <KV k="Kraj zakupu" v={car.krajZakupu} />
            <KV k="Kraj rejestracji" v={car.krajRejestracji} />
            <KV k="Kraj lokalizacji" v={car.krajLokalizacji} />
            <KV k="Kraj sprzedawcy" v={car.krajSprzedawcy} />
            <KV k="Kraj faktury" v={car.krajFaktury} />
            <KV k="Cena A" v={money(car.cenaA)} strong />
            <KV k="Cena B" v={money(car.cenaB)} />
          </dl>
        </section>

        {f && (
          <section className="panel panel-fin">
            <header className="panel-head">
              <h2>
                <Icon name="lock" size={15} /> Finanse
              </h2>
              <span className="nav-stage">pełne rozliczenie — Etap 4</span>
            </header>
            <dl className="kv">
              <KV k="Wartość auta" v={money(f.wartoscAuta)} strong />
              <KV k="Zakup w walucie" v={f.cenaZakupuWaluta ? `${money(f.cenaZakupuWaluta, false)} ${f.walutaZakupu}${f.kursWaluty ? ` × ${f.kursWaluty}` : ''}` : null} />
              <KV k="Usługi aukcji netto" v={money(f.uslugiAukcjiNetto)} />
              <KV k="VAT na usługi" v={money(f.vatNaUslugi)} />
              <KV k="PCC-3 / Akcyza" v={money(f.akcyzaPcc)} />
              <KV k="Tryb zakupu / sprzedaży" v={[f.trybZakupu, f.trybSprzedazy].map((x) => (x ? TRYB[x] : '—')).join(' / ')} />
              <KV k="Kwota nabycia (VAT-marża)" v={money(f.kwotaNabyciaVatMarza)} />
              <KV k="Koszty razem" v={f.kosztyRazem === null ? 'brak uprawnień' : money(f.kosztyRazem)} />
              <KV k="Cena sprzedaży faktyczna" v={money(f.cenaSprzedazyFaktyczna)} strong />
            </dl>
            <div className="fin-results">
              <div>
                <span className="tiny muted">Zysk A (prognoza)</span>
                <Money value={f.zyskAPrognoza} signed />
              </div>
              <div>
                <span className="tiny muted">Zysk B (prognoza)</span>
                <Money value={f.zyskBPrognoza} signed />
              </div>
            </div>
            <p className="footnote">Prognoza przed podatkami: cena ofertowa − wartość auta − koszty.</p>
          </section>
        )}

        {app.can('costs.view') && <CarCostsPanel carId={car.id} onChanged={reload} />}

        <section className="panel">
          <header className="panel-head">
            <h2>
              <Icon name="history" size={15} /> Historia statusów
            </h2>
          </header>
          {history.data ? (
            <ol className="timeline">
              {history.data.map((h, i) => (
                <li key={i}>
                  <span className="tl-dot" style={{ background: app.status(h.toStatusId)?.color }} />
                  <div>
                    <div>
                      <span className="muted small">{KIND_LABEL[h.kind]}:</span>{' '}
                      {h.fromStatusId ? (
                        <>
                          {app.status(h.fromStatusId)?.name} → <strong>{app.status(h.toStatusId)?.name}</strong>
                        </>
                      ) : (
                        <strong>{app.status(h.toStatusId)?.name}</strong>
                      )}
                    </div>
                    <div className="muted small">
                      {dateTime(h.changedAt)} · {h.changedBy ?? 'system'}
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <Spinner />
          )}
        </section>

        <section className="panel">
          <header className="panel-head">
            <h2>Zdjęcia i dokumenty</h2>
            <span className="nav-stage">Etap 2 · Google Drive</span>
          </header>
          <p className="muted small">
            Zdjęcia (główne, auto, dokumenty, tablice, uszkodzenia, naprawa) i dokumenty będą zapisywane w folderze tego auta na
            Google Drive.
          </p>
          {car.notatka && (
            <>
              <h3 className="sub">Notatka</h3>
              <p className="note">{car.notatka}</p>
            </>
          )}
        </section>
      </div>

      <p className="muted small meta-line">
        Utworzono {dateTime(car.createdAt)} · ostatnia zmiana {dateTime(car.updatedAt)} · wersja {car.version}
      </p>

      {editing && (
        <CarFormModal
          car={car}
          onClose={() => setEditing(false)}
          onSaved={(c) => {
            setEditing(false);
            setData(c);
          }}
        />
      )}
    </div>
  );
}

function BackLink() {
  return (
    <Link to="/samochody" className="back">
      <Icon name="back" size={16} /> Samochody
    </Link>
  );
}

function KV({ k, v, mono, strong }: { k: string; v: string | number | null | undefined; mono?: boolean; strong?: boolean }) {
  return (
    <div>
      <dt>{k}</dt>
      <dd className={(mono ? 'mono ' : '') + (strong ? 'strong' : '')}>{v === null || v === undefined || v === '' ? '—' : v}</dd>
    </div>
  );
}

function StatusPicker(props: {
  label: string;
  current?: CarStatus;
  options: CarStatus[];
  disabled: boolean;
  busy: boolean;
  onPick: (id: string) => void;
}) {
  return (
    <div className="status-picker" style={cssVar(props.current?.color)}>
      <span className="tiny muted">{props.label}</span>
      <div className="status-select">
        <span className="badge-dot" />
        <select
          value={props.current?.id ?? ''}
          disabled={props.disabled}
          onChange={(e) => props.onPick(e.target.value)}
          aria-label={props.label}
        >
          {props.options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
        {props.busy && <span className="spinner sm" />}
      </div>
    </div>
  );
}
