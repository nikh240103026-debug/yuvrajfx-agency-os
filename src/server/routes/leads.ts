import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../context.ts';
import { badRequest, conflict, idParam, notFound, parse } from '../lib/http.ts';
import { actorOf, logActivity, type Actor } from '../lib/activity.ts';
import { toCsv } from '../lib/csv.ts';
import {
  currencyCode,
  optionalDate,
  optionalEmail,
  optionalMinorAmount,
  optionalText,
  optionalUrl,
  qStr,
  requiredDate,
  requiredText,
  tagList,
} from '../lib/validation.ts';
import { likeParam, sendCsv, withJson } from './common.ts';
import { findDuplicates, pipelineMetrics, previewLeadImport } from '../services/pipeline.ts';
import {
  COMM_CHANNELS,
  COMM_DIRECTIONS,
  DEAL_TYPES,
  LEAD_SOURCES,
  LEAD_SOURCE_LABELS,
  LEAD_STAGES,
  LEAD_STAGE_LABELS,
  type LeadStage,
} from '../../shared/constants.ts';
import { formatMoney, fromMinor, isValidCurrency } from '../../shared/money.ts';

const fields = {
  name: requiredText(120),
  company: optionalText(160),
  email: optionalEmail(),
  phone: optionalText(60),
  website: optionalUrl(),
  social_url: optionalText(300),
  source: z.enum(LEAD_SOURCES),
  deal_type: z.enum(DEAL_TYPES),
  estimated_value_minor: optionalMinorAmount(),
  currency: currencyCode(),
  stage: z.enum(LEAD_STAGES),
  last_contact_at: optionalDate(),
  next_follow_up: optionalDate(),
  notes: optionalText(20000),
  outcome_reason: optionalText(1000),
  tags: tagList(),
};
const createSchema = z.object({
  ...fields,
  source: fields.source.optional(),
  deal_type: fields.deal_type.optional(),
  stage: fields.stage.optional(),
  force: z.boolean().optional(),
});
const updateSchema = z.object(fields).partial();

const listQuery = z.object({ q: qStr(), stage: qStr(), source: qStr(), follow_up: qStr(), deal_type: qStr(), status: z.enum(['open', 'closed', 'all']).optional().catch('all') });

const activitySchema = z.object({
  channel: z.enum(COMM_CHANNELS),
  direction: z.enum(COMM_DIRECTIONS).optional(),
  subject: optionalText(200),
  body: optionalText(10000),
  occurred_at: requiredDate(),
  next_follow_up: optionalDate(),
  advance_stage: z.boolean().optional(),
});

function changeStage(ctx: AppContext, actor: Actor, id: number, from: LeadStage, to: LeadStage, label: string, isDemo: number): void {
  if (from === to) return;
  const now = ctx.nowIso();
  ctx.db.run('UPDATE leads SET stage = :to, stage_changed_at = :now, closed_at = :closed, updated_at = :now WHERE id = :id', {
    to,
    now,
    closed: to === 'won' || to === 'lost' ? now : null,
    id,
  });
  ctx.db.insert('lead_stage_history', { lead_id: id, from_stage: from, to_stage: to, changed_at: now });
  logActivity(ctx, actor, {
    entity_type: 'lead',
    entity_id: id,
    action: to === 'won' ? 'won' : to === 'lost' ? 'lost' : 'stage_changed',
    summary: `${label}: ${LEAD_STAGE_LABELS[from]} → ${LEAD_STAGE_LABELS[to]}`,
    is_demo: isDemo,
  });
}

