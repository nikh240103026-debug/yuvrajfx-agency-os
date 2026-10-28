import { formatMoney } from '../../shared/money.ts';
import { formatDateLong } from '../../shared/dates.ts';
import { INVOICE_STATUS_LABELS, type InvoiceStatus } from '../../shared/constants.ts';
import { cx } from '../lib/util.ts';

export type InvoiceDetail = {
  id: number;
  number: string;
  client_id: number;
  project_id: number | null;
  kind: 'standard' | 'retainer';
  currency: string;
  issue_date: string;
  due_date: string;
  period_start: string | null;
  period_end: string | null;
  state: 'draft' | 'sent' | 'void';
  status: InvoiceStatus;
  discount_type: 'none' | 'percent' | 'fixed';
  discount_percent: number;
  discount_fixed_minor: number;
  taxes: { label: string; rate: number }[];
  tax_lines: { label: string; rate: number; amount_minor: number }[];
  subtotal_minor: number;
  discount_minor: number;
  taxable_minor: number;
  tax_minor: number;
  total_minor: number;
  paid_minor: number;
  balance_minor: number;
  notes: string | null;
  terms: string | null;
  internal_notes?: string | null;
  sent_at: string | null;
  voided_at: string | null;
  void_reason?: string | null;
  portal_visible: number;
  is_demo: number;
  days_overdue: number;
  items: { id: number; description: string; quantity: number; unit_price_minor: number; amount_minor: number; service_type: string }[];
  payments: { id: number; amount_minor: number; currency: string; paid_at: string; method: string; reference: string | null; notes?: string | null; recorded_by?: string | null }[];
  client: { id: number; name: string; company: string | null; email: string | null; phone: string | null; billing_address: string | null; tax_id: string | null; country: string | null } | null;
  project: { id: number; name: string } | null;
};

export type BusinessProfile = { name: string; email: string; phone: string; address: string; website: string; tax_id_label: string; tax_id: string; payment_instructions: string; footer: string };

