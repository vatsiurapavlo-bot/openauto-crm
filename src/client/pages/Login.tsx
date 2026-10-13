import { useState, type FormEvent } from 'react';
import { api } from '../api.ts';
import { Icon, cssVar } from '../ui.tsx';

export function LoginPage({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.post('/api/auth/login', { email, password });
      onLoggedIn();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <div className="login-art" aria-hidden="true">
        <div className="login-art-inner">
          <span className="brand-mark lg">OA</span>
          <h1>OpenAuto CRM</h1>
          <p>Zakup, import, serwis i sprzedaż samochodów — wszystko w jednym miejscu.</p>
          <ul className="login-status">
            <li style={cssVar('#EAB308')}>W drodze</li>
            <li style={cssVar('#16A34A')}>Na placu</li>
            <li style={cssVar('#7C3AED')}>Serwis</li>
            <li style={cssVar('#C026D3')}>Lakiernia</li>
            <li style={cssVar('#2563EB')}>Rozliczone</li>
          </ul>
        </div>
      </div>
      <form className="login-form" onSubmit={submit} noValidate>
        <span className="brand-mark lg mobile-only">OA</span>
        <h2>Zaloguj się</h2>
        <p className="muted">Dostęp tylko dla pracowników OpenAuto.</p>
        <label className="field">
          <span className="field-label">E-mail</span>
          <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label className="field">
          <span className="field-label">Hasło</span>
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        {error && (
          <div className="error-box" role="alert">
            <Icon name="alert" />
            <span>{error}</span>
          </div>
        )}
        <button className="btn btn-primary btn-block" disabled={busy || !email || !password}>
          {busy ? 'Logowanie…' : 'Zaloguj'}
        </button>
        <p className="muted small">
          <Icon name="lock" size={14} /> Połączenie szyfrowane, sesja wygasa po bezczynności.
        </p>
      </form>
    </div>
  );
}