export function leadsRouter(ctx: AppContext): Router {
  const r = Router();

  function list(q: z.output<typeof listQuery>) {
    const where: string[] = ['1 = 1'];
    const params: Record<string, unknown> = { today: ctx.today() };
    if (q.stage) {
      where.push('l.stage = :stage');
      params.stage = q.stage;
    }
    if (q.status === 'open') where.push(`l.stage NOT IN ('won','lost')`);
    if (q.status === 'closed') where.push(`l.stage IN ('won','lost')`);
    if (q.source) {
      where.push('l.source = :source');
      params.source = q.source;
    }
    if (q.deal_type) {
      where.push('l.deal_type = :deal_type');
      params.deal_type = q.deal_type;
    }
    if (q.follow_up === 'overdue') where.push(`l.next_follow_up < :today AND l.stage NOT IN ('won','lost')`);
    if (q.follow_up === 'today') where.push(`l.next_follow_up = :today AND l.stage NOT IN ('won','lost')`);
    if (q.follow_up === 'due') where.push(`l.next_follow_up <= :today AND l.stage NOT IN ('won','lost')`);
    if (q.q) {
      where.push('(l.name LIKE :q OR l.company LIKE :q OR l.email LIKE :q OR l.website LIKE :q OR l.notes LIKE :q OR l.social_url LIKE :q)');
      params.q = likeParam(q.q);
    }
    return ctx.db
      .all<Record<string, unknown>>(
        `SELECT l.*, (l.next_follow_up IS NOT NULL AND l.next_follow_up < :today AND l.stage NOT IN ('won','lost')) AS follow_up_overdue,
                (l.next_follow_up = :today AND l.stage NOT IN ('won','lost')) AS follow_up_today,
                (SELECT COUNT(*) FROM communications c WHERE c.lead_id = l.id) AS touchpoints
           FROM leads l WHERE ${where.join(' AND ')}
          ORDER BY CASE WHEN l.stage IN ('won','lost') THEN 1 ELSE 0 END, COALESCE(l.next_follow_up, '9999-12-31'), l.updated_at DESC`,
        params,
      )
      .map((l) => withJson(l, { tags: [] }));
  }

  r.get('/', (req, res) => {
    res.json({ leads: list(parse(listQuery, req.query)) });
  });

  r.get('/metrics', (req, res) => {
    const q = parse(z.object({ from: qStr(), to: qStr() }), req.query);
    res.json(pipelineMetrics(ctx, q));
  });

  r.get('/export.csv', (req, res) => {
    const rows = list(parse(listQuery, req.query));
    const csv = toCsv(rows, [
      { header: 'Name', value: (l) => l.name },
      { header: 'Company', value: (l) => l.company },
      { header: 'Email', value: (l) => l.email },
      { header: 'Phone', value: (l) => l.phone },
      { header: 'Website', value: (l) => l.website },
      { header: 'Social', value: (l) => l.social_url },
      { header: 'Source', value: (l) => LEAD_SOURCE_LABELS[l.source as keyof typeof LEAD_SOURCE_LABELS] ?? l.source },
      { header: 'Stage', value: (l) => LEAD_STAGE_LABELS[l.stage as LeadStage] },
      { header: 'Deal type', value: (l) => l.deal_type },
      { header: 'Estimated value', value: (l) => (l.estimated_value_minor == null ? '' : fromMinor(l.estimated_value_minor as number, l.currency as string)) },
      { header: 'Currency', value: (l) => l.currency },
      { header: 'Last contact', value: (l) => l.last_contact_at },
      { header: 'Next follow-up', value: (l) => l.next_follow_up },
      { header: 'Outcome reason', value: (l) => l.outcome_reason },
      { header: 'Notes', value: (l) => l.notes },
      { header: 'Tags', value: (l) => (l.tags as string[]).join('; ') },
      { header: 'Created', value: (l) => String(l.created_at).slice(0, 10) },
      { header: 'Demo data', value: (l) => (l.is_demo ? 'yes' : '') },
    ]);
    sendCsv(ctx, res, 'pipeline', csv);
  });

  r.post('/check-duplicates', (req, res) => {
    const body = parse(
      z.object({
        name: z.string().max(200).nullish(),
        company: z.string().max(200).nullish(),
        email: z.string().max(200).nullish(),
        phone: z.string().max(60).nullish(),
        website: z.string().max(2000).nullish(),
        social_url: z.string().max(300).nullish(),
        exclude_id: z.number().int().positive().optional(),
      }),
      req.body,
    );
    res.json({ duplicates: findDuplicates(ctx, body, { excludeLeadId: body.exclude_id }) });
  });

  const importSchema = z.object({
    csv: z.string().min(1, 'The file is empty.').max(4_000_000, 'That file is too large (max ~4 MB).'),
    default_currency: z.string().optional(),
    skip_duplicates: z.boolean().optional(),
    skip_rows: z.array(z.number().int()).max(5000).optional(),
  });

  r.post('/import/preview', (req, res) => {
    const body = parse(importSchema, req.body);
    const cur = body.default_currency && isValidCurrency(body.default_currency) ? body.default_currency : ctx.settings().base_currency;
    const preview = previewLeadImport(ctx, body.csv, cur);
    if (preview.rows.length === 0) throw badRequest('No data rows found. The first row must be column headers.');
    res.json(preview);
  });

  /** Imports only rows the owner supplied in the CSV; nothing is invented or enriched. */
  r.post('/import', (req, res) => {
    const body = parse(importSchema, req.body);
    const cur = body.default_currency && isValidCurrency(body.default_currency) ? body.default_currency : ctx.settings().base_currency;
    const preview = previewLeadImport(ctx, body.csv, cur);
    const skip = new Set(body.skip_rows ?? []);
    const actor = actorOf(req);
    let imported = 0;
    let skipped = 0;
    ctx.db.tx(() => {
      for (const row of preview.rows) {
        if (!row.lead || skip.has(row.row) || (body.skip_duplicates !== false && (row.duplicates.length > 0 || row.duplicate_in_file))) {
          skipped++;
          continue;
        }
        const now = ctx.nowIso();
        const id = ctx.db.insert('leads', { ...row.lead, stage_changed_at: now, closed_at: row.lead.stage === 'won' || row.lead.stage === 'lost' ? now : null, created_at: now, updated_at: now });
        ctx.db.insert('lead_stage_history', { lead_id: id, from_stage: null, to_stage: row.lead.stage, changed_at: now });
        imported++;
      }
      if (imported) logActivity(ctx, actor, { entity_type: 'lead', entity_id: null, action: 'imported', summary: `${imported} lead${imported === 1 ? '' : 's'} imported from CSV` });
    });
    res.json({ imported, skipped });
  });

  r.post('/', (req, res) => {
    const body = parse(createSchema, req.body);
    const { force, ...data } = body;
    const duplicates = findDuplicates(ctx, data);
    if (duplicates.length && !force) throw conflict('This looks like someone already in your pipeline or client list.', { duplicates });
    const now = ctx.nowIso();
    const stage = data.stage ?? 'lead';
    const id = ctx.db.tx(() => {
      const id = ctx.db.insert('leads', {
        ...data,
        stage,
        source: data.source ?? 'other',
        deal_type: data.deal_type ?? 'retainer',
        stage_changed_at: now,
        closed_at: stage === 'won' || stage === 'lost' ? now : null,
        created_at: now,
        updated_at: now,
      });
      ctx.db.insert('lead_stage_history', { lead_id: id, from_stage: null, to_stage: stage, changed_at: now });
      logActivity(ctx, actorOf(req), {
        entity_type: 'lead',
        entity_id: id,
        action: 'created',
        summary: `Lead ${data.company ? `${data.name} (${data.company})` : data.name} added${data.estimated_value_minor ? ` · est. ${formatMoney(data.estimated_value_minor, data.currency)}${(data.deal_type ?? 'retainer') === 'retainer' ? '/mo' : ''}` : ''}`,
      });
      return id;
    });
    res.status(201).json({ id, duplicates });
  });

  r.get('/:id', (req, res) => {
    const id = idParam(req);
    const row = ctx.db.get<Record<string, unknown>>('SELECT * FROM leads WHERE id = :id', { id });
    if (!row) throw notFound('Lead');
    const lead = withJson(row, { tags: [] });
    const outreach = ctx.db.all(
      `SELECT c.*, u.name AS created_by_name FROM communications c LEFT JOIN users u ON u.id = c.created_by
        WHERE c.lead_id = :id ORDER BY c.occurred_at DESC, c.id DESC`,
      { id },
    );
    const history = ctx.db.all('SELECT * FROM lead_stage_history WHERE lead_id = :id ORDER BY changed_at, id', { id });
    const duplicates = findDuplicates(ctx, lead as never, { excludeLeadId: id });
    const client = lead.client_id ? ctx.db.get('SELECT id, name, company FROM clients WHERE id = :id', { id: lead.client_id }) : null;
    res.json({ lead, outreach, history, duplicates, client });
  });

  r.patch('/:id', (req, res) => {
    const id = idParam(req);
    const existing = ctx.db.get<{ stage: LeadStage; name: string; company: string | null; is_demo: number }>('SELECT stage, name, company, is_demo FROM leads WHERE id = :id', { id });
    if (!existing) throw notFound('Lead');
    const body = parse(updateSchema, req.body);
    const { stage, ...rest } = body;
    ctx.db.tx(() => {
      if (Object.keys(rest).length) ctx.db.update('leads', id, { ...rest, updated_at: ctx.nowIso() });
      if (stage) changeStage(ctx, actorOf(req), id, existing.stage, stage, rest.company ?? existing.company ?? rest.name ?? existing.name, existing.is_demo);
    });
    res.json({ ok: true });
  });

  r.delete('/:id', (req, res) => {
    const id = idParam(req);
    const l = ctx.db.get<{ name: string }>('SELECT name FROM leads WHERE id = :id', { id });
    if (!l) throw notFound('Lead');
    ctx.db.tx(() => {
      ctx.db.run('DELETE FROM leads WHERE id = :id', { id });
      logActivity(ctx, actorOf(req), { entity_type: 'lead', entity_id: id, action: 'deleted', summary: `Lead ${l.name} deleted` });
    });
    res.json({ ok: true });
  });

  /** Log outreach (a call, email, DM…) that happened outside the app. Nothing is sent. */
  r.post('/:id/activities', (req, res) => {
    const id = idParam(req);
    const lead = ctx.db.get<{ stage: LeadStage; name: string; company: string | null; last_contact_at: string | null; is_demo: number }>(
      'SELECT stage, name, company, last_contact_at, is_demo FROM leads WHERE id = :id',
      { id },
    );
    if (!lead) throw notFound('Lead');
    const body = parse(activitySchema, req.body);
    const direction = body.direction ?? 'outbound';
    const commId = ctx.db.tx(() => {
      const commId = ctx.db.insert('communications', {
        lead_id: id,
        channel: body.channel,
        direction,
        subject: body.subject,
        body: body.body,
        occurred_at: body.occurred_at,
        created_by: req.user!.id,
        created_at: ctx.nowIso(),
      });
      const patch: Record<string, unknown> = { updated_at: ctx.nowIso() };
      if (direction !== 'internal' && body.channel !== 'note' && (!lead.last_contact_at || body.occurred_at > lead.last_contact_at)) patch.last_contact_at = body.occurred_at;
      if (body.next_follow_up !== null) patch.next_follow_up = body.next_follow_up;
      ctx.db.update('leads', id, patch);
      if (body.advance_stage !== false && body.channel !== 'note') {
        const label = lead.company ?? lead.name;
        if (lead.stage === 'lead' && direction === 'outbound') changeStage(ctx, actorOf(req), id, 'lead', 'contacted', label, lead.is_demo);
        else if ((lead.stage === 'lead' || lead.stage === 'contacted') && direction === 'inbound') changeStage(ctx, actorOf(req), id, lead.stage, 'replied', label, lead.is_demo);
      }
      return commId;
    });
    res.status(201).json({ id: commId });
  });

  r.delete('/:id/activities/:commId', (req, res) => {
    const changes = ctx.db.run('DELETE FROM communications WHERE id = :commId AND lead_id = :id', { id: idParam(req), commId: idParam(req, 'commId') }).changes;
    if (!changes) throw notFound('Log entry');
    res.json({ ok: true });
  });

  /** Won deal → client record (reuses the lead's details; outreach history is linked to the client). */
  r.post('/:id/convert', (req, res) => {
    const id = idParam(req);
    const lead = ctx.db.get<{ id: number; name: string; company: string | null; email: string | null; phone: string | null; website: string | null; social_url: string | null; deal_type: string; estimated_value_minor: number | null; currency: string; stage: LeadStage; client_id: number | null; notes: string | null; tags: string; is_demo: number; outcome_reason: string | null }>(
      'SELECT * FROM leads WHERE id = :id',
      { id },
    );
    if (!lead) throw notFound('Lead');
    if (lead.client_id && ctx.db.get('SELECT 1 FROM clients WHERE id = :id', { id: lead.client_id })) throw conflict('This lead is already linked to a client.', { client_id: lead.client_id });
    const body = parse(z.object({ outcome_reason: optionalText(1000) }), req.body ?? {});
    const now = ctx.nowIso();
    const clientId = ctx.db.tx(() => {
      const socials: Record<string, string> = {};
      if (lead.social_url) {
        const s = lead.social_url.toLowerCase();
        const key = s.includes('instagram') ? 'instagram' : s.includes('youtube') ? 'youtube' : s.includes('tiktok') ? 'tiktok' : s.includes('linkedin') ? 'linkedin' : s.includes('x.com') || s.includes('twitter') ? 'x' : 'other';
        socials[key] = lead.social_url;
      }
      const clientId = ctx.db.insert('clients', {
        name: lead.name,
        company: lead.company,
        email: lead.email,
        phone: lead.phone,
        website: lead.website,
        socials,
        currency: lead.currency,
        retainer_minor: lead.deal_type === 'retainer' ? lead.estimated_value_minor : null,
        billing_cycle: 'monthly',
        payment_terms_days: ctx.settings().default_payment_terms_days,
        status: 'onboarding',
        contract_start: ctx.today(),
        tags: lead.tags,
        notes: lead.notes,
        is_demo: lead.is_demo,
        created_at: now,
        updated_at: now,
      });
      ctx.db.run('UPDATE leads SET client_id = :cid, outcome_reason = COALESCE(:reason, outcome_reason), updated_at = :now WHERE id = :id', { cid: clientId, reason: body.outcome_reason, now, id });
      ctx.db.run('UPDATE communications SET client_id = :cid WHERE lead_id = :id', { cid: clientId, id });
      if (lead.stage !== 'won') changeStage(ctx, actorOf(req), id, lead.stage, 'won', lead.company ?? lead.name, lead.is_demo);
      logActivity(ctx, actorOf(req), {
        entity_type: 'client',
        entity_id: clientId,
        client_id: clientId,
        action: 'created',
        summary: `Deal won — ${lead.company ?? lead.name} is now a client`,
        is_demo: lead.is_demo,
      });
      return clientId;
    });
    res.status(201).json({ client_id: clientId });
  });

  return r;
}
