import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Me, Meta } from '../shared/types.ts';
import { api, setUnauthorizedHandler } from './api.ts';
import { Link, matchPath, navigate, useLocation } from './router.tsx';
import { AppContext, buildState, useApp } from './state.tsx';
import { ErrorBox, Icon, Spinner, ToastProvider } from './ui.tsx';
import { LoginPage } from './pages/Login.tsx';
import { DashboardPage } from './pages/Dashboard.tsx';
import { CarsPage, type CarsPreset } from './pages/Cars.tsx';
import { CarDetailPage } from './pages/CarDetail.tsx';
import { UsersPage } from './pages/Users.tsx';
import { SettingsPage, ForcedPasswordPage } from './pages/Settings.tsx';
import { PlaceholderPage } from './pages/Placeholder.tsx';

interface NavItem {
  path: string;
  label: string;
  icon: string;
  perm?: string;
  preset?: CarsPreset;
  stage?: { n: number; text: string };
}

export const NAV: NavItem[] = [
  { path: '/', label: 'Dashboard', icon: 'dashboard', perm: 'dashboard.view' },
  { path: '/samochody', label: 'Samochody', icon: 'car', perm: 'cars.view', preset: { title: 'Samochody' } },
  { path: '/w-drodze', label: 'W drodze', icon: 'truck', perm: 'cars.view', preset: { title: 'W drodze', status: 'w_drodze' } },
  { path: '/na-placu', label: 'Na placu', icon: 'lot', perm: 'cars.view', preset: { title: 'Na placu', status: 'na_placu' } },
  { path: '/serwis', label: 'Serwis', icon: 'wrench', perm: 'cars.view', preset: { title: 'Serwis', status: 'serwis' } },
  { path: '/lakiernia', label: 'Lakiernia', icon: 'spray', perm: 'cars.view', preset: { title: 'Lakiernia', status: 'lakiernia' } },
  { path: '/rozliczone', label: 'Rozliczone', icon: 'check', perm: 'cars.view', preset: { title: 'Rozliczone', view: 'rozliczone' } },
  { path: '/koszty', label: 'Koszty', icon: 'receipt', perm: 'costs.view', stage: { n: 3, text: 'Koszty z VAT (netto/brutto), przypisanie do auta lub firmy, automatyczny wydatek w Kasie przy płatności gotówką.' } },
  { path: '/kasa', label: 'Kasa', icon: 'wallet', perm: 'kasa.view', stage: { n: 3, text: 'Dziennik kasowy z saldem po operacji, korektami zamiast nadpisywania i ochroną przed podwójnym obciążeniem.' } },
  { path: '/finanse', label: 'Finanse', icon: 'chart', perm: 'finance.view', stage: { n: 4, text: 'VAT-marża, VAT należny i naliczony w okresie, PIT, składka zdrowotna, zysk księgowy i ekonomiczny — reguły do weryfikacji przez księgowego.' } },
  { path: '/raporty', label: 'Raporty', icon: 'report', perm: 'reports.view', stage: { n: 4, text: 'Raporty sprzedaży, kosztów i zysku za okres oraz eksport do Excela.' } },
  { path: '/dokumenty', label: 'Dokumenty', icon: 'file', perm: 'documents.view', stage: { n: 4, text: 'Faktury VAT i VAT-marża, faktury kosztowe, umowy, korekty, kontrahenci i eksport PDF.' } },
  { path: '/uzytkownicy', label: 'Użytkownicy', icon: 'users', perm: 'users.manage' },
  { path: '/ustawienia', label: 'Ustawienia', icon: 'settings' },
];

function landingPath(can: (p: string) => boolean, role: string) {
  if (can('dashboard.view')) return '/';
  if (role === 'serwis') return '/serwis';
  if (role === 'lakiernia') return '/lakiernia';
  return '/samochody';
}

