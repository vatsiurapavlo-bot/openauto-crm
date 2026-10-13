import { useEffect, useState, type MouseEvent, type ReactNode } from 'react';

const listeners = new Set<() => void>();

export function navigate(to: string, replace = false) {
  if (to === location.pathname + location.search) return;
  if (replace) history.replaceState(null, '', to);
  else history.pushState(null, '', to);
  listeners.forEach((l) => l());
  window.scrollTo(0, 0);
}

window.addEventListener('popstate', () => listeners.forEach((l) => l()));

export function useLocation() {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
  return { path: location.pathname, search: new URLSearchParams(location.search) };
}

/** Aktualizuje parametry zapytania w adresie (filtry listy) bez nowego wpisu historii. */
export function setSearchParams(params: Record<string, string | undefined>) {
  const sp = new URLSearchParams(location.search);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === '') sp.delete(k);
    else sp.set(k, v);
  }
  const qs = sp.toString();
  navigate(location.pathname + (qs ? '?' + qs : ''), true);
}

export function Link(props: { to: string; className?: string; children: ReactNode; title?: string; onClick?: () => void }) {
  const click = (e: MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    props.onClick?.();
    navigate(props.to);
  };
  return (
    <a href={props.to} className={props.className} onClick={click} title={props.title}>
      {props.children}
    </a>
  );
}

export function matchPath(pattern: string, path: string): Record<string, string> | null {
  const keys: string[] = [];
  const re = new RegExp(
    '^' + pattern.replace(/\/:([a-zA-Z]+)/g, (_, k) => (keys.push(k), '/([^/]+)')) + '/?$',
  );
  const m = re.exec(path);
  if (!m) return null;
  return Object.fromEntries(keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
}
