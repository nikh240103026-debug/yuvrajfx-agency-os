import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Download, Info } from 'lucide-react';
import { api, qs } from '../lib/api.ts';
import { useToday } from '../lib/queries.ts';
import { Button, Card, CardHeader, ErrorState, IconButton, InfoTip, Input, PageHeader, PageSkeleton, Segmented } from '../components/ui.tsx';
import { MoneyStack } from '../components/money.tsx';
import { BarList, ChartFrame, ColumnChart, DataTable, Legend, useChartCurrency } from '../components/charts.tsx';
import { EXPENSE_CATEGORY_LABELS, SERVICE_TYPE_LABELS } from '../../shared/constants.ts';
import { formatMoney, type FxSettings, type MoneyGroup } from '../../shared/money.ts';
import { addMonths, monthLabel, periodFor, shiftPeriod, startOfMonth, type Period, type PeriodKind } from '../../shared/dates.ts';
import { cx } from '../lib/util.ts';

export type Summary = {
  range: { start: string; end: string; label: string };
  base_currency: string;
  fx: FxSettings | null;
  collected: MoneyGroup[];
  invoiced: { net: MoneyGroup[]; tax: MoneyGroup[]; gross: MoneyGroup[]; count: number };
  expenses: MoneyGroup[];
  net_cash_flow: MoneyGroup[];
  estimated_profit: MoneyGroup[];
  receivables: { outstanding: MoneyGroup[]; overdue: MoneyGroup[]; count: number; overdue_count: number; aging: { key: string; label: string; count: number; groups: MoneyGroup[] }[] };
  mrr: { groups: MoneyGroup[]; clients: number; per_client: { client_id: number; name: string; currency: string; amount_minor: number }[] };
  by_client: { client_id: number; name: string; collected: MoneyGroup[]; invoiced: MoneyGroup[] }[];
  by_service: { service: string; invoiced: MoneyGroup[]; collected: MoneyGroup[] }[];
  expenses_by_category: { category: string; count: number; groups: MoneyGroup[] }[];
  series: { currencies: string[]; months: { month: string; collected: MoneyGroup[]; invoiced: MoneyGroup[]; expenses: MoneyGroup[] }[] };
  payments_count: number;
};

const amt = (g: MoneyGroup[], c: string) => g.find((x) => x.currency === c)?.amount_minor ?? 0;

function Metric({ label, info, groups, fx, sub, tone, empty = '—' }: { label: string; info: string; groups: MoneyGroup[]; fx?: FxSettings | null; sub?: ReactNode; tone?: 'bad' | 'good'; empty?: ReactNode }) {
  return (
    <Card className="p-4 sm:p-5">
      <div className="flex items-center gap-1.5 text-[12.5px] font-medium text-ink-3 mb-3">
        {label}
        <InfoTip text={info} />
      </div>
      <MoneyStack groups={groups} fx={fx} tone={tone} empty={empty} />
      {sub && <div className="mt-2 text-[12px] text-ink-3">{sub}</div>}
    </Card>
  );
}

function CurrencyTabs({ currencies, value, onChange }: { currencies: string[]; value: string; onChange: (v: string) => void }) {
  if (currencies.length < 2) return null;
  return <Segmented size="xs" label="Currency" value={value} onChange={onChange} options={currencies.map((c) => ({ value: c, label: c }))} />;
}

