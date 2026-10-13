import { createContext, useCallback, useContext, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { formatPLN, toCents } from '../shared/money.ts';
import type { Car, CarStatus } from '../shared/types.ts';

// ---------------------------------------------------------------------------
// Ikony (inline SVG, stroke = currentColor)
// ---------------------------------------------------------------------------

const PATHS: Record<string, ReactNode> = {
  dashboard: <><rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" /></>,
  car: <><path d="M5 16h14M5 16a2 2 0 1 0 4 0M15 16a2 2 0 1 0 4 0M3 16v-3.5l2-5A2 2 0 0 1 6.9 6h10.2a2 2 0 0 1 1.9 1.5l2 5V16" /><path d="M5 12h14" /></>,
  truck: <><path d="M3 6h11v10H3zM14 9h4l3 3v4h-7" /><circle cx="7" cy="17" r="1.8" /><circle cx="17" cy="17" r="1.8" /></>,
  lot: <><path d="M4 20V9l8-5 8 5v11" /><path d="M8 20v-6h8v6" /></>,
  wrench: <path d="M14.5 6.5a4 4 0 0 0-5.3 5.2L4 17l3 3 5.3-5.2a4 4 0 0 0 5.2-5.3l-2.4 2.4-2.6-.6-.6-2.6z" />,
  spray: <><rect x="6" y="10" width="7" height="11" rx="1.5" /><path d="M8 10V7h3v3M9.5 7V4.5M16 5h.01M19 4h.01M18 7.5h.01M16 9h.01" /></>,
  check: <><circle cx="12" cy="12" r="9" /><path d="m8 12.5 2.8 2.8L16.5 9.5" /></>,
  receipt: <><path d="M6 3h12v18l-3-2-3 2-3-2-3 2z" /><path d="M9 8h6M9 12h6" /></>,
  wallet: <><rect x="3" y="6" width="18" height="13" rx="2" /><path d="M3 10h18M16 14.5h2" /></>,
  chart: <path d="M4 20V4M4 20h16M8 16v-5M12 16V8M16 16v-8" />,
  report: <><path d="M7 3h7l5 5v13H7z" /><path d="M14 3v5h5M10 13h6M10 17h6" /></>,
  file: <><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v4h4" /></>,
  users: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6 6 0 0 1 3.5 6" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-2.7-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 3.6 15H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.1-2.7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 9.7 4.4V4a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7h.6a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.4 1z" /></>,
  search: <><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.2-4.2" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  grid: <><rect x="4" y="4" width="7" height="7" rx="1" /><rect x="13" y="4" width="7" height="7" rx="1" /><rect x="4" y="13" width="7" height="7" rx="1" /><rect x="13" y="13" width="7" height="7" rx="1" /></>,
  list: <path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" />,
  logout: <path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 16l-4-4 4-4M6 12h10" />,
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  x: <path d="M6 6l12 12M18 6 6 18" />,
  back: <path d="M15 5l-7 7 7 7" />,
  alert: <><path d="M12 3 2 20h20z" /><path d="M12 10v4M12 17h.01" /></>,
  lock: <><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></>,
  history: <><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5M12 7v5l3 2" /></>,
  filter: <path d="M4 5h16l-6 7v6l-4 2v-8z" />,
  import: <path d="M12 3v12M7 10l5 5 5-5M5 21h14" />,
};

export function Icon({ name, size = 18, className }: { name: string; size?: number; className?: string }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  );
}

/** Kolor statusu przekazywany do CSS jako zmienna --c */
export const cssVar = (color?: string) => ({ '--c': color } as CSSProperties);

// ---------------------------------------------------------------------------
// Statusy, kwoty, auta
// ---------------------------------------------------------------------------

export function StatusBadge({ status, small }: { status?: CarStatus; small?: boolean }) {
  if (!status) return null;
  return (
    <span className={'badge' + (small ? ' badge-sm' : '')} style={cssVar(status.color)}>
      <span className="badge-dot" />
      {status.name}
    </span>
  );
}

