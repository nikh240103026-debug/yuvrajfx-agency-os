import type { AppContext } from '../context.ts';
import type { Actor } from '../lib/activity.ts';
import { logActivity } from '../lib/activity.ts';
import { json } from '../db/db.ts';
import { badRequest, conflict, notFound, translateDbError } from '../lib/http.ts';
import { writeSettings } from '../lib/settings.ts';
import { computeInvoiceTotals, formatMoney, type TaxLine } from '../../shared/money.ts';
import { addDays, addMonths, diffDays, endOfMonth, monthLabel } from '../../shared/dates.ts';
import type { DiscountType, InvoiceStatus, PaymentMethod, ServiceType } from '../../shared/constants.ts';
import { BILLING_CYCLE_MONTHS, INVOICE_STATUS_LABELS } from '../../shared/constants.ts';

/** Derived invoice status. Paid only when recorded payments cover the total; needs :today bound. */
export function invoiceStatusSql(alias = 'b'): string {
  return `CASE
    WHEN ${alias}.state = 'void' THEN 'void'
    WHEN ${alias}.state = 'draft' THEN 'draft'
    WHEN ${alias}.balance_minor <= 0 THEN 'paid'
    WHEN ${alias}.due_date < :today THEN 'overdue'
    WHEN ${alias}.paid_minor > 0 THEN 'partially_paid'
    ELSE 'sent' END`;
}

export type InvoiceItemInput = {
  description: string;
  quantity: number;
  unit_price_minor: number;
  service_type: ServiceType;
};

export type InvoiceInput = {
  number?: string | null;
  client_id: number;
  project_id: number | null;
  kind?: 'standard' | 'retainer';
  currency: string;
  issue_date: string;
  due_date: string;
  period_start?: string | null;
  period_end?: string | null;
  discount_type: DiscountType;
  discount_percent: number;
  discount_fixed_minor: number;
  taxes: TaxLine[];
  notes: string | null;
  terms: string | null;
  internal_notes: string | null;
  portal_visible?: number;
  items: InvoiceItemInput[];
};

export type InvoiceListRow = {
  id: number;
  number: string;
  client_id: number;
  client_name: string;
  client_company: string | null;
  project_id: number | null;
  project_name: string | null;
  kind: string;
  currency: string;
  issue_date: string;
  due_date: string;
  state: string;
  status: InvoiceStatus;
  total_minor: number;
  paid_minor: number;
  balance_minor: number;
  last_paid_at: string | null;
  sent_at: string | null;
  is_demo: number;
  days_overdue: number;
};

export type InvoiceFilters = {
  q?: string;
  status?: string;
  client_id?: number;
  project_id?: number;
  currency?: string;
  from?: string;
  to?: string;
  portal_only?: boolean;
};

export async function listInvoices(ctx: AppContext, f: InvoiceFilters = {}): Promise<InvoiceListRow[]> {
  const today = await ctx.today();
  const where: string[] = ['1 = 1'];
  const params: Record<string, unknown> = { today };
  if (f.client_id) {
    where.push('b.client_id = :client_id');
    params.client_id = f.client_id;
  }
  if (f.project_id) {
    where.push('b.project_id = :project_id');
    params.project_id = f.project_id;
  }
  if (f.currency) {
    where.push('b.currency = :currency');
    params.currency = f.currency;
  }
  if (f.from) {
    where.push('b.issue_date >= :from');
    params.from = f.from;
  }
  if (f.to) {
    where.push('b.issue_date <= :to');
    params.to = f.to;
  }
  if (f.portal_only) where.push(`b.state <> 'draft' AND b.portal_visible = 1`);
  if (f.q) {
    where.push(`(b.number LIKE :q OR c.name LIKE :q OR c.company LIKE :q OR p.name LIKE :q OR b.notes LIKE :q)`);
    params.q = `%${f.q}%`;
  }
  const rows = await ctx.db.all<InvoiceListRow>(
    `SELECT b.id, b.number, b.client_id, c.name AS client_name, c.company AS client_company, b.project_id, p.name AS project_name,
            b.kind, b.currency, b.issue_date, b.due_date, b.state, ${invoiceStatusSql('b')} AS status,
            b.total_minor, b.paid_minor, b.balance_minor, b.last_paid_at, b.sent_at, b.is_demo
       FROM invoice_balances b
       JOIN clients c ON c.id = b.client_id
       LEFT JOIN projects p ON p.id = b.project_id
      WHERE ${where.join(' AND ')}
      ORDER BY b.issue_date DESC, b.id DESC`,
    params,
  );
  const out = rows.map((r) => ({ ...r, days_overdue: r.status === 'overdue' ? diffDays(r.due_date, today) : 0 }));
  if (f.status) return out.filter((r) => (f.status === 'open' ? ['sent', 'partially_paid', 'overdue'].includes(r.status) : r.status === f.status));
  return out;
}

