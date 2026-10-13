import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../api.ts';
import { useLocation, setSearchParams } from '../router.tsx';
import { ErrorBox, Icon, Spinner, dateTime, useLoad, useToast } from '../ui.tsx';

interface BackupRun {
  id: number;
  trigger: 'auto' | 'manual';
  status: 'running' | 'ok' | 'error';
  startedAt: string;
  finishedAt: string | null;
  fileName: string | null;
  sizeBytes: number | null;
  error: string | null;
}

interface BackupStatus {
  enabled: boolean;
  scheduleEnabled: boolean;
  masterKey: 'ok' | 'missing' | 'too_short';
  googleConfigured: boolean;
  drive: { accountEmail: string | null; connectedAt: string; lastError: string | null } | null;
  pgDump: { available: boolean; version: string | null; compatible: boolean | null; message?: string };
  keep: number;
  runs: BackupRun[];
  lastOk: string | null;
}

const DRIVE_MESSAGES: Record<string, [string, 'ok' | 'error']> = {
  polaczono: ['Google Drive połączony. Utworzono folder „OpenAuto CRM”.', 'ok'],
  anulowano: ['Łączenie z Google anulowane.', 'error'],
  'niewazny-link': ['Link łączenia wygasł lub jest nieprawidłowy — spróbuj ponownie.', 'error'],
  'brak-uprawnien': ['Brak uprawnień do zarządzania kopiami.', 'error'],
  'brak-konfiguracji': ['Google nie jest skonfigurowany na serwerze.', 'error'],
  blad: ['Nie udało się połączyć z Google Drive. Spróbuj ponownie.', 'error'],
};

