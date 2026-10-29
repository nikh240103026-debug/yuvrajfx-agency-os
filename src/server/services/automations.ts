import type { AppContext } from '../context.ts';
import { logActivity, SYSTEM_ACTOR, type Actor } from '../lib/activity.ts';
import { json } from '../db/db.ts';
import { conflict, notFound } from '../lib/http.ts';
import { notify } from './notifications.ts';
import { materializeRecurring } from './recurrence.ts';
import { getInvoice, invoiceStatusSql } from './invoices.ts';
import { financeSummary, operationsStats } from './finance.ts';
import { pipelineValue } from './pipeline.ts';
import { demoPresent } from './demo.ts';
import { addDays, diffDays, endOfMonth, formatDate, formatDateLong, monthLabel, startOfMonth, startOfWeek, addMonths } from '../../shared/dates.ts';
import { formatMoney, type MoneyGroup } from '../../shared/money.ts';
import { AUTOMATION_KEYS, type AutomationKey } from '../../shared/constants.ts';

// The automation layer only ever:
//  - creates in-app notifications and tasks,
//  - materialises recurring tasks/projects the owner set up,
//  - saves report snapshots,
//  - DRAFTS emails into the outbox. Drafts are sent only when a person presses "Approve & send",
//    and only if SMTP is configured. It never records payments or changes invoices.

export type AutomationDef = {
  key: AutomationKey;
  title: string;
  description: string;
  defaults: Record<string, unknown>;
  external: boolean;
};

export const AUTOMATIONS: AutomationDef[] = [
  {
    key: 'deadline_reminders',
    title: 'Deadline reminders',
    description: 'Notifies you about deliverables and projects due soon, and about overdue deliverables and tasks.',
    defaults: { days_before: 2 },
    external: false,
  },
  {
    key: 'overdue_invoice_reminders',
    title: 'Overdue invoice reminders',
    description: 'Flags overdue invoices and drafts a polite reminder email to the client for your approval. Nothing is sent automatically.',
    defaults: { draft_client_emails: true, repeat_every_days: 7, grace_days: 1 },
    external: true,
  },
  {
    key: 'renewal_reminders',
    title: 'Client renewal reminders',
    description: 'Reminds you before a client contract renews and adds a follow-up task.',
    defaults: { days_before: 14, create_task: true },
    external: false,
  },
  {
    key: 'follow_up_reminders',
    title: 'Sales follow-ups',
    description: 'Notifies you when a prospect follow-up is due or overdue.',
    defaults: {},
    external: false,
  },
  {
    key: 'recurring_work',
    title: 'Recurring tasks & projects',
    description: 'Creates the recurring tasks and projects you scheduled (monthly invoicing, weekly client updates, monthly content packs…).',
    defaults: {},
    external: false,
  },
  {
    key: 'monthly_revenue_summary',
    title: 'Monthly revenue summary',
    description: 'On the 1st, saves a summary of last month (cash collected, invoiced, expenses, receivables). Optionally drafts it as an email to you.',
    defaults: { email_owner: false },
    external: true,
  },
  {
    key: 'weekly_report',
    title: 'Weekly business report',
    description: 'Every Monday, saves a report of last week: money in and out, work delivered, pipeline movement. Optionally drafts it as an email to you.',
    defaults: { email_owner: false },
    external: true,
  },
];

export async function automationConfig(ctx: AppContext, key: AutomationKey): Promise<{ enabled: boolean; config: Record<string, unknown> }> {
  const def = AUTOMATIONS.find((a) => a.key === key)!;
  const row = await ctx.db.get<{ enabled: number; config: string }>('SELECT enabled, config FROM automation_settings WHERE key = :key', { key });
  return { enabled: row ? !!row.enabled : true, config: { ...def.defaults, ...(row ? json<Record<string, unknown>>(row.config, {}) : {}) } };
}

export async function listAutomations(ctx: AppContext) {
  return Promise.all(AUTOMATIONS.map(async (a) => {
    const row = await ctx.db.get<{ last_run_at: string | null; last_result: string | null }>('SELECT last_run_at, last_result FROM automation_settings WHERE key = :key', { key: a.key });
    const { enabled, config } = await automationConfig(ctx, a.key);
    return { ...a, enabled, config, last_run_at: row?.last_run_at ?? null, last_result: row?.last_result ? json(row.last_result, null) : null };
  }));
}