type InvoiceRow = InvoiceListRow & {
  taxes: string;
  period_start: string | null;
  period_end: string | null;
  discount_type: DiscountType;
  discount_percent: number;
  discount_fixed_minor: number;
  subtotal_minor: number;
  discount_minor: number;
  tax_minor: number;
  notes: string | null;
  terms: string | null;
  internal_notes: string | null;
  voided_at: string | null;
  void_reason: string | null;
  portal_visible: number;
  payment_count: number;
  created_at: string;
  updated_at: string;
};

export async function getInvoice(ctx: AppContext, id: number) {
  const today = await ctx.today();
  const inv = await ctx.db.get<InvoiceRow>(
    `SELECT b.*, ${invoiceStatusSql('b')} AS status FROM invoice_balances b WHERE b.id = :id`,
    { id, today },
  );
  if (!inv) return null;
  const items = await ctx.db.all<{ id: number; description: string; quantity: number; unit_price_minor: number; amount_minor: number; service_type: string; sort_order: number }>(
    'SELECT id, description, quantity, unit_price_minor, amount_minor, service_type, sort_order FROM invoice_items WHERE invoice_id = :id ORDER BY sort_order, id',
    { id },
  );
  const payments = await ctx.db.all(
    `SELECT p.id, p.amount_minor, p.currency, p.paid_at, p.method, p.reference, p.notes, p.created_at, u.name AS recorded_by
       FROM payments p LEFT JOIN users u ON u.id = p.created_by
      WHERE p.invoice_id = :id ORDER BY p.paid_at, p.id`,
    { id },
  );
  const client = await ctx.db.get(
    'SELECT id, name, company, email, phone, billing_address, tax_id, country, currency, payment_terms_days, is_demo FROM clients WHERE id = :id',
    { id: inv.client_id },
  );
  const project = inv.project_id ? await ctx.db.get('SELECT id, name, type FROM projects WHERE id = :id', { id: inv.project_id }) : null;
  const taxes = json<TaxLine[]>(inv.taxes, []);
  const totals = computeInvoiceTotals({
    items,
    discount_type: inv.discount_type as DiscountType,
    discount_percent: inv.discount_percent as number,
    discount_fixed_minor: inv.discount_fixed_minor as number,
    taxes,
  });
  return {
    ...inv,
    taxes,
    tax_lines: totals.tax_lines,
    taxable_minor: totals.taxable_minor,
    items,
    payments,
    client,
    project,
    days_overdue: inv.status === 'overdue' ? diffDays(inv.due_date, today) : 0,
  };
}

async function nextNumber(ctx: AppContext): Promise<{ number: string; seq: number }> {
  const s = await ctx.settings();
  let seq = Math.max(1, Math.floor(s.invoice_next_number || 1));
  for (let i = 0; i < 100_000; i++, seq++) {
    const number = `${s.invoice_prefix}${String(seq).padStart(Math.min(Math.max(s.invoice_number_padding, 1), 8), '0')}`;
    if (!await ctx.db.get('SELECT 1 FROM invoices WHERE number = :number', { number })) return { number, seq };
  }
  throw conflict('Could not allocate an invoice number. Check the numbering settings.');
}

