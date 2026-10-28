import { z } from 'zod';
import { isValidCurrency } from '../../shared/money.ts';
import { isValidDate } from '../../shared/dates.ts';

// Field builders shared by every route schema. Optional text/url/date fields turn '' into null so a
// form can clear a value; in PATCH schemas (.partial()) an absent key stays undefined = "leave as is".

export const requiredText = (max = 200) =>
  z.string({ error: 'Required.' }).trim().min(1, 'Required.').max(max, `Keep it under ${max} characters.`);

export const optionalText = (max = 5000) =>
  z
    .string()
    .trim()
    .max(max, `Keep it under ${max} characters.`)
    .nullish()
    .transform((v) => (v ? v : null));

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const requiredEmail = () =>
  z
    .string({ error: 'Enter an email address.' })
    .trim()
    .toLowerCase()
    .max(200)
    .refine((v) => EMAIL_RE.test(v), 'Enter a valid email address.');

export const optionalEmail = () =>
  z
    .string()
    .trim()
    .toLowerCase()
    .max(200)
    .nullish()
    .transform((v, ctx) => {
      if (!v) return null;
      if (!EMAIL_RE.test(v)) {
        ctx.addIssue({ code: 'custom', message: 'Enter a valid email address.' });
        return z.NEVER;
      }
      return v;
    });

/** Accepts "example.com" and stores "https://example.com". Only http(s) links are allowed. */
export function normalizeUrl(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(v) ? v : `https://${v}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!u.hostname.includes('.') && u.hostname !== 'localhost') return null;
    return u.toString();
  } catch {
    return null;
  }
}

export const optionalUrl = () =>
  z
    .string()
    .max(2000)
    .nullish()
    .transform((v, ctx) => {
      if (!v || !v.trim()) return null;
      const url = normalizeUrl(v);
      if (!url) {
        ctx.addIssue({ code: 'custom', message: 'Enter a valid http(s) link.' });
        return z.NEVER;
      }
      return url;
    });

export const requiredDate = () =>
  z.string({ error: 'Required.' }).refine(isValidDate, 'Use a valid date (YYYY-MM-DD).');

export const optionalDate = () =>
  z
    .string()
    .nullish()
    .transform((v, ctx) => {
      if (!v) return null;
      if (!isValidDate(v)) {
        ctx.addIssue({ code: 'custom', message: 'Use a valid date (YYYY-MM-DD).' });
        return z.NEVER;
      }
      return v;
    });

export const currencyCode = () =>
  z
    .string({ error: 'Pick a currency.' })
    .trim()
    .transform((v) => v.toUpperCase())
    .refine(isValidCurrency, 'Unknown currency code.');

/** Integer amount in minor units (cents/paise). */
export const minorAmount = () =>
  z
    .number({ error: 'Enter an amount.' })
    .int('Amounts are whole minor units.')
    .min(0, 'Amount cannot be negative.')
    .max(1e13, 'That amount is too large.');

export const positiveMinorAmount = () => minorAmount().refine((v) => v > 0, 'Amount must be more than zero.');

export const optionalMinorAmount = () => minorAmount().nullish().transform((v) => (v === undefined ? null : v));

export const foreignKey = () =>
  z
    .number()
    .int()
    .positive()
    .nullish()
    .transform((v) => v ?? null);

export const requiredForeignKey = (label = 'record') => z.number({ error: `Pick a ${label}.` }).int().positive(`Pick a ${label}.`);

export const tagList = () =>
  z
    .array(z.string().trim().min(1).max(40))
    .max(30)
    .nullish()
    .transform((tags) => [...new Set((tags ?? []).map((t) => t.toLowerCase()))]);

export const linkList = () =>
  z
    .array(z.object({ label: z.string().trim().max(120).nullish(), url: z.string().max(2000) }))
    .max(40)
    .nullish()
    .transform((links, ctx) => {
      const out: { label: string; url: string }[] = [];
      for (const l of links ?? []) {
        if (!l.url.trim()) continue;
        const url = normalizeUrl(l.url);
        if (!url) {
          ctx.addIssue({ code: 'custom', message: `Not a valid http(s) link: ${l.url.slice(0, 60)}` });
          return z.NEVER;
        }
        out.push({ label: l.label?.trim() || new URL(url).hostname.replace(/^www\./, ''), url });
      }
      return out;
    });

export const boolish = () => z.union([z.boolean(), z.literal(0), z.literal(1)]).transform((v) => (v ? 1 : 0));

/** Query-string helpers. */
export const qInt = () =>
  z
    .union([z.string(), z.number()])
    .optional()
    .transform((v) => {
      if (v === undefined || v === '') return undefined;
      const n = Number(v);
      return Number.isSafeInteger(n) && n > 0 ? n : undefined;
    });
export const qStr = () =>
  z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((v) => {
      const s = Array.isArray(v) ? v[0] : v;
      return s && s.trim() ? s.trim().slice(0, 200) : undefined;
    });
export const qDate = () =>
  z
    .string()
    .optional()
    .transform((v) => (v && isValidDate(v) ? v : undefined));