const kb = (n: number | null) => (n === null ? '—' : n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export function BackupPanel() {
  const toast = useToast();
  const { search } = useLocation();
  const { data, error, loading, reload } = useLoad(() => api.get<BackupStatus>('/api/system/backup'), []);
  const [busy, setBusy] = useState<'' | 'run' | 'connect' | 'disconnect'>('');
  const [generated, setGenerated] = useState('');

  useEffect(() => {
    const code = search.get('drive');
    if (code && DRIVE_MESSAGES[code]) {
      toast(...DRIVE_MESSAGES[code]);
      setSearchParams({ drive: undefined });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function act(kind: 'run' | 'connect' | 'disconnect') {
    setBusy(kind);
    try {
      if (kind === 'connect') {
        const r = await api.post<{ url: string }>('/api/integrations/google/connect');
        window.location.href = r.url;
        return;
      }
      if (kind === 'disconnect') {
        if (!confirm('Odłączyć Google Drive? Automatyczne kopie zostaną wstrzymane. Pliki na Dysku pozostaną.')) return;
        await api.post('/api/integrations/google/disconnect');
        toast('Google Drive odłączony');
      }
      if (kind === 'run') {
        const r = await api.post<BackupRun>('/api/system/backup/run');
        toast(`Kopia zapisana na Dysku: ${r.fileName}`);
      }
      reload();
    } catch (e) {
      toast((e as Error).message, 'error');
      reload();
    } finally {
      setBusy('');
    }
  }

  function generateKey() {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    setGenerated(btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''));
  }

  return (
    <section className="panel backup-panel">
      <header className="panel-head">
        <h2>
          <Icon name="lock" size={15} /> Google Drive i kopie zapasowe
        </h2>
      </header>
      {error && <ErrorBox error={error} onRetry={reload} />}
      {loading && !data && <Spinner />}
      {data && (
        <>
          <ul className="checklist">
            <Check ok={data.masterKey === 'ok'} label="Klucz szyfrowania (OPENAUTO_MASTER_KEY)">
              {data.masterKey === 'ok' ? 'ustawiony' : data.masterKey === 'too_short' ? 'za krótki (min. 32 znaki)' : 'brak'}
            </Check>
            <Check ok={data.googleConfigured} label="Aplikacja Google (GOOGLE_CLIENT_ID / SECRET)">
              {data.googleConfigured ? 'skonfigurowana' : 'brak — instrukcja, krok 5'}
            </Check>
            <Check ok={!!data.drive} label="Google Drive">
              {data.drive ? `połączony: ${data.drive.accountEmail ?? 'konto Google'}` : 'niepołączony'}
            </Check>
            <Check ok={data.pgDump.compatible === true} label="Narzędzie kopii (pg_dump)">
              {data.pgDump.message ?? `wersja ${data.pgDump.version}`}
            </Check>
            <Check ok={data.scheduleEnabled} label="Kopia automatyczna">
              {data.scheduleEnabled ? `codziennie po 2:00, przechowywane ${data.keep} ostatnich` : 'wyłączona w tym środowisku (podgląd / test)'}
            </Check>
            <Check ok={!!data.lastOk} label="Ostatnia udana kopia">
              {data.lastOk ? dateTime(data.lastOk) : 'jeszcze nie było'}
            </Check>
          </ul>

          {data.drive?.lastError && (
            <div className="error-box" role="alert">
              <Icon name="alert" />
              <span>Ostatni błąd: {data.drive.lastError}</span>
            </div>
          )}

          {data.masterKey !== 'ok' && (
            <div className="hint-box">
              <p>
                <strong>Klucz szyfrowania</strong> chroni kopie na Dysku. Bez niego kopii nie da się odczytać — także po utracie
                konta Railway. Zapisz go w menedżerze haseł i dodaj w Railway jako zmienną <code>OPENAUTO_MASTER_KEY</code>.
              </p>
              {generated ? (
                <p className="mono key-out">{generated}</p>
              ) : (
                <button className="btn btn-ghost btn-sm" onClick={generateKey}>
                  Wygeneruj klucz (tylko w tej przeglądarce)
                </button>
              )}
            </div>
          )}

          <div className="form-actions start">
            {data.drive ? (
              <>
                <button className="btn btn-primary" disabled={!data.enabled || busy !== ''} onClick={() => void act('run')}>
                  {busy === 'run' ? 'Tworzenie kopii…' : 'Utwórz kopię teraz'}
                </button>
                <button className="btn btn-ghost" disabled={busy !== ''} onClick={() => void act('disconnect')}>
                  Odłącz Dysk
                </button>
              </>
            ) : (
              <button
                className="btn btn-primary"
                disabled={!data.googleConfigured || data.masterKey !== 'ok' || busy !== ''}
                onClick={() => void act('connect')}
              >
                {busy === 'connect' ? 'Przekierowanie do Google…' : 'Połącz Google Drive'}
              </button>
            )}
          </div>

          {data.runs.length > 0 && (
            <table className="table compact">
              <thead>
                <tr>
                  <th>Data</th>
                  <th>Rodzaj</th>
                  <th>Wynik</th>
                  <th className="r">Rozmiar</th>
                </tr>
              </thead>
              <tbody>
                {data.runs.map((r) => (
                  <tr key={r.id} title={r.error ?? r.fileName ?? ''}>
                    <td>{dateTime(r.startedAt)}</td>
                    <td>{r.trigger === 'auto' ? 'automatyczna' : 'ręczna'}</td>
                    <td className={r.status === 'error' ? 'neg-text' : ''}>
                      {r.status === 'ok' ? 'OK' : r.status === 'running' ? 'w toku…' : `błąd: ${r.error?.slice(0, 80)}`}
                    </td>
                    <td className="r">{kb(r.sizeBytes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="footnote">
            Kopie są szyfrowane (AES-256) przed wysłaniem. CRM ma dostęp wyłącznie do folderu „OpenAuto CRM”, który sam utworzył — nie
            widzi innych plików na Twoim Dysku.
          </p>
        </>
      )}
    </section>
  );
}

function Check({ ok, label, children }: { ok: boolean; label: string; children: ReactNode }) {
  return (
    <li className={ok ? 'ok' : 'todo'}>
      <span className="check-mark">{ok ? '✓' : '!'}</span>
      <span>
        <strong>{label}</strong>
        <br />
        <span className="muted small">{children}</span>
      </span>
    </li>
  );
}
