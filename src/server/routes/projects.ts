import { Router, type Request } from 'express';
import { z } from 'zod';
import type { AppContext } from '../context.ts';
import { isAdmin, requireAdmin } from '../lib/auth.ts';
import { badRequest, conflict, forbidden, idParam, notFound, parse } from '../lib/http.ts';
import { actorOf, logActivity } from '../lib/activity.ts';
import { toCsv } from '../lib/csv.ts';
import {
  boolish,
  currencyCode,
  foreignKey,
  linkList,
  optionalDate,
  optionalMinorAmount,
  optionalText,
  optionalUrl,
  qInt,
  qStr,
  requiredForeignKey,
  requiredText,
} from '../lib/validation.ts';
import { canSeeFinance, likeParam, sendCsv, stripFields, withJson } from './common.ts';
import { PROJECT_SUMMARY_COLUMNS, setDeliverableStatus, setProjectStatus } from '../services/production.ts';
import { listInvoices } from '../services/invoices.ts';
import {
  BILLING_TYPES,
  FEEDBACK_KINDS,
  PLATFORMS,
  PLATFORM_LABELS,
  PRIORITIES,
  PROJECT_STATUSES,
  PROJECT_STATUS_LABELS,
  PROJECT_TYPES,
  PROJECT_TYPE_LABELS,
  STAGES,
  STAGE_LABELS,
} from '../../shared/constants.ts';
import { fromMinor } from '../../shared/money.ts';

const PRICE_FIELDS = ['price_minor', 'billing_type'] as const;

export const deliverableFields = {
  title: requiredText(200),
  format: optionalText(80),
  platform: z.enum(PLATFORMS).nullish().transform((v) => v ?? null),
  deadline: optionalDate(),
  status: z.enum(STAGES),
  assignee_id: foreignKey(),
  source_url: optionalUrl(),
  review_url: optionalUrl(),
  final_url: optionalUrl(),
  revision_count: z.number().int().min(0).max(999),
  estimated_hours: z.number().min(0).max(1000).nullish().transform((v) => v ?? null),
  notes: optionalText(10000),
};
const deliverableCreate = z.object({
  ...deliverableFields,
  status: deliverableFields.status.optional(),
  revision_count: deliverableFields.revision_count.optional(),
});
const deliverableUpdate = z.object({ ...deliverableFields, project_id: z.number().int().positive() }).partial();

const projectFields = {
  client_id: requiredForeignKey('client'),
  name: requiredText(160),
  description: optionalText(20000),
  type: z.enum(PROJECT_TYPES),
  billing_type: z.enum(BILLING_TYPES),
  price_minor: optionalMinorAmount(),
  currency: currencyCode(),
  start_date: optionalDate(),
  deadline: optionalDate(),
  priority: z.enum(PRIORITIES),
  status: z.enum(PROJECT_STATUSES),
  editor_id: foreignKey(),
  reference_links: linkList(),
  asset_links: linkList(),
  portal_visible: boolish(),
};
const projectCreate = z.object({
  ...projectFields,
  billing_type: projectFields.billing_type.optional(),
  currency: projectFields.currency.optional(),
  priority: projectFields.priority.optional(),
  status: projectFields.status.optional(),
  portal_visible: projectFields.portal_visible.optional(),
  deliverables: z.array(deliverableCreate).max(200).optional(),
});
const projectUpdate = z.object(projectFields).partial();
/** What a non-admin team member may change on a project. */
const projectUpdateMember = projectUpdate.omit({ client_id: true, billing_type: true, price_minor: true, currency: true });

const feedbackCreate = z.object({
  deliverable_id: foreignKey(),
  kind: z.enum(FEEDBACK_KINDS),
  body: requiredText(10000),
  timecode: optionalText(40),
  visible_to_client: boolish().optional(),
  move_to_revisions: z.boolean().optional(),
});

const listQuery = z.object({
  q: qStr(),
  status: qStr(),
  scope: z.enum(['active', 'all', 'done', 'archived']).optional().catch('active'),
  client_id: qInt(),
  type: qStr(),
  editor_id: qInt(),
  priority: qStr(),
  overdue: qStr(),
});

