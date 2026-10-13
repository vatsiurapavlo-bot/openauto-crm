import { createContext, useContext } from 'react';
import type { CarStatus, Me, Meta } from '../shared/types.ts';

export interface AppState {
  me: Me;
  meta: Meta;
  can: (perm: string) => boolean;
  status: (id: string | null | undefined) => CarStatus | undefined;
  statusByCode: (kind: CarStatus['kind'], code: string) => CarStatus | undefined;
  reloadMeta: () => Promise<void>;
  logout: () => Promise<void>;
}

export const AppContext = createContext<AppState | null>(null);

export function useApp(): AppState {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('AppContext missing');
  return ctx;
}

export function buildState(me: Me, meta: Meta, reloadMeta: () => Promise<void>, logout: () => Promise<void>): AppState {
  const perms = new Set(me.permissions);
  const byId = new Map(meta.statuses.map((s) => [s.id, s]));
  return {
    me,
    meta,
    can: (p) => perms.has(p),
    status: (id) => (id ? byId.get(id) : undefined),
    statusByCode: (kind, code) => meta.statuses.find((s) => s.kind === kind && s.systemCode === code),
    reloadMeta,
    logout,
  };
}
