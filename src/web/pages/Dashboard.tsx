import { Link, useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle,
  ArrowDownRight,
  ArrowUpRight,
  CalendarClock,
  CheckCircle2,
  CircleDollarSign,
  FileText,
  FolderKanban,
  Inbox,
  Mail,
  MessageSquare,
  RefreshCcw,
  Sparkles,
  Target,
  Users,
} from 'lucide-react';
import { api } from '../lib/api.ts';
import { useAuth } from '../lib/queries.ts';
import { Avatar, Button, Card, CardHeader, DemoBadge, EmptyState, ErrorState, InfoTip, PageHeader, PageSkeleton, Segmented } from '../components/ui.tsx';
import { MoneyStack } from '../components/money.tsx';
import { BarList, ChartFrame, ColumnChart, DataTable, Legend, StageBar, useChartCurrency } from '../components/charts.tsx';
import { DueChip, stageColor } from '../lib/status.tsx';
import { SeverityDot } from '../components/layout.tsx';
import { useToast } from '../components/overlay.tsx';
import { formatMoney, type FxSettings, type MoneyGroup } from '../../shared/money.ts';
import { formatDateLong, monthLabel } from '../../shared/dates.ts';
import { STAGE_LABELS, type Stage } from '../../shared/constants.ts';
import { cx, timeAgo } from '../lib/util.ts';

type Dashboard = {
  today: string;
  month: { label: string; start: string; end: string };
  base_currency: string;
  counts: Record<string, number>;
  stage_distribution: { stage: Stage; count: number }[];
  due_soon: { id: number; title: string; deadline: string; status: string; project_id: number; project_name: string; client_name: string; assignee_name: string | null; assignee_color: string | null; is_demo: number; is_overdue: number }[];
  recent_activity: { id: number; entity_type: string; action: string; summary: string; actor_name: string | null; actor_type: string; created_at: string; is_demo: number; client_id: number | null; project_id: number | null }[];
  next_actions: { kind: string; severity: 'critical' | 'warning' | 'info'; title: string; detail: string; link: string; date: string | null }[];
  finance: null | {
    mrr: { groups: MoneyGroup[]; clients: number };
    collected_month: MoneyGroup[];
    collected_prev_month: MoneyGroup[];
    invoiced_month: MoneyGroup[];
    expenses_month: MoneyGroup[];
    expenses_prev_month: MoneyGroup[];
    net_month: MoneyGroup[];
    receivables: { outstanding: MoneyGroup[]; overdue: MoneyGroup[]; count: number; overdue_count: number };
    pipeline: { total: MoneyGroup[]; weighted: MoneyGroup[]; open_count: number };
    series: { currencies: string[]; months: { month: string; collected: MoneyGroup[]; invoiced: MoneyGroup[]; expenses: MoneyGroup[] }[] };
    top_clients: { client_id: number; name: string; is_demo: number; collected: MoneyGroup[] }[];
    fx: FxSettings | null;
  };
  has_any_data: boolean;
  demo_data: boolean;
};

const amountIn = (groups: MoneyGroup[], currency: string) => groups.find((g) => g.currency === currency)?.amount_minor ?? 0;