async function checkRefs(ctx: AppContext, body: { client_id?: number; editor_id?: number | null; start_date?: string | null; deadline?: string | null }) {
  if (body.client_id && !await ctx.db.get('SELECT 1 FROM clients WHERE id = :id', { id: body.client_id })) throw badRequest('Pick an existing client.');
  if (body.editor_id && !await ctx.db.get('SELECT 1 FROM team_members WHERE id = :id', { id: body.editor_id })) throw badRequest('That editor is not on the team.');
  if (body.start_date && body.deadline && body.deadline < body.start_date) throw badRequest('The deadline cannot be before the start date.');
}

export async function listProjects(ctx: AppContext, query: Partial<z.output<typeof listQuery>>) {
  const where: string[] = [];
  const params: Record<string, unknown> = { today: await ctx.today() };
  if (query.scope === 'archived') where.push('p.archived_at IS NOT NULL');
  else {
    where.push('p.archived_at IS NULL');
    if (query.scope === 'done') where.push(`p.status IN ('delivered','cancelled')`);
    else if (query.scope !== 'all') where.push(`p.status NOT IN ('delivered','cancelled')`);
  }
  if (query.status) {
    where.push('p.status = :status');
    params.status = query.status;
  }
  if (query.client_id) {
    where.push('p.client_id = :client_id');
    params.client_id = query.client_id;
  }
  if (query.type) {
    where.push('p.type = :type');
    params.type = query.type;
  }
  if (query.editor_id) {
    where.push('p.editor_id = :editor_id');
    params.editor_id = query.editor_id;
  }
  if (query.priority) {
    where.push('p.priority = :priority');
    params.priority = query.priority;
  }
  if (query.overdue === '1') where.push(`((p.deadline < :today AND p.status NOT IN ('delivered','cancelled')) OR EXISTS (SELECT 1 FROM deliverables d WHERE d.project_id = p.id AND d.status <> 'delivered' AND d.deadline < :today))`);
  if (query.q) {
    where.push('(p.name LIKE :q OR p.description LIKE :q OR c.name LIKE :q OR c.company LIKE :q)');
    params.q = likeParam(query.q);
  }
  return await (await ctx.db
    .all<Record<string, unknown>>(
      `SELECT p.*, COALESCE(c.company, c.name) AS client_name, c.is_demo AS client_is_demo,
              t.name AS editor_name, t.color AS editor_color, ${PROJECT_SUMMARY_COLUMNS}
         FROM projects p
         JOIN clients c ON c.id = p.client_id
         LEFT JOIN team_members t ON t.id = p.editor_id
        WHERE ${where.join(' AND ')}
        ORDER BY CASE p.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
                 COALESCE(p.deadline, '9999-12-31'), p.id DESC`,
      params,
    ))
    .map((p) => withJson(p, { reference_links: [], asset_links: [] }));
}

export type DeliverableQuery = {
  q?: string;
  status?: string;
  project_id?: number;
  client_id?: number;
  assignee_id?: number;
  overdue?: boolean;
  due_from?: string;
  due_to?: string;
  include_delivered?: boolean;
  delivered_since?: string;
};

