import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { CreditCard, Download, Search } from 'lucide-react';
import { api, qs } from '../lib/api.ts';
import { useClients, useToday } from '../lib/queries.ts';
import { Button, Card, DemoBadge, EmptyState, ErrorState, Input, PageHeader, Select, Skeleton } from '../components/ui.tsx';
import { MoneyStack } from '../components/money.tsx';
import { PAYMENT_METHOD_LABELS, PAYMENT_METHOD_OPTIONS } from '../../shared/constants.ts';
import { formatMoney, type MoneyGroup } from '../../shared/money.ts';
import { formatDate, startOfMonth, startOfYear } from '../../shared/dates.ts';
import { cx, useDebounced } from '../lib/util.ts';

type Payment = { id: number; invoice_id: number; number: string; client_id: number; client_name: string; amount_minor: number; currency: string; paid_at: string; method: string; reference: string | null; notes: string | null; is_demo: number; recorded_by: string | null };

export default function PaymentsPage() {
  const today = useToday();
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const [method, setMethod] = useState('');
  const [clientId, setClientId] = useState('');
  const [range, setRange] = useState<'all' | 'month' | 'year' | 'custom'>('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const { data: clients } = useClients();
  const dates = range === 'month' ? { from: startOfMonth(today), to: today } : range === 'year' ? { from: startOfYear(today), to: today } : range === 'custom' ? { from, to } : { from: '', to: '' };
  const query = qs({ q: dq, method, client_id: clientId, ...dates });
  const { data, isLoading, error, refetch, isFetching } = useQuery({ queryKey: ['payments', query], queryFn: () => api.get<{ payments: Payment[]; totals: MoneyGroup[] }>(`/api/payments${query}`) });
  const rows = data?.payments ?? [];
  return (
    <div>
      <PageHeader
        title="Payments"
        description="Every payment you recorded against an invoice. This is your actual cash in."
        actions={
          <Button href={`/api/payments/export.csv${query}`} download icon={<Download className="size-4" />}>
            Export CSV
          </Button>
        }
      />
      <div className="flex flex-col lg:flex-row lg:items-center gap-2 mb-4">
        <div className="relative lg:max-w-64 w-full">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-ink-3" aria-hidden />
          <Input aria-label="Search payments" placeholder="Invoice, client, reference…" className="!pl-9" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <Select aria-label="Client" value={clientId} onChange={(e) => setClientId(e.target.value)} className="lg:!w-44">
          <option value="">All clients</option>
          {(clients?.clients ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.company || c.name}
            </option>
          ))}
        </Select>
        <Select aria-label="Method" value={method} onChange={(e) => setMethod(e.target.value)} className="lg:!w-40">
          <option value="">All methods</option>
          {PAYMENT_METHOD_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
        <Select aria-label="Date range" value={range} onChange={(e) => setRange(e.target.value as typeof range)} className="lg:!w-36">
          <option value="all">All time</option>
          <option value="month">This month</option>
          <option value="year">This year</option>
          <option value="custom">Custom…</option>
        </Select>
        {range === 'custom' && (
          <div className="flex items-center gap-2">
            <Input type="date" aria-label="From" value={from} onChange={(e) => setFrom(e.target.value)} className="!w-40" />
            <span className="text-ink-3">–</span>
            <Input type="date" aria-label="To" value={to} onChange={(e) => setTo(e.target.value)} className="!w-40" />
          </div>
        )}
      </div>
      <Card className="p-4 mb-4 flex flex-wrap items-center gap-x-8 gap-y-2">
        <div>
          <div className="text-[12px] text-ink-3 mb-1">Total received (filtered)</div>
          <MoneyStack groups={data?.totals} size="md" empty="—" />
        </div>
        <div className="text-[12.5px] text-ink-3">{rows.length} payment{rows.length === 1 ? '' : 's'}</div>
      </Card>
      <Card className={cx('overflow-hidden', isFetching && !isLoading && 'opacity-70')}>
        {isLoading ? (
          <div className="p-4 flex flex-col gap-2">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : error ? (
          <ErrorState error={error} onRetry={() => refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState icon={<CreditCard className="size-5" />} title="No payments found" body="Record payments from an invoice page. They show up here and in your cash figures." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead className="text-left text-[12px] text-ink-3 border-b border-line">
                <tr>
                  <th className="py-2.5 px-5 font-medium">Date</th>
                  <th className="py-2.5 px-3 font-medium">Invoice</th>
                  <th className="py-2.5 px-3 font-medium">Client</th>
                  <th className="py-2.5 px-3 font-medium">Method</th>
                  <th className="py-2.5 px-3 font-medium">Reference</th>
                  <th className="py-2.5 px-5 font-medium text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.id} className="border-b border-line last:border-0">
                    <td className="py-2.5 px-5 tabular text-ink-2">{formatDate(p.paid_at, today)}</td>
                    <td className="py-2.5 px-3">
                      <Link className="text-ink font-medium hover:underline" to={`/invoices/${p.invoice_id}`}>
                        {p.number}
                      </Link>{' '}
                      {p.is_demo ? <DemoBadge /> : null}
                    </td>
                    <td className="py-2.5 px-3">
                      <Link className="text-ink-2 hover:underline" to={`/clients/${p.client_id}`}>
                        {p.client_name}
                      </Link>
                    </td>
                    <td className="py-2.5 px-3 text-ink-2">{PAYMENT_METHOD_LABELS[p.method as keyof typeof PAYMENT_METHOD_LABELS] ?? p.method}</td>
                    <td className="py-2.5 px-3 text-ink-3">{p.reference ?? '—'}</td>
                    <td className="py-2.5 px-5 text-right tabular font-medium text-good">{formatMoney(p.amount_minor, p.currency, { decimals: 'always' })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
