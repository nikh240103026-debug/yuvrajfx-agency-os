import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../context.ts';
import { isAdmin } from '../lib/auth.ts';
import { badRequest, parse } from '../lib/http.ts';
import { qDate, qInt, qStr } from '../lib/validation.ts';
import { likeParam } from './common.ts';
import { buildDashboard } from '../services/dashboard.ts';
import { listNotifications, markRead, unreadCount } from '../services/notifications.ts';
import { addDays, diffDays } from '../../shared/dates.ts';

export function dashboardRouter(ctx: AppContext): Router {
  const r = Router();
  r.get('/', async (req, res) => {
    res.json(await buildDashboard(ctx, req.user!));
  });
  return r;
}

export function notificationsRouter(ctx: AppContext): Router {
  const r = Router();
  r.get('/', async (req, res) => {
    const q = parse(z.object({ unread: qStr(), limit: qInt() }), req.query);
    res.json({
      notifications: await listNotifications(ctx, req.user!, { unreadOnly: q.unread === '1', limit: Math.min(q.limit ?? 100, 300) }),
      unread: await unreadCount(ctx, req.user!),
    });
  });
  r.get('/count', async (req, res) => {
    res.json({ unread: await unreadCount(ctx, req.user!) });
  });
  r.post('/read', async (req, res) => {
    const body = parse(z.object({ ids: z.union([z.array(z.number().int().positive()).max(500), z.literal('all')]) }), req.body);
    res.json({ marked: await markRead(ctx, req.user!, body.ids) });
  });
  return r;
}

export function activityRouter(ctx: AppContext): Router {
  const r = Router();
  r.get('/', async (req, res) => {
    const q = parse(z.object({ client_id: qInt(), entity_type: qStr(), invoice_id: qInt(), before: qStr(), limit: qInt() }), req.query);
    const where: string[] = ['1 = 1'];
    const params: Record<string, unknown> = { limit: Math.min(q.limit ?? 50, 200) };
    if (!isAdmin(req)) where.push(`entity_type NOT IN ('invoice','payment','expense','lead')`);
    if (q.client_id) {
      where.push('client_id = :client_id');
      params.client_id = q.client_id;
    }
    if (q.entity_type) {
      where.push('entity_type = :entity_type');
      params.entity_type = q.entity_type;
    }
    if (q.invoice_id) {
      // An invoice's own history plus the payments recorded against it.
      where.push(`((entity_type = 'invoice' AND entity_id = :invoice_id) OR (entity_type = 'payment' AND (meta::jsonb ->> 'invoice_id')::bigint = :invoice_id))`);
      params.invoice_id = q.invoice_id;
    }
    if (q.before) {
      where.push('created_at < :before');
      params.before = q.before;
    }
    res.json({ items: await ctx.db.all(`SELECT * FROM activity WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT :limit`, params) });
  });
  return r;
}

/** Global search for the command palette. Finance records only for admins. */
export function searchRouter(ctx: AppContext): Router {
  const r = Router();
  r.get('/', async (req, res) => {
    const q = parse(z.object({ q: qStr() }), req.query).q;
    if (!q || q.length < 2) return void res.json({ results: [] });
    const like = likeParam(q);
    const admin = isAdmin(req);
    const results: { type: string; id: number; title: string; subtitle: string | null; link: string }[] = [];
    for (const c of await ctx.db.all<{ id: number; name: string; company: string | null; status: string }>(
      `SELECT id, name, company, status FROM clients WHERE archived_at IS NULL AND (name LIKE :q OR company LIKE :q OR email LIKE :q) ORDER BY name LIMIT 6`,
      { q: like },
    ))
      results.push({ type: 'client', id: c.id, title: c.company || c.name, subtitle: c.company ? c.name : c.status, link: `/clients/${c.id}` });
    for (const p of await ctx.db.all<{ id: number; name: string; client: string }>(
      `SELECT p.id, p.name, COALESCE(c.company, c.name) AS client FROM projects p JOIN clients c ON c.id = p.client_id
        WHERE p.archived_at IS NULL AND (p.name LIKE :q OR p.description LIKE :q OR c.name LIKE :q OR c.company LIKE :q) ORDER BY p.updated_at DESC LIMIT 6`,
      { q: like },
    ))
      results.push({ type: 'project', id: p.id, title: p.name, subtitle: p.client, link: `/projects/${p.id}` });
    for (const d of await ctx.db.all<{ id: number; title: string; project_id: number; project: string }>(
      `SELECT d.id, d.title, d.project_id, p.name AS project FROM deliverables d JOIN projects p ON p.id = d.project_id
        WHERE p.archived_at IS NULL AND d.title LIKE :q ORDER BY d.updated_at DESC LIMIT 6`,
      { q: like },
    ))
      results.push({ type: 'deliverable', id: d.id, title: d.title, subtitle: d.project, link: `/projects/${d.project_id}` });
    for (const t of await ctx.db.all<{ id: number; title: string; status: string }>(`SELECT id, title, status FROM tasks WHERE title LIKE :q ORDER BY status = 'done', id DESC LIMIT 5`, { q: like }))
      results.push({ type: 'task', id: t.id, title: t.title, subtitle: t.status === 'done' ? 'Done' : 'Task', link: `/tasks?task=${t.id}` });
    if (admin) {
      for (const i of await ctx.db.all<{ id: number; number: string; client: string }>(
        `SELECT i.id, i.number, COALESCE(c.company, c.name) AS client FROM invoices i JOIN clients c ON c.id = i.client_id WHERE i.number LIKE :q OR c.name LIKE :q OR c.company LIKE :q ORDER BY i.issue_date DESC LIMIT 5`,
        { q: like },
      ))
        results.push({ type: 'invoice', id: i.id, title: i.number, subtitle: i.client, link: `/invoices/${i.id}` });
      for (const l of await ctx.db.all<{ id: number; name: string; company: string | null; stage: string }>(
        `SELECT id, name, company, stage FROM leads WHERE name LIKE :q OR company LIKE :q OR email LIKE :q OR website LIKE :q ORDER BY updated_at DESC LIMIT 5`,
        { q: like },
      ))
        results.push({ type: 'lead', id: l.id, title: l.company || l.name, subtitle: l.company ? l.name : l.stage, link: `/pipeline?lead=${l.id}` });
    }
    res.json({ results });
  });
  return r;
}