export async function listDeliverables(ctx: AppContext, f: DeliverableQuery) {
  const where: string[] = [`p.archived_at IS NULL`, `p.status NOT IN ('cancelled')`];
  // Paused projects stay off the production board (they still show on their own project page).
  if (!f.project_id) where.push(`p.status <> 'on_hold'`);
  const params: Record<string, unknown> = { today: await ctx.today() };
  if (f.status) {
    where.push('d.status = :status');
    params.status = f.status;
  } else if (!f.include_delivered) {
    if (f.delivered_since) {
      where.push(`(d.status <> 'delivered' OR d.delivered_at >= :since)`);
      params.since = f.delivered_since;
    } else where.push(`d.status <> 'delivered'`);
  }
  if (f.project_id) {
    where.push('d.project_id = :project_id');
    params.project_id = f.project_id;
  }
  if (f.client_id) {
    where.push('p.client_id = :client_id');
    params.client_id = f.client_id;
  }
  if (f.assignee_id) {
    where.push('COALESCE(d.assignee_id, p.editor_id) = :assignee_id');
    params.assignee_id = f.assignee_id;
  }
  if (f.overdue) where.push(`d.deadline < :today AND d.status <> 'delivered'`);
  if (f.due_from) {
    where.push('d.deadline >= :due_from');
    params.due_from = f.due_from;
  }
  if (f.due_to) {
    where.push('d.deadline <= :due_to');
    params.due_to = f.due_to;
  }
  if (f.q) {
    where.push('(d.title LIKE :q OR p.name LIKE :q OR c.name LIKE :q OR c.company LIKE :q OR d.platform LIKE :q)');
    params.q = likeParam(f.q);
  }
  return ctx.db.all<Record<string, unknown>>(
    `SELECT d.*, p.name AS project_name, p.type AS project_type, p.priority AS project_priority, p.client_id,
            COALESCE(c.company, c.name) AS client_name,
            COALESCE(d.assignee_id, p.editor_id) AS effective_assignee_id,
            t.name AS assignee_name, t.color AS assignee_color,
            (d.deadline IS NOT NULL AND d.deadline < :today AND d.status <> 'delivered' AND p.status <> 'on_hold') AS is_overdue,
            (SELECT COUNT(*) FROM feedback f WHERE f.deliverable_id = d.id AND f.author_type = 'client' AND f.resolved_at IS NULL) AS open_client_feedback
       FROM deliverables d
       JOIN projects p ON p.id = d.project_id
       JOIN clients c ON c.id = p.client_id
       LEFT JOIN team_members t ON t.id = COALESCE(d.assignee_id, p.editor_id)
      WHERE ${where.join(' AND ')}
      ORDER BY COALESCE(d.deadline, '9999-12-31'),
               CASE p.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, d.sort_order, d.id
      LIMIT 2000`,
    params,
  );
}

async function insertDeliverable(ctx: AppContext, projectId: number, d: z.output<typeof deliverableCreate>, sort: number, isDemo = 0): Promise<number> {
  const now = ctx.nowIso();
  return ctx.db.insert('deliverables', {
    ...d,
    project_id: projectId,
    status: d.status ?? 'backlog',
    revision_count: d.revision_count ?? 0,
    sort_order: sort,
    approved_at: d.status === 'approved' || d.status === 'delivered' ? now : null,
    delivered_at: d.status === 'delivered' ? now : null,
    is_demo: isDemo,
    created_at: now,
    updated_at: now,
  });
}