function greeting(): string {
  const h = new Date().getHours();
  return h < 5 ? 'Working late' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

function Kpi({ label, info, children, sub, href, icon }: { label: string; info?: string; children: React.ReactNode; sub?: React.ReactNode; href?: string; icon: React.ReactNode }) {
  const body = (
    <div className="card p-4 sm:p-5 h-full transition-colors hover:border-white/[0.12] group">
      <div className="flex items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-1.5 text-[12.5px] font-medium text-ink-3">
          {label}
          {info && <InfoTip text={info} />}
        </div>
        <span className="text-ink-3 group-hover:text-accent-ink transition-colors [&_svg]:size-4" aria-hidden>
          {icon}
        </span>
      </div>
      {children}
      {sub && <div className="mt-2 text-[12px] text-ink-3">{sub}</div>}
    </div>
  );
  return href ? (
    <Link to={href} className="block focus-visible:rounded-[14px]">
      {body}
    </Link>
  ) : (
    body
  );
}

function Delta({ now, prev, currency, goodWhenUp = true }: { now: MoneyGroup[]; prev: MoneyGroup[]; currency: string | undefined; goodWhenUp?: boolean }) {
  if (!currency) return null;
  const a = amountIn(now, currency);
  const b = amountIn(prev, currency);
  if (!b) return <span>Last month: nothing in {currency}</span>;
  const change = (a - b) / Math.abs(b);
  const up = change >= 0;
  const good = up === goodWhenUp;
  return (
    <span className="inline-flex items-center gap-1">
      <span className={cx('inline-flex items-center gap-0.5 font-medium tabular', good ? 'text-good' : 'text-bad')}>
        {up ? <ArrowUpRight className="size-3.5" aria-hidden /> : <ArrowDownRight className="size-3.5" aria-hidden />}
        {Math.abs(change * 100).toFixed(0)}%
      </span>
      vs last month ({currency})
    </span>
  );
}

function Onboarding() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: auth } = useAuth();
  const admin = auth?.user?.role === 'owner' || auth?.user?.role === 'admin';
  const loadDemo = useMutation({
    mutationFn: () => api.post('/api/settings/demo'),
    onSuccess: () => {
      qc.invalidateQueries();
      toast.success('Demo data loaded. Everything is labelled DEMO and can be removed in Settings → Data.');
    },
  });
  return (
    <Card className="p-6 sm:p-8 mb-6 overflow-hidden relative">
      <div className="absolute -right-24 -top-24 size-72 rounded-full bg-accent/10 blur-3xl" aria-hidden />
      <div className="relative max-w-2xl">
        <div className="inline-flex items-center gap-1.5 text-[12px] font-medium text-accent-ink mb-3">
          <Sparkles className="size-3.5" /> Welcome to your agency OS
        </div>
        <h2 className="text-[20px] font-semibold tracking-tight">Let’s set up YuvrajFX</h2>
        <p className="mt-1.5 text-[13.5px] text-ink-2">Every number on this dashboard is calculated from your own records, so it starts empty. Add a client and a project to bring it to life, or explore with sample data first.</p>
        <ol className="mt-5 grid sm:grid-cols-3 gap-3">
          {[
            { n: 1, t: 'Add your business details', d: 'Address, tax ID and payment instructions for invoices.', to: '/settings' },
            { n: 2, t: 'Add your first client', d: 'Contact, retainer, currency and payment terms.', to: '/clients?new=1' },
            { n: 3, t: 'Create a project', d: 'Deliverables, deadlines, editor and review links.', to: '/projects?new=1' },
          ].map((s) => (
            <li key={s.n}>
              <Link to={s.to} className="block h-full rounded-xl bg-white/[0.03] ring-1 ring-inset ring-white/[0.06] p-4 hover:bg-white/[0.05]">
                <div className="text-[11px] font-semibold text-accent-ink mb-1">STEP {s.n}</div>
                <div className="text-[13.5px] font-medium text-ink">{s.t}</div>
                <div className="text-[12px] text-ink-3 mt-0.5">{s.d}</div>
              </Link>
            </li>
          ))}
        </ol>
        {admin && (
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <Button variant="secondary" icon={<Sparkles className="size-4" />} loading={loadDemo.isPending} onClick={() => loadDemo.mutate()}>
              Explore with demo data
            </Button>
            <span className="text-[12px] text-ink-3">Fictional, clearly labelled, removable in one click.</span>
          </div>
        )}
      </div>
    </Card>
  );
}

const ACTION_ICONS: Record<string, React.ReactNode> = {
  invoice_overdue: <CircleDollarSign />,
  deliverable_overdue: <AlertCircle />,
  deliverable_due: <CalendarClock />,
  client_feedback: <MessageSquare />,
  task_overdue: <CheckCircle2 />,
  task_today: <CheckCircle2 />,
  follow_up: <Target />,
  renewal: <RefreshCcw />,
  drafts: <FileText />,
  retainers: <FileText />,
  outbox: <Mail />,
};

