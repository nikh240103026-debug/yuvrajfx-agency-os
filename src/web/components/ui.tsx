import { Children, cloneElement, isValidElement, useId, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type Ref, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { Link } from 'react-router';
import { AlertTriangle, Info, Loader2, RefreshCw } from 'lucide-react';
import { cx, initials } from '../lib/util.ts';
import { errorMessage } from '../lib/api.ts';

// ── Buttons ──────────────────────────────────────────────────────────────────

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle';
type Size = 'xs' | 'sm' | 'md';

const VARIANTS: Record<Variant, string> = {
  primary:
    'bg-accent text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.18),0_1px_2px_rgb(0_0_0/0.4)] hover:bg-accent-hover disabled:bg-accent/50',
  secondary: 'bg-surface-2 text-ink border border-line-strong hover:bg-surface-3 hover:border-white/20 disabled:opacity-50',
  ghost: 'text-ink-2 hover:text-ink hover:bg-white/[0.06] disabled:opacity-40',
  subtle: 'bg-white/[0.05] text-ink hover:bg-white/[0.09] disabled:opacity-40',
  danger: 'bg-[#b4363a] text-white hover:bg-[#a02f33] shadow-[inset_0_1px_0_rgb(255_255_255/0.15)] disabled:opacity-50',
};
const SIZES: Record<Size, string> = {
  xs: 'h-7 px-2 text-[12px] gap-1 rounded-md',
  sm: 'h-8 px-2.5 text-[13px] gap-1.5 rounded-lg',
  md: 'h-9 px-3.5 text-[13.5px] gap-2 rounded-lg',
};

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: ReactNode;
  to?: string;
  href?: string;
  /** With href: download the target instead of navigating (CSV exports). */
  download?: boolean;
  ref?: Ref<HTMLButtonElement>;
};

export function Button({ variant = 'secondary', size = 'md', loading, icon, children, className, to, href, download, disabled, ...rest }: ButtonProps) {
  const cls = cx(
    'inline-flex items-center justify-center font-medium whitespace-nowrap select-none transition-colors duration-150 cursor-pointer disabled:cursor-not-allowed',
    VARIANTS[variant],
    SIZES[size],
    className,
  );
  const content = (
    <>
      {loading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : icon}
      {children}
    </>
  );
  if (to) return <Link to={to} className={cls}>{content}</Link>;
  if (href) {
    const newTab = !download && !href.startsWith('mailto:');
    return (
      <a href={href} className={cls} download={download || undefined} target={newTab ? '_blank' : undefined} rel={newTab ? 'noreferrer' : undefined}>
        {content}
      </a>
    );
  }
  return (
    <button type="button" className={cls} disabled={disabled || loading} aria-busy={loading || undefined} {...rest}>
      {content}
    </button>
  );
}

