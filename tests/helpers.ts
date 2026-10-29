import request from 'supertest';
import { expect } from 'vitest';
import { Db } from '../src/server/db/db.ts';
import { migratePostgres } from '../src/server/db/postgres-migrations.ts';
import { Pool } from 'pg';
import { createContext } from '../src/server/context.ts';
import { createApp } from '../src/server/app.ts';
import { createMailer, createRecordingMailer } from '../src/server/services/mailer.ts';
import type { Config } from '../src/server/config.ts';

// Integration tests require a disposable PostgreSQL database, never the production database.
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required for PostgreSQL-backed tests. Use a disposable database named yuvraj_agency_test.');
const dbName = new URL(TEST_DATABASE_URL).pathname.replace(/^\//, '');
if (dbName !== 'yuvraj_agency_test') throw new Error('Safety check failed: TEST_DATABASE_URL must target yuvraj_agency_test.');
let schemaCounter = 0;
const testSchemas = new Set<string>();
const testDbs = new Set<Db>();
let testsCleanedUp = false;
process.on('beforeExit', async () => {
  if (testsCleanedUp) return;
  testsCleanedUp = true;
  for (const db of testDbs) await db.close().catch(() => undefined);
  const pool = new Pool({ connectionString: TEST_DATABASE_URL, allowExitOnIdle: true });
  try { for (const schema of testSchemas) await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } finally { await pool.end(); }
});

// Cheap password hashing for tests only (production uses N = 32768).
process.env.YFX_SCRYPT_N = '1024';

export const OWNER = { name: 'Test Owner', email: 'owner@yfx.test', password: 'correct horse battery staple' };

/** A fresh app on an in-memory database with a controllable clock (default: 27 Oct 2026, noon IST). */
export async function makeApp(opts: { now?: string; recordingMailer?: boolean } = {}) {
  const schema = `yfx_test_${process.pid}_${++schemaCounter}`;
  const bootstrap = new Pool({ connectionString: TEST_DATABASE_URL, allowExitOnIdle: true });
  try { await bootstrap.query(`CREATE SCHEMA ${schema}`); } finally { await bootstrap.end(); }
  testSchemas.add(schema);
  const db = new Db(TEST_DATABASE_URL!, schema);
  testDbs.add(db);
  await migratePostgres(db.pool);
  let now = new Date(opts.now ?? '2026-10-27T06:30:00.000Z');
  const mailer = opts.recordingMailer ? createRecordingMailer() : createMailer(null);
  const config: Config = { host: '127.0.0.1', port: 0, databaseUrl: TEST_DATABASE_URL!, cookieSecure: false, isDev: false, smtp: null };
  const ctx = createContext({ db, config, mailer, clock: { now: () => now } });
  const app = createApp(ctx);
  return {
    app,
    ctx,
    db,
    mailer,
    setNow(iso: string) {
      now = new Date(iso);
    },
  };
}

export type Api = ReturnType<typeof client>;

/** Supertest agent that keeps cookies and sends the app's CSRF header on writes. */
export function client(app: Parameters<typeof request.agent>[0]) {
  const agent = request.agent(app);
  const h = (r: request.Test) => r.set('X-Requested-With', 'yfx');
  return {
    agent,
    get: (url: string) => agent.get(url),
    post: (url: string, body: object = {}) => h(agent.post(url)).send(body),
    put: (url: string, body: object = {}) => h(agent.put(url)).send(body),
    patch: (url: string, body: object = {}) => h(agent.patch(url)).send(body),
    del: (url: string) => h(agent.delete(url)),
  };
}

export async function ownerClient(app: Parameters<typeof request.agent>[0], baseCurrency = 'INR') {
  const api = client(app);
  const res = await api.post('/api/auth/setup', {
    name: OWNER.name,
    email: OWNER.email,
    password: OWNER.password,
    business_name: 'YuvrajFX',
    base_currency: baseCurrency,
    timezone: 'Asia/Kolkata',
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return api;
}

export function ok<T = Record<string, unknown>>(res: request.Response, status = 200): T {
  expect(res.status, `${res.status} ${JSON.stringify(res.body)}`).toBe(status);
  return res.body as T;
}

export async function createClient(api: Api, overrides: Record<string, unknown> = {}) {
  const body = ok<{ id: number }>(
    await api.post('/api/clients', {
      name: 'Liam Carter',
      company: 'Northwind Creators',
      email: 'liam@northwind.test',
      currency: 'USD',
      retainer_minor: 240000,
      billing_cycle: 'monthly',
      payment_terms_days: 7,
      status: 'active',
      tags: ['YouTube', 'shorts'],
      ...overrides,
    }),
    201,
  );
  return body.id;
}

export async function createInvoice(api: Api, clientId: number, overrides: Record<string, unknown> = {}) {
  const body = ok<{ id: number; invoice: Record<string, unknown> }>(
    await api.post('/api/invoices', {
      client_id: clientId,
      currency: 'USD',
      issue_date: '2026-10-01',
      due_date: '2026-10-08',
      items: [{ description: 'October retainer', quantity: 1, unit_price_minor: 100000, service_type: 'retainer' }],
      ...overrides,
    }),
    201,
  );
  return body;
}
