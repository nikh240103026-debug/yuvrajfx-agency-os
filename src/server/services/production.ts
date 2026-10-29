import type { AppContext } from '../context.ts';
import type { Actor } from '../lib/activity.ts';
import { logActivity } from '../lib/activity.ts';
import { notFound } from '../lib/http.ts';
import { PROJECT_STATUS_LABELS, STAGE_LABELS, type ProjectStatus, type Stage } from '../../shared/constants.ts';

type DeliverableRow = {
  id: number;
  project_id: number;
  title: string;
  status: Stage;
  revision_count: number;
  approved_at: string | null;
  delivered_at: string | null;
  is_demo: number;
  client_id: number;
  project_status: ProjectStatus;
  project_name: string;
};

/**
 * Move a deliverable to a new stage, keeping the revision counter and approval/delivery dates honest:
 * entering Revisions counts one revision round; Approved/Delivered stamp their dates; reopening clears them.
 * If every deliverable of the project is delivered, the project is marked delivered too.
 */
export async function setDeliverableStatus(
  ctx: AppContext,
  actor: Actor,
  id: number,
  next: Stage,
  opts: { countRevision?: boolean; reason?: string } = {},
): Promise<{ changed: boolean; revision_count: number }> {
  const d = await ctx.db.get<DeliverableRow>(
    `SELECT d.id, d.project_id, d.title, d.status, d.revision_count, d.approved_at, d.delivered_at, d.is_demo,
            p.client_id, p.status AS project_status, p.name AS project_name
       FROM deliverables d JOIN projects p ON p.id = d.project_id WHERE d.id = :id`,
    { id },
  );
  if (!d) throw notFound('Deliverable');
  if (d.status === next) return { changed: false, revision_count: d.revision_count };
  const now = ctx.nowIso();
  return ctx.db.tx(async () => {
    const revision_count = next === 'revisions' && opts.countRevision !== false ? d.revision_count + 1 : d.revision_count;
    const approved_at = next === 'approved' || next === 'delivered' ? d.approved_at ?? now : ['backlog', 'editing', 'internal_review', 'client_review', 'revisions'].includes(next) ? null : d.approved_at;
    const delivered_at = next === 'delivered' ? d.delivered_at ?? now : null;
    await ctx.db.update('deliverables', id, { status: next, revision_count, approved_at, delivered_at, updated_at: now });
    await logActivity(ctx, actor, {
      entity_type: 'deliverable',
      entity_id: id,
      client_id: d.client_id,
      project_id: d.project_id,
      action: 'status_changed',
      summary: `“${d.title}” ${STAGE_LABELS[d.status]} → ${STAGE_LABELS[next]}${next === 'revisions' && revision_count !== d.revision_count ? ` (revision ${revision_count})` : ''}${opts.reason ? ` · ${opts.reason}` : ''}`,
      meta: { from: d.status, to: next },
      is_demo: d.is_demo,
    });
    await syncProjectAfterDeliverable(ctx, actor, d.project_id, next);
    return { changed: true, revision_count };
  });
}

async function syncProjectAfterDeliverable(ctx: AppContext, actor: Actor, projectId: number, movedTo: Stage): Promise<void> {
  const p = await ctx.db.get<{ status: ProjectStatus; name: string; client_id: number; is_demo: number }>('SELECT status, name, client_id, is_demo FROM projects WHERE id = :id', { id: projectId });
  if (!p || p.status === 'cancelled' || p.status === 'on_hold') return;
  const counts = await ctx.db.get<{ total: number; delivered: number }>(
    `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE status = 'delivered') AS delivered FROM deliverables WHERE project_id = :id`,
    { id: projectId },
  )!;
  if (counts.total > 0 && counts.delivered === counts.total && p.status !== 'delivered') {
    await setProjectStatus(ctx, actor, projectId, 'delivered', 'all deliverables delivered');
  } else if (p.status === 'delivered' && movedTo !== 'delivered') {
    await setProjectStatus(ctx, actor, projectId, movedTo, 'a deliverable was reopened');
  }
}

export async function setProjectStatus(ctx: AppContext, actor: Actor, id: number, next: ProjectStatus, reason?: string): Promise<boolean> {
  const p = await ctx.db.get<{ status: ProjectStatus; name: string; client_id: number; is_demo: number; completed_at: string | null }>(
    'SELECT status, name, client_id, is_demo, completed_at FROM projects WHERE id = :id',
    { id },
  );
  if (!p) throw notFound('Project');
  if (p.status === next) return false;
  const now = ctx.nowIso();
  await ctx.db.tx(async () => {
    await ctx.db.update('projects', id, {
      status: next,
      completed_at: next === 'delivered' ? p.completed_at ?? now : null,
      updated_at: now,
    });
    await logActivity(ctx, actor, {
      entity_type: 'project',
      entity_id: id,
      client_id: p.client_id,
      project_id: id,
      action: 'status_changed',
      summary: `Project “${p.name}” ${PROJECT_STATUS_LABELS[p.status]} → ${PROJECT_STATUS_LABELS[next]}${reason ? ` (${reason})` : ''}`,
      meta: { from: p.status, to: next },
      is_demo: p.is_demo,
    });
  });
  return true;
}

/** SQL fragment with per-project deliverable counts. Needs :today bound. */
export const PROJECT_SUMMARY_COLUMNS = `
  (SELECT COUNT(*) FROM deliverables d WHERE d.project_id = p.id) AS deliverable_count,
  (SELECT COUNT(*) FROM deliverables d WHERE d.project_id = p.id AND d.status = 'delivered') AS delivered_count,
  (SELECT COUNT(*) FROM deliverables d WHERE d.project_id = p.id AND d.status <> 'delivered' AND d.deadline < :today AND p.status NOT IN ('on_hold','cancelled')) AS overdue_deliverables,
  (SELECT MIN(d.deadline) FROM deliverables d WHERE d.project_id = p.id AND d.status <> 'delivered') AS next_deliverable_deadline,
  (SELECT COALESCE(SUM(d.revision_count), 0) FROM deliverables d WHERE d.project_id = p.id) AS revision_total,
  (p.deadline IS NOT NULL AND p.deadline < :today AND p.status NOT IN ('delivered','cancelled','on_hold')) AS is_overdue`;
