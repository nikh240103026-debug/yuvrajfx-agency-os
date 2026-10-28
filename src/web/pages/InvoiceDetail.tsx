import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Ban, Copy, CreditCard, FilePen, Mail, MoreHorizontal, Pencil, Printer, Send, Trash2, Undo2 } from 'lucide-react';
import { api, errorMessage } from '../lib/api.ts';
import { invalidateAll, useToday } from '../lib/queries.ts';
import { Badge, Button, Card, CardHeader, DemoBadge, ErrorState, IconButton, Notice, PageSkeleton } from '../components/ui.tsx';
import { Menu, useConfirm, useToast } from '../components/overlay.tsx';
import { PaymentDialog } from '../components/forms.tsx';
import { InvoiceDocument, type BusinessProfile, type InvoiceDetail } from '../components/invoice-document.tsx';
import { InvoiceStatusBadge } from '../lib/status.tsx';
import { PAYMENT_METHOD_LABELS } from '../../shared/constants.ts';
import { formatMoney } from '../../shared/money.ts';
import { formatDate } from '../../shared/dates.ts';
import { cx, timeAgo } from '../lib/util.ts';

export default function InvoiceDetailPage() {
  const { id } = useParams();
  const today = useToday();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { confirm, prompt } = useConfirm();
  const [paying, setPaying] = useState(false);
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['invoice', id], queryFn: () => api.get<{ invoice: InvoiceDetail; business: BusinessProfile }>(`/api/invoices/${id}`) });
  const activity = useQuery({ queryKey: ['activity', 'invoice', id], queryFn: () => api.get<{ items: { id: number; summary: string; actor_name: string | null; created_at: string }[] }>(`/api/activity?invoice_id=${id}&limit=30`) });
  const refresh = () => invalidateAll(qc, 'invoice', 'invoices', 'payments', 'finance', 'client', 'clients');
  const action = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: unknown }): Promise<{ id?: number; outbox_id?: number } | null> => (path === 'delete' ? api.del(`/api/invoices/${id}`) : api.post(`/api/invoices/${id}/${path}`, body ?? {})),
    onSuccess: (res, v) => {
      refresh();
      if (v.path === 'send') toast.success('Marked as sent. It now counts as invoiced revenue and as outstanding until paid.');
      if (v.path === 'void') toast.success('Invoice voided');
      if (v.path === 'revert-to-draft') toast.success('Moved back to draft');
      if (v.path === 'duplicate' && res?.id) navigate(`/invoices/${res.id}/edit`);
      if (v.path === 'delete') navigate('/invoices');
      if (v.path === 'draft-email') toast.success('Email drafted in Automations → Outbox. It is sent only after you approve it.', { label: 'Open outbox', onClick: () => navigate('/automations?tab=outbox') });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const removePayment = useMutation({
    mutationFn: (pid: number) => api.del(`/api/payments/${pid}`),
    onSuccess: () => {
      refresh();
      toast.success('Payment removed — the balance was recalculated');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (isLoading) return <PageSkeleton />;
  if (error || !data) return <ErrorState error={error} onRetry={() => refetch()} />;
  const inv = data.invoice;
  const m = (v: number) => formatMoney(v, inv.currency, { decimals: 'always' });
  const canPay = inv.state !== 'void' && inv.balance_minor > 0;
  const hasPayments = inv.payments.length > 0;

  return (
    <div>
      <Link to="/invoices" className="inline-flex items-center gap-1 text-[12.5px] text-ink-3 hover:text-ink mb-3 no-print">
        <ArrowLeft className="size-3.5" /> Invoices
      </Link>
      <header className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between mb-6 animate-enter">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-[24px] font-semibold tracking-tight">{inv.number}</h1>
            <InvoiceStatusBadge status={inv.status} daysOverdue={inv.days_overdue} />
            {inv.kind === 'retainer' && <Badge tone="accent">Retainer</Badge>}
            {inv.is_demo ? <DemoBadge /> : null}
          </div>
          <p className="mt-1 text-[13.5px] text-ink-3">
            <Link className="text-ink-2 hover:underline" to={`/clients/${inv.client_id}`}>
              {inv.client?.company || inv.client?.name}
            </Link>
            {inv.project ? (
              <>
                {' · '}
                <Link className="hover:underline" to={`/projects/${inv.project.id}`}>
                  {inv.project.name}
                </Link>
              </>
            ) : null}
            {' · '}issued {formatDate(inv.issue_date, today)} · due {formatDate(inv.due_date, today)}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {inv.state === 'draft' && (
            <Button
              variant="primary"
              icon={<Send className="size-4" />}
              onClick={async () => {
                if (await confirm({ title: `Mark ${inv.number} as sent?`, body: 'Do this after you have sent the invoice to your client (by email, WhatsApp…). From then on it counts as invoiced revenue and appears in outstanding balances and the client portal.', confirmLabel: 'Mark as sent' })) action.mutate({ path: 'send' });
              }}
            >
              Mark as sent
            </Button>
          )}
          {canPay && (
            <Button variant={inv.state === 'draft' ? 'secondary' : 'primary'} icon={<CreditCard className="size-4" />} onClick={() => setPaying(true)}>
              Record payment
            </Button>
          )}
          <Button icon={<Printer className="size-4" />} href={`/invoices/${inv.id}/print`}>
            Print / PDF
          </Button>
          {inv.state !== 'void' && (
            <Button icon={<Pencil className="size-4" />} to={`/invoices/${inv.id}/edit`}>
              Edit
            </Button>
          )}
          <Menu
            label="More"
            button={(p) => (
              <IconButton label="More actions" {...p}>
                <MoreHorizontal className="size-4" />
              </IconButton>
            )}
            items={[
              ...(inv.state !== 'void'
                ? [
                    { label: inv.state === 'draft' ? 'Draft cover email' : 'Draft payment reminder', icon: <Mail />, onSelect: () => action.mutate({ path: 'draft-email', body: { purpose: inv.state === 'draft' || inv.status === 'sent' ? 'send' : 'reminder' } }) },
                  ]
                : []),
              { label: 'Duplicate as new draft', icon: <Copy />, onSelect: () => action.mutate({ path: 'duplicate' }) },
              ...(inv.state === 'sent' && !hasPayments ? [{ label: 'Move back to draft', icon: <Undo2 />, onSelect: () => action.mutate({ path: 'revert-to-draft' }) }] : []),
              { divider: true as const },
              ...(inv.state === 'sent' && !hasPayments
                ? [
                    {
                      label: 'Void invoice',
                      icon: <Ban />,
                      danger: true,
                      onSelect: async () => {
                        const reason = await prompt({ title: `Void ${inv.number}?`, body: 'Voided invoices stay in your records but no longer count as revenue or outstanding.', confirmLabel: 'Void invoice', danger: true, input: { label: 'Reason', placeholder: 'e.g. Issued twice', required: false } });
                        if (reason !== null) action.mutate({ path: 'void', body: { reason } });
                      },
                    },
                  ]
                : []),
              ...(inv.state === 'draft' && !hasPayments
                ? [
                    {
                      label: 'Delete draft',
                      icon: <Trash2 />,
                      danger: true,
                      onSelect: async () => {
                        if (await confirm({ title: `Delete draft ${inv.number}?`, confirmLabel: 'Delete', danger: true })) action.mutate({ path: 'delete' });
                      },
                    },
                  ]
                : []),
              ...(hasPayments && inv.state === 'sent' ? [{ label: 'To void: remove its payments first', icon: <FilePen />, disabled: true, onSelect: () => undefined }] : []),
            ]}
          />
        </div>
      </header>

      {inv.state === 'void' && (
        <Notice tone="warn" className="mb-4">
          Voided {inv.voided_at ? timeAgo(inv.voided_at) : ''}
          {inv.void_reason ? `: ${inv.void_reason}` : ''}. It no longer counts toward revenue or receivables.
        </Notice>
      )}
      {inv.state === 'draft' && (
        <Notice tone="info" className="mb-4">
          Draft — not counted as revenue yet. Print or download it, send it to your client, then press “Mark as sent”. Nothing is emailed automatically.
        </Notice>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_340px] gap-4">
        <div className="min-w-0 overflow-x-auto">
          <InvoiceDocument invoice={inv} business={data.business} className="max-w-[820px]" />
        </div>
        <aside className="flex flex-col gap-4">
          <Card className="p-5">
            <dl className="flex flex-col gap-2 text-[13px]">
              <div className="flex justify-between">
                <dt className="text-ink-3">Total</dt>
                <dd className="tabular font-medium">{m(inv.total_minor)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-ink-3">Paid</dt>
                <dd className="tabular text-good">{m(inv.paid_minor)}</dd>
              </div>
              <div className="flex justify-between pt-2 border-t border-line">
                <dt className="font-medium">Balance due</dt>
                <dd className={cx('tabular text-[18px] font-semibold', inv.status === 'overdue' ? 'text-bad' : '')}>{inv.state === 'void' ? '—' : m(inv.balance_minor)}</dd>
              </div>
            </dl>
            {inv.total_minor > 0 && inv.state !== 'void' && (
              <div className="mt-3 h-1.5 rounded-full bg-good-dot/15 overflow-hidden" role="meter" aria-label="Share paid" aria-valuemin={0} aria-valuemax={inv.total_minor} aria-valuenow={inv.paid_minor}>
                <div className="h-full rounded-full bg-good-dot" style={{ width: `${(inv.paid_minor / inv.total_minor) * 100}%` }} />
              </div>
            )}
            {inv.status === 'overdue' && <p className="mt-3 text-[12.5px] text-bad">{inv.days_overdue} day{inv.days_overdue === 1 ? '' : 's'} overdue.</p>}
          </Card>
          <Card>
            <CardHeader title="Payments" action={canPay && <Button size="xs" icon={<CreditCard className="size-3" />} onClick={() => setPaying(true)}>Record</Button>} />
            {inv.payments.length === 0 ? (
              <p className="px-5 pb-4 text-[12.5px] text-ink-3">No payments recorded.</p>
            ) : (
              <ul className="px-5 pb-3 divide-y divide-line">
                {inv.payments.map((p) => (
                  <li key={p.id} className="flex items-start gap-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-medium tabular">{m(p.amount_minor)}</div>
                      <div className="text-[12px] text-ink-3">
                        {formatDate(p.paid_at, today)} · {PAYMENT_METHOD_LABELS[p.method as keyof typeof PAYMENT_METHOD_LABELS] ?? p.method}
                        {p.reference ? ` · ${p.reference}` : ''}
                      </div>
                      {p.notes && <div className="text-[12px] text-ink-3 mt-0.5">{p.notes}</div>}
                    </div>
                    <IconButton
                      size="sm"
                      label="Remove payment"
                      onClick={async () => {
                        if (await confirm({ title: 'Remove this payment?', body: `${m(p.amount_minor)} on ${formatDate(p.paid_at)}. The invoice balance and status are recalculated.`, confirmLabel: 'Remove payment', danger: true })) removePayment.mutate(p.id);
                      }}
                    >
                      <Trash2 className="size-3.5" />
                    </IconButton>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          {inv.internal_notes && (
            <Card className="p-5">
              <h3 className="label-caps mb-1.5">Internal notes</h3>
              <p className="text-[12.5px] text-ink-2 whitespace-pre-wrap">{inv.internal_notes}</p>
            </Card>
          )}
          <Card>
            <CardHeader title="History" />
            <ol className="px-5 pb-4 flex flex-col gap-2">
              {(activity.data?.items ?? []).map((a) => (
                <li key={a.id} className="text-[12.5px]">
                  <p className="text-ink-2">{a.summary}</p>
                  <p className="text-[11px] text-ink-3">
                    {a.actor_name ?? 'System'} · {timeAgo(a.created_at)}
                  </p>
                </li>
              ))}
              {activity.data && activity.data.items.length === 0 && <li className="text-[12.5px] text-ink-3">No history yet.</li>}
            </ol>
          </Card>
        </aside>
      </div>
      {canPay && <PaymentDialog open={paying} onClose={() => setPaying(false)} invoice={inv} />}
    </div>
  );
}
