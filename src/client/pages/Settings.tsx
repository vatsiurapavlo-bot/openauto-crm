import { useState, type FormEvent } from 'react';
import type { StatusKind } from '../../shared/types.ts';
import { api, ApiError } from '../api.ts';
import { useApp } from '../state.tsx';
import { Field, Icon, StatusBadge, useToast } from '../ui.tsx';
import { BackupPanel } from './BackupPanel.tsx';
import { LaunchPanel } from './LaunchPanel.tsx';

const KINDS: Array<[StatusKind, string]> = [
  ['logistic', 'Logistyczne (gdzie jest auto)'],
  ['sales', 'Sprzedaż'],
  ['settlement', 'Rozliczenie'],
];

export function SettingsPage() {
  const app = useApp();
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Ustawienia</h1>
          <p className="muted">
            {app.me.user.fullName} · {app.me.roleName} · {app.me.workspace.name}
          </p>
        </div>
      </div>
      <div className="two-col">
        {app.can('backup.manage') && app.me.role === 'owner' && <BackupPanel />}
        {app.can('backup.manage') && app.me.role === 'owner' && <LaunchPanel />}
        <PasswordPanel />
        <EmailPanel />
        <section className="panel">
          <header className="panel-head">
            <h2>Statusy samochodów</h2>
            <span className="nav-stage">edycja — Etap 2</span>
          </header>
          {KINDS.map(([kind, label]) => (
            <div key={kind} className="status-group">
              <h3 className="sub">{label}</h3>
              <div className="chips">
                {app.meta.statuses
                  .filter((s) => s.kind === kind)
                  .map((s) => (
                    <StatusBadge key={s.id} status={s} />
                  ))}
              </div>
            </div>
          ))}
        </section>
        <section className="panel">
          <header className="panel-head">
            <h2>Kraje</h2>
            <span className="nav-stage">Kraje i aukcje — Etap 5</span>
          </header>
          <ul className="plain-list">
            {app.meta.countries.map((c) => (
              <li key={c.code}>
                <span className="mono">{c.code}</span> {c.name} <span className="muted">{c.currency}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}

function PasswordPanel({ onChanged }: { onChanged?: () => void } = {}) {
  const toast = useToast();
  const [v, setV] = useState({ currentPassword: '', newPassword: '', repeat: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  async function submit(e: FormEvent) {
    e.preventDefault();
    setErrors({});
    if (v.newPassword !== v.repeat) return setErrors({ repeat: 'Hasła się różnią' });
    try {
      await api.post('/api/auth/password', { currentPassword: v.currentPassword, newPassword: v.newPassword });
      toast('Hasło zmienione. Inne sesje zostały wylogowane.');
      setV({ currentPassword: '', newPassword: '', repeat: '' });
      onChanged?.();
    } catch (err) {
      const fields = (err as ApiError).fields;
      setErrors(Object.keys(fields).length ? fields : { newPassword: (err as Error).message });
    }
  }
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV((s) => ({ ...s, [k]: e.target.value }));
  return (
    <section className="panel">
      <header className="panel-head">
        <h2>
          <Icon name="lock" size={15} /> Zmiana hasła
        </h2>
      </header>
      <form className="form" onSubmit={submit}>
        <div className="form-grid one">
          <Field label="Obecne hasło" error={errors.currentPassword}>
            <input type="password" autoComplete="current-password" value={v.currentPassword} onChange={set('currentPassword')} />
          </Field>
          <Field label="Nowe hasło" error={errors.newPassword} hint="min. 10 znaków, litery i cyfry">
            <input type="password" autoComplete="new-password" value={v.newPassword} onChange={set('newPassword')} />
          </Field>
          <Field label="Powtórz nowe hasło" error={errors.repeat}>
            <input type="password" autoComplete="new-password" value={v.repeat} onChange={set('repeat')} />
          </Field>
        </div>
        <div className="form-actions">
          <button className="btn btn-primary" disabled={!v.currentPassword || !v.newPassword}>
            Zmień hasło
          </button>
        </div>
      </form>
    </section>
  );
}

/** Zmiana własnego adresu e-mail, którym loguje się użytkownik. */
function EmailPanel() {
  const app = useApp();
  const toast = useToast();
  const [current, setCurrent] = useState(app.me.user.email);
  const [v, setV] = useState({ newEmail: '', currentPassword: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setErrors({});
    setBusy(true);
    try {
      const r = await api.post<{ email: string }>('/api/auth/email', v);
      setCurrent(r.email);
      setV({ newEmail: '', currentPassword: '' });
      toast(`E-mail zmieniony na ${r.email}. Od teraz loguj się nowym adresem. Inne sesje zostały wylogowane.`);
    } catch (err) {
      const fields = (err as ApiError).fields;
      setErrors(Object.keys(fields).length ? fields : { newEmail: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV((s) => ({ ...s, [k]: e.target.value }));
  return (
    <section className="panel">
      <header className="panel-head">
        <h2>
          <Icon name="users" size={15} /> Zmiana e-maila (logowanie)
        </h2>
      </header>
      <form className="form" onSubmit={submit}>
        <p className="muted">
          Obecny e-mail: <strong className="mono">{current}</strong>
        </p>
        <div className="form-grid one">
          <Field label="Nowy e-mail" error={errors.newEmail}>
            <input type="email" autoComplete="email" inputMode="email" value={v.newEmail} onChange={set('newEmail')} />
          </Field>
          <Field label="Obecne hasło (potwierdzenie)" error={errors.currentPassword}>
            <input type="password" autoComplete="current-password" value={v.currentPassword} onChange={set('currentPassword')} />
          </Field>
        </div>
        <div className="form-actions">
          <button className="btn btn-primary" disabled={busy || !v.newEmail || !v.currentPassword}>
            {busy ? 'Zapisywanie…' : 'Zmień e-mail'}
          </button>
        </div>
      </form>
    </section>
  );
}

/** Pierwsze logowanie z hasłem tymczasowym — przed pracą trzeba ustawić własne hasło. */
export function ForcedPasswordPage({ name, onDone, onLogout }: { name: string; onDone: () => void; onLogout: () => void }) {
  return (
    <div className="boot">
      <div className="forced-pw">
        <span className="brand-mark lg">OA</span>
        <h1>Ustaw własne hasło</h1>
        <p className="muted">
          {name}, logujesz się hasłem tymczasowym. Przed rozpoczęciem pracy ustaw własne hasło — znasz je tylko Ty.
        </p>
        <PasswordPanel onChanged={onDone} />
        <button className="btn btn-ghost btn-block" onClick={onLogout}>
          Wyloguj
        </button>
      </div>
    </div>
  );
}
