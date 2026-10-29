import { describe, expect, test } from 'vitest';
import { createClient, createInvoice, makeApp, ok, OWNER, ownerClient } from './helpers.ts';
import { runAutomations } from '../src/server/services/automations.ts';

describe('tasks', () => {
  test('today, overdue and upcoming views', async () => {
    const { app } = await makeApp();
    const api = await ownerClient(app);
    ok(await api.post('/api/tasks', { title: 'Late', due_date: '2026-10-20', priority: 'high' }), 201);
    ok(await api.post('/api/tasks', { title: 'Today', due_date: '2026-10-27' }), 201);
    ok(await api.post('/api/tasks', { title: 'Later', due_date: '2026-11-05' }), 201);
    const done = ok<{ id: number }>(await api.post('/api/tasks', { title: 'Done already', due_date: '2026-10-01' }), 201).id;
    ok(await api.patch(`/api/tasks/${done}`, { status: 'done' }));
    const view = async (v: string) => ok<{ tasks: { title: string }[] }>(await api.get(`/api/tasks?view=${v}`)).tasks.map((t) => t.title);
    expect(await view('today')).toEqual(['Late', 'Today']); // today includes anything overdue
    expect(await view('overdue')).toEqual(['Late']);
    expect(await view('upcoming')).toEqual(['Later']);
    expect(await view('done')).toEqual(['Done already']);
    const counts = ok<{ counts: Record<string, number> }>(await api.get('/api/tasks')).counts;
    expect(counts).toMatchObject({ today: 2, overdue: 1, upcoming: 1, open: 3, done: 1 });
  });

  test('recurring tasks are generated once per occurrence; long gaps do not flood', async () => {
    const { app, ctx, setNow } = await makeApp({ now: '2026-10-27T06:30:00.000Z' });
    const api = await ownerClient(app);
    const rule = ok<{ id: number; generated: { tasks: number } }>(
      await api.post('/api/recurring', { kind: 'task', title: 'Send {{month}} retainer invoices', frequency: 'monthly', month_day: 1, start_date: '2026-10-27', lead_days: 5, template: { priority: 'high' } }),
      201,
    );
    // 1 Nov is within the 5-day lead window from 27 Oct.
    expect(rule.generated.tasks).toBe(1);
    const titles = ok<{ tasks: { title: string; due_date: string; source: string }[] }>(await api.get('/api/tasks?view=all')).tasks;
    expect(titles).toEqual([expect.objectContaining({ title: 'Send November 2026 retainer invoices', due_date: '2026-11-01', source: 'recurring' })]);
    await runAutomations(ctx, 'manual');
    await runAutomations(ctx, 'manual');
    expect(ok<{ tasks: unknown[] }>(await api.get('/api/tasks?view=all')).tasks).toHaveLength(1);

    // Six months later: only the latest missed occurrence (plus the next one inside the lead window) appears.
    setNow('2027-04-29T06:30:00.000Z');
    await runAutomations(ctx, 'manual');
    ok(await api.post('/api/auth/login', { email: OWNER.email, password: OWNER.password })); // the old session expired
    const later = ok<{ tasks: { title: string; due_date: string }[] }>(await api.get('/api/tasks?view=all')).tasks;
    expect(later.map((t) => t.due_date)).toEqual(['2026-11-01', '2027-04-01', '2027-05-01']);
  });

  test('recurring projects copy their template and deliverables', async () => {
    const { app, ctx } = await makeApp();
    const api = await ownerClient(app);
    const cid = await createClient(api);
    ok(
      await api.post('/api/recurring', {
        kind: 'project',
        title: '{{month}} Shorts Pack',
        frequency: 'monthly',
        month_day: 1,
        start_date: '2026-10-01',
        lead_days: 0,
        template: { client_id: cid, type: 'short_form', billing_type: 'retainer', deadline_offset_days: 27, deliverables: [{ title: 'Short #1', deadline_offset_days: 5 }, { title: 'Short #2', deadline_offset_days: 9 }] },
      }),
      201,
    );
    await runAutomations(ctx, 'manual');
    const projects = ok<{ projects: { id: number; name: string; deadline: string; deliverable_count: number }[] }>(await api.get('/api/projects')).projects;
    expect(projects).toEqual([expect.objectContaining({ name: 'October 2026 Shorts Pack', deadline: '2026-10-28', deliverable_count: 2 })]);
    const bad = await api.post('/api/recurring', { kind: 'project', title: 'X', frequency: 'monthly', start_date: '2026-10-01', template: { type: 'ad' } });
    expect(bad.status).toBe(400);
  });
});