export async function saveAutomation(ctx: AppContext, key: AutomationKey, patch: { enabled?: boolean; config?: Record<string, unknown> }): Promise<void> {
  const current = await automationConfig(ctx, key);
  const enabled = patch.enabled ?? current.enabled;
  const config = { ...current.config, ...(patch.config ?? {}) };
  await ctx.db.run(
    `INSERT INTO automation_settings (key, enabled, config) VALUES (:key, :enabled, :config)
     ON CONFLICT(key) DO UPDATE SET enabled = excluded.enabled, config = excluded.config`,
    { key, enabled: enabled ? 1 : 0, config: JSON.stringify(config) },
  );
}

// ── Email drafts ─────────────────────────────────────────────────────────────

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

function moneyLine(groups: MoneyGroup[]): string {
  return groups.length ? groups.map((g) => formatMoney(g.amount_minor, g.currency)).join(' + ') : '—';
}

/**
 * Draft an invoice email (cover note or payment reminder) into the outbox. Returns the outbox id,
 * or null when the client has no email address. Never sends anything.
 */
export async function draftInvoiceEmail(ctx: AppContext, invoiceId: number, purpose: 'send' | 'reminder', trigger: 'manual' | 'automation', dedupeKey?: string): Promise<number | null> {
  const inv = await getInvoice(ctx, invoiceId);
  if (!inv) throw notFound('Invoice');
  if (inv.state === 'void') throw conflict('This invoice is void.');
  const client = inv.client as { name: string; company: string | null; email: string | null } | undefined;
  if (!client?.email) return null;
  const s = await ctx.settings();
  const amount = formatMoney(inv.total_minor, inv.currency, { decimals: 'always' });
  const balance = formatMoney(inv.balance_minor, inv.currency, { decimals: 'always' });
  const lines =
    purpose === 'reminder'
      ? [
          `Hi ${firstName(client.name)},`,
          '',
          `A friendly reminder that invoice ${inv.number} (${amount}) was due on ${formatDateLong(inv.due_date)}${inv.days_overdue > 0 ? ` — ${inv.days_overdue} day${inv.days_overdue === 1 ? '' : 's'} ago` : ''}.`,
          inv.paid_minor > 0 ? `Thank you for the payment received so far; the remaining balance is ${balance}.` : `The outstanding balance is ${balance}.`,
          '',
          ...(s.payment_instructions ? ['Payment details:', s.payment_instructions, ''] : []),
          'If the payment is already on its way, please ignore this note — and thank you!',
          '',
          'Best regards,',
          s.business_name,
        ]
      : [
          `Hi ${firstName(client.name)},`,
          '',
          `Please find the details of invoice ${inv.number} below.`,
          '',
          `Amount due: ${balance}`,
          `Issued: ${formatDateLong(inv.issue_date)}`,
          `Due by: ${formatDateLong(inv.due_date)}`,
          '',
          ...(s.payment_instructions ? ['Payment details:', s.payment_instructions, ''] : []),
          'Let me know if you have any questions.',
          '',
          'Best regards,',
          s.business_name,
        ];
  const now = ctx.nowIso();
  const r = await ctx.db.run(
    `INSERT INTO outbox (automation_key, channel, to_address, to_name, subject, body, status, entity_type, entity_id, client_id, dedupe_key, is_demo, created_at, updated_at)
     VALUES (:key, 'email', :to, :to_name, :subject, :body, 'pending_approval', 'invoice', :invoice_id, :client_id, :dedupe, :is_demo, :now, :now)
     ON CONFLICT(dedupe_key) DO NOTHING RETURNING id`,
    {
      key: trigger === 'automation' ? 'overdue_invoice_reminders' : null,
      to: client.email,
      to_name: client.name,
      subject: purpose === 'reminder' ? `Payment reminder: invoice ${inv.number} (${balance} outstanding)` : `Invoice ${inv.number} from ${s.business_name}`,
      body: lines.join('\n'),
      invoice_id: inv.id,
      client_id: inv.client_id,
      dedupe: dedupeKey ?? null,
      is_demo: inv.is_demo,
      now,
    },
  );
  if (r.changes === 0) return null;
  return r.lastInsertRowid;
}

