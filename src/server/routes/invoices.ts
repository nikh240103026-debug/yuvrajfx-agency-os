import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../context.ts';
import { badRequest, idParam, notFound, parse } from '../lib/http.ts';
import { actorOf } from '../lib/activity.ts';
import { toCsv } from '../lib/csv.ts';
import { currencyCode, foreignKey, optionalText, qInt, qStr, requiredDate, requiredForeignKey, requiredText } from '../lib/validation.ts';
import { likeParam, sendCsv } from './common.ts';
import {
  createInvoice,
  createRetainerDrafts,
  deleteInvoice,
  deletePayment,
  duplicateInvoice,
  getInvoice,
  listInvoices,
  markInvoiceSent,
  previewNextNumber,
  recordPayment,
  retainerDraftPreview,
  revertInvoiceToDraft,
  updateInvoice,
  voidInvoice,
  type InvoiceInput,
} from '../services/invoices.ts';
import { draftInvoiceEmail } from '../services/automations.ts';
import { DISCOUNT_TYPES, INVOICE_STATUS_LABELS, PAYMENT_METHODS, PAYMENT_METHOD_LABELS, SERVICE_TYPES } from '../../shared/constants.ts';
import { fromMinor, sumByCurrency } from '../../shared/money.ts';
import { monthKey } from '../../shared/dates.ts';

const itemSchema = z.object({
  description: requiredText(500),
  quantity: z.number({ error: 'Enter a quantity.' }).positive('Quantity must be more than zero.').max(100_000),
  unit_price_minor: z.number({ error: 'Enter a rate.' }).int().min(0, 'Rates cannot be negative.').max(1e13),
  service_type: z.enum(SERVICE_TYPES).optional(),
});