export function IconButton({ label, children, className, size = 'md', ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; size?: 'sm' | 'md'; ref?: Ref<HTMLButtonElement> }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cx(
        'inline-flex items-center justify-center rounded-lg text-ink-2 hover:text-ink hover:bg-white/[0.07] transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed',
        size === 'sm' ? 'size-7' : 'size-9',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

// ── Form fields ──────────────────────────────────────────────────────────────

const LABELABLE = new Set(['input', 'select', 'textarea']);

export function Field({ label, hint, error, children, className, htmlFor, required, optional, group }: { label?: ReactNode; hint?: ReactNode; error?: string; children: ReactNode; className?: string; htmlFor?: string; required?: boolean; optional?: boolean; group?: boolean }) {
  const autoId = useId();
  const labelId = useId();
  // Link the label to a single control (or a component that forwards `id`) automatically; otherwise label the group.
  let forId = htmlFor;
  let body: ReactNode = children;
  const kids = Children.toArray(children);
  const only = kids.length === 1 && isValidElement<{ id?: string }>(kids[0]) ? kids[0] : null;
  if (!forId && !group && only && (typeof only.type !== 'string' || LABELABLE.has(only.type))) {
    forId = only.props.id ?? autoId;
    body = only.props.id ? only : cloneElement(only, { id: autoId });
  }
  return (
    <div className={cx('flex flex-col gap-1.5 min-w-0', className)} role={forId ? undefined : 'group'} aria-labelledby={forId || !label ? undefined : labelId}>
      {label && (
        <label id={labelId} htmlFor={forId} className="text-[12.5px] font-medium text-ink-2 flex items-center gap-1">
          {label}
          {required && <span className="text-accent-ink" aria-hidden>*</span>}
          {optional && <span className="text-ink-3 font-normal">optional</span>}
        </label>
      )}
      {body}
      {error ? (
        <p className="text-[12px] text-bad flex items-center gap-1" role="alert">
          <AlertTriangle className="size-3.5 shrink-0" aria-hidden /> {error}
        </p>
      ) : hint ? (
        <p className="text-[12px] text-ink-3">{hint}</p>
      ) : null}
    </div>
  );
}

export function Input({ className, invalid, ...rest }: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean; ref?: Ref<HTMLInputElement> }) {
  return <input className={cx('field-input', className)} aria-invalid={invalid || undefined} {...rest} />;
}

export function Textarea({ className, invalid, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean; ref?: Ref<HTMLTextAreaElement> }) {
  return <textarea className={cx('field-input', className)} aria-invalid={invalid || undefined} {...rest} />;
}

export function Select({ className, invalid, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }) {
  return (
    <select className={cx('field-input cursor-pointer', className)} aria-invalid={invalid || undefined} {...rest}>
      {children}
    </select>
  );
}

/** Labelled input with id wiring in one line. */
export function TextField({ label, error, hint, required, optional, className, ...rest }: InputHTMLAttributes<HTMLInputElement> & { label: ReactNode; error?: string; hint?: ReactNode; optional?: boolean }) {
  const id = useId();
  return (
    <Field label={label} error={error} hint={hint} htmlFor={id} required={required} optional={optional} className={className}>
      <Input id={id} invalid={!!error} required={required} {...rest} />
    </Field>
  );
}

export function SelectField({ label, error, hint, required, optional, className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement> & { label: ReactNode; error?: string; hint?: ReactNode; optional?: boolean }) {
  const id = useId();
  return (
    <Field label={label} error={error} hint={hint} htmlFor={id} required={required} optional={optional} className={className}>
      <Select id={id} invalid={!!error} required={required} {...rest}>
        {children}
      </Select>
    </Field>
  );
}

export function TextareaField({ label, error, hint, optional, className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { label: ReactNode; error?: string; hint?: ReactNode; optional?: boolean }) {
  const id = useId();
  return (
    <Field label={label} error={error} hint={hint} htmlFor={id} optional={optional} className={className}>
      <Textarea id={id} invalid={!!error} {...rest} />
    </Field>
  );
}

export function Checkbox({ label, checked, onChange, description, disabled }: { label: ReactNode; checked: boolean; onChange: (v: boolean) => void; description?: ReactNode; disabled?: boolean }) {
  const id = useId();
  return (
    <label htmlFor={id} className={cx('flex items-start gap-2.5 cursor-pointer select-none', disabled && 'opacity-50 cursor-not-allowed')}>
      <input id={id} type="checkbox" className="mt-0.5 size-4 accent-[#6c5ce7] cursor-pointer" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="flex flex-col">
        <span className="text-[13px] text-ink">{label}</span>
        {description && <span className="text-[12px] text-ink-3">{description}</span>}
      </span>
    </label>
  );
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed',
        checked ? 'bg-accent' : 'bg-white/[0.14]',
      )}
    >
      <span className={cx('inline-block size-4 rounded-full bg-white shadow transition-transform', checked ? 'translate-x-[18px]' : 'translate-x-0.5')} />
    </button>
  );
}

// ── Display ──────────────────────────────────────────────────────────────────

export type Tone = 'neutral' | 'accent' | 'good' | 'warn' | 'serious' | 'bad' | 'info';
const TONES: Record<Tone, string> = {
  neutral: 'bg-white/[0.06] text-ink-2 ring-white/[0.06]',
  accent: 'bg-accent-soft text-accent-ink ring-accent/25',
  good: 'bg-good-dot/12 text-good ring-good-dot/25',
  warn: 'bg-warn/10 text-warn ring-warn/25',
  serious: 'bg-serious-dot/12 text-serious ring-serious-dot/25',
  bad: 'bg-bad-dot/14 text-bad ring-bad-dot/30',
  info: 'bg-[#3987e5]/12 text-info ring-[#3987e5]/25',
};

export function Badge({ tone = 'neutral', children, dot, className, title }: { tone?: Tone; children: ReactNode; dot?: string; className?: string; title?: string }) {
  return (
    <span title={title} className={cx('inline-flex items-center gap-1.5 h-[22px] px-2 rounded-md text-[11.5px] font-medium ring-1 ring-inset whitespace-nowrap', TONES[tone], className)}>
      {dot && <span className="size-1.5 rounded-full" style={{ background: dot }} aria-hidden />}
      {children}
    </span>
  );
}

