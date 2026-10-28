import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../context.ts';
import { requireAdmin } from '../lib/auth.ts';
import { conflict, idParam, notFound, parse } from '../lib/http.ts';
import { actorOf, logActivity } from '../lib/activity.ts';
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
import { canSeeFinance, likeParam, sendCsv, stripFields, withJson } from './common.ts';
import { listInvoices } from '../services/invoices.ts';
import { sumByCurrency, fromMinor } from '../../shared/money.ts';
import {
  BILLING_CYCLES,
  CLIENT_STATUSES,
  CLIENT_STATUS_LABELS,
  COMM_CHANNELS,
  COMM_DIRECTIONS,
  SOCIAL_KEYS,
} from '../../shared/constants.ts';
import { isValidTimeZone } from '../../shared/dates.ts';

const FINANCE_FIELDS = ['retainer_minor', 'outstanding', 'collected', 'invoiced', 'payment_terms_note'] as const;

const socials = () =>
  z
    .record(z.string(), z.string().max(300).nullish())
    .nullish()
    .transform((rec) => {
      const out: Record<string, string> = {};
      for (const key of SOCIAL_KEYS) {
        const v = rec?.[key]?.trim();
        if (v) out[key] = v;
      }
      return out;
    });

const clientFields = {
  name: requiredText(120),
  company: optionalText(160),
  email: optionalEmail(),
  phone: optionalText(60),
  whatsapp: optionalText(60),
  other_contact: optionalText(300),
  website: optionalUrl(),
  socials: socials(),
  billing_address: optionalText(600),
  tax_id: optionalText(80),
  country: optionalText(80),
  timezone: z
    .string()
    .nullish()
    .transform((v) => (v ? v : null))
    .refine((v) => v === null || isValidTimeZone(v), 'Unknown timezone.'),
  service_package: optionalText(200),
  retainer_minor: optionalMinorAmount(),
  currency: currencyCode(),
  billing_cycle: z.enum(BILLING_CYCLES),
  billing_day: z.number().int().min(1).max(28).nullish().transform((v) => v ?? null),
  contract_start: optionalDate(),
  renewal_date: optionalDate(),
  payment_terms_days: z.number().int().min(0).max(365),
  payment_terms_note: optionalText(300),
  status: z.enum(CLIENT_STATUSES),
  tags: tagList(),
  notes: optionalText(20000),
};

const createSchema = z.object({
  ...clientFields,
  billing_cycle: clientFields.billing_cycle.optional(),
  payment_terms_days: clientFields.payment_terms_days.optional(),
  status: clientFields.status.optional(),
});
const updateSchema = z.object(clientFields).partial();

const commSchema = z.object({
  channel: z.enum(COMM_CHANNELS),
  direction: z.enum(COMM_DIRECTIONS).optional(),
  subject: optionalText(200),
  body: optionalText(10000),
  occurred_at: requiredDate(),
});

const listQuery = z.object({
  q: qStr(),
  status: qStr(),
  tag: qStr(),
  sort: z.enum(['name', 'company', 'retainer', 'created', 'renewal', 'status', 'activity']).optional().catch('name'),
  order: z.enum(['asc', 'desc']).optional().catch('asc'),
  archived: z.enum(['0', '1', 'only']).optional().catch('0'),
});

export type ClientListRow = Record<string, unknown> & {
  id: number;
  name: string;
  company: string | null;
  currency: string;
  tags: string[];
  outstanding: { currency: string; amount_minor: number }[];
};

