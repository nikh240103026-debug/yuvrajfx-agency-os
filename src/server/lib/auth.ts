import { createHash, randomBytes, randomInt, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { AppContext } from '../context.ts';
import { ADMIN_ROLES, STAFF_ROLES, type Role } from '../../shared/constants.ts';
import { forbidden, HttpError, unauthorized } from './http.ts';

export type SessionUser = {
  id: number;
  email: string;
  name: string;
  role: Role;
  client_id: number | null;
  team_member_id: number | null;
  must_change_password: boolean;
};

export const SESSION_COOKIE = 'yfx_session';
const SESSION_DAYS = 30;
const KEYLEN = 64;

function scrypt(password: string, salt: Buffer, N: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, KEYLEN, { N, r: 8, p: 1, maxmem: 256 * N * 8 }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** scrypt with a per-password salt. Format: scrypt$N$salt$hash (base64url). */
export async function hashPassword(password: string): Promise<string> {
  const N = Number(process.env.YFX_SCRYPT_N) || 32768;
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, N);
  return `scrypt$${N}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, nRaw, saltRaw, hashRaw] = stored.split('$');
  if (algo !== 'scrypt' || !nRaw || !saltRaw || !hashRaw) return false;
  const N = Number(nRaw);
  if (!Number.isInteger(N) || N < 1024 || N > 1 << 20) return false;
  const expected = Buffer.from(hashRaw, 'base64url');
  const actual = await scrypt(password, Buffer.from(saltRaw, 'base64url'), N);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** A dummy hash so failed lookups take as long as real ones (no user-enumeration timing). */
let dummyHash: Promise<string> | null = null;
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= hashPassword('not-a-real-password-' + randomBytes(8).toString('hex'));
  await verifyPassword(password, await dummyHash);
}

export function passwordProblem(password: string): string | null {
  if (password.length < 10) return 'Use at least 10 characters.';
  if (password.length > 200) return 'Use at most 200 characters.';
  if (/^(.)\1+$/.test(password)) return 'Avoid repeating a single character.';
  const lower = password.toLowerCase();
  if (['password12', 'password123', '1234567890', 'qwertyuiop', 'yuvrajfx123'].some((w) => lower.includes(w))) {
    return 'That password is too easy to guess.';
  }
  return null;
}

/** Readable temporary password for portal invites, e.g. "kite-amber-41-river". */
export function generatePassword(): string {
  const words = ['amber', 'river', 'pixel', 'frame', 'orbit', 'cedar', 'lumen', 'delta', 'kite', 'nova', 'reel', 'prism', 'sable', 'tempo', 'vivid', 'zephyr', 'quartz', 'harbor', 'mosaic', 'echo'];
  const pick = () => words[randomInt(words.length)];
  return `${pick()}-${pick()}-${randomInt(10, 100)}-${pick()}-${randomInt(10, 100)}`;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      try {
        return decodeURIComponent(part.slice(idx + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

// ── Running behind a local tunnel (e.g. cloudflared) ─────────────────────────
// The server only listens on 127.0.0.1, so forwarding headers are trusted only from a loopback
// connection, which is where a tunnel connects from. Remote visitors are recognised by those headers.

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function fromLoopback(req: Request): boolean {
  return LOOPBACK.has(req.socket.remoteAddress ?? '');
}

/** True when the request came through a proxy/tunnel rather than straight from a browser on this computer. */
export function isForwarded(req: Request): boolean {
  return !fromLoopback(req) || !!(req.get('cf-connecting-ip') || req.get('x-forwarded-for'));
}

/** The visitor's IP: the tunnel's header when it came through one, else the socket address. */
export function clientIp(req: Request): string | null {
  if (fromLoopback(req)) {
    const fwd = req.get('cf-connecting-ip') || req.get('x-forwarded-for')?.split(',')[0];
    if (fwd?.trim()) return fwd.trim();
  }
  return req.ip ?? null;
}

function isHttps(ctx: AppContext, req: Request): boolean {
  return ctx.config.cookieSecure || req.secure || (fromLoopback(req) && req.get('x-forwarded-proto') === 'https');
}

export async function createSession(ctx: AppContext, userId: number, req: Request, res: Response): Promise<void> {
  const token = randomBytes(32).toString('base64url');
  const now = ctx.clock.now();
  const expires = new Date(now.getTime() + SESSION_DAYS * 86_400_000);
  await ctx.db.insert('sessions', {
    id: sha256(token),
    user_id: userId,
    created_at: now.toISOString(),
    expires_at: expires.toISOString(),
    last_seen_at: now.toISOString(),
    user_agent: String(req.headers['user-agent'] ?? '').slice(0, 300),
    ip: clientIp(req),
  });
  await ctx.db.run('UPDATE users SET last_login_at = :at WHERE id = :id', { at: now.toISOString(), id: userId });
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isHttps(ctx, req),
    path: '/',
    maxAge: SESSION_DAYS * 86_400_000,
  });
}

export async function destroySession(ctx: AppContext, req: Request, res: Response): Promise<void> {
  if (req.sessionId) await ctx.db.run('DELETE FROM sessions WHERE id = :id', { id: req.sessionId });
  res.clearCookie(SESSION_COOKIE, { path: '/', httpOnly: true, sameSite: 'lax', secure: isHttps(ctx, req) });
}

type SessionRow = {
  session_id: string;
  expires_at: string;
  last_seen_at: string;
  id: number;
  email: string;
  name: string;
  role: Role;
  client_id: number | null;
  team_member_id: number | null;
  must_change_password: number;
  disabled: number;
  client_archived: string | null;
};

/** Loads the signed-in user (if any) onto req.user. Never throws for anonymous requests. */
export function sessionMiddleware(ctx: AppContext) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const token = readCookie(req, SESSION_COOKIE);
    if (!token) return next();
    const row = await ctx.db.get<SessionRow>(
      `SELECT s.id AS session_id, s.expires_at, s.last_seen_at, u.id, u.email, u.name, u.role, u.client_id,
              u.team_member_id, u.must_change_password, u.disabled, c.archived_at AS client_archived
         FROM sessions s
         JOIN users u ON u.id = s.user_id
         LEFT JOIN clients c ON c.id = u.client_id
        WHERE s.id = :id`,
      { id: sha256(token) },
    );
    const now = ctx.clock.now();
    if (!row || row.expires_at <= now.toISOString() || row.disabled || (row.role === 'client' && row.client_archived)) {
      if (row) await ctx.db.run('DELETE FROM sessions WHERE id = :id', { id: row.session_id });
      res.clearCookie(SESSION_COOKIE, { path: '/' });
      return next();
    }
    // Sliding expiry, refreshed at most every 12 hours.
    if (now.getTime() - Date.parse(row.last_seen_at) > 12 * 3_600_000) {
      await ctx.db.run('UPDATE sessions SET last_seen_at = :now, expires_at = :exp WHERE id = :id', {
        now: now.toISOString(),
        exp: new Date(now.getTime() + SESSION_DAYS * 86_400_000).toISOString(),
        id: row.session_id,
      });
    }
    req.sessionId = row.session_id;
    req.user = {
      id: row.id,
      email: row.email,
      name: row.name,
      role: row.role,
      client_id: row.client_id,
      team_member_id: row.team_member_id,
      must_change_password: !!row.must_change_password,
    };
    next();
  };
}

/**
 * CSRF defence for cookie-authenticated mutations: the SPA sends a custom header that a cross-site
 * form or image cannot, and any Origin header present must match this host. SameSite=Lax backs this up.
 */
export function csrfGuard(req: Request, _res: Response, next: NextFunction): void {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('x-requested-with') !== 'yfx') return next(new HttpError(403, 'Request blocked: missing app header.'));
  const origin = req.get('origin');
  if (origin) {
    let host: string | null = null;
    try {
      host = new URL(origin).host;
    } catch {
      /* invalid */
    }
    if (host !== req.get('host')) return next(new HttpError(403, 'Request blocked: cross-site origin.'));
  }
  next();
}

export function requireUser(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) return next(unauthorized());
  next();
}

export function requireStaff(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) return next(unauthorized());
  if (!STAFF_ROLES.includes(req.user.role)) return next(forbidden());
  if (req.user.must_change_password) return next(new HttpError(403, 'Please set a new password first.', { code: 'PASSWORD_CHANGE_REQUIRED' }));
  next();
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) return next(unauthorized());
  if (!ADMIN_ROLES.includes(req.user.role)) return next(forbidden('Only the owner or an admin can do this.'));
  if (req.user.must_change_password) return next(new HttpError(403, 'Please set a new password first.', { code: 'PASSWORD_CHANGE_REQUIRED' }));
  next();
}

export function requireClient(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) return next(unauthorized());
  if (req.user.role !== 'client' || !req.user.client_id) return next(forbidden('This area is for client portal accounts.'));
  if (req.user.must_change_password) return next(new HttpError(403, 'Please set a new password first.', { code: 'PASSWORD_CHANGE_REQUIRED' }));
  next();
}

export function isAdmin(req: Request): boolean {
  return !!req.user && ADMIN_ROLES.includes(req.user.role);
}

/** Simple fixed-window limiter for login attempts, keyed by IP + email. */
export class LoginLimiter {
  readonly max: number;
  readonly windowMs: number;
  #hits = new Map<string, { count: number; resetAt: number }>();
  constructor(max = 10, windowMs = 15 * 60_000) {
    this.max = max;
    this.windowMs = windowMs;
  }
  blocked(key: string, now = Date.now()): boolean {
    const h = this.#hits.get(key);
    if (!h || h.resetAt <= now) return false;
    return h.count >= this.max;
  }
  fail(key: string, now = Date.now()): void {
    const h = this.#hits.get(key);
    if (!h || h.resetAt <= now) this.#hits.set(key, { count: 1, resetAt: now + this.windowMs });
    else h.count++;
    if (this.#hits.size > 5000) for (const [k, v] of this.#hits) if (v.resetAt <= now) this.#hits.delete(k);
  }
  reset(key: string): void {
    this.#hits.delete(key);
  }
}