export async function previewNextNumber(ctx: AppContext): Promise<string> {
  return (await nextNumber(ctx)).number;
}

async function validateRefs(ctx: AppContext, input: InvoiceInput): Promise<void> {
  const client = await ctx.db.get<{ id: number; archived_at: string | null }>('SELECT id, archived_at FROM clients WHERE id = :id', { id: input.client_id });
  if (!client) throw badRequest('Pick an existing client.');
  if (input.project_id) {
    const project = await ctx.db.get<{ client_id: number }>('SELECT client_id FROM projects WHERE id = :id', { id: input.project_id });
    if (!project) throw badRequest('That project no longer exists.');
    if (project.client_id !== input.client_id) throw badRequest('That project belongs to a different client.');
  }
  if (input.items.length === 0) throw badRequest('Add at least one line item.');
  if (input.due_date < input.issue_date) throw badRequest('The due date cannot be before the issue date.');
  if (input.discount_type === 'percent' && (input.discount_percent < 0 || input.discount_percent > 100)) {
    throw badRequest('Discount percent must be between 0 and 100.');
  }
}

async function writeItems(ctx: AppContext, invoiceId: number, items: InvoiceItemInput[], amounts: { amount_minor: number }[]): Promise<void> {
  await ctx.db.run('DELETE FROM invoice_items WHERE invoice_id = :id', { id: invoiceId });
  for (const [idx, it] of items.entries()) {
    await ctx.db.insert('invoice_items', {
      invoice_id: invoiceId,
      description: it.description,
      quantity: it.quantity,
      unit_price_minor: it.unit_price_minor,
      amount_minor: amounts[idx].amount_minor,
      service_type: it.service_type,
      sort_order: idx,
    });
  }
}

export async function createInvoice(ctx: AppContext, actor: Actor, input: InvoiceInput, opts: { is_demo?: number } = {}): Promise<number> {
  await validateRefs(ctx, input);
  const totals = computeInvoiceTotals(input);
  return ctx.db.tx(async () => {
    let number = input.number?.trim() || null;
    let seq: number | null = null;
    if (!number) ({ number, seq } = await nextNumber(ctx));
    const now = ctx.nowIso();
    let id: number;
    try {
      id = await ctx.db.insert('invoices', {
        number,
        client_id: input.client_id,
        project_id: input.project_id,
        kind: input.kind ?? 'standard',
        currency: input.currency,
        issue_date: input.issue_date,
        due_date: input.due_date,
        period_start: input.period_start ?? null,
        period_end: input.period_end ?? null,
        state: 'draft',
        discount_type: input.discount_type,
        discount_percent: input.discount_type === 'percent' ? input.discount_percent : 0,
        discount_fixed_minor: input.discount_type === 'fixed' ? input.discount_fixed_minor : 0,
        taxes: input.taxes,
        subtotal_minor: totals.subtotal_minor,
        discount_minor: totals.discount_minor,
        tax_minor: totals.tax_minor,
        total_minor: totals.total_minor,
        notes: input.notes,
        terms: input.terms,
        internal_notes: input.internal_notes,
        portal_visible: input.portal_visible ?? 1,
        is_demo: opts.is_demo ?? 0,
        created_at: now,
        updated_at: now,
      });
    } catch (err) {
      translateDbError(err);
    }
    await writeItems(ctx, id, input.items, totals.lines);
    if (seq !== null) {
      await writeSettings(ctx.db, { invoice_next_number: seq + 1 });
      ctx.invalidateSettings();
    }
    await logActivity(ctx, actor, {
      entity_type: 'invoice',
      entity_id: id,
      client_id: input.client_id,
      project_id: input.project_id,
      action: 'created',
      summary: `Invoice ${number} drafted for ${formatMoney(totals.total_minor, input.currency, { decimals: 'always' })}`,
      is_demo: opts.is_demo,
    });
    return id;
  });
}