function qty(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

/** The invoice as the client receives it. Always rendered as light "paper", on screen and in print. */
export function InvoiceDocument({ invoice: inv, business: b, className }: { invoice: InvoiceDetail; business: BusinessProfile; className?: string }) {
  const m = (v: number) => formatMoney(v, inv.currency, { decimals: 'always' });
  const watermark = inv.state === 'void' ? 'VOID' : inv.is_demo ? 'DEMO' : inv.status === 'paid' ? 'PAID' : null;
  return (
    <article className={cx('print-sheet relative mx-auto bg-white text-[#16161d] rounded-xl shadow-[0_30px_80px_-20px_rgb(0_0_0/0.7)] overflow-hidden', className)} style={{ fontFeatureSettings: "'tnum'" }}>
      {watermark && (
        <div aria-hidden className={cx('pointer-events-none absolute right-8 top-28 rotate-[-14deg] rounded-lg border-[3px] px-4 py-1 text-[28px] font-extrabold tracking-[0.2em] opacity-[0.16]', watermark === 'PAID' ? 'border-[#0a8f0a] text-[#0a8f0a]' : watermark === 'VOID' ? 'border-[#c02a2a] text-[#c02a2a]' : 'border-[#b07800] text-[#b07800]')}>
          {watermark}
        </div>
      )}
      <div className="h-1.5 bg-gradient-to-r from-[#6c5ce7] via-[#9085e9] to-[#cdc4ff]" aria-hidden />
      <div className="p-8 sm:p-10">
        <header className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-6">
          <div>
            <div className="flex items-center gap-2.5">
              <svg viewBox="0 0 64 64" className="size-9" aria-hidden>
                <rect width="64" height="64" rx="16" fill="#16161d" />
                <path d="M19 17h9l4 10 4-10h9l-9 18v12h-8V35z" fill="#9085e9" />
              </svg>
              <div className="text-[19px] font-semibold tracking-tight">{b.name}</div>
            </div>
            <div className="mt-3 text-[12px] leading-relaxed text-[#55556a] whitespace-pre-line">
              {[b.address, [b.email, b.phone].filter(Boolean).join(' · '), b.website, b.tax_id ? `${b.tax_id_label || 'Tax ID'}: ${b.tax_id}` : ''].filter(Boolean).join('\n')}
            </div>
          </div>
          <div className="sm:text-right">
            <div className="text-[11px] font-semibold tracking-[0.18em] text-[#6c5ce7]">INVOICE</div>
            <div className="text-[22px] font-semibold tracking-tight mt-0.5">{inv.number}</div>
            <dl className="mt-3 grid grid-cols-[auto_auto] sm:justify-end gap-x-4 gap-y-0.5 text-[12px]">
              <dt className="text-[#77778a]">Issued</dt>
              <dd>{formatDateLong(inv.issue_date)}</dd>
              <dt className="text-[#77778a]">Due</dt>
              <dd className="font-medium">{formatDateLong(inv.due_date)}</dd>
              {inv.period_start && (
                <>
                  <dt className="text-[#77778a]">Period</dt>
                  <dd>
                    {formatDateLong(inv.period_start)}
                    {inv.period_end ? ` – ${formatDateLong(inv.period_end)}` : ''}
                  </dd>
                </>
              )}
            </dl>
          </div>
        </header>

        <section className="mt-8 grid sm:grid-cols-2 gap-6">
          <div>
            <div className="text-[10.5px] font-semibold tracking-[0.14em] text-[#77778a] mb-1.5">BILL TO</div>
            {inv.client ? (
              <div className="text-[13px] leading-relaxed">
                <div className="font-semibold">{inv.client.company || inv.client.name}</div>
                {inv.client.company && <div>{inv.client.name}</div>}
                {inv.client.billing_address && <div className="whitespace-pre-line text-[#44445a]">{inv.client.billing_address}</div>}
                {inv.client.country && !inv.client.billing_address && <div className="text-[#44445a]">{inv.client.country}</div>}
                {inv.client.email && <div className="text-[#44445a]">{inv.client.email}</div>}
                {inv.client.tax_id && <div className="text-[#44445a]">Tax ID: {inv.client.tax_id}</div>}
              </div>
            ) : (
              <div className="text-[13px] text-[#77778a]">—</div>
            )}
          </div>
          <div className="sm:text-right">
            <div className="text-[10.5px] font-semibold tracking-[0.14em] text-[#77778a] mb-1.5">AMOUNT DUE</div>
            <div className="text-[26px] font-semibold tracking-tight">{m(inv.state === 'void' ? 0 : inv.balance_minor)}</div>
            <div className="text-[12px] text-[#77778a]">
              {inv.currency}
              {inv.project ? ` · ${inv.project.name}` : ''}
            </div>
          </div>
        </section>

        <table className="mt-8 w-full text-[13px]">
          <thead>
            <tr className="border-b-2 border-[#16161d] text-left text-[11px] tracking-[0.08em] text-[#55556a]">
              <th className="py-2 pr-3 font-semibold">DESCRIPTION</th>
              <th className="py-2 px-3 font-semibold text-right w-16">QTY</th>
              <th className="py-2 px-3 font-semibold text-right w-32">RATE</th>
              <th className="py-2 pl-3 font-semibold text-right w-36">AMOUNT</th>
            </tr>
          </thead>
          <tbody>
            {inv.items.map((it) => (
              <tr key={it.id} className="border-b border-[#e6e6ee] align-top">
                <td className="py-3 pr-3 whitespace-pre-line">{it.description}</td>
                <td className="py-3 px-3 text-right">{qty(it.quantity)}</td>
                <td className="py-3 px-3 text-right">{m(it.unit_price_minor)}</td>
                <td className="py-3 pl-3 text-right font-medium">{m(it.amount_minor)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="mt-4 flex justify-end">
          <dl className="w-full sm:w-80 text-[13px]">
            <div className="flex justify-between py-1.5">
              <dt className="text-[#55556a]">Subtotal</dt>
              <dd>{m(inv.subtotal_minor)}</dd>
            </div>
            {inv.discount_minor > 0 && (
              <div className="flex justify-between py-1.5">
                <dt className="text-[#55556a]">Discount{inv.discount_type === 'percent' ? ` (${inv.discount_percent}%)` : ''}</dt>
                <dd>−{m(inv.discount_minor)}</dd>
              </div>
            )}
            {inv.tax_lines.map((t) => (
              <div key={t.label} className="flex justify-between py-1.5">
                <dt className="text-[#55556a]">
                  {t.label} ({t.rate}%)
                </dt>
                <dd>{m(t.amount_minor)}</dd>
              </div>
            ))}
            <div className="flex justify-between py-2 mt-1 border-t-2 border-[#16161d] text-[15px] font-semibold">
              <dt>Total</dt>
              <dd>{m(inv.total_minor)}</dd>
            </div>
            {inv.paid_minor > 0 && (
              <>
                <div className="flex justify-between py-1.5 text-[#0a7a0a]">
                  <dt>Paid</dt>
                  <dd>−{m(inv.paid_minor)}</dd>
                </div>
                <div className="flex justify-between py-1.5 font-semibold">
                  <dt>Balance due</dt>
                  <dd>{m(inv.balance_minor)}</dd>
                </div>
              </>
            )}
          </dl>
        </div>

        {(b.payment_instructions || inv.notes || inv.terms) && (
          <section className="mt-10 grid sm:grid-cols-2 gap-6 text-[12.5px] leading-relaxed">
            {b.payment_instructions && (
              <div>
                <div className="text-[10.5px] font-semibold tracking-[0.14em] text-[#77778a] mb-1.5">HOW TO PAY</div>
                <p className="whitespace-pre-line text-[#33334a]">{b.payment_instructions}</p>
              </div>
            )}
            {(inv.notes || inv.terms) && (
              <div>
                {inv.notes && (
                  <>
                    <div className="text-[10.5px] font-semibold tracking-[0.14em] text-[#77778a] mb-1.5">NOTES</div>
                    <p className="whitespace-pre-line text-[#33334a] mb-3">{inv.notes}</p>
                  </>
                )}
                {inv.terms && (
                  <>
                    <div className="text-[10.5px] font-semibold tracking-[0.14em] text-[#77778a] mb-1.5">TERMS</div>
                    <p className="whitespace-pre-line text-[#33334a]">{inv.terms}</p>
                  </>
                )}
              </div>
            )}
          </section>
        )}

        <footer className="mt-10 pt-5 border-t border-[#e6e6ee] flex flex-wrap items-center justify-between gap-2 text-[11.5px] text-[#77778a]">
          <span>{b.footer}</span>
          <span>
            {inv.number} · {INVOICE_STATUS_LABELS[inv.status]}
          </span>
        </footer>
      </div>
    </article>
  );
}
