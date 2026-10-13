/**
 * Minimalny klient protokołu PostgreSQL (v3) — używany WYŁĄCZNIE do testów
 * i pracy lokalnej, gdy pakiet `pg` nie jest zainstalowany (DB_DRIVER=wire).
 * Produkcja używa sprawdzonego pakietu `pg` (DB_DRIVER=pg, domyślnie).
 *
 * Obsługa: uwierzytelnianie SCRAM-SHA-256 / MD5 / trust, rozszerzony protokół
 * z parametrami (format tekstowy), zapytania wielopoleceniowe (migracje).
 * Typy wyników parsowane tak jak w `pg`: int8 i numeric → string, date → string.
 */
import net from 'node:net';
import crypto from 'node:crypto';
import type { PoolClientLike, PoolLike, QueryResult } from './types.ts';

export interface WireConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

export function parseDatabaseUrl(url: string): WireConfig {
  const u = new URL(url);
  return {
    host: u.hostname || '127.0.0.1',
    port: Number(u.port || 5432),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: decodeURIComponent(u.pathname.replace(/^\//, '')),
  };
}

export class PgError extends Error {
  code?: string;
  detail?: string;
  constraint?: string;
  table?: string;
  severity?: string;
  constructor(fields: Record<string, string>) {
    super(fields.M ?? 'PostgreSQL error');
    this.name = 'PgError';
    this.code = fields.C;
    this.detail = fields.D;
    this.constraint = fields.n;
    this.table = fields.t;
    this.severity = fields.S;
  }
}

interface Field {
  name: string;
  typeOid: number;
}

interface Pending {
  fields: Field[];
  rows: Record<string, unknown>[];
  rowCount: number;
  error?: PgError;
  resolve: (r: QueryResult<any>) => void;
  reject: (e: Error) => void;
}

export class WireClient implements PoolClientLike {
  private socket!: net.Socket;
  private buf: Buffer = Buffer.alloc(0);
  private queue: Promise<unknown> = Promise.resolve();
  private pending: Pending | null = null;
  private onAuth: ((type: number, payload: Buffer) => void) | null = null;
  private readyWaiter: { resolve: () => void; reject: (e: Error) => void } | null = null;
  private closed = false;
  releaseFn: (c: WireClient, err?: unknown) => void = () => {};

  constructor(private cfg: WireConfig) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.readyWaiter = { resolve, reject };
      this.socket = net.createConnection({ host: this.cfg.host, port: this.cfg.port });
      this.socket.on('data', (d: Buffer) => this.onData(d));
      this.socket.on('error', (e) => this.fail(e));
      this.socket.on('close', () => {
        this.closed = true;
        this.fail(new Error('Połączenie z bazą zamknięte'));
      });
      this.socket.setNoDelay(true); // bez opóźnień Nagle'a — małe komunikaty protokołu
      this.socket.on('connect', () => this.startup());
    });
  }

  private fail(e: Error) {
    if (this.readyWaiter) {
      this.readyWaiter.reject(e);
      this.readyWaiter = null;
    }
    if (this.pending) {
      this.pending.reject(e);
      this.pending = null;
    }
  }

  private startup() {
    const params = `user\0${this.cfg.user}\0database\0${this.cfg.database}\0client_encoding\0UTF8\0\0`;
    const body = Buffer.concat([int32(196608), Buffer.from(params, 'utf8')]);
    this.socket.write(Buffer.concat([int32(body.length + 4), body]));
    this.onAuth = (type, payload) => this.handleAuth(type, payload);
  }

  private scram: { nonce: string; bare: string; salted?: Buffer; authMessage?: string } | null = null;

  private handleAuth(code: number, payload: Buffer) {
    if (code === 0) return; // AuthenticationOk
    if (code === 3) return this.send('p', cstr(this.cfg.password));
    if (code === 5) {
      const salt = payload.subarray(0, 4);
      const inner = md5hex(this.cfg.password + this.cfg.user);
      const outer = 'md5' + md5hex(Buffer.concat([Buffer.from(inner), salt]));
      return this.send('p', cstr(outer));
    }
    if (code === 10) {
      const nonce = crypto.randomBytes(18).toString('base64');
      const bare = `n=,r=${nonce}`;
      this.scram = { nonce, bare };
      const first = Buffer.from(`n,,${bare}`, 'utf8');
      return this.send('p', Buffer.concat([cstr('SCRAM-SHA-256'), int32(first.length), first]));
    }
    if (code === 11 && this.scram) {
      const serverFirst = payload.toString('utf8');
      const attrs = Object.fromEntries(serverFirst.split(',').map((p) => [p[0], p.slice(2)]));
      if (!attrs.r?.startsWith(this.scram.nonce)) return this.fail(new Error('SCRAM: nieprawidłowy nonce'));
      const salted = crypto.pbkdf2Sync(this.cfg.password, Buffer.from(attrs.s, 'base64'), Number(attrs.i), 32, 'sha256');
      const clientKey = hmac(salted, 'Client Key');
      const storedKey = crypto.createHash('sha256').update(clientKey).digest();
      const finalNoProof = `c=biws,r=${attrs.r}`;
      const authMessage = `${this.scram.bare},${serverFirst},${finalNoProof}`;
      const sig = hmac(storedKey, authMessage);
      const proof = Buffer.alloc(clientKey.length);
      for (let i = 0; i < proof.length; i++) proof[i] = clientKey[i] ^ sig[i];
      this.scram.salted = salted;
      this.scram.authMessage = authMessage;
      return this.send('p', Buffer.from(`${finalNoProof},p=${proof.toString('base64')}`, 'utf8'));
    }
    if (code === 12 && this.scram?.salted) {
      const v = payload.toString('utf8').replace(/^v=/, '');
      const serverKey = hmac(this.scram.salted, 'Server Key');
      const expected = hmac(serverKey, this.scram.authMessage!).toString('base64');
      if (v !== expected) this.fail(new Error('SCRAM: nieprawidłowy podpis serwera'));
      return;
    }
    this.fail(new Error(`Nieobsługiwana metoda uwierzytelniania: ${code}`));
  }

  private send(type: string, body: Buffer) {
    this.socket.write(frame(type, body));
  }

  private onData(chunk: Buffer) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (this.buf.length >= 5) {
      const len = this.buf.readInt32BE(1);
      if (this.buf.length < len + 1) break;
      const type = String.fromCharCode(this.buf[0]);
      const body = this.buf.subarray(5, len + 1);
      this.buf = this.buf.subarray(len + 1);
      this.handleMessage(type, body);
    }
  }

  private handleMessage(type: string, body: Buffer) {
    const p = this.pending;
    switch (type) {
      case 'R':
        this.onAuth?.(body.readInt32BE(0), body.subarray(4));
        break;
      case 'Z':
        if (this.readyWaiter) {
          this.readyWaiter.resolve();
          this.readyWaiter = null;
        } else if (p) {
          this.pending = null;
          if (p.error) p.reject(p.error);
          else p.resolve({ rows: p.rows, rowCount: p.rowCount });
        }
        break;
      case 'T':
        if (p) {
          p.fields = parseRowDescription(body);
          p.rows = [];
        }
        break;
      case 'D':
        if (p) p.rows.push(parseDataRow(body, p.fields));
        break;
      case 'C':
        if (p) {
          const tag = body.toString('utf8', 0, body.length - 1);
          const n = Number(tag.split(' ').pop());
          p.rowCount = Number.isFinite(n) ? n : 0;
        }
        break;
      case 'E': {
        const err = new PgError(parseFields(body));
        if (this.readyWaiter) this.fail(err);
        else if (p && !p.error) p.error = err;
        break;
      }
      default:
        break; // S, K, N, 1, 2, n, I, s — ignorowane
    }
  }

  /** Zapytanie z parametrami ($1, $2…) — jedno polecenie SQL. */
  query<T = any>(text: string, params: unknown[] = []): Promise<QueryResult<T>> {
    if (params.length === 0 && /;\s*\S/.test(text)) return this.simpleQuery(text);
    return this.enqueue<T>(() => {
      const parse = Buffer.concat([cstr(''), cstr(text), int16(0)]);
      const bindParts: Buffer[] = [cstr(''), cstr(''), int16(0), int16(params.length)];
      for (const v of params) {
        const s = serialize(v);
        if (s === null) bindParts.push(int32(-1));
        else {
          const b = Buffer.from(s, 'utf8');
          bindParts.push(int32(b.length), b);
        }
      }
      bindParts.push(int16(0));
      // jeden zapis do gniazda zamiast pięciu
      this.socket.write(
        Buffer.concat([
          frame('P', parse),
          frame('B', Buffer.concat(bindParts)),
          frame('D', Buffer.concat([Buffer.from('P'), cstr('')])),
          frame('E', Buffer.concat([cstr(''), int32(0)])),
          frame('S', Buffer.alloc(0)),
        ]),
      );
    });
  }

  /** Protokół prosty: wiele poleceń (np. pliki migracji). Zwraca wynik ostatniego. */
  simpleQuery<T = any>(text: string): Promise<QueryResult<T>> {
    return this.enqueue<T>(() => this.send('Q', cstr(text)));
  }

  private enqueue<T>(write: () => void): Promise<QueryResult<T>> {
    const run = () =>
      new Promise<QueryResult<T>>((resolve, reject) => {
        if (this.closed) return reject(new Error('Połączenie z bazą zamknięte'));
        this.pending = { fields: [], rows: [], rowCount: 0, resolve, reject };
        write();
      });
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  release(err?: unknown) {
    this.releaseFn(this, err);
  }

  async end() {
    if (this.closed) return;
    this.send('X', Buffer.alloc(0));
    this.socket.end();
    this.closed = true;
  }

  get isClosed() {
    return this.closed;
  }
}

