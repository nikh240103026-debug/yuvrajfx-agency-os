import { describe, expect, test } from 'vitest';
import { createClient, createInvoice, makeApp, ok, ownerClient } from './helpers.ts';

type Inv = { id: number; number: string; status: string; state: string; total_minor: number; paid_minor: number; balance_minor: number; tax_lines: { amount_minor: number }[]; items: unknown[]; payments: unknown[] };

describe('invoices', () => {
  test('line items, discount and taxes produce the stored totals; numbers are sequential', async () => {
    const { app } = makeApp();
    const api = await ownerClient(app);
    const cid = await createClient(api, { currency: 'INR', retainer_minor: 8500000 });
    const { invoice } = await createInvoice(api, cid, {
      currency: 'INR',
      discount_type: 'percent',
      discount_percent: 10,
      taxes: [
        { label: 'CGST', rate: 9 },
        { label: 'SGST', rate: 9 },
      ],
      items: [
        { description: 'Reels retainer', quantity: 1, unit_price_minor: 8500000, service_type: 'retainer' },
        { description: 'Extra reels', quantity: 2, unit_price_minor: 1250000, service_type: 'short_form' },
      ],
    });
    const inv = invoice as unknown as Inv & Record<string, number>;
    expect(inv.number).toBe('YFX-0001');
    expect(inv.status).toBe('draft');
    expect(inv.subtotal_minor).toBe(11000000);
    expect(inv.discount_minor).toBe(1100000);
    expect(inv.tax_minor).toBe(1782000);
    expect(inv.total_minor).toBe(11682000);
    expect(inv.tax_lines.map((t) => t.amount_minor)).toEqual([891000, 891000]);
    const second = await createInvoice(api, cid, { currency: 'INR' });
    expect((second.invoice as { number: string }).number).toBe('YFX-0002');
    const dup = await api.post('/api/invoices', { client_id: cid, number: 'YFX-0001', currency: 'INR', issue_date: '2026-10-01', due_date: '2026-10-08', items: [{ description: 'x', quantity: 1, unit_price_minor: 100 }] });
    expect(dup.status).toBe(409);
  });

  test('validation: dates, empty items, negative rates, foreign project', async () => {
    const { app } = makeApp();
    const api = await ownerClient(app);
    const a = await createClient(api);
    const b = await createClient(api, { name: 'Other', company: 'Other Co' });
    const pid = ok<{ id: number }>(await api.post('/api/projects', { client_id: b, name: 'B project', type: 'ad' }), 201).id;
    const base = { client_id: a, currency: 'USD', issue_date: '2026-10-10', due_date: '2026-10-17', items: [{ description: 'x', quantity: 1, unit_price_minor: 100 }] };
    expect((await api.post('/api/invoices', { ...base, due_date: '2026-10-01' })).status).toBe(400);
    expect((await api.post('/api/invoices', { ...base, items: [] })).status).toBe(400);
    expect((await api.post('/api/invoices', { ...base, items: [{ description: 'x', quantity: 1, unit_price_minor: -5 }] })).status).toBe(400);
    expect((await api.post('/api/invoices', { ...base, project_id: pid })).status).toBe(400);
  });

  test('partial payments, balance, paid only when covered, no overpayment, deleting a payment reopens it', async () => {
    const { app, db } = makeApp();
    const api = await ownerClient(app);
    const cid = await createClient(api);
    const { id } = await createInvoice(api, cid, { issue_date: '2026-10-20', due_date: '2026-11-03', items: [{ description: 'Ad', quantity: 1, unit_price_minor: 120000 }] });

    // Recording a payment on a draft issues it (and says so in the activity log).
    let res = ok<{ status: string; balance_minor: number; payment_id: number }>(await api.post(`/api/invoices/${id}/payments`, { amount_minor: 50000, paid_at: '2026-10-21', method: 'wise' }), 201);
    expect(res.status).toBe('partially_paid');
    expect(res.balance_minor).toBe(70000);
    const firstPayment = res.payment_id;

    const over = await api.post(`/api/invoices/${id}/payments`, { amount_minor: 70001, paid_at: '2026-10-22', method: 'wise' });
    expect(over.status).toBe(409);
    expect(over.body.error.message).toMatch(/more than the outstanding balance/);
    expect((await api.post(`/api/invoices/${id}/payments`, { amount_minor: 100, paid_at: '2026-11-15', method: 'wise' })).status).toBe(400); // future date
    expect((await api.post(`/api/invoices/${id}/payments`, { amount_minor: 0, paid_at: '2026-10-22', method: 'wise' })).status).toBe(400);

    res = ok(await api.post(`/api/invoices/${id}/payments`, { amount_minor: 70000, paid_at: '2026-10-25', method: 'paypal', reference: 'PP-1' }), 201);
    expect(res.status).toBe('paid');
    expect(res.balance_minor).toBe(0);
    expect((await api.post(`/api/invoices/${id}/payments`, { amount_minor: 1, paid_at: '2026-10-25', method: 'paypal' })).status).toBe(409);

    // The database itself refuses an overpayment even if application code were bypassed.
    expect(() => db.run(`INSERT INTO payments (invoice_id, client_id, amount_minor, currency, paid_at, method) VALUES (:id, :cid, 1, 'USD', '2026-10-25', 'cash')`, { id, cid })).toThrow(/PAYMENT_EXCEEDS_BALANCE/);
    expect(() => db.run(`INSERT INTO payments (invoice_id, client_id, amount_minor, currency, paid_at, method) VALUES (:id, :cid, 1, 'INR', '2026-10-25', 'cash')`, { id, cid })).toThrow();

    // Lowering the total below what was paid is refused.
    const lower = await api.put(`/api/invoices/${id}`, { client_id: cid, currency: 'USD', issue_date: '2026-10-20', due_date: '2026-11-03', items: [{ description: 'Ad', quantity: 1, unit_price_minor: 100000 }] });
    expect(lower.status).toBe(409);
    // Voiding a paid invoice is refused (payments must be removed first).
    expect((await api.post(`/api/invoices/${id}/void`, {})).status).toBe(409);

    ok(await api.del(`/api/payments/${firstPayment}`));
    const inv = ok<{ invoice: Inv }>(await api.get(`/api/invoices/${id}`)).invoice;
    expect(inv.status).toBe('partially_paid');
    expect(inv.paid_minor).toBe(70000);
    expect(inv.balance_minor).toBe(50000);
    expect(inv.payments).toHaveLength(1);
  });

  test('overdue is derived from the due date and the business timezone', async () => {
    const { app, setNow } = makeApp({ now: '2026-11-03T12:00:00.000Z' });
    const api = await ownerClient(app);
    const cid = await createClient(api);
    const { id } = await createInvoice(api, cid, { issue_date: '2026-10-27', due_date: '2026-11-03' });
    ok(await api.post(`/api/invoices/${id}/send`));
    expect(ok<{ invoice: Inv }>(await api.get(`/api/invoices/${id}`)).invoice.status).toBe('sent');
    // 20:00 UTC on 3 Nov is already 4 Nov in India → overdue.
    setNow('2026-11-03T20:00:00.000Z');
    const inv = ok<{ invoice: Inv & { days_overdue: number } }>(await api.get(`/api/invoices/${id}`)).invoice;
    expect(inv.status).toBe('overdue');
    expect(inv.days_overdue).toBe(1);
    const list = ok<{ invoices: Inv[] }>(await api.get('/api/invoices?status=overdue')).invoices;
    expect(list.map((i) => i.id)).toEqual([id]);
  });

  test('outstanding totals stay per currency', async () => {
    const { app } = makeApp();
    const api = await ownerClient(app);
    const usd = await createClient(api);
    const inr = await createClient(api, { name: 'Priya', company: 'Lumen', currency: 'INR' });
    const a = await createInvoice(api, usd, { items: [{ description: 'x', quantity: 1, unit_price_minor: 100000 }] });
    const b = await createInvoice(api, inr, { currency: 'INR', items: [{ description: 'y', quantity: 1, unit_price_minor: 8500000 }] });
    ok(await api.post(`/api/invoices/${a.id}/send`));
    ok(await api.post(`/api/invoices/${b.id}/send`));
    const totals = ok<{ totals: { outstanding: { currency: string; amount_minor: number }[] } }>(await api.get('/api/invoices')).totals;
    expect(totals.outstanding).toEqual([
      { currency: 'INR', amount_minor: 8500000 },
      { currency: 'USD', amount_minor: 100000 },
    ]);
  });

  test('drafts delete, sent invoices void, duplicates copy lines', async () => {
    const { app } = makeApp();
    const api = await ownerClient(app);
    const cid = await createClient(api);
    const draft = await createInvoice(api, cid);
    const sent = await createInvoice(api, cid);
    ok(await api.post(`/api/invoices/${sent.id}/send`));
    expect((await api.del(`/api/invoices/${sent.id}`)).status).toBe(409);
    ok(await api.post(`/api/invoices/${sent.id}/void`, { reason: 'Issued twice' }));
    expect(ok<{ invoice: Inv }>(await api.get(`/api/invoices/${sent.id}`)).invoice.status).toBe('void');
    expect((await api.post(`/api/invoices/${sent.id}/payments`, { amount_minor: 100, paid_at: '2026-10-20', method: 'cash' })).status).toBe(409);
    ok(await api.del(`/api/invoices/${draft.id}`));
    const copy = ok<{ id: number }>(await api.post(`/api/invoices/${sent.id}/duplicate`), 201);
    const inv = ok<{ invoice: Inv & { issue_date: string } }>(await api.get(`/api/invoices/${copy.id}`)).invoice;
    expect(inv.state).toBe('draft');
    expect(inv.issue_date).toBe('2026-10-27');
    expect(inv.items).toHaveLength(1);
  });

  test('retainer drafts are created once per client per period', async () => {
    const { app } = makeApp();
    const api = await ownerClient(app);
    await createClient(api, { contract_start: '2026-06-01' });
    await createClient(api, { name: 'Q', company: 'Quarterly Co', billing_cycle: 'quarterly', contract_start: '2026-08-01', retainer_minor: 600000 });
    await createClient(api, { name: 'P', company: 'Project Co', retainer_minor: null });
    const preview = ok<{ clients: { client_name: string; due: boolean; existing_invoice: unknown }[] }>(await api.get('/api/invoices/retainer-drafts?month=2026-11')).clients;
    expect(preview.map((p) => p.client_name)).toEqual(['Northwind Creators', 'Quarterly Co']); // Nov is a quarterly cycle month from Aug
    const first = ok<{ ids: number[] }>(await api.post('/api/invoices/retainer-drafts', { month: '2026-11' }), 201);
    expect(first.ids).toHaveLength(2);
    const again = ok<{ ids: number[] }>(await api.post('/api/invoices/retainer-drafts', { month: '2026-11' }), 201);
    expect(again.ids).toHaveLength(0);
    const decPreview = ok<{ clients: { client_name: string }[] }>(await api.get('/api/invoices/retainer-drafts?month=2026-12')).clients;
    expect(decPreview.map((p) => p.client_name)).toEqual(['Northwind Creators']);
    const inv = ok<{ invoice: { total_minor: number; kind: string; period_end: string } }>(await api.get(`/api/invoices/${first.ids[1]}`)).invoice;
    expect(inv.kind).toBe('retainer');
    expect(inv.period_end).toBe('2027-01-31'); // quarterly period
  });

  test('CSV export of invoices and payment history search', async () => {
    const { app } = makeApp();
    const api = await ownerClient(app);
    const cid = await createClient(api);
    const { id } = await createInvoice(api, cid, { due_date: '2026-11-08' });
    ok(await api.post(`/api/invoices/${id}/payments`, { amount_minor: 40000, paid_at: '2026-10-05', method: 'wise', reference: 'WISE-77' }), 201);
    const csv = await api.get('/api/invoices/export.csv');
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.text).toContain('YFX-0001');
    expect(csv.text).toContain('Partially paid');
    const found = ok<{ payments: { reference: string }[] }>(await api.get('/api/payments?q=WISE-77')).payments;
    expect(found).toHaveLength(1);
    expect(ok<{ payments: unknown[] }>(await api.get('/api/payments?q=nothing-like-this')).payments).toHaveLength(0);
  });
});
