import type { AppContext } from '../context.ts';
import { fxFromSettings } from '../lib/settings.ts';
import { invoiceStatusSql } from './invoices.ts';
import { sortGroups, subtractGroups, sumByCurrency, type FxSettings, type MoneyGroup } from '../../shared/money.ts';
import { addMonths, diffDays, monthRange, periodFor, shiftPeriod, startOfMonth, type PeriodKind } from '../../shared/dates.ts';
import { BILLING_CYCLE_MONTHS, type BillingCycle } from '../../shared/constants.ts';

// Definitions used everywhere in the app (and shown in the UI next to each figure):
// - Invoiced revenue: invoices that have been issued (marked sent), by issue date, excluding tax.
// - Cash collected: payments actually recorded, by payment date.
// - Outstanding receivables: unpaid balances on issued invoices, as of today.
// - MRR: contracted monthly retainer value of active clients. It is NOT cash.
// - Net cash flow: cash collected minus expenses. Estimated profit: invoiced revenue minus expenses.

type CurRow = { currency: string; amount_minor: number };

async function groups(ctx: AppContext, rows: CurRow[]): Promise<MoneyGroup[]> {
  return sumByCurrency(rows, (await ctx.settings()).base_currency);
}

export async function fxOrNull(ctx: AppContext): Promise<FxSettings | null> {
  const fx = fxFromSettings(await ctx.settings());
  return Object.values(fx.rates).some((r) => r > 0) ? fx : null;
}

export async function collected(ctx: AppContext, from: string, to: string): Promise<MoneyGroup[]> {
  return groups(
    ctx,
    await ctx.db.all<CurRow>('SELECT currency, SUM(amount_minor) AS amount_minor FROM payments WHERE paid_at BETWEEN :from AND :to GROUP BY currency', { from, to }),
  );
}

export async function invoiced(ctx: AppContext, from: string, to: string) {
  const rows = await ctx.db.all<{ currency: string; net: number; tax: number; gross: number; n: number }>(
    `SELECT currency, SUM(total_minor - tax_minor) AS net, SUM(tax_minor) AS tax, SUM(total_minor) AS gross, COUNT(*) AS n
       FROM invoices WHERE state = 'sent' AND issue_date BETWEEN :from AND :to GROUP BY currency`,
    { from, to },
  );
  return {
    net: await groups(ctx, rows.map((r) => ({ currency: r.currency, amount_minor: r.net }))),
    tax: (await groups(ctx, rows.map((r) => ({ currency: r.currency, amount_minor: r.tax })))).filter((g) => g.amount_minor !== 0),
    gross: await groups(ctx, rows.map((r) => ({ currency: r.currency, amount_minor: r.gross }))),
    count: rows.reduce((s, r) => s + r.n, 0),
  };
}

export async function expenses(ctx: AppContext, from: string, to: string): Promise<MoneyGroup[]> {
  return groups(
    ctx,
    await ctx.db.all<CurRow>('SELECT currency, SUM(amount_minor) AS amount_minor FROM expenses WHERE date BETWEEN :from AND :to GROUP BY currency', { from, to }),
  );
}

export async function expensesByCategory(ctx: AppContext, from: string, to: string) {
  const rows = await ctx.db.all<{ category: string; currency: string; amount_minor: number; n: number }>(
    'SELECT category, currency, SUM(amount_minor) AS amount_minor, COUNT(*) AS n FROM expenses WHERE date BETWEEN :from AND :to GROUP BY category, currency',
    { from, to },
  );
  const map = new Map<string, { category: string; groups: CurRow[]; count: number }>();
  for (const r of rows) {
    const e = map.get(r.category) ?? { category: r.category, groups: [], count: 0 };
    e.groups.push({ currency: r.currency, amount_minor: r.amount_minor });
    e.count += r.n;
    map.set(r.category, e);
  }
  return Promise.all([...map.values()].map(async (e) => ({ category: e.category, count: e.count, groups: await groups(ctx, e.groups) })));
}

