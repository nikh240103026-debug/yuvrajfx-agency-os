import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CheckCircle2, AlertTriangle, Info, X } from 'lucide-react';
import { Button, IconButton, Input } from './ui.tsx';
import { cx } from '../lib/util.ts';

// ── Dialog & Drawer (native <dialog>: focus trap, Esc, inert background) ────

type DialogProps = {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  variant?: 'modal' | 'drawer';
};

const WIDTHS = { sm: 'w-[min(420px,calc(100vw-24px))]', md: 'w-[min(560px,calc(100vw-24px))]', lg: 'w-[min(760px,calc(100vw-24px))]', xl: 'w-[min(1000px,calc(100vw-24px))]' };

export function Dialog({ open, onClose, title, description, children, footer, size = 'md', variant = 'modal' }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  const drawer = variant === 'drawer';
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onMouseDown={(e) => {
        if (e.target === ref.current) onClose();
      }}
      className={cx(
        'p-0 bg-transparent backdrop:bg-black/60 overflow-visible',
        drawer ? 'm-0 ml-auto h-dvh max-h-dvh w-[min(600px,100vw)] max-w-none' : cx('m-auto max-h-[calc(100dvh-32px)]', WIDTHS[size]),
      )}
    >
      {open && (
        <div
          className={cx(
            'flex flex-col bg-surface border border-line-strong shadow-[0_24px_80px_-12px_rgb(0_0_0/0.7)]',
            drawer ? 'h-full rounded-l-2xl animate-slide-in' : 'max-h-[calc(100dvh-32px)] rounded-2xl animate-pop',
          )}
        >
          <div className="flex items-start justify-between gap-4 px-5 pt-4 pb-3 border-b border-line">
            <div className="min-w-0">
              <h2 id={titleId} className="text-[15px] font-semibold text-ink">
                {title}
              </h2>
              {description && <p className="mt-0.5 text-[12.5px] text-ink-3">{description}</p>}
            </div>
            <IconButton label="Close" size="sm" onClick={onClose} className="-mr-1.5 -mt-0.5">
              <X className="size-4" />
            </IconButton>
          </div>
          <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer && <div className="flex flex-wrap items-center justify-end gap-2 px-5 py-3 border-t border-line bg-white/[0.015] rounded-b-2xl">{footer}</div>}
        </div>
      )}
    </dialog>
  );
}

// ── Dropdown menu ─────────────────────────────────────────────────────────────

export type MenuItem =
  | { label: ReactNode; icon?: ReactNode; onSelect: () => void; danger?: boolean; disabled?: boolean; hint?: ReactNode }
  | { divider: true }
  | { heading: ReactNode };

