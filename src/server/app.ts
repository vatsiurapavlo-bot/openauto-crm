import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { Database, PoolLike, Queryable } from './db/index.ts';
import { checkAppRoleIsRestricted } from './db/migrate.ts';
import type { Config } from './config.ts';
import {
  HttpError,
  type Request,
  Router,
  SECURITY_HEADERS,
  badRequest,
  parseCookies,
  readJson,
  sendJson,
  unauthorized,
} from './http/core.ts';
import {
  LoginRateLimiter,
  Semaphore,
  SESSION_COOKIE,
  type SessionInfo,
  authenticate,
  createSession,
  findSession,
  revokeSession,
} from './auth/sessions.ts';
import { type Ctx, loadPermissions } from './services/context.ts';
import * as cars from './services/cars.ts';
import * as admin from './services/admin.ts';
import * as costs from './services/costs.ts';
import * as kasa from './services/kasa.ts';
import * as voice from './services/voice.ts';
import { getDashboard } from './services/dashboard.ts';
import * as system from './services/system.ts';
import type { SystemDeps } from './services/system.ts';

type R = Request<Ctx>;

function buildRouter(cfg: Config, deps: SystemDeps, appPool: PoolLike) {
  const r = new Router<Ctx>();
  // Tryb produkcyjny: zmienna OPENAUTO_MODE=production albo zatwierdzenie Właściciela w CRM (po kontroli)
  let confirmedCache: { value: boolean; at: number } | null = null;
  const productionConfirmed = async (q: Queryable) => {
    if (confirmedCache && Date.now() - confirmedCache.at < 30_000) return confirmedCache.value;
    const value = !!(await system.launchConfirmation(q));
    confirmedCache = { value, at: Date.now() };
    return value;
  };
  const launchEnv = async (req: R): Promise<system.LaunchEnv> => ({
    secureRequest: cfg.trustProxy ? req.raw.headers['x-forwarded-proto'] === 'https' : (req.raw.socket as any).encrypted === true,
    secureCookies: cfg.secureCookies,
    environmentName: cfg.environmentName,
    isProduction: cfg.isProduction,
    dbRoleProblem: await checkAppRoleIsRestricted(appPool),
  });
  r.get('/api/auth/me', async (req) => ({
    ...admin.me(req.ctx),
    mode: cfg.mode === 'production' || (await productionConfirmed(req.ctx.q)) ? 'production' : 'test',
    environment: cfg.environmentName,
  }));
  r.get('/api/system/launch', async (req) => system.launchChecks(req.ctx, deps, await launchEnv(req)));
  r.post('/api/system/launch/confirm', async (req) => {
    const res = await system.confirmLaunch(req.ctx, deps, await launchEnv(req), req.body);
    confirmedCache = null;
    return res;
  });
  r.post('/api/auth/password', async (req) => {
    await admin.changeOwnPassword(req.ctx, req.body);
    return { ok: true };
  });
  r.post('/api/auth/email', async (req) => admin.changeOwnEmail(req.ctx, req.body));
  r.get('/api/meta', async (req) => ({
    ...(await admin.getMeta(req.ctx)),
    voiceEnabled: !!deps.anthropic && req.ctx.perms.has('costs.edit'),
  }));
  r.get('/api/dashboard', async (req) => getDashboard(req.ctx));

  r.get('/api/cars', async (req) => {
    const q = req.query;
    const num = (k: string) => (q.get(k) && /^\d{1,6}$/.test(q.get(k)!) ? Number(q.get(k)) : undefined);
    const view = q.get('view');
    return cars.listCars(req.ctx, {
      view: view === 'rozliczone' || view === 'all' ? view : 'active',
      status: q.get('status') ?? undefined,
      salesStatus: q.get('sales') ?? undefined,
      q: q.get('q') ?? undefined,
      marka: q.get('marka') ?? undefined,
      rokOd: num('rokOd'),
      rokDo: num('rokDo'),
      kraj: q.get('kraj') ?? undefined,
      paliwo: q.get('paliwo') ?? undefined,
      sort: q.get('sort') ?? undefined,
      dir: q.get('dir') === 'asc' ? 'asc' : 'desc',
      limit: num('limit'),
      offset: num('offset'),
    });
  });
  r.post('/api/cars', async (req) => cars.createCar(req.ctx, req.body));
  r.get('/api/cars/:id', async (req) => cars.getCar(req.ctx, req.params.id));
  r.patch('/api/cars/:id', async (req) => cars.updateCar(req.ctx, req.params.id, req.body));
  r.post('/api/cars/:id/status', async (req) => ({ car: await cars.changeStatus(req.ctx, req.params.id, req.body) }));
  r.post('/api/cars/:id/archive', async (req) => {
    const v = (req.body as any)?.version;
    if (typeof v !== 'number') throw badRequest('Brak wersji');
    await cars.archiveCar(req.ctx, req.params.id, v);
    return { ok: true };
  });
  r.get('/api/cars/:id/history', async (req) => cars.carHistory(req.ctx, req.params.id));

  const qNum = (v: string | null) => (v && /^\d{1,7}$/.test(v) ? Number(v) : undefined);
  r.get('/api/costs', async (req) => {
    const q = req.query;
    const status = q.get('status');
    return costs.listCosts(req.ctx, {
      od: q.get('od') ?? undefined,
      do: q.get('do') ?? undefined,
      carId: q.get('car') ?? undefined,
      zakres: q.get('zakres') === 'firma' ? 'firma' : undefined,
      categoryId: q.get('kategoria') ?? undefined,
      sposob: q.get('sposob') ?? undefined,
      q: q.get('q') ?? undefined,
      status: status === 'cancelled' || status === 'all' ? status : 'active',
      limit: qNum(q.get('limit')),
      offset: qNum(q.get('offset')),
    });
  });
  r.post('/api/costs', async (req) => costs.createCost(req.ctx, req.body));
  r.post('/api/costs/parse', async (req) => voice.parseCostText(req.ctx, deps.anthropic ?? null, req.body));
  r.get('/api/costs/:id', async (req) => costs.getCost(req.ctx, req.params.id));
  r.patch('/api/costs/:id', async (req) => costs.updateCost(req.ctx, req.params.id, req.body));
  r.post('/api/costs/:id/cancel', async (req) => costs.cancelCost(req.ctx, req.params.id, req.body));

  r.get('/api/kasa', async (req) =>
    kasa.getKasa(req.ctx, {
      od: req.query.get('od') ?? undefined,
      do: req.query.get('do') ?? undefined,
      limit: qNum(req.query.get('limit')),
      offset: qNum(req.query.get('offset')),
    }),
  );
  r.post('/api/kasa', async (req) => kasa.addKasaOperation(req.ctx, req.body));
  r.post('/api/kasa/saldo-poczatkowe', async (req) => kasa.setInitialBalance(req.ctx, req.body));

  r.get('/api/users', async (req) => admin.listUsers(req.ctx));
  r.post('/api/users', async (req) => admin.createUser(req.ctx, req.body));
  r.get('/api/audit', async (req) =>
    admin.listAudit(req.ctx, {
      entity: req.query.get('entity') ?? undefined,
      entityId: req.query.get('entityId') ?? undefined,
    }),
  );
  r.get('/api/system/backup', async (req) => system.backupStatus(req.ctx, deps));
  r.post('/api/system/backup/run', async (req) => system.runBackupNow(req.ctx, deps));
  r.post('/api/integrations/google/connect', async (req) => system.googleConnectUrl(req.ctx, deps));
  r.post('/api/integrations/google/disconnect', async (req) => system.googleDisconnect(req.ctx, deps));
  return r;
}

