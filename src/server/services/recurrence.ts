import type { AppContext } from '../context.ts';
import { logActivity, SYSTEM_ACTOR, type Actor } from '../lib/activity.ts';
import { json } from '../db/db.ts';
import { addDays, addMonths, daysInMonth, formatDate, isValidDate, monthName, weekday, type ISODate } from '../../shared/dates.ts';
import type { Frequency } from '../../shared/constants.ts';

export type RecurringRule = {
  id: number;
  kind: 'task' | 'project';
  title: string;
  frequency: Frequency;
  interval: number;
  weekday: number | null;
  month_day: number | null;
  start_date: string;
  end_date: string | null;
  next_occurrence: string;
  lead_days: number;
  template: string;
  active: number;
  is_demo: number;
};

export type TaskTemplate = {
  description?: string | null;
  client_id?: number | null;
  project_id?: number | null;
  assignee_id?: number | null;
  priority?: string | null;
};

export type ProjectTemplate = {
  client_id: number;
  type: string;
  description?: string | null;
  billing_type?: string | null;
  price_minor?: number | null;
  currency?: string | null;
  editor_id?: number | null;
  priority?: string | null;
  deadline_offset_days?: number | null;
  deliverables?: { title: string; format?: string | null; platform?: string | null; deadline_offset_days?: number | null }[];
};

type RuleShape = Pick<RecurringRule, 'frequency' | 'interval' | 'weekday' | 'month_day' | 'start_date'>;

function monthsPerStep(r: RuleShape): number {
  return r.frequency === 'monthly' ? r.interval : r.frequency === 'quarterly' ? 3 * r.interval : r.frequency === 'yearly' ? 12 * r.interval : 0;
}

/** First occurrence on or after the rule's start date. */
export function firstOccurrence(r: RuleShape): ISODate {
  if (r.frequency === 'daily') return r.start_date;
  if (r.frequency === 'weekly') {
    const target = r.weekday ?? weekday(r.start_date);
    const delta = (target - weekday(r.start_date) + 7) % 7;
    return addDays(r.start_date, delta);
  }
  const day = r.month_day ?? Number(r.start_date.slice(8, 10));
  const [y, m] = r.start_date.split('-').map(Number);
  const candidate = `${r.start_date.slice(0, 8)}${String(Math.min(day, daysInMonth(y, m))).padStart(2, '0')}`;
  return candidate >= r.start_date ? candidate : addMonths(candidate, monthsPerStep(r), day);
}

export function occurrenceAfter(r: RuleShape, prev: ISODate): ISODate {
  if (r.frequency === 'daily') return addDays(prev, r.interval);
  if (r.frequency === 'weekly') return addDays(prev, 7 * r.interval);
  return addMonths(prev, monthsPerStep(r), r.month_day ?? Number(r.start_date.slice(8, 10)));
}

/** The next few occurrences, for the UI preview. */
export function upcomingOccurrences(r: RuleShape & { end_date?: string | null }, from: ISODate, count = 4): ISODate[] {
  const out: ISODate[] = [];
  let occ = firstOccurrence(r);
  let guard = 0;
  while (occ < from && guard++ < 5000) occ = occurrenceAfter(r, occ);
  while (out.length < count && guard++ < 5000) {
    if (r.end_date && occ > r.end_date) break;
    out.push(occ);
    occ = occurrenceAfter(r, occ);
  }
  return out;
}

/** Fill {{month}}, {{month_short}}, {{year}}, {{date}}, {{quarter}} placeholders for an occurrence. */
export function renderTitle(template: string, occ: ISODate): string {
  const key = occ.slice(0, 7);
  const q = Math.floor((Number(occ.slice(5, 7)) - 1) / 3) + 1;
  return template
    .replace(/\{\{\s*month\s*\}\}/g, `${monthName(key)} ${occ.slice(0, 4)}`)
    .replace(/\{\{\s*month_short\s*\}\}/g, monthName(key).slice(0, 3))
    .replace(/\{\{\s*year\s*\}\}/g, occ.slice(0, 4))
    .replace(/\{\{\s*quarter\s*\}\}/g, `Q${q} ${occ.slice(0, 4)}`)
    .replace(/\{\{\s*date\s*\}\}/g, formatDate(occ));
}

function createTaskFor(ctx: AppContext, rule: RecurringRule, occ: ISODate): boolean {
  const t = json<TaskTemplate>(rule.template, {});
  const key = `rule:${rule.id}:${occ}`;
  if (ctx.db.get('SELECT 1 FROM tasks WHERE recurrence_key = :key', { key })) return false;
  const exists = (table: string, id: number | null | undefined) => (id ? !!ctx.db.get(`SELECT 1 FROM ${table} WHERE id = :id`, { id }) : false);
  const now = ctx.nowIso();
  ctx.db.insert('tasks', {
    title: renderTitle(rule.title, occ),
    description: t.description ?? null,
    client_id: exists('clients', t.client_id) ? t.client_id : null,
    project_id: exists('projects', t.project_id) ? t.project_id : null,
    assignee_id: exists('team_members', t.assignee_id) ? t.assignee_id : null,
    priority: ['low', 'medium', 'high', 'urgent'].includes(t.priority ?? '') ? t.priority : 'medium',
    due_date: occ,
    status: 'todo',
    recurring_rule_id: rule.id,
    recurrence_key: key,
    source: 'recurring',
    is_demo: rule.is_demo,
    created_at: now,
    updated_at: now,
  });
  return true;
}