export async function updateInvoice(ctx: AppContext, actor: Actor, id: number, input: InvoiceInput): Promise<void> {
  const existing = await ctx.db.get<{ id: number; state: string; number: string; client_id: number }>('SELECT id, state, number, client_id FROM invoices WHERE id = :id', { id });
  if (!existing) throw notFound('Invoice');
  if (existing.state === 'void') throw conflict('Void invoices cannot be edited.');
  await validateRefs(ctx, input);
  const totals = computeInvoiceTotals(input);
  await ctx.db.tx(async () => {
    try {
      await ctx.db.update('invoices', id, {
        number: input.number?.trim() || existing.number,
        client_id: input.client_id,
        project_id: input.project_id,
        currency: input.currency,
        issue_date: input.issue_date,
        due_date: input.due_date,
        period_start: input.period_start ?? null,
        period_end: input.period_end ?? null,
        discount_type: input.discount_type,
        discount_percent: input.discount_type === 'percent' ? input.discount_percent : 0,
        discount_fixed_minor: input.discount_type === 'fixed' ? input.discount_fixed_minor : 0,
        taxes: input.taxes,
        subtotal_minor: totals.subtotal_minor,
        discount_minor: totals.discount_minor,
        tax_minor: totals.tax_minor,
        total_minor: totals.total_minor,
        notes: input.notes,
        terms: input.terms,
        internal_notes: input.internal_notes,
        portal_visible: input.portal_visible,
        updated_at: ctx.nowIso(),
      });
    } catch (err) {
      translateDbError(err);
    }
    await writeItems(ctx, id, input.items, totals.lines);
    await logActivity(ctx, actor, {
      entity_type: 'invoice',
      entity_id: id,
      client_id: input.client_id,
      project_id: input.project_id,
      action: 'updated',
      summary: `Invoice ${input.number?.trim() || existing.number} updated${existing.state === 'sent' ? ' after sending' : ''} · total ${formatMoney(totals.total_minor, input.currency, { decimals: 'always' })}`,
    });
  });
}

/** Records that the owner sent the invoice themselves. Nothing is emailed from here. */
export async function markInvoiceSent(ctx: AppContext, actor: Actor, id: number): Promise<void> {
  const inv = await ctx.db.get<{ state: string; number: string; client_id: number; project_id: number | null; total_minor: number; is_demo: number }>(
    'SELECT state, number, client_id, project_id, total_minor, is_demo FROM invoices WHERE id = :id',
    { id },
  );
  if (!inv) throw notFound('Invoice');
  if (inv.state === 'void') throw conflict('Void invoices cannot be sent.');
  if (inv.state === 'sent') return;
  await ctx.db.tx(async () => {
    await ctx.db.run('UPDATE invoices SET state = :state, sent_at = :at, updated_at = :at WHERE id = :id', { state: 'sent', at: ctx.nowIso(), id });
    await logActivity(ctx, actor, {
      entity_type: 'invoice',
      entity_id: id,
      client_id: inv.client_id,
      project_id: inv.project_id,
      action: 'sent',
      summary: `Invoice ${inv.number} marked as sent`,
      is_demo: inv.is_demo,
    });
  });
}

export async function revertInvoiceToDraft(ctx: AppContext, actor: Actor, id: number): Promise<void> {
  const inv = await ctx.db.get<{ state: string; number: string; client_id: number }>('SELECT state, number, client_id FROM invoices WHERE id = :id', { id });
  if (!inv) throw notFound('Invoice');
  if (inv.state !== 'sent') throw conflict('Only sent invoices can go back to draft.');
  await ctx.db.tx(async () => {
    try {
      await ctx.db.run(`UPDATE invoices SET state = 'draft', sent_at = NULL, updated_at = :at WHERE id = :id`, { at: ctx.nowIso(), id });
    } catch (err) {
      translateDbError(err);
    }
    await logActivity(ctx, actor, { entity_type: 'invoice', entity_id: id, client_id: inv.client_id, action: 'reverted', summary: `Invoice ${inv.number} moved back to draft` });
  });
}

