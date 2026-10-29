import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../context.ts';
import { badRequest, idParam, notFound, parse } from '../lib/http.ts';
import { actorOf, logActivity } from '../lib/activity.ts';
import { toCsv } from '../lib/csv.ts';
import { foreignKey, optionalDate, optionalText, qInt, qStr, requiredDate, requiredText } from '../lib/validation.ts';
import { likeParam, sendCsv } from './common.ts';
import { firstOccurrence, materializeRecurring, upcomingOccurrences } from '../services/recurrence.ts';
import { FREQUENCIES, PLATFORMS, PRIORITIES, PROJECT_TYPES, RECURRING_KINDS, TASK_STATUSES, TASK_STATUS_LABELS, BILLING_TYPES } from '../../shared/constants.ts';
import { addDays } from '../../shared/dates.ts';
import { json } from '../db/db.ts';
import { isValidCurrency } from '../../shared/money.ts';

const taskFields = {
  title: requiredText(200),
  description: optionalText(10000),
  client_id: foreignKey(),
  project_id: foreignKey(),
  lead_id: foreignKey(),
  priority: z.enum(PRIORITIES),
  assignee_id: foreignKey(),
  due_date: optionalDate(),
  status: z.enum(TASK_STATUSES),
};
const taskCreate = z.object({ ...taskFields, priority: taskFields.priority.optional(), status: taskFields.status.optional() });
const taskUpdate = z.object(taskFields).partial();

const listQuery = z.object({
  view: z.enum(['today', 'upcoming', 'overdue', 'open', 'done', 'all']).optional().catch('open'),
  assignee_id: qInt(),
  client_id: qInt(),
  project_id: qInt(),
  q: qStr(),
});

async function checkRefs(ctx: AppContext, b: { client_id?: number | null; project_id?: number | null; lead_id?: number | null; assignee_id?: number | null }) {
  const check = async (table: string, id: number | null | undefined, label: string) => {
    if (id && !await ctx.db.get(`SELECT 1 FROM ${table} WHERE id = :id`, { id })) throw badRequest(`That ${label} does not exist.`);
  };
  await check('clients', b.client_id, 'client');
  await check('projects', b.project_id, 'project');
  await check('leads', b.lead_id, 'lead');
  await check('team_members', b.assignee_id, 'team member');
}

export async function listTasks(ctx: AppContext, q: Partial<z.output<typeof listQuery>>) {
  const today = await ctx.today();
  const where: string[] = ['1 = 1'];
  const params: Record<string, unknown> = { today, week: addDays(today, 7) };
  const open = `t.status IN ('todo','in_progress')`;
  switch (q.view) {
    case 'today':
      where.push(open, 't.due_date <= :today');
      break;
    case 'upcoming':
      where.push(open, 't.due_date > :today');
      break;
    case 'overdue':
      where.push(open, 't.due_date < :today');
      break;
    case 'done':
      where.push(`t.status IN ('done','cancelled')`);
      break;
    case 'all':
      break;
    default:
      where.push(open);
  }
  for (const key of ['assignee_id', 'client_id', 'project_id'] as const) {
    if (q[key]) {
      where.push(`t.${key} = :${key}`);
      params[key] = q[key];
    }
  }
  if (q.q) {
    where.push('(t.title LIKE :q OR t.description LIKE :q)');
    params.q = likeParam(q.q);
  }
  return ctx.db.all<Record<string, unknown>>(
    `SELECT t.*, COALESCE(c.company, c.name) AS client_name, p.name AS project_name, l.name AS lead_name,
            m.name AS assignee_name, m.color AS assignee_color, r.frequency AS recurrence_frequency,
            (t.due_date IS NOT NULL AND t.due_date < :today AND t.status IN ('todo','in_progress')) AS is_overdue
       FROM tasks t
       LEFT JOIN clients c ON c.id = t.client_id
       LEFT JOIN projects p ON p.id = t.project_id
       LEFT JOIN leads l ON l.id = t.lead_id
       LEFT JOIN team_members m ON m.id = t.assignee_id
       LEFT JOIN recurring_rules r ON r.id = t.recurring_rule_id
      WHERE ${where.join(' AND ')}
      ORDER BY t.status IN ('done','cancelled'), COALESCE(t.due_date, '9999-12-31'),
               CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, t.id
      LIMIT 1000`,
    params,
  );
}

