import crypto from 'node:crypto';
import type { Queryable } from '../db/index.ts';
import { verifyPassword } from './password.ts';

export interface SessionInfo {
  sessionId: string;
  userId: string;
  email: string;
  fullName: string;
  workspaceId: string;
  workspaceCode: string;
  workspaceName: string;
  role: string;
  /** Hasło tymczasowe — dostęp tylko do zmiany hasła */
  mustChangePassword: boolean;
}

export const SESSION_COOKIE = 'oa_session';

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest();

export async function createSession(
  q: Queryable,
  userId: string,
  workspaceId: string,
  ttlHours: number,
  meta: { ip?: string; userAgent?: string },
): Promise<string> {
  const token = crypto.randomBytes(32).toString('base64url');
  await q.query(
    `INSERT INTO sessions (token_hash, user_id, workspace_id, expires_at, ip, user_agent)
     VALUES ($1, $2, $3, now() + make_interval(hours => $4::int), $5, $6)`,
    [sha256(token), userId, workspaceId, ttlHours, meta.ip ?? null, meta.userAgent?.slice(0, 300) ?? null],
  );
  return token;
}

/** Zwraca sesję tylko gdy: nieodwołana, nie wygasła, użytkownik aktywny i nadal członek przestrzeni. */
export async function findSession(q: Queryable, token: string, ttlHours: number): Promise<SessionInfo | null> {
  if (!token || token.length > 100) return null;
  const { rows } = await q.query<SessionInfo & { expires_soon: boolean }>(
    `SELECT session_id AS "sessionId", user_id AS "userId", email, full_name AS "fullName",
            workspace_id AS "workspaceId", workspace_code AS "workspaceCode", workspace_name AS "workspaceName",
            role_code AS role, must_change_password AS "mustChangePassword", expires_at < now() + make_interval(hours => $2::int) / 2 AS expires_soon
     FROM auth_find_session($1)`,
    [sha256(token), ttlHours],
  );
  const row = rows[0];
  if (!row) return null;
  // sesja przesuwna: przedłużamy, gdy minęła połowa czasu
  await q.query(
    `UPDATE sessions SET last_seen_at = now(),
       expires_at = CASE WHEN $2 THEN now() + make_interval(hours => $3::int) ELSE expires_at END
     WHERE id = $1`,
    [row.sessionId, row.expires_soon, ttlHours],
  );
  const { expires_soon: _, ...info } = row;
  return info;
}

export async function revokeSession(q: Queryable, token: string) {
  await q.query('UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL', [sha256(token)]);
}

export async function revokeAllUserSessions(q: Queryable, userId: string, exceptSessionId?: string) {
  await q.query(
    'UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL AND id IS DISTINCT FROM $2',
    [userId, exceptSessionId ?? null],
  );
}

export interface LoginResult {
  userId: string;
  workspaceId: string;
}

/** Weryfikuje e-mail i hasło; wybiera przestrzeń (domyślnie pierwszą aktywną). */
export async function authenticate(
  q: Queryable,
  email: string,
  password: string,
  workspaceCode?: string,
): Promise<LoginResult | null> {
  const { rows } = await q.query<{ id: string; password_hash: string | null; is_active: boolean }>(
    'SELECT id, password_hash, is_active FROM users WHERE email = $1',
    [email.trim().toLowerCase()],
  );
  const user = rows[0];
  const ok = await verifyPassword(password, user?.password_hash ?? null);
  if (!user || !ok || !user.is_active) return null;
  const ws = await q.query<{ id: string | null }>('SELECT auth_member_workspace($1, $2) AS id', [user.id, workspaceCode ?? null]);
  if (!ws.rows[0]?.id) return null;
  await q.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
  return { userId: user.id, workspaceId: ws.rows[0].id };
}

/**
 * Ochrona przed zgadywaniem haseł (okno 15 min):
 *  - 10 nieudanych prób dla pary IP + e-mail,
 *  - 50 prób z jednego adresu IP (kilku pracowników może mieć wspólny adres biura),
 *  - 200 prób dla jednego e-maila z dowolnych adresów (atak rozproszony; nie blokuje właściciela
 *    z jego własnego adresu przy pojedynczych próbach obcych).
 * Próba jest rejestrowana PRZED sprawdzeniem hasła — równoległe żądania nie omijają limitu.
 */
export class LoginRateLimiter {
  private hits = new Map<string, number[]>();
  constructor(
    private limits = { pair: 10, ip: 50, email: 200 },
    private windowMs = 15 * 60 * 1000,
  ) {}

  private recent(key: string, now: number) {
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (list.length) this.hits.set(key, list);
    else this.hits.delete(key);
    return list;
  }

  private keys(ip: string, email: string) {
    const e = email.toLowerCase();
    return [
      { key: `pair:${ip}|${e}`, max: this.limits.pair },
      { key: `ip:${ip}`, max: this.limits.ip },
      { key: `email:${e}`, max: this.limits.email },
    ];
  }

  /** Rezerwuje próbę. Zwraca false, jeśli limit przekroczony (wtedy próby nie rejestruje). */
  tryAttempt(ip: string, email: string, now = Date.now()): boolean {
    const keys = this.keys(ip, email);
    if (keys.some((k) => this.recent(k.key, now).length >= k.max)) return false;
    for (const k of keys) this.hits.set(k.key, [...this.recent(k.key, now), now]);
    if (this.hits.size > 20_000) for (const key of [...this.hits.keys()]) this.recent(key, now); // sprzątanie
    return true;
  }

  /** Po udanym logowaniu: zwalnia zarezerwowaną próbę i zeruje licznik pary IP + e-mail. */
  success(ip: string, email: string) {
    const [pair, ...rest] = this.keys(ip, email);
    this.hits.delete(pair.key);
    for (const k of rest) {
      const list = this.hits.get(k.key);
      list?.pop();
      if (list && !list.length) this.hits.delete(k.key);
    }
  }
}

/** Ogranicza liczbę równoczesnych sprawdzeń hasła (scrypt jest celowo kosztowny). */
export class Semaphore {
  private active = 0;
  constructor(private max: number) {}
  tryAcquire() {
    if (this.active >= this.max) return false;
    this.active++;
    return true;
  }
  release() {
    this.active = Math.max(0, this.active - 1);
  }
}
