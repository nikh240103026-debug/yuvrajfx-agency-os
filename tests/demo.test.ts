import { describe, expect, test } from 'vitest';
import { createClient, makeApp, ok, ownerClient } from './helpers.ts';
import { runAutomations } from '../src/server/services/automations.ts';

describe('demo data', () => {
  test('loads clearly flagged data, powers every view, and removes cleanly', async () => {
    const { app, ctx } = await makeApp();
    const api = await ownerClient(app);
    const real = await createClient(api, { name: 'Real Person', company: 'Real Client Co' });
    const loaded = ok<{ loaded: Record<string, number> }>(await api.post('/api/settings/demo'), 201).loaded;
    expect(loaded.clients).toBe(6);
    expect(loaded.invoices).toBeGreaterThan(15);
    expect((await api.post('/api/settings/demo')).status).toBe(409);
    await runAutomations(ctx, 'manual');

    const dash = ok<{ demo_data: boolean; finance: { mrr: { groups: { currency: string }[] }; receivables: { overdue_count: number } }; next_actions: unknown[]; counts: Record<string, number> }>(await api.get('/api/dashboard'));
    expect(dash.demo_data).toBe(true);
    expect(dash.finance.mrr.groups.map((g) => g.currency).sort()).toEqual(['INR', 'USD']); // Copperleaf (EUR) is still onboarding
    expect(dash.finance.receivables.overdue_count).toBe(2);
    expect(dash.counts.overdue_deliverables).toBeGreaterThan(0);
    expect(dash.next_actions.length).toBeGreaterThan(3);

    // Every invoice's stored totals and payments obey the invariants.
    const bad = await ctx.db.all(`SELECT id FROM invoice_balances WHERE balance_minor < 0 OR (state = 'draft' AND paid_minor > 0)`);
    expect(bad).toHaveLength(0);
    const metrics = ok<{ won: number; lost: number; funnel: { reached: number }[] }>(await api.get('/api/leads/metrics'));
    expect(metrics.won).toBe(2);
    expect(metrics.lost).toBe(2);
    const clients = ok<{ clients: { is_demo: number }[] }>(await api.get('/api/clients')).clients;
    expect(clients.filter((c) => c.is_demo === 1)).toHaveLength(6);

    ok(await api.del('/api/settings/demo'));
    const counts = ok<{ system: { demo: Record<string, number> } }>(await api.get('/api/settings')).system.demo;
    for (const [table, n] of Object.entries(counts)) expect(n, table).toBe(0);
    const left = ok<{ clients: { id: number }[] }>(await api.get('/api/clients')).clients;
    expect(left.map((c) => c.id)).toEqual([real]);
  });

  test('refuses to remove demo clients that real records depend on', async () => {
    const { app } = await makeApp();
    const api = await ownerClient(app);
    ok(await api.post('/api/settings/demo'), 201);
    const demoClient = ok<{ clients: { id: number; is_demo: number }[] }>(await api.get('/api/clients')).clients.find((c) => c.is_demo)!;
    ok(await api.post('/api/projects', { client_id: demoClient.id, name: 'My real project', type: 'ad' }), 201);
    expect((await api.del('/api/settings/demo')).status).toBe(409);
  });
});