/** Unpaid balances on issued invoices as of today, with an aging breakdown. */
export async function receivables(ctx: AppContext) {
  const today = await ctx.today();
  const rows = await ctx.db.all<{ id: number; currency: string; balance_minor: number; due_date: string; status: string }>(
    `SELECT b.id, b.currency, b.balance_minor, b.due_date, ${invoiceStatusSql('b')} AS status
       FROM invoice_balances b WHERE b.state = 'sent' AND b.balance_minor > 0`,
    { today },
  );
  const buckets = [
    { key: 'current', label: 'Not yet due', rows: [] as CurRow[] },
    { key: '1_30', label: '1–30 days overdue', rows: [] as CurRow[] },
    { key: '31_60', label: '31–60 days overdue', rows: [] as CurRow[] },
    { key: '61_90', label: '61–90 days overdue', rows: [] as CurRow[] },
    { key: '90_plus', label: '90+ days overdue', rows: [] as CurRow[] },
  ];
  for (const r of rows) {
    const late = diffDays(r.due_date, today);
    const idx = late <= 0 ? 0 : late <= 30 ? 1 : late <= 60 ? 2 : late <= 90 ? 3 : 4;
    buckets[idx].rows.push({ currency: r.currency, amount_minor: r.balance_minor });
  }
  const overdue = rows.filter((r) => r.status === 'overdue');
  return {
    outstanding: await groups(ctx, rows.map((r) => ({ currency: r.currency, amount_minor: r.balance_minor }))),
    overdue: await groups(ctx, overdue.map((r) => ({ currency: r.currency, amount_minor: r.balance_minor }))),
    count: rows.length,
    overdue_count: overdue.length,
    aging: await Promise.all(buckets.map(async (b) => ({ key: b.key, label: b.label, count: b.rows.length, groups: await groups(ctx, b.rows) }))),
  };
}

/** Contracted monthly recurring revenue from active retainer clients (quarterly/yearly normalised per month). */
export async function mrr(ctx: AppContext) {
  const rows = await ctx.db.all<{ id: number; name: string; company: string | null; retainer_minor: number; currency: string; billing_cycle: BillingCycle }>(
    `SELECT id, name, company, retainer_minor, currency, billing_cycle FROM clients
      WHERE status = 'active' AND archived_at IS NULL AND retainer_minor > 0`,
  );
  const perClient = rows.map((r) => ({
    client_id: r.id,
    name: r.company || r.name,
    currency: r.currency,
    amount_minor: Math.round(r.retainer_minor / BILLING_CYCLE_MONTHS[r.billing_cycle]),
  }));
  return { groups: await groups(ctx, perClient), clients: perClient.length, per_client: perClient.sort((a, b) => b.amount_minor - a.amount_minor) };
}

type LineRow = { invoice_id: number; currency: string; amount_minor: number; service_type: string; subtotal_minor: number; discount_minor: number; total_minor: number; tax_minor: number };

/** Split an invoice's discount across its lines so per-line net amounts add up exactly to the invoice net. */
function netLines(lines: LineRow[]): (LineRow & { net: number })[] {
  if (lines.length === 0) return [];
  const { subtotal_minor, discount_minor } = lines[0];
  let allocated = 0;
  return lines.map((l, i) => {
    let share = subtotal_minor > 0 ? Math.round((discount_minor * l.amount_minor) / subtotal_minor) : 0;
    if (i === lines.length - 1) share = discount_minor - allocated;
    allocated += share;
    return { ...l, net: l.amount_minor - share };
  });
}

async function linesByInvoice(ctx: AppContext, invoiceIds: number[]): Promise<Map<number, (LineRow & { net: number })[]>> {
  const out = new Map<number, (LineRow & { net: number })[]>();
  if (invoiceIds.length === 0) return out;
  const rows = await ctx.db.all<LineRow>(
    `SELECT it.invoice_id, i.currency, it.amount_minor, it.service_type, i.subtotal_minor, i.discount_minor, i.total_minor, i.tax_minor
       FROM invoice_items it JOIN invoices i ON i.id = it.invoice_id
      WHERE it.invoice_id = ANY(ARRAY(SELECT jsonb_array_elements_text(:ids::jsonb)::bigint))
      ORDER BY it.invoice_id, it.sort_order, it.id`,
    { ids: JSON.stringify(invoiceIds) },
  );
  const grouped = new Map<number, LineRow[]>();
  for (const r of rows) grouped.set(r.invoice_id, [...(grouped.get(r.invoice_id) ?? []), r]);
  for (const [id, lines] of grouped) out.set(id, netLines(lines));
  return out;
}

