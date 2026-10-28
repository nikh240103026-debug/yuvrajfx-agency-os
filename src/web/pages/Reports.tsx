import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Download, FileBarChart, Printer } from 'lucide-react';
import { api, qs } from '../lib/api.ts';
import { useToday } from '../lib/queries.ts';
import { Badge, Button, Card, CardHeader, DemoBadge, EmptyState, ErrorState, IconButton, PageHeader, PageSkeleton, Segmented } from '../components/ui.tsx';
import { Dialog } from '../components/overlay.tsx';
import { groupsText } from '../components/money.tsx';
import type { Summary } from './Finance.tsx';
import { EXPENSE_CATEGORY_LABELS } from '../../shared/constants.ts';
import { formatMoney, type MoneyGroup } from '../../shared/money.ts';
import { formatDate, periodFor, shiftPeriod, type Period, type PeriodKind } from '../../shared/dates.ts';
import { cx, pct, timeAgo } from '../lib/util.ts';

type Report = {
  period: Period;
  previous_period: Period;
  summary: Summary;
  previous: { collected: MoneyGroup[]; invoiced: MoneyGroup[]; expenses: MoneyGroup[] };
  operations: Record<string, number | null>;
  generated_at: string;
};

type Snapshot = { id: number; kind: 'weekly' | 'monthly'; period_start: string; period_end: string; created_at: string; is_demo: number };
type SnapshotData = {
  period: { from: string; to: string };
  collected: MoneyGroup[];
  invoiced: MoneyGroup[];
  expenses: MoneyGroup[];
  net_cash_flow: MoneyGroup[];
  estimated_profit: MoneyGroup[];
  receivables: { outstanding: MoneyGroup[]; overdue: MoneyGroup[]; overdue_count: number };
  mrr: MoneyGroup[];
  top_clients: { name: string; collected: MoneyGroup[] }[];
  operations: Record<string, number | null>;
  pipeline: { total: MoneyGroup[]; weighted: MoneyGroup[]; open_count: number };
  upcoming_deadlines: number;
};

const amt = (g: MoneyGroup[] | undefined, c: string) => g?.find((x) => x.currency === c)?.amount_minor ?? 0;

function Change({ now, prev, goodWhenUp = true }: { now: number; prev: number; goodWhenUp?: boolean }) {
  if (!prev) return <span className="text-ink-3">—</span>;
  const c = (now - prev) / Math.abs(prev);
  const good = c >= 0 === goodWhenUp;
  return <span className={cx('tabular', c === 0 ? 'text-ink-3' : good ? 'text-good' : 'text-bad')}>{c > 0 ? '+' : ''}{(c * 100).toFixed(0)}%</span>;
}

const OPS: [string, string][] = [
  ['new_clients', 'New clients'],
  ['projects_started', 'Projects started'],
  ['projects_delivered', 'Projects delivered'],
  ['deliverables_delivered', 'Deliverables delivered'],
  ['revisions_requested', 'Revision requests'],
  ['tasks_completed', 'Tasks completed'],
  ['leads_added', 'New leads'],
  ['leads_won', 'Deals won'],
  ['leads_lost', 'Deals lost'],
];

