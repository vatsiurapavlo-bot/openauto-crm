import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../src/server/app.ts';
import type { Config } from '../../src/server/config.ts';
import type { Database } from '../../src/server/db/index.ts';
import type { SystemDeps } from '../../src/server/services/system.ts';

export function testConfig(over: Partial<Config> = {}): Config {
  return {
    port: 0,
    host: '127.0.0.1',
    databaseUrl: '',
    dbDriver: 'wire',
    publicDir: 'dist/public',
    secureCookies: false,
    sessionTtlHours: 12,
    isProduction: false,
    allowInsecureDbRole: false,
    publicUrl: null,
    trustProxy: false,
    mode: 'test',
    environmentName: null,
    ...over,
  };
}

export async function startServer(db: Database, publicDir = 'dist/public', deps?: SystemDeps, over: Partial<Config> = {}) {
  const cfg = testConfig({ publicDir, ...over });
  const server = http.createServer(createApp(db, cfg, deps));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/** Klient API z ciasteczkiem sesji — jak przeglądarka jednego użytkownika. */
export class ApiClient {
  cookie = '';
  constructor(readonly base: string) {}

  async req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(this.base + path, {
      method,
      redirect: 'manual',
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(method !== 'GET' ? { 'X-Requested-With': 'openauto' } : {}),
        ...(this.cookie ? { Cookie: this.cookie } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];
    const text = await res.text();
    let parsed: any = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed, location: res.headers.get('location') };
  }
  get = (p: string) => this.req('GET', p);
  post = (p: string, b?: unknown) => this.req('POST', p, b ?? {});
  patch = (p: string, b: unknown) => this.req('PATCH', p, b);

  async login(email: string, password: string) {
    const r = await this.post('/api/auth/login', { email, password });
    if (r.status !== 200) throw new Error(`Logowanie nieudane: ${r.status} ${JSON.stringify(r.body)}`);
    return this;
  }
}