async function draftOwnerEmail(ctx: AppContext, key: AutomationKey, subject: string, body: string, dedupe: string, isDemo = 0): Promise<number | null> {
  const to = (await ctx.settings()).owner_report_email;
  if (!to) return null;
  const now = ctx.nowIso();
  const r = await ctx.db.run(
    `INSERT INTO outbox (automation_key, channel, to_address, to_name, subject, body, status, dedupe_key, is_demo, created_at, updated_at)
     VALUES (:key, 'email', :to, NULL, :subject, :body, 'pending_approval', :dedupe, :is_demo, :now, :now)
     ON CONFLICT(dedupe_key) DO NOTHING RETURNING id`,
    { key, to, subject, body, dedupe, is_demo: isDemo, now },
  );
  return r.changes ? r.lastInsertRowid : null;
}

// ── Report snapshots ─────────────────────────────────────────────────────────

export async function buildPeriodSnapshot(ctx: AppContext, from: string, to: string) {
  const f = await financeSummary(ctx, from, to);
  return {
    period: { from, to },
    collected: f.collected,
    invoiced: f.invoiced.net,
    expenses: f.expenses,
    net_cash_flow: f.net_cash_flow,
    estimated_profit: f.estimated_profit,
    receivables: { outstanding: f.receivables.outstanding, overdue: f.receivables.overdue, overdue_count: f.receivables.overdue_count },
    mrr: f.mrr.groups,
    top_clients: f.by_client.slice(0, 5).map((c) => ({ name: c.name, collected: c.collected })),
    operations: await operationsStats(ctx, from, to),
    pipeline: await pipelineValue(ctx),
    upcoming_deadlines: await ctx.db.value<number>(`SELECT COUNT(*) FROM deliverables WHERE status <> 'delivered' AND deadline BETWEEN :a AND :b`, { a: addDays(to, 1), b: addDays(to, 7) }) ?? 0,
  };
}

function snapshotText(title: string, s: ReturnType<typeof buildPeriodSnapshot>): string {
  const o = s.operations;
  return [
    title,
    '',
    `Cash collected: ${moneyLine(s.collected)}`,
    `Invoiced (excl. tax): ${moneyLine(s.invoiced)}`,
    `Expenses: ${moneyLine(s.expenses)}`,
    `Net cash flow: ${moneyLine(s.net_cash_flow)}`,
    `Outstanding receivables today: ${moneyLine(s.receivables.outstanding)} (${s.receivables.overdue_count} overdue)`,
    `MRR (contracted): ${moneyLine(s.mrr)}`,
    '',
    `Deliverables delivered: ${o.deliverables_delivered} · Projects delivered: ${o.projects_delivered} · Revision requests: ${o.revisions_requested}`,
    `New leads: ${o.leads_added} · Won: ${o.leads_won} · Lost: ${o.leads_lost}`,
    `Deliverables due next 7 days: ${s.upcoming_deadlines}`,
    '',
    'Amounts in different currencies are listed separately, never added together.',
  ].join('\n');
}

async function saveSnapshot(ctx: AppContext, kind: 'weekly' | 'monthly', from: string, to: string): Promise<{ created: boolean; id: number | null; data: ReturnType<typeof buildPeriodSnapshot> | null }> {
  if (await ctx.db.get('SELECT 1 FROM report_snapshots WHERE kind = :kind AND period_start = :from', { kind, from })) return { created: false, id: null, data: null };
  const data = await buildPeriodSnapshot(ctx, from, to);
  // A snapshot taken while demo data exists includes demo numbers, so it is removed with the demo data.
  const id = await ctx.db.insert('report_snapshots', { kind, period_start: from, period_end: to, data, is_demo: await demoPresent(ctx) ? 1 : 0, created_at: ctx.nowIso() });
  return { created: true, id, data };
}

// ── The runner ───────────────────────────────────────────────────────────────

type RunSummary = Record<string, Record<string, number> | string>;

