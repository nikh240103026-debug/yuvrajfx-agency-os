import { describe, expect, test } from 'vitest';
import { client, createClient, createInvoice, makeApp, ok, ownerClient, type Api } from './helpers.ts';

/** Two clients, each with a project, deliverables, invoices and a portal login. */
async function world() {
  const { app } = await makeApp();
  const owner = await ownerClient(app);
  const a = await createClient(owner, { name: 'Liam Carter', company: 'Northwind', email: 'liam@northwind.test' });
  const b = await createClient(owner, { name: 'Priya Nair', company: 'Lumen', email: 'priya@lumen.test', currency: 'INR' });
  const mkProject = async (cid: number, name: string) =>
    ok<{ id: number }>(
      await owner.post('/api/projects', {
        client_id: cid,
        name,
        type: 'short_form',
        price_minor: 99900,
        description: 'INTERNAL brief',
        deliverables: [
          { title: `${name} — in edit`, status: 'editing', review_url: 'https://frame.test/early-cut', source_url: 'https://drive.test/raw', notes: 'INTERNAL note' },
          { title: `${name} — for review`, status: 'client_review', review_url: 'https://frame.test/review', final_url: 'https://drive.test/final-not-yet' },
          { title: `${name} — done`, status: 'delivered', final_url: 'https://drive.test/final' },
        ],
      }),
      201,
    ).id;
  const pa = await mkProject(a, 'Northwind shorts');
  const pb = await mkProject(b, 'Lumen reels');
  const hidden = ok<{ id: number }>(await owner.post('/api/projects', { client_id: a, name: 'Hidden project', type: 'ad', portal_visible: false }), 201).id;
  ok(await owner.post(`/api/projects/${pa}/feedback`, { kind: 'internal_note', body: 'INTERNAL: client is slow to pay' }), 201);
  const invA = await createInvoice(owner, a, { due_date: '2026-11-10', internal_notes: 'INTERNAL invoice note' });
  ok(await owner.post(`/api/invoices/${invA.id}/send`));
  const draftA = await createInvoice(owner, a);
  const invB = await createInvoice(owner, b, { currency: 'INR' });
  ok(await owner.post(`/api/invoices/${invB.id}/send`));

  const portalLogin = async (cid: number, email: string): Promise<Api> => {
    const { temporary_password } = ok<{ temporary_password: string }>(await owner.post('/api/settings/users', { name: email.split('@')[0], email, role: 'client', client_id: cid }), 201);
    const api = client(app);
    ok(await api.post('/api/auth/login', { email, password: temporary_password }));
    ok(await api.post('/api/auth/change-password', { current_password: temporary_password, new_password: 'my own long portal password' }));
    return api;
  };
  const portalA = await portalLogin(a, 'liam@northwind.test');
  const portalB = await portalLogin(b, 'priya@lumen.test');
  return { app, owner, a, b, pa, pb, hidden, invA, draftA, invB, portalA, portalB };
}