export function projectsRouter(ctx: AppContext): Router {
  const r = Router();

  r.get('/', async (req, res) => {
    const query = parse(listQuery, req.query);
    const rows = await listProjects(ctx, query);
    res.json({ projects: canSeeFinance(req) ? rows : rows.map((p) => stripFields(p, PRICE_FIELDS)) });
  });

  r.get('/export.csv', requireAdmin, async (_req, res) => {
    const rows = await listProjects(ctx, { scope: 'all' });
    const csv = toCsv(rows, [
      { header: 'ID', value: (p) => p.id },
      { header: 'Project', value: (p) => p.name },
      { header: 'Client', value: (p) => p.client_name },
      { header: 'Type', value: (p) => PROJECT_TYPE_LABELS[p.type as keyof typeof PROJECT_TYPE_LABELS] },
      { header: 'Status', value: (p) => PROJECT_STATUS_LABELS[p.status as keyof typeof PROJECT_STATUS_LABELS] },
      { header: 'Priority', value: (p) => p.priority },
      { header: 'Editor', value: (p) => p.editor_name },
      { header: 'Billing', value: (p) => p.billing_type },
      { header: 'Price', value: (p) => (p.price_minor == null ? '' : fromMinor(p.price_minor as number, p.currency as string)) },
      { header: 'Currency', value: (p) => p.currency },
      { header: 'Start date', value: (p) => p.start_date },
      { header: 'Deadline', value: (p) => p.deadline },
      { header: 'Deliverables', value: (p) => p.deliverable_count },
      { header: 'Delivered', value: (p) => p.delivered_count },
      { header: 'Revisions', value: (p) => p.revision_total },
      { header: 'Overdue', value: (p) => (p.is_overdue ? 'yes' : '') },
      { header: 'Demo data', value: (p) => (p.is_demo ? 'yes' : '') },
    ]);
    await sendCsv(ctx, res, 'projects', csv);
  });

  r.post('/', requireAdmin, async (req, res) => {
    const body = parse(projectCreate, req.body);
    await checkRefs(ctx, body);
    const client = (await ctx.db.get<{ currency: string; archived_at: string | null; is_demo: number }>('SELECT currency, archived_at, is_demo FROM clients WHERE id = :id', { id: body.client_id }))!;
    if (client.archived_at) throw badRequest('That client is archived. Restore it first.');
    const { deliverables, ...fields } = body;
    for (const d of deliverables ?? []) if (d.assignee_id && !await ctx.db.get('SELECT 1 FROM team_members WHERE id = :id', { id: d.assignee_id })) throw badRequest('A deliverable is assigned to someone not on the team.');
    const now = ctx.nowIso();
    const id = await ctx.db.tx(async () => {
      const id = await ctx.db.insert('projects', {
        ...fields,
        currency: fields.currency ?? client.currency,
        billing_type: fields.billing_type ?? 'fixed',
        priority: fields.priority ?? 'medium',
        status: fields.status ?? 'backlog',
        portal_visible: fields.portal_visible ?? 1,
        completed_at: fields.status === 'delivered' ? now : null,
        created_at: now,
        updated_at: now,
      });
      for (const [i, d] of (deliverables ?? []).entries()) await insertDeliverable(ctx, id, d, i);
      await logActivity(ctx, actorOf(req), {
        entity_type: 'project',
        entity_id: id,
        client_id: body.client_id,
        project_id: id,
        action: 'created',
        summary: `Project “${body.name}” created${deliverables?.length ? ` with ${deliverables.length} deliverable${deliverables.length === 1 ? '' : 's'}` : ''}`,
      });
      return id;
    });
    res.status(201).json({ id });
  });

  r.get('/:id', async (req, res) => {
    const id = idParam(req);
    const row = await ctx.db.get<Record<string, unknown>>(
      `SELECT p.*, COALESCE(c.company, c.name) AS client_name, c.name AS client_contact, c.email AS client_email,
              t.name AS editor_name, t.color AS editor_color, ${PROJECT_SUMMARY_COLUMNS}
         FROM projects p JOIN clients c ON c.id = p.client_id LEFT JOIN team_members t ON t.id = p.editor_id
        WHERE p.id = :id`,
      { id, today: await ctx.today() },
    );
    if (!row) throw notFound('Project');
    const project = withJson(row, { reference_links: [], asset_links: [] });
    const deliverables = await (await listDeliverables(ctx, { project_id: id, include_delivered: true })).sort((a, b) => (a.sort_order as number) - (b.sort_order as number) || (a.id as number) - (b.id as number));
    const feedback = await ctx.db.all(
      `SELECT f.*, d.title AS deliverable_title FROM feedback f LEFT JOIN deliverables d ON d.id = f.deliverable_id
        WHERE f.project_id = :id ORDER BY f.created_at DESC, f.id DESC`,
      { id },
    );
    const activity = await ctx.db.all(
      `SELECT id, entity_type, action, summary, actor_type, actor_name, created_at FROM activity
        WHERE project_id = :id ${canSeeFinance(req) ? '' : "AND entity_type NOT IN ('invoice','payment')"}
        ORDER BY created_at DESC LIMIT 100`,
      { id },
    );
    const tasks = await ctx.db.all(`SELECT id, title, status, priority, due_date FROM tasks WHERE project_id = :id ORDER BY status = 'done', COALESCE(due_date,'9999'), id`, { id });
    const invoices = canSeeFinance(req) ? await listInvoices(ctx, { project_id: id }) : [];
    res.json({
      project: canSeeFinance(req) ? project : stripFields(project, PRICE_FIELDS),
      deliverables,
      feedback,
      activity,
      tasks,
      invoices,
    });
  });

  r.patch('/:id', async (req: Request, res) => {
    const id = idParam(req);
    const existing = await ctx.db.get<{ status: string; name: string; client_id: number; start_date: string | null; deadline: string | null }>(
      'SELECT status, name, client_id, start_date, deadline FROM projects WHERE id = :id',
      { id },
    );
    if (!existing) throw notFound('Project');
    const body = isAdmin(req) ? parse(projectUpdate, req.body) : parse(projectUpdateMember, req.body);
    await checkRefs(ctx, { ...body, start_date: body.start_date !== undefined ? body.start_date : existing.start_date, deadline: body.deadline !== undefined ? body.deadline : existing.deadline });
    if ('client_id' in body && body.client_id && body.client_id !== existing.client_id) {
      if (await ctx.db.get('SELECT 1 FROM invoices WHERE project_id = :id', { id })) throw conflict('This project is already invoiced; it cannot move to another client.');
    }
    const { status, ...rest } = body;
    await ctx.db.tx(async () => {
      await ctx.db.update('projects', id, { ...rest, updated_at: ctx.nowIso() });
      if (Object.keys(rest).length) {
        await logActivity(ctx, actorOf(req), {
          entity_type: 'project',
          entity_id: id,
          client_id: (rest as { client_id?: number }).client_id ?? existing.client_id,
          project_id: id,
          action: 'updated',
          summary: `Project “${rest.name ?? existing.name}” updated`,
        });
      }
      if (status) await setProjectStatus(ctx, actorOf(req), id, status);
    });
    res.json({ ok: true });
  });

  r.post('/:id/archive', requireAdmin, async (req, res) => {
    const id = idParam(req);
    const p = await ctx.db.get<{ name: string; client_id: number }>('SELECT name, client_id FROM projects WHERE id = :id', { id });
    if (!p) throw notFound('Project');
    await ctx.db.run('UPDATE projects SET archived_at = :at, updated_at = :at WHERE id = :id', { at: ctx.nowIso(), id });
    await logActivity(ctx, actorOf(req), { entity_type: 'project', entity_id: id, client_id: p.client_id, project_id: id, action: 'archived', summary: `Project “${p.name}” archived` });
    res.json({ ok: true });
  });

  r.post('/:id/restore', requireAdmin, async (req, res) => {
    const id = idParam(req);
    const p = await ctx.db.get<{ name: string; client_id: number }>('SELECT name, client_id FROM projects WHERE id = :id', { id });
    if (!p) throw notFound('Project');
    await ctx.db.run('UPDATE projects SET archived_at = NULL, updated_at = :at WHERE id = :id', { at: ctx.nowIso(), id });
    await logActivity(ctx, actorOf(req), { entity_type: 'project', entity_id: id, client_id: p.client_id, project_id: id, action: 'restored', summary: `Project “${p.name}” restored` });
    res.json({ ok: true });
  });

  r.delete('/:id', requireAdmin, async (req, res) => {
    const id = idParam(req);
    const p = await ctx.db.get<{ name: string; client_id: number }>('SELECT name, client_id FROM projects WHERE id = :id', { id });
    if (!p) throw notFound('Project');
    if (await ctx.db.get('SELECT 1 FROM invoices WHERE project_id = :id', { id })) throw conflict('This project has invoices. Archive it instead, so your financial history stays intact.');
    await ctx.db.tx(async () => {
      await ctx.db.run('DELETE FROM projects WHERE id = :id', { id });
      await logActivity(ctx, actorOf(req), { entity_type: 'project', entity_id: id, client_id: p.client_id, action: 'deleted', summary: `Project “${p.name}” deleted with its deliverables` });
    });
    res.json({ ok: true });
  });

  r.post('/:id/deliverables', async (req, res) => {
    const id = idParam(req);
    const p = await ctx.db.get<{ name: string; client_id: number; is_demo: number }>('SELECT name, client_id, is_demo FROM projects WHERE id = :id', { id });
    if (!p) throw notFound('Project');
    const body = parse(z.union([deliverableCreate, z.object({ items: z.array(deliverableCreate).min(1).max(100) })]), req.body);
    const items = 'items' in body ? body.items : [body];
    for (const d of items) if (d.assignee_id && !await ctx.db.get('SELECT 1 FROM team_members WHERE id = :id', { id: d.assignee_id })) throw badRequest('That assignee is not on the team.');
    const ids = await ctx.db.tx(async () => {
      const base = (await ctx.db.value<number>('SELECT COALESCE(MAX(sort_order), -1) FROM deliverables WHERE project_id = :id', { id }) ?? -1) + 1;
      const ids = await Promise.all(items.map(async (d, i) => insertDeliverable(ctx, id, d, base + i)));
      await logActivity(ctx, actorOf(req), {
        entity_type: 'deliverable',
        entity_id: ids[0],
        client_id: p.client_id,
        project_id: id,
        action: 'created',
        summary: items.length === 1 ? `Deliverable “${items[0].title}” added to ${p.name}` : `${items.length} deliverables added to ${p.name}`,
      });
      // A delivered project that gets new work is live again.
      const status = await ctx.db.value<string>('SELECT status FROM projects WHERE id = :id', { id });
      if (status === 'delivered') await setProjectStatus(ctx, actorOf(req), id, items[0].status ?? 'backlog', 'new deliverables added');
      return ids;
    });
    res.status(201).json({ ids, id: ids[0] });
  });

  r.post('/:id/feedback', async (req, res) => {
    const id = idParam(req);
    const p = await ctx.db.get<{ name: string; client_id: number }>('SELECT name, client_id FROM projects WHERE id = :id', { id });
    if (!p) throw notFound('Project');
    const body = parse(feedbackCreate, req.body);
    let deliverableTitle: string | null = null;
    if (body.deliverable_id) {
      const d = await ctx.db.get<{ project_id: number; title: string }>('SELECT project_id, title FROM deliverables WHERE id = :id', { id: body.deliverable_id });
      if (!d || d.project_id !== id) throw badRequest('That deliverable is not part of this project.');
      deliverableTitle = d.title;
    }
    if (body.kind === 'approval' && !body.deliverable_id) throw badRequest('Pick the deliverable that was approved.');
    const fid = await ctx.db.tx(async () => {
      let revision: number | null = null;
      if (body.deliverable_id && body.kind === 'revision_request' && body.move_to_revisions !== false) {
        revision = (await setDeliverableStatus(ctx, actorOf(req), body.deliverable_id, 'revisions', { reason: 'revision request logged' })).revision_count;
      }
      if (body.deliverable_id && body.kind === 'approval') await setDeliverableStatus(ctx, actorOf(req), body.deliverable_id, 'approved', { reason: 'approval logged' });
      const fid = await ctx.db.insert('feedback', {
        project_id: id,
        deliverable_id: body.deliverable_id,
        kind: body.kind,
        author_type: 'team',
        author_user_id: req.user!.id,
        author_name: req.user!.name,
        body: body.body,
        timecode: body.timecode,
        revision_number: revision,
        visible_to_client: body.kind === 'internal_note' ? 0 : body.visible_to_client ?? 1,
        created_at: ctx.nowIso(),
      });
      await logActivity(ctx, actorOf(req), {
        entity_type: 'feedback',
        entity_id: fid,
        client_id: p.client_id,
        project_id: id,
        action: body.kind,
        summary: `${body.kind === 'internal_note' ? 'Internal note' : body.kind === 'revision_request' ? 'Revision request' : body.kind === 'approval' ? 'Approval' : 'Comment'} on ${deliverableTitle ? `“${deliverableTitle}”` : p.name}`,
      });
      return fid;
    });
    res.status(201).json({ id: fid });
  });

  return r;
}