async function runDeadlineReminders(ctx: AppContext, cfg: Record<string, unknown>) {
  const today = await ctx.today();
  const days = Math.max(0, Math.min(30, Number(cfg.days_before) || 2));
  const horizon = addDays(today, days);
  let soon = 0;
  let overdue = 0;
  const due = await ctx.db.all<{ id: number; title: string; deadline: string; project_id: number; project_name: string; client_name: string; is_demo: number }>(
    `SELECT d.id, d.title, d.deadline, d.project_id, p.name AS project_name, COALESCE(c.company, c.name) AS client_name, d.is_demo
       FROM deliverables d JOIN projects p ON p.id = d.project_id JOIN clients c ON c.id = p.client_id
      WHERE d.status <> 'delivered' AND d.deadline IS NOT NULL AND d.deadline <= :horizon
        AND p.status NOT IN ('cancelled','on_hold') AND p.archived_at IS NULL`,
    { horizon },
  );
  for (const d of due) {
    const late = d.deadline < today;
    const created = await notify(ctx, {
      kind: late ? 'deliverable_overdue' : 'deadline_soon',
      audience: 'staff',
      severity: late ? 'critical' : 'warning',
      title: late ? `Overdue: “${d.title}”` : `Due ${diffDays(today, d.deadline) === 0 ? 'today' : diffDays(today, d.deadline) === 1 ? 'tomorrow' : formatDate(d.deadline, today)}: “${d.title}”`,
      body: `${d.client_name} · ${d.project_name}${late ? ` · was due ${formatDate(d.deadline, today)}` : ''}`,
      link: `/projects/${d.project_id}`,
      entity_type: 'deliverable',
      entity_id: d.id,
      dedupe_key: `${late ? 'deliverable_overdue' : 'deadline_soon'}:${d.id}:${d.deadline}`,
      is_demo: d.is_demo,
    });
    if (created) late ? overdue++ : soon++;
  }
  const tasks = await ctx.db.all<{ id: number; title: string; due_date: string; is_demo: number }>(
    `SELECT id, title, due_date, is_demo FROM tasks WHERE status IN ('todo','in_progress') AND due_date < :today`,
    { today },
  );
  let tasksOverdue = 0;
  for (const t of tasks) {
    if (
      await notify(ctx, {
        kind: 'task_overdue',
        audience: 'staff',
        severity: 'warning',
        title: `Task overdue: ${t.title}`,
        body: `Was due ${formatDate(t.due_date, today)}`,
        link: '/tasks?view=overdue',
        entity_type: 'task',
        entity_id: t.id,
        dedupe_key: `task_overdue:${t.id}:${t.due_date}`,
        is_demo: t.is_demo,
      })
    )
      tasksOverdue++;
  }
  return { due_soon: soon, deliverables_overdue: overdue, tasks_overdue: tasksOverdue };
}

async function runOverdueInvoices(ctx: AppContext, cfg: Record<string, unknown>) {
  const today = await ctx.today();
  const grace = Math.max(0, Number(cfg.grace_days) || 0);
  const every = Math.max(1, Number(cfg.repeat_every_days) || 7);
  const rows = await ctx.db.all<{ id: number; number: string; due_date: string; balance_minor: number; currency: string; client_name: string; client_id: number; is_demo: number }>(
    `SELECT b.id, b.number, b.due_date, b.balance_minor, b.currency, COALESCE(c.company, c.name) AS client_name, b.client_id, b.is_demo
       FROM invoice_balances b JOIN clients c ON c.id = b.client_id
      WHERE ${invoiceStatusSql('b')} = 'overdue'`,
    { today },
  );
  let flagged = 0;
  let drafted = 0;
  for (const inv of rows) {
    const late = diffDays(inv.due_date, today);
    if (late < grace) continue;
    const bucket = Math.floor(late / every);
    if (
      await notify(ctx, {
        kind: 'invoice_overdue',
        audience: 'admin',
        severity: 'critical',
        title: `Invoice ${inv.number} is ${late} day${late === 1 ? '' : 's'} overdue`,
        body: `${inv.client_name} · ${formatMoney(inv.balance_minor, inv.currency, { decimals: 'always' })} outstanding`,
        link: `/invoices/${inv.id}`,
        entity_type: 'invoice',
        entity_id: inv.id,
        dedupe_key: `invoice_overdue:${inv.id}:${bucket}`,
        is_demo: inv.is_demo,
      })
    )
      flagged++;
    if (cfg.draft_client_emails !== false) {
      const already = await ctx.db.get(`SELECT 1 FROM outbox WHERE entity_type = 'invoice' AND entity_id = :id AND status = 'pending_approval'`, { id: inv.id });
      if (!already && await draftInvoiceEmail(ctx, inv.id, 'reminder', 'automation', `invoice_reminder:${inv.id}:${bucket}`)) drafted++;
    }
  }
  return { overdue_flagged: flagged, reminders_drafted: drafted };
}