export async function voidInvoice(ctx: AppContext, actor: Actor, id: number, reason: string | null): Promise<void> {
  const inv = await ctx.db.get<{ state: string; number: string; client_id: number }>('SELECT state, number, client_id FROM invoices WHERE id = :id', { id });
  if (!inv) throw notFound('Invoice');
  if (inv.state === 'void') return;
  await ctx.db.tx(async () => {
    try {
      await ctx.db.run(`UPDATE invoices SET state = 'void', voided_at = :at, void_reason = :reason, updated_at = :at WHERE id = :id`, { at: ctx.nowIso(), reason, id });
    } catch (err) {
      translateDbError(err);
    }
    await logActivity(ctx, actor, { entity_type: 'invoice', entity_id: id, client_id: inv.client_id, action: 'voided', summary: `Invoice ${inv.number} voided${reason ? `: ${reason}` : ''}` });
  });
}

export async function deleteInvoice(ctx: AppContext, actor: Actor, id: number): Promise<void> {
  const inv = await ctx.db.get<{ state: string; number: string; client_id: number }>('SELECT state, number, client_id FROM invoices WHERE id = :id', { id });
  if (!inv) throw notFound('Invoice');
  if (inv.state !== 'draft') throw conflict('Only drafts can be deleted. Void a sent invoice instead, so your records stay complete.');
  if (await ctx.db.get('SELECT 1 FROM payments WHERE invoice_id = :id', { id })) throw conflict('This draft has payments recorded.');
  await ctx.db.tx(async () => {
    await ctx.db.run('DELETE FROM invoices WHERE id = :id', { id });
    await logActivity(ctx, actor, { entity_type: 'invoice', entity_id: id, client_id: inv.client_id, action: 'deleted', summary: `Draft invoice ${inv.number} deleted` });
  });
}

export async function duplicateInvoice(ctx: AppContext, actor: Actor, id: number): Promise<number> {
  const inv = await getInvoice(ctx, id);
  if (!inv) throw notFound('Invoice');
  const today = await ctx.today();
  const terms = (inv.client as { payment_terms_days?: number } | undefined)?.payment_terms_days ?? (await ctx.settings()).default_payment_terms_days;
  return createInvoice(ctx, actor, {
    client_id: inv.client_id,
    project_id: inv.project_id,
    kind: 'standard',
    currency: inv.currency,
    issue_date: today,
    due_date: addDays(today, terms),
    discount_type: inv.discount_type as DiscountType,
    discount_percent: inv.discount_percent as number,
    discount_fixed_minor: inv.discount_fixed_minor as number,
    taxes: inv.taxes,
    notes: inv.notes as string | null,
    terms: inv.terms as string | null,
    internal_notes: null,
    items: inv.items.map((it) => ({
      description: it.description,
      quantity: it.quantity,
      unit_price_minor: it.unit_price_minor,
      service_type: it.service_type as ServiceType,
    })),
  });
}

export type PaymentInput = {
  amount_minor: number;
  paid_at: string;
  method: PaymentMethod;
  reference: string | null;
  notes: string | null;
};

/**
 * Record a (partial or full) payment. The invoice only becomes "paid" when payments cover the total;
 * overpayment is refused here and again by a database trigger.
 */
