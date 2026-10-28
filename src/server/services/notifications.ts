import type { AppContext } from '../context.ts';
import type { SessionUser } from '../lib/auth.ts';
import { ADMIN_ROLES } from '../../shared/constants.ts';

export type NotificationInput = {
  kind: string;
  audience?: 'admin' | 'staff';
  severity?: 'info' | 'success' | 'warning' | 'critical';
  title: string;
  body?: string | null;
  link?: string | null;
  entity_type?: string | null;
  entity_id?: number | null;
  /** Same key = same notification; it is created once and never duplicated. */
  dedupe_key: string;
  is_demo?: number;
};

/** Returns true when a new notification was created (false if it already existed). */
export function notify(ctx: AppContext, n: NotificationInput): boolean {
  const r = ctx.db.run(
    `INSERT INTO notifications (kind, audience, severity, title, body, link, entity_type, entity_id, dedupe_key, is_demo, created_at)
     VALUES (:kind, :audience, :severity, :title, :body, :link, :entity_type, :entity_id, :dedupe_key, :is_demo, :created_at)
     ON CONFLICT(dedupe_key) DO NOTHING`,
    {
      ...n,
      audience: n.audience ?? 'admin',
      severity: n.severity ?? 'info',
      body: n.body ?? null,
      link: n.link ?? null,
      entity_type: n.entity_type ?? null,
      entity_id: n.entity_id ?? null,
      is_demo: n.is_demo ?? 0,
      created_at: ctx.nowIso(),
    },
  );
  return r.changes > 0;
}

function audienceSql(user: SessionUser): string {
  return ADMIN_ROLES.includes(user.role) ? `n.audience IN ('admin','staff')` : `n.audience = 'staff'`;
}

export function listNotifications(ctx: AppContext, user: SessionUser, opts: { unreadOnly?: boolean; limit?: number } = {}) {
  return ctx.db.all(
    `SELECT n.*, r.read_at FROM notifications n
       LEFT JOIN notification_reads r ON r.notification_id = n.id AND r.user_id = :uid
      WHERE ${audienceSql(user)} ${opts.unreadOnly ? 'AND r.read_at IS NULL' : ''}
      ORDER BY n.created_at DESC, n.id DESC LIMIT :limit`,
    { uid: user.id, limit: opts.limit ?? 100 },
  );
}

export function unreadCount(ctx: AppContext, user: SessionUser): number {
  return (
    ctx.db.value<number>(
      `SELECT COUNT(*) FROM notifications n LEFT JOIN notification_reads r ON r.notification_id = n.id AND r.user_id = :uid
        WHERE ${audienceSql(user)} AND r.read_at IS NULL`,
      { uid: user.id },
    ) ?? 0
  );
}

export function markRead(ctx: AppContext, user: SessionUser, ids: number[] | 'all'): number {
  const at = ctx.nowIso();
  if (ids === 'all') {
    return ctx.db.run(
      `INSERT OR IGNORE INTO notification_reads (notification_id, user_id, read_at)
       SELECT n.id, :uid, :at FROM notifications n WHERE ${audienceSql(user)}`,
      { uid: user.id, at },
    ).changes;
  }
  let n = 0;
  ctx.db.tx(() => {
    for (const id of ids) {
      n += ctx.db.run(
        `INSERT OR IGNORE INTO notification_reads (notification_id, user_id, read_at)
         SELECT n.id, :uid, :at FROM notifications n WHERE n.id = :id AND ${audienceSql(user)}`,
        { uid: user.id, at, id },
      ).changes;
    }
  });
  return n;
}