async function runRenewals(ctx: AppContext, cfg: Record<string, unknown>) {
  const today = await ctx.today();
  const days = Math.max(1, Math.min(90, Number(cfg.days_before) || 14));
  const rows = await ctx.db.all<{ id: number; name: string; company: string | null; renewal_date: string; is_demo: number }>(
    `SELECT id, name, company, renewal_date, is_demo FROM clients
      WHERE archived_at IS NULL AND status IN ('active','onboarding','paused') AND renewal_date BETWEEN :today AND :until`,
    { today, until: addDays(today, days) },
  );
  let notified = 0;
  let tasks = 0;
  for (const c of rows) {
    const label = c.company || c.name;
    if (
      await notify(ctx, {
        kind: 'renewal_soon',
        audience: 'admin',
        severity: 'info',
        title: `${label} renews ${formatDate(c.renewal_date, today)}`,
        body: `Contract renewal in ${diffDays(today, c.renewal_date)} days — confirm scope and pricing.`,
        link: `/clients/${c.id}`,
        entity_type: 'client',
        entity_id: c.id,
        dedupe_key: `renewal:${c.id}:${c.renewal_date}`,
        is_demo: c.is_demo,
      })
    ) {
      notified++;
      if (cfg.create_task !== false) {
        const key = `renewal:${c.id}:${c.renewal_date}`;
        if (!await ctx.db.get('SELECT 1 FROM tasks WHERE recurrence_key = :key', { key })) {
          await ctx.db.insert('tasks', {
            title: `Renewal check-in with ${label}`,
            description: `Contract renews on ${formatDateLong(c.renewal_date)}. Review results, scope and pricing before then.`,
            client_id: c.id,
            priority: 'high',
            due_date: addDays(c.renewal_date, -3) < today ? today : addDays(c.renewal_date, -3),
            status: 'todo',
            recurrence_key: key,
            source: 'automation',
            is_demo: c.is_demo,
            created_at: ctx.nowIso(),
            updated_at: ctx.nowIso(),
          });
          tasks++;
        }
      }
    }
  }
  return { renewals_notified: notified, tasks_created: tasks };
}

async function runFollowUps(ctx: AppContext) {
  const today = await ctx.today();
  const rows = await ctx.db.all<{ id: number; name: string; company: string | null; next_follow_up: string; stage: string; is_demo: number }>(
    `SELECT id, name, company, next_follow_up, stage, is_demo FROM leads WHERE stage NOT IN ('won','lost') AND next_follow_up <= :today`,
    { today },
  );
  let n = 0;
  for (const l of rows) {
    const late = l.next_follow_up < today;
    if (
      await notify(ctx, {
        kind: 'follow_up_due',
        audience: 'admin',
        severity: late ? 'warning' : 'info',
        title: `Follow up with ${l.company ? `${l.name} (${l.company})` : l.name}`,
        body: late ? `Follow-up was due ${formatDate(l.next_follow_up, today)}` : 'Follow-up is due today',
        link: `/pipeline?lead=${l.id}`,
        entity_type: 'lead',
        entity_id: l.id,
        dedupe_key: `follow_up:${l.id}:${l.next_follow_up}`,
        is_demo: l.is_demo,
      })
    )
      n++;
  }
  return { follow_ups_notified: n };
}

async function runMonthly(ctx: AppContext, cfg: Record<string, unknown>): Promise<Record<string, number>> {
  const today = await ctx.today();
  const lastMonthStart = startOfMonth(addMonths(startOfMonth(today), -1));
  const lastMonthEnd = endOfMonth(lastMonthStart);
  const snap = await saveSnapshot(ctx, 'monthly', lastMonthStart, lastMonthEnd);
  if (!snap.created || !snap.data) return { snapshots: 0 };
  const label = monthLabel(lastMonthStart.slice(0, 7), 'long');
  await notify(ctx, {
    kind: 'report_ready',
    audience: 'admin',
    severity: 'success',
    title: `${label} revenue summary is ready`,
    body: `Collected ${moneyLine(snap.data.collected)} · expenses ${moneyLine(snap.data.expenses)}`,
    link: `/reports?snapshot=${snap.id}`,
    entity_type: 'report',
    entity_id: snap.id,
    dedupe_key: `report:monthly:${lastMonthStart}`,
    is_demo: await demoPresent(ctx) ? 1 : 0,
  });
  let drafted = 0;
  if (cfg.email_owner && await draftOwnerEmail(ctx, 'monthly_revenue_summary', `${(await ctx.settings()).business_name} · ${label} revenue summary`, snapshotText(`${label} revenue summary`, snap.data), `owner_report:monthly:${lastMonthStart}`)) drafted++;
  return { snapshots: 1, emails_drafted: drafted };
}