export async function recordPayment(ctx: AppContext, actor: Actor, invoiceId: number, input: PaymentInput, opts: { is_demo?: number } = {}): Promise<{ id: number; status: InvoiceStatus; balance_minor: number }> {
  const inv = await ctx.db.get<{ id: number; number: string; state: string; currency: string; client_id: number; project_id: number | null; total_minor: number; paid_minor: number; balance_minor: number; issue_date: string; is_demo: number }>(
    'SELECT id, number, state, currency, client_id, project_id, total_minor, paid_minor, balance_minor, issue_date, is_demo FROM invoice_balances WHERE id = :id',
    { id: invoiceId },
  );
  if (!inv) throw notFound('Invoice');
  if (inv.state === 'void') throw conflict('Payments cannot be recorded on a void invoice.');
  if (inv.balance_minor <= 0) throw conflict('This invoice is already fully paid.');
  if (input.amount_minor <= 0) throw badRequest('Payment amount must be more than zero.');
  if (input.amount_minor > inv.balance_minor) {
    throw conflict(
      `That payment (${formatMoney(input.amount_minor, inv.currency, { decimals: 'always' })}) is more than the outstanding balance of ${formatMoney(inv.balance_minor, inv.currency, { decimals: 'always' })}.`,
    );
  }
  if (input.paid_at > await ctx.today()) throw badRequest('The payment date cannot be in the future.');
  return ctx.db.tx(async () => {
    if (inv.state === 'draft') {
      await ctx.db.run(`UPDATE invoices SET state = 'sent', sent_at = COALESCE(sent_at, :at), updated_at = :at WHERE id = :id`, { at: ctx.nowIso(), id: invoiceId });
      await logActivity(ctx, actor, {
        entity_type: 'invoice',
        entity_id: invoiceId,
        client_id: inv.client_id,
        action: 'sent',
        summary: `Invoice ${inv.number} marked as sent (a payment was recorded)`,
        is_demo: opts.is_demo ?? inv.is_demo,
      });
    }
    let id: number;
    try {
      id = await ctx.db.insert('payments', {
        invoice_id: invoiceId,
        client_id: inv.client_id,
        amount_minor: input.amount_minor,
        currency: inv.currency,
        paid_at: input.paid_at,
        method: input.method,
        reference: input.reference,
        notes: input.notes,
        created_by: actor.type === 'user' ? actor.id : null,
        is_demo: opts.is_demo ?? inv.is_demo,
        created_at: ctx.nowIso(),
      });
    } catch (err) {
      translateDbError(err);
    }
    const after = await ctx.db.get<{ status: InvoiceStatus; balance_minor: number }>(
      `SELECT ${invoiceStatusSql('b')} AS status, b.balance_minor FROM invoice_balances b WHERE b.id = :id`,
      { id: invoiceId, today: await ctx.today() },
    )!;
    await logActivity(ctx, actor, {
      entity_type: 'payment',
      entity_id: id,
      client_id: inv.client_id,
      project_id: inv.project_id,
      action: 'payment_recorded',
      summary: `Payment of ${formatMoney(input.amount_minor, inv.currency, { decimals: 'always' })} recorded on ${inv.number} · now ${INVOICE_STATUS_LABELS[after.status].toLowerCase()}`,
      meta: { invoice_id: invoiceId, balance_minor: after.balance_minor },
      is_demo: opts.is_demo ?? inv.is_demo,
    });
    return { id, status: after.status, balance_minor: after.balance_minor };
  });
}

export async function deletePayment(ctx: AppContext, actor: Actor, paymentId: number): Promise<void> {
  const p = await ctx.db.get<{ id: number; invoice_id: number; amount_minor: number; currency: string; client_id: number; number: string }>(
    'SELECT p.id, p.invoice_id, p.amount_minor, p.currency, p.client_id, i.number FROM payments p JOIN invoices i ON i.id = p.invoice_id WHERE p.id = :id',
    { id: paymentId },
  );
  if (!p) throw notFound('Payment');
  await ctx.db.tx(async () => {
    await ctx.db.run('DELETE FROM payments WHERE id = :id', { id: paymentId });
    await logActivity(ctx, actor, {
      entity_type: 'payment',
      entity_id: paymentId,
      client_id: p.client_id,
      action: 'payment_deleted',
      summary: `Payment of ${formatMoney(p.amount_minor, p.currency, { decimals: 'always' })} removed from ${p.number}`,
      meta: { invoice_id: p.invoice_id },
    });
  });
}

// ── Retainer drafts ──────────────────────────────────────────────────────────

