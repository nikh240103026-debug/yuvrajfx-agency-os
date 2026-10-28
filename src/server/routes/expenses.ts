import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../context.ts';
import { badRequest, idParam, notFound, parse } from '../lib/http.ts';
import { actorOf, logActivity } from '../lib/activity.ts';
import { toCsv } from '../lib/csv.ts';
import { currencyCode, foreignKey, optionalText, optionalUrl, positiveMinorAmount, qInt, qStr, requiredDate, requiredText } from '../lib/validation.ts';
import { likeParam, sendCsv } from './common.ts';
import { EXPENSE_CATEGORIES, EXPENSE_CATEGORY_LABELS } from '../../shared/constants.ts';
import { formatMoney, fromMinor, sumByCurrency } from '../../shared/money.ts';

const fields = {
  date: requiredDate(),
  category: z.enum(EXPENSE_CATEGORIES),
  amount_minor: positiveMinorAmount(),
  currency: currencyCode(),
  description: requiredText(300),
  vendor: optionalText(160),
  client_id: foreignKey(),
  project_id: foreignKey(),
  team_member_id: foreignKey(),
  receipt_url: optionalUrl(),
  notes: optionalText(5000),
};
const createSchema = z.object(fields);
const updateSchema = z.object(fields).partial();

const listQuery = z.object({ q: qStr(), category: qStr(), currency: qStr(), from: qStr(), to: qStr(), client_id: qInt(), project_id: qInt() });

function checkRefs(ctx: AppContext, b: { client_id?: number | null; project_id?: number | null; team_member_id?: number | null }) {
  if (b.client_id && !ctx.db.get('SELECT 1 FROM clients WHERE id = :id', { id: b.client_id })) throw badRequest('That client does not exist.');
  if (b.project_id) {
    const p = ctx.db.get<{ client_id: number }>('SELECT client_id FROM projects WHERE id = :id', { id: b.project_id });
    if (!p) throw badRequest('That project does not exist.');
    if (b.client_id && p.client_id !== b.client_id) throw badRequest('That project belongs to a different client.');
  }
  if (b.team_member_id && !ctx.db.get('SELECT 1 FROM team_members WHERE id = :id', { id: b.team_member_id })) throw badRequest('That team member does not exist.');
}

export function expensesRouter(ctx: AppContext): Router {
  const r = Router();

  function list(q: z.output<typeof listQuery>) {
    const where: string[] = ['1 = 1'];
    const params: Record<string, unknown> = {};
    for (const key of ['category', 'currency', 'client_id', 'project_id'] as const) {
      if (q[key]) {
        where.push(`e.${key} = :${key}`);
        params[key] = q[key];
      }
    }
    if (q.from) {
      where.push('e.date >= :from');
      params.from = q.from;
    }
    if (q.to) {
      where.push('e.date <= :to');
      params.to = q.to;
    }
    if (q.q) {
      where.push('(e.description LIKE :q OR e.vendor LIKE :q OR e.notes LIKE :q)');
      params.q = likeParam(q.q);
    }
    return ctx.db.all<{ id: number; date: string; category: string; amount_minor: number; currency: string; description: string; vendor: string | null; client_name: string | null; project_name: string | null; member_name: string | null; receipt_url: string | null; is_demo: number }>(
      `SELECT e.*, COALESCE(c.company, c.name) AS client_name, p.name AS project_name, t.name AS member_name
         FROM expenses e LEFT JOIN clients c ON c.id = e.client_id LEFT JOIN projects p ON p.id = e.project_id LEFT JOIN team_members t ON t.id = e.team_member_id
        WHERE ${where.join(' AND ')} ORDER BY e.date DESC, e.id DESC`,
      params,
    );
  }

  r.get('/', (req, res) => {
    const rows = list(parse(listQuery, req.query));
    res.json({ expenses: rows, totals: sumByCurrency(rows, ctx.settings().base_currency) });
  });

  r.get('/export.csv', (req, res) => {
    const rows = list(parse(listQuery, req.query));
    const csv = toCsv(rows, [
      { header: 'Date', value: (e) => e.date },
      { header: 'Category', value: (e) => EXPENSE_CATEGORY_LABELS[e.category as keyof typeof EXPENSE_CATEGORY_LABELS] ?? e.category },
      { header: 'Description', value: (e) => e.description },
      { header: 'Vendor', value: (e) => e.vendor },
      { header: 'Currency', value: (e) => e.currency },
      { header: 'Amount', value: (e) => fromMinor(e.amount_minor, e.currency) },
      { header: 'Client', value: (e) => e.client_name },
      { header: 'Project', value: (e) => e.project_name },
      { header: 'Team member', value: (e) => e.member_name },
      { header: 'Receipt', value: (e) => e.receipt_url },
      { header: 'Demo data', value: (e) => (e.is_demo ? 'yes' : '') },
    ]);
    sendCsv(ctx, res, 'expenses', csv);
  });

  r.post('/', (req, res) => {
    const body = parse(createSchema, req.body);
    checkRefs(ctx, body);
    const now = ctx.nowIso();
    const id = ctx.db.tx(() => {
      const id = ctx.db.insert('expenses', { ...body, created_at: now, updated_at: now });
      logActivity(ctx, actorOf(req), {
        entity_type: 'expense',
        entity_id: id,
        client_id: body.client_id,
        project_id: body.project_id,
        action: 'created',
        summary: `Expense recorded: ${body.description} · ${formatMoney(body.amount_minor, body.currency)}`,
      });
      return id;
    });
    res.status(201).json({ id });
  });

  r.patch('/:id', (req, res) => {
    const id = idParam(req);
    const existing = ctx.db.get<{ client_id: number | null; project_id: number | null }>('SELECT client_id, project_id FROM expenses WHERE id = :id', { id });
    if (!existing) throw notFound('Expense');
    const body = parse(updateSchema, req.body);
    checkRefs(ctx, { ...existing, ...body });
    ctx.db.update('expenses', id, { ...body, updated_at: ctx.nowIso() });
    res.json({ ok: true });
  });

  r.delete('/:id', (req, res) => {
    const id = idParam(req);
    const e = ctx.db.get<{ description: string; amount_minor: number; currency: string }>('SELECT description, amount_minor, currency FROM expenses WHERE id = :id', { id });
    if (!e) throw notFound('Expense');
    ctx.db.tx(() => {
      ctx.db.run('DELETE FROM expenses WHERE id = :id', { id });
      logActivity(ctx, actorOf(req), { entity_type: 'expense', entity_id: id, action: 'deleted', summary: `Expense deleted: ${e.description} · ${formatMoney(e.amount_minor, e.currency)}` });
    });
    res.json({ ok: true });
  });

  return r;
}