export function money(v: string | null | undefined, withCurrency = true) {
  if (v === null || v === undefined || v === '') return '—';
  return formatPLN(toCents(v), withCurrency);
}

export function Money({ value, signed }: { value: string | null | undefined; signed?: boolean }) {
  const neg = value?.startsWith('-');
  return <span className={'num' + (signed && value ? (neg ? ' neg' : ' pos') : '')}>{money(value)}</span>;
}

export const num = (n: number | null | undefined, unit = '') =>
  n === null || n === undefined ? '—' : n.toLocaleString('pl-PL') + (unit ? ' ' + unit : '');

export const date = (iso: string | null | undefined) => {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}.${m}.${y}`;
};

export const dateTime = (iso: string) =>
  new Date(iso).toLocaleString('pl-PL', { dateStyle: 'short', timeStyle: 'short' });

export function CarNumber({ car }: { car: Pick<Car, 'numer'> }) {
  return <span className="car-no">#{car.numer}</span>;
}

/** Zdjęcie auta albo neutralna sylwetka (zdjęcia: Etap 2). */
export function CarThumb({ car, color }: { car: Pick<Car, 'mainPhotoUrl' | 'marka'>; color?: string }) {
  if (car.mainPhotoUrl) return <img className="thumb" src={car.mainPhotoUrl} alt="" loading="lazy" />;
  return (
    <div className="thumb thumb-empty" style={cssVar(color ?? '#94a3b8')}>
      <svg viewBox="0 0 120 48" aria-hidden="true">
        <path d="M8 36h104M14 36v-8l10-12c2-2 4-3 7-3h44c4 0 6 1 9 3l14 11 10 2c3 1 4 2 4 5v2" />
        <circle cx="32" cy="36" r="7" />
        <circle cx="90" cy="36" r="7" />
        <path d="M30 24h66M55 13v11" />
      </svg>
      <span>{car.marka}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Formularze
// ---------------------------------------------------------------------------

interface FieldProps {
  label: string;
  error?: string;
  hint?: string;
  children: ReactNode;
  wide?: boolean;
}

export function Field({ label, error, hint, children, wide }: FieldProps) {
  return (
    <label className={'field' + (error ? ' has-error' : '') + (wide ? ' wide' : '')}>
      <span className="field-label">{label}</span>
      {children}
      {error ? <span className="field-error">{error}</span> : hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

// ---------------------------------------------------------------------------
// Różne
// ---------------------------------------------------------------------------

export function Empty({ icon = 'car', title, children }: { icon?: string; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <Icon name={icon} size={28} />
      <strong>{title}</strong>
      {children && <p>{children}</p>}
    </div>
  );
}

export function Spinner() {
  return <div className="spinner" role="status" aria-label="Ładowanie" />;
}

export function ErrorBox({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  return (
    <div className="error-box" role="alert">
      <Icon name="alert" />
      <span>{error.message}</span>
      {onRetry && (
        <button className="btn btn-ghost btn-sm" onClick={onRetry}>
          Spróbuj ponownie
        </button>
      )}
    </div>
  );
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    document.body.classList.add('no-scroll');
    ref.current?.querySelector<HTMLElement>('input, select, textarea, button')?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.classList.remove('no-scroll');
    };
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={'modal' + (wide ? ' modal-wide' : '')} role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <header className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Zamknij">
            <Icon name="x" />
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}

/** Ładowanie danych z obsługą błędu i ponowienia. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<{ data?: T; error?: Error; loading: boolean }>({ loading: true });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true, error: undefined }));
    fn().then(
      (data) => alive && setState({ data, loading: false }),
      (error) => alive && setState({ error, loading: false }),
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, reload, setData: (data: T) => setState({ data, loading: false }) };
}

// ---------------------------------------------------------------------------
// Powiadomienia
// ---------------------------------------------------------------------------

type Toast = { id: number; text: string; kind: 'ok' | 'error' };
const ToastCtx = createContext<(text: string, kind?: Toast['kind']) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, kind: Toast['kind'] = 'ok') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={'toast toast-' + t.kind}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
