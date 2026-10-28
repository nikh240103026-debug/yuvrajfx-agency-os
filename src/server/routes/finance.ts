import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../context.ts';
import { badRequest, notFound, parse } from '../lib/http.ts';
import { toCsv } from '../lib/csv.ts';
import { sendCsv } from './common.ts';
import { financeSummary, periodReport } from '../services/finance.ts';
import { isValidDate, periodFor, type PeriodKind } from '../../shared/dates.ts';
import { fromMinor, type MoneyGroup } from '../../shared/money.ts';
import { EXPENSE_CATEGORY_LABELS, SERVICE_TYPE_LABELS } from '../../shared/constants.ts';
import { json } from '../db/db.ts';

const rangeQuery = z.object({
  period: z.enum(['month', 'quarter', 'year', 'custom']).optional().catch('month'),
  date: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});

function resolveRange(ctx: AppContext, q: z.output<typeof rangeQuery>) {
  const today = ctx.today();
  if (q.period === 'custom') {
    if (!q.from || !q.to || !isValidDate(q.from) || !isValidDate(q.to)) throw badRequest('Pick a valid start and end date.');
    if (q.to < q.from) throw badRequest('The end date is before the start date.');
    return { kind: 'custom' as const, start: q.from, end: q.to, label: `${q.from} → ${q.to}` };
  }
  const anchor = q.date && isValidDate(q.date) ? q.date : today;
  return periodFor((q.period ?? 'month') as PeriodKind, anchor);
}

type ReportRow = { section: string; metric: string; currency: string; amount: string };

function groupRows(section: string, metric: string, groups: MoneyGroup[]): ReportRow[] {
  if (groups.length === 0) return [{ section, metric, currency: '', amount: '0' }];
  return groups.map((g) => ({ section, metric, currency: g.currency, amount: fromMinor(g.amount_minor, g.currency) }));
}

function reportRows(report: ReturnType<typeof periodReport>): ReportRow[] {
  const s = report.summary;
  const rows: ReportRow[] = [
    ...groupRows('Revenue', 'Cash collected', s.collected),
    ...groupRows('Revenue', 'Invoiced (excl. tax)', s.invoiced.net),
    ...groupRows('Revenue', 'Tax invoiced', s.invoiced.tax),
    ...groupRows('Costs', 'Expenses', s.expenses),
    ...groupRows('Result', 'Net cash flow (collected − expenses)', s.net_cash_flow),
    ...groupRows('Result', 'Estimated profit (invoiced − expenses)', s.estimated_profit),
    ...groupRows('Receivables (today)', 'Outstanding', s.receivables.outstanding),
    ...groupRows('Receivables (today)', 'Overdue', s.receivables.overdue),
    ...groupRows('Recurring (today)', 'MRR (contracted, not collected)', s.mrr.groups),
  ];
  for (const c of s.by_client) rows.push(...groupRows('Cash collected by client', c.name, c.collected));
  for (const sv of s.by_service) rows.push(...groupRows('Invoiced by service (excl. tax)', SERVICE_TYPE_LABELS[sv.service as keyof typeof SERVICE_TYPE_LABELS] ?? sv.service, sv.invoiced));
  for (const e of s.expenses_by_category) rows.push(...groupRows('Expenses by category', EXPENSE_CATEGORY_LABELS[e.category as keyof typeof EXPENSE_CATEGORY_LABELS] ?? e.category, e.groups));
  for (const m of s.series.months) {
    rows.push(...groupRows(`Month ${m.month}`, 'Cash collected', m.collected));
    rows.push(...groupRows(`Month ${m.month}`, 'Invoiced (excl. tax)', m.invoiced));
    rows.push(...groupRows(`Month ${m.month}`, 'Expenses', m.expenses));
  }
  const o = report.operations;
  const count = (metric: string, v: number | null) => rows.push({ section: 'Operations', metric, currency: '', amount: v === null ? '' : String(v) });
  count('New clients', o.new_clients);
  count('Projects started', o.projects_started);
  count('Projects delivered', o.projects_delivered);
  count('Deliverables delivered', o.deliverables_delivered);
  count('Revision requests', o.revisions_requested);
  count('Tasks completed', o.tasks_completed);
  count('Leads added', o.leads_added);
  count('Deals won', o.leads_won);
  count('Deals lost', o.leads_lost);
  count('Win rate %', o.win_rate === null ? null : Math.round(o.win_rate * 100));
  return rows;
}

export function financeRouter(ctx: AppContext): Router {
  const r = Router();

  r.get('/summary', (req, res) => {
    const range = resolveRange(ctx, parse(rangeQuery, req.query));
    res.json({ range, ...financeSummary(ctx, range.start, range.end) });
  });

  r.get('/report', (req, res) => {
    const q = parse(rangeQuery, req.query);
    if (q.period === 'custom') throw badRequest('Reports are monthly, quarterly or annual.');
    const anchor = q.date && isValidDate(q.date) ? q.date : ctx.today();
    res.json(periodReport(ctx, (q.period ?? 'month') as PeriodKind, anchor));
  });

  r.get('/report.csv', (req, res) => {
    const q = parse(rangeQuery, req.query);
    const anchor = q.date && isValidDate(q.date) ? q.date : ctx.today();
    const kind = (q.period === 'custom' ? 'month' : q.period ?? 'month') as PeriodKind;
    const report = periodReport(ctx, kind, anchor);
    const csv = toCsv(reportRows(report), [
      { header: 'Section', value: (x) => x.section },
      { header: 'Metric', value: (x) => x.metric },
      { header: 'Currency', value: (x) => x.currency },
      { header: 'Amount', value: (x) => x.amount },
    ]);
    sendCsv(ctx, res, `report-${report.period.label.toLowerCase().replace(/\s+/g, '-')}`, csv);
  });

  r.get('/snapshots', (_req, res) => {
    res.json({
      snapshots: ctx.db.all('SELECT id, kind, period_start, period_end, created_at, is_demo FROM report_snapshots ORDER BY period_start DESC, id DESC LIMIT 200'),
    });
  });

  r.get('/snapshots/:id', (req, res) => {
    const row = ctx.db.get<{ id: number; kind: string; period_start: string; period_end: string; data: string; created_at: string }>(
      'SELECT * FROM report_snapshots WHERE id = :id',
      { id: Number(req.params.id) || 0 },
    );
    if (!row) throw notFound('Report');
    res.json({ snapshot: { ...row, data: json(row.data, {}) } });
  });

  return r;
}
