import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarPlus, Download, FileText, Plus, Search } from 'lucide-react';
import { api, errorMessage, qs } from '../lib/api.ts';
import { invalidateAll, useClients, useToday } from '../lib/queries.ts';
import { Button, Card, Checkbox, DemoBadge, EmptyState, ErrorState, Input, Notice, PageHeader, Segmented, Select, Skeleton } from '../components/ui.tsx';
import { Dialog, useToast } from '../components/overlay.tsx';
import { MoneyStack } from '../components/money.tsx';
import { InvoiceStatusBadge } from '../lib/status.tsx';
import { COMMON_CURRENCIES, type InvoiceStatus } from '../../shared/constants.ts';
import { formatMoney, type MoneyGroup } from '../../shared/money.ts';
import { addMonths, formatDate, monthKey, monthLabel } from '../../shared/dates.ts';
import { cx, useDebounced } from '../lib/util.ts';

type Row = { id: number; number: string; client_id: number; client_name: string; client_company: string | null; project_name: string | null; kind: string; currency: string; issue_date: string; due_date: string; status: InvoiceStatus; total_minor: number; paid_minor: number; balance_minor: number; days_overdue: number; is_demo: number };

function RetainerDraftsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const today = useToday();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [month, setMonth] = useState(monthKey(today));
  const [skip, setSkip] = useState<Set<number>>(new Set());
  const { data, isLoading } = useQuery({
    queryKey: ['retainer-drafts', month],
    queryFn: () => api.get<{ clients: { client_id: number; client_name: string; amount_minor: number; currency: string; billing_cycle: string; period_start: string; period_end: string; existing_invoice: { id: number; number: string } | null; is_demo: number }[] }>(`/api/invoices/retainer-drafts?month=${month}`),
    enabled: open,
  });
  const todo = (data?.clients ?? []).filter((c) => !c.existing_invoice && !skip.has(c.client_id));
  const create = useMutation({
    mutationFn: () => api.post<{ ids: number[] }>('/api/invoices/retainer-drafts', { month, client_ids: todo.map((c) => c.client_id) }),
    onSuccess: (r) => {
      invalidateAll(qc, 'invoices', 'retainer-drafts');
      toast.success(`${r.ids.length} draft invoice${r.ids.length === 1 ? '' : 's'} created — review and send them`);
      onClose();
      navigate('/invoices?status=draft');
    },
  });
  const months = [-1, 0, 1].map((d) => monthKey(addMonths(`${monthKey(today)}-01`, d)));
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Draft retainer invoices"
      description="Creates drafts for active retainer clients who are due an invoice this period. Nothing is sent — you review each one first."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!todo.length} loading={create.isPending} onClick={() => create.mutate()}>
            Create {todo.length || ''} draft{todo.length === 1 ? '' : 's'}
          </Button>
        </>
      }
    >
      <Segmented label="Billing month" value={month} onChange={setMonth} options={months.map((m) => ({ value: m, label: monthLabel(m, 'long') }))} />
      <div className="mt-4">
        {isLoading ? (
          <Skeleton className="h-24" />
        ) : (data?.clients ?? []).length === 0 ? (
          <Notice tone="info">No active retainer clients are due an invoice for {monthLabel(month, 'long')}.</Notice>
        ) : (
          <ul className="divide-y divide-line">
            {data!.clients.map((c) => (
              <li key={c.client_id} className="flex items-center gap-3 py-2.5">
                {c.existing_invoice ? (
                  <span className="text-[12px] text-ink-3 w-[18px]">✓</span>
                ) : (
                  <Checkbox
                    label={<span className="sr-only">Include {c.client_name}</span>}
                    checked={!skip.has(c.client_id)}
                    onChange={(v) => {
                      const next = new Set(skip);
                      if (v) next.delete(c.client_id);
                      else next.add(c.client_id);
                      setSkip(next);
                    }}
                  />
                )}
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] text-ink">
                    {c.client_name} {c.is_demo ? <DemoBadge /> : null}
                  </div>
                  <div className="text-[12px] text-ink-3">
                    {c.billing_cycle} · {formatDate(c.period_start)} – {formatDate(c.period_end)}
                    {c.existing_invoice ? (
                      <>
                        {' · already billed as '}
                        <Link className="text-accent-ink hover:underline" to={`/invoices/${c.existing_invoice.id}`} onClick={onClose}>
                          {c.existing_invoice.number}
                        </Link>
                      </>
                    ) : null}
                  </div>
                </div>
                <div className="text-[13px] font-medium tabular">{formatMoney(c.amount_minor, c.currency)}</div>
              </li>
            ))}
          </ul>
        )}
        {create.error && <Notice tone="bad" className="mt-3">{errorMessage(create.error)}</Notice>}
      </div>
    </Dialog>
  );
}