export function Menu({ button, items, align = 'end', label }: { button: (props: { onClick: () => void; 'aria-expanded': boolean; 'aria-haspopup': 'menu' }) => ReactNode; items: MenuItem[]; align?: 'start' | 'end'; label: string }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    requestAnimationFrame(() => list.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus());
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const els = [...(list.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? [])];
    const i = els.indexOf(document.activeElement as HTMLElement);
    els[(i + (e.key === 'ArrowDown' ? 1 : -1) + els.length) % els.length]?.focus();
  };
  return (
    <div ref={wrap} className="relative inline-flex">
      {button({ onClick: () => setOpen((v) => !v), 'aria-expanded': open, 'aria-haspopup': 'menu' })}
      {open && (
        <div
          ref={list}
          role="menu"
          aria-label={label}
          onKeyDown={onKeyDown}
          className={cx(
            'absolute top-full mt-1.5 z-40 min-w-52 max-w-72 rounded-xl bg-surface-2 border border-line-strong p-1 shadow-[0_16px_48px_-8px_rgb(0_0_0/0.65)] animate-pop',
            align === 'end' ? 'right-0' : 'left-0',
          )}
        >
          {items.map((item, i) => {
            if ('divider' in item) return <div key={i} className="my-1 h-px bg-line" role="separator" />;
            if ('heading' in item)
              return (
                <div key={i} className="px-2.5 pt-2 pb-1 label-caps">
                  {item.heading}
                </div>
              );
            return (
              <button
                key={i}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                onClick={() => {
                  setOpen(false);
                  item.onSelect();
                }}
                className={cx(
                  'flex w-full items-center gap-2.5 rounded-lg px-2.5 h-8 text-left text-[13px] cursor-pointer outline-none disabled:opacity-40 disabled:cursor-not-allowed',
                  item.danger ? 'text-bad hover:bg-bad-dot/12 focus:bg-bad-dot/12' : 'text-ink hover:bg-white/[0.06] focus:bg-white/[0.06]',
                )}
              >
                {item.icon && <span className="text-ink-3 [&_svg]:size-4" aria-hidden>{item.icon}</span>}
                <span className="flex-1 truncate">{item.label}</span>
                {item.hint && <span className="text-[11px] text-ink-3">{item.hint}</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Toasts ───────────────────────────────────────────────────────────────────

type Toast = { id: number; tone: 'success' | 'error' | 'info'; message: ReactNode; action?: { label: string; onClick: () => void } };
type ToastApi = {
  success: (m: ReactNode, action?: Toast['action']) => void;
  error: (m: ReactNode) => void;
  info: (m: ReactNode, action?: Toast['action']) => void;
};

const ToastCtx = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((tone: Toast['tone'], message: ReactNode, action?: Toast['action']) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, tone, message, action }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'error' ? 7000 : 4200);
  }, []);
  const apiRef = useRef<ToastApi>({ success: (m, a) => push('success', m, a), error: (m) => push('error', m), info: (m, a) => push('info', m, a) });
  return (
    <ToastCtx.Provider value={apiRef.current}>
      {children}
      {createPortal(
        <div aria-live="polite" className="fixed z-[100] bottom-4 right-4 left-4 sm:left-auto flex flex-col gap-2 items-stretch sm:items-end pointer-events-none no-print">
          {toasts.map((t) => (
            <div key={t.id} role={t.tone === 'error' ? 'alert' : 'status'} className="pointer-events-auto flex items-start gap-2.5 rounded-xl bg-surface-2 border border-line-strong pl-3 pr-2 py-2.5 text-[13px] text-ink shadow-[0_16px_40px_-8px_rgb(0_0_0/0.7)] animate-pop sm:max-w-sm">
              <span className="mt-[1px]" aria-hidden>
                {t.tone === 'success' ? <CheckCircle2 className="size-4 text-good" /> : t.tone === 'error' ? <AlertTriangle className="size-4 text-bad" /> : <Info className="size-4 text-info" />}
              </span>
              <div className="flex-1 min-w-0">{t.message}</div>
              {t.action && (
                <button type="button" className="text-accent-ink font-medium hover:underline cursor-pointer px-1" onClick={t.action.onClick}>
                  {t.action.label}
                </button>
              )}
              <button type="button" aria-label="Dismiss" onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))} className="text-ink-3 hover:text-ink cursor-pointer">
                <X className="size-3.5" />
              </button>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </ToastCtx.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastCtx);
  if (!ctx) throw new Error('useToast outside ToastProvider');
  return ctx;
}

// ── Confirm / prompt ─────────────────────────────────────────────────────────

type ConfirmOpts = { title: ReactNode; body?: ReactNode; confirmLabel?: string; danger?: boolean; input?: { label: string; placeholder?: string; required?: boolean } };
type ConfirmState = ConfirmOpts & { resolve: (v: { ok: boolean; value: string }) => void };
const ConfirmCtx = createContext<((o: ConfirmOpts) => Promise<{ ok: boolean; value: string }>) | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ConfirmState | null>(null);
  const [value, setValue] = useState('');
  const ask = useCallback((o: ConfirmOpts) => new Promise<{ ok: boolean; value: string }>((resolve) => {
    setValue('');
    setState({ ...o, resolve });
  }), []);
  const close = (ok: boolean) => {
    state?.resolve({ ok, value: value.trim() });
    setState(null);
  };
  return (
    <ConfirmCtx.Provider value={ask}>
      {children}
      <Dialog
        open={!!state}
        onClose={() => close(false)}
        title={state?.title}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => close(false)}>
              Cancel
            </Button>
            <Button variant={state?.danger ? 'danger' : 'primary'} disabled={!!state?.input?.required && !value.trim()} onClick={() => close(true)}>
              {state?.confirmLabel ?? 'Confirm'}
            </Button>
          </>
        }
      >
        {state?.body && <div className="text-[13.5px] text-ink-2 leading-relaxed">{state.body}</div>}
        {state?.input && (
          <div className="mt-3 flex flex-col gap-1.5">
            <label className="text-[12.5px] font-medium text-ink-2">{state.input.label}</label>
            <Input autoFocus value={value} placeholder={state.input.placeholder} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (!state.input?.required || value.trim()) && close(true)} />
          </div>
        )}
      </Dialog>
    </ConfirmCtx.Provider>
  );
}

export function useConfirm() {
  const ask = useContext(ConfirmCtx);
  if (!ask) throw new Error('useConfirm outside ConfirmProvider');
  return {
    confirm: async (o: Omit<ConfirmOpts, 'input'>) => (await ask(o)).ok,
    prompt: async (o: ConfirmOpts & { input: NonNullable<ConfirmOpts['input']> }) => {
      const r = await ask(o);
      return r.ok ? r.value : null;
    },
  };
}
