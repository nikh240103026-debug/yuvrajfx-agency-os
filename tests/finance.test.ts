import { describe, expect, test } from 'vitest';
import { createClient, createInvoice, makeApp, ok, ownerClient, type Api } from './helpers.ts';

type G = { currency: string; amount_minor: number }[];

async function seed(api: Api) {
  const usd = await createClient(api, { retainer_minor: 240000 });
  const inr = await createClient(api, { name: 'Priya', company: 'Lumen', currency: 'INR', retainer_minor: 8500000 });
  await createClient(api, { name: 'Q', company: 'Quarterly', currency: 'USD', retainer_minor: 600000, billing_cycle: 'quarterly' });
  await createClient(api, { name: 'Gone', company: 'Churned Co', currency: 'USD', retainer_minor: 999900, status: 'churned' });
  // USD: invoiced 1,000 + 500 in October, 800 collected in October
  const a = await createInvoice(api, usd, { issue_date: '2026-10-02', due_date: '2026-10-09', items: [{ description: 'Retainer', quantity: 1, unit_price_minor: 100000, service_type: 'retainer' }] });
  const b = await createInvoice(api, usd, { issue_date: '2026-10-15', due_date: '2026-11-15', items: [{ description: 'Ad', quantity: 1, unit_price_minor: 50000, service_type: 'ad' }] });
  ok(await api.post(`/api/invoices/${a.id}/payments`, { amount_minor: 80000, paid_at: '2026-10-05', method: 'wise' }), 201);
  ok(await api.post(`/api/invoices/${b.id}/send`));
  // INR: ₹85,000 + 18% GST invoiced in October, paid in full; a September invoice paid in October
  const c = await createInvoice(api, inr, { currency: 'INR', issue_date: '2026-10-03', due_date: '2026-10-18', taxes: [{ label: 'GST', rate: 18 }], items: [{ description: 'Reels', quantity: 1, unit_price_minor: 8500000, service_type: 'retainer' }] });
  ok(await api.post(`/api/invoices/${c.id}/payments`, { amount_minor: 10030000, paid_at: '2026-10-10', method: 'bank_transfer' }), 201);
  const d = await createInvoice(api, inr, { currency: 'INR', issue_date: '2026-09-20', due_date: '2026-09-27', items: [{ description: 'Thumbnails', quantity: 4, unit_price_minor: 250000, service_type: 'thumbnail' }] });
  ok(await api.post(`/api/invoices/${d.id}/payments`, { amount_minor: 1000000, paid_at: '2026-10-01', method: 'upi' }), 201);
  // A draft never counts.
  await createInvoice(api, usd, { issue_date: '2026-10-20', due_date: '2026-10-27', items: [{ description: 'Draft', quantity: 1, unit_price_minor: 999999 }] });
  // Expenses in two currencies
  ok(await api.post('/api/expenses', { date: '2026-10-02', category: 'software', amount_minor: 423000, currency: 'INR', description: 'Adobe CC' }), 201);
  ok(await api.post('/api/expenses', { date: '2026-10-04', category: 'software', amount_minor: 1500, currency: 'USD', description: 'Frame.io' }), 201);
  ok(await api.post('/api/expenses', { date: '2026-09-04', category: 'hardware', amount_minor: 1450000, currency: 'INR', description: 'SSD' }), 201);
  return { usd, inr };
}