export function DemoBadge() {
  return (
    <span className="inline-flex items-center h-[18px] px-1.5 rounded text-[10px] font-semibold tracking-wider uppercase bg-warn/10 text-warn ring-1 ring-inset ring-warn/25" title="Sample data — remove it any time in Settings → Data">
      Demo
    </span>
  );
}

export function Card({ children, className, as: As = 'section' }: { children: ReactNode; className?: string; as?: 'section' | 'div' | 'article' }) {
  return <As className={cx('card', className)}>{children}</As>;
}

export function CardHeader({ title, description, action, className }: { title: ReactNode; description?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cx('flex items-start justify-between gap-3 px-5 pt-4 pb-3', className)}>
      <div className="min-w-0">
        <h2 className="text-[14px] font-semibold text-ink">{title}</h2>
        {description && <p className="text-[12.5px] text-ink-3 mt-0.5">{description}</p>}
      </div>
      {action && <div className="flex items-center gap-1.5 shrink-0">{action}</div>}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('skeleton', className)} aria-hidden />;
}

export function PageSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading" className="flex flex-col gap-4">
      <Skeleton className="h-8 w-56" />
      <Skeleton className="h-4 w-80" />
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 mt-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-28" />
        ))}
      </div>
      <Skeleton className="h-72 mt-2" />
    </div>
  );
}

export function Spinner({ className, label = 'Loading' }: { className?: string; label?: string }) {
  return (
    <span role="status" className={cx('inline-flex items-center gap-2 text-ink-3 text-[13px]', className)}>
      <Loader2 className="size-4 animate-spin" aria-hidden />
      <span className="sr-only">{label}</span>
    </span>
  );
}