export function listClients(ctx: AppContext, query: Partial<z.output<typeof listQuery>>): ClientListRow[] {
  const where: string[] = [];
  const params: Record<string, unknown> = { today: ctx.today() };
  if (query.archived === 'only') where.push('c.archived_at IS NOT NULL');
  else if (query.archived !== '1') where.push('c.archived_at IS NULL');
  if (query.status && query.status !== 'all') {
    where.push('c.status = :status');
    params.status = query.status;
  }
  if (query.tag) {
    where.push('EXISTS (SELECT 1 FROM json_each(c.tags) WHERE value = :tag)');
    params.tag = query.tag.toLowerCase();
  }
  if (query.q) {
    where.push('(c.name LIKE :q OR c.company LIKE :q OR c.email LIKE :q OR c.service_package LIKE :q OR c.tags LIKE :q OR c.website LIKE :q)');
    params.q = likeParam(query.q);
  }
  const sortCol: Record<string, string> = {
    name: 'c.name COLLATE NOCASE',
    company: 'COALESCE(c.company, c.name) COLLATE NOCASE',
    // Amounts only compare within one currency, so group by currency first.
    retainer: 'c.currency, COALESCE(c.retainer_minor, 0)',
    created: 'c.created_at',
    renewal: "COALESCE(c.renewal_date, '9999-12-31')",
    status: 'c.status',
    activity: "COALESCE(last_activity_at, '')",
  };
  const rows = ctx.db.all<Record<string, unknown>>(
    `SELECT c.*,
            (SELECT COUNT(*) FROM projects p WHERE p.client_id = c.id AND p.archived_at IS NULL
                AND p.status IN ('backlog','editing','internal_review','client_review','revisions','approved')) AS active_projects,
            (SELECT COUNT(*) FROM deliverables d JOIN projects p ON p.id = d.project_id
              WHERE p.client_id = c.id AND d.status <> 'delivered' AND p.archived_at IS NULL AND p.status NOT IN ('on_hold','cancelled')) AS open_deliverables,
            (SELECT MIN(d.deadline) FROM deliverables d JOIN projects p ON p.id = d.project_id
              WHERE p.client_id = c.id AND d.status <> 'delivered' AND d.deadline IS NOT NULL
                AND p.archived_at IS NULL AND p.status NOT IN ('on_hold','cancelled')) AS next_deadline,
            (SELECT MAX(a.created_at) FROM activity a WHERE a.client_id = c.id) AS last_activity_at,
            (SELECT COUNT(*) FROM users u WHERE u.client_id = c.id AND u.disabled = 0) AS portal_users
       FROM clients c
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY ${sortCol[query.sort ?? 'name']} ${query.order === 'desc' ? 'DESC' : 'ASC'}, c.id`,
    params,
  );
  const balances = ctx.db.all<{ client_id: number; currency: string; amount_minor: number }>(
    `SELECT client_id, currency, SUM(balance_minor) AS amount_minor FROM invoice_balances
      WHERE state = 'sent' AND balance_minor > 0 GROUP BY client_id, currency`,
  );
  return rows.map((r) => ({
    ...withJson(r, { tags: [], socials: {} }),
    outstanding: sumByCurrency(balances.filter((b) => b.client_id === r.id)),
  })) as ClientListRow[];
}

