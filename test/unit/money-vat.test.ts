import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatPLN, toCents, toDecimalString, divRound, MoneyError } from '../../src/shared/money.ts';
import { fromGross, fromNet, vatMarza } from '../../src/shared/vat.ts';

test('kwoty: parsowanie i format bez błędów zmiennoprzecinkowych', () => {
  assert.equal(toCents('1 234,56'), 123456n);
  assert.equal(toCents('1234.5'), 123450n);
  assert.equal(toCents('-15'), -1500n);
  assert.equal(toCents('0.10'), 10n);
  assert.equal(toCents('2.000'), 200n); // zera po 2. miejscu dopuszczalne
  assert.throws(() => toCents('1.005'), MoneyError);
  assert.throws(() => toCents('abc'), MoneyError);
  // klasyczny błąd float: 0.1 + 0.2
  assert.equal(toDecimalString(toCents('0.1') + toCents('0.2')), '0.30');
  assert.equal(formatPLN(toCents('1234567.8')), '1 234 567,80 zł');
  assert.equal(formatPLN(-150n), '−1,50 zł');
});

test('zaokrąglanie połówek od zera (jak ROUND w PostgreSQL)', () => {
  assert.equal(divRound(5n, 2n), 3n);
  assert.equal(divRound(-5n, 2n), -3n);
  assert.equal(divRound(4n, 3n), 1n);
});

test('VAT z netto i z brutto: brutto = netto + VAT', () => {
  const a = fromNet(toCents('1000'), '0.23');
  assert.deepEqual([a.netto, a.vat, a.brutto], [100000n, 23000n, 123000n]);
  const b = fromGross(toCents('1230'), '0.23');
  assert.deepEqual([b.netto, b.vat, b.brutto], [100000n, 23000n, 123000n]);
  // brutto niepodzielne bez reszty — suma zawsze się zgadza
  const c = fromGross(toCents('99.99'), '0.23');
  assert.equal(c.netto + c.vat, c.brutto);
  assert.equal(toDecimalString(c.vat), '18.70');
  // stawka 0%
  assert.deepEqual(fromNet(toCents('1500'), '0'), { netto: 150000n, vat: 0n, brutto: 150000n });
});

test('VAT-marża: przykład z założeń (15 977 → 25 000 zł)', () => {
  const r = vatMarza(toCents('25000'), toCents('15977'));
  assert.equal(toDecimalString(r.marzaBrutto), '9023.00');
  assert.equal(toDecimalString(r.vatNalezny), '1687.23');
  // VAT naliczony 519 zł nie pomniejsza marży — to rozliczenie okresu
  assert.equal(toDecimalString(r.vatNalezny - toCents('519')), '1168.23');
});

test('VAT-marża: marża ujemna → VAT należny 0', () => {
  const r = vatMarza(toCents('10000'), toCents('12000'));
  assert.equal(r.marzaBrutto, -200000n);
  assert.equal(r.vatNalezny, 0n);
});
