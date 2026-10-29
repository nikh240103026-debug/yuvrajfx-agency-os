import { describe, expect, test } from 'vitest';
import { client, makeApp, ok, ownerClient } from './helpers.ts';
import { runAutomations } from '../src/server/services/automations.ts';

// Every read endpoint, exercised against the full demo dataset. The DB layer throws on any query
// that references a parameter it was not given, so this also guards against silent NULL filters.
describe('smoke: every read endpoint works on a populated database', () => {
  test('staff endpoints', async () => {
    const { app, ctx } = await makeApp();
    const api = await ownerClient(app);
    ok(await api.post('/api/settings/demo'), 201);
    await runAutomations(ctx, 'manual');
    const clientId = ok<{ clients: { id: number }[] }>(await api.get('/api/clients')).clients[0].id;
    const projectId = ok<{ projects: { id: number }[] }>(await api.get('/api/projects')).projects[0].id;
    const invoiceId = ok<{ invoices: { id: number }[] }>(await api.get('/api/invoices')).invoices[0].id;
    const leadId = ok<{ leads: { id: number }[] }>(await api.get('/api/leads')).leads[0].id;
    const memberId = ok<{ members: { id: number }[] }>(await api.get('/api/team')).members[0].id;
    const snapshotId = ok<{ snapshots: { id: number }[] }>(await api.get('/api/finance/snapshots')).snapshots[0]?.id;
    const urls = [
      '/api/auth/state',
      '/api/dashboard',
      '/api/clients?sort=activity&order=desc',
      '/api/clients?status=active&tag=shorts&q=north',
      '/api/clients?archived=only',
      '/api/clients/tags',
      '/api/clients/export.csv',
      `/api/clients/${clientId}`,
      `/api/clients/${clientId}/timeline`,
      '/api/team',
      `/api/team/${memberId}`,
      '/api/projects?scope=all',
      '/api/projects?scope=done',
      '/api/projects?scope=archived',
      '/api/projects?overdue=1&priority=high&type=short_form',
      `/api/projects?client_id=${clientId}&editor_id=${memberId}`,
      '/api/projects/export.csv',
      `/api/projects/${projectId}`,
      '/api/deliverables',
      '/api/deliverables?overdue=1',
      '/api/deliverables?include_delivered=1&q=short',
      '/api/deliverables?delivered_since=2026-10-01',
      `/api/deliverables?assignee_id=${memberId}&due_from=2026-10-01&due_to=2026-12-31`,
      '/api/deliverables/export.csv',
      '/api/invoices',
      '/api/invoices?status=open',
      '/api/invoices?status=overdue&currency=USD',
      `/api/invoices?client_id=${clientId}&from=2026-01-01&to=2026-12-31&q=YFX`,
      '/api/invoices/meta',
      '/api/invoices/export.csv',
      '/api/invoices/retainer-drafts?month=2026-11',
      `/api/invoices/${invoiceId}`,
      '/api/payments',
      '/api/payments?method=wise&currency=USD&from=2026-01-01&to=2026-12-31&q=WISE',
      '/api/payments/export.csv',
      '/api/expenses',
      '/api/expenses?category=software&currency=INR&from=2026-01-01&to=2026-12-31&q=adobe',
      '/api/expenses/export.csv',
      '/api/finance/summary?period=month',
      '/api/finance/summary?period=quarter&date=2026-08-15',
      '/api/finance/summary?period=year',
      '/api/finance/summary?period=custom&from=2026-05-01&to=2026-10-27',
      '/api/finance/report?period=month',
      '/api/finance/report?period=year',
      '/api/finance/report.csv?period=quarter',
      '/api/finance/snapshots',
      ...(snapshotId ? [`/api/finance/snapshots/${snapshotId}`] : []),
      '/api/leads',
      '/api/leads?status=open&follow_up=overdue',
      '/api/leads?follow_up=today&stage=proposal_sent&source=cold_email&deal_type=retainer&q=a',
      '/api/leads?status=closed',
      '/api/leads/metrics',
      '/api/leads/metrics?from=2026-01-01&to=2026-12-31',
      '/api/leads/export.csv',
      `/api/leads/${leadId}`,
      '/api/tasks',
      '/api/tasks?view=today',
      '/api/tasks?view=upcoming',
      '/api/tasks?view=overdue',
      '/api/tasks?view=done',
      `/api/tasks?view=all&assignee_id=${memberId}&client_id=${clientId}&q=e`,
      '/api/tasks/export.csv',
      '/api/recurring',
      '/api/calendar?from=2026-10-01&to=2026-11-30',
      '/api/notifications',
      '/api/notifications?unread=1&limit=5',
      '/api/notifications/count',
      '/api/activity',
      `/api/activity?client_id=${clientId}&entity_type=invoice`,
      '/api/search?q=north',
      '/api/automations',
      '/api/outbox',
      '/api/outbox?status=pending_approval',
      '/api/settings',
      '/api/settings/users',
    ];
    for (const url of urls) {
      const res = await api.get(url);
      expect(res.status, `${url} → ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`).toBe(200);
    }
  });

  test('search finds projects by client name and keeps finance records admin-only', async () => {
    const { app } = await makeApp();
    const owner = await ownerClient(app);
    ok(await owner.post('/api/settings/demo'), 201);
    const types = (body: { results: { type: string; subtitle: string | null }[] }) => new Set(body.results.map((r) => r.type));
    const asOwner = ok<{ results: { type: string; subtitle: string | null }[] }>(await owner.get('/api/search?q=Lumen'));
    expect(types(asOwner)).toEqual(new Set(['client', 'project', 'task', 'invoice']));
    expect(asOwner.results.filter((r) => r.type === 'project').every((r) => r.subtitle === 'Lumen Fitness')).toBe(true);
    const { temporary_password } = ok<{ temporary_password: string }>(await owner.post('/api/settings/users', { name: 'Ed', email: 'ed@yfx.test', role: 'member' }), 201);
    const member = client(app);
    ok(await member.post('/api/auth/login', { email: 'ed@yfx.test', password: temporary_password }));
    ok(await member.post('/api/auth/change-password', { current_password: temporary_password, new_password: 'member password long enough' }));
    const asMember = types(ok(await member.get('/api/search?q=Lumen')));
    expect(asMember.has('project')).toBe(true);
    expect(asMember.has('invoice') || asMember.has('lead')).toBe(false);
  });

  test('portal endpoints', async () => {
    const { app } = await makeApp();
    const owner = await ownerClient(app);
    ok(await owner.post('/api/settings/demo'), 201);
    const c = ok<{ clients: { id: number; company: string }[] }>(await owner.get('/api/clients')).clients.find((x) => x.company === 'Northwind Creators')!;
    const { temporary_password } = ok<{ temporary_password: string }>(await owner.post('/api/settings/users', { name: 'Liam', email: 'liam@portal.test', role: 'client', client_id: c.id }), 201);
    const portal = client(app);
    ok(await portal.post('/api/auth/login', { email: 'liam@portal.test', password: temporary_password }));
    ok(await portal.post('/api/auth/change-password', { current_password: temporary_password, new_password: 'portal password long enough' }));
    const me = ok<{ counts: Record<string, number> }>(await portal.get('/api/portal/me'));
    expect(me.counts.awaiting_review).toBeGreaterThan(0);
    const projects = ok<{ projects: { id: number }[] }>(await portal.get('/api/portal/projects')).projects;
    ok(await portal.get(`/api/portal/projects/${projects[0].id}`));
    const invoices = ok<{ invoices: { id: number }[] }>(await portal.get('/api/portal/invoices')).invoices;
    expect(invoices.length).toBeGreaterThan(3);
    ok(await portal.get(`/api/portal/invoices/${invoices[0].id}`));
  });
});
