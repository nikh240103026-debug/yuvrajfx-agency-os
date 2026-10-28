import { describe, expect, test } from 'vitest';
import {
  computeInvoiceTotals,
  currencyDecimals,
  estimateInBase,
  formatMoney,
  fromMinor,
  lineAmount,
  mulDivRound,
  subtractGroups,
  sumByCurrency,
  toMinor,
} from '../src/shared/money.ts';

describe('parsing amounts', () => {
  test('parses common formats into minor units without float drift', () => {
    expect(toMinor('1,500.50', 'USD')).toBe(150050);
    expect(toMinor('₹1,50,000', 'INR')).toBe(15000000);
    expect(toMinor('$ 0.1', 'USD')).toBe(10);
    expect(toMinor('2.675', 'USD')).toBeNull(); // too many decimals for USD
    expect(toMinor(19.99, 'USD')).toBe(1999);
    expect(toMinor('1200', 'JPY')).toBe(1200); // zero-decimal currency
    expect(toMinor('12.5', 'JPY')).toBeNull();
  });

  test('rejects junk and negatives', () => {
    for (const bad of ['', 'abc', '1.2.3', '--5', '5-', '1e5']) expect(toMinor(bad, 'USD')).toBeNull();
    expect(toMinor('-5', 'USD')).toBeNull();
    expect(toMinor('-5', 'USD', { allowNegative: true })).toBe(-500);
  });

  test('round-trips to form values', () => {
    expect(fromMinor(150050, 'USD')).toBe('1500.50');
    expect(fromMinor(5, 'USD')).toBe('0.05');
    expect(fromMinor(1200, 'JPY')).toBe('1200');
    expect(currencyDecimals('JPY')).toBe(0);
  });
});

describe('formatting', () => {
  test('uses Indian grouping for INR and hides needless decimals', () => {
    expect(formatMoney(15000000, 'INR')).toBe('₹1,50,000');
    expect(formatMoney(15000050, 'INR')).toBe('₹1,50,000.50');
    expect(formatMoney(420000, 'USD')).toBe('$4,200');
    expect(formatMoney(420000, 'USD', { decimals: 'always' })).toBe('$4,200.00');
    expect(formatMoney(120000, 'CAD')).toBe('CA$1,200');
  });
});

describe('invoice maths', () => {
  test('quantity × rate with fractional quantities is exact', () => {
    expect(lineAmount(2.5, 150000)).toBe(375000);
    expect(lineAmount(1.005, 1000)).toBe(1005);
    expect(lineAmount(3, 333)).toBe(999);
  });

  test('percent discount then several taxes on the discounted amount', () => {
    const t = computeInvoiceTotals({
      items: [
        { quantity: 1, unit_price_minor: 8500000 },
        { quantity: 2, unit_price_minor: 1250000 },
      ],
      discount_type: 'percent',
      discount_percent: 10,
      taxes: [
        { label: 'CGST', rate: 9 },
        { label: 'SGST', rate: 9 },
      ],
    });
    expect(t.subtotal_minor).toBe(11000000);
    expect(t.discount_minor).toBe(1100000);
    expect(t.taxable_minor).toBe(9900000);
    expect(t.tax_lines.map((x) => x.amount_minor)).toEqual([891000, 891000]);
    expect(t.total_minor).toBe(11682000);
  });

  test('fixed discount is capped at the subtotal and rounding is half-up', () => {
    const t = computeInvoiceTotals({ items: [{ quantity: 1, unit_price_minor: 1000 }], discount_type: 'fixed', discount_fixed_minor: 5000, taxes: [{ label: 'VAT', rate: 20 }] });
    expect(t.discount_minor).toBe(1000);
    expect(t.total_minor).toBe(0);
    const r = computeInvoiceTotals({ items: [{ quantity: 1, unit_price_minor: 105 }], discount_type: 'none', taxes: [{ label: 'GST', rate: 10 }] });
    expect(r.tax_minor).toBe(11); // 10.5 → 11
    expect(mulDivRound(5, 1, 2)).toBe(3);
  });
});

describe('currency groups', () => {
  test('never adds different currencies together', () => {
    const groups = sumByCurrency(
      [
        { currency: 'USD', amount_minor: 100000 },
        { currency: 'INR', amount_minor: 5000000 },
        { currency: 'USD', amount_minor: 50000 },
      ],
      'INR',
    );
    expect(groups).toEqual([
      { currency: 'INR', amount_minor: 5000000 },
      { currency: 'USD', amount_minor: 150000 },
    ]);
    expect(subtractGroups(groups, [{ currency: 'EUR', amount_minor: 1000 }], 'INR')).toEqual([
      { currency: 'INR', amount_minor: 5000000 },
      { currency: 'USD', amount_minor: 150000 },
      { currency: 'EUR', amount_minor: -1000 },
    ]);
  });

  test('cross-currency estimate only with owner rates, listing what it could not convert', () => {
    const groups = [
      { currency: 'INR', amount_minor: 5000000 },
      { currency: 'USD', amount_minor: 150000 },
      { currency: 'EUR', amount_minor: 1000 },
    ];
    expect(estimateInBase(groups, null)).toBeNull();
    expect(estimateInBase(groups, { base: 'INR', rates: {}, as_of: null })).toBeNull();
    const est = estimateInBase(groups, { base: 'INR', rates: { USD: 84 }, as_of: '2026-10-01' })!;
    expect(est.amount_minor).toBe(5000000 + 1500 * 84 * 100);
    expect(est.missing).toEqual(['EUR']);
    expect(estimateInBase([{ currency: 'INR', amount_minor: 100 }], { base: 'INR', rates: { USD: 84 }, as_of: null })).toBeNull();
  });
});
