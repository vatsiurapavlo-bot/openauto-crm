import type { IncomingMessage, ServerResponse } from 'node:http';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (msg: string, details?: unknown) => new HttpError(400, msg, 'bad_request', details);
export const unauthorized = () => new HttpError(401, 'Wymagane zalogowanie', 'unauthorized');
export const forbidden = (msg = 'Brak uprawnień') => new HttpError(403, msg, 'forbidden');
export const notFound = (msg = 'Nie znaleziono') => new HttpError(404, msg, 'not_found');
export const conflict = (msg: string, code = 'conflict') => new HttpError(409, msg, code);

export type Handler<C> = (req: Request<C>) => Promise<unknown>;

export interface Request<C> {
  raw: IncomingMessage;
  res: ServerResponse;
  method: string;
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  ip: string;
  ctx: C;
}

interface Route<C> {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler<C>;
}

export class Router<C> {
  private routes: Route<C>[] = [];

  add(method: string, path: string, handler: Handler<C>) {
    const keys: string[] = [];
    const pattern = new RegExp(
      '^' +
        path.replace(/\/:([a-zA-Z_]+)/g, (_, k) => {
          keys.push(k);
          return '/([^/]+)';
        }) +
        '$',
    );
    this.routes.push({ method, pattern, keys, handler });
  }
  get(p: string, h: Handler<C>) {
    this.add('GET', p, h);
  }
  post(p: string, h: Handler<C>) {
    this.add('POST', p, h);
  }
  patch(p: string, h: Handler<C>) {
    this.add('PATCH', p, h);
  }

  match(method: string, path: string): { handler: Handler<C>; params: Record<string, string> } | 'method' | null {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.pattern.exec(path);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      const params: Record<string, string> = {};
      try {
        r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      } catch {
        throw badRequest('Nieprawidłowy adres');
      }
      return { handler: r.handler, params };
    }
    return pathMatched ? 'method' : null;
  }
}

export async function readJson(req: IncomingMessage, limit = 1_000_000): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, 'Zbyt duże żądanie');
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return undefined;
  const ct = req.headers['content-type'] ?? '';
  if (!ct.includes('application/json')) throw new HttpError(415, 'Oczekiwano application/json');
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw badRequest('Nieprawidłowy JSON');
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const raw = part.slice(i + 1).trim();
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(raw);
    } catch {
      out[part.slice(0, i).trim()] = raw;
    }
  }
  return out;
}

export function sendJson(res: ServerResponse, status: number, data: unknown) {
  const body = JSON.stringify(data, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

export const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(self), geolocation=()',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data: blob: https:; style-src 'self' 'unsafe-inline'; " +
    "font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};
