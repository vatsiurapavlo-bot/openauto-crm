import type { DashboardData } from '../../shared/types.ts';
import { api } from '../api.ts';
import { Link, navigate } from '../router.tsx';
import { useApp } from '../state.tsx';
import { CarNumber, CarThumb, Empty, ErrorBox, Icon, Money, Spinner, StatusBadge, date, money, useLoad } from '../ui.tsx';
import { NewCarButton } from './Cars.tsx';

const TYPY: Record<string, string> = {
  przychod: 'Przychód',
  wydatek: 'Wydatek',
  korekta: 'Korekta',
  wplata: 'Wpłata',
  wyplata: 'Wypłata',
};

export function DashboardPage() {
  const app = useApp();
  const { data, error, loading, reload } = useLoad(() => api.get<DashboardData>('/api/dashboard'), []);

  const today = new Date().toLocaleDateString('pl-PL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Dashboard</h1>
          <p className="muted cap">{today}</p>
        </div>
        <NewCarButton />
      </div>

      {error && <ErrorBox error={error} onRetry={reload} />}
      {loading && !data && <Spinner />}
      {data && (
        <>
          <section className="tiles" aria-label="Samochody według statusu">
            <StatTile label="W sprzedaży" value={data.counts.wSprzedazy} color={app.statusByCode('sales', 'w_sprzedazy')?.color} to="/samochody?sales=w_sprzedazy" />
            <StatTile label="W drodze" value={data.counts.wDrodze} color={app.statusByCode('logistic', 'w_drodze')?.color} to="/w-drodze" />
            <StatTile label="Na placu" value={data.counts.naPlacu} color={app.statusByCode('logistic', 'na_placu')?.color} to="/na-placu" />
            <StatTile label="Serwis" value={data.counts.serwis} color={app.statusByCode('logistic', 'serwis')?.color} to="/serwis" />
            <StatTile label="Lakiernia" value={data.counts.lakiernia} color={app.statusByCode('logistic', 'lakiernia')?.color} to="/lakiernia" />
            <StatTile label="Problem / Wstrzymane" value={data.counts.problem} color={app.statusByCode('logistic', 'problem')?.color} to="/samochody?status=problem" />
          </section>

          {(data.finance || data.kasa || data.kosztyRazem !== null) && (
            <section className="money-row" aria-label="Finanse">
              {data.finance && (
                <MoneyTile label="Wartość aut (aktywne)" value={data.finance.wartoscAut} sub={`${data.counts.aktywne} aut w obrocie`} />
              )}
              {data.kosztyRazem !== null && <MoneyTile label="Koszty razem" value={data.kosztyRazem} sub="wszystkie koszty brutto" />}
              {data.kasa && <MoneyTile label="Kasa — stan aktualny" value={data.kasa.aktualna} sub="gotówka, operacje potwierdzone" accent />}
              {data.finance && (
                <MoneyTile
                  label="Zysk oczekiwany"
                  value={data.finance.zyskOczekiwany}
                  sub={`prognoza z Ceny A · ${data.finance.zyskOczekiwanyLiczbaAut} aut`}
                  signed
                />
              )}
              {data.finance && (
                <MoneyTile
                  label="Zysk faktyczny"
                  value={data.finance.zyskFaktyczny}
                  sub={`auta rozliczone · ${data.finance.zyskFaktycznyLiczbaAut}`}
                  signed
                />
              )}
            </section>
          )}
          {data.finance && (
            <p className="footnote">
              Zysk liczony przed podatkami: cena − wartość auta − koszty. Rozliczenie VAT-marża, PIT i składki — Etap 4, po
              weryfikacji reguł przez księgowego.
            </p>
          )}

          <div className="two-col">
            <section className="panel">
              <header className="panel-head">
                <h2>Ostatnio zmienione</h2>
                <Link to="/samochody?sort=zmiana" className="link">
                  Wszystkie
                </Link>
              </header>
              {data.recentCars.length === 0 ? (
                <Empty title="Brak samochodów">Dodaj pierwszy samochód, aby zacząć.</Empty>
              ) : (
                <ul className="mini-list">
                  {data.recentCars.map((c) => {
                    const st = app.status(c.displayStatusId);
                    return (
                      <li key={c.id} onClick={() => navigate(`/samochody/${c.id}`)}>
                        <CarThumb car={c} color={st?.color} />
                        <div className="mini-main">
                          <div className="mini-title">
                            <CarNumber car={c} /> {c.marka} {c.model} <span className="muted">{c.rokProdukcji}</span>
                          </div>
                          <StatusBadge status={st} small />
                        </div>
                        <div className="mini-price">{money(c.cenaA)}</div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            {data.kasa && (
              <section className="panel">
                <header className="panel-head">
                  <h2>Ostatnie operacje kasowe</h2>
                  <span className="nav-stage">Kasa — Etap 3</span>
                </header>
                {data.kasa.ostatnieOperacje.length === 0 ? (
                  <Empty icon="wallet" title="Brak operacji kasowych">
                    Operacje pojawią się po uruchomieniu modułów Koszty i Kasa.
                  </Empty>
                ) : (
                  <table className="table compact">
                    <thead>
                      <tr>
                        <th>Data</th>
                        <th>Opis</th>
                        <th className="r">Kwota</th>
                        <th className="r">Saldo</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.kasa.ostatnieOperacje.map((o) => (
                        <tr key={o.id}>
                          <td>{date(o.data)}</td>
                          <td>
                            {TYPY[o.typ] ?? o.typ} · {o.opis}
                            {o.carNumer !== null && <span className="muted"> · auto #{o.carNumer}</span>}
                          </td>
                          <td className="r">
                            <Money value={o.kwota} signed />
                          </td>
                          <td className="r">
                            <Money value={o.saldoPoOperacji} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </section>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function StatTile({ label, value, color, to }: { label: string; value: number; color?: string; to: string }) {
  return (
    <Link to={to} className="tile" title={`Pokaż: ${label}`}>
      <span className="tile-bar" style={{ background: color }} />
      <span className="tile-label">{label}</span>
      <span className="tile-value">{value}</span>
      <Icon name="back" className="tile-arrow" size={16} />
    </Link>
  );
}

function MoneyTile({ label, value, sub, signed, accent }: { label: string; value: string; sub: string; signed?: boolean; accent?: boolean }) {
  return (
    <div className={'money-tile' + (accent ? ' accent' : '')}>
      <span className="tile-label">{label}</span>
      <span className="money-value">
        <Money value={value} signed={signed} />
      </span>
      <span className="muted small">{sub}</span>
    </div>
  );
}