export function deliverablesRouter(ctx: AppContext): Router {
  const r = Router();
  const query = z.object({
    q: qStr(),
    status: qStr(),
    project_id: qInt(),
    client_id: qInt(),
    assignee_id: qInt(),
    overdue: qStr(),
    due_from: qStr(),
    due_to: qStr(),
    include_delivered: qStr(),
    delivered_since: qStr(),
  });

  r.get('/', async (req, res) => {
    const q = parse(query, req.query);
    res.json({
      deliverables: await listDeliverables(ctx, {
        ...q,
        overdue: q.overdue === '1',
        include_delivered: q.include_delivered === '1',
      }),
    });
  });

  r.get('/export.csv', requireAdmin, async (_req, res) => {
    const rows = await listDeliverables(ctx, { include_delivered: true });
    const csv = toCsv(rows, [
      { header: 'ID', value: (d) => d.id },
      { header: 'Title', value: (d) => d.title },
      { header: 'Project', value: (d) => d.project_name },
      { header: 'Client', value: (d) => d.client_name },
      { header: 'Status', value: (d) => STAGE_LABELS[d.status as keyof typeof STAGE_LABELS] },
      { header: 'Platform', value: (d) => (d.platform ? PLATFORM_LABELS[d.platform as keyof typeof PLATFORM_LABELS] : '') },
      { header: 'Format', value: (d) => d.format },
      { header: 'Deadline', value: (d) => d.deadline },
      { header: 'Assignee', value: (d) => d.assignee_name },
      { header: 'Revisions', value: (d) => d.revision_count },
      { header: 'Source footage', value: (d) => d.source_url },
      { header: 'Review link', value: (d) => d.review_url },
      { header: 'Final delivery', value: (d) => d.final_url },
      { header: 'Delivered at', value: (d) => d.delivered_at },
      { header: 'Overdue', value: (d) => (d.is_overdue ? 'yes' : '') },
    ]);
    await sendCsv(ctx, res, 'deliverables', csv);
  });

  r.patch('/:id', async (req, res) => {
    const id = idParam(req);
    const existing = await ctx.db.get<{ project_id: number; title: string; client_id: number }>(
      'SELECT d.project_id, d.title, p.client_id FROM deliverables d JOIN projects p ON p.id = d.project_id WHERE d.id = :id',
      { id },
    );
    if (!existing) throw notFound('Deliverable');
    const body = parse(deliverableUpdate, req.body);
    if (body.assignee_id && !await ctx.db.get('SELECT 1 FROM team_members WHERE id = :id', { id: body.assignee_id })) throw badRequest('That assignee is not on the team.');
    if (body.project_id && body.project_id !== existing.project_id) {
      if (!isAdmin(req)) throw forbidden('Only an admin can move deliverables between projects.');
      if (!await ctx.db.get('SELECT 1 FROM projects WHERE id = :id', { id: body.project_id })) throw badRequest('That project does not exist.');
    }
    const { status, ...rest } = body;
    await ctx.db.tx(async () => {
      if (Object.keys(rest).length) {
        await ctx.db.update('deliverables', id, { ...rest, updated_at: ctx.nowIso() });
        const fields = Object.keys(rest).filter((k) => k !== 'revision_count');
        if (fields.length) {
          await logActivity(ctx, actorOf(req), {
            entity_type: 'deliverable',
            entity_id: id,
            client_id: existing.client_id,
            project_id: rest.project_id ?? existing.project_id,
            action: 'updated',
            summary: `“${rest.title ?? existing.title}” updated (${fields.map((f) => f.replace(/_/g, ' ')).join(', ')})`,
          });
        }
      }
      if (status) await setDeliverableStatus(ctx, actorOf(req), id, status, { countRevision: rest.revision_count === undefined });
    });
    const row = (await listDeliverables(ctx, { include_delivered: true, project_id: rest.project_id ?? existing.project_id })).find((d) => d.id === id);
    res.json({ deliverable: row ?? null });
  });

  r.delete('/:id', async (req, res) => {
    const id = idParam(req);
    const d = await ctx.db.get<{ title: string; project_id: number; client_id: number }>(
      'SELECT d.title, d.project_id, p.client_id FROM deliverables d JOIN projects p ON p.id = d.project_id WHERE d.id = :id',
      { id },
    );
    if (!d) throw notFound('Deliverable');
    await ctx.db.tx(async () => {
      await ctx.db.run('DELETE FROM deliverables WHERE id = :id', { id });
      await logActivity(ctx, actorOf(req), { entity_type: 'deliverable', entity_id: id, client_id: d.client_id, project_id: d.project_id, action: 'deleted', summary: `Deliverable “${d.title}” deleted` });
    });
    res.json({ ok: true });
  });

  return r;
}

export function feedbackRouter(ctx: AppContext): Router {
  const r = Router();
  r.patch('/:id', async (req, res) => {
    const id = idParam(req);
    const body = parse(z.object({ resolved: z.boolean() }), req.body);
    const changes = (await ctx.db.run('UPDATE feedback SET resolved_at = :at WHERE id = :id', { at: body.resolved ? ctx.nowIso() : null, id })).changes;
    if (!changes) throw notFound('Feedback');
    res.json({ ok: true });
  });
  r.delete('/:id', async (req, res) => {
    const id = idParam(req);
    const f = await ctx.db.get<{ author_type: string }>('SELECT author_type FROM feedback WHERE id = :id', { id });
    if (!f) throw notFound('Feedback');
    if (f.author_type === 'client' && !isAdmin(req)) throw forbidden('Only an admin can delete client feedback.');
    await ctx.db.run('DELETE FROM feedback WHERE id = :id', { id });
    res.json({ ok: true });
  });
  return r;
}
