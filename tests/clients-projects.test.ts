import { describe, expect, test } from 'vitest';
import { createClient, makeApp, ok, ownerClient } from './helpers.ts';

describe('clients', () => {
  test('create, validate, edit, search, filter by tag and status', async () => {
    const { app } = await makeApp();
    const api = await ownerClient(app);
    const bad = await api.post('/api/clients', { name: '', currency: 'XYZ', website: 'javascript:alert(1)' });
    expect(bad.status).toBe(400);
    expect(Object.keys(bad.body.error.details.fields)).toEqual(expect.arrayContaining(['name', 'currency', 'website']));

    const nw = await createClient(api, { website: 'northwind.test', socials: { youtube: '@northwind', bogus: 'x' } });
    await createClient(api, { name: 'Priya Nair', company: 'Lumen Fitness', email: 'priya@lumen.test', currency: 'INR', retainer_minor: 8500000, tags: ['instagram'], status: 'onboarding' });

    const detail = ok<{ client: Record<string, unknown> }>(await api.get(`/api/clients/${nw}`)).client;
    expect(detail.website).toBe('https://northwind.test/');
    expect(detail.socials).toEqual({ youtube: '@northwind' });
    expect(detail.tags).toEqual(['youtube', 'shorts']);

    ok(await api.patch(`/api/clients/${nw}`, { retainer_minor: 300000, status: 'paused', renewal_date: '2026-12-01' }));
    const updated = ok<{ client: Record<string, unknown> }>(await api.get(`/api/clients/${nw}`)).client;
    expect(updated.retainer_minor).toBe(300000);
    expect(updated.status).toBe('paused');
    expect(updated.name).toBe('Liam Carter'); // untouched by the partial update

    const byTag = ok<{ clients: { company: string }[] }>(await api.get('/api/clients?tag=instagram')).clients;
    expect(byTag.map((c) => c.company)).toEqual(['Lumen Fitness']);
    const bySearch = ok<{ clients: { company: string }[] }>(await api.get('/api/clients?q=northwind')).clients;
    expect(bySearch).toHaveLength(1);
    const byStatus = ok<{ clients: unknown[] }>(await api.get('/api/clients?status=onboarding')).clients;
    expect(byStatus).toHaveLength(1);
    const sorted = ok<{ clients: { company: string }[] }>(await api.get('/api/clients?sort=retainer&order=desc')).clients;
    expect(sorted[0].company).toBe('Lumen Fitness'); // grouped by currency (INR before USD), then by amount
  });

  test('communication log and activity timeline', async () => {
    const { app } = await makeApp();
    const api = await ownerClient(app);
    const id = await createClient(api);
    ok(await api.post(`/api/clients/${id}/communications`, { channel: 'call', direction: 'outbound', subject: 'Check-in', body: 'Talked scope', occurred_at: '2026-10-20' }), 201);
    const items = ok<{ items: { kind: string }[] }>(await api.get(`/api/clients/${id}/timeline`)).items;
    expect(items.map((i) => i.kind)).toEqual(expect.arrayContaining(['communication', 'activity']));
  });

  test('clients with history can be archived but not deleted', async () => {
    const { app } = await makeApp();
    const api = await ownerClient(app);
    const id = await createClient(api);
    ok(await api.post('/api/projects', { client_id: id, name: 'Shorts', type: 'short_form' }), 201);
    expect((await api.del(`/api/clients/${id}`)).status).toBe(409);
    ok(await api.post(`/api/clients/${id}/archive`));
    expect(ok<{ clients: unknown[] }>(await api.get('/api/clients')).clients).toHaveLength(0);
    expect(ok<{ clients: unknown[] }>(await api.get('/api/clients?archived=only')).clients).toHaveLength(1);
  });
});

