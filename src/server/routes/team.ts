import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../context.ts';
import { requireAdmin } from '../lib/auth.ts';
import { conflict, idParam, notFound, parse } from '../lib/http.ts';
import { actorOf, logActivity } from '../lib/activity.ts';
import { optionalEmail, optionalMinorAmount, optionalText, requiredText } from '../lib/validation.ts';
import { canSeeFinance, stripFields, withJson } from './common.ts';
import { addDays } from '../../shared/dates.ts';
import { COST_UNITS } from '../../shared/constants.ts';
import { isValidCurrency as isValidCurrencyCode } from '../../shared/money.ts';

const teamFields = {
  name: requiredText(120),
  email: optionalEmail(),
  title: requiredText(80),
  skills: z
    .array(z.string().trim().min(1).max(40))
    .max(20)
    .nullish()
    .transform((v) => [...new Set(v ?? [])]),
  capacity_hours: z.number().min(0).max(168),
  cost_rate_minor: optionalMinorAmount(),
  cost_currency: z
    .string()
    .trim()
    .toUpperCase()
    .nullish()
    .transform((v) => (v ? v : null))
    .refine((v) => v === null || isValidCurrencyCode(v), 'Unknown currency code.'),
  cost_unit: z.enum(COST_UNITS).nullish().transform((v) => v ?? null),
  status: z.enum(['active', 'inactive']),
  color: z
    .string()
    .regex(/^#[0-9a-f]{6}$/i)
    .nullish()
    .transform((v) => v ?? null),
  notes: optionalText(5000),
};

const createSchema = z.object({ ...teamFields, title: teamFields.title.optional(), capacity_hours: teamFields.capacity_hours.optional(), status: teamFields.status.optional() });
const updateSchema = z.object(teamFields).partial();

const PALETTE = ['#9085e9', '#199e70', '#d95926', '#3987e5', '#c98500', '#d55181', '#e66767', '#7469b8'];

/** Workload per team member: open deliverables/tasks and hours booked in the next 7 days vs weekly capacity. */
export function teamWorkload(ctx: AppContext) {
  const today = ctx.today();
  const weekEnd = addDays(today, 6);
  const members = ctx.db.all<Record<string, unknown> & { id: number; capacity_hours: number }>('SELECT * FROM team_members ORDER BY status, name COLLATE NOCASE');
  const stats = ctx.db.all<{ assignee_id: number; open: number; overdue: number; due_week: number; in_review: number; hours_week: number; hours_open: number }>(
    `SELECT COALESCE(d.assignee_id, p.editor_id) AS assignee_id,
            COUNT(*) AS open,
            SUM(d.deadline IS NOT NULL AND d.deadline < :today) AS overdue,
            SUM(d.deadline BETWEEN :today AND :week_end) AS due_week,
            SUM(d.status IN ('internal_review','client_review')) AS in_review,
            SUM(CASE WHEN d.deadline <= :week_end THEN COALESCE(d.estimated_hours, 0) ELSE 0 END) AS hours_week,
            SUM(COALESCE(d.estimated_hours, 0)) AS hours_open
       FROM deliverables d JOIN projects p ON p.id = d.project_id
      WHERE d.status <> 'delivered' AND p.status NOT IN ('cancelled','on_hold') AND p.archived_at IS NULL
      GROUP BY COALESCE(d.assignee_id, p.editor_id)`,
    { today, week_end: weekEnd },
  );
  const tasks = ctx.db.all<{ assignee_id: number; open: number; overdue: number; due_today: number }>(
    `SELECT assignee_id, COUNT(*) AS open, SUM(due_date < :today) AS overdue, SUM(due_date = :today) AS due_today
       FROM tasks WHERE status IN ('todo','in_progress') AND assignee_id IS NOT NULL GROUP BY assignee_id`,
    { today },
  );
  const projects = ctx.db.all<{ editor_id: number; n: number }>(
    `SELECT editor_id, COUNT(*) AS n FROM projects
      WHERE editor_id IS NOT NULL AND archived_at IS NULL AND status IN ('backlog','editing','internal_review','client_review','revisions','approved')
      GROUP BY editor_id`,
  );
  return members.map((m) => {
    const s = stats.find((x) => x.assignee_id === m.id);
    const t = tasks.find((x) => x.assignee_id === m.id);
    const hoursWeek = s?.hours_week ?? 0;
    return {
      ...withJson(m, { skills: [] }),
      workload: {
        open_deliverables: s?.open ?? 0,
        overdue_deliverables: s?.overdue ?? 0,
        due_this_week: s?.due_week ?? 0,
        in_review: s?.in_review ?? 0,
        hours_booked_week: hoursWeek,
        hours_open: s?.hours_open ?? 0,
        utilization: m.capacity_hours > 0 ? hoursWeek / m.capacity_hours : null,
        open_tasks: t?.open ?? 0,
        overdue_tasks: t?.overdue ?? 0,
        tasks_due_today: t?.due_today ?? 0,
        active_projects: projects.find((x) => x.editor_id === m.id)?.n ?? 0,
      },
    };
  });
}

export function teamRouter(ctx: AppContext): Router {
  const r = Router();

  r.get('/', (req, res) => {
    const rows = teamWorkload(ctx);
    const unassigned = ctx.db.value<number>(
      `SELECT COUNT(*) FROM deliverables d JOIN projects p ON p.id = d.project_id
        WHERE d.status <> 'delivered' AND d.assignee_id IS NULL AND p.editor_id IS NULL AND p.status NOT IN ('cancelled','on_hold')`,
    );
    res.json({
      members: canSeeFinance(req) ? rows : rows.map((m) => stripFields(m, ['cost_rate_minor', 'cost_currency', 'cost_unit'])),
      unassigned_deliverables: unassigned ?? 0,
    });
  });

  r.get('/:id', (req, res) => {
    const id = idParam(req);
    const member = teamWorkload(ctx).find((m) => m.id === id);
    if (!member) throw notFound('Team member');
    const deliverables = ctx.db.all(
      `SELECT d.id, d.title, d.status, d.deadline, d.estimated_hours, d.revision_count, p.id AS project_id, p.name AS project_name,
              c.id AS client_id, COALESCE(c.company, c.name) AS client_name
         FROM deliverables d JOIN projects p ON p.id = d.project_id JOIN clients c ON c.id = p.client_id
        WHERE d.status <> 'delivered' AND COALESCE(d.assignee_id, p.editor_id) = :id AND p.status NOT IN ('cancelled')
        ORDER BY COALESCE(d.deadline, '9999'), d.id`,
      { id },
    );
    const tasks = ctx.db.all(
      `SELECT id, title, status, priority, due_date FROM tasks WHERE assignee_id = :id AND status IN ('todo','in_progress') ORDER BY COALESCE(due_date,'9999'), id`,
      { id },
    );
    res.json({ member: canSeeFinance(req) ? member : stripFields(member, ['cost_rate_minor', 'cost_currency', 'cost_unit']), deliverables, tasks });
  });

  r.post('/', requireAdmin, (req, res) => {
    const body = parse(createSchema, req.body);
    const now = ctx.nowIso();
    const count = ctx.db.value<number>('SELECT COUNT(*) FROM team_members') ?? 0;
    const id = ctx.db.insert('team_members', {
      ...body,
      title: body.title ?? 'Editor',
      capacity_hours: body.capacity_hours ?? 40,
      status: body.status ?? 'active',
      color: body.color ?? PALETTE[count % PALETTE.length],
      created_at: now,
      updated_at: now,
    });
    logActivity(ctx, actorOf(req), { entity_type: 'team_member', entity_id: id, action: 'created', summary: `${body.name} added to the team` });
    res.status(201).json({ id });
  });

  r.patch('/:id', requireAdmin, (req, res) => {
    const id = idParam(req);
    if (!ctx.db.get('SELECT 1 FROM team_members WHERE id = :id', { id })) throw notFound('Team member');
    const body = parse(updateSchema, req.body);
    ctx.db.update('team_members', id, { ...body, updated_at: ctx.nowIso() });
    res.json({ ok: true });
  });

  r.delete('/:id', requireAdmin, (req, res) => {
    const id = idParam(req);
    const m = ctx.db.get<{ name: string }>('SELECT name FROM team_members WHERE id = :id', { id });
    if (!m) throw notFound('Team member');
    const open = ctx.db.value<number>(
      `SELECT COUNT(*) FROM deliverables d JOIN projects p ON p.id = d.project_id WHERE d.status <> 'delivered' AND (d.assignee_id = :id OR p.editor_id = :id)`,
      { id },
    );
    if (open) throw conflict(`${m.name} still has ${open} open deliverable(s). Reassign them or mark the member inactive instead.`);
    ctx.db.tx(() => {
      ctx.db.run('DELETE FROM team_members WHERE id = :id', { id });
      logActivity(ctx, actorOf(req), { entity_type: 'team_member', entity_id: id, action: 'deleted', summary: `${m.name} removed from the team` });
    });
    res.json({ ok: true });
  });

  return r;
}