async function runWeekly(ctx: AppContext, cfg: Record<string, unknown>): Promise<Record<string, number>> {
  const today = await ctx.today();
  const thisWeek = startOfWeek(today);
  const from = addDays(thisWeek, -7);
  const to = addDays(thisWeek, -1);
  const snap = await saveSnapshot(ctx, 'weekly', from, to);
  if (!snap.created || !snap.data) return { snapshots: 0 };
  const label = `Week of ${formatDate(from)} – ${formatDate(to)}`;
  await notify(ctx, {
    kind: 'report_ready',
    audience: 'admin',
    severity: 'success',
    title: `Weekly report ready: ${label}`,
    body: `Collected ${moneyLine(snap.data.collected)} · ${snap.data.operations.deliverables_delivered} deliverables delivered`,
    link: `/reports?snapshot=${snap.id}`,
    entity_type: 'report',
    entity_id: snap.id,
    dedupe_key: `report:weekly:${from}`,
    is_demo: await demoPresent(ctx) ? 1 : 0,
  });
  let drafted = 0;
  if (cfg.email_owner && await draftOwnerEmail(ctx, 'weekly_report', `${(await ctx.settings()).business_name} · weekly report (${label})`, snapshotText(`Weekly report — ${label}`, snap.data), `owner_report:weekly:${from}`)) drafted++;
  return { snapshots: 1, emails_drafted: drafted };
}

let running = false;

export async function runAutomations(ctx: AppContext, trigger: 'startup' | 'schedule' | 'manual', only?: AutomationKey[]): Promise<{ run_id: number; summary: RunSummary; status: 'ok' | 'error' }> {
  if (running) throw conflict('Automations are already running. Try again in a moment.');
  running = true;
  const started = ctx.nowIso();
  const runId = await ctx.db.insert('automation_runs', { trigger, started_at: started, status: 'running', summary: {} });
  const summary: RunSummary = {};
  let status: 'ok' | 'error' = 'ok';
  let firstError: string | null = null;
  try {
    // Only run when the agency exists (setup done), so an empty install stays quiet.
    if (!await ctx.db.get('SELECT 1 FROM users LIMIT 1')) {
      summary.skipped = 'Setup not completed yet.';
    } else {
      for (const key of AUTOMATION_KEYS) {
        if (only && !only.includes(key)) continue;
        const { enabled, config } = await automationConfig(ctx, key);
        if (!enabled) {
          summary[key] = 'disabled';
          continue;
        }
        try {
          let result: Record<string, number>;
          switch (key) {
            case 'deadline_reminders':
              result = await runDeadlineReminders(ctx, config);
              break;
            case 'overdue_invoice_reminders':
              result = await runOverdueInvoices(ctx, config);
              break;
            case 'renewal_reminders':
              result = await runRenewals(ctx, config);
              break;
            case 'follow_up_reminders':
              result = await runFollowUps(ctx);
              break;
            case 'recurring_work':
              result = await materializeRecurring(ctx, SYSTEM_ACTOR);
              break;
            case 'monthly_revenue_summary':
              result = await runMonthly(ctx, config);
              break;
            case 'weekly_report':
              result = await runWeekly(ctx, config);
              break;
          }
          summary[key] = result;
          await ctx.db.run(
            `INSERT INTO automation_settings (key, enabled, config, last_run_at, last_result) VALUES (:key, 1, '{}', :at, :result)
             ON CONFLICT(key) DO UPDATE SET last_run_at = excluded.last_run_at, last_result = excluded.last_result`,
            { key, at: ctx.nowIso(), result: JSON.stringify(result) },
          );
        } catch (err) {
          status = 'error';
          const msg = err instanceof Error ? err.message : String(err);
          firstError ??= `${key}: ${msg}`;
          summary[key] = `error: ${msg}`;
          console.error(`[automation] ${key} failed`, err);
        }
      }
    }
  } finally {
    await ctx.db.run('UPDATE automation_runs SET finished_at = :at, status = :status, summary = :summary, error = :error WHERE id = :id', {
      at: ctx.nowIso(),
      status,
      summary: JSON.stringify(summary),
      error: firstError,
      id: runId,
    });
    running = false;
  }
  return { run_id: runId, summary, status };
}

