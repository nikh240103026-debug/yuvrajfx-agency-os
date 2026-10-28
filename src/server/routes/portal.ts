import { Router, type Request } from 'express';
import { z } from 'zod';
import type { AppContext } from '../context.ts';
import { conflict, idParam, notFound, parse } from '../lib/http.ts';
import { actorOf, logActivity } from '../lib/activity.ts';
import { optionalText, requiredText } from '../lib/validation.ts';
import { setDeliverableStatus } from '../services/production.ts';
import { getInvoice, listInvoices } from '../services/invoices.ts';
import { notify } from '../services/notifications.ts';
import { businessProfile } from './invoices.ts';
import { PORTAL_STAGE_LABELS, type Stage } from '../../shared/constants.ts';

// Client portal API. Every query is scoped by the client id stored on the signed-in portal user's
// session — never by an id taken from the request — so one client can never read another's data.
// Internal fields (notes, prices, team costs, internal comments, source footage, draft invoices)
// are never selected here at all.

const REVIEW_VISIBLE: Stage[] = ['client_review', 'revisions', 'approved', 'delivered'];
const FINAL_VISIBLE: Stage[] = ['approved', 'delivered'];

type SafeDeliverable = {
  id: number;
  project_id: number;
  title: string;
  format: string | null;
  platform: string | null;
  deadline: string | null;
  status: Stage;
  revision_count: number;
  review_url: string | null;
  final_url: string | null;
  approved_at: string | null;
  delivered_at: string | null;
};

function clientId(req: Request): number {
  return req.user!.client_id!;
}

function safeDeliverable(d: SafeDeliverable) {
  return {
    id: d.id,
    project_id: d.project_id,
    title: d.title,
    format: d.format,
    platform: d.platform,
    deadline: d.deadline,
    status: d.status,
    status_label: PORTAL_STAGE_LABELS[d.status],
    revision_count: d.revision_count,
    review_url: REVIEW_VISIBLE.includes(d.status) ? d.review_url : null,
    final_url: FINAL_VISIBLE.includes(d.status) ? d.final_url : null,
    approved_at: d.approved_at,
    delivered_at: d.delivered_at,
    can_review: d.status === 'client_review',
  };
}

const PROJECT_SCOPE = `p.client_id = :cid AND p.portal_visible = 1 AND p.archived_at IS NULL AND p.status <> 'cancelled'`;

/** Loads a deliverable only if it belongs to a visible project of this client; otherwise 404. */
function ownDeliverable(ctx: AppContext, req: Request): SafeDeliverable & { project_name: string; client_id: number } {
  const d = ctx.db.get<SafeDeliverable & { project_name: string; client_id: number }>(
    `SELECT d.id, d.project_id, d.title, d.format, d.platform, d.deadline, d.status, d.revision_count, d.review_url, d.final_url,
            d.approved_at, d.delivered_at, p.name AS project_name, p.client_id
       FROM deliverables d JOIN projects p ON p.id = d.project_id
      WHERE d.id = :id AND ${PROJECT_SCOPE}`,
    { id: idParam(req), cid: clientId(req) },
  );
  if (!d) throw notFound('Deliverable');
  return d;
}

const messageSchema = z.object({ body: requiredText(5000), timecode: optionalText(40) });

