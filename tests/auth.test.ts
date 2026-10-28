import { describe, expect, test } from 'vitest';
import request from 'supertest';
import { client, makeApp, ok, OWNER, ownerClient } from './helpers.ts';

describe('authentication', () => {
  test('first-run setup creates the owner once, then only sign-in works', async () => {
    const { app } = makeApp();
    const anon = client(app);
    expect(ok<{ needs_setup: boolean }>(await anon.get('/api/auth/state')).needs_setup).toBe(true);
    const owner = await ownerClient(app);
    const state = ok<{ needs_setup: boolean; user: { role: string } }>(await owner.get('/api/auth/state'));
    expect(state.needs_setup).toBe(false);
    expect(state.user.role).toBe('owner');
    // A second setup is refused, even with valid data.
    const again = await client(app).post('/api/auth/setup', { name: 'X', email: 'x@y.test', password: 'another long password', business_name: 'X', base_currency: 'USD', timezone: 'UTC' });
    expect(again.status).toBe(409);
  });

  test('behind a tunnel: setup is refused, cookies are Secure, rate limit is per visitor IP', async () => {
    const { app } = makeApp();
    const setup = { name: 'X', email: 'x@y.test', password: 'another long password', business_name: 'X', base_currency: 'USD', timezone: 'UTC' };
    const viaTunnel = await client(app).post('/api/auth/setup', setup).set('Cf-Connecting-Ip', '203.0.113.9');
    expect(viaTunnel.status).toBe(403);
    await ownerClient(app);
    const login = await request(app).post('/api/auth/login').set('X-Requested-With', 'yfx').set('Cf-Connecting-Ip', '203.0.113.9').set('X-Forwarded-Proto', 'https').send({ email: OWNER.email, password: OWNER.password });
    expect(login.status).toBe(200);
    expect(String(login.headers['set-cookie'])).toMatch(/Secure/);
    const local = await request(app).post('/api/auth/login').set('X-Requested-With', 'yfx').send({ email: OWNER.email, password: OWNER.password });
    expect(String(local.headers['set-cookie'])).not.toMatch(/Secure/);
    // One visitor hammering the login does not lock out a different visitor.
    for (let i = 0; i < 10; i++) await request(app).post('/api/auth/login').set('X-Requested-With', 'yfx').set('Cf-Connecting-Ip', '198.51.100.1').send({ email: OWNER.email, password: 'wrong password here' });
    expect((await request(app).post('/api/auth/login').set('X-Requested-With', 'yfx').set('Cf-Connecting-Ip', '198.51.100.1').send({ email: OWNER.email, password: OWNER.password })).status).toBe(429);
    expect((await request(app).post('/api/auth/login').set('X-Requested-With', 'yfx').set('Cf-Connecting-Ip', '198.51.100.2').send({ email: OWNER.email, password: OWNER.password })).status).toBe(200);
  });

  test('weak passwords are rejected at setup', async () => {
    const { app } = makeApp();
    const res = await client(app).post('/api/auth/setup', { name: 'Y', email: 'y@y.test', password: 'short', business_name: 'Y', base_currency: 'INR', timezone: 'Asia/Kolkata' });
    expect(res.status).toBe(400);
    expect(res.body.error.details.fields.password).toBeTruthy();
  });

  test('login, wrong password, logout', async () => {
    const { app } = makeApp();
    await ownerClient(app);
    const c = client(app);
    expect((await c.post('/api/auth/login', { email: OWNER.email, password: 'wrong password!!' })).status).toBe(401);
    ok(await c.post('/api/auth/login', { email: OWNER.email.toUpperCase(), password: OWNER.password }));
    ok(await c.get('/api/dashboard'));
    ok(await c.post('/api/auth/logout'));
    expect((await c.get('/api/dashboard')).status).toBe(401);
  });

  test('API requires a session and the CSRF header on writes', async () => {
    const { app } = makeApp();
    expect((await request(app).get('/api/clients')).status).toBe(401);
    const owner = await ownerClient(app);
    // Same session, but a write without the app header (what a cross-site form would send) is blocked.
    const res = await owner.agent.post('/api/clients').send({ name: 'X', currency: 'USD' });
    expect(res.status).toBe(403);
    const crossOrigin = await owner.agent.post('/api/clients').set('X-Requested-With', 'yfx').set('Origin', 'https://evil.example').send({ name: 'X', currency: 'USD' });
    expect(crossOrigin.status).toBe(403);
  });

  test('repeated failed logins are rate-limited', async () => {
    const { app } = makeApp();
    await ownerClient(app);
    const c = client(app);
    for (let i = 0; i < 10; i++) await c.post('/api/auth/login', { email: OWNER.email, password: `nope-nope-${i}` });
    const blocked = await c.post('/api/auth/login', { email: OWNER.email, password: OWNER.password });
    expect(blocked.status).toBe(429);
  });

  test('team members cannot reach money or settings, and see no prices', async () => {
    const { app } = makeApp();
    const owner = await ownerClient(app);
    const cid = ok<{ id: number }>(await owner.post('/api/clients', { name: 'Ava', currency: 'USD', retainer_minor: 100000 }), 201).id;
    ok(await owner.post('/api/projects', { client_id: cid, name: 'Ad', type: 'ad', price_minor: 50000 }), 201);
    const created = ok<{ temporary_password: string }>(await owner.post('/api/settings/users', { name: 'Dev', email: 'dev@yfx.test', role: 'member' }), 201);
    const member = client(app);
    ok(await member.post('/api/auth/login', { email: 'dev@yfx.test', password: created.temporary_password }));
    // Must set a real password before anything else.
    expect((await member.get('/api/projects')).status).toBe(403);
    ok(await member.post('/api/auth/change-password', { current_password: created.temporary_password, new_password: 'a brand new long password' }));
    const projects = ok<{ projects: Record<string, unknown>[] }>(await member.get('/api/projects')).projects;
    expect(projects[0].price_minor).toBeUndefined();
    const clients = ok<{ clients: Record<string, unknown>[] }>(await member.get('/api/clients')).clients;
    expect(clients[0].retainer_minor).toBeUndefined();
    for (const url of ['/api/invoices', '/api/payments', '/api/expenses', '/api/finance/summary', '/api/leads', '/api/settings', '/api/automations']) {
      expect((await member.get(url)).status, url).toBe(403);
    }
    const dash = ok<{ finance: unknown }>(await member.get('/api/dashboard'));
    expect(dash.finance).toBeNull();
  });
});
