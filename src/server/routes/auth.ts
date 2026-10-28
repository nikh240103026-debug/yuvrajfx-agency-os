import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../context.ts';
import { badRequest, conflict, forbidden, HttpError, parse, unauthorized } from '../lib/http.ts';
import {
  burnPasswordCheck,
  clientIp,
  createSession,
  destroySession,
  hashPassword,
  isForwarded,
  LoginLimiter,
  passwordProblem,
  requireUser,
  verifyPassword,
} from '../lib/auth.ts';
import { writeSettings } from '../lib/settings.ts';
import { demoPresent } from '../services/demo.ts';
import { currencyCode, requiredEmail, requiredText } from '../lib/validation.ts';
import { isValidTimeZone } from '../../shared/dates.ts';
import type { Role } from '../../shared/constants.ts';

const email = requiredEmail;

const setupSchema = z.object({
  name: requiredText(120),
  email: email(),
  password: z.string().max(200),
  business_name: requiredText(120),
  base_currency: currencyCode(),
  timezone: z.string().refine(isValidTimeZone, 'Unknown timezone.'),
});

const loginSchema = z.object({ email: email(), password: z.string().min(1, 'Enter your password.').max(200) });

const changePasswordSchema = z.object({
  current_password: z.string().min(1, 'Enter your current password.').max(200),
  new_password: z.string().max(200),
});

type UserRow = {
  id: number;
  email: string;
  name: string;
  role: Role;
  client_id: number | null;
  team_member_id: number | null;
  must_change_password: number;
  disabled: number;
  password_hash: string;
};

export function publicUser(u: Omit<UserRow, 'password_hash' | 'disabled'> | Express.Request['user']) {
  if (!u) return null;
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    client_id: u.client_id,
    team_member_id: u.team_member_id,
    must_change_password: !!u.must_change_password,
  };
}

export function authRouter(ctx: AppContext): Router {
  const r = Router();
  const limiter = new LoginLimiter();

  r.get('/state', (req, res) => {
    const users = ctx.db.value<number>('SELECT COUNT(*) FROM users') ?? 0;
    let client: unknown = null;
    if (req.user?.role === 'client' && req.user.client_id) {
      client = ctx.db.get('SELECT id, name, company FROM clients WHERE id = :id', { id: req.user.client_id }) ?? null;
    }
    const s = ctx.settings();
    const staff = !!req.user && req.user.role !== 'client';
    res.json({
      needs_setup: users === 0,
      user: publicUser(req.user),
      client,
      business_name: s.business_name,
      base_currency: s.base_currency,
      today: ctx.today(),
      demo_data: staff ? demoPresent(ctx) : false,
    });
  });

  // First-run setup: creates the owner account. Refused once any user exists.
  r.post('/setup', async (req, res) => {
    // Only from this computer: over a public link, a stranger could otherwise claim the owner account.
    if (isForwarded(req)) throw forbidden('Finish the first-run setup on the computer that runs the app (http://127.0.0.1:4747).');
    if ((ctx.db.value<number>('SELECT COUNT(*) FROM users') ?? 0) > 0) throw conflict('Setup is already complete. Sign in instead.');
    const body = parse(setupSchema, req.body);
    const problem = passwordProblem(body.password);
    if (problem) throw badRequest(problem, { fields: { password: problem } });
    const hash = await hashPassword(body.password);
    const now = ctx.nowIso();
    const id = ctx.db.tx(() => {
      if ((ctx.db.value<number>('SELECT COUNT(*) FROM users') ?? 0) > 0) throw conflict('Setup is already complete. Sign in instead.');
      writeSettings(ctx.db, {
        business_name: body.business_name,
        base_currency: body.base_currency,
        timezone: body.timezone,
        business_email: body.email,
        owner_report_email: body.email,
      });
      return ctx.db.insert('users', { email: body.email, name: body.name, password_hash: hash, role: 'owner', created_at: now, updated_at: now });
    });
    ctx.invalidateSettings();
    createSession(ctx, id, req, res);
    res.status(201).json({
      user: publicUser({ id, email: body.email, name: body.name, role: 'owner', client_id: null, team_member_id: null, must_change_password: 0 }),
    });
  });

  r.post('/login', async (req, res) => {
    const body = parse(loginSchema, req.body);
    const key = `${clientIp(req)}|${body.email}`;
    if (limiter.blocked(key)) throw new HttpError(429, 'Too many sign-in attempts. Wait 15 minutes and try again.');
    const user = ctx.db.get<UserRow & { client_archived: string | null }>(
      `SELECT u.*, c.archived_at AS client_archived FROM users u LEFT JOIN clients c ON c.id = u.client_id WHERE u.email = :email`,
      { email: body.email },
    );
    if (!user) {
      await burnPasswordCheck(body.password);
      limiter.fail(key);
      throw unauthorized('Email or password is incorrect.');
    }
    const ok = await verifyPassword(body.password, user.password_hash);
    if (!ok) {
      limiter.fail(key);
      throw unauthorized('Email or password is incorrect.');
    }
    if (user.disabled || (user.role === 'client' && user.client_archived)) throw unauthorized('This account is disabled. Contact the agency.');
    limiter.reset(key);
    createSession(ctx, user.id, req, res);
    res.json({ user: publicUser(user) });
  });

  r.post('/logout', (req, res) => {
    destroySession(ctx, req, res);
    res.json({ ok: true });
  });

  r.post('/change-password', requireUser, async (req, res) => {
    const body = parse(changePasswordSchema, req.body);
    const user = ctx.db.get<UserRow>('SELECT * FROM users WHERE id = :id', { id: req.user!.id })!;
    if (!(await verifyPassword(body.current_password, user.password_hash))) {
      throw badRequest('Your current password is incorrect.', { fields: { current_password: 'Incorrect password.' } });
    }
    const problem = passwordProblem(body.new_password);
    if (problem) throw badRequest(problem, { fields: { new_password: problem } });
    if (body.new_password === body.current_password) throw badRequest('Choose a password you have not used here.', { fields: { new_password: 'Must differ from the current one.' } });
    const hash = await hashPassword(body.new_password);
    ctx.db.tx(() => {
      ctx.db.run('UPDATE users SET password_hash = :hash, must_change_password = 0, updated_at = :at WHERE id = :id', { hash, at: ctx.nowIso(), id: user.id });
      // Sign out every other device.
      ctx.db.run('DELETE FROM sessions WHERE user_id = :id AND id <> :sid', { id: user.id, sid: req.sessionId ?? '' });
    });
    res.json({ ok: true });
  });

  return r;
}