/** Calendar feed: deliverable and project deadlines, task due dates, plus invoices/renewals/follow-ups for admins. */
export function calendarRouter(ctx: AppContext): Router {
  const r = Router();
  r.get('/', async (req, res) => {
    const q = parse(z.object({ from: qDate(), to: qDate(), types: qStr() }), req.query);
    if (!q.from || !q.to) throw badRequest('Pass from and to dates (YYYY-MM-DD).');
    if (q.to < q.from || diffDays(q.from, q.to) > 120) throw badRequest('Use a range of up to 120 days.');
    const types = new Set((q.types ?? 'deliverable,project,task,invoice,renewal,follow_up').split(','));
    const today = await ctx.today();
    const admin = isAdmin(req);
    const params = { from: q.from, to: q.to, today };
    const events: Record<string, unknown>[] = [];
    if (types.has('deliverable')) {
      for (const d of await ctx.db.all<Record<string, unknown>>(
        `SELECT d.id, d.title, d.deadline AS date, d.status, d.project_id, p.name AS project_name, COALESCE(c.company, c.name) AS client_name,
                t.color AS color, t.name AS assignee_name, (d.deadline < :today AND d.status <> 'delivered' AND p.status <> 'on_hold') AS overdue
           FROM deliverables d JOIN projects p ON p.id = d.project_id JOIN clients c ON c.id = p.client_id
           LEFT JOIN team_members t ON t.id = COALESCE(d.assignee_id, p.editor_id)
          WHERE d.deadline BETWEEN :from AND :to AND p.archived_at IS NULL AND p.status <> 'cancelled'`,
        params,
      ))
        events.push({ ...d, type: 'deliverable', link: `/projects/${d.project_id}` });
    }
    if (types.has('project')) {
      for (const p of await ctx.db.all<Record<string, unknown>>(
        `SELECT p.id, p.name AS title, p.deadline AS date, p.status, COALESCE(c.company, c.name) AS client_name,
                (p.deadline < :today AND p.status NOT IN ('delivered','cancelled','on_hold')) AS overdue
           FROM projects p JOIN clients c ON c.id = p.client_id
          WHERE p.deadline BETWEEN :from AND :to AND p.archived_at IS NULL AND p.status <> 'cancelled'`,
        params,
      ))
        events.push({ ...p, type: 'project', link: `/projects/${p.id}` });
    }
    if (types.has('task')) {
      for (const t of await ctx.db.all<Record<string, unknown>>(
        `SELECT t.id, t.title, t.due_date AS date, t.status, m.color, (t.due_date < :today AND t.status IN ('todo','in_progress')) AS overdue
           FROM tasks t LEFT JOIN team_members m ON m.id = t.assignee_id
          WHERE t.due_date BETWEEN :from AND :to AND t.status <> 'cancelled'`,
        params,
      ))
        events.push({ ...t, type: 'task', link: `/tasks?task=${t.id}` });
    }
    if (admin && types.has('invoice')) {
      for (const i of await ctx.db.all<Record<string, unknown>>(
        `SELECT b.id, b.number AS title, b.due_date AS date, b.balance_minor, b.currency, COALESCE(c.company, c.name) AS client_name,
                (b.due_date < :today) AS overdue
           FROM invoice_balances b JOIN clients c ON c.id = b.client_id
          WHERE b.state = 'sent' AND b.balance_minor > 0 AND b.due_date BETWEEN :from AND :to`,
        params,
      ))
        events.push({ ...i, type: 'invoice', link: `/invoices/${i.id}` });
    }
    if (admin && types.has('renewal')) {
      for (const c of await ctx.db.all<Record<string, unknown>>(
        `SELECT id, COALESCE(company, name) AS title, renewal_date AS date FROM clients WHERE archived_at IS NULL AND renewal_date BETWEEN :from AND :to`,
        params,
      ))
        events.push({ ...c, type: 'renewal', overdue: 0, link: `/clients/${c.id}` });
    }
    if (admin && types.has('follow_up')) {
      for (const l of await ctx.db.all<Record<string, unknown>>(
        `SELECT id, COALESCE(company, name) AS title, next_follow_up AS date, stage, (next_follow_up < :today) AS overdue FROM leads
          WHERE stage NOT IN ('won','lost') AND next_follow_up BETWEEN :from AND :to`,
        params,
      ))
        events.push({ ...l, type: 'follow_up', link: `/pipeline?lead=${l.id}` });
    }
    events.sort((a, b) => String(a.date).localeCompare(String(b.date)));
    res.json({ events, today, range: { from: q.from, to: q.to, next: addDays(q.to, 1) } });
  });
  return r;
}
