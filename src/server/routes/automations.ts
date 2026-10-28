import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../context.ts';
import { badRequest, conflict, idParam, notFound, parse } from '../lib/http.ts';
import { actorOf } from '../lib/activity.ts';
import { requiredText } from '../lib/validation.ts';
import { approveAndSend, listAutomations, markSentManually, runAutomations, saveAutomation } from '../services/automations.ts';
import { AUTOMATION_KEYS, OUTBOX_STATUSES, type AutomationKey } from '../../shared/constants.ts';
import { json } from '../db/db.ts';

export function automationsRouter(ctx: AppContext): Router {
  const r = Router();

  r.get('/', (_req, res) => {
    const runs = ctx.db
      .all<{ id: number; trigger: string; started_at: string; finished_at: string | null; status: string; summary: string; error: string | null }>('SELECT * FROM automation_runs ORDER BY id DESC LIMIT 20')
      .map((run) => ({ ...run, summary: json(run.summary, {}) }));
    res.json({
      automations: listAutomations(ctx),
      runs,
      email: { configured: ctx.mailer.configured, description: ctx.mailer.description },
      owner_report_email: ctx.settings().owner_report_email || null,
      pending_approval: ctx.db.value<number>(`SELECT COUNT(*) FROM outbox WHERE status = 'pending_approval'`) ?? 0,
    });
  });

  r.patch('/:key', (req, res) => {
    const key = req.params.key as AutomationKey;
    if (!AUTOMATION_KEYS.includes(key)) throw notFound('Automation');
    const body = parse(
      z.object({
        enabled: z.boolean().optional(),
        config: z.record(z.string(), z.union([z.boolean(), z.number().min(0).max(365)])).optional(),
      }),
      req.body,
    );
    saveAutomation(ctx, key, body);
    res.json({ ok: true });
  });

  r.post('/run', (req, res) => {
    const body = parse(z.object({ keys: z.array(z.enum(AUTOMATION_KEYS)).optional() }), req.body ?? {});
    res.json(runAutomations(ctx, 'manual', body.keys));
  });

  r.post('/test-email', async (_req, res) => {
    if (!ctx.mailer.configured) throw conflict('Email is not configured. Add SMTP settings to the .env file and restart the app.');
    res.json(await ctx.mailer.verify());
  });

  return r;
}

export function outboxRouter(ctx: AppContext): Router {
  const r = Router();

  r.get('/', (req, res) => {
    const status = typeof req.query.status === 'string' && (OUTBOX_STATUSES as readonly string[]).includes(req.query.status) ? req.query.status : null;
    const rows = ctx.db.all(
      `SELECT o.*, COALESCE(c.company, c.name) AS client_name, u.name AS approved_by_name
         FROM outbox o LEFT JOIN clients c ON c.id = o.client_id LEFT JOIN users u ON u.id = o.approved_by
        ${status ? 'WHERE o.status = :status' : ''}
        ORDER BY (o.status = 'pending_approval') DESC, o.created_at DESC LIMIT 300`,
      { status },
    );
    res.json({ messages: rows, email: { configured: ctx.mailer.configured, description: ctx.mailer.description } });
  });

  r.patch('/:id', (req, res) => {
    const id = idParam(req);
    const row = ctx.db.get<{ status: string }>('SELECT status FROM outbox WHERE id = :id', { id });
    if (!row) throw notFound('Message');
    if (row.status !== 'pending_approval' && row.status !== 'failed') throw conflict('Only messages waiting for approval can be edited.');
    const body = parse(
      z.object({
        to_address: z
          .string()
          .trim()
          .toLowerCase()
          .refine((v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), 'Enter a valid email address.')
          .optional(),
        subject: requiredText(300).optional(),
        body: requiredText(20000).optional(),
      }),
      req.body,
    );
    ctx.db.update('outbox', id, { ...body, updated_at: ctx.nowIso() });
    res.json({ ok: true });
  });

  /** The only path that sends an email: a signed-in admin approving one specific message. */
  r.post('/:id/approve-send', async (req, res) => {
    const result = await approveAndSend(ctx, actorOf(req), idParam(req));
    if (result.status === 'failed') throw badRequest(`Sending failed: ${result.error}`);
    res.json(result);
  });

  r.post('/:id/mark-sent', (req, res) => {
    markSentManually(ctx, actorOf(req), idParam(req));
    res.json({ ok: true });
  });

  r.post('/:id/discard', (req, res) => {
    const id = idParam(req);
    const changes = ctx.db.run(`UPDATE outbox SET status = 'rejected', updated_at = :now WHERE id = :id AND status IN ('pending_approval','failed')`, { now: ctx.nowIso(), id }).changes;
    if (!changes) throw conflict('This message was already handled.');
    res.json({ ok: true });
  });

  return r;
}
