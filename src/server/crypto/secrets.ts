/**
 * Szyfrowanie danych poufnych kluczem głównym OPENAUTO_MASTER_KEY.
 *
 * Z jednego klucza wyprowadzane są (HKDF-SHA256) osobne klucze do różnych celów:
 *  - 'backup'      — pliki kopii zapasowych na Google Drive,
 *  - 'token'       — token odświeżania Google zapisany w bazie,
 *  - 'oauth-state' — podpis parametru state przy łączeniu z Google.
 *
 * Format zaszyfrowanych danych: "OAENC1" | iv (12 B) | szyfrogram | tag GCM (16 B).
 * Klucz NIE jest przechowywany w bazie ani na Dysku — właściciel musi go zachować osobno,
 * inaczej kopii z Dysku nie da się odszyfrować.
 */
import crypto from 'node:crypto';

const MAGIC = Buffer.from('OAENC1');
export const MIN_MASTER_KEY_LENGTH = 32;

export type KeyPurpose = 'backup' | 'token' | 'oauth-state';

export class MasterKeyError extends Error {}

export function masterKeyStatus(raw = process.env.OPENAUTO_MASTER_KEY): 'ok' | 'missing' | 'too_short' {
  if (!raw) return 'missing';
  // co najmniej 32 znaki i nie „aaaa…”/„1234…” — klucz ma być losowy (np. openssl rand -base64 32)
  return raw.length < MIN_MASTER_KEY_LENGTH || new Set(raw).size < 12 ? 'too_short' : 'ok';
}

export function deriveKey(purpose: KeyPurpose, raw = process.env.OPENAUTO_MASTER_KEY): Buffer {
  const status = masterKeyStatus(raw);
  if (status === 'missing') throw new MasterKeyError('Brak klucza OPENAUTO_MASTER_KEY');
  if (status === 'too_short') {
    throw new MasterKeyError(`OPENAUTO_MASTER_KEY musi mieć co najmniej ${MIN_MASTER_KEY_LENGTH} losowych znaków`);
  }
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(raw!, 'utf8'), Buffer.from('openauto-crm'), Buffer.from(purpose), 32));
}

export function encrypt(plain: Buffer, purpose: KeyPurpose, raw?: string): Buffer {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(purpose, raw), iv);
  cipher.setAAD(Buffer.from(purpose));
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, iv, body, cipher.getAuthTag()]);
}

export function decrypt(data: Buffer, purpose: KeyPurpose, raw?: string): Buffer {
  if (data.length < MAGIC.length + 12 + 16 || !data.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new MasterKeyError('To nie jest plik zaszyfrowany przez OpenAuto CRM');
  }
  const iv = data.subarray(MAGIC.length, MAGIC.length + 12);
  const tag = data.subarray(data.length - 16);
  const body = data.subarray(MAGIC.length + 12, data.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(purpose, raw), iv);
  decipher.setAAD(Buffer.from(purpose));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    throw new MasterKeyError('Nie można odszyfrować — nieprawidłowy klucz lub uszkodzony plik');
  }
}

/** Podpisany, krótkotrwały parametr state dla OAuth (ochrona przed CSRF). */
export function signState(payload: Record<string, unknown>, ttlSeconds = 600): string {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds })).toString('base64url');
  const sig = crypto.createHmac('sha256', deriveKey('oauth-state')).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyState<T = Record<string, unknown>>(state: string): T | null {
  const [body, sig] = state.split('.');
  if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', deriveKey('oauth-state')).update(body).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  if (typeof data.exp !== 'number' || data.exp < Date.now() / 1000) return null;
  return data as T;
}
