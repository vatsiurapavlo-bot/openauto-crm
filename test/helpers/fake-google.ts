/**
 * Atrapa Google OAuth + Drive API do testów (lokalny serwer HTTP).
 * Odwzorowuje tylko punkty końcowe używane przez src/server/integrations/google/drive.ts.
 * Nie zastępuje testu z prawdziwym Google — ten wykonuje się przy pierwszym połączeniu na Railway.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeFile {
  id: string;
  name: string;
  parent: string | null;
  mimeType: string;
  data?: Buffer;
  createdTime: string;
}

export async function startFakeGoogle() {
  const files = new Map<string, FakeFile>();
  const sessions = new Map<string, { name: string; parent: string; mimeType: string }>();
  let seq = 0;
  let clock = Date.parse('2026-10-01T00:00:00Z');
  const revoked: string[] = [];
  const idToken = ['x', Buffer.from(JSON.stringify({ email: 'crm@example.com' })).toString('base64url'), 'sig'].join('.');

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://x');
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    const json = (status: number, data: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      res.end(JSON.stringify(data));
    };
    const authed = () => req.headers.authorization === 'Bearer access-1';

    if (url.pathname === '/token' && req.method === 'POST') {
      const p = new URLSearchParams(body.toString());
      if (p.get('grant_type') === 'authorization_code') {
        if (p.get('code') !== 'good-code') return json(400, { error: 'invalid_grant', error_description: 'Bad code' });
        return json(200, {
          access_token: 'access-1',
          refresh_token: 'refresh-secret-1',
          expires_in: 3600,
          scope: 'https://www.googleapis.com/auth/drive.file openid https://www.googleapis.com/auth/userinfo.email',
          id_token: idToken,
        });
      }
      if (p.get('grant_type') === 'refresh_token' && p.get('refresh_token') === 'refresh-secret-1') {
        return json(200, { access_token: 'access-1', expires_in: 3600 });
      }
      return json(400, { error: 'invalid_grant' });
    }
    if (url.pathname === '/revoke') {
      revoked.push(new URLSearchParams(body.toString()).get('token') ?? '');
      return json(200, {});
    }
    // adres sesji uploadu sam w sobie jest poświadczeniem (jak w Google)
    const up = /^\/upload\/session\/(\w+)$/.exec(url.pathname);
    if (up && req.method === 'PUT') {
      const s = sessions.get(up[1]);
      if (!s) return json(404, { error: { message: 'no session' } });
      const id = `f${++seq}`;
      files.set(id, { id, name: s.name, parent: s.parent, mimeType: s.mimeType, data: body, createdTime: new Date((clock += 1000)).toISOString() });
      return json(200, { id });
    }
    if (!authed()) return json(401, { error: { message: 'unauthorized' } });

    if (url.pathname === '/drive/v3/files' && req.method === 'GET') {
      const q = url.searchParams.get('q') ?? '';
      const name = /name = '((?:[^'\\]|\\.)*)'/.exec(q)?.[1]?.replace(/\\(.)/g, '$1');
      const parent = /'([^']+)' in parents/.exec(q)?.[1];
      const list = [...files.values()]
        .filter((f) => (name === undefined || f.name === name) && (parent === 'root' ? f.parent === null : f.parent === parent))
        .filter((f) => !q.includes('mimeType') || f.mimeType === 'application/vnd.google-apps.folder')
        .sort((a, b) => b.createdTime.localeCompare(a.createdTime))
        .map((f) => ({ id: f.id, name: f.name, createdTime: f.createdTime, size: String(f.data?.length ?? 0) }));
      return json(200, { files: list });
    }
    if (url.pathname === '/drive/v3/files' && req.method === 'POST') {
      const meta = JSON.parse(body.toString());
      const id = `f${++seq}`;
      files.set(id, { id, name: meta.name, parent: meta.parents?.[0] ?? null, mimeType: meta.mimeType, createdTime: new Date((clock += 1000)).toISOString() });
      return json(200, { id });
    }
    if (url.pathname === '/upload/drive/v3/files' && req.method === 'POST') {
      const meta = JSON.parse(body.toString());
      const sid = `s${++seq}`;
      sessions.set(sid, { name: meta.name, parent: meta.parents[0], mimeType: String(req.headers['x-upload-content-type']) });
      res.writeHead(200, { Location: `${base}/upload/session/${sid}` });
      return res.end();
    }
    const one = /^\/drive\/v3\/files\/(\w+)$/.exec(url.pathname);
    if (one && req.method === 'GET' && url.searchParams.get('alt') === 'media') {
      const f = files.get(one[1]);
      if (!f?.data) return json(404, { error: { message: 'not found' } });
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      return res.end(f.data);
    }
    if (one && req.method === 'DELETE') {
      files.delete(one[1]);
      res.writeHead(204);
      return res.end();
    }
    json(404, { error: { message: `fake: ${req.method} ${url.pathname}` } });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    files,
    revoked,
    env: { GOOGLE_OAUTH_BASE: base, GOOGLE_AUTH_BASE: base, GOOGLE_API_BASE: base, GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'csecret' },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