function Shell() {
  const app = useApp();
  const { path } = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const items = NAV.filter((n) => !n.perm || app.can(n.perm));

  useEffect(() => setMenuOpen(false), [path]);

  let page: ReactNode = null;
  let current = items.find((n) => n.path === path);
  const carMatch = matchPath('/samochody/:id', path);
  const redirect = path === '/' && !app.can('dashboard.view') ? landingPath(app.can, app.me.role) : null;
  useEffect(() => {
    if (redirect) navigate(redirect, true);
  }, [redirect]);
  if (redirect) {
    page = null;
  } else if (carMatch) {
    current = items.find((n) => n.path === '/samochody');
    page = <CarDetailPage id={carMatch.id} />;
  } else if (current?.path === '/') page = <DashboardPage />;
  else if (current?.preset) page = <CarsPage key={current.path} preset={current.preset} />;
  else if (current?.stage) page = <PlaceholderPage title={current.label} icon={current.icon} stage={current.stage} />;
  else if (current?.path === '/uzytkownicy') page = <UsersPage />;
  else if (current?.path === '/ustawienia') page = <SettingsPage />;
  else page = <PlaceholderPage title="Nie znaleziono" icon="alert" />;

  return (
    <div className={'shell' + (menuOpen ? ' menu-open' : '')}>
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">OA</span>
          <span className="brand-text">
            <strong>OpenAuto</strong>
            <small>CRM</small>
          </span>
          <button className="icon-btn sidebar-close" onClick={() => setMenuOpen(false)} aria-label="Zamknij menu">
            <Icon name="x" />
          </button>
        </div>
        <nav className="nav" aria-label="Menu główne">
          {items.map((n) => (
            <Link key={n.path} to={n.path} className={'nav-item' + (current?.path === n.path ? ' active' : '')}>
              <Icon name={n.icon} />
              <span>{n.label}</span>
              {n.preset?.status && <StatusPip code={n.preset.status} />}
              {n.preset?.view === 'rozliczone' && <StatusPip code="rozliczone" kind="settlement" />}
              {n.stage && <span className="nav-stage">E{n.stage.n}</span>}
            </Link>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="who">
            <strong>{app.me.user.fullName}</strong>
            <small>
              {app.me.roleName} · {app.me.workspace.name}
            </small>
          </div>
          <button className="icon-btn" onClick={() => void app.logout()} title="Wyloguj" aria-label="Wyloguj">
            <Icon name="logout" />
          </button>
        </div>
      </aside>
      <div className="scrim" onClick={() => setMenuOpen(false)} />
      <div className="main">
        <header className="topbar">
          <button className="icon-btn" onClick={() => setMenuOpen(true)} aria-label="Otwórz menu">
            <Icon name="menu" />
          </button>
          <span className="topbar-title">{current?.label ?? 'OpenAuto'}</span>
          <span className="brand-mark sm">OA</span>
        </header>
        {app.me.mode !== 'production' && (
          <div className="test-banner" role="note">
            <Icon name="alert" size={16} />
            {app.me.environment && app.me.environment !== 'production'
              ? `Podgląd zmian (${app.me.environment}) — osobna baza testowa, nie wprowadzaj prawdziwych danych.`
              : 'Tryb testowy — nie wprowadzaj prawdziwych danych, dopóki właściciel nie zatwierdzi uruchomienia.'}
          </div>
        )}
        <main className="content">{page}</main>
      </div>
    </div>
  );
}

function StatusPip({ code, kind = 'logistic' }: { code: string; kind?: 'logistic' | 'settlement' }) {
  const s = useApp().statusByCode(kind, code);
  return s ? <span className="nav-pip" style={{ background: s.color }} /> : null;
}

export function App() {
  const [session, setSession] = useState<{ me: Me; meta: Meta } | null>(null);
  const [state, setState] = useState<'loading' | 'anon' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<Error | null>(null);
  useLocation();

  const load = useCallback(async () => {
    try {
      const [me, meta] = await Promise.all([api.get<Me>('/api/auth/me'), api.get<Meta>('/api/meta')]);
      setSession({ me, meta });
      setState('ready');
    } catch (e: any) {
      if (e.status === 401) setState('anon');
      else {
        setError(e);
        setState('error');
      }
    }
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setSession(null);
      setState('anon');
    });
    void load();
  }, [load]);

  const value = useMemo(() => {
    if (!session) return null;
    return buildState(
      session.me,
      session.meta,
      async () => {
        const meta = await api.get<Meta>('/api/meta');
        setSession((s) => (s ? { ...s, meta } : s));
      },
      async () => {
        await api.post('/api/auth/logout').catch(() => {});
        setSession(null);
        setState('anon');
        navigate('/', true);
      },
    );
  }, [session]);

  if (state === 'loading') return <div className="boot"><Spinner /></div>;
  if (state === 'error') return <div className="boot"><ErrorBox error={error!} onRetry={() => void load()} /></div>;
  if (state === 'anon' || !value) return <LoginPage onLoggedIn={() => void load()} />;
  if (value.me.mustChangePassword) {
    return (
      <ToastProvider>
        <ForcedPasswordPage name={value.me.user.fullName} onDone={() => void load()} onLogout={() => void value.logout()} />
      </ToastProvider>
    );
  }
  return (
    <ToastProvider>
      <AppContext.Provider value={value}>
        <Shell />
      </AppContext.Provider>
    </ToastProvider>
  );
}