function SnapshotView({ id, onClose }: { id: number | null; onClose: () => void }) {
  const { data } = useQuery({ queryKey: ['snapshot', id], queryFn: () => api.get<{ snapshot: Snapshot & { data: SnapshotData } }>(`/api/finance/snapshots/${id}`), enabled: id !== null });
  const s = data?.snapshot;
  return (
    <Dialog open={id !== null} onClose={onClose} title={s ? `${s.kind === 'weekly' ? 'Weekly report' : 'Monthly summary'} · ${formatDate(s.period_start)} – ${formatDate(s.period_end)}` : 'Report'} size="lg">
      {!s ? (
        <p className="text-ink-3 text-[13px]">Loading…</p>
      ) : (
        <div className="flex flex-col gap-4 text-[13px]">
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2">
            {[
              ['Cash collected', s.data.collected],
              ['Invoiced (excl. tax)', s.data.invoiced],
              ['Expenses', s.data.expenses],
              ['Net cash flow', s.data.net_cash_flow],
              ['Estimated profit', s.data.estimated_profit],
              ['Outstanding (at snapshot)', s.data.receivables.outstanding],
              ['MRR (contracted)', s.data.mrr],
              ['Open pipeline (weighted)', s.data.pipeline.weighted],
            ].map(([label, g]) => (
              <div key={label as string} className="flex justify-between gap-4 border-b border-line py-1.5">
                <dt className="text-ink-3">{label as string}</dt>
                <dd className="tabular text-right text-ink">{groupsText(g as MoneyGroup[])}</dd>
              </div>
            ))}
          </dl>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {OPS.map(([k, l]) => (
              <div key={k} className="rounded-xl bg-white/[0.03] p-3">
                <div className="text-[11.5px] text-ink-3">{l}</div>
                <div className="text-[18px] font-semibold">{s.data.operations[k] ?? '—'}</div>
              </div>
            ))}
          </div>
          {s.data.top_clients.length > 0 && (
            <div>
              <h3 className="label-caps mb-2">Top clients by cash</h3>
              <ul className="flex flex-col gap-1">
                {s.data.top_clients.map((c) => (
                  <li key={c.name} className="flex justify-between">
                    <span className="text-ink-2">{c.name}</span>
                    <span className="tabular">{groupsText(c.collected)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className="text-[12px] text-ink-3">Saved automatically {timeAgo(s.created_at)}. Figures are as they were at that moment; later edits do not change this snapshot.</p>
        </div>
      )}
    </Dialog>
  );
}

export default function ReportsPage() {
  const today = useToday();
  const [params, setParams] = useSearchParams();
  const [kind, setKind] = useState<PeriodKind>('month');
  const [period, setPeriod] = useState<Period>(() => periodFor('month', today));
  const [snapshot, setSnapshot] = useState<number | null>(params.get('snapshot') ? Number(params.get('snapshot')) : null);
  useEffect(() => {
    if (params.get('snapshot')) {
      params.delete('snapshot');
      setParams(params, { replace: true });
    }
  }, [params, setParams]);
  const query = qs({ period: kind, date: period.start });
  const { data, isLoading, error, refetch, isFetching } = useQuery({ queryKey: ['report', query], queryFn: () => api.get<Report>(`/api/finance/report${query}`), placeholderData: (p) => p });
  const snapshots = useQuery({ queryKey: ['snapshots'], queryFn: () => api.get<{ snapshots: Snapshot[] }>('/api/finance/snapshots') });
  const currencies = useMemo(() => {
    if (!data) return [];
    const s = data.summary;
    return [...new Set([...s.collected, ...s.invoiced.net, ...s.expenses, ...data.previous.collected, ...data.previous.invoiced, ...data.previous.expenses].map((g) => g.currency))].sort((a, b) => (a === s.base_currency ? -1 : b === s.base_currency ? 1 : a.localeCompare(b)));
  }, [data]);
  if (isLoading) return <PageSkeleton />;
  if (error || !data) return <ErrorState error={error} onRetry={() => refetch()} />;
  const s = data.summary;
  const canNext = shiftPeriod(period, 1).start <= today;

  return (
    <div className={cx('transition-opacity', isFetching && 'opacity-80')}>
      <PageHeader
        title="Reports"
        description="Monthly, quarterly and annual business reports from your real records, plus snapshots saved by the automations."
        actions={
          <>
            <Button icon={<Printer className="size-4" />} onClick={() => window.print()}>
              Print
            </Button>
            <Button variant="primary" href={`/api/finance/report.csv${query}`} download icon={<Download className="size-4" />}>
              Export CSV
            </Button>
          </>
        }
      />
      <div className="flex flex-wrap items-center gap-2 mb-5 no-print">
        <Segmented
          label="Report type"
          value={kind}
          onChange={(k) => {
            setKind(k);
            setPeriod(periodFor(k, today));
          }}
          options={[
            { value: 'month', label: 'Monthly' },
            { value: 'quarter', label: 'Quarterly' },
            { value: 'year', label: 'Annual' },
          ]}
        />
        <IconButton label="Previous period" onClick={() => setPeriod(shiftPeriod(period, -1))}>
          <ChevronLeft className="size-4" />
        </IconButton>
        <div className="min-w-32 text-center text-[14px] font-semibold">{period.label}</div>
        <IconButton label="Next period" disabled={!canNext} onClick={() => setPeriod(shiftPeriod(period, 1))}>
          <ChevronRight className="size-4" />
        </IconButton>
      </div>

      <Card className="mb-4">
        <CardHeader title={`${data.period.label} · money`} description={`Compared with ${data.previous_period.label}. Each currency is reported on its own.`} />
        {currencies.length === 0 ? (
          <EmptyState compact title="No financial activity in this period" />
        ) : (
          <div className="overflow-x-auto px-5 pb-5">
            {currencies.map((c) => {
              const rows: [string, number, number | null, boolean][] = [
                ['Cash collected', amt(s.collected, c), amt(data.previous.collected, c), true],
                ['Invoiced (excl. tax)', amt(s.invoiced.net, c), amt(data.previous.invoiced, c), true],
                ['Tax invoiced', amt(s.invoiced.tax, c), null, true],
                ['Expenses', amt(s.expenses, c), amt(data.previous.expenses, c), false],
                ['Net cash flow', amt(s.collected, c) - amt(s.expenses, c), amt(data.previous.collected, c) - amt(data.previous.expenses, c), true],
                ['Estimated profit', amt(s.invoiced.net, c) - amt(s.expenses, c), amt(data.previous.invoiced, c) - amt(data.previous.expenses, c), true],
              ];
              return (
                <table key={c} className="w-full text-[13px] mb-4 last:mb-0">
                  <thead>
                    <tr className="text-left text-[12px] text-ink-3 border-b border-line">
                      <th className="py-2 font-semibold text-ink">{c}</th>
                      <th className="py-2 text-right font-medium">{data.period.label}</th>
                      <th className="py-2 text-right font-medium">{data.previous_period.label}</th>
                      <th className="py-2 text-right font-medium w-20">Change</th>
                    </tr>
                  </thead>
                  <tbody className="tabular">
                    {rows.map(([label, now, prev, up]) => (
                      <tr key={label} className="border-b border-line last:border-0">
                        <td className="py-2 text-ink-2">{label}</td>
                        <td className={cx('py-2 text-right', now < 0 ? 'text-bad' : 'text-ink')}>{formatMoney(now, c)}</td>
                        <td className="py-2 text-right text-ink-3">{prev === null ? '—' : formatMoney(prev, c)}</td>
                        <td className="py-2 text-right">{prev === null ? <span className="text-ink-3">—</span> : <Change now={now} prev={prev} goodWhenUp={up} />}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              );
            })}
          </div>
        )}
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2">
          <CardHeader title="Operations" description="Work delivered and sales movement in this period." />
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 px-5 pb-5">
            {OPS.map(([k, l]) => (
              <div key={k} className="rounded-xl bg-white/[0.03] ring-1 ring-inset ring-white/[0.05] p-3">
                <div className="text-[11.5px] text-ink-3">{l}</div>
                <div className="text-[20px] font-semibold">{data.operations[k] ?? 0}</div>
              </div>
            ))}
            <div className="rounded-xl bg-white/[0.03] ring-1 ring-inset ring-white/[0.05] p-3">
              <div className="text-[11.5px] text-ink-3">Win rate</div>
              <div className="text-[20px] font-semibold">{pct(data.operations.win_rate as number | null)}</div>
            </div>
          </div>
        </Card>
        <Card>
          <CardHeader title="As of today" />
          <dl className="px-5 pb-5 flex flex-col gap-2 text-[13px]">
            <div className="flex justify-between gap-3">
              <dt className="text-ink-3">Outstanding</dt>
              <dd className="tabular text-right">{groupsText(s.receivables.outstanding)}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-ink-3">Overdue</dt>
              <dd className="tabular text-right text-bad">{groupsText(s.receivables.overdue)}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-ink-3">MRR (contracted)</dt>
              <dd className="tabular text-right">{groupsText(s.mrr.groups)}</dd>
            </div>
          </dl>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader title="Cash by client" />
          {s.by_client.length === 0 ? (
            <p className="px-5 pb-5 text-[13px] text-ink-3">No payments in this period.</p>
          ) : (
            <table className="w-full text-[13px] mb-3">
              <tbody>
                {s.by_client.slice(0, 12).map((c) => (
                  <tr key={c.client_id} className="border-t border-line">
                    <td className="py-2 px-5 text-ink-2">{c.name}</td>
                    <td className="py-2 px-3 text-right tabular">{groupsText(c.collected)}</td>
                    <td className="py-2 px-5 text-right tabular text-ink-3">{groupsText(c.invoiced)} invoiced</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
        <Card>
          <CardHeader title="Expenses by category" />
          {s.expenses_by_category.length === 0 ? (
            <p className="px-5 pb-5 text-[13px] text-ink-3">No expenses.</p>
          ) : (
            <ul className="px-5 pb-4 flex flex-col gap-1.5 text-[13px]">
              {s.expenses_by_category.map((e) => (
                <li key={e.category} className="flex justify-between gap-3">
                  <span className="text-ink-2">{EXPENSE_CATEGORY_LABELS[e.category as keyof typeof EXPENSE_CATEGORY_LABELS] ?? e.category}</span>
                  <span className="tabular">{groupsText(e.groups)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card className="mt-4 no-print">
        <CardHeader title="Saved reports" description="Weekly reports (every Monday) and monthly revenue summaries (every 1st), created by Automations." />
        {(snapshots.data?.snapshots ?? []).length === 0 ? (
          <EmptyState compact icon={<FileBarChart className="size-5" />} title="No saved reports yet" body="They are created automatically while the app is running. You can also run automations now from the Automations page." />
        ) : (
          <ul className="px-3 pb-3">
            {snapshots.data!.snapshots.map((sn) => (
              <li key={sn.id}>
                <button type="button" onClick={() => setSnapshot(sn.id)} className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-white/[0.04] cursor-pointer">
                  <Badge tone={sn.kind === 'weekly' ? 'info' : 'accent'}>{sn.kind === 'weekly' ? 'Weekly' : 'Monthly'}</Badge>
                  <span className="text-[13px] text-ink flex-1">
                    {formatDate(sn.period_start)} – {formatDate(sn.period_end)} {sn.is_demo ? <DemoBadge /> : null}
                  </span>
                  <span className="text-[12px] text-ink-3">{timeAgo(sn.created_at)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <SnapshotView id={snapshot} onClose={() => setSnapshot(null)} />
    </div>
  );
}