describe('projects and deliverables', () => {
  test('project with deliverables, stage moves, revision counting and auto-completion', async () => {
    const { app } = await makeApp();
    const api = await ownerClient(app);
    const cid = await createClient(api);
    const editor = ok<{ id: number }>(await api.post('/api/team', { name: 'Dev Arora', title: 'Editor' }), 201).id;
    const pid = ok<{ id: number }>(
      await api.post('/api/projects', {
        client_id: cid,
        name: 'October Shorts',
        type: 'short_form',
        billing_type: 'retainer',
        deadline: '2026-10-31',
        editor_id: editor,
        reference_links: [{ label: 'Board', url: 'boards.test/hooks' }],
        deliverables: [
          { title: 'Short 1', deadline: '2026-10-25', platform: 'youtube_shorts', format: '9:16' },
          { title: 'Short 2', deadline: '2026-10-30', review_url: 'https://frame.test/2' },
        ],
      }),
      201,
    ).id;
    let detail = ok<{ project: Record<string, unknown>; deliverables: Record<string, unknown>[] }>(await api.get(`/api/projects/${pid}`));
    expect(detail.project.currency).toBe('USD'); // inherited from the client
    expect(detail.project.reference_links).toEqual([{ label: 'Board', url: 'https://boards.test/hooks' }]);
    const [d1, d2] = detail.deliverables;
    expect(d1.is_overdue).toBe(1); // due 25 Oct, today is 27 Oct
    expect(d2.is_overdue).toBe(0);
    expect(d1.assignee_name).toBe('Dev Arora'); // falls back to the project editor

    // Kanban moves
    for (const status of ['editing', 'internal_review', 'client_review', 'revisions', 'client_review', 'revisions']) {
      ok(await api.patch(`/api/deliverables/${d1.id}`, { status }));
    }
    let row = ok<{ deliverable: Record<string, unknown> }>(await api.patch(`/api/deliverables/${d1.id}`, { status: 'approved' })).deliverable;
    expect(row.revision_count).toBe(2);
    expect(row.approved_at).toBeTruthy();
    row = ok<{ deliverable: Record<string, unknown> }>(await api.patch(`/api/deliverables/${d1.id}`, { status: 'delivered', final_url: 'drive.test/final1' })).deliverable;
    expect(row.delivered_at).toBeTruthy();
    expect(row.final_url).toBe('https://drive.test/final1');
    expect(row.is_overdue).toBe(0);

    ok(await api.patch(`/api/deliverables/${d2.id}`, { status: 'delivered' }));
    detail = ok(await api.get(`/api/projects/${pid}`));
    expect(detail.project.status).toBe('delivered');
    expect(detail.project.completed_at).toBeTruthy();

    // Reopening a deliverable puts the project back into production.
    ok(await api.patch(`/api/deliverables/${d2.id}`, { status: 'revisions' }));
    detail = ok(await api.get(`/api/projects/${pid}`));
    expect(detail.project.status).toBe('revisions');

    const invalid = await api.patch(`/api/deliverables/${d2.id}`, { status: 'teleported' });
    expect(invalid.status).toBe(400);
  });

  test('revision requests are logged in the history and move the deliverable', async () => {
    const { app } = await makeApp();
    const api = await ownerClient(app);
    const cid = await createClient(api);
    const pid = ok<{ id: number }>(await api.post('/api/projects', { client_id: cid, name: 'Ad', type: 'ad', deliverables: [{ title: 'Ad 30s', status: 'client_review' }] }), 201).id;
    const did = ok<{ deliverables: { id: number }[] }>(await api.get(`/api/projects/${pid}`)).deliverables[0].id;
    ok(await api.post(`/api/projects/${pid}/feedback`, { deliverable_id: did, kind: 'revision_request', body: 'Client wants a faster intro', timecode: '00:03' }), 201);
    ok(await api.post(`/api/projects/${pid}/feedback`, { kind: 'internal_note', body: 'Use the v2 logo' }), 201);
    const detail = ok<{ deliverables: Record<string, unknown>[]; feedback: Record<string, unknown>[] }>(await api.get(`/api/projects/${pid}`));
    expect(detail.deliverables[0].status).toBe('revisions');
    expect(detail.deliverables[0].revision_count).toBe(1);
    expect(detail.feedback.find((f) => f.kind === 'revision_request')!.revision_number).toBe(1);
    expect(detail.feedback.find((f) => f.kind === 'internal_note')!.visible_to_client).toBe(0);
  });

  test('list filters: overdue, editor, scope', async () => {
    const { app } = await makeApp();
    const api = await ownerClient(app);
    const cid = await createClient(api);
    ok(await api.post('/api/projects', { client_id: cid, name: 'Late', type: 'long_form', deadline: '2026-10-20' }), 201);
    ok(await api.post('/api/projects', { client_id: cid, name: 'Fine', type: 'long_form', deadline: '2026-11-20' }), 201);
    ok(await api.post('/api/projects', { client_id: cid, name: 'Done', type: 'thumbnail', status: 'delivered' }), 201);
    const overdue = ok<{ projects: { name: string }[] }>(await api.get('/api/projects?overdue=1')).projects;
    expect(overdue.map((p) => p.name)).toEqual(['Late']);
    expect(ok<{ projects: unknown[] }>(await api.get('/api/projects')).projects).toHaveLength(2);
    expect(ok<{ projects: unknown[] }>(await api.get('/api/projects?scope=done')).projects).toHaveLength(1);
    const cal = ok<{ events: { type: string; overdue: number; title: string }[] }>(await api.get('/api/calendar?from=2026-10-01&to=2026-11-30'));
    expect(cal.events.find((e) => e.title === 'Late')!.overdue).toBe(1);
  });
});