describe('client portal isolation', () => {
  test('a client sees only their own visible projects, with internal fields removed', async () => {
    const w = await world();
    const projects = ok<{ projects: { id: number; name: string }[] }>(await w.portalA.get('/api/portal/projects')).projects;
    expect(projects.map((p) => p.name)).toEqual(['Northwind shorts']);
    const body = ok<{ project: Record<string, unknown>; deliverables: Record<string, unknown>[]; feedback: { body: string }[] }>(await w.portalA.get(`/api/portal/projects/${w.pa}`));
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('INTERNAL');
    expect(raw).not.toContain('99900');
    expect(raw).not.toContain('drive.test/raw');
    const [inEdit, forReview, done] = body.deliverables;
    expect(inEdit.review_url).toBeNull(); // early cuts are not exposed before review
    expect(forReview.review_url).toBe('https://frame.test/review');
    expect(forReview.final_url).toBeNull(); // not approved yet
    expect(done.final_url).toBe('https://drive.test/final');
    expect(forReview.status_label).toBe('Ready for your review');
    expect(inEdit.status_label).toBe('In production');
  });

  test("guessing another client's ids returns 404, never data", async () => {
    const w = await world();
    expect((await w.portalA.get(`/api/portal/projects/${w.pb}`)).status).toBe(404);
    expect((await w.portalA.get(`/api/portal/projects/${w.hidden}`)).status).toBe(404);
    expect((await w.portalA.get(`/api/portal/invoices/${w.invB.id}`)).status).toBe(404);
    expect((await w.portalA.get(`/api/portal/invoices/${w.draftA.id}`)).status).toBe(404); // drafts stay private
    const bDeliverables = ok<{ deliverables: { id: number }[] }>(await w.owner.get(`/api/projects/${w.pb}`)).deliverables;
    for (const d of bDeliverables) {
      expect((await w.portalA.post(`/api/portal/deliverables/${d.id}/approve`)).status).toBe(404);
      expect((await w.portalA.post(`/api/portal/deliverables/${d.id}/feedback`, { body: 'hi' })).status).toBe(404);
      expect((await w.portalA.post(`/api/portal/deliverables/${d.id}/request-changes`, { body: 'x' })).status).toBe(404);
    }
    const invoices = ok<{ invoices: { id: number; number: string }[] }>(await w.portalA.get('/api/portal/invoices')).invoices;
    expect(invoices.map((i) => i.id)).toEqual([w.invA.id]);
    const inv = ok<{ invoice: Record<string, unknown> }>(await w.portalA.get(`/api/portal/invoices/${w.invA.id}`)).invoice;
    expect(JSON.stringify(inv)).not.toContain('INTERNAL');
  });

  test('portal users cannot reach any staff endpoint', async () => {
    const w = await world();
    for (const url of ['/api/clients', `/api/clients/${w.a}`, `/api/projects/${w.pa}`, '/api/invoices', '/api/dashboard', '/api/search?q=Lumen', '/api/deliverables', '/api/notifications', '/api/team']) {
      expect((await w.portalA.get(url)).status, url).toBe(403);
    }
    expect((await w.portalA.patch(`/api/deliverables/1`, { status: 'approved' })).status).toBe(403);
    // …and staff cannot use the portal API.
    expect((await w.owner.get('/api/portal/projects')).status).toBe(403);
  });

  test('review flow: approve, request changes, comment — staff are notified', async () => {
    const w = await world();
    const ds = ok<{ deliverables: { id: number; status: string; can_review: boolean }[] }>(await w.portalA.get(`/api/portal/projects/${w.pa}`)).deliverables;
    const review = ds.find((d) => d.can_review)!;
    const inEdit = ds.find((d) => d.status === 'editing')!;
    expect((await w.portalA.post(`/api/portal/deliverables/${inEdit.id}/approve`)).status).toBe(409);
    ok(await w.portalA.post(`/api/portal/deliverables/${review.id}/request-changes`, { body: 'Make the hook punchier', timecode: '00:02' }));
    let staffView = ok<{ deliverables: { id: number; status: string; revision_count: number }[]; feedback: { kind: string; author_type: string }[] }>(await w.owner.get(`/api/projects/${w.pa}`));
    expect(staffView.deliverables.find((d) => d.id === review.id)).toMatchObject({ status: 'revisions', revision_count: 1 });
    expect(staffView.feedback[0]).toMatchObject({ kind: 'revision_request', author_type: 'client' });
    // Cannot approve while it is in revisions; the team re-submits it for review first.
    expect((await w.portalA.post(`/api/portal/deliverables/${review.id}/approve`)).status).toBe(409);
    ok(await w.owner.patch(`/api/deliverables/${review.id}`, { status: 'client_review' }));
    ok(await w.portalA.post(`/api/portal/deliverables/${review.id}/approve`, { body: 'Perfect' }));
    ok(await w.portalA.post(`/api/portal/deliverables/${inEdit.id}/feedback`, { body: 'Excited for this one' }), 201);
    staffView = ok(await w.owner.get(`/api/projects/${w.pa}`));
    expect(staffView.deliverables.find((d) => d.id === review.id)!.status).toBe('approved');
    const notes = ok<{ notifications: { kind: string }[] }>(await w.owner.get('/api/notifications')).notifications.map((n) => n.kind);
    expect(notes).toEqual(expect.arrayContaining(['client_revision', 'client_approval', 'client_feedback']));
    // The other client never sees any of it.
    const other = ok<{ feedback: unknown[] }>(await w.portalB.get(`/api/portal/projects/${w.pb}`)).feedback;
    expect(other).toHaveLength(0);
  });

  test('archiving a client cuts off portal access immediately', async () => {
    const w = await world();
    ok(await w.owner.post(`/api/clients/${w.a}/archive`));
    expect((await w.portalA.get('/api/portal/projects')).status).toBe(401);
    expect((await client(w.app).post('/api/auth/login', { email: 'liam@northwind.test', password: 'my own long portal password' })).status).toBe(401);
  });
});
