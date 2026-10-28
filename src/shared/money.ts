// Money is always an integer count of the currency's minor unit (cents, paise…) plus an ISO 4217 code.
// Amounts in different currencies are never added together: totals are grouped per currency,
// and any cross-currency figure is an explicitly labelled estimate made from the owner's own rates.

import type { DiscountType } from './constants.ts';

export type MoneyGroup = { currency: string; amount_minor: number };

const decimalsCache = new Map<string, number>();
let supported: Set<string> | null = null;

export function isValidCurrency(code: unknown): code is string {
  if (typeof code !== 'string' || !/^[A-Z]{3}$/.test(code)) return false;
  if (!supported) {
    try {
      supported = new Set(Intl.supportedValuesOf('currency'));
    } catch {
      supported = new Set();
    }
  }
  if (supported.size > 0) return supported.has(code);
  try {
    new Intl.NumberFormat('en-US', { style: 'currency', currency: code });
    return true;
  } catch {
    return false;
  }
}

/** Number of minor-unit digits for a currency (USD 2, JPY 0, …). */
export function currencyDecimals(currency: string): number {
  let d = decimalsCache.get(currency);
  if (d === undefined) {
    try {
      d = new Intl.NumberFormat('en-US', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
    } catch {
      d = 2;
    }
    decimalsCache.set(currency, d);
  }
  return d;
}

/**
 * Parse a human amount ("1,500.50", "₹ 1,50,000", "12") into minor units without floating-point maths.
 * Returns null for anything that is not a plain non-negative amount with at most the currency's decimals.
 */
export function toMinor(input: string | number | null | undefined, currency: string, opts: { allowNegative?: boolean } = {}): number | null {
  if (input === null || input === undefined) return null;
  let s = typeof input === 'number' ? (Number.isFinite(input) ? String(input) : '') : input;
  s = s.trim().replace(/[\s,_']/g, '');
  // Drop a leading currency symbol or code ("$", "₹", "USD").
  s = s.replace(/^-?[^\d.\-]+/, (m) => (m.startsWith('-') ? '-' : ''));
  if (!/^-?(\d+(\.\d*)?|\.\d+)$/.test(s)) return null;
  const negative = s.startsWith('-');
  if (negative && !opts.allowNegative) return null;
  const [intPart, fracPart = ''] = s.replace('-', '').split('.');
  const d = currencyDecimals(currency);
  if (fracPart.length > d) return null;
  const minor = Number(intPart || '0') * 10 ** d + Number((fracPart + '0'.repeat(d)).slice(0, d) || '0');
  if (!Number.isSafeInteger(minor)) return null;
  return negative ? -minor : minor;
}

/** Minor units back to a plain decimal string for form inputs ("1500.5" → "1500.50"). */
export function fromMinor(minor: number | null | undefined, currency: string): string {
  if (minor === null || minor === undefined) return '';
  const d = currencyDecimals(currency);
  const negative = minor < 0;
  const abs = Math.abs(minor);
  const intPart = Math.floor(abs / 10 ** d);
  const frac = d > 0 ? '.' + String(abs % 10 ** d).padStart(d, '0') : '';
  return `${negative ? '-' : ''}${intPart}${frac}`;
}

const formatterCache = new Map<string, Intl.NumberFormat>();
function formatter(key: string, make: () => Intl.NumberFormat): Intl.NumberFormat {
  let f = formatterCache.get(key);
  if (!f) {
    f = make();
    formatterCache.set(key, f);
  }
  return f;
}

export function currencyLocale(currency: string): string {
  return currency === 'INR' ? 'en-IN' : 'en-US';
}

export type FormatMoneyOptions = {
  /** 'auto' shows decimals only when the amount has a fractional part. Default 'auto'. */
  decimals?: 'auto' | 'always' | 'never';
  compact?: boolean;
  signDisplay?: 'auto' | 'always' | 'exceptZero';
};

export function formatMoney(minor: number, currency: string, opts: FormatMoneyOptions = {}): string {
  const d = currencyDecimals(currency);
  const major = minor / 10 ** d;
  const locale = currencyLocale(currency);
  const sign = opts.signDisplay ?? 'auto';
  if (opts.compact && Math.abs(major) >= 1000) {
    return formatter(`c|${locale}|${currency}|${sign}`, () =>
      new Intl.NumberFormat(locale, { style: 'currency', currency, notation: 'compact', maximumFractionDigits: 1, signDisplay: sign }),
    ).format(major);
  }
  const mode = opts.decimals ?? 'auto';
  const showDecimals = mode === 'always' || (mode === 'auto' && minor % 10 ** d !== 0);
  const digits = showDecimals ? d : 0;
  return formatter(`f|${locale}|${currency}|${digits}|${sign}`, () =>
    new Intl.NumberFormat(locale, { style: 'currency', currency, minimumFractionDigits: digits, maximumFractionDigits: digits, signDisplay: sign }),
  ).format(major);
}

/** Group amounts by currency. Order: `preferred` first, then by absolute size. */
export function sumByCurrency(rows: Iterable<{ currency: string; amount_minor: number }>, preferred?: string): MoneyGroup[] {
  const totals = new Map<string, number>();
  for (const r of rows) totals.set(r.currency, (totals.get(r.currency) ?? 0) + r.amount_minor);
  return sortGroups(
    [...totals.entries()].map(([currency, amount_minor]) => ({ currency, amount_minor })),
    preferred,
  );
}

export function sortGroups(groups: MoneyGroup[], preferred?: string): MoneyGroup[] {
  return [...groups].sort((a, b) => {
    if (preferred) {
      if (a.currency === preferred && b.currency !== preferred) return -1;
      if (b.currency === preferred && a.currency !== preferred) return 1;
    }
    return Math.abs(b.amount_minor) - Math.abs(a.amount_minor) || a.currency.localeCompare(b.currency);
  });
}

/** a - b per currency (e.g. collected minus expenses). Currencies present on either side are kept. */
export function subtractGroups(a: MoneyGroup[], b: MoneyGroup[], preferred?: string): MoneyGroup[] {
  return sumByCurrency(
    [...a, ...b.map((g) => ({ currency: g.currency, amount_minor: -g.amount_minor }))],
    preferred,
  );
}

/** Round-half-up of a*b/c for integers, exact even when a*b exceeds 2^53. */
export function mulDivRound(a: number, b: number, c: number): number {
  if (c === 0) throw new Error('division by zero');
  const negative = a < 0 !== b < 0 && a !== 0 && b !== 0;
  const num = BigInt(Math.abs(Math.trunc(a))) * BigInt(Math.abs(Math.trunc(b)));
  const den = BigInt(Math.abs(c));
  const q = (num * 2n + den) / (den * 2n);
  return Number(negative ? -q : q);
}

/** Percent (up to 2 decimals) as integer basis points: 18 → 1800, 2.5 → 250. */
export function percentToBps(percent: number): number {
  return Math.round(percent * 100);
}

// ── Invoice totals ───────────────────────────────────────────────────────────

export type TaxLine = { label: string; rate: number };
export type InvoiceLineInput = { quantity: number; unit_price_minor: number };
export type InvoiceTotalsInput = {
  items: InvoiceLineInput[];
  discount_type: DiscountType;
  discount_percent?: number | null;
  discount_fixed_minor?: number | null;
  taxes: TaxLine[];
};
export type InvoiceTotals = {
  lines: { amount_minor: number }[];
  subtotal_minor: number;
  discount_minor: number;
  taxable_minor: number;
  tax_lines: (TaxLine & { amount_minor: number })[];
  tax_minor: number;
  total_minor: number;
};

/** Line amount = quantity × unit price, with quantity supporting up to 3 decimals (e.g. 2.5 hours). */
export function lineAmount(quantity: number, unitPriceMinor: number): number {
  const qtyThousandths = Math.round(quantity * 1000);
  return mulDivRound(qtyThousandths, unitPriceMinor, 1000);
}

/**
 * The single source of truth for invoice maths, shared by the editor preview and the server.
 * Discount applies to the subtotal; every tax line is charged on the discounted amount.
 */
export function computeInvoiceTotals(input: InvoiceTotalsInput): InvoiceTotals {
  const lines = input.items.map((it) => ({ amount_minor: lineAmount(it.quantity, it.unit_price_minor) }));
  const subtotal = lines.reduce((s, l) => s + l.amount_minor, 0);
  let discount = 0;
  if (input.discount_type === 'percent') {
    discount = mulDivRound(subtotal, percentToBps(input.discount_percent ?? 0), 10_000);
  } else if (input.discount_type === 'fixed') {
    discount = Math.max(0, input.discount_fixed_minor ?? 0);
  }
  discount = Math.min(discount, subtotal);
  const taxable = subtotal - discount;
  const tax_lines = input.taxes.map((t) => ({ ...t, amount_minor: mulDivRound(taxable, percentToBps(t.rate), 10_000) }));
  const tax = tax_lines.reduce((s, t) => s + t.amount_minor, 0);
  return {
    lines,
    subtotal_minor: subtotal,
    discount_minor: discount,
    taxable_minor: taxable,
    tax_lines,
    tax_minor: tax,
    total_minor: taxable + tax,
  };
}

// ── Cross-currency estimate ─────────────────────────────────────────────────

/** rates[X] = how many units of the base currency one unit of X is worth (set by the owner). */
export type FxSettings = { base: string; rates: Record<string, number>; as_of: string | null };
export type FxEstimate = { currency: string; amount_minor: number; missing: string[]; as_of: string | null };

/**
 * Convert per-currency groups into one approximate figure in the base currency.
 * Returns null when there is nothing to estimate (one currency only, or no rates set).
 * Currencies without a rate are left out and listed in `missing` so the UI can say so.
 */
export function estimateInBase(groups: MoneyGroup[], fx: FxSettings | null): FxEstimate | null {
  if (!fx) return null;
  const nonZero = groups.filter((g) => g.amount_minor !== 0);
  if (nonZero.length < 2 && nonZero.every((g) => g.currency === fx.base)) return null;
  const foreign = nonZero.filter((g) => g.currency !== fx.base);
  if (!foreign.some((g) => fx.rates[g.currency] > 0)) return null;
  const baseDec = currencyDecimals(fx.base);
  let total = 0;
  const missing: string[] = [];
  for (const g of nonZero) {
    if (g.currency === fx.base) {
      total += g.amount_minor;
      continue;
    }
    const rate = fx.rates[g.currency];
    if (!(rate > 0)) {
      missing.push(g.currency);
      continue;
    }
    const major = g.amount_minor / 10 ** currencyDecimals(g.currency);
    total += Math.round(major * rate * 10 ** baseDec);
  }
  return { currency: fx.base, amount_minor: total, missing, as_of: fx.as_of };
}