export function tasksRouter(ctx: AppContext): Router {
  const r = Router();

  r.get('/', async (req, res) => {
    const q = parse(listQuery, req.query);
    const today = await ctx.today();
    const counts = await ctx.db.get(
      `SELECT COUNT(*) FILTER (WHERE status IN ('todo','in_progress') AND due_date <= :today) AS today,
              COUNT(*) FILTER (WHERE status IN ('todo','in_progress') AND due_date < :today) AS overdue,
              COUNT(*) FILTER (WHERE status IN ('todo','in_progress') AND due_date > :today) AS upcoming,
              COUNT(*) FILTER (WHERE status IN ('todo','in_progress')) AS open,
              COUNT(*) FILTER (WHERE status IN ('done','cancelled')) AS done
         FROM tasks`,
      { today },
    );
    res.json({ tasks: await listTasks(ctx, q), counts });
  });

  r.get('/export.csv', async (_req, res) => {
    const rows = await listTasks(ctx, { view: 'all' });
    const csv = toCsv(rows, [
      { header: 'Title', value: (t) => t.title },
      { header: 'Status', value: (t) => TASK_STATUS_LABELS[t.status as keyof typeof TASK_STATUS_LABELS] },
      { header: 'Priority', value: (t) => t.priority },
      { header: 'Due', value: (t) => t.due_date },
      { header: 'Assignee', value: (t) => t.assignee_name },
      { header: 'Client', value: (t) => t.client_name },
      { header: 'Project', value: (t) => t.project_name },
      { header: 'Recurring', value: (t) => t.recurrence_frequency ?? '' },
      { header: 'Completed', value: (t) => t.completed_at },
      { header: 'Description', value: (t) => t.description },
    ]);
    await sendCsv(ctx, res, 'tasks', csv);
  });

  r.post('/', async (req, res) => {
    const body = parse(taskCreate, req.body);
    await checkRefs(ctx, body);
    const now = ctx.nowIso();
    const status = body.status ?? 'todo';
    const id = await ctx.db.insert('tasks', {
      ...body,
      priority: body.priority ?? 'medium',
      status,
      completed_at: status === 'done' ? now : null,
      source: 'manual',
      created_at: now,
      updated_at: now,
    });
    res.status(201).json({ id });
  });

  r.patch('/:id', async (req, res) => {
    const id = idParam(req);
    const existing = await ctx.db.get<{ status: string; title: string; client_id: number | null; project_id: number | null; is_demo: number }>(
      'SELECT status, title, client_id, project_id, is_demo FROM tasks WHERE id = :id',
      { id },
    );
    if (!existing) throw notFound('Task');
    const body = parse(taskUpdate, req.body);
    await checkRefs(ctx, body);
    const now = ctx.nowIso();
    const patch: Record<string, unknown> = { ...body, updated_at: now };
    if (body.status && body.status !== existing.status) patch.completed_at = body.status === 'done' ? now : null;
    await ctx.db.tx(async () => {
      await ctx.db.update('tasks', id, patch);
      if (body.status === 'done' && existing.status !== 'done') {
        await logActivity(ctx, actorOf(req), {
          entity_type: 'task',
          entity_id: id,
          client_id: body.client_id ?? existing.client_id,
          project_id: body.project_id ?? existing.project_id,
          action: 'completed',
          summary: `Task done: ${body.title ?? existing.title}`,
          is_demo: existing.is_demo,
        });
      }
    });
    res.json({ ok: true });
  });

  r.delete('/:id', async (req, res) => {
    const changes = (await ctx.db.run('DELETE FROM tasks WHERE id = :id', { id: idParam(req) })).changes;
    if (!changes) throw notFound('Task');
    res.json({ ok: true });
  });

  return r;
}

// ── Recurring rules ─────────────────────────────────────────────────────────

const taskTemplate = z.object({
  description: optionalText(5000),
  client_id: foreignKey(),
  project_id: foreignKey(),
  assignee_id: foreignKey(),
  priority: z.enum(PRIORITIES).nullish(),
});
const projectTemplate = z.object({
  client_id: z.number({ error: 'Pick the client this project repeats for.' }).int().positive(),
  type: z.enum(PROJECT_TYPES),
  description: optionalText(5000),
  billing_type: z.enum(BILLING_TYPES).nullish(),
  price_minor: z.number().int().min(0).nullish(),
  currency: z
    .string()
    .nullish()
    .refine((v) => !v || isValidCurrency(v), 'Unknown currency.'),
  editor_id: foreignKey(),
  priority: z.enum(PRIORITIES).nullish(),
  deadline_offset_days: z.number().int().min(0).max(365).nullish(),
  deliverables: z
    .array(
      z.object({
        title: requiredText(200),
        format: optionalText(80),
        platform: z.enum(PLATFORMS).nullish(),
        deadline_offset_days: z.number().int().min(0).max(365).nullish(),
      }),
    )
    .max(60)
    .optional(),
});

