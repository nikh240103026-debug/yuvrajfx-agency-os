import { useId, type InputHTMLAttributes, type ReactNode } from 'react';
import { COMMON_CURRENCIES } from '../../shared/constants.ts';
import { estimateInBase, formatMoney, type FxSettings, type MoneyGroup } from '../../shared/money.ts';
import { cx } from '../lib/util.ts';
import { Field, Select } from './ui.tsx';

export function Money({ minor, currency, decimals = 'auto', className, signed }: { minor: number | null | undefined; currency: string; decimals?: 'auto' | 'always' | 'never'; className?: string; signed?: boolean }) {
  if (minor === null || minor === undefined) return <span className={cx('text-ink-3', className)}>—</span>;
  return <span className={cx('tabular', className)}>{formatMoney(minor, currency, { decimals, signDisplay: signed ? 'exceptZero' : 'auto' })}</span>;
}

export function groupsText(groups: MoneyGroup[] | undefined, empty = '—'): string {
  if (!groups || groups.length === 0) return empty;
  return groups.map((g) => formatMoney(g.amount_minor, g.currency)).join(' · ');
}

/**
 * Per-currency amounts, never added together. The first currency is shown large, the rest below.
 * With owner-set exchange rates, an explicitly labelled approximate total in the base currency is added.
 */
export function MoneyStack({ groups, size = 'lg', empty = '—', fx, tone, className }: { groups: MoneyGroup[] | undefined; size?: 'xl' | 'lg' | 'md' | 'sm'; empty?: ReactNode; fx?: FxSettings | null; tone?: 'bad' | 'good'; className?: string }) {
  const list = (groups ?? []).filter((g) => g.amount_minor !== 0);
  if (list.length === 0) return <div className={cx(size === 'sm' ? 'text-[13px]' : size === 'md' ? 'text-[15px]' : 'text-[26px] font-semibold', 'text-ink-3', className)}>{empty}</div>;
  const [first, ...rest] = list;
  const est = fx ? estimateInBase(list, fx) : null;
  const main = { xl: 'text-[32px] font-semibold tracking-tight', lg: 'text-[26px] font-semibold tracking-tight', md: 'text-[15px] font-semibold', sm: 'text-[13px] font-medium' }[size];
  return (
    <div className={cx('min-w-0', className)}>
      <div className={cx(main, 'leading-tight truncate', tone === 'bad' ? 'text-bad' : tone === 'good' ? 'text-good' : 'text-ink')}>{formatMoney(first.amount_minor, first.currency)}</div>
      {rest.length > 0 && (
        <div className={cx('mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5', size === 'sm' ? 'text-[12px]' : 'text-[13px]', 'text-ink-2 font-medium')}>
          {rest.map((g) => (
            <span key={g.currency} className="tabular">
              + {formatMoney(g.amount_minor, g.currency)}
            </span>
          ))}
        </div>
      )}
      {est && (
        <div className="mt-1 text-[11.5px] text-ink-3" title={`Estimate using your own exchange rates${est.as_of ? ` (as of ${est.as_of})` : ''}. Not an accounting figure.`}>
          ≈ {formatMoney(est.amount_minor, est.currency)} total at your rates{est.missing.length ? ` · ${est.missing.join(', ')} not converted` : ''}
        </div>
      )}
    </div>
  );
}

export function currencySymbol(currency: string): string {
  try {
    const parts = new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en-US', { style: 'currency', currency }).formatToParts(0);
    return parts.find((p) => p.type === 'currency')?.value ?? currency;
  } catch {
    return currency;
  }
}

/** Decimal text input for an amount; the parent converts with toMinor() on save. */
export function MoneyInput({ currency, value, onChange, invalid, className, ...rest }: Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value'> & { currency: string; value: string; onChange: (v: string) => void; invalid?: boolean }) {
  const sym = currencySymbol(currency);
  return (
    <div className={cx('relative', className)}>
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[13px] text-ink-3">{sym}</span>
      <input
        inputMode="decimal"
        autoComplete="off"
        className="field-input tabular"
        style={{ paddingLeft: `${Math.max(26, 14 + sym.length * 8)}px` }}
        aria-invalid={invalid || undefined}
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/[^\d.,]/g, ''))}
        {...rest}
      />
    </div>
  );
}

export function MoneyField({ label, currency, value, onChange, error, hint, optional, required, placeholder }: { label: ReactNode; currency: string; value: string; onChange: (v: string) => void; error?: string; hint?: ReactNode; optional?: boolean; required?: boolean; placeholder?: string }) {
  const id = useId();
  return (
    <Field label={label} error={error} hint={hint} htmlFor={id} optional={optional} required={required}>
      <MoneyInput id={id} currency={currency} value={value} onChange={onChange} invalid={!!error} placeholder={placeholder ?? '0.00'} />
    </Field>
  );
}

export function CurrencySelect({ value, onChange, id, extra = [] }: { value: string; onChange: (v: string) => void; id?: string; extra?: string[] }) {
  const options = [...new Set([...COMMON_CURRENCIES, ...extra, value].filter(Boolean))];
  return (
    <Select id={id} value={value} onChange={(e) => onChange(e.target.value)} className="tabular">
      {options.map((c) => (
        <option key={c} value={c}>
          {c} · {currencySymbol(c)}
        </option>
      ))}
    </Select>
  );
}