function NextActions({ actions }: { actions: Dashboard['next_actions'] }) {
  return (
    <Card className="flex flex-col">
      <CardHeader title="Next actions" description="What needs you, most urgent first." />
      {actions.length === 0 ? (
        <EmptyState compact icon={<CheckCircle2 className="size-5" />} title="Nothing urgent" body="No overdue work, payments or follow-ups. Nice." />
      ) : (
        <ul className="px-2 pb-2 flex-1 overflow-y-auto max-h-[420px]">
          {actions.map((a, i) => (
            <li key={i}>
              <Link to={a.link} className="flex items-start gap-3 rounded-xl px-3 py-2.5 hover:bg-white/[0.04]">
                <span className={cx('mt-0.5 grid place-items-center size-7 rounded-lg shrink-0 [&_svg]:size-3.5', a.severity === 'critical' ? 'bg-bad-dot/14 text-bad' : a.severity === 'warning' ? 'bg-warn/10 text-warn' : 'bg-white/[0.05] text-ink-2')} aria-hidden>
                  {ACTION_ICONS[a.kind] ?? <Inbox />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] text-ink leading-snug">{a.title}</span>
                  <span className="block text-[12px] text-ink-3 truncate">{a.detail}</span>
                </span>
                <span className="sr-only">{a.severity}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function RevenueChart({ finance, base }: { finance: NonNullable<Dashboard['finance']>; base: string }) {
  const currencies = finance.series.currencies;
  const [currency, setCurrency] = useChartCurrency(currencies, base);
  const months = finance.series.months;
  const cats = months.map((m) => monthLabel(m.month));
  const series = [
    { key: 'collected', label: 'Cash collected', color: 'var(--color-series-1)', values: months.map((m) => amountIn(m.collected, currency)) },
    { key: 'invoiced', label: 'Invoiced (excl. tax)', color: 'var(--color-series-2)', values: months.map((m) => amountIn(m.invoiced, currency)) },
    { key: 'expenses', label: 'Expenses', color: 'var(--color-series-3)', values: months.map((m) => amountIn(m.expenses, currency)) },
  ];
  const fmt = (v: number) => formatMoney(v, currency);
  return (
    <Card className="p-5 lg:col-span-2">
      <ChartFrame
        title="Revenue, last 12 months"
        description="Cash actually received vs. invoices issued vs. money spent. One currency at a time — never blended."
        actions={currencies.length > 1 ? <Segmented label="Currency" size="xs" value={currency} onChange={setCurrency} options={currencies.map((c) => ({ value: c, label: c }))} /> : undefined}
        legend={<Legend items={series.map((s) => ({ label: s.label, color: s.color }))} />}
        table={<DataTable headers={['Month', ...series.map((s) => s.label)]} rows={months.map((m, i) => [monthLabel(m.month, 'long'), ...series.map((s) => fmt(s.values[i]))])} />}
      >
        {currencies.length === 0 ? (
          <EmptyState compact icon={<CircleDollarSign className="size-5" />} title="No money movement yet" body="Invoices you send, payments you record and expenses appear here." />
        ) : (
          <ColumnChart categories={cats} series={series} format={fmt} formatAxis={(v) => formatMoney(v, currency, { compact: true })} height={260} />
        )}
      </ChartFrame>
    </Card>
  );
}

function TopClients({ finance, base }: { finance: NonNullable<Dashboard['finance']>; base: string }) {
  const currencies = [...new Set(finance.top_clients.flatMap((c) => c.collected.map((g) => g.currency)))];
  const [currency, setCurrency] = useChartCurrency(currencies, base);
  const items = finance.top_clients
    .map((c) => ({ key: c.client_id, label: <Link className="hover:text-ink" to={`/clients/${c.client_id}`}>{c.name}{c.is_demo ? <span className="ml-1.5"><DemoBadge /></span> : null}</Link>, value: amountIn(c.collected, currency) }))
    .filter((i) => i.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, 6);
  return (
    <Card className="p-5">
      <ChartFrame title="Top clients" description="Cash collected, last 12 months" actions={currencies.length > 1 ? <Segmented label="Currency" size="xs" value={currency} onChange={setCurrency} options={currencies.map((c) => ({ value: c, label: c }))} /> : undefined}>
        <BarList items={items} format={(v) => formatMoney(v, currency)} empty="No payments recorded in the last 12 months." />
      </ChartFrame>
    </Card>
  );
}

export default function DashboardPage() {
  const navigate = useNavigate();
  const { data: auth } = useAuth();
  const { data, isLoading, error, refetch, isFetching } = useQuery({ queryKey: ['dashboard'], queryFn: () => api.get<Dashboard>('/api/dashboard'), refetchInterval: 120_000 });
  if (isLoading) return <PageSkeleton />;
  if (error || !data) return <ErrorState error={error} onRetry={() => refetch()} />;
  const f = data.finance;
  const base = data.base_currency;
  const firstName = auth?.user?.name.split(' ')[0] ?? '';
  const c = data.counts;

  return (
    <div className={cx('transition-opacity', isFetching && 'opacity-[0.985]')}>
      <PageHeader
        eyebrow={<span className="text-[12.5px] text-ink-3">{formatDateLong(data.today)}</span>}
        title={`${greeting()}${firstName ? `, ${firstName}` : ''}`}
        description={data.has_any_data ? `${c.active_projects} active project${c.active_projects === 1 ? '' : 's'} · ${c.due_this_week} deliverable${c.due_this_week === 1 ? '' : 's'} due this week${c.overdue_deliverables ? ` · ${c.overdue_deliverables} overdue` : ''}` : undefined}
        actions={
          f ? (
            <>
              <Button icon={<FolderKanban className="size-4" />} onClick={() => navigate('/projects?new=1')}>
                New project
              </Button>
              <Button variant="primary" icon={<FileText className="size-4" />} onClick={() => navigate('/invoices/new')}>
                New invoice
              </Button>
            </>
          ) : undefined
        }
      />

      {!data.has_any_data && <Onboarding />}

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 animate-enter">
        {f && (
          <>
            <Kpi label="Monthly recurring revenue" icon={<RefreshCcw />} info="Contracted retainers of active clients, per month (quarterly/yearly retainers are spread per month). It is a commitment, not cash received." href="/clients?status=active" sub={`${f.mrr.clients} active retainer${f.mrr.clients === 1 ? '' : 's'}`}>
              <MoneyStack groups={f.mrr.groups} fx={f.fx} empty="No retainers" />
            </Kpi>
            <Kpi label={`Collected · ${data.month.label.split(' ')[0]}`} icon={<CircleDollarSign />} info="Payments you recorded with a date in this calendar month. Unpaid invoices are not counted." href="/payments" sub={<Delta now={f.collected_month} prev={f.collected_prev_month} currency={f.collected_month[0]?.currency ?? f.collected_prev_month[0]?.currency} />}>
              <MoneyStack groups={f.collected_month} fx={f.fx} empty="Nothing yet" />
            </Kpi>
            <Kpi label="Outstanding invoices" icon={<FileText />} info="Unpaid balances on invoices you have sent, as of today." href="/invoices?status=open" sub={f.receivables.overdue_count ? <span className="text-bad font-medium">{f.receivables.overdue_count} overdue · {f.receivables.overdue.map((g) => formatMoney(g.amount_minor, g.currency)).join(' + ')}</span> : `${f.receivables.count} open invoice${f.receivables.count === 1 ? '' : 's'}`}>
              <MoneyStack groups={f.receivables.outstanding} fx={f.fx} empty="All paid" />
            </Kpi>
            <Kpi label={`Net cash flow · ${data.month.label.split(' ')[0]}`} icon={<ArrowUpRight />} info="Cash collected minus expenses recorded this month, per currency." href="/finance" sub={<>Expenses: {f.expenses_month.length ? f.expenses_month.map((g) => formatMoney(g.amount_minor, g.currency)).join(' + ') : 'none'}</>}>
              <MoneyStack groups={f.net_month} fx={f.fx} empty="—" />
            </Kpi>
          </>
        )}
        <Kpi label="Active clients" icon={<Users />} href="/clients" sub={c.onboarding_clients ? `${c.onboarding_clients} onboarding` : 'Active status'}>
          <div className="text-[26px] font-semibold tracking-tight">{c.active_clients}</div>
        </Kpi>
        <Kpi label="Active projects" icon={<FolderKanban />} href="/projects" sub={`${c.open_deliverables} open deliverables · ${c.in_client_review} in client review`}>
          <div className="text-[26px] font-semibold tracking-tight">{c.active_projects}</div>
        </Kpi>
        <Kpi label="Due in the next 7 days" icon={<CalendarClock />} href="/calendar" sub={c.overdue_deliverables ? <span className="text-bad font-medium">{c.overdue_deliverables} overdue now</span> : `${c.delivered_this_month} delivered this month`}>
          <div className="text-[26px] font-semibold tracking-tight">{c.due_this_week}</div>
        </Kpi>
        {f ? (
          <Kpi label="Sales pipeline" icon={<Target />} info="Weighted forecast: each open deal's estimated value × the typical win chance for its stage. Not booked revenue." href="/pipeline" sub={`${f.pipeline.open_count} open deal${f.pipeline.open_count === 1 ? '' : 's'} · total ${f.pipeline.total.map((g) => formatMoney(g.amount_minor, g.currency, { compact: true })).join(' + ') || '—'}`}>
            <MoneyStack groups={f.pipeline.weighted} empty="No open deals" />
          </Kpi>
        ) : (
          <Kpi label="Overdue tasks" icon={<CheckCircle2 />} href="/tasks?view=overdue" sub={`${c.tasks_today} due today`}>
            <div className={cx('text-[26px] font-semibold tracking-tight', c.overdue_tasks ? 'text-bad' : '')}>{c.overdue_tasks}</div>
          </Kpi>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mt-4">
        {f ? <RevenueChart finance={f} base={base} /> : null}
        <div className={f ? '' : 'lg:col-span-3'}>
          <NextActions actions={data.next_actions} />
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mt-4">
        <Card className="p-5">
          <ChartFrame title="Production pipeline" description="Deliverables by stage (delivered = this month)">
            {data.stage_distribution.every((s) => s.count === 0) ? (
              <EmptyState compact icon={<FolderKanban className="size-5" />} title="No deliverables yet" />
            ) : (
              <StageBar segments={data.stage_distribution.map((s) => ({ key: s.stage, label: STAGE_LABELS[s.stage], count: s.count, color: stageColor(s.stage) }))} onSelect={() => navigate('/projects?view=board')} />
            )}
          </ChartFrame>
        </Card>
        {f ? <TopClients finance={f} base={base} /> : null}
        <Card className={cx('flex flex-col', !f && 'lg:col-span-2')}>
          <CardHeader title="Due soon" description="Next 7 days and overdue" action={<Button size="xs" variant="ghost" to="/calendar">Calendar</Button>} />
          {data.due_soon.length === 0 ? (
            <EmptyState compact icon={<CalendarClock className="size-5" />} title="Clear week" body="No deliverables due in the next 7 days." />
          ) : (
            <ul className="px-2 pb-2">
              {data.due_soon.map((d) => (
                <li key={d.id}>
                  <Link to={`/projects/${d.project_id}`} className="flex items-center gap-3 rounded-xl px-3 py-2 hover:bg-white/[0.04]">
                    <span className="size-2 rounded-full shrink-0" style={{ background: stageColor(d.status) }} title={STAGE_LABELS[d.status as Stage]} aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] text-ink">{d.title}</span>
                      <span className="block truncate text-[12px] text-ink-3">
                        {d.client_name} · {STAGE_LABELS[d.status as Stage]}
                      </span>
                    </span>
                    {d.assignee_name && <Avatar name={d.assignee_name} color={d.assignee_color} size={22} />}
                    <DueChip date={d.deadline} today={data.today} compact />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card className="mt-4">
        <CardHeader title="Recent activity" description="Everything that changed across clients, production and money." />
        {data.recent_activity.length === 0 ? (
          <EmptyState compact title="No activity yet" />
        ) : (
          <ol className="px-5 pb-4 grid md:grid-cols-2 gap-x-8">
            {data.recent_activity.map((a) => (
              <li key={a.id} className="flex gap-3 py-2 border-b border-line last:border-0 md:[&:nth-last-child(2)]:border-0">
                <SeverityDot severity={a.action.includes('payment') ? 'success' : a.action === 'deleted' || a.action === 'voided' ? 'critical' : 'info'} />
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] text-ink-2 leading-snug">
                    {a.summary} {a.is_demo ? <DemoBadge /> : null}
                  </p>
                  <p className="text-[11.5px] text-ink-3 mt-0.5">
                    {a.actor_name ?? 'System'} · {timeAgo(a.created_at)}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        )}
      </Card>
    </div>
  );
}
