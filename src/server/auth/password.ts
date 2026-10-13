import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt) as (
  pw: string,
  salt: Buffer,
  keylen: number,
  opts: crypto.ScryptOptions,
) => Promise<Buffer>;

// N=2^15, r=8, p=1 — zalecenia OWASP dla scrypt
const PARAMS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEYLEN = 32;

export const MIN_PASSWORD_LENGTH = 10;

export function validatePasswordStrength(pw: string): string | null {
  if (pw.length < MIN_PASSWORD_LENGTH) return `Hasło musi mieć co najmniej ${MIN_PASSWORD_LENGTH} znaków`;
  if (!/[a-zA-Ząćęłńóśźż]/.test(pw) || !/\d/.test(pw)) return 'Hasło musi zawierać litery i cyfry';
  return null;
}

/** Format: scrypt$N$r$p$salt(b64)$hash(b64) */
export async function hashPassword(pw: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(pw.normalize('NFKC'), salt, KEYLEN, PARAMS);
  return ['scrypt', PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

export async function verifyPassword(pw: string, stored: string | null): Promise<boolean> {
  if (!stored) {
    // stały czas także dla nieistniejących kont
    await scrypt(pw, crypto.randomBytes(16), KEYLEN, PARAMS);
    return false;
  }
  const [alg, N, r, p, salt, hash] = stored.split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scrypt(pw.normalize('NFKC'), Buffer.from(salt, 'base64'), expected.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
    maxmem: PARAMS.maxmem,
  });
  return crypto.timingSafeEqual(actual, expected);
}