type RetainerClient = {
  id: number;
  name: string;
  company: string | null;
  retainer_minor: number;
  currency: string;
  billing_cycle: 'monthly' | 'quarterly' | 'yearly';
  billing_day: number | null;
  contract_start: string | null;
  service_package: string | null;
  payment_terms_days: number;
  is_demo: number;
};

/**
 * Which active retainer clients are due an invoice for the period starting in `month` (YYYY-MM),
 * and whether one already exists. Quarterly/yearly retainers are due only in their cycle months.
 */
export async function retainerDraftPreview(ctx: AppContext, month: string) {
  const periodStart = `${month}-01`;
  const clients = await ctx.db.all<RetainerClient>(
    `SELECT id, name, company, retainer_minor, currency, billing_cycle, billing_day, contract_start, service_package, payment_terms_days, is_demo
       FROM clients
      WHERE status = 'active' AND archived_at IS NULL AND retainer_minor > 0
      ORDER BY COALESCE(company, name)`,
  );
  return (await Promise.all(clients
    .map(async (c) => {
      const cycle = BILLING_CYCLE_MONTHS[c.billing_cycle];
      const anchor = c.contract_start ? c.contract_start.slice(0, 7) : month;
      const monthsFromAnchor = (Number(month.slice(0, 4)) - Number(anchor.slice(0, 4))) * 12 + (Number(month.slice(5, 7)) - Number(anchor.slice(5, 7)));
      const due = monthsFromAnchor >= 0 && monthsFromAnchor % cycle === 0;
      const existing = await ctx.db.get<{ id: number; number: string }>(
        `SELECT id, number FROM invoices WHERE client_id = :id AND kind = 'retainer' AND period_start = :ps AND state <> 'void'`,
        { id: c.id, ps: periodStart },
      );
      return {
        client_id: c.id,
        client_name: c.company || c.name,
        amount_minor: c.retainer_minor,
        currency: c.currency,
        billing_cycle: c.billing_cycle,
        period_start: periodStart,
        period_end: endOfMonth(addMonths(periodStart, cycle - 1)),
        due,
        existing_invoice: existing ?? null,
        is_demo: c.is_demo,
      };
    })))
    .filter((c) => c.due);
}

export async function createRetainerDrafts(ctx: AppContext, actor: Actor, month: string, clientIds?: number[]): Promise<number[]> {
  const preview = (await retainerDraftPreview(ctx, month)).filter((p) => !p.existing_invoice && (!clientIds || clientIds.includes(p.client_id)));
  const created: number[] = [];
  const today = await ctx.today();
  await ctx.db.tx(async () => {
    for (const p of preview) {
      const c = (await ctx.db.get<RetainerClient>('SELECT * FROM clients WHERE id = :id', { id: p.client_id }))!;
      const issue = today > p.period_start ? today : p.period_start;
      const label = p.billing_cycle === 'monthly' ? monthLabel(month, 'long') : `${monthLabel(month, 'long')} – ${monthLabel(p.period_end.slice(0, 7), 'long')}`;
      created.push(
        await createInvoice(
          ctx,
          actor,
          {
            client_id: c.id,
            project_id: null,
            kind: 'retainer',
            currency: c.currency,
            issue_date: issue,
            due_date: addDays(issue, c.payment_terms_days),
            period_start: p.period_start,
            period_end: p.period_end,
            discount_type: 'none',
            discount_percent: 0,
            discount_fixed_minor: 0,
            taxes: (await ctx.settings()).default_taxes,
            notes: null,
            terms: (await ctx.settings()).default_invoice_terms || null,
            internal_notes: 'Drafted from the retainer schedule. Review before sending.',
            items: [
              {
                description: `${c.service_package || 'Monthly retainer'} — ${label}`,
                quantity: 1,
                unit_price_minor: c.retainer_minor,
                service_type: 'retainer',
              },
            ],
          },
          { is_demo: c.is_demo },
        ),
      );
    }
  });
  return created;
}