function Trend({ series, base, title }: { series: Summary['series']; base: string; title: string }) {
  const [cur, setCur] = useChartCurrency(series.currencies, base);
  const s = [
    { key: 'collected', label: 'Cash collected', color: 'var(--color-series-1)', values: series.months.map((m) => amt(m.collected, cur)) },
    { key: 'invoiced', label: 'Invoiced (excl. tax)', color: 'var(--color-series-2)', values: series.months.map((m) => amt(m.invoiced, cur)) },
    { key: 'expenses', label: 'Expenses', color: 'var(--color-series-3)', values: series.months.map((m) => amt(m.expenses, cur)) },
  ];
  const fmt = (v: number) => formatMoney(v, cur);
  return (
    <Card className="p-5">
      <ChartFrame
        title={title}
        description="One currency at a time. Amounts in different currencies are never added together."
        actions={<CurrencyTabs currencies={series.currencies} value={cur} onChange={setCur} />}
        legend={<Legend items={s.map((x) => ({ label: x.label, color: x.color }))} />}
        table={<DataTable headers={['Month', ...s.map((x) => x.label), 'Net cash']} rows={series.months.map((m, i) => [monthLabel(m.month, 'long'), ...s.map((x) => fmt(x.values[i])), fmt(s[0].values[i] - s[2].values[i])])} />}
      >
        {series.currencies.length === 0 ? <p className="py-10 text-center text-[13px] text-ink-3">No money movement in this period.</p> : <ColumnChart categories={series.months.map((m) => monthLabel(m.month))} series={s} format={fmt} formatAxis={(v) => formatMoney(v, cur, { compact: true })} height={250} />}
      </ChartFrame>
    </Card>
  );
}