/** Prosta pula połączeń o interfejsie zgodnym z pg.Pool (connect/query/end). */
export class WirePool implements PoolLike {
  private idle: WireClient[] = [];
  private all = new Set<WireClient>();
  private waiters: Array<(c: WireClient) => void> = [];
  private cfg: WireConfig;

  constructor(opts: { connectionString: string; max?: number }) {
    this.cfg = parseDatabaseUrl(opts.connectionString);
    this.max = opts.max ?? 10;
  }
  private max: number;

  async connect(): Promise<WireClient> {
    const c = this.idle.pop();
    if (c && !c.isClosed) return c;
    if (this.all.size < this.max) {
      const client = new WireClient(this.cfg);
      client.releaseFn = (cl, err) => this.giveBack(cl, err);
      this.all.add(client);
      try {
        await client.connect();
      } catch (e) {
        this.all.delete(client);
        throw e;
      }
      return client;
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private giveBack(c: WireClient, err?: unknown) {
    if (err || c.isClosed) {
      this.all.delete(c);
      void c.end();
      if (this.waiters.length) this.connect().then(this.waiters.shift()!);
      return;
    }
    const w = this.waiters.shift();
    if (w) w(c);
    else this.idle.push(c);
  }

  async query<T = any>(text: string, params?: unknown[]): Promise<QueryResult<T>> {
    const c = await this.connect();
    try {
      const r = await c.query<T>(text, params);
      c.release();
      return r;
    } catch (e) {
      c.release();
      throw e;
    }
  }

  async end() {
    await Promise.all([...this.all].map((c) => c.end()));
    this.all.clear();
    this.idle = [];
  }
}

// --- kodowanie / dekodowanie -------------------------------------------------

function int32(n: number) {
  const b = Buffer.alloc(4);
  b.writeInt32BE(n);
  return b;
}
function frame(type: string, body: Buffer) {
  return Buffer.concat([Buffer.from(type), int32(body.length + 4), body]);
}
function int16(n: number) {
  const b = Buffer.alloc(2);
  b.writeInt16BE(n);
  return b;
}
function cstr(s: string) {
  return Buffer.from(s + '\0', 'utf8');
}
function md5hex(s: string | Buffer) {
  return crypto.createHash('md5').update(s).digest('hex');
}
function hmac(key: Buffer, data: string) {
  return crypto.createHmac('sha256', key).update(data).digest();
}

function parseFields(body: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < body.length && body[i] !== 0) {
    const code = String.fromCharCode(body[i]);
    const end = body.indexOf(0, i + 1);
    out[code] = body.toString('utf8', i + 1, end);
    i = end + 1;
  }
  return out;
}

function parseRowDescription(body: Buffer): Field[] {
  const n = body.readInt16BE(0);
  const fields: Field[] = [];
  let i = 2;
  for (let k = 0; k < n; k++) {
    const end = body.indexOf(0, i);
    const name = body.toString('utf8', i, end);
    i = end + 1;
    const typeOid = body.readInt32BE(i + 6);
    i += 18;
    fields.push({ name, typeOid });
  }
  return fields;
}

function parseDataRow(body: Buffer, fields: Field[]): Record<string, unknown> {
  const n = body.readInt16BE(0);
  const row: Record<string, unknown> = {};
  let i = 2;
  for (let k = 0; k < n; k++) {
    const len = body.readInt32BE(i);
    i += 4;
    const f = fields[k];
    if (len === -1) {
      row[f.name] = null;
      continue;
    }
    const text = body.toString('utf8', i, i + len);
    i += len;
    row[f.name] = parseValue(text, f.typeOid);
  }
  return row;
}

function parseValue(text: string, oid: number): unknown {
  switch (oid) {
    case 16:
      return text === 't';
    case 21:
    case 23:
    case 26:
    case 700:
    case 701:
      return Number(text);
    case 114:
    case 3802:
      return JSON.parse(text);
    case 1114:
      return new Date(text.replace(' ', 'T') + 'Z');
    case 1184:
      return new Date(text.replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00'));
    case 17:
      return Buffer.from(text.slice(2), 'hex');
    default:
      return text; // int8, numeric, date, uuid, text…
  }
}

function serialize(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return v ? 't' : 'f';
  if (typeof v === 'bigint' || typeof v === 'number') return String(v);
  if (v instanceof Date) return v.toISOString();
  if (Buffer.isBuffer(v)) return '\\x' + v.toString('hex');
  if (Array.isArray(v)) return '{' + v.map((x) => (x === null ? 'NULL' : '"' + String(x).replace(/(["\\])/g, '\\$1') + '"')).join(',') + '}';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
