import { useState, type FormEvent } from 'react';
import { ROLE_LABELS } from '../../shared/permissions.ts';
import { api, ApiError } from '../api.ts';
import { useApp } from '../state.tsx';
import { ErrorBox, Field, Icon, Modal, Spinner, dateTime, useLoad, useToast } from '../ui.tsx';

interface UserRow {
  id: string;
  email: string;
  fullName: string;
  role: string;
  roleName: string;
  active: boolean;
  lastLoginAt: string | null;
}

export function UsersPage() {
  const { data, error, loading, reload } = useLoad(() => api.get<UserRow[]>('/api/users'), []);
  const [adding, setAdding] = useState(false);
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Użytkownicy</h1>
          <p className="muted">Dostęp do OpenAuto. Uprawnienia sprawdza serwer i baza danych.</p>
        </div>
        <button className="btn btn-primary" onClick={() => setAdding(true)}>
          <Icon name="plus" /> Dodaj użytkownika
        </button>
      </div>
      {error && <ErrorBox error={error} onRetry={reload} />}
      {loading && !data && <Spinner />}
      {data && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Imię i nazwisko</th>
                <th>E-mail</th>
                <th>Rola</th>
                <th>Ostatnie logowanie</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.map((u) => (
                <tr key={u.id}>
                  <td>
                    <strong>{u.fullName}</strong>
                  </td>
                  <td>{u.email}</td>
                  <td>{u.roleName}</td>
                  <td>{u.lastLoginAt ? dateTime(u.lastLoginAt) : '—'}</td>
                  <td>{u.active ? 'Aktywny' : 'Nieaktywny'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="footnote">
        Zaproszenia przez indywidualny link, edycja uprawnień ról i dezaktywacja kont — Etap 6.
      </p>
      {adding && (
        <AddUserModal
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

function AddUserModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const app = useApp();
  const toast = useToast();
  const [v, setV] = useState({ fullName: '', email: '', role: 'sprzedawca', password: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const roles = Object.entries(ROLE_LABELS).filter(([code]) => code !== 'owner' || app.me.role === 'owner');

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    setMsg('');
    try {
      await api.post('/api/users', v);
      toast(`Dodano: ${v.fullName}. Przekaż hasło tymczasowe osobiście.`);
      onSaved();
    } catch (err) {
      setErrors((err as ApiError).fields);
      setMsg((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV((s) => ({ ...s, [k]: e.target.value }));

  return (
    <Modal title="Nowy użytkownik" onClose={onClose}>
      <form className="form" onSubmit={submit} noValidate>
        <div className="form-grid">
          <Field label="Imię i nazwisko" error={errors.fullName}>
            <input value={v.fullName} onChange={set('fullName')} />
          </Field>
          <Field label="E-mail" error={errors.email}>
            <input type="email" value={v.email} onChange={set('email')} autoComplete="off" />
          </Field>
          <Field label="Rola" error={errors.role}>
            <select value={v.role} onChange={set('role')}>
              {roles.map(([code, label]) => (
                <option key={code} value={code}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Hasło tymczasowe" error={errors.password} hint="min. 10 znaków, litery i cyfry">
            <input type="text" value={v.password} onChange={set('password')} autoComplete="new-password" />
          </Field>
        </div>
        {msg && (
          <div className="error-box" role="alert">
            <Icon name="alert" />
            <span>{msg}</span>
          </div>
        )}
        <div className="form-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Anuluj
          </button>
          <button className="btn btn-primary" disabled={busy}>
            Dodaj
          </button>
        </div>
      </form>
    </Modal>
  );
}