const invoiceSchema = z.object({
  number: z
    .string()
    .trim()
    .max(40)
    .regex(/^[A-Za-z0-9._/#-]*$/, 'Use letters, numbers and - _ . / # only.')
    .nullish(),
  client_id: requiredForeignKey('client'),
  project_id: foreignKey(),
  currency: currencyCode(),
  issue_date: requiredDate(),
  due_date: requiredDate(),
  period_start: z.string().nullish(),
  period_end: z.string().nullish(),
  discount_type: z.enum(DISCOUNT_TYPES).optional(),
  discount_percent: z.number().min(0).max(100).optional(),
  discount_fixed_minor: z.number().int().min(0).max(1e13).optional(),
  taxes: z
    .array(z.object({ label: requiredText(40), rate: z.number().min(0, 'Tax rates cannot be negative.').max(100) }))
    .max(4)
    .optional(),
  notes: optionalText(5000),
  terms: optionalText(5000),
  internal_notes: optionalText(5000),
  portal_visible: z.boolean().optional(),
  items: z.array(itemSchema).min(1, 'Add at least one line item.').max(200),
});

const paymentSchema = z.object({
  amount_minor: z.number({ error: 'Enter the amount received.' }).int().positive('Amount must be more than zero.'),
  paid_at: requiredDate(),
  method: z.enum(PAYMENT_METHODS),
  reference: optionalText(200),
  notes: optionalText(2000),
});

const listQuery = z.object({
  q: qStr(),
  status: qStr(),
  client_id: qInt(),
  project_id: qInt(),
  currency: qStr(),
  from: qStr(),
  to: qStr(),
});

function toInput(body: z.output<typeof invoiceSchema>): InvoiceInput {
  return {
    number: body.number ?? null,
    client_id: body.client_id,
    project_id: body.project_id,
    currency: body.currency,
    issue_date: body.issue_date,
    due_date: body.due_date,
    period_start: body.period_start ?? null,
    period_end: body.period_end ?? null,
    discount_type: body.discount_type ?? 'none',
    discount_percent: body.discount_percent ?? 0,
    discount_fixed_minor: body.discount_fixed_minor ?? 0,
    taxes: body.taxes ?? [],
    notes: body.notes,
    terms: body.terms,
    internal_notes: body.internal_notes,
    portal_visible: body.portal_visible === undefined ? undefined : body.portal_visible ? 1 : 0,
    items: body.items.map((it) => ({ ...it, service_type: it.service_type ?? 'other' })),
  };
}

export function invoicesRouter(ctx: AppContext): Router {
  const r = Router();

  r.get('/', async (req, res) => {
    const q = parse(listQuery, req.query);
    const invoices = await listInvoices(ctx, q);
    const open = invoices.filter((i) => i.state === 'sent' && i.balance_minor > 0);
    res.json({
      invoices,
      totals: {
        outstanding: sumByCurrency(open.map((i) => ({ currency: i.currency, amount_minor: i.balance_minor })), (await ctx.settings()).base_currency),
        overdue: sumByCurrency(open.filter((i) => i.status === 'overdue').map((i) => ({ currency: i.currency, amount_minor: i.balance_minor })), (await ctx.settings()).base_currency),
        drafts: invoices.filter((i) => i.state === 'draft').length,
      },
    });
  });

  r.get('/meta', async (_req, res) => {
    const s = await ctx.settings();
    res.json({
      next_number: await previewNextNumber(ctx),
      default_taxes: s.default_taxes,
      default_terms: s.default_invoice_terms,
      default_payment_terms_days: s.default_payment_terms_days,
      today: await ctx.today(),
    });
  });

  r.get('/export.csv', async (req, res) => {
    const q = parse(listQuery, req.query);
    const rows = await listInvoices(ctx, q);
    const csv = toCsv(rows, [
      { header: 'Invoice', value: (i) => i.number },
      { header: 'Client', value: (i) => i.client_company || i.client_name },
      { header: 'Project', value: (i) => i.project_name },
      { header: 'Kind', value: (i) => i.kind },
      { header: 'Issue date', value: (i) => i.issue_date },
      { header: 'Due date', value: (i) => i.due_date },
      { header: 'Status', value: (i) => INVOICE_STATUS_LABELS[i.status] },
      { header: 'Currency', value: (i) => i.currency },
      { header: 'Total', value: (i) => fromMinor(i.total_minor, i.currency) },
      { header: 'Paid', value: (i) => fromMinor(i.paid_minor, i.currency) },
      { header: 'Balance', value: (i) => fromMinor(i.balance_minor, i.currency) },
      { header: 'Days overdue', value: (i) => i.days_overdue || '' },
      { header: 'Last payment', value: (i) => i.last_paid_at },
      { header: 'Demo data', value: (i) => (i.is_demo ? 'yes' : '') },
    ]);
    await sendCsv(ctx, res, 'invoices', csv);
  });

  r.get('/retainer-drafts', async (req, res) => {
    const month = typeof req.query.month === 'string' && /^\d{4}-\d{2}$/.test(req.query.month) ? req.query.month : monthKey(await ctx.today());
    res.json({ month, clients: await retainerDraftPreview(ctx, month) });
  });

  r.post('/retainer-drafts', async (req, res) => {
    const body = parse(z.object({ month: z.string().regex(/^\d{4}-\d{2}$/), client_ids: z.array(z.number().int().positive()).optional() }), req.body);
    const ids = await createRetainerDrafts(ctx, actorOf(req), body.month, body.client_ids);
    res.status(201).json({ ids });
  });

  r.post('/', async (req, res) => {
    const body = parse(invoiceSchema, req.body);
    const id = await createInvoice(ctx, actorOf(req), toInput(body));
    res.status(201).json({ id, invoice: await getInvoice(ctx, id) });
  });

  r.get('/:id', async (req, res) => {
    const invoice = await getInvoice(ctx, idParam(req));
    if (!invoice) throw notFound('Invoice');
    res.json({ invoice, business: await businessProfile(ctx) });
  });

  r.put('/:id', async (req, res) => {
    const id = idParam(req);
    const body = parse(invoiceSchema, req.body);
    await updateInvoice(ctx, actorOf(req), id, toInput(body));
    res.json({ invoice: await getInvoice(ctx, id) });
  });

  r.post('/:id/send', async (req, res) => {
    const id = idParam(req);
    await markInvoiceSent(ctx, actorOf(req), id);
    res.json({ invoice: await getInvoice(ctx, id) });
  });

  r.post('/:id/revert-to-draft', async (req, res) => {
    const id = idParam(req);
    await revertInvoiceToDraft(ctx, actorOf(req), id);
    res.json({ invoice: await getInvoice(ctx, id) });
  });

  r.post('/:id/void', async (req, res) => {
    const id = idParam(req);
    const body = parse(z.object({ reason: optionalText(500) }), req.body ?? {});
    await voidInvoice(ctx, actorOf(req), id, body.reason);
    res.json({ invoice: await getInvoice(ctx, id) });
  });

  r.post('/:id/duplicate', async (req, res) => {
    const id = await duplicateInvoice(ctx, actorOf(req), idParam(req));
    res.status(201).json({ id });
  });

  /** Drafts a reminder/cover email into the outbox for approval. Nothing is sent from here. */
  r.post('/:id/draft-email', async (req, res) => {
    const id = idParam(req);
    const body = parse(z.object({ purpose: z.enum(['send', 'reminder']) }), req.body);
    const outboxId = await draftInvoiceEmail(ctx, id, body.purpose, 'manual');
    if (!outboxId) throw badRequest('This client has no email address. Add one on the client page first.');
    res.status(201).json({ outbox_id: outboxId });
  });

  r.delete('/:id', async (req, res) => {
    await deleteInvoice(ctx, actorOf(req), idParam(req));
    res.json({ ok: true });
  });

  r.post('/:id/payments', async (req, res) => {
    const id = idParam(req);
    const body = parse(paymentSchema, req.body);
    const result = await recordPayment(ctx, actorOf(req), id, body);
    res.status(201).json({ payment_id: result.id, status: result.status, balance_minor: result.balance_minor, invoice: await getInvoice(ctx, id) });
  });

  return r;
}

export async function businessProfile(ctx: AppContext) {
  const s = await ctx.settings();
  return {
    name: s.business_name,
    email: s.business_email,
    phone: s.business_phone,
    address: s.business_address,
    website: s.business_website,
    tax_id_label: s.tax_id_label,
    tax_id: s.tax_id,
    payment_instructions: s.payment_instructions,
    footer: s.invoice_footer,
  };
}

export function paymentsRouter(ctx: AppContext): Router {
  const r = Router();
  const query = z.object({ q: qStr(), client_id: qInt(), method: qStr(), currency: qStr(), from: qStr(), to: qStr() });

  async function list(q: z.output<typeof query>) {
    const where: string[] = ['1 = 1'];
    const params: Record<string, unknown> = {};
    if (q.client_id) {
      where.push('p.client_id = :client_id');
      params.client_id = q.client_id;
    }
    if (q.method) {
      where.push('p.method = :method');
      params.method = q.method;
    }
    if (q.currency) {
      where.push('p.currency = :currency');
      params.currency = q.currency;
    }
    if (q.from) {
      where.push('p.paid_at >= :from');
      params.from = q.from;
    }
    if (q.to) {
      where.push('p.paid_at <= :to');
      params.to = q.to;
    }
    if (q.q) {
      where.push('(i.number LIKE :q OR c.name LIKE :q OR c.company LIKE :q OR p.reference LIKE :q OR p.notes LIKE :q)');
      params.q = likeParam(q.q);
    }
    return ctx.db.all<{ id: number; invoice_id: number; number: string; client_id: number; client_name: string; amount_minor: number; currency: string; paid_at: string; method: string; reference: string | null; notes: string | null; is_demo: number; recorded_by: string | null }>(
      `SELECT p.id, p.invoice_id, i.number, p.client_id, COALESCE(c.company, c.name) AS client_name, p.amount_minor, p.currency, p.paid_at,
              p.method, p.reference, p.notes, p.is_demo, u.name AS recorded_by
         FROM payments p JOIN invoices i ON i.id = p.invoice_id JOIN clients c ON c.id = p.client_id LEFT JOIN users u ON u.id = p.created_by
        WHERE ${where.join(' AND ')}
        ORDER BY p.paid_at DESC, p.id DESC`,
      params,
    );
  }

  r.get('/', async (req, res) => {
    const rows = await list(parse(query, req.query));
    res.json({ payments: rows, totals: sumByCurrency(rows, (await ctx.settings()).base_currency) });
  });

  r.get('/export.csv', async (req, res) => {
    const rows = await list(parse(query, req.query));
    const csv = toCsv(rows, [
      { header: 'Date', value: (p) => p.paid_at },
      { header: 'Invoice', value: (p) => p.number },
      { header: 'Client', value: (p) => p.client_name },
      { header: 'Currency', value: (p) => p.currency },
      { header: 'Amount', value: (p) => fromMinor(p.amount_minor, p.currency) },
      { header: 'Method', value: (p) => PAYMENT_METHOD_LABELS[p.method as keyof typeof PAYMENT_METHOD_LABELS] ?? p.method },
      { header: 'Reference', value: (p) => p.reference },
      { header: 'Notes', value: (p) => p.notes },
      { header: 'Recorded by', value: (p) => p.recorded_by },
      { header: 'Demo data', value: (p) => (p.is_demo ? 'yes' : '') },
    ]);
    await sendCsv(ctx, res, 'payments', csv);
  });

  r.delete('/:id', async (req, res) => {
    await deletePayment(ctx, actorOf(req), idParam(req));
    res.json({ ok: true });
  });

  return r;
}
