import { useState } from 'react';
import { api } from '../api.ts';
import { ErrorBox, Icon, Spinner, dateTime, useLoad, useToast } from '../ui.tsx';

interface LaunchData {
  checks: Array<{ id: string; label: string; ok: boolean; critical: boolean; detail?: string }>;
  ready: boolean;
  confirmed: { at: string; by: string | null } | null;
}

const MANUAL: Array<[keyof Manual, string]> = [
  ['railwayBackups', 'W Railway włączyłem kopie bazy (Postgres → Backups: codziennie i co tydzień).'],
  ['dbPrivate', 'Baza nie jest dostępna publicznie (Postgres → Settings → Networking: brak TCP Proxy).'],
  ['keyStored', 'Klucz OPENAUTO_MASTER_KEY mam zapisany poza Railway (menedżer haseł / sejf).'],
];
type Manual = { railwayBackups: boolean; dbPrivate: boolean; keyStored: boolean };

/** Kontrola bezpieczeństwa i zatwierdzenie pracy na prawdziwych danych (tylko Właściciel). */
export function LaunchPanel() {
  const toast = useToast();
  const { data, error, loading, reload } = useLoad(() => api.get<LaunchData>('/api/system/launch'), []);
  const [manual, setManual] = useState<Manual>({ railwayBackups: false, dbPrivate: false, keyStored: false });
  const [busy, setBusy] = useState(false);
  const allManual = Object.values(manual).every(Boolean);

  async function confirmLaunch() {
    if (!confirm('Zatwierdzić uruchomienie? Od teraz w CRM można wprowadzać prawdziwe dane.')) return;
    setBusy(true);
    try {
      await api.post('/api/system/launch/confirm', manual);
      toast('Uruchomienie zatwierdzone');
      setTimeout(() => window.location.reload(), 600);
    } catch (e) {
      toast((e as Error).message, 'error');
      reload();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <header className="panel-head">
        <h2>
          <Icon name="check" size={15} /> Kontrola przed uruchomieniem
        </h2>
        <button className="btn btn-ghost btn-sm" onClick={reload}>
          Sprawdź ponownie
        </button>
      </header>
      {error && <ErrorBox error={error} onRetry={reload} />}
      {loading && !data && <Spinner />}
      {data && (
        <>
          <ul className="checklist">
            {data.checks.map((c) => (
              <li key={c.id} className={c.ok ? 'ok' : 'todo'}>
                <span className="check-mark">{c.ok ? '✓' : '!'}</span>
                <span>
                  <strong>{c.label}</strong>
                  {!c.critical && <span className="muted small"> (zalecane)</span>}
                  {c.detail && (
                    <>
                      <br />
                      <span className="muted small">{c.detail}</span>
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
          {data.confirmed ? (
            <p className="ok-box">
              Uruchomienie zatwierdzone {dateTime(data.confirmed.at)}
              {data.confirmed.by ? ` — ${data.confirmed.by}` : ''}. CRM pracuje na prawdziwych danych.
            </p>
          ) : (
            <>
              <fieldset className="manual-checks">
                <legend className="muted small">Punkty sprawdzane ręcznie</legend>
                {MANUAL.map(([key, label]) => (
                  <label key={key}>
                    <input type="checkbox" checked={manual[key]} onChange={(e) => setManual((m) => ({ ...m, [key]: e.target.checked }))} />
                    <span>{label}</span>
                  </label>
                ))}
              </fieldset>
              <div className="form-actions start">
                <button className="btn btn-primary" disabled={!data.ready || !allManual || busy} onClick={() => void confirmLaunch()}>
                  Zatwierdzam uruchomienie z prawdziwymi danymi
                </button>
              </div>
              {!data.ready && <p className="footnote">Przycisk będzie aktywny, gdy wszystkie wymagane kontrole będą spełnione.</p>}
            </>
          )}
        </>
      )}
    </section>
  );
}