export function EmptyState({ icon, title, body, action, compact }: { icon?: ReactNode; title: ReactNode; body?: ReactNode; action?: ReactNode; compact?: boolean }) {
  return (
    <div className={cx('flex flex-col items-center justify-center text-center', compact ? 'py-8 px-4' : 'py-14 px-6')}>
      {icon && <div className="mb-3 grid place-items-center size-11 rounded-xl bg-white/[0.04] ring-1 ring-inset ring-white/[0.06] text-ink-3">{icon}</div>}
      <h3 className="text-[14px] font-semibold text-ink">{title}</h3>
      {body && <p className="mt-1 max-w-sm text-[13px] text-ink-3">{body}</p>}
      {action && <div className="mt-4 flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry, compact }: { error: unknown; onRetry?: () => void; compact?: boolean }) {
  return (
    <div role="alert" className={cx('flex flex-col items-center justify-center text-center', compact ? 'py-6' : 'py-12')}>
      <div className="mb-3 grid place-items-center size-10 rounded-xl bg-bad-dot/12 text-bad">
        <AlertTriangle className="size-5" aria-hidden />
      </div>
      <p className="text-[13.5px] font-medium text-ink">Couldn’t load this</p>
      <p className="mt-1 max-w-md text-[12.5px] text-ink-3">{errorMessage(error)}</p>
      {onRetry && (
        <Button size="sm" className="mt-3" icon={<RefreshCw className="size-3.5" />} onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

export function Notice({ tone = 'info', children, className }: { tone?: 'info' | 'warn' | 'bad' | 'good'; children: ReactNode; className?: string }) {
  const map = {
    info: 'bg-[#3987e5]/[0.07] ring-[#3987e5]/20 text-ink-2',
    warn: 'bg-warn/[0.07] ring-warn/20 text-ink-2',
    bad: 'bg-bad-dot/[0.09] ring-bad-dot/25 text-ink-2',
    good: 'bg-good-dot/[0.08] ring-good-dot/20 text-ink-2',
  } as const;
  const icon = { info: <Info className="size-4 text-info" />, warn: <AlertTriangle className="size-4 text-warn" />, bad: <AlertTriangle className="size-4 text-bad" />, good: <Info className="size-4 text-good" /> }[tone];
  return (
    <div className={cx('flex gap-2.5 rounded-xl px-3.5 py-3 ring-1 ring-inset text-[13px]', map[tone], className)}>
      <span className="mt-[1px] shrink-0" aria-hidden>
        {icon}
      </span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="inline-flex items-center h-5 min-w-5 justify-center px-1 rounded border border-line-strong bg-white/[0.04] text-[10.5px] font-medium text-ink-3 font-sans">{children}</kbd>;
}

export function Avatar({ name, color, size = 24, className }: { name: string; color?: string | null; size?: number; className?: string }) {
  return (
    <span
      title={name}
      className={cx('inline-grid place-items-center rounded-full font-semibold text-white/95 shrink-0 ring-2 ring-surface', className)}
      style={{ width: size, height: size, fontSize: Math.max(9, size * 0.4), background: color ?? '#5f54a1' }}
    >
      {initials(name)}
    </span>
  );
}

export function Meter({ value, max = 1, tone = 'accent', label }: { value: number; max?: number; tone?: 'accent' | 'warn' | 'bad'; label: string }) {
  const ratio = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  const bar = { accent: 'bg-series-1', warn: 'bg-warn', bad: 'bg-bad-dot' }[tone];
  return (
    <div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} className="h-1.5 w-full rounded-full bg-series-1/15 overflow-hidden">
      <div className={cx('h-full rounded-full transition-[width] duration-500', bar)} style={{ width: `${ratio * 100}%` }} />
    </div>
  );
}

export function Segmented<T extends string>({ value, onChange, options, label, size = 'sm' }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode; count?: number }[]; label: string; size?: 'sm' | 'xs' }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex items-center gap-0.5 p-0.5 rounded-lg bg-white/[0.04] ring-1 ring-inset ring-white/[0.06] max-w-full overflow-x-auto">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cx(
            'inline-flex items-center gap-1.5 rounded-md font-medium transition-colors cursor-pointer whitespace-nowrap',
            size === 'xs' ? 'h-6 px-2 text-[12px]' : 'h-7 px-2.5 text-[12.5px]',
            value === o.value ? 'bg-surface-3 text-ink shadow-[0_1px_2px_rgb(0_0_0/0.4)] ring-1 ring-inset ring-white/[0.08]' : 'text-ink-3 hover:text-ink',
          )}
        >
          {o.label}
          {o.count !== undefined && <span className={cx('tabular text-[11px]', value === o.value ? 'text-ink-2' : 'text-ink-3')}>{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

/** Underlined tab bar (state lives with the caller, usually in the URL). */
export function Tabs<T extends string>({ value, onChange, tabs, label }: { value: T; onChange: (v: T) => void; tabs: { value: T; label: ReactNode; count?: number | null }[]; label: string }) {
  return (
    <div role="tablist" aria-label={label} className="flex items-center gap-1 border-b border-line mb-5 overflow-x-auto">
      {tabs.map((t) => (
        <button
          key={t.value}
          role="tab"
          type="button"
          aria-selected={value === t.value}
          onClick={() => onChange(t.value)}
          className={cx(
            'relative h-10 px-3 text-[13px] font-medium whitespace-nowrap cursor-pointer transition-colors',
            value === t.value ? 'text-ink' : 'text-ink-3 hover:text-ink-2',
          )}
        >
          <span className="inline-flex items-center gap-1.5">
            {t.label}
            {t.count ? <span className="text-[11px] tabular text-ink-3 bg-white/[0.06] rounded px-1.5">{t.count}</span> : null}
          </span>
          {value === t.value && <span className="absolute inset-x-2 -bottom-px h-[2px] rounded-full bg-accent-ink" aria-hidden />}
        </button>
      ))}
    </div>
  );
}

export function PageHeader({ title, description, actions, eyebrow }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; eyebrow?: ReactNode }) {
  return (
    <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between mb-6 animate-enter">
      <div className="min-w-0">
        {eyebrow && <div className="mb-1.5">{eyebrow}</div>}
        <h1 className="text-[22px] sm:text-[24px] font-semibold tracking-tight text-ink">{title}</h1>
        {description && <p className="mt-1 text-[13.5px] text-ink-3 max-w-2xl">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

/** Small "?" hint used next to financial definitions. */
export function InfoTip({ text }: { text: string }) {
  return (
    <span className="relative inline-flex group align-middle">
      <button type="button" aria-label={text} className="text-ink-3 hover:text-ink-2 cursor-help">
        <Info className="size-3.5" aria-hidden />
      </button>
      <span role="tooltip" className="pointer-events-none absolute left-1/2 bottom-full mb-2 -translate-x-1/2 w-60 rounded-lg bg-surface-3 px-3 py-2 text-[12px] leading-snug text-ink-2 ring-1 ring-white/10 shadow-xl opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity z-50">
        {text}
      </span>
    </span>
  );
}
