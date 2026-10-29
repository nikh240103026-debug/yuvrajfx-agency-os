import type { Request, Response } from 'express';
import { isAdmin } from '../lib/auth.ts';
import { csvFilename } from '../lib/csv.ts';
import type { AppContext } from '../context.ts';

export async function sendCsv(ctx: AppContext, res: Response, base: string, csv: string): Promise<void> {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${csvFilename(base, await ctx.today())}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(csv);
}

/** Team members (non-admin staff) don't see money: retainers, prices, balances. */
export function canSeeFinance(req: Request): boolean {
  return isAdmin(req);
}

export function stripFields<T extends Record<string, unknown>>(row: T, fields: readonly string[]): T {
  const copy: Record<string, unknown> = { ...row };
  for (const f of fields) delete copy[f];
  return copy as T;
}

/** Parse JSON text columns on a row. */
export function withJson<T extends Record<string, unknown>>(row: T, fields: Record<string, unknown>): T {
  const copy: Record<string, unknown> = { ...row };
  for (const [f, fallback] of Object.entries(fields)) {
    const v = copy[f];
    if (typeof v === 'string') {
      try {
        copy[f] = JSON.parse(v);
      } catch {
        copy[f] = fallback;
      }
    } else if (v === null || v === undefined) {
      copy[f] = fallback;
    }
  }
  return copy as T;
}

/** Substring match for LIKE (a stray % or _ in a search only broadens it, which is harmless). */
export function likeParam(q: string): string {
  return `%${q}%`;
}
