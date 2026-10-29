import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';

export class HttpError extends Error {
  readonly status: number;
  readonly details: unknown;
  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export const badRequest = (message: string, details?: unknown) => new HttpError(400, message, details);
export const unauthorized = (message = 'Please sign in.') => new HttpError(401, message);
export const forbidden = (message = "You don't have access to this.") => new HttpError(403, message);
export const notFound = (what = 'Record') => new HttpError(404, `${what} not found.`);
export const conflict = (message: string, details?: unknown) => new HttpError(409, message, details);

/** Validate with zod and turn failures into a 400 with per-field messages. */
export function parse<S extends z.ZodType>(schema: S, data: unknown): z.output<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const fields: Record<string, string> = {};
    for (const issue of result.error.issues) {
      const key = issue.path.length ? issue.path.join('.') : '_';
      if (!fields[key]) fields[key] = issue.message;
    }
    const first = Object.entries(fields)[0];
    const message = first ? (first[0] === '_' ? first[1] : `${humanize(first[0])}: ${first[1]}`) : 'Invalid input.';
    throw badRequest(message, { fields });
  }
  return result.data;
}

function humanize(path: string): string {
  const last = path.split('.').filter((p) => !/^\d+$/.test(p)).pop() ?? path;
  const s = last.replace(/_minor$/, '').replace(/_id$/, '').replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function idParam(req: Request, name = 'id'): number {
  const raw = req.params[name];
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) throw notFound();
  return n;
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: { message: err.message, details: err.details ?? null } });
    return;
  }
  const e = err as { type?: string; status?: number; message?: string };
  if (e?.type === 'entity.parse.failed') {
    res.status(400).json({ error: { message: 'Malformed JSON body.', details: null } });
    return;
  }
  if (e?.type === 'entity.too.large') {
    res.status(413).json({ error: { message: 'That upload is too large.', details: null } });
    return;
  }
  console.error(`[error] ${req.method} ${req.originalUrl}`, err);
  res.status(500).json({ error: { message: 'Something went wrong on the server. Check the server log for details.', details: null } });
}

/** Map our trigger/constraint codes (see migrations) to friendly API errors. */
export function translateDbError(err: unknown): never {
  const msg = err instanceof Error ? err.message : String(err);
  const pg = err as { code?: string; constraint?: string };
  if (pg?.code === '23505') {
    if (pg.constraint?.includes('invoice') && pg.constraint?.includes('number')) throw conflict('That invoice number is already used.');
    if (pg.constraint?.includes('users_email')) throw conflict('A user with that email already exists.');
    if (pg.constraint === 'invoices_retainer_period') throw conflict('A retainer invoice for this client and period already exists.');
    throw conflict('A record with the same unique value already exists.');
  }
  if (pg?.code === '23503') throw conflict('This record is still referenced by other records.');
  const map: [string, () => HttpError][] = [
    ['PAYMENT_EXCEEDS_BALANCE', () => conflict('That payment is more than the outstanding balance.')],
    ['PAYMENT_CURRENCY_MISMATCH', () => badRequest('Payment currency must match the invoice currency.')],
    ['PAYMENT_CLIENT_MISMATCH', () => badRequest('Payment client must match the invoice client.')],
    ['PAYMENT_INVOICE_VOID', () => conflict('Payments cannot be recorded on a void invoice.')],
    ['PAYMENT_IMMUTABLE', () => conflict('Recorded payments cannot be edited. Delete it and record it again.')],
    ['INVOICE_TOTAL_BELOW_PAID', () => conflict('The new total would be less than what has already been paid.')],
    ['INVOICE_HAS_PAYMENTS', () => conflict('This invoice has payments recorded. Remove them before changing its client, currency or state.')],
    ['UNIQUE constraint failed: invoices.number', () => conflict('That invoice number is already used.')],
    ['UNIQUE constraint failed: invoices.client_id, invoices.period_start', () => conflict('A retainer invoice for this client and period already exists.')],
    ['UNIQUE constraint failed: users.email', () => conflict('A user with that email already exists.')],
    ['FOREIGN KEY constraint failed', () => conflict('This record is still referenced by other records.')],
  ];
  for (const [needle, make] of map) if (msg.includes(needle)) throw make();
  throw err;
}
