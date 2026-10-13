/**
 * Kwoty pieniężne jako liczba groszy w BigInt — bez błędów zmiennoprzecinkowych.
 * W bazie: NUMERIC(14,2); w API: string "1234.56".
 */

export type Cents = bigint;

const DECIMAL_RE = /^(-)?(\d+)(?:[.,](\d+))?$/;

/** Parsuje "1 234,56", "1234.56", "-15", 12.5 (number tylko z wejścia formularza). */
export function toCents(value: string | number | bigint): Cents {
  if (typeof value === 'bigint') return value * 100n;
  const raw = String(value).replace(/[\s ]/g, '').replace(/zł$/i, '');
  const m = DECIMAL_RE.exec(raw);
  if (!m) throw new MoneyError(`Nieprawidłowa kwota: "${value}"`);
  const [, sign, intPart, fracRaw = ''] = m;
  if (fracRaw.length > 2 && /[1-9]/.test(fracRaw.slice(2))) {
    throw new MoneyError(`Kwota może mieć najwyżej 2 miejsca po przecinku: "${value}"`);
  }
  const frac = (fracRaw + '00').slice(0, 2);
  const cents = BigInt(intPart) * 100n + BigInt(frac);
  return sign ? -cents : cents;
}

/** Wartość z bazy (NUMERIC jako string) lub null. */
export function fromDb(value: string | null | undefined): Cents | null {
  return value === null || value === undefined ? null : toCents(value);
}

/** Do bazy / API: "1234.56" */
export function toDecimalString(c: Cents): string {
  const neg = c < 0n;
  const abs = neg ? -c : c;
  const s = `${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`;
  return neg ? `-${s}` : s;
}

/** Format polski: "1 234,56 zł" (spacja twarda jako separator tysięcy). */
export function formatPLN(c: Cents | null, withCurrency = true): string {
  if (c === null) return '—';
  const neg = c < 0n;
  const abs = neg ? -c : c;
  const int = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const frac = (abs % 100n).toString().padStart(2, '0');
  return `${neg ? '−' : ''}${int},${frac}${withCurrency ? ' zł' : ''}`;
}

/** Ułamek dziesiętny ("0.23", "23/123") jako para BigInt. */
export function parseRatio(rate: string): [bigint, bigint] {
  const frac = /^(\d+)\/(\d+)$/.exec(rate.trim());
  if (frac) return [BigInt(frac[1]), BigInt(frac[2])];
  const m = /^(\d+)(?:\.(\d+))?$/.exec(rate.trim());
  if (!m) throw new MoneyError(`Nieprawidłowa stawka: "${rate}"`);
  const decimals = m[2] ?? '';
  return [BigInt(m[1] + decimals), 10n ** BigInt(decimals.length)];
}

/** Dzielenie z zaokrągleniem do najbliższego grosza, połówki od zera (ROUND_HALF_UP jak w PostgreSQL). */
export function divRound(num: bigint, den: bigint): bigint {
  if (den === 0n) throw new MoneyError('Dzielenie przez zero');
  const neg = (num < 0n) !== (den < 0n);
  const n = num < 0n ? -num : num;
  const d = den < 0n ? -den : den;
  const q = (2n * n + d) / (2n * d);
  return neg ? -q : q;
}

/** cents × num/den, zaokrąglone do grosza. */
export function mulRatio(c: Cents, num: bigint, den: bigint): Cents {
  return divRound(c * num, den);
}

export function sum(values: Array<Cents | null | undefined>): Cents {
  let s = 0n;
  for (const v of values) if (v !== null && v !== undefined) s += v;
  return s;
}

export const max = (a: Cents, b: Cents): Cents => (a > b ? a : b);

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}