export function portalRouter(ctx: AppContext): Router {
  const r = Router();

  r.get('/me', (req, res) => {
    const cid = clientId(req);
    const client = ctx.db.get('SELECT id, name, company, service_package FROM clients WHERE id = :cid', { cid });
    const counts = ctx.db.get(
      `SELECT (SELECT COUNT(*) FROM projects p WHERE ${PROJECT_SCOPE} AND p.status <> 'delivered') AS active_projects,
              (SELECT COUNT(*) FROM deliverables d JOIN projects p ON p.id = d.project_id WHERE ${PROJECT_SCOPE} AND d.status = 'client_review') AS awaiting_review,
              (SELECT COUNT(*) FROM deliverables d JOIN projects p ON p.id = d.project_id WHERE ${PROJECT_SCOPE} AND d.status IN ('approved','delivered') AND d.final_url IS NOT NULL) AS downloads`,
      { cid },
    );
    const open = listInvoices(ctx, { client_id: cid, portal_only: true }).filter((i) => ['sent', 'partially_paid', 'overdue'].includes(i.status));
    const b = businessProfile(ctx);
    res.json({ client, counts: { ...counts, open_invoices: open.length }, business: { name: b.name, email: b.email, website: b.website } });
  });

  r.get('/projects', (req, res) => {
    const cid = clientId(req);
    const projects = ctx.db.all<{ id: number }>(
      `SELECT p.id, p.name, p.type, p.status, p.start_date, p.deadline,
              (SELECT COUNT(*) FROM deliverables d WHERE d.project_id = p.id) AS deliverable_count,
              (SELECT COUNT(*) FROM deliverables d WHERE d.project_id = p.id AND d.status = 'delivered') AS delivered_count,
              (SELECT COUNT(*) FROM deliverables d WHERE d.project_id = p.id AND d.status = 'client_review') AS awaiting_review
         FROM projects p WHERE ${PROJECT_SCOPE}
        ORDER BY p.status = 'delivered', COALESCE(p.deadline, '9999-12-31'), p.id DESC`,
      { cid },
    );
    res.json({ projects });
  });

  r.get('/projects/:id', (req, res) => {
    const cid = clientId(req);
    const id = idParam(req);
    const project = ctx.db.get(`SELECT p.id, p.name, p.type, p.status, p.start_date, p.deadline FROM projects p WHERE p.id = :id AND ${PROJECT_SCOPE}`, { id, cid });
    if (!project) throw notFound('Project');
    const deliverables = ctx.db
      .all<SafeDeliverable>(
        `SELECT d.id, d.project_id, d.title, d.format, d.platform, d.deadline, d.status, d.revision_count, d.review_url, d.final_url, d.approved_at, d.delivered_at
           FROM deliverables d WHERE d.project_id = :id ORDER BY d.sort_order, d.id`,
        { id },
      )
      .map(safeDeliverable);
    const feedback = ctx.db.all(
      `SELECT f.id, f.deliverable_id, f.kind, f.author_type, f.author_name, f.body, f.timecode, f.created_at
         FROM feedback f WHERE f.project_id = :id AND f.visible_to_client = 1 AND f.kind <> 'internal_note'
        ORDER BY f.created_at DESC, f.id DESC`,
      { id },
    );
    res.json({ project, deliverables, feedback });
  });

  r.post('/deliverables/:id/feedback', (req, res) => {
    const d = ownDeliverable(ctx, req);
    const body = parse(messageSchema, req.body);
    const fid = ctx.db.tx(() => {
      const fid = ctx.db.insert('feedback', {
        project_id: d.project_id,
        deliverable_id: d.id,
        kind: 'comment',
        author_type: 'client',
        author_user_id: req.user!.id,
        author_name: req.user!.name,
        body: body.body,
        timecode: body.timecode,
        visible_to_client: 1,
        created_at: ctx.nowIso(),
      });
      logActivity(ctx, actorOf(req), { entity_type: 'feedback', entity_id: fid, client_id: d.client_id, project_id: d.project_id, action: 'client_comment', summary: `${req.user!.name} commented on “${d.title}”` });
      notify(ctx, {
        kind: 'client_feedback',
        audience: 'staff',
        severity: 'warning',
        title: `New comment from ${req.user!.name}`,
        body: `On “${d.title}”: ${body.body.slice(0, 140)}`,
        link: `/projects/${d.project_id}`,
        entity_type: 'deliverable',
        entity_id: d.id,
        dedupe_key: `client_feedback:${fid}`,
      });
      return fid;
    });
    res.status(201).json({ id: fid });
  });

  r.post('/deliverables/:id/approve', (req, res) => {
    const d = ownDeliverable(ctx, req);
    if (d.status !== 'client_review') throw conflict('This video is not waiting for your review right now.');
    const body = parse(z.object({ body: optionalText(5000) }), req.body ?? {});
    ctx.db.tx(() => {
      setDeliverableStatus(ctx, actorOf(req), d.id, 'approved', { reason: `approved by ${req.user!.name} in the portal` });
      const fid = ctx.db.insert('feedback', {
        project_id: d.project_id,
        deliverable_id: d.id,
        kind: 'approval',
        author_type: 'client',
        author_user_id: req.user!.id,
        author_name: req.user!.name,
        body: body.body ?? 'Approved.',
        visible_to_client: 1,
        created_at: ctx.nowIso(),
      });
      notify(ctx, {
        kind: 'client_approval',
        audience: 'staff',
        severity: 'success',
        title: `${req.user!.name} approved “${d.title}”`,
        body: d.project_name,
        link: `/projects/${d.project_id}`,
        entity_type: 'deliverable',
        entity_id: d.id,
        dedupe_key: `client_approval:${fid}`,
      });
    });
    res.json({ ok: true });
  });

  r.post('/deliverables/:id/request-changes', (req, res) => {
    const d = ownDeliverable(ctx, req);
    if (d.status !== 'client_review') throw conflict('This video is not waiting for your review right now.');
    const body = parse(messageSchema, req.body);
    ctx.db.tx(() => {
      const { revision_count } = setDeliverableStatus(ctx, actorOf(req), d.id, 'revisions', { reason: `changes requested by ${req.user!.name}` });
      const fid = ctx.db.insert('feedback', {
        project_id: d.project_id,
        deliverable_id: d.id,
        kind: 'revision_request',
        author_type: 'client',
        author_user_id: req.user!.id,
        author_name: req.user!.name,
        body: body.body,
        timecode: body.timecode,
        revision_number: revision_count,
        visible_to_client: 1,
        created_at: ctx.nowIso(),
      });
      notify(ctx, {
        kind: 'client_revision',
        audience: 'staff',
        severity: 'warning',
        title: `${req.user!.name} requested changes on “${d.title}”`,
        body: body.body.slice(0, 160),
        link: `/projects/${d.project_id}`,
        entity_type: 'deliverable',
        entity_id: d.id,
        dedupe_key: `client_revision:${fid}`,
      });
    });
    res.json({ ok: true });
  });

  r.get('/invoices', (req, res) => {
    const invoices = listInvoices(ctx, { client_id: clientId(req), portal_only: true }).map((i) => ({
      id: i.id,
      number: i.number,
      issue_date: i.issue_date,
      due_date: i.due_date,
      status: i.status,
      currency: i.currency,
      total_minor: i.total_minor,
      paid_minor: i.paid_minor,
      balance_minor: i.balance_minor,
      project_name: i.project_name,
    }));
    res.json({ invoices });
  });

  r.get('/invoices/:id', (req, res) => {
    const inv = getInvoice(ctx, idParam(req));
    if (!inv || inv.client_id !== clientId(req) || inv.state === 'draft' || !inv.portal_visible) throw notFound('Invoice');
    const { internal_notes: _internal, void_reason: _void, ...rest } = inv as typeof inv & { internal_notes?: unknown; void_reason?: unknown };
    res.json({
      invoice: {
        ...rest,
        payments: inv.payments.map((p) => {
          const { recorded_by: _r, notes: _n, created_at: _c, ...safe } = p as Record<string, unknown>;
          return safe;
        }),
      },
      business: businessProfile(ctx),
    });
  });

  return r;
}
