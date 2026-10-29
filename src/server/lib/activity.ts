import type { Request } from 'express';
import type { AppContext } from '../context.ts';

export type Actor = { type: 'user' | 'client' | 'system'; id: number | null; name: string };

export const SYSTEM_ACTOR: Actor = { type: 'system', id: null, name: 'Automation' };

export function actorOf(req: Request): Actor {
  const u = req.user;
  if (!u) return SYSTEM_ACTOR;
  return { type: u.role === 'client' ? 'client' : 'user', id: u.id, name: u.name };
}

export type ActivityEntry = {
  entity_type: string;
  entity_id: number | null;
  client_id?: number | null;
  project_id?: number | null;
  action: string;
  summary: string;
  meta?: Record<string, unknown>;
  is_demo?: boolean | number;
};

export async function logActivity(ctx: AppContext, actor: Actor, entry: ActivityEntry): Promise<void> {
  await ctx.db.insert('activity', {
    entity_type: entry.entity_type,
    entity_id: entry.entity_id,
    client_id: entry.client_id ?? null,
    project_id: entry.project_id ?? null,
    action: entry.action,
    summary: entry.summary,
    meta: entry.meta ?? {},
    actor_type: actor.type,
    actor_id: actor.id,
    actor_name: actor.name,
    is_demo: entry.is_demo ? 1 : 0,
    created_at: ctx.nowIso(),
  });
}
