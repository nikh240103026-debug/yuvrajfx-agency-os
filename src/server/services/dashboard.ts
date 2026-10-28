import type { AppContext } from '../context.ts';
import type { SessionUser } from '../lib/auth.ts';
import { ADMIN_ROLES, STAGES } from '../../shared/constants.ts';
import { addDays, addMonths, diffDays, formatDate, monthKey, monthLabel, periodFor, relativeDay, shiftPeriod, startOfMonth } from '../../shared/dates.ts';
import { formatMoney, subtractGroups } from '../../shared/money.ts';
import { collected, expenses, fxOrNull, invoiced, mrr, receivables, revenueByClient, trailingYear } from './finance.ts';
import { pipelineValue } from './pipeline.ts';
import { retainerDraftPreview } from './invoices.ts';

export type NextAction = {
  kind: string;
  severity: 'critical' | 'warning' | 'info';
  title: string;
  detail: string;
  link: string;
  date: string | null;
};

const SEVERITY_RANK = { critical: 0, warning: 1, info: 2 } as const;

export function buildDashboard(ctx: AppContext, user: SessionUser) {
  const today = ctx.today();
  const admin = ADMIN_ROLES.includes(user.role);
  const month = periodFor('month', today);
  const prevMonth = shiftPeriod(month, -1);
  const weekAhead = addDays(today, 7);
  const n = (sql: string, params: Record<string, unknown> = {}) => ctx.db.value<number>(sql, { today, ...params }) ?? 0;

  // ── Production ──
  const counts = {
    active_clients: n(`SELECT COUNT(*) FROM clients WHERE status = 'active' AND archived_at IS NULL`),
    onboarding_clients: n(`SELECT COUNT(*) FROM clients WHERE status = 'onboarding' AND archived_at IS NULL`),
    active_projects: n(`SELECT COUNT(*) FROM projects WHERE archived_at IS NULL AND status IN ('backlog','editing','internal_review','client_review','revisions','approved')`),
    open_deliverables: n(`SELECT COUNT(*) FROM deliverables d JOIN projects p ON p.id = d.project_id WHERE d.status <> 'delivered' AND p.archived_at IS NULL AND p.status NOT IN ('cancelled','on_hold')`),
    due_this_week: n(
      `SELECT COUNT(*) FROM deliverables d JOIN projects p ON p.id = d.project_id
        WHERE d.status <> 'delivered' AND d.deadline BETWEEN :today AND :week AND p.archived_at IS NULL AND p.status NOT IN ('cancelled','on_hold')`,
      { week: weekAhead },
    ),
    overdue_deliverables: n(
      `SELECT COUNT(*) FROM deliverables d JOIN projects p ON p.id = d.project_id
        WHERE d.status <> 'delivered' AND d.deadline < :today AND p.archived_at IS NULL AND p.status NOT IN ('cancelled','on_hold')`,
    ),
    overdue_tasks: n(`SELECT COUNT(*) FROM tasks WHERE status IN ('todo','in_progress') AND due_date < :today`),
    tasks_today: n(`SELECT COUNT(*) FROM tasks WHERE status IN ('todo','in_progress') AND due_date = :today`),
    delivered_this_month: n(`SELECT COUNT(*) FROM deliverables WHERE status = 'delivered' AND substr(delivered_at,1,10) BETWEEN :a AND :b`, { a: month.start, b: month.end }),
    in_client_review: n(`SELECT COUNT(*) FROM deliverables d JOIN projects p ON p.id = d.project_id WHERE d.status = 'client_review' AND p.archived_at IS NULL`),
  };

  const stageCounts = ctx.db.all<{ status: string; n: number }>(
    `SELECT d.status, COUNT(*) AS n FROM deliverables d JOIN projects p ON p.id = d.project_id
      WHERE p.archived_at IS NULL AND p.status NOT IN ('cancelled','on_hold')
        AND (d.status <> 'delivered' OR substr(d.delivered_at,1,10) >= :since)
      GROUP BY d.status`,
    { since: month.start },
  );
  const stage_distribution = STAGES.map((s) => ({ stage: s, count: stageCounts.find((r) => r.status === s)?.n ?? 0 }));

  const due_soon = ctx.db.all(
    `SELECT d.id, d.title, d.deadline, d.status, d.project_id, p.name AS project_name, COALESCE(c.company, c.name) AS client_name,
            t.name AS assignee_name, t.color AS assignee_color, d.is_demo, (d.deadline < :today) AS is_overdue
       FROM deliverables d JOIN projects p ON p.id = d.project_id JOIN clients c ON c.id = p.client_id
       LEFT JOIN team_members t ON t.id = COALESCE(d.assignee_id, p.editor_id)
      WHERE d.status <> 'delivered' AND d.deadline IS NOT NULL AND d.deadline <= :week
        AND p.archived_at IS NULL AND p.status NOT IN ('cancelled','on_hold')
      ORDER BY d.deadline, d.id LIMIT 10`,
    { today, week: weekAhead },
  );

  const recent_activity = ctx.db.all(
    `SELECT id, entity_type, entity_id, client_id, project_id, action, summary, actor_type, actor_name, created_at, is_demo
       FROM activity ${admin ? '' : "WHERE entity_type NOT IN ('invoice','payment','expense','lead')"}
      ORDER BY created_at DESC, id DESC LIMIT 14`,
  );

  // ── Next actions ──
  const actions: NextAction[] = [];
  for (const d of ctx.db.all<{ id: number; title: string; deadline: string; project_id: number; client_name: string }>(
    `SELECT d.id, d.title, d.deadline, d.project_id, COALESCE(c.company, c.name) AS client_name
       FROM deliverables d JOIN projects p ON p.id = d.project_id JOIN clients c ON c.id = p.client_id
      WHERE d.status <> 'delivered' AND d.deadline IS NOT NULL AND d.deadline <= :tomorrow AND p.archived_at IS NULL AND p.status NOT IN ('cancelled','on_hold')
      ORDER BY d.deadline LIMIT 8`,
    { tomorrow: addDays(today, 1) },
  )) {
    const late = d.deadline < today;
    actions.push({
      kind: late ? 'deliverable_overdue' : 'deliverable_due',
      severity: late ? 'critical' : 'warning',
      title: late ? `Overdue: “${d.title}”` : `Due ${relativeDay(d.deadline, today)}: “${d.title}”`,
      detail: `${d.client_name}${late ? ` · was due ${formatDate(d.deadline, today)} (${diffDays(d.deadline, today)}d late)` : ''}`,
      link: `/projects/${d.project_id}`,
      date: d.deadline,
    });
  }
  for (const f of ctx.db.all<{ id: number; project_id: number; deliverable_title: string | null; client_name: string; kind: string; created_at: string }>(
    `SELECT f.id, f.project_id, d.title AS deliverable_title, COALESCE(c.company, c.name) AS client_name, f.kind, f.created_at
       FROM feedback f JOIN projects p ON p.id = f.project_id JOIN clients c ON c.id = p.client_id LEFT JOIN deliverables d ON d.id = f.deliverable_id
      WHERE f.author_type = 'client' AND f.resolved_at IS NULL AND f.kind IN ('comment','revision_request')
      ORDER BY f.created_at LIMIT 6`,
  )) {
    actions.push({
      kind: 'client_feedback',
      severity: 'warning',
      title: f.kind === 'revision_request' ? `${f.client_name} requested changes` : `New comment from ${f.client_name}`,
      detail: f.deliverable_title ? `On “${f.deliverable_title}”` : 'Project feedback',
      link: `/projects/${f.project_id}`,
      date: f.created_at.slice(0, 10),
    });
  }
  for (const t of ctx.db.all<{ id: number; title: string; due_date: string }>(
    `SELECT id, title, due_date FROM tasks WHERE status IN ('todo','in_progress') AND due_date <= :today ORDER BY due_date, id LIMIT 6`,
    { today },
  )) {
    const late = t.due_date < today;
    actions.push({
      kind: late ? 'task_overdue' : 'task_today',
      severity: late ? 'warning' : 'info',
      title: t.title,
      detail: late ? `Task overdue since ${formatDate(t.due_date, today)}` : 'Task due today',
      link: '/tasks',
      date: t.due_date,
    });
  }

  let finance: Record<string, unknown> | null = null;
  if (admin) {
    const rec = receivables(ctx);
    for (const inv of ctx.db.all<{ id: number; number: string; due_date: string; balance_minor: number; currency: string; client_name: string }>(
      `SELECT b.id, b.number, b.due_date, b.balance_minor, b.currency, COALESCE(c.company, c.name) AS client_name
         FROM invoice_balances b JOIN clients c ON c.id = b.client_id
        WHERE b.state = 'sent' AND b.balance_minor > 0 AND b.due_date < :today ORDER BY b.due_date LIMIT 6`,
      { today },
    )) {
      actions.push({
        kind: 'invoice_overdue',
        severity: 'critical',
        title: `Chase ${inv.number} · ${formatMoney(inv.balance_minor, inv.currency)}`,
        detail: `${inv.client_name} · ${diffDays(inv.due_date, today)} days overdue`,
        link: `/invoices/${inv.id}`,
        date: inv.due_date,
      });
    }
    for (const l of ctx.db.all<{ id: number; name: string; company: string | null; next_follow_up: string; stage: string }>(
      `SELECT id, name, company, next_follow_up, stage FROM leads WHERE stage NOT IN ('won','lost') AND next_follow_up <= :today ORDER BY next_follow_up LIMIT 5`,
      { today },
    )) {
      actions.push({
        kind: 'follow_up',
        severity: l.next_follow_up < today ? 'warning' : 'info',
        title: `Follow up with ${l.company ?? l.name}`,
        detail: l.next_follow_up < today ? `Follow-up was due ${formatDate(l.next_follow_up, today)}` : 'Follow-up due today',
        link: `/pipeline?lead=${l.id}`,
        date: l.next_follow_up,
      });
    }
    for (const c of ctx.db.all<{ id: number; name: string; company: string | null; renewal_date: string }>(
      `SELECT id, name, company, renewal_date FROM clients WHERE archived_at IS NULL AND status IN ('active','onboarding','paused') AND renewal_date BETWEEN :today AND :until ORDER BY renewal_date LIMIT 4`,
      { today, until: addDays(today, 14) },
    )) {
      actions.push({ kind: 'renewal', severity: 'info', title: `${c.company ?? c.name} renews ${relativeDay(c.renewal_date, today)}`, detail: 'Confirm scope and pricing', link: `/clients/${c.id}`, date: c.renewal_date });
    }
    const drafts = n(`SELECT COUNT(*) FROM invoices WHERE state = 'draft'`);
    if (drafts) actions.push({ kind: 'drafts', severity: 'info', title: `${drafts} draft invoice${drafts === 1 ? '' : 's'} not sent yet`, detail: 'Review and send, then mark as sent', link: '/invoices?status=draft', date: null });
    const missingRetainers = retainerDraftPreview(ctx, monthKey(today)).filter((p) => !p.existing_invoice);
    if (missingRetainers.length) {
      actions.push({
        kind: 'retainers',
        severity: 'info',
        title: `Bill ${missingRetainers.length} retainer${missingRetainers.length === 1 ? '' : 's'} for ${monthLabel(monthKey(today), 'long')}`,
        detail: missingRetainers.slice(0, 3).map((p) => p.client_name).join(', ') + (missingRetainers.length > 3 ? '…' : ''),
        link: '/invoices?retainers=1',
        date: null,
      });
    }
    const pendingEmails = n(`SELECT COUNT(*) FROM outbox WHERE status = 'pending_approval'`);
    if (pendingEmails) actions.push({ kind: 'outbox', severity: 'info', title: `${pendingEmails} drafted email${pendingEmails === 1 ? '' : 's'} waiting for your approval`, detail: 'Nothing is sent until you approve it', link: '/automations?tab=outbox', date: null });

    const colMonth = collected(ctx, month.start, month.end);
    const expMonth = expenses(ctx, month.start, month.end);
    finance = {
      mrr: mrr(ctx),
      collected_month: colMonth,
      collected_prev_month: collected(ctx, prevMonth.start, prevMonth.end),
      invoiced_month: invoiced(ctx, month.start, month.end).net,
      expenses_month: expMonth,
      expenses_prev_month: expenses(ctx, prevMonth.start, prevMonth.end),
      net_month: subtractGroups(colMonth, expMonth, ctx.settings().base_currency),
      receivables: rec,
      pipeline: pipelineValue(ctx),
      series: trailingYear(ctx),
      top_clients: revenueByClient(ctx, startOfMonth(addMonths(today, -11)), today).slice(0, 8),
      fx: fxOrNull(ctx),
    };
  }

  actions.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || (a.date ?? '9999').localeCompare(b.date ?? '9999'));

  return {
    today,
    month: { ...month, label: month.label },
    base_currency: ctx.settings().base_currency,
    counts,
    stage_distribution,
    due_soon,
    recent_activity,
    next_actions: actions.slice(0, 14),
    finance,
    has_any_data: n('SELECT (SELECT COUNT(*) FROM clients) + (SELECT COUNT(*) FROM projects) + (SELECT COUNT(*) FROM leads)') > 0,
    demo_data: n(`SELECT (SELECT COUNT(*) FROM clients WHERE is_demo = 1) + (SELECT COUNT(*) FROM leads WHERE is_demo = 1)`) > 0,
  };
}
