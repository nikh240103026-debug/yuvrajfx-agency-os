import type { Db } from '../db/db.ts';
import type { TaxLine, FxSettings } from '../../shared/money.ts';

export type Settings = {
  business_name: string;
  business_email: string;
  business_phone: string;
  business_address: string;
  business_website: string;
  tax_id_label: string;
  tax_id: string;
  base_currency: string;
  timezone: string;
  /** Units of base currency per one unit of the keyed currency, entered by the owner. */
  fx_rates: Record<string, number>;
  fx_as_of: string | null;
  invoice_prefix: string;
  invoice_next_number: number;
  invoice_number_padding: number;
  default_payment_terms_days: number;
  default_taxes: TaxLine[];
  default_invoice_terms: string;
  payment_instructions: string;
  invoice_footer: string;
  owner_report_email: string;
};

export const DEFAULT_SETTINGS: Settings = {
  business_name: 'YuvrajFX',
  business_email: '',
  business_phone: '',
  business_address: '',
  business_website: '',
  tax_id_label: 'GSTIN',
  tax_id: '',
  base_currency: 'INR',
  timezone: 'Asia/Kolkata',
  fx_rates: {},
  fx_as_of: null,
  invoice_prefix: 'YFX-',
  invoice_next_number: 1,
  invoice_number_padding: 4,
  default_payment_terms_days: 7,
  default_taxes: [],
  default_invoice_terms: '',
  payment_instructions: '',
  invoice_footer: 'Thank you for working with YuvrajFX.',
  owner_report_email: '',
};

export const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[];

export function readSettings(db: Db): Settings {
  const out: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const row of db.all<{ key: string; value: string }>('SELECT key, value FROM settings')) {
    if (!(row.key in DEFAULT_SETTINGS)) continue;
    try {
      out[row.key] = JSON.parse(row.value);
    } catch {
      /* keep default */
    }
  }
  return out as Settings;
}

export function writeSettings(db: Db, patch: Partial<Settings>): void {
  db.tx(() => {
    for (const [key, value] of Object.entries(patch)) {
      if (!(key in DEFAULT_SETTINGS) || value === undefined) continue;
      db.run('INSERT INTO settings (key, value) VALUES (:key, :value) ON CONFLICT(key) DO UPDATE SET value = excluded.value', {
        key,
        value: JSON.stringify(value),
      });
    }
  });
}

export function fxFromSettings(s: Settings): FxSettings {
  return { base: s.base_currency, rates: s.fx_rates ?? {}, as_of: s.fx_as_of };
}