/**
 * Adres klienta. Za proxy Railway używamy X-Real-IP — Railway nadpisuje ten nagłówek na brzegu sieci,
 * więc klient nie może go podrobić (w przeciwieństwie do pierwszego wpisu X-Forwarded-For).
 */
function clientIp(req: IncomingMessage, trustProxy: boolean) {
  if (trustProxy) {
    const real = req.headers['x-real-ip'];
    if (typeof real === 'string' && real) return real.trim();
    const fwd = req.headers['x-forwarded-for'];
    if (typeof fwd === 'string') return fwd.split(',').pop()!.trim();
  }
  return req.socket.remoteAddress ?? '';
}

function sessionCookie(token: string, cfg: Config, maxAgeSec: number) {
  return [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSec}`,
    cfg.secureCookies ? 'Secure' : '',
  ]
    .filter(Boolean)
    .join('; ');
}

export function createApp(db: Database, cfg: Config, deps: SystemDeps = { backup: null, google: null, adminPool: null }) {
  const router = buildRouter(cfg, deps, db.pool);
  const limiter = new LoginRateLimiter();
  const passwordChecks = new Semaphore(4);
  const errorTimes: number[] = [];
  const trustProxy = cfg.trustProxy;

  async function logAuth(ws: string | null, user: string | null, action: string, details: object) {
    await db
      .system()
      .query('SELECT app_log_auth_event($1, $2, $3, $4)', [ws, user, action, details])
      .catch((e) => console.error('Nie udało się zapisać zdarzenia logowania', e));
  }

  async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL) {
    const method = req.method ?? 'GET';
    const mutating = method !== 'GET' && method !== 'HEAD';
    // Ochrona CSRF: przeglądarka nie wyśle własnego nagłówka z obcej strony bez CORS
    if (mutating && req.headers['x-requested-with'] !== 'openauto') {
      throw new HttpError(403, 'Brak nagłówka żądania aplikacji', 'csrf');
    }
    const ip = clientIp(req, trustProxy);
    const body = mutating ? await readJson(req) : undefined;

    if (url.pathname === '/api/health' && method === 'GET') {
      await db.system().query('SELECT 1');
      return sendJson(res, 200, { ok: true });
    }

    if (url.pathname === '/api/auth/login' && method === 'POST') {
      const { email, password, workspace } = (body ?? {}) as Record<string, unknown>;
      if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
        throw badRequest('Podaj e-mail i hasło');
      }
      if (email.length > 200 || password.length > 200) throw badRequest('Nieprawidłowe dane logowania');
      if (!limiter.tryAttempt(ip, email)) throw new HttpError(429, 'Zbyt wiele nieudanych prób. Spróbuj za 15 minut.');
      if (!passwordChecks.tryAcquire()) throw new HttpError(429, 'Serwer jest zajęty — spróbuj za chwilę.');
      let result: Awaited<ReturnType<typeof authenticate>>;
      try {
        result = await authenticate(db.system(), email, password, typeof workspace === 'string' ? workspace : undefined);
      } finally {
        passwordChecks.release();
      }
      if (!result) {
        await logAuth(null, null, 'LOGIN_FAILED', { email: email.toLowerCase().slice(0, 200), ip });
        throw new HttpError(401, 'Nieprawidłowy e-mail lub hasło', 'invalid_credentials');
      }
      limiter.success(ip, email);
      const token = await createSession(db.system(), result.userId, result.workspaceId, cfg.sessionTtlHours, {
        ip,
        userAgent: req.headers['user-agent'],
      });
      await logAuth(result.workspaceId, result.userId, 'LOGIN', { ip });
      res.setHeader('Set-Cookie', sessionCookie(token, cfg, cfg.sessionTtlHours * 3600));
      return sendJson(res, 200, { ok: true });
    }

    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];

    if (url.pathname === '/api/auth/logout' && method === 'POST') {
      if (token) await revokeSession(db.system(), token);
      res.setHeader('Set-Cookie', sessionCookie('', cfg, 0));
      return sendJson(res, 200, { ok: true });
    }

    // Powrót z Google (zwykła nawigacja przeglądarki, ciasteczko SameSite=Lax jest wysyłane)
    if (url.pathname === '/api/integrations/google/callback' && method === 'GET') {
      const session = token ? await findSession(db.system(), token, cfg.sessionTtlHours) : null;
      const perms = session
        ? await db.tx({ workspaceId: session.workspaceId, userId: session.userId }, (q) => loadPermissions(q))
        : new Set<string>();
      const to = await system.googleCallback(session, url.searchParams, deps, perms);
      res.writeHead(302, { Location: to, 'Cache-Control': 'no-store' });
      return res.end();
    }

    const match = router.match(method, url.pathname);
    if (match === null) throw new HttpError(404, 'Nie ma takiego zasobu API');
    if (match === 'method') throw new HttpError(405, 'Metoda niedozwolona');

    const session: SessionInfo | null = token ? await findSession(db.system(), token, cfg.sessionTtlHours) : null;
    if (!session) throw unauthorized();
    (res as any).__session = session;
    // Hasło tymczasowe: do czasu zmiany dostępne są tylko dane konta i zmiana hasła
    const allowedWithTempPassword = ['GET /api/auth/me', 'GET /api/meta', 'POST /api/auth/password'];
    if (session.mustChangePassword && !allowedWithTempPassword.includes(`${method} ${url.pathname}`)) {
      throw new HttpError(403, 'Najpierw ustaw własne hasło', 'password_change_required');
    }

    const result = await db.tx({ workspaceId: session.workspaceId, userId: session.userId }, async (q) => {
      const ctx: Ctx = { q, session, perms: await loadPermissions(q) };
      const r: R = {
        raw: req,
        res,
        method,
        path: url.pathname,
        params: match.params,
        query: url.searchParams,
        body,
        ip,
        ctx,
      };
      return match.handler(r);
    });
    return sendJson(res, 200, result ?? { ok: true });
  }

  function mapError(e: any): HttpError {
    if (e instanceof HttpError) return e;
    if (e?.code === '42501') return new HttpError(403, 'Brak uprawnień', 'forbidden');
    if (e?.code === '23505') return new HttpError(409, 'Taki wpis już istnieje', 'duplicate');
    if (e?.code === '23514' || e?.code === '23503' || e?.code === '23502' || String(e?.code).startsWith('22')) {
      // własne komunikaty z bazy (po polsku) przekazujemy; techniczne komunikaty PostgreSQL — nie
      const technical = /violates|relation|constraint|syntax|column|out of range|too long|invalid input/i.test(String(e.message));
      return new HttpError(400, technical ? 'Nieprawidłowe dane' : e.message, 'invalid');
    }
    return new HttpError(500, 'Wewnętrzny błąd serwera. Zdarzenie zostało zapisane w dzienniku błędów.', 'internal');
  }

  async function logError(req: IncomingMessage, res: ServerResponse, e: any) {
    const s: SessionInfo | undefined = (res as any).__session;
    console.error(`[${new Date().toISOString()}] ${req.method} ${req.url}`, e);
    // ochrona przed zalaniem bazy: najwyżej 20 wpisów na minutę (reszta tylko w logach serwera)
    const now = Date.now();
    while (errorTimes.length && now - errorTimes[0] > 60_000) errorTimes.shift();
    if (errorTimes.length >= 20) return;
    errorTimes.push(now);
    await db
      .system()
      .query('INSERT INTO error_log (workspace_id, user_id, method, path, message, stack) VALUES ($1, $2, $3, $4, $5, $6)', [
        s?.workspaceId ?? null,
        s?.userId ?? null,
        req.method,
        (req.url ?? '').slice(0, 500),
        String(e?.message ?? e).slice(0, 2000),
        String(e?.stack ?? '').slice(0, 8000),
      ])
      .catch(() => {});
  }

  const staticRoot = path.resolve(cfg.publicDir);
  const TYPES: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json',
    '.webmanifest': 'application/manifest+json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
  };

  function serveStatic(res: ServerResponse, pathname: string) {
    let rel: string;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      res.writeHead(400);
      return res.end();
    }
    let file = path.resolve(staticRoot, '.' + rel);
    if (!file.startsWith(staticRoot + path.sep) && file !== staticRoot) {
      res.writeHead(400);
      return res.end();
    }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      if (path.extname(rel)) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Nie znaleziono');
      }
      rel = '/index.html'; // SPA
      file = path.join(staticRoot, 'index.html');
    }
    const ext = path.extname(file);
    const immutable = /\/assets\//.test(rel);
    res.writeHead(200, {
      'Content-Type': TYPES[ext] ?? 'application/octet-stream',
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    fs.createReadStream(file).pipe(res);
  }

  return async function handler(req: IncomingMessage, res: ServerResponse) {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    if (cfg.secureCookies) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
      else serveStatic(res, url.pathname);
    } catch (e) {
      const err = mapError(e);
      if (err.status >= 500) await logError(req, res, e);
      if (!res.headersSent) {
        sendJson(res, err.status, { error: { message: err.message, code: err.code, details: err.details } });
      } else res.end();
    }
  };
}