describe('financial analytics', () => {
  test('cash collected, invoiced revenue, receivables and expenses are separate and per currency', async () => {
    const { app } = await makeApp();
    const api = await ownerClient(app);
    await seed(api);
    const s = ok<{
      collected: G;
      invoiced: { net: G; tax: G; gross: G; count: number };
      expenses: G;
      net_cash_flow: G;
      estimated_profit: G;
      receivables: { outstanding: G; overdue: G; overdue_count: number; aging: { key: string; groups: G }[] };
      mrr: { groups: G; clients: number };
      fx: unknown;
    }>(await api.get('/api/finance/summary?period=month&date=2026-10-27'));

    expect(s.collected).toEqual([
      { currency: 'INR', amount_minor: 10030000 + 1000000 },
      { currency: 'USD', amount_minor: 80000 },
    ]);
    // Invoiced counts issued invoices by issue date, excluding tax; the draft and the September invoice are out.
    expect(s.invoiced.net).toEqual([
      { currency: 'INR', amount_minor: 8500000 },
      { currency: 'USD', amount_minor: 150000 },
    ]);
    expect(s.invoiced.tax).toEqual([{ currency: 'INR', amount_minor: 1530000 }]);
    expect(s.expenses).toEqual([
      { currency: 'INR', amount_minor: 423000 },
      { currency: 'USD', amount_minor: 1500 },
    ]);
    expect(s.net_cash_flow).toEqual([
      { currency: 'INR', amount_minor: 11030000 - 423000 },
      { currency: 'USD', amount_minor: 80000 - 1500 },
    ]);
    expect(s.estimated_profit).toEqual([
      { currency: 'INR', amount_minor: 8500000 - 423000 },
      { currency: 'USD', amount_minor: 150000 - 1500 },
    ]);
    // Receivables as of today: USD 200 left on invoice a (overdue since 9 Oct) + 500 on b (not yet due).
    expect(s.receivables.outstanding).toEqual([{ currency: 'USD', amount_minor: 70000 }]);
    expect(s.receivables.overdue).toEqual([{ currency: 'USD', amount_minor: 20000 }]);
    expect(s.receivables.aging.find((b) => b.key === '1_30')!.groups).toEqual([{ currency: 'USD', amount_minor: 20000 }]);
    // MRR: contracted retainers of active clients, quarterly normalised to monthly, churned excluded. Not cash.
    expect(s.mrr.groups).toEqual([
      { currency: 'INR', amount_minor: 8500000 },
      { currency: 'USD', amount_minor: 240000 + 200000 },
    ]);
    expect(s.mrr.clients).toBe(3);
    expect(s.fx).toBeNull(); // no rates set → no blended figure at all
  });

  test('revenue by client, by service and by month', async () => {
    const { app } = await makeApp();
    const api = await ownerClient(app);
    const { usd } = await seed(api);
    const s = ok<{
      by_client: { client_id: number; collected: G; invoiced: G }[];
      by_service: { service: string; invoiced: G; collected: G }[];
      series: { currencies: string[]; months: { month: string; collected: G; invoiced: G; expenses: G }[] };
    }>(await api.get('/api/finance/summary?period=quarter&date=2026-10-27'));
    expect(s.by_client.find((c) => c.client_id === usd)!.collected).toEqual([{ currency: 'USD', amount_minor: 80000 }]);
    const retainer = s.by_service.find((x) => x.service === 'retainer')!;
    expect(retainer.invoiced).toEqual([
      { currency: 'INR', amount_minor: 8500000 },
      { currency: 'USD', amount_minor: 100000 },
    ]);
    // INR cash on the GST invoice is attributed to its one retainer line (tax included in cash).
    expect(retainer.collected).toEqual([
      { currency: 'INR', amount_minor: 10030000 },
      { currency: 'USD', amount_minor: 80000 },
    ]);
    expect(s.by_service.find((x) => x.service === 'thumbnail')!.collected).toEqual([{ currency: 'INR', amount_minor: 1000000 }]);
    expect(s.series.months.map((m) => m.month)).toEqual(['2026-10', '2026-11', '2026-12']);
    expect(s.series.currencies).toEqual(['INR', 'USD']);
  });

  test('owner exchange rates give a labelled estimate; reports export to CSV', async () => {
    const { app } = await makeApp();
    const api = await ownerClient(app);
    await seed(api);
    ok(await api.put('/api/settings', { fx_rates: { USD: 84 }, fx_as_of: '2026-10-01' }));
    const s = ok<{ fx: { base: string; rates: Record<string, number> } }>(await api.get('/api/finance/summary?period=month&date=2026-10-27'));
    expect(s.fx).toEqual({ base: 'INR', rates: { USD: 84 }, as_of: '2026-10-01' });
    expect((await api.put('/api/settings', { fx_rates: { ZZZ: 2 } })).status).toBe(400);

    const report = ok<{ period: { label: string }; previous_period: { label: string }; operations: Record<string, number> }>(await api.get('/api/finance/report?period=quarter&date=2026-10-27'));
    expect(report.period.label).toBe('Q4 2026');
    expect(report.previous_period.label).toBe('Q3 2026');
    const annual = ok<{ summary: { collected: G } }>(await api.get('/api/finance/report?period=year&date=2026-10-27'));
    expect(annual.summary.collected).toEqual([
      { currency: 'INR', amount_minor: 11030000 },
      { currency: 'USD', amount_minor: 80000 },
    ]);
    const csv = await api.get('/api/finance/report.csv?period=month&date=2026-10-27');
    expect(csv.status).toBe(200);
    expect(csv.text).toContain('Cash collected,INR,110300.00');
    expect(csv.text).toContain('Cash collected,USD,800.00');
    expect(csv.text).toContain('MRR (contracted, not collected)');
  });

  test('dashboard metrics come from the data, per currency', async () => {
    const { app } = await makeApp();
    const api = await ownerClient(app);
    const empty = ok<{ has_any_data: boolean; finance: { collected_month: G; mrr: { groups: G } } }>(await api.get('/api/dashboard'));
    expect(empty.has_any_data).toBe(false);
    expect(empty.finance.collected_month).toEqual([]);
    expect(empty.finance.mrr.groups).toEqual([]);
    await seed(api);
    const d = ok<{ counts: Record<string, number>; finance: { collected_month: G; expenses_month: G; net_month: G; receivables: { overdue_count: number } }; next_actions: { kind: string }[] }>(
      await api.get('/api/dashboard'),
    );
    expect(d.counts.active_clients).toBe(3);
    expect(d.finance.collected_month).toEqual([
      { currency: 'INR', amount_minor: 11030000 },
      { currency: 'USD', amount_minor: 80000 },
    ]);
    expect(d.finance.receivables.overdue_count).toBe(1);
    expect(d.next_actions.some((a) => a.kind === 'invoice_overdue')).toBe(true);
    expect(d.next_actions.some((a) => a.kind === 'drafts')).toBe(true);
  });
});
