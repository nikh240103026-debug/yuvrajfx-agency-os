import { describe, expect, test } from 'vitest';
import { createClient, makeApp, ok, ownerClient } from './helpers.ts';

type G = { currency: string; amount_minor: number }[];

describe('sales pipeline', () => {
  test('duplicate detection against leads and clients, with explicit override', async () => {
    const { app } = await makeApp();
    const api = await ownerClient(app);
    await createClient(api, { website: 'https://www.northwind.test' });
    ok(await api.post('/api/leads', { name: 'Ava Collins', company: 'Brightside Labs Inc.', email: 'ava@brightside.test', currency: 'USD' }), 201);

    const byEmail = await api.post('/api/leads', { name: 'A. Collins', email: 'AVA@brightside.test', currency: 'USD' });
    expect(byEmail.status).toBe(409);
    expect(byEmail.body.error.details.duplicates[0].matched_on).toContain('email');
    const byCompany = ok<{ duplicates: { type: string; matched_on: string[] }[] }>(await api.post('/api/leads/check-duplicates', { company: 'brightside labs' }));
    expect(byCompany.duplicates[0].matched_on).toEqual(['company']);
    const byDomain = ok<{ duplicates: { type: string }[] }>(await api.post('/api/leads/check-duplicates', { website: 'northwind.test/about' }));
    expect(byDomain.duplicates[0].type).toBe('client');
    // Shared platforms are not identities: two different YouTube channels are not duplicates by domain.
    expect(ok<{ duplicates: unknown[] }>(await api.post('/api/leads/check-duplicates', { website: 'youtube.com/@someone' })).duplicates).toHaveLength(0);
    const forced = ok<{ id: number; duplicates: unknown[] }>(await api.post('/api/leads', { name: 'A. Collins', email: 'ava@brightside.test', currency: 'USD', force: true }), 201);
    expect(forced.duplicates.length).toBeGreaterThan(0);
  });

  test('stages, history, weighted value per currency, conversion and win/loss', async () => {
    const { app } = await makeApp();
    const api = await ownerClient(app);
    const mk = async (name: string, stage: string, value: number, currency = 'USD', deal_type = 'retainer') =>
      ok<{ id: number }>(await api.post('/api/leads', { name, company: `${name} Co`, stage, estimated_value_minor: value, currency, deal_type, source: 'cold_email' }), 201).id;
    const a = await mk('A', 'lead', 100000);
    const b = await mk('B', 'proposal_sent', 200000);
    await mk('C', 'negotiation', 5000000, 'INR');
    const d = await mk('D', 'contacted', 90000, 'USD', 'one_time');

    // B wins, D is lost after a discovery call.
    ok(await api.patch(`/api/leads/${b}`, { stage: 'negotiation' }));
    ok(await api.patch(`/api/leads/${b}`, { stage: 'won', outcome_reason: 'Loved the sample edit' }));
    ok(await api.patch(`/api/leads/${d}`, { stage: 'discovery_call' }));
    ok(await api.patch(`/api/leads/${d}`, { stage: 'lost', outcome_reason: 'Budget' }));

    const m = ok<{
      value: { total: G; weighted: G; retainer_monthly: G; one_time: G; open_count: number };
      funnel: { stage: string; reached: number }[];
      win_rate: number;
      won: number;
      lost: number;
      loss_reasons: { reason: string; count: number }[];
      win_reasons: { reason: string }[];
    }>(await api.get('/api/leads/metrics'));
    expect(m.value.open_count).toBe(2);
    expect(m.value.total).toEqual([
      { currency: 'INR', amount_minor: 5000000 },
      { currency: 'USD', amount_minor: 100000 },
    ]);
    expect(m.value.weighted).toEqual([
      { currency: 'INR', amount_minor: 3500000 }, // 70% at negotiation
      { currency: 'USD', amount_minor: 5000 }, // 5% at lead
    ]);
    const reached = Object.fromEntries(m.funnel.map((f) => [f.stage, f.reached]));
    expect(reached).toMatchObject({ lead: 4, contacted: 3, replied: 3, discovery_call: 3, proposal_sent: 2, negotiation: 2, won: 1 });
    expect(m.won).toBe(1);
    expect(m.lost).toBe(1);
    expect(m.win_rate).toBe(0.5);
    expect(m.loss_reasons).toEqual([{ reason: 'Budget', count: 1 }]);
    expect(m.win_reasons[0].reason).toBe('Loved the sample edit');
    const detail = ok<{ history: { to_stage: string }[] }>(await api.get(`/api/leads/${b}`));
    expect(detail.history.map((h) => h.to_stage)).toEqual(['proposal_sent', 'negotiation', 'won']);
    void a;
  });

  test('logging outreach updates last contact, follow-up and advances early stages', async () => {
    const { app } = await makeApp();
    const api = await ownerClient(app);
    const id = ok<{ id: number }>(await api.post('/api/leads', { name: 'Karan', company: 'Stackwise', currency: 'INR' }), 201).id;
    ok(await api.post(`/api/leads/${id}/activities`, { channel: 'email', direction: 'outbound', subject: 'Intro', occurred_at: '2026-10-25', next_follow_up: '2026-10-27' }), 201);
    let lead = ok<{ lead: Record<string, unknown>; outreach: unknown[] }>(await api.get(`/api/leads/${id}`));
    expect(lead.lead.stage).toBe('contacted');
    expect(lead.lead.last_contact_at).toBe('2026-10-25');
    expect(lead.lead.next_follow_up).toBe('2026-10-27');
    expect(lead.outreach).toHaveLength(1);
    ok(await api.post(`/api/leads/${id}/activities`, { channel: 'dm', direction: 'inbound', occurred_at: '2026-10-26' }), 201);
    lead = ok(await api.get(`/api/leads/${id}`));
    expect(lead.lead.stage).toBe('replied');
    const due = ok<{ leads: { id: number }[] }>(await api.get('/api/leads?follow_up=due')).leads;
    expect(due.map((l) => l.id)).toEqual([id]);
  });

  test('won lead converts into a client with its outreach history', async () => {
    const { app } = await makeApp();
    const api = await ownerClient(app);
    const id = ok<{ id: number }>(await api.post('/api/leads', { name: 'Noah Kim', company: 'Pixel Forge', email: 'noah@pixelforge.test', estimated_value_minor: 220000, currency: 'USD', stage: 'negotiation', social_url: 'https://youtube.com/@pixelforge' }), 201).id;
    ok(await api.post(`/api/leads/${id}/activities`, { channel: 'call', occurred_at: '2026-10-20' }), 201);
    const { client_id } = ok<{ client_id: number }>(await api.post(`/api/leads/${id}/convert`, { outcome_reason: 'Referral + fast turnaround' }), 201);
    const c = ok<{ client: Record<string, unknown>; lead: { id: number } }>(await api.get(`/api/clients/${client_id}`));
    expect(c.client.company).toBe('Pixel Forge');
    expect(c.client.retainer_minor).toBe(220000);
    expect(c.client.status).toBe('onboarding');
    expect(c.client.socials).toEqual({ youtube: 'https://youtube.com/@pixelforge' });
    expect(c.lead.id).toBe(id);
    const timeline = ok<{ items: { kind: string }[] }>(await api.get(`/api/clients/${client_id}/timeline`)).items;
    expect(timeline.some((t) => t.kind === 'communication')).toBe(true);
    expect((await api.post(`/api/leads/${id}/convert`)).status).toBe(409);
    expect(ok<{ lead: { stage: string } }>(await api.get(`/api/leads/${id}`)).lead.stage).toBe('won');
  });

  test('CSV import: preview with validation and duplicates, import skips them, export round-trips', async () => {
    const { app } = await makeApp();
    const api = await ownerClient(app);
    ok(await api.post('/api/leads', { name: 'Existing', company: 'Kettle & Co', email: 'hello@kettle.test', currency: 'INR' }), 201);
    const csv = [
      'Full Name,Company,Email,Website,Lead Source,Deal Value,Currency,Stage,Follow Up,Notes',
      'Grace Lee,Daybreak Travel,grace@daybreak.test,daybreak.test,Website,"1,800",USD,Lead,2026-11-02,"Launch film, 90s"',
      'Rohan Gupta,Kettle and Co,rohan@kettle.test,,Instagram,60000,INR,Discovery Call,03/11/2026,',
      'Broken Row,,not-an-email,,,abc,USD,,,',
      'Sofia Alvarez,Verde Skincare,sofia@verde.test,,Clutch,1200,EUR,Contacted,,',
      'Sofia Again,Verde Skincare,sofia2@verde.test,,,,EUR,,,',
    ].join('\n');
    const preview = ok<{ rows: { row: number; lead: Record<string, unknown> | null; errors: string[]; duplicates: unknown[]; duplicate_in_file: number | null; warnings: string[] }[] }>(
      await api.post('/api/leads/import/preview', { csv, default_currency: 'USD' }),
    );
    const [grace, rohan, broken, sofia, again] = preview.rows;
    expect(grace.lead).toMatchObject({ name: 'Grace Lee', source: 'website', estimated_value_minor: 180000, stage: 'lead', next_follow_up: '2026-11-02', website: 'https://daybreak.test/' });
    expect(rohan.duplicates.length).toBe(1); // "Kettle and Co" ≈ "Kettle & Co"
    expect(rohan.lead).toMatchObject({ stage: 'discovery_call', next_follow_up: '2026-11-03', currency: 'INR' });
    expect(broken.lead).toBeNull();
    expect(broken.errors.length).toBeGreaterThanOrEqual(2);
    expect(sofia.lead).toMatchObject({ source: 'other', notes: 'Source: Clutch' });
    expect(again.duplicate_in_file).toBe(5);

    const result = ok<{ imported: number; skipped: number }>(await api.post('/api/leads/import', { csv, default_currency: 'USD' }));
    expect(result).toEqual({ imported: 2, skipped: 3 });
    const exported = await api.get('/api/leads/export.csv');
    expect(exported.text).toContain('Daybreak Travel');
    expect(exported.text).toContain('1800.00');
    // Re-importing the export finds everything as duplicates.
    const reimport = ok<{ imported: number }>(await api.post('/api/leads/import', { csv: exported.text }));
    expect(reimport.imported).toBe(0);
  });
});
