import type { Queryable } from '../db/index.ts';
import type { SessionInfo } from '../auth/sessions.ts';
import { forbidden } from '../http/core.ts';

/** Kontekst jednego żądania: transakcja z ustawionym RLS + sesja + uprawnienia z bazy. */
export interface Ctx {
  q: Queryable;
  session: SessionInfo;
  perms: Set<string>;
}

export function can(ctx: Ctx, perm: string) {
  return ctx.perms.has(perm);
}

export function requirePerm(ctx: Ctx, ...perms: string[]) {
  for (const p of perms) if (!ctx.perms.has(p)) throw forbidden(`Brak uprawnienia: ${p}`);
}

export async function loadPermissions(q: Queryable): Promise<Set<string>> {
  const { rows } = await q.query<{ permission: string }>(
    'SELECT permission FROM role_permissions WHERE workspace_id = app_workspace() AND role_code = app_role()',
  );
  return new Set(rows.map((r) => r.permission));
}
