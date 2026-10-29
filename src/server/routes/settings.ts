import { Router } from 'express';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import type { AppContext } from '../context.ts';
import { badRequest, conflict, forbidden, idParam, notFound, parse } from '../lib/http.ts';
import { pgEnvFromUrl } from '../db/pg-env.ts';
import { generatePassword, hashPassword } from '../lib/auth.ts';
import { actorOf, logActivity } from '../lib/activity.ts';
import { writeSettings, type Settings } from '../lib/settings.ts';
import { currencyCode, foreignKey, optionalDate, optionalEmail, optionalText, optionalUrl, requiredEmail, requiredText } from '../lib/validation.ts';
import { isValidCurrency } from '../../shared/money.ts';
import { isValidTimeZone } from '../../shared/dates.ts';
import { demoCounts, loadDemoData, removeDemoData } from '../services/demo.ts';

const text = (max: number) => optionalText(max).transform((v) => v ?? '');

const settingsSchema = z
  .object({
    business_name: requiredText(120),
    business_email: optionalEmail().transform((v) => v ?? ''),
    business_phone: text(60),
    business_address: text(600),
    business_website: optionalUrl().transform((v) => v ?? ''),
    tax_id_label: text(30),
    tax_id: text(60),
    base_currency: currencyCode(),
    timezone: z.string().refine(isValidTimeZone, 'Unknown timezone.'),
    fx_rates: z
      .record(z.string(), z.number().positive('Rates must be more than zero.').max(10_000_000))
      .refine((r) => Object.keys(r).every(isValidCurrency), 'Unknown currency in exchange rates.'),
    fx_as_of: optionalDate(),
    invoice_prefix: z.string().trim().max(20).regex(/^[A-Za-z0-9._/#-]*$/, 'Use letters, numbers and - _ . / # only.'),
    invoice_next_number: z.number().int().min(1).max(1_000_000_000),
    invoice_number_padding: z.number().int().min(1).max(8),
    default_payment_terms_days: z.number().int().min(0).max(365),
    default_taxes: z.array(z.object({ label: requiredText(40), rate: z.number().min(0).max(100) })).max(4),
    default_invoice_terms: text(5000),
    payment_instructions: text(5000),
    invoice_footer: text(1000),
    owner_report_email: optionalEmail().transform((v) => v ?? ''),
  })
  .partial();

const userCreate = z.object({
  name: requiredText(120),
  email: requiredEmail(),
  role: z.enum(['admin', 'member', 'client']),
  client_id: foreignKey(),
  team_member_id: foreignKey(),
});
const userUpdate = z.object({ name: requiredText(120), role: z.enum(['admin', 'member']), disabled: z.boolean(), team_member_id: foreignKey() }).partial();

export function settingsRouter(ctx: AppContext): Router {
  const r = Router();

  r.get('/', async (_req, res) => {
    res.json({
      settings: await ctx.settings(),
      system: {
        database: 'PostgreSQL',
        node: process.version,
        email: { configured: ctx.mailer.configured, description: ctx.mailer.description },
        demo: await demoCounts(ctx),
        today: await ctx.today(),
      },
    });
  });

  r.put('/', async (req, res) => {
    const body = parse(settingsSchema, req.body);
    await writeSettings(ctx.db, body as Partial<Settings>);
    ctx.invalidateSettings();
    await logActivity(ctx, actorOf(req), { entity_type: 'settings', entity_id: null, action: 'updated', summary: 'Business settings updated' });
    res.json({ settings: await ctx.settings() });
  });

  // ── Users & portal access ──
  r.get('/users', async (_req, res) => {
    res.json({
      users: await ctx.db.all(
        `SELECT u.id, u.email, u.name, u.role, u.client_id, u.team_member_id, u.disabled, u.must_change_password, u.last_login_at, u.created_at,
                COALESCE(c.company, c.name) AS client_name, t.name AS team_member_name
           FROM users u LEFT JOIN clients c ON c.id = u.client_id LEFT JOIN team_members t ON t.id = u.team_member_id
          ORDER BY CASE u.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'member' THEN 2 ELSE 3 END, u.name`,
      ),
    });
  });

  /** Creates a login with a one-time temporary password. The password is returned once and never stored in plain text. */
  r.post('/users', async (req, res) => {
    const body = parse(userCreate, req.body);
    if (body.role === 'admin' && req.user!.role !== 'owner') throw forbidden('Only the owner can add admins.');
    if (body.role === 'client') {
      if (!body.client_id) throw badRequest('Pick the client this portal login belongs to.');
      const c = await ctx.db.get<{ archived_at: string | null }>('SELECT archived_at FROM clients WHERE id = :id', { id: body.client_id });
      if (!c) throw badRequest('That client does not exist.');
      if (c.archived_at) throw badRequest('That client is archived.');
    }
    if (body.team_member_id && !await ctx.db.get('SELECT 1 FROM team_members WHERE id = :id', { id: body.team_member_id })) throw badRequest('That team member does not exist.');
    if (await ctx.db.get('SELECT 1 FROM users WHERE email = :email', { email: body.email })) throw conflict('A login with that email already exists.');
    const temporary = generatePassword();
    const hash = await hashPassword(temporary);
    const now = ctx.nowIso();
    const id = await ctx.db.insert('users', {
      name: body.name,
      email: body.email,
      role: body.role,
      client_id: body.role === 'client' ? body.client_id : null,
      team_member_id: body.role === 'client' ? null : body.team_member_id,
      password_hash: hash,
      must_change_password: 1,
      created_at: now,
      updated_at: now,
    });
    await logActivity(ctx, actorOf(req), {
      entity_type: 'user',
      entity_id: id,
      client_id: body.role === 'client' ? body.client_id : null,
      action: 'created',
      summary: body.role === 'client' ? `Portal access created for ${body.name}` : `${body.name} added as ${body.role}`,
    });
    res.status(201).json({ id, temporary_password: temporary });
  });

  r.patch('/users/:id', async (req, res) => {
    const id = idParam(req);
    const u = await ctx.db.get<{ id: number; role: string; name: string }>('SELECT id, role, name FROM users WHERE id = :id', { id });
    if (!u) throw notFound('User');
    const body = parse(userUpdate, req.body);
    if (u.role === 'owner' && (body.role || body.disabled)) throw forbidden('The owner account cannot be demoted or disabled.');
    if (u.role === 'client' && body.role) throw badRequest('Portal logins cannot be turned into staff accounts.');
    if (id === req.user!.id && (body.role || body.disabled)) throw badRequest('You cannot change your own role or disable yourself.');
    if ((u.role === 'admin' || body.role === 'admin') && req.user!.role !== 'owner') throw forbidden('Only the owner can manage admins.');
    await ctx.db.tx(async () => {
      await ctx.db.update('users', id, { ...body, disabled: body.disabled === undefined ? undefined : body.disabled ? 1 : 0, updated_at: ctx.nowIso() });
      if (body.disabled) await ctx.db.run('DELETE FROM sessions WHERE user_id = :id', { id });
    });
    res.json({ ok: true });
  });

  r.post('/users/:id/reset-password', async (req, res) => {
    const id = idParam(req);
    const u = await ctx.db.get<{ role: string; name: string; client_id: number | null }>('SELECT role, name, client_id FROM users WHERE id = :id', { id });
    if (!u) throw notFound('User');
    if (u.role === 'owner' && req.user!.id !== id) throw forbidden('Only the owner can reset the owner password.');
    if (u.role === 'admin' && req.user!.role !== 'owner') throw forbidden('Only the owner can reset an admin password.');
    const temporary = generatePassword();
    const hash = await hashPassword(temporary);
    await ctx.db.tx(async () => {
      await ctx.db.run('UPDATE users SET password_hash = :hash, must_change_password = 1, updated_at = :now WHERE id = :id', { hash, now: ctx.nowIso(), id });
      await ctx.db.run('DELETE FROM sessions WHERE user_id = :id', { id });
      await logActivity(ctx, actorOf(req), { entity_type: 'user', entity_id: id, client_id: u.client_id, action: 'password_reset', summary: `Password reset for ${u.name}` });
    });
    res.json({ temporary_password: temporary });
  });

  r.delete('/users/:id', async (req, res) => {
    const id = idParam(req);
    const u = await ctx.db.get<{ role: string; name: string; client_id: number | null }>('SELECT role, name, client_id FROM users WHERE id = :id', { id });
    if (!u) throw notFound('User');
    if (u.role === 'owner') throw forbidden('The owner account cannot be deleted.');
    if (id === req.user!.id) throw badRequest('You cannot delete your own account.');
    if (u.role === 'admin' && req.user!.role !== 'owner') throw forbidden('Only the owner can remove admins.');
    await ctx.db.tx(async () => {
      await ctx.db.run('DELETE FROM users WHERE id = :id', { id });
      await logActivity(ctx, actorOf(req), { entity_type: 'user', entity_id: id, client_id: u.client_id, action: 'deleted', summary: `Login removed for ${u.name}` });
    });
    res.json({ ok: true });
  });

  // ── Demo data ──
  r.post('/demo', async (req, res) => {
    if ((await demoCounts(ctx)).total > 0) throw conflict('Demo data is already loaded.');
    res.status(201).json({ loaded: await loadDemoData(ctx, actorOf(req)) });
  });

  r.delete('/demo', async (req, res) => {
    res.json({ removed: await removeDemoData(ctx, actorOf(req)) });
  });

  // ── PostgreSQL backup ──
  r.get('/backup', async (_req, res) => {
    const connectionString = ctx.config.databaseUrl;
    if (!connectionString) throw badRequest('PostgreSQL is not configured.');
    const stamp = ctx.nowIso().replace(/[:.]/g, '-');
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="yuvrajfx-agency-${stamp}.dump"`);
    const child = spawn('pg_dump', ['--format=custom', '--no-owner', '--no-privileges'], { env: pgEnvFromUrl(connectionString), stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', (error) => {
      console.error('[backup] pg_dump unavailable or failed to start', error);
      if (!res.headersSent) res.status(503).json({ error: { message: 'PostgreSQL backup utility (pg_dump) is not available on this host. Use your database provider’s backup/export feature.' } });
      else res.destroy(error);
    });
    child.on('close', (code) => {
      if (code !== 0) console.error('[backup] pg_dump failed', stderr);
      if (code !== 0 && !res.headersSent) res.status(500).json({ error: { message: 'PostgreSQL backup failed. Check server logs or use your provider’s backup feature.' } });
    });
    child.stdout.pipe(res);
  });

  return r;
}