/** Revenue per service line: invoiced (excl. tax) and cash collected (payments attributed by line share). */
export async function revenueByService(ctx: AppContext, from: string, to: string) {
  const issued = (await ctx.db.all<{ id: number }>(`SELECT id FROM invoices WHERE state = 'sent' AND issue_date BETWEEN :from AND :to`, { from, to })).map((r) => r.id);
  const pays = await ctx.db.all<{ invoice_id: number; amount_minor: number; currency: string }>(
    'SELECT invoice_id, amount_minor, currency FROM payments WHERE paid_at BETWEEN :from AND :to',
    { from, to },
  );
  const lines = await linesByInvoice(ctx, [...new Set([...issued, ...pays.map((p) => p.invoice_id)])]);
  const inv = new Map<string, CurRow[]>();
  const cash = new Map<string, CurRow[]>();
  const push = (m: Map<string, CurRow[]>, k: string, row: CurRow) => m.set(k, [...(m.get(k) ?? []), row]);
  for (const id of issued) for (const l of lines.get(id) ?? []) push(inv, l.service_type, { currency: l.currency, amount_minor: l.net });
  for (const p of pays) {
    const ls = lines.get(p.invoice_id) ?? [];
    const taxable = ls.reduce((s, l) => s + l.net, 0);
    let allocated = 0;
    ls.forEach((l, i) => {
      let part = taxable > 0 ? Math.round((p.amount_minor * l.net) / taxable) : i === 0 ? p.amount_minor : 0;
      if (i === ls.length - 1) part = p.amount_minor - allocated;
      allocated += part;
      push(cash, l.service_type, { currency: p.currency, amount_minor: part });
    });
  }
  const keys = new Set([...inv.keys(), ...cash.keys()]);
  return Promise.all([...keys].map(async (service) => ({ service, invoiced: await groups(ctx, inv.get(service) ?? []), collected: await groups(ctx, cash.get(service) ?? []) })));
}

export async function revenueByClient(ctx: AppContext, from: string, to: string) {
  const cash = await ctx.db.all<{ client_id: number; currency: string; amount_minor: number }>(
    'SELECT client_id, currency, SUM(amount_minor) AS amount_minor FROM payments WHERE paid_at BETWEEN :from AND :to GROUP BY client_id, currency',
    { from, to },
  );
  const inv = await ctx.db.all<{ client_id: number; currency: string; amount_minor: number }>(
    `SELECT client_id, currency, SUM(total_minor - tax_minor) AS amount_minor FROM invoices
      WHERE state = 'sent' AND issue_date BETWEEN :from AND :to GROUP BY client_id, currency`,
    { from, to },
  );
  const ids = [...new Set([...cash, ...inv].map((r) => r.client_id))];
  const nameRows = ids.length
    ? await ctx.db.all<{ id: number; name: string; company: string | null; is_demo: number }>(
        'SELECT id, name, company, is_demo FROM clients WHERE id = ANY(ARRAY(SELECT jsonb_array_elements_text(:ids::jsonb)::bigint))',
        { ids: JSON.stringify(ids) },
      )
    : [];
  const names = new Map(nameRows.map((c) => [c.id, c]));
  return (await Promise.all(ids
    .map(async (id) => ({
      client_id: id,
      name: names.get(id)?.company || names.get(id)?.name || 'Unknown client',
      is_demo: names.get(id)?.is_demo ?? 0,
      collected: await groups(ctx, cash.filter((r) => r.client_id === id)),
      invoiced: await groups(ctx, inv.filter((r) => r.client_id === id)),
    }))))
    .sort((a, b) => (b.collected[0]?.amount_minor ?? 0) - (a.collected[0]?.amount_minor ?? 0));
}

/** Month-by-month series. Each month carries per-currency values; charts pick one currency at a time. */
export async function monthlySeries(ctx: AppContext, from: string, to: string) {
  const months = monthRange(from, to);
  const q = async (sql: string) => await ctx.db.all<{ m: string; currency: string; amount_minor: number }>(sql, { from, to });
  const cash = await q(`SELECT substr(paid_at,1,7) AS m, currency, SUM(amount_minor) AS amount_minor FROM payments WHERE paid_at BETWEEN :from AND :to GROUP BY m, currency`);
  const inv = await q(`SELECT substr(issue_date,1,7) AS m, currency, SUM(total_minor - tax_minor) AS amount_minor FROM invoices WHERE state = 'sent' AND issue_date BETWEEN :from AND :to GROUP BY m, currency`);
  const exp = await q(`SELECT substr(date,1,7) AS m, currency, SUM(amount_minor) AS amount_minor FROM expenses WHERE date BETWEEN :from AND :to GROUP BY m, currency`);
  const currencies = sortGroups(
    sumByCurrency([...cash, ...inv, ...exp].map((r) => ({ currency: r.currency, amount_minor: Math.abs(r.amount_minor) }))),
    (await ctx.settings()).base_currency,
  ).map((g) => g.currency);
  return {
    currencies,
    months: await Promise.all(months.map(async (m) => ({
      month: m,
      collected: await groups(ctx, cash.filter((r) => r.m === m)),
      invoiced: await groups(ctx, inv.filter((r) => r.m === m)),
      expenses: await groups(ctx, exp.filter((r) => r.m === m)),
    }))),
  };
}