describe('automations', () => {
  test('overdue invoices: in-app alert + a reminder drafted for approval, never sent on its own', async () => {
    const { app, ctx, mailer } = await makeApp({ recordingMailer: true });
    const api = await ownerClient(app);
    const cid = await createClient(api);
    const { id } = await createInvoice(api, cid, { issue_date: '2026-10-01', due_date: '2026-10-08' });
    ok(await api.post(`/api/invoices/${id}/send`));
    const run = await runAutomations(ctx, 'manual');
    expect(run.status).toBe('ok');
    expect((run.summary.overdue_invoice_reminders as Record<string, number>).reminders_drafted).toBe(1);
    await runAutomations(ctx, 'manual'); // idempotent

    const notes = ok<{ notifications: { kind: string; title: string }[]; unread: number }>(await api.get('/api/notifications'));
    expect(notes.notifications.filter((n) => n.kind === 'invoice_overdue')).toHaveLength(1);
    const outbox = ok<{ messages: { id: number; status: string; to_address: string; subject: string; body: string }[] }>(await api.get('/api/outbox')).messages;
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ status: 'pending_approval', to_address: 'liam@northwind.test' });
    expect(outbox[0].body).toContain('19 days ago');
    expect((mailer as unknown as { sent: unknown[] }).sent).toHaveLength(0);

    // Only an explicit approval sends it.
    ok(await api.post(`/api/outbox/${outbox[0].id}/approve-send`));
    expect((mailer as unknown as { sent: { to: string }[] }).sent).toEqual([expect.objectContaining({ to: 'liam@northwind.test' })]);
    expect((await api.post(`/api/outbox/${outbox[0].id}/approve-send`)).status).toBe(409);
    ok(await api.post('/api/notifications/read', { ids: 'all' }));
    expect(ok<{ unread: number }>(await api.get('/api/notifications/count')).unread).toBe(0);
  });

  test('without SMTP the approval button refuses and offers the manual route', async () => {
    const { app, ctx } = await makeApp();
    const api = await ownerClient(app);
    const cid = await createClient(api);
    const { id } = await createInvoice(api, cid);
    ok(await api.post(`/api/invoices/${id}/send`));
    await runAutomations(ctx, 'manual');
    const msg = ok<{ messages: { id: number }[]; email: { configured: boolean } }>(await api.get('/api/outbox'));
    expect(msg.email.configured).toBe(false);
    const res = await api.post(`/api/outbox/${msg.messages[0].id}/approve-send`);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/not set up/);
    ok(await api.post(`/api/outbox/${msg.messages[0].id}/mark-sent`));
    expect(ok<{ messages: { status: string }[] }>(await api.get('/api/outbox')).messages[0].status).toBe('sent_manually');
  });

  test('deadline, renewal and follow-up reminders; weekly and monthly snapshots once', async () => {
    const { app, ctx } = await makeApp();
    const api = await ownerClient(app);
    const cid = await createClient(api, { renewal_date: '2026-11-05' });
    ok(await api.post('/api/projects', { client_id: cid, name: 'P', type: 'ad', deliverables: [{ title: 'Due tomorrow', deadline: '2026-10-28' }, { title: 'Overdue', deadline: '2026-10-25' }, { title: 'Far', deadline: '2026-12-01' }] }), 201);
    ok(await api.post('/api/leads', { name: 'Lead', currency: 'USD', next_follow_up: '2026-10-26' }), 201);
    const run = await runAutomations(ctx, 'manual');
    expect(run.summary.deadline_reminders).toMatchObject({ due_soon: 1, deliverables_overdue: 1 });
    expect(run.summary.renewal_reminders).toMatchObject({ renewals_notified: 1, tasks_created: 1 });
    expect(run.summary.follow_up_reminders).toMatchObject({ follow_ups_notified: 1 });
    expect(run.summary.weekly_report).toMatchObject({ snapshots: 1 });
    expect(run.summary.monthly_revenue_summary).toMatchObject({ snapshots: 1 });
    const again = await runAutomations(ctx, 'manual');
    expect(again.summary.weekly_report).toMatchObject({ snapshots: 0 });
    const snaps = ok<{ snapshots: { kind: string; period_start: string; period_end: string }[] }>(await api.get('/api/finance/snapshots')).snapshots;
    expect(snaps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'weekly', period_start: '2026-10-19', period_end: '2026-10-25' }),
        expect.objectContaining({ kind: 'monthly', period_start: '2026-09-01', period_end: '2026-09-30' }),
      ]),
    );
    // Disabled automations do nothing.
    ok(await api.patch('/api/automations/deadline_reminders', { enabled: false }));
    expect(await runAutomations(ctx, 'manual').summary.deadline_reminders).toBe('disabled');
  });
});