export default function InvoicesPage() {
  const today = useToday();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const status = params.get('status') ?? 'all';
  const [currency, setCurrency] = useState('');
  const [clientId, setClientId] = useState('');
  const [retainers, setRetainers] = useState(params.get('retainers') === '1');
  useEffect(() => {
    if (params.get('retainers') === '1') {
      setRetainers(true);
      params.delete('retainers');
      setParams(params, { replace: true });
    }
  }, [params, setParams]);
  const { data: clients } = useClients();
  const query = qs({ q: dq, status: status === 'all' ? undefined : status, currency, client_id: clientId });
  const { data, isLoading, error, refetch, isFetching } = useQuery({ queryKey: ['invoices', query], queryFn: () => api.get<{ invoices: Row[]; totals: { outstanding: MoneyGroup[]; overdue: MoneyGroup[]; drafts: number } }>(`/api/invoices${query}`) });
  const { data: allData } = useQuery({ queryKey: ['invoices', 'all-summary'], queryFn: () => api.get<{ invoices: Row[]; totals: { outstanding: MoneyGroup[]; overdue: MoneyGroup[]; drafts: number } }>('/api/invoices') });
  const all = allData?.invoices ?? [];
  const count = (s: string) => all.filter((i) => (s === 'open' ? ['sent', 'partially_paid', 'overdue'].includes(i.status) : i.status === s)).length;
  const setStatus = (s: string) => {
    const next = new URLSearchParams(params);
    if (s === 'all') next.delete('status');
    else next.set('status', s);
    setParams(next, { replace: true });
  };
  const rows = data?.invoices ?? [];
  return (
    <div>
      <PageHeader
        title="Invoices"
        description="Create, track and print invoices. An invoice is only “paid” once recorded payments cover it."
        actions={
          <>
            <Button icon={<CalendarPlus className="size-4" />} onClick={() => setRetainers(true)}>
              Draft retainer invoices
            </Button>
            <Button href={`/api/invoices/export.csv${query}`} download icon={<Download className="size-4" />}>
              Export CSV
            </Button>
            <Button variant="primary" icon={<Plus className="size-4" />} to="/invoices/new">
              New invoice
            </Button>
          </>
        }
      />
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-5">
        <Card className="p-4">
          <div className="text-[12.5px] text-ink-3 mb-2">Outstanding</div>
          <MoneyStack groups={allData?.totals.outstanding} size="lg" empty="Nothing owed" />
        </Card>
        <Card className="p-4">
          <div className="text-[12.5px] text-ink-3 mb-2">Overdue</div>
          <MoneyStack groups={allData?.totals.overdue} size="lg" tone="bad" empty={<span className="text-good">Nothing overdue</span>} />
        </Card>
        <Card className="p-4">
          <div className="text-[12.5px] text-ink-3 mb-2">Drafts waiting to be sent</div>
          <div className="text-[26px] font-semibold">{allData?.totals.drafts ?? '—'}</div>
        </Card>
      </div>

      <div className="flex flex-col xl:flex-row xl:items-center gap-2 mb-4">
        <div className="relative xl:max-w-64 w-full">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-ink-3" aria-hidden />
          <Input aria-label="Search invoices" placeholder="Number, client, project…" className="!pl-9" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <Segmented
          label="Status"
          value={status}
          onChange={setStatus}
          options={[
            { value: 'all', label: 'All', count: all.length },
            { value: 'draft', label: 'Drafts', count: count('draft') },
            { value: 'open', label: 'Open', count: count('open') },
            { value: 'overdue', label: 'Overdue', count: count('overdue') },
            { value: 'partially_paid', label: 'Partially paid', count: count('partially_paid') },
            { value: 'paid', label: 'Paid', count: count('paid') },
            { value: 'void', label: 'Void', count: count('void') },
          ]}
        />
        <Select aria-label="Client" value={clientId} onChange={(e) => setClientId(e.target.value)} className="xl:!w-44">
          <option value="">All clients</option>
          {(clients?.clients ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.company || c.name}
            </option>
          ))}
        </Select>
        <Select aria-label="Currency" value={currency} onChange={(e) => setCurrency(e.target.value)} className="xl:!w-32">
          <option value="">All currencies</option>
          {[...new Set([...all.map((i) => i.currency), ...COMMON_CURRENCIES.slice(0, 2)])].map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </Select>
      </div>

      <Card className={cx('overflow-hidden', isFetching && !isLoading && 'opacity-70')}>
        {isLoading ? (
          <div className="p-4 flex flex-col gap-2">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-11" />
            ))}
          </div>
        ) : error ? (
          <ErrorState error={error} onRetry={() => refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState icon={<FileText className="size-5" />} title={all.length ? 'No invoices match' : 'No invoices yet'} body={all.length ? 'Try another filter.' : 'Create your first invoice, or draft this month’s retainer invoices in one go.'} action={!all.length ? <Button variant="primary" to="/invoices/new" icon={<Plus className="size-4" />}>New invoice</Button> : undefined} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead className="text-left text-[12px] text-ink-3 border-b border-line">
                <tr>
                  <th className="py-2.5 px-5 font-medium">Invoice</th>
                  <th className="py-2.5 px-3 font-medium">Client</th>
                  <th className="py-2.5 px-3 font-medium">Issued</th>
                  <th className="py-2.5 px-3 font-medium">Due</th>
                  <th className="py-2.5 px-3 font-medium">Status</th>
                  <th className="py-2.5 px-3 font-medium text-right">Total</th>
                  <th className="py-2.5 px-5 font-medium text-right">Balance</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((i) => (
                  <tr key={i.id} onClick={() => navigate(`/invoices/${i.id}`)} className={cx('border-b border-line last:border-0 hover:bg-white/[0.025] cursor-pointer', i.status === 'void' && 'opacity-60')}>
                    <td className="py-3 px-5">
                      <Link to={`/invoices/${i.id}`} onClick={(e) => e.stopPropagation()} className="font-medium text-ink hover:underline">
                        {i.number}
                      </Link>{' '}
                      {i.is_demo ? <DemoBadge /> : null}
                      <div className="text-[11.5px] text-ink-3">{i.kind === 'retainer' ? 'Retainer' : i.project_name ?? 'One-off'}</div>
                    </td>
                    <td className="py-3 px-3 text-ink-2">{i.client_company || i.client_name}</td>
                    <td className="py-3 px-3 text-ink-2 tabular">{formatDate(i.issue_date, today)}</td>
                    <td className={cx('py-3 px-3 tabular', i.status === 'overdue' ? 'text-bad' : 'text-ink-2')}>{formatDate(i.due_date, today)}</td>
                    <td className="py-3 px-3">
                      <InvoiceStatusBadge status={i.status} daysOverdue={i.days_overdue} />
                    </td>
                    <td className="py-3 px-3 text-right tabular text-ink">{formatMoney(i.total_minor, i.currency, { decimals: 'always' })}</td>
                    <td className={cx('py-3 px-5 text-right tabular font-medium', i.balance_minor > 0 && !['draft', 'void'].includes(i.status) ? (i.status === 'overdue' ? 'text-bad' : 'text-ink') : 'text-ink-3 font-normal')}>
                      {i.status === 'void' ? '—' : formatMoney(i.balance_minor, i.currency, { decimals: 'always' })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <RetainerDraftsDialog open={retainers} onClose={() => setRetainers(false)} />
    </div>
  );
}