export function clientsRouter(ctx: AppContext): Router {
  const r = Router();

  r.get('/', (req, res) => {
    const query = parse(listQuery, req.query);
    const rows = listClients(ctx, query);
    res.json({ clients: canSeeFinance(req) ? rows : rows.map((row) => stripFields(row, FINANCE_FIELDS)) });
  });

  r.get('/tags', (_req, res) => {
    const tags = ctx.db.all<{ tag: string; count: number }>(
      `SELECT j.value AS tag, COUNT(*) AS count FROM clients c, json_each(c.tags) j WHERE c.archived_at IS NULL GROUP BY j.value ORDER BY count DESC, tag`,
    );
    const packages = ctx.db
      .all<{ service_package: string }>(`SELECT DISTINCT service_package FROM clients WHERE service_package IS NOT NULL ORDER BY service_package`)
      .map((p) => p.service_package);
    res.json({ tags, packages });
  });

  r.get('/export.csv', requireAdmin, (_req, res) => {
    const rows = listClients(ctx, { archived: '1', sort: 'name', order: 'asc' });
    const csv = toCsv(rows, [
      { header: 'ID', value: (c) => c.id },
      { header: 'Name', value: (c) => c.name },
      { header: 'Company', value: (c) => c.company },
      { header: 'Email', value: (c) => c.email },
      { header: 'Phone', value: (c) => c.phone },
      { header: 'WhatsApp', value: (c) => c.whatsapp },
      { header: 'Website', value: (c) => c.website },
      { header: 'Country', value: (c) => c.country },
      { header: 'Status', value: (c) => CLIENT_STATUS_LABELS[c.status as keyof typeof CLIENT_STATUS_LABELS] },
      { header: 'Service package', value: (c) => c.service_package },
      { header: 'Retainer', value: (c) => (c.retainer_minor == null ? '' : fromMinor(c.retainer_minor as number, c.currency)) },
      { header: 'Currency', value: (c) => c.currency },
      { header: 'Billing cycle', value: (c) => c.billing_cycle },
      { header: 'Contract start', value: (c) => c.contract_start },
      { header: 'Renewal date', value: (c) => c.renewal_date },
      { header: 'Payment terms (days)', value: (c) => c.payment_terms_days },
      { header: 'Tags', value: (c) => c.tags.join('; ') },
      { header: 'Active projects', value: (c) => c.active_projects },
      { header: 'Outstanding', value: (c) => c.outstanding.map((o) => `${o.currency} ${fromMinor(o.amount_minor, o.currency)}`).join('; ') },
      { header: 'Archived', value: (c) => (c.archived_at ? 'yes' : '') },
      { header: 'Demo data', value: (c) => (c.is_demo ? 'yes' : '') },
    ]);
    sendCsv(ctx, res, 'clients', csv);
  });

  r.post('/', requireAdmin, (req, res) => {
    const body = parse(createSchema, req.body);
    const now = ctx.nowIso();
    const id = ctx.db.tx(() => {
      const id = ctx.db.insert('clients', {
        ...body,
        billing_cycle: body.billing_cycle ?? 'monthly',
        payment_terms_days: body.payment_terms_days ?? ctx.settings().default_payment_terms_days,
        status: body.status ?? 'active',
        created_at: now,
        updated_at: now,
      });
      logActivity(ctx, actorOf(req), { entity_type: 'client', entity_id: id, client_id: id, action: 'created', summary: `Client ${body.company || body.name} added` });
      return id;
    });
    res.status(201).json({ id });
  });

  r.get('/:id', (req, res) => {
    const id = idParam(req);
    const row = ctx.db.get<Record<string, unknown>>('SELECT * FROM clients WHERE id = :id', { id });
    if (!row) throw notFound('Client');
    const client = withJson(row, { tags: [], socials: {} });
    const projects = ctx.db
      .all<Record<string, unknown>>(
        `SELECT p.id, p.name, p.type, p.status, p.priority, p.deadline, p.billing_type, p.price_minor, p.currency, p.is_demo, p.archived_at,
                t.name AS editor_name,
                (SELECT COUNT(*) FROM deliverables d WHERE d.project_id = p.id) AS deliverable_count,
                (SELECT COUNT(*) FROM deliverables d WHERE d.project_id = p.id AND d.status = 'delivered') AS delivered_count
           FROM projects p LEFT JOIN team_members t ON t.id = p.editor_id
          WHERE p.client_id = :id ORDER BY (p.status IN ('delivered','cancelled')), COALESCE(p.deadline, '9999') , p.id DESC`,
        { id },
      )
      .map((p) => (canSeeFinance(req) ? p : stripFields(p, ['price_minor'])));
    const deliverables = ctx.db.all(
      `SELECT d.id, d.title, d.status, d.deadline, d.platform, d.revision_count, d.project_id, p.name AS project_name
         FROM deliverables d JOIN projects p ON p.id = d.project_id
        WHERE p.client_id = :id AND d.status <> 'delivered'
        ORDER BY COALESCE(d.deadline, '9999'), d.id LIMIT 50`,
      { id },
    );
    const portalUsers = ctx.db.all('SELECT id, email, name, disabled, last_login_at, must_change_password, created_at FROM users WHERE client_id = :id ORDER BY id', { id });
    const lead = ctx.db.get('SELECT id, name, source, closed_at FROM leads WHERE client_id = :id ORDER BY id DESC LIMIT 1', { id }) ?? null;
    let finance: unknown = null;
    if (canSeeFinance(req)) {
      const invoices = listInvoices(ctx, { client_id: id });
      const collectedRows = ctx.db.all<{ currency: string; amount_minor: number }>(
        'SELECT currency, SUM(amount_minor) AS amount_minor FROM payments WHERE client_id = :id GROUP BY currency',
        { id },
      );
      finance = {
        invoices,
        collected_lifetime: sumByCurrency(collectedRows),
        outstanding: sumByCurrency(invoices.filter((i) => i.state === 'sent' && i.balance_minor > 0).map((i) => ({ currency: i.currency, amount_minor: i.balance_minor }))),
        overdue: sumByCurrency(invoices.filter((i) => i.status === 'overdue').map((i) => ({ currency: i.currency, amount_minor: i.balance_minor }))),
        invoiced_lifetime: sumByCurrency(invoices.filter((i) => i.state === 'sent').map((i) => ({ currency: i.currency, amount_minor: i.total_minor }))),
      };
    }
    res.json({
      client: canSeeFinance(req) ? client : stripFields(client, FINANCE_FIELDS),
      projects,
      deliverables,
      portal_users: canSeeFinance(req) ? portalUsers : [],
      lead,
      finance,
    });
  });

  r.patch('/:id', requireAdmin, (req, res) => {
    const id = idParam(req);
    const existing = ctx.db.get<{ id: number; status: string; name: string; company: string | null; retainer_minor: number | null; currency: string }>(
      'SELECT id, status, name, company, retainer_minor, currency FROM clients WHERE id = :id',
      { id },
    );
    if (!existing) throw notFound('Client');
    const body = parse(updateSchema, req.body);
    ctx.db.tx(() => {
      ctx.db.update('clients', id, { ...body, updated_at: ctx.nowIso() });
      const label = body.company ?? existing.company ?? body.name ?? existing.name;
      const changes: string[] = [];
      if (body.status && body.status !== existing.status) changes.push(`status ${CLIENT_STATUS_LABELS[existing.status as keyof typeof CLIENT_STATUS_LABELS]} → ${CLIENT_STATUS_LABELS[body.status]}`);
      if (body.retainer_minor !== undefined && body.retainer_minor !== existing.retainer_minor) changes.push('retainer updated');
      logActivity(ctx, actorOf(req), {
        entity_type: 'client',
        entity_id: id,
        client_id: id,
        action: body.status && body.status !== existing.status ? 'status_changed' : 'updated',
        summary: `Client ${label} updated${changes.length ? ` · ${changes.join(', ')}` : ''}`,
      });
    });
    res.json({ ok: true });
  });

  r.post('/:id/archive', requireAdmin, (req, res) => {
    const id = idParam(req);
    const c = ctx.db.get<{ name: string; company: string | null }>('SELECT name, company FROM clients WHERE id = :id', { id });
    if (!c) throw notFound('Client');
    ctx.db.tx(() => {
      ctx.db.run('UPDATE clients SET archived_at = :at, updated_at = :at WHERE id = :id', { at: ctx.nowIso(), id });
      // Archived clients lose portal access immediately.
      ctx.db.run('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE client_id = :id)', { id });
      logActivity(ctx, actorOf(req), { entity_type: 'client', entity_id: id, client_id: id, action: 'archived', summary: `Client ${c.company || c.name} archived` });
    });
    res.json({ ok: true });
  });

  r.post('/:id/restore', requireAdmin, (req, res) => {
    const id = idParam(req);
    const c = ctx.db.get<{ name: string; company: string | null }>('SELECT name, company FROM clients WHERE id = :id', { id });
    if (!c) throw notFound('Client');
    ctx.db.run('UPDATE clients SET archived_at = NULL, updated_at = :at WHERE id = :id', { at: ctx.nowIso(), id });
    logActivity(ctx, actorOf(req), { entity_type: 'client', entity_id: id, client_id: id, action: 'restored', summary: `Client ${c.company || c.name} restored` });
    res.json({ ok: true });
  });

  /** Hard delete is only allowed for clients with no projects, invoices or payments. */
  r.delete('/:id', requireAdmin, (req, res) => {
    const id = idParam(req);
    const c = ctx.db.get<{ name: string; company: string | null }>('SELECT name, company FROM clients WHERE id = :id', { id });
    if (!c) throw notFound('Client');
    const refs = ctx.db.get<{ p: number; i: number }>(
      'SELECT (SELECT COUNT(*) FROM projects WHERE client_id = :id) AS p, (SELECT COUNT(*) FROM invoices WHERE client_id = :id) AS i',
      { id },
    )!;
    if (refs.p > 0 || refs.i > 0) throw conflict('This client has projects or invoices. Archive the client instead, so your history stays intact.');
    ctx.db.tx(() => {
      ctx.db.run('DELETE FROM clients WHERE id = :id', { id });
      logActivity(ctx, actorOf(req), { entity_type: 'client', entity_id: id, client_id: null, action: 'deleted', summary: `Client ${c.company || c.name} deleted` });
    });
    res.json({ ok: true });
  });

  r.get('/:id/timeline', (req, res) => {
    const id = idParam(req);
    if (!ctx.db.get('SELECT 1 FROM clients WHERE id = :id', { id })) throw notFound('Client');
    const finance = canSeeFinance(req);
    const activity = ctx.db.all<Record<string, unknown>>(
      `SELECT id, 'activity' AS kind, entity_type, entity_id, action, summary, actor_type, actor_name, created_at AS at
         FROM activity WHERE client_id = :id ${finance ? '' : "AND entity_type NOT IN ('invoice','payment')"}
        ORDER BY created_at DESC LIMIT 150`,
      { id },
    );
    const comms = ctx.db.all<Record<string, unknown>>(
      `SELECT c.id, 'communication' AS kind, c.channel, c.direction, c.subject, c.body, c.occurred_at, u.name AS actor_name,
              c.occurred_at || 'T12:00:00.000Z' AS at, c.created_at
         FROM communications c LEFT JOIN users u ON u.id = c.created_by
        WHERE c.client_id = :id ORDER BY c.occurred_at DESC, c.id DESC LIMIT 150`,
      { id },
    );
    const items = [...activity, ...comms].sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 200);
    res.json({ items });
  });

  r.post('/:id/communications', (req, res) => {
    const id = idParam(req);
    const c = ctx.db.get<{ name: string; company: string | null; is_demo: number }>('SELECT name, company, is_demo FROM clients WHERE id = :id', { id });
    if (!c) throw notFound('Client');
    const body = parse(commSchema, req.body);
    const commId = ctx.db.insert('communications', {
      client_id: id,
      channel: body.channel,
      direction: body.direction ?? 'outbound',
      subject: body.subject,
      body: body.body,
      occurred_at: body.occurred_at,
      created_by: req.user!.id,
      created_at: ctx.nowIso(),
    });
    res.status(201).json({ id: commId });
  });

  r.delete('/:id/communications/:commId', (req, res) => {
    const id = idParam(req);
    const commId = idParam(req, 'commId');
    const changes = ctx.db.run('DELETE FROM communications WHERE id = :commId AND client_id = :id', { id, commId }).changes;
    if (!changes) throw notFound('Log entry');
    res.json({ ok: true });
  });

  return r;
}