function createProjectFor(ctx: AppContext, rule: RecurringRule, occ: ISODate, actor: Actor): boolean | 'skipped' {
  const t = json<ProjectTemplate | null>(rule.template, null);
  if (!t?.client_id) return 'skipped';
  const client = ctx.db.get<{ id: number; currency: string; archived_at: string | null; status: string }>('SELECT id, currency, archived_at, status FROM clients WHERE id = :id', { id: t.client_id });
  if (!client || client.archived_at || client.status === 'churned') return 'skipped';
  const key = `rule:${rule.id}:${occ}`;
  if (ctx.db.get('SELECT 1 FROM projects WHERE recurrence_key = :key', { key })) return false;
  const now = ctx.nowIso();
  const editor = t.editor_id && ctx.db.get('SELECT 1 FROM team_members WHERE id = :id', { id: t.editor_id }) ? t.editor_id : null;
  const name = renderTitle(rule.title, occ);
  const projectId = ctx.db.insert('projects', {
    client_id: client.id,
    name,
    description: t.description ?? null,
    type: t.type || 'other',
    billing_type: t.billing_type || 'retainer',
    price_minor: t.price_minor ?? null,
    currency: t.currency || client.currency,
    start_date: occ,
    deadline: t.deadline_offset_days != null ? addDays(occ, t.deadline_offset_days) : null,
    priority: t.priority || 'medium',
    status: 'backlog',
    editor_id: editor,
    recurring_rule_id: rule.id,
    recurrence_key: key,
    is_demo: rule.is_demo,
    created_at: now,
    updated_at: now,
  });
  (t.deliverables ?? []).forEach((d, i) => {
    ctx.db.insert('deliverables', {
      project_id: projectId,
      title: renderTitle(d.title, occ),
      format: d.format ?? null,
      platform: d.platform ?? null,
      deadline: d.deadline_offset_days != null ? addDays(occ, d.deadline_offset_days) : null,
      status: 'backlog',
      sort_order: i,
      is_demo: rule.is_demo,
      created_at: now,
      updated_at: now,
    });
  });
  logActivity(ctx, actor, {
    entity_type: 'project',
    entity_id: projectId,
    client_id: client.id,
    project_id: projectId,
    action: 'created',
    summary: `Recurring project “${name}” created${t.deliverables?.length ? ` with ${t.deliverables.length} deliverables` : ''}`,
    is_demo: rule.is_demo,
  });
  return true;
}

/**
 * Create the tasks/projects that recurring rules owe as of today (+ each rule's lead days).
 * Idempotent: a unique key per rule and date prevents doubles. If the app was closed for a long time,
 * only the latest missed occurrence is created, not a flood of stale ones.
 */
export function materializeRecurring(ctx: AppContext, actor: Actor = SYSTEM_ACTOR, onlyRuleId?: number): { tasks: number; projects: number; skipped: number } {
  const today = ctx.today();
  const rules = ctx.db.all<RecurringRule>(`SELECT * FROM recurring_rules WHERE active = 1 ${onlyRuleId ? 'AND id = :id' : ''}`, { id: onlyRuleId });
  const result = { tasks: 0, projects: 0, skipped: 0 };
  for (const rule of rules) {
    if (!isValidDate(rule.next_occurrence)) continue;
    ctx.db.tx(() => {
      let occ = rule.next_occurrence;
      let guard = 0;
      const horizon = addDays(today, rule.lead_days);
      while (occ <= horizon && (!rule.end_date || occ <= rule.end_date) && guard++ < 1000) {
        const next = occurrenceAfter(rule, occ);
        const stale = next <= today;
        if (!stale) {
          if (rule.kind === 'task') {
            if (createTaskFor(ctx, rule, occ)) result.tasks++;
          } else {
            const r = createProjectFor(ctx, rule, occ, actor);
            if (r === true) result.projects++;
            else if (r === 'skipped') result.skipped++;
          }
        }
        occ = next;
      }
      ctx.db.run('UPDATE recurring_rules SET next_occurrence = :occ, last_generated_at = :now, active = :active, updated_at = :now WHERE id = :id', {
        occ,
        now: ctx.nowIso(),
        active: rule.end_date && occ > rule.end_date ? 0 : 1,
        id: rule.id,
      });
    });
  }
  return result;
}
