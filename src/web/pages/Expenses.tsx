import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Download, MoreHorizontal, Pencil, Plus, Receipt, Search, Trash2 } from 'lucide-react';
import { api, errorMessage, qs } from '../lib/api.ts';
import { invalidateAll, useBaseCurrency, useToday } from '../lib/queries.ts';
import { Button, Card, CardHeader, DemoBadge, EmptyState, ErrorState, IconButton, Input, PageHeader, Segmented, Select, Skeleton } from '../components/ui.tsx';
import { Menu, useConfirm, useToast } from '../components/overlay.tsx';
import { MoneyStack } from '../components/money.tsx';
import { BarList, useChartCurrency } from '../components/charts.tsx';
import { ExpenseFormDialog, type ExpenseRow } from '../components/forms.tsx';
import { EXPENSE_CATEGORY_LABELS, EXPENSE_CATEGORY_OPTIONS } from '../../shared/constants.ts';
import { formatMoney, type MoneyGroup } from '../../shared/money.ts';
import { formatDate, startOfMonth, startOfYear, addMonths } from '../../shared/dates.ts';
import { cx, safeHref, useDebounced } from '../lib/util.ts';

export default function ExpensesPage() {
  const today = useToday();
  const base = useBaseCurrency();
  const qc = useQueryClient();
  const toast = useToast();
  const { confirm } = useConfirm();
  const [params, setParams] = useSearchParams();
  const [editing, setEditing] = useState<ExpenseRow | null | 'new'>(null);
  const [copyFrom, setCopyFrom] = useState<ExpenseRow | null>(null);
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const [category, setCategory] = useState('');
  const [range, setRange] = useState<'month' | 'last3' | 'year' | 'all'>('month');
  useEffect(() => {
    if (params.get('new') === '1') {
      setEditing('new');
      params.delete('new');
      setParams(params, { replace: true });
    }
  }, [params, setParams]);
  const from = range === 'month' ? startOfMonth(today) : range === 'last3' ? startOfMonth(addMonths(today, -2)) : range === 'year' ? startOfYear(today) : '';
  const query = qs({ q: dq, category, from, to: range === 'all' ? '' : today });
  const { data, isLoading, error, refetch, isFetching } = useQuery({ queryKey: ['expenses', query], queryFn: () => api.get<{ expenses: ExpenseRow[]; totals: MoneyGroup[] }>(`/api/expenses${query}`) });
  const rows = data?.expenses ?? [];
  const remove = useMutation({
    mutationFn: (id: number) => api.del(`/api/expenses/${id}`),
    onSuccess: () => {
      invalidateAll(qc, 'expenses', 'finance');
      toast.success('Expense deleted');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const currencies = [...new Set(rows.map((r) => r.currency))];
  const [cur, setCur] = useChartCurrency(currencies, base);
  const byCategory = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) if (r.currency === cur) m.set(r.category, (m.get(r.category) ?? 0) + r.amount_minor);
    return [...m.entries()].map(([k, v]) => ({ key: k, label: EXPENSE_CATEGORY_LABELS[k as keyof typeof EXPENSE_CATEGORY_LABELS] ?? k, value: v })).sort((a, b) => b.value - a.value);
  }, [rows, cur]);

  return (
    <div>
      <PageHeader
        title="Expenses"
        description="Software, freelancers, assets, gear — everything that leaves the business. Recorded per currency."
        actions={
          <>
            <Button href={`/api/expenses/export.csv${query}`} download icon={<Download className="size-4" />}>
              Export CSV
            </Button>
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
              Record expense
            </Button>
          </>
        }
      />
      <div className="flex flex-col lg:flex-row lg:items-center gap-2 mb-4">
        <div className="relative lg:max-w-64 w-full">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-ink-3" aria-hidden />
          <Input aria-label="Search expenses" placeholder="Description, vendor…" className="!pl-9" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <Segmented label="Period" value={range} onChange={setRange} options={[{ value: 'month', label: 'This month' }, { value: 'last3', label: 'Last 3 months' }, { value: 'year', label: 'This year' }, { value: 'all', label: 'All' }]} />
        <Select aria-label="Category" value={category} onChange={(e) => setCategory(e.target.value)} className="lg:!w-56">
          <option value="">All categories</option>
          {EXPENSE_CATEGORY_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_340px] gap-4">
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
            <EmptyState icon={<Receipt className="size-5" />} title="No expenses in this period" body="Record subscriptions, freelancer payouts and purchases to see real profit." action={<Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>Record expense</Button>} />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead className="text-left text-[12px] text-ink-3 border-b border-line">
                  <tr>
                    <th className="py-2.5 px-5 font-medium">Date</th>
                    <th className="py-2.5 px-3 font-medium">Description</th>
                    <th className="py-2.5 px-3 font-medium">Category</th>
                    <th className="py-2.5 px-3 font-medium text-right">Amount</th>
                    <th className="py-2.5 px-3" aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((e) => (
                    <tr key={e.id} className="border-b border-line last:border-0 hover:bg-white/[0.02]">
                      <td className="py-2.5 px-5 tabular text-ink-2 whitespace-nowrap">{formatDate(e.date, today)}</td>
                      <td className="py-2.5 px-3">
                        <div className="text-ink">
                          {e.description} {e.is_demo ? <DemoBadge /> : null}
                        </div>
                        <div className="text-[11.5px] text-ink-3">
                          {[e.vendor, e.client_name, e.member_name].filter(Boolean).join(' · ') || '—'}
                          {safeHref(e.receipt_url) && (
                            <>
                              {' · '}
                              <a className="text-accent-ink hover:underline" href={safeHref(e.receipt_url)} target="_blank" rel="noreferrer noopener">
                                receipt
                              </a>
                            </>
                          )}
                        </div>
                      </td>
                      <td className="py-2.5 px-3 text-ink-2">{EXPENSE_CATEGORY_LABELS[e.category as keyof typeof EXPENSE_CATEGORY_LABELS] ?? e.category}</td>
                      <td className="py-2.5 px-3 text-right tabular font-medium">{formatMoney(e.amount_minor, e.currency, { decimals: 'always' })}</td>
                      <td className="py-2.5 px-3 text-right">
                        <Menu
                          label="Expense actions"
                          button={(p) => (
                            <IconButton size="sm" label={`Actions for ${e.description}`} {...p}>
                              <MoreHorizontal className="size-4" />
                            </IconButton>
                          )}
                          items={[
                            { label: 'Edit', icon: <Pencil />, onSelect: () => setEditing(e) },
                            {
                              label: 'Record again (new date)',
                              icon: <Copy />,
                              onSelect: () => {
                                setCopyFrom(e);
                                setEditing('new');
                              },
                            },
                            {
                              label: 'Delete',
                              icon: <Trash2 />,
                              danger: true,
                              onSelect: async () => {
                                if (await confirm({ title: 'Delete this expense?', body: `${e.description} · ${formatMoney(e.amount_minor, e.currency)}`, confirmLabel: 'Delete', danger: true })) remove.mutate(e.id);
                              },
                            },
                          ]}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <aside className="flex flex-col gap-4">
          <Card className="p-5">
            <div className="text-[12.5px] text-ink-3 mb-2">Total spent in this view</div>
            <MoneyStack groups={data?.totals} empty="Nothing" />
          </Card>
          <Card>
            <CardHeader title="By category" action={currencies.length > 1 ? <Segmented size="xs" label="Currency" value={cur} onChange={setCur} options={currencies.map((c) => ({ value: c, label: c }))} /> : undefined} />
            <div className="px-5 pb-5">
              <BarList items={byCategory} format={(v) => formatMoney(v, cur)} color="var(--color-series-3)" empty="No expenses yet." />
            </div>
          </Card>
        </aside>
      </div>
      <ExpenseFormDialog
        open={editing !== null}
        onClose={() => {
          setEditing(null);
          setCopyFrom(null);
        }}
        expense={editing === 'new' ? null : editing}
        copyFrom={editing === 'new' ? copyFrom : null}
      />
    </div>
  );
}
