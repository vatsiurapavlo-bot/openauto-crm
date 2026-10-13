/**
 * Wzory VAT z założeń projektu (p. 5, 7, 17).
 * UWAGA: to mechanika obliczeń. To, czy dana transakcja może być rozliczona
 * w procedurze VAT-marża i jaka jest kwota nabycia, wynika z dokumentów
 * i musi zostać zweryfikowane przez księgowego (tax_rule_versions).
 */
import { type Cents, max, mulRatio, parseRatio } from './money.ts';

export interface NetVatGross {
  netto: Cents;
  vat: Cents;
  brutto: Cents;
}

/** Kwota VAT = netto × stawka; brutto = netto + VAT */
export function fromNet(netto: Cents, rate: string): NetVatGross {
  const [n, d] = parseRatio(rate);
  const vat = mulRatio(netto, n, d);
  return { netto, vat, brutto: netto + vat };
}

/**
 * Z brutto: VAT = brutto × stawka / (1 + stawka), netto = brutto − VAT.
 * Liczone tak, aby zawsze brutto = netto + VAT (brak formuł cyklicznych).
 */
export function fromGross(brutto: Cents, rate: string): NetVatGross {
  const [n, d] = parseRatio(rate);
  const vat = mulRatio(brutto, n, d + n);
  return { netto: brutto - vat, vat, brutto };
}

export interface VatMarzaResult {
  marzaBrutto: Cents;
  vatNalezny: Cents;
}

/**
 * Marża brutto = Cena sprzedaży − Kwota nabycia
 * VAT należny = MAX(0, Marża brutto × 23/123)
 * VAT naliczony z kosztów NIE jest tu odejmowany — rozlicza się go w okresie (p. 7, 17).
 */
export function vatMarza(cenaSprzedazy: Cents, kwotaNabycia: Cents, rate = '0.23'): VatMarzaResult {
  const [n, d] = parseRatio(rate);
  const marzaBrutto = cenaSprzedazy - kwotaNabycia;
  const vatNalezny = max(0n, mulRatio(marzaBrutto, n, d + n));
  return { marzaBrutto, vatNalezny };
}