/** Runs automations shortly after start-up and then every 15 minutes while the app is running. */
export function startScheduler(ctx: AppContext, everyMs = 15 * 60_000): () => void {
  const tick = async (trigger: 'startup' | 'schedule') => {
    try {
      await runAutomations(ctx, trigger);
    } catch (err) {
      if (!(err instanceof Error && err.message.includes('already running'))) console.error('[automation] run failed', err);
    }
  };
  const first = setTimeout(async () => await tick('startup'), 3000);
  const timer = setInterval(async () => await tick('schedule'), everyMs);
  first.unref?.();
  timer.unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}

// ── Outbox actions (all require a person) ───────────────────────────────────

type OutboxRow = { id: number; status: string; to_address: string; to_name: string | null; subject: string; body: string; entity_type: string | null; entity_id: number | null; client_id: number | null; is_demo: number };

export async function approveAndSend(ctx: AppContext, actor: Actor, id: number): Promise<{ status: string; error?: string }> {
  const row = await ctx.db.get<OutboxRow>('SELECT * FROM outbox WHERE id = :id', { id });
  if (!row) throw notFound('Message');
  if (row.status !== 'pending_approval' && row.status !== 'failed') throw conflict('This message was already handled.');
  if (!ctx.mailer.configured) throw conflict('Email is not set up (no SMTP settings). Copy the message into your own email, then use “Mark as sent manually”.');
  const now = ctx.nowIso();
  await ctx.db.run(`UPDATE outbox SET approved_by = :uid, approved_at = :now, updated_at = :now WHERE id = :id`, { uid: actor.id, now, id });
  try {
    await ctx.mailer.send({ to: row.to_address, toName: row.to_name, subject: row.subject, text: row.body });
    await ctx.db.run(`UPDATE outbox SET status = 'sent', sent_at = :now, error = NULL, updated_at = :now WHERE id = :id`, { now: ctx.nowIso(), id });
    await logActivity(ctx, actor, { entity_type: row.entity_type ?? 'outbox', entity_id: row.entity_id ?? id, client_id: row.client_id, action: 'email_sent', summary: `Email sent to ${row.to_address}: ${row.subject}`, is_demo: row.is_demo });
    if (row.entity_type === 'invoice' && row.entity_id && row.subject.startsWith('Invoice ')) {
      const inv = await ctx.db.get<{ state: string }>('SELECT state FROM invoices WHERE id = :id', { id: row.entity_id });
      if (inv?.state === 'draft') await ctx.db.run(`UPDATE invoices SET state = 'sent', sent_at = :now, updated_at = :now WHERE id = :id`, { now: ctx.nowIso(), id: row.entity_id });
    }
    return { status: 'sent' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await ctx.db.run(`UPDATE outbox SET status = 'failed', error = :err, updated_at = :now WHERE id = :id`, { err: msg.slice(0, 1000), now: ctx.nowIso(), id });
    return { status: 'failed', error: msg };
  }
}

export async function markSentManually(ctx: AppContext, actor: Actor, id: number): Promise<void> {
  const row = await ctx.db.get<OutboxRow>('SELECT * FROM outbox WHERE id = :id', { id });
  if (!row) throw notFound('Message');
  if (row.status === 'sent' || row.status === 'sent_manually') return;
  const now = ctx.nowIso();
  await ctx.db.run(`UPDATE outbox SET status = 'sent_manually', approved_by = :uid, approved_at = :now, sent_at = :now, updated_at = :now WHERE id = :id`, { uid: actor.id, now, id });
  await logActivity(ctx, actor, { entity_type: row.entity_type ?? 'outbox', entity_id: row.entity_id ?? id, client_id: row.client_id, action: 'email_sent_manually', summary: `Marked as sent manually to ${row.to_address}: ${row.subject}`, is_demo: row.is_demo });
}