export async function financeSummary(ctx: AppContext, from: string, to: string) {
  const col = await collected(ctx, from, to);
  const inv = await invoiced(ctx, from, to);
  const exp = await expenses(ctx, from, to);
  return {
    period: { from, to },
    base_currency: (await ctx.settings()).base_currency,
    fx: await fxOrNull(ctx),
    collected: col,
    invoiced: inv,
    expenses: exp,
    net_cash_flow: subtractGroups(col, exp, (await ctx.settings()).base_currency),
    estimated_profit: subtractGroups(inv.net, exp, (await ctx.settings()).base_currency),
    receivables: await receivables(ctx),
    mrr: await mrr(ctx),
    by_client: await revenueByClient(ctx, from, to),
    by_service: await revenueByService(ctx, from, to),
    expenses_by_category: await expensesByCategory(ctx, from, to),
    series: await monthlySeries(ctx, from, to),
    payments_count: await ctx.db.value<number>('SELECT COUNT(*) FROM payments WHERE paid_at BETWEEN :from AND :to', { from, to }) ?? 0,
  };
}

/** Operational counts for a period, used by the reports page and the automated snapshots. */
export async function operationsStats(ctx: AppContext, from: string, to: string) {
  const n = async (sql: string) => await ctx.db.value<number>(sql, { from, to }) ?? 0;
  const won = await n(`SELECT COUNT(*) FROM leads WHERE stage = 'won' AND substr(closed_at,1,10) BETWEEN :from AND :to`);
  const lost = await n(`SELECT COUNT(*) FROM leads WHERE stage = 'lost' AND substr(closed_at,1,10) BETWEEN :from AND :to`);
  return {
    new_clients: await n(`SELECT COUNT(*) FROM clients WHERE COALESCE(contract_start, substr(created_at,1,10)) BETWEEN :from AND :to`),
    projects_started: await n(`SELECT COUNT(*) FROM projects WHERE COALESCE(start_date, substr(created_at,1,10)) BETWEEN :from AND :to`),
    projects_delivered: await n(`SELECT COUNT(*) FROM projects WHERE status = 'delivered' AND substr(completed_at,1,10) BETWEEN :from AND :to`),
    deliverables_delivered: await n(`SELECT COUNT(*) FROM deliverables WHERE status = 'delivered' AND substr(delivered_at,1,10) BETWEEN :from AND :to`),
    revisions_requested: await n(`SELECT COUNT(*) FROM feedback WHERE kind = 'revision_request' AND substr(created_at,1,10) BETWEEN :from AND :to`),
    tasks_completed: await n(`SELECT COUNT(*) FROM tasks WHERE status = 'done' AND substr(completed_at,1,10) BETWEEN :from AND :to`),
    leads_added: await n(`SELECT COUNT(*) FROM leads WHERE substr(created_at,1,10) BETWEEN :from AND :to`),
    leads_won: won,
    leads_lost: lost,
    win_rate: won + lost > 0 ? won / (won + lost) : null,
  };
}

export async function periodReport(ctx: AppContext, kind: PeriodKind, anchor: string) {
  const period = periodFor(kind, anchor);
  const prev = shiftPeriod(period, -1);
  const summary = await financeSummary(ctx, period.start, period.end);
  const previous = {
    collected: await collected(ctx, prev.start, prev.end),
    invoiced: (await invoiced(ctx, prev.start, prev.end)).net,
    expenses: await expenses(ctx, prev.start, prev.end),
  };
  return {
    period,
    previous_period: prev,
    summary,
    previous,
    operations: await operationsStats(ctx, period.start, period.end),
    generated_at: ctx.nowIso(),
  };
}

/** Last 12 months ending with the current month (for dashboard charts). */
export async function trailingYear(ctx: AppContext) {
  const today = await ctx.today();
  return monthlySeries(ctx, startOfMonth(addMonths(today, -11)), today);
}