const ruleFields = {
  kind: z.enum(RECURRING_KINDS),
  title: requiredText(200),
  frequency: z.enum(FREQUENCIES),
  interval: z.number().int().min(1).max(52),
  weekday: z.number().int().min(0).max(6).nullish().transform((v) => v ?? null),
  month_day: z.number().int().min(1).max(31).nullish().transform((v) => v ?? null),
  start_date: requiredDate(),
  end_date: optionalDate(),
  lead_days: z.number().int().min(0).max(60),
  active: z.boolean(),
  template: z.record(z.string(), z.unknown()),
};
const ruleCreate = z.object({ ...ruleFields, interval: ruleFields.interval.optional(), lead_days: ruleFields.lead_days.optional(), active: ruleFields.active.optional() });
const ruleUpdate = z.object(ruleFields).partial();

function validateTemplate(kind: string, template: unknown) {
  return kind === 'project' ? parse(projectTemplate, template) : parse(taskTemplate, template);
}

export function recurringRouter(ctx: AppContext): Router {
  const r = Router();

  r.get('/', async (_req, res) => {
    const today = await ctx.today();
    const rules = await ctx.db.all<Record<string, unknown> & { id: number; template: string }>('SELECT * FROM recurring_rules ORDER BY active DESC, next_occurrence, id');
    res.json({
      rules: await Promise.all(rules.map(async (rule) => ({
        ...rule,
        template: json(rule.template, {}),
        upcoming: upcomingOccurrences(rule as never, rule.next_occurrence as string > today ? (rule.next_occurrence as string) : today, 3),
        generated: (await ctx.db.value<number>(`SELECT (SELECT COUNT(*) FROM tasks WHERE recurring_rule_id = :id) + (SELECT COUNT(*) FROM projects WHERE recurring_rule_id = :id)`, { id: rule.id })) ?? 0,
      }))),
    });
  });

  r.post('/', async (req, res) => {
    const body = parse(ruleCreate, req.body);
    const template = validateTemplate(body.kind, body.template);
    if (body.end_date && body.end_date < body.start_date) throw badRequest('The end date is before the start date.');
    const shape = { frequency: body.frequency, interval: body.interval ?? 1, weekday: body.weekday, month_day: body.month_day, start_date: body.start_date };
    const now = ctx.nowIso();
    const id = await ctx.db.insert('recurring_rules', {
      ...body,
      ...shape,
      template,
      lead_days: body.lead_days ?? 0,
      active: body.active === false ? 0 : 1,
      next_occurrence: firstOccurrence(shape),
      created_at: now,
      updated_at: now,
    });
    await logActivity(ctx, actorOf(req), { entity_type: 'recurring_rule', entity_id: id, action: 'created', summary: `Recurring ${body.kind} “${body.title}” set up (${body.frequency})` });
    const generated = await materializeRecurring(ctx, actorOf(req), id);
    res.status(201).json({ id, generated });
  });

  r.patch('/:id', async (req, res) => {
    const id = idParam(req);
    const existing = await ctx.db.get<Record<string, unknown> & { kind: string; frequency: string; interval: number; weekday: number | null; month_day: number | null; start_date: string; next_occurrence: string }>(
      'SELECT * FROM recurring_rules WHERE id = :id',
      { id },
    );
    if (!existing) throw notFound('Recurring rule');
    const body = parse(ruleUpdate, req.body);
    const kind = body.kind ?? existing.kind;
    const patch: Record<string, unknown> = { ...body, updated_at: ctx.nowIso() };
    if (body.template) patch.template = validateTemplate(kind, body.template);
    if (body.active !== undefined) patch.active = body.active ? 1 : 0;
    const scheduleChanged = ['frequency', 'interval', 'weekday', 'month_day', 'start_date'].some((k) => k in body);
    if (scheduleChanged) {
      const shape = {
        frequency: (body.frequency ?? existing.frequency) as never,
        interval: body.interval ?? existing.interval,
        weekday: body.weekday !== undefined ? body.weekday : existing.weekday,
        month_day: body.month_day !== undefined ? body.month_day : existing.month_day,
        start_date: body.start_date ?? existing.start_date,
      };
      // Re-anchor from today so a schedule edit never back-fills old dates.
      const upcoming = upcomingOccurrences(shape, await ctx.today(), 1);
      patch.next_occurrence = upcoming[0] ?? firstOccurrence(shape);
    }
    await ctx.db.update('recurring_rules', id, patch);
    res.json({ ok: true });
  });

  r.post('/:id/run', async (req, res) => {
    const id = idParam(req);
    if (!await ctx.db.get('SELECT 1 FROM recurring_rules WHERE id = :id', { id })) throw notFound('Recurring rule');
    res.json({ generated: await materializeRecurring(ctx, actorOf(req), id) });
  });

  r.delete('/:id', async (req, res) => {
    const id = idParam(req);
    const changes = (await ctx.db.run('DELETE FROM recurring_rules WHERE id = :id', { id })).changes;
    if (!changes) throw notFound('Recurring rule');
    res.json({ ok: true });
  });

  return r;
}