export default function FinancePage() {
  const today = useToday();
  const [kind, setKind] = useState<PeriodKind | 'custom'>('month');
  const [period, setPeriod] = useState<Period>(() => periodFor('month', today));
  const [custom, setCustom] = useState({ from: startOfMonth(addMonths(today, -5)), to: today });
  const [basis, setBasis] = useState<'collected' | 'invoiced'>('collected');
  const query = kind === 'custom' ? qs({ period: 'custom', from: custom.from, to: custom.to }) : qs({ period: kind, date: period.start });
  const { data, isLoading, error, refetch, isFetching } = useQuery({ queryKey: ['finance', query], queryFn: () => api.get<Summary>(`/api/finance/summary${query}`), placeholderData: (prev) => prev });
  const trailing = useQuery({
    queryKey: ['finance', 'trailing', today],
    queryFn: () => api.get<Summary>(`/api/finance/summary${qs({ period: 'custom', from: startOfMonth(addMonths(today, -11)), to: today })}`),
    enabled: kind === 'month',
  });
  const base = data?.base_currency ?? 'INR';
  const clientCurrencies = useMemo(() => [...new Set((data?.by_client ?? []).flatMap((c) => c[basis].map((g) => g.currency)))], [data, basis]);
  const [clientCur, setClientCur] = useChartCurrency(clientCurrencies, base);
  const serviceCurrencies = useMemo(() => [...new Set((data?.by_service ?? []).flatMap((s) => s[basis].map((g) => g.currency)))], [data, basis]);
  const [serviceCur, setServiceCur] = useChartCurrency(serviceCurrencies, base);
  const expenseCurrencies = useMemo(() => [...new Set((data?.expenses_by_category ?? []).flatMap((e) => e.groups.map((g) => g.currency)))], [data]);
  const [expCur, setExpCur] = useChartCurrency(expenseCurrencies, base);
  const agingCurrencies = useMemo(() => [...new Set((data?.receivables.aging ?? []).flatMap((a) => a.groups.map((g) => g.currency)))], [data]);
  const [agingCur, setAgingCur] = useChartCurrency(agingCurrencies, base);

  if (isLoading) return <PageSkeleton />;
  if (error || !data) return <ErrorState error={error} onRetry={() => refetch()} />;

  const changeKind = (k: PeriodKind | 'custom') => {
    setKind(k);
    if (k !== 'custom') setPeriod(periodFor(k, today));
  };
  const canNext = kind !== 'custom' && shiftPeriod(period, 1).start <= today;

  return (
    <div className={cx('transition-opacity', isFetching && 'opacity-80')}>
      <PageHeader
        title="Finance"
        description="Cash you actually received, kept apart from what you invoiced, what is still owed and what is only contracted."
        actions={
          kind !== 'custom' ? (
            <Button href={`/api/finance/report.csv${qs({ period: kind, date: period.start })}`} download icon={<Download className="size-4" />}>
              Export {kind} report
            </Button>
          ) : undefined
        }
      />
      <div className="flex flex-wrap items-center gap-2 mb-5">
        <Segmented label="Period type" value={kind} onChange={changeKind} options={[{ value: 'month', label: 'Month' }, { value: 'quarter', label: 'Quarter' }, { value: 'year', label: 'Year' }, { value: 'custom', label: 'Custom' }]} />
        {kind !== 'custom' ? (
          <div className="flex items-center gap-1">
            <IconButton label="Previous period" onClick={() => setPeriod(shiftPeriod(period, -1))}>
              <ChevronLeft className="size-4" />
            </IconButton>
            <div className="min-w-32 text-center text-[14px] font-semibold">{period.label}</div>
            <IconButton label="Next period" disabled={!canNext} onClick={() => setPeriod(shiftPeriod(period, 1))}>
              <ChevronRight className="size-4" />
            </IconButton>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <Input type="date" aria-label="From" value={custom.from} onChange={(e) => setCustom({ ...custom, from: e.target.value })} className="!w-40" />
            <span className="text-ink-3">–</span>
            <Input type="date" aria-label="To" value={custom.to} onChange={(e) => setCustom({ ...custom, to: e.target.value })} className="!w-40" />
          </div>
        )}
        {data.fx ? (
          <span className="text-[12px] text-ink-3 ml-auto">“≈ total” lines use your exchange rates{data.fx.as_of ? ` (as of ${data.fx.as_of})` : ''}.</span>
        ) : (
          <Link to="/settings?tab=currency" className="text-[12px] text-ink-3 hover:text-ink ml-auto inline-flex items-center gap-1">
            <Info className="size-3.5" /> Add exchange rates to see an approximate combined total
          </Link>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <Metric label="Cash collected" info="Payments recorded with a date in this period. This is real money received." groups={data.collected} fx={data.fx} sub={`${data.payments_count} payment${data.payments_count === 1 ? '' : 's'}`} empty="Nothing received" />
        <Metric label="Invoiced revenue" info="Invoices issued (marked sent) in this period, excluding tax. Includes invoices that are not paid yet." groups={data.invoiced.net} fx={data.fx} sub={data.invoiced.tax.length ? <>+ tax {data.invoiced.tax.map((g) => formatMoney(g.amount_minor, g.currency)).join(' + ')} · {data.invoiced.count} invoices</> : `${data.invoiced.count} invoice${data.invoiced.count === 1 ? '' : 's'}`} empty="Nothing invoiced" />
        <Metric label="Expenses" info="Money spent in this period, from your expense records." groups={data.expenses} fx={data.fx} empty="No expenses" />
        <Metric label="Net cash flow" info="Cash collected minus expenses in this period, per currency." groups={data.net_cash_flow} fx={data.fx} />
        <Metric label="Estimated profit" info="Invoiced revenue (excl. tax) minus expenses. An accrual-style estimate: some of that revenue may not be paid yet." groups={data.estimated_profit} fx={data.fx} />
        <Metric label="Outstanding receivables" info="What clients owe you today on sent invoices. Not limited to the selected period." groups={data.receivables.outstanding} fx={data.fx} sub={data.receivables.overdue_count ? <span className="text-bad">{data.receivables.overdue_count} overdue · {data.receivables.overdue.map((g) => formatMoney(g.amount_minor, g.currency)).join(' + ')}</span> : `${data.receivables.count} open invoices`} empty="Nothing owed" />
        <Metric label="Monthly recurring revenue" info="Contracted monthly retainers of active clients today. A commitment, not cash — it only becomes revenue when invoiced and cash when paid." groups={data.mrr.groups} fx={data.fx} sub={`${data.mrr.clients} retainer client${data.mrr.clients === 1 ? '' : 's'}`} empty="No retainers" />
        <Card className="p-4 sm:p-5 flex flex-col justify-center gap-2 text-[12.5px] text-ink-2 leading-relaxed">
          <p>
            <span className="text-ink font-medium">Collected</span> = money in your account. <span className="text-ink font-medium">Invoiced</span> = bills issued. <span className="text-ink font-medium">MRR</span> = signed retainers.
          </p>
          <p className="text-ink-3">An invoice turns “paid” only when recorded payments cover it.</p>
        </Card>
      </div>

      <div className="mt-4">
        {kind === 'month' ? trailing.data ? <Trend series={trailing.data.series} base={base} title="Last 12 months" /> : null : <Trend series={data.series} base={base} title={`By month · ${data.range.label}`} />}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-4">
        <Card>
          <CardHeader
            title="Revenue by client"
            description={basis === 'collected' ? 'Cash received in this period' : 'Invoiced in this period (excl. tax)'}
            action={
              <>
                <Segmented size="xs" label="Basis" value={basis} onChange={setBasis} options={[{ value: 'collected', label: 'Cash' }, { value: 'invoiced', label: 'Invoiced' }]} />
                <CurrencyTabs currencies={clientCurrencies} value={clientCur} onChange={setClientCur} />
              </>
            }
          />
          <div className="px-5 pb-5">
            <BarList
              items={data.by_client
                .map((c) => ({ key: c.client_id, label: <Link to={`/clients/${c.client_id}`} className="hover:text-ink">{c.name}</Link>, value: amt(c[basis], clientCur) }))
                .filter((x) => x.value > 0)
                .sort((a, b) => b.value - a.value)
                .slice(0, 10)}
              format={(v) => formatMoney(v, clientCur)}
              empty="No revenue in this period."
            />
          </div>
        </Card>
        <Card>
          <CardHeader title="Revenue by service" description={basis === 'collected' ? 'Cash, attributed to invoice lines by share' : 'Invoice lines after discounts, excl. tax'} action={<CurrencyTabs currencies={serviceCurrencies} value={serviceCur} onChange={setServiceCur} />} />
          <div className="px-5 pb-5">
            <BarList
              items={data.by_service
                .map((s) => ({ key: s.service, label: SERVICE_TYPE_LABELS[s.service as keyof typeof SERVICE_TYPE_LABELS] ?? s.service, value: amt(s[basis], serviceCur) }))
                .filter((x) => x.value > 0)
                .sort((a, b) => b.value - a.value)}
              format={(v) => formatMoney(v, serviceCur)}
              color="var(--color-series-2)"
              empty="No revenue in this period."
            />
          </div>
        </Card>
        <Card>
          <CardHeader title="Expenses by category" action={<CurrencyTabs currencies={expenseCurrencies} value={expCur} onChange={setExpCur} />} />
          <div className="px-5 pb-5">
            <BarList
              items={data.expenses_by_category.map((e) => ({ key: e.category, label: EXPENSE_CATEGORY_LABELS[e.category as keyof typeof EXPENSE_CATEGORY_LABELS] ?? e.category, value: amt(e.groups, expCur), sub: `${e.count} entr${e.count === 1 ? 'y' : 'ies'}` })).filter((x) => x.value > 0).sort((a, b) => b.value - a.value)}
              format={(v) => formatMoney(v, expCur)}
              color="var(--color-series-3)"
              empty="No expenses in this period."
            />
          </div>
        </Card>
        <Card>
          <CardHeader title="Receivables aging" description="Unpaid balances today, by how late they are" action={<CurrencyTabs currencies={agingCurrencies} value={agingCur} onChange={setAgingCur} />} />
          <div className="px-5 pb-5">
            <BarList
              items={data.receivables.aging.map((a) => ({ key: a.key, label: a.label, value: amt(a.groups, agingCur), sub: `${a.count} invoice${a.count === 1 ? '' : 's'}` }))}
              format={(v) => formatMoney(v, agingCur)}
              color="var(--color-series-1)"
              empty="Nothing outstanding."
            />
            <div className="mt-3">
              <Button size="sm" variant="ghost" to="/invoices?status=overdue" className="-ml-2">
                See overdue invoices
              </Button>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
