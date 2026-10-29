import type { AppContext } from '../context.ts';
import { logActivity, type Actor } from '../lib/activity.ts';
import { conflict } from '../lib/http.ts';
import { computeInvoiceTotals, type TaxLine } from '../../shared/money.ts';
import { addDays, addMonths, endOfMonth, monthLabel, startOfMonth } from '../../shared/dates.ts';
import { firstOccurrence } from './recurrence.ts';
import type { LeadStage } from '../../shared/constants.ts';

// Clearly labelled sample data so the app can be explored before real data goes in.
// Every row is flagged is_demo = 1, shown with a "Demo" badge, and removable in one click.
// Companies use the reserved .example domain, so none of them can be a real business.

const DEMO_TABLES = ['clients', 'team_members', 'projects', 'deliverables', 'invoices', 'payments', 'expenses', 'leads', 'tasks', 'recurring_rules', 'feedback', 'communications', 'activity', 'notifications', 'outbox', 'report_snapshots'] as const;

export async function demoCounts(ctx: AppContext) {
  const counts: Record<string, number> = {};
  let total = 0;
  for (const t of DEMO_TABLES) {
    counts[t] = await ctx.db.value<number>(`SELECT COUNT(*) FROM ${t} WHERE is_demo = 1`) ?? 0;
    if (t === 'clients' || t === 'leads' || t === 'team_members') total += counts[t];
  }
  return { ...counts, total };
}

export async function demoPresent(ctx: AppContext): Promise<boolean> {
  return !!await ctx.db.get('SELECT 1 FROM clients WHERE is_demo = 1 UNION ALL SELECT 1 FROM leads WHERE is_demo = 1 LIMIT 1');
}

export async function loadDemoData(ctx: AppContext, actor: Actor) {
  const today = await ctx.today();
  const ts =(date: string, hour = 11) => `${date}T${String(hour).padStart(2, '0')}:${String((date.charCodeAt(9) * 7) % 60).padStart(2, '0')}:00.000Z`;
  const monthStart = startOfMonth(today);
  const db = ctx.db;
  const D = { is_demo: 1 };
  const activity = async (date: string, entry: Parameters<typeof logActivity>[2], hour = 10) => {
    await db.insert('activity', {
      entity_type: entry.entity_type,
      entity_id: entry.entity_id,
      client_id: entry.client_id ?? null,
      project_id: entry.project_id ?? null,
      action: entry.action,
      summary: entry.summary,
      meta: {},
      actor_type: 'user',
      actor_id: actor.id,
      actor_name: actor.name,
      is_demo: 1,
      created_at: ts(date, hour),
    });
  };

  return db.tx(async () => {
    // ── Team ──
    const team = async (name: string, title: string, capacity: number, color: string, skills: string[], cost?: [number, string, string]) =>
      await db.insert('team_members', {
        name,
        title,
        capacity_hours: capacity,
        color,
        skills,
        email: `${name.split(' ')[0].toLowerCase()}@yuvrajfx-team.example`,
        cost_rate_minor: cost?.[0] ?? null,
        cost_currency: cost?.[1] ?? null,
        cost_unit: cost?.[2] ?? null,
        status: 'active',
        ...D,
        created_at: ts(addMonths(today, -9)),
        updated_at: ts(addMonths(today, -9)),
      });
    const kabir = await team('Kabir Mehta', 'Lead editor', 40, '#9085e9', ['long-form', 'color', 'sound'], [150000, 'INR', 'hour']);
    const sara = await team('Sara Iqbal', 'Motion designer', 32, '#199e70', ['after effects', 'motion graphics', 'ads'], [200000, 'INR', 'hour']);
    const dev = await team('Dev Arora', 'Short-form editor', 40, '#d95926', ['shorts', 'captions', 'premiere'], [90000, 'INR', 'video']);
    const mira = await team('Mira Kapoor', 'Thumbnail designer', 20, '#3987e5', ['thumbnails', 'photoshop'], [70000, 'INR', 'video']);

    // ── Clients ──
    type C = { name: string; company: string; email: string; currency: string; retainer: number | null; pkg: string | null; status: string; months: number; renewalIn: number | null; terms: number; tags: string[]; website: string; socials: Record<string, string>; country: string; tax_id?: string };
    const clientDefs: C[] = [
      { name: 'Liam Carter', company: 'Northwind Creators', email: 'liam@northwind.example', currency: 'USD', retainer: 240000, pkg: 'Shorts Growth · 12 shorts/mo', status: 'active', months: 8, renewalIn: 10, terms: 7, tags: ['youtube', 'shorts', 'priority'], website: 'https://northwind.example', socials: { youtube: '@northwindcreators' }, country: 'United States' },
      { name: 'Priya Nair', company: 'Lumen Fitness', email: 'priya@lumenfitness.example', currency: 'INR', retainer: 8500000, pkg: 'Reels Studio · 16 reels/mo', status: 'active', months: 5, renewalIn: 40, terms: 15, tags: ['instagram', 'fitness'], website: 'https://lumenfitness.example', socials: { instagram: '@lumen.fitness' }, country: 'India', tax_id: '27AAACL0000L1Z5' },
      { name: 'Marcus Reed', company: 'Atlas Money Show', email: 'marcus@atlasmoney.example', currency: 'USD', retainer: 380000, pkg: 'Long-form · 4 episodes/mo', status: 'active', months: 11, renewalIn: 25, terms: 7, tags: ['long-form', 'finance', 'priority'], website: 'https://atlasmoney.example', socials: { youtube: '@atlasmoneyshow' }, country: 'United Kingdom' },
      { name: 'Elena Rossi', company: 'Copperleaf Studio', email: 'elena@copperleaf.example', currency: 'EUR', retainer: 150000, pkg: 'Ad Creative · 6 ads/mo', status: 'onboarding', months: 0, renewalIn: null, terms: 14, tags: ['ads', 'e-commerce'], website: 'https://copperleaf.example', socials: { instagram: '@copperleaf.studio' }, country: 'Italy' },
      { name: 'Jay Thompson', company: 'Orbit Gaming', email: 'jay@orbitgaming.example', currency: 'USD', retainer: null, pkg: 'Project-based', status: 'paused', months: 4, renewalIn: null, terms: 7, tags: ['gaming'], website: 'https://orbitgaming.example', socials: { youtube: '@orbitgaming' }, country: 'Canada' },
      { name: 'Ananya Rao', company: 'Saffron Kitchen', email: 'ananya@saffronkitchen.example', currency: 'INR', retainer: 4500000, pkg: 'Recipe Shorts · 8 shorts/mo', status: 'active', months: 3, renewalIn: 60, terms: 7, tags: ['food', 'shorts'], website: 'https://saffronkitchen.example', socials: { instagram: '@saffron.kitchen' }, country: 'India' },
    ];
    const clients = await Promise.all(clientDefs.map(async (c) => {
      const start = startOfMonth(addMonths(today, -c.months));
      return {
        ...c,
        start,
        id: await db.insert('clients', {
          name: c.name,
          company: c.company,
          email: c.email,
          phone: null,
          website: c.website,
          socials: c.socials,
          country: c.country,
          tax_id: c.tax_id ?? null,
          service_package: c.pkg,
          retainer_minor: c.retainer,
          currency: c.currency,
          billing_cycle: 'monthly',
          contract_start: start,
          renewal_date: c.renewalIn === null ? null : addDays(today, c.renewalIn),
          payment_terms_days: c.terms,
          status: c.status,
          tags: c.tags,
          notes: c.company === 'Northwind Creators' ? 'Prefers Frame.io for reviews. Captions: yellow, bold, centered.' : null,
          ...D,
          created_at: ts(start),
          updated_at: ts(start),
        }),
      };
    }));
    const [northwind, lumen, atlas, copperleaf, orbit, saffron] = clients;
    for (const c of clients) await activity(c.start, { entity_type: 'client', entity_id: c.id, client_id: c.id, action: 'created', summary: `Client ${c.company} added` });

    // ── Projects & deliverables ──
    type Dl = { title: string; status: string; due: number | null; platform?: string; format?: string; revisions?: number; assignee?: number; review?: boolean; final?: boolean; hours?: number };
    const project = async (client: (typeof clients)[number], p: { name: string; type: string; billing: string; price?: number; status: string; editor: number | null; priority: string; startOffset: number; deadline: number | null; description?: string; refs?: { label: string; url: string }[] }, dls: Dl[]) => {
      const start = addDays(today, p.startOffset);
      const id = await db.insert('projects', {
        client_id: client.id,
        name: p.name,
        description: p.description ?? null,
        type: p.type,
        billing_type: p.billing,
        price_minor: p.price ?? null,
        currency: client.currency,
        start_date: start,
        deadline: p.deadline === null ? null : addDays(today, p.deadline),
        priority: p.priority,
        status: p.status,
        editor_id: p.editor,
        reference_links: p.refs ?? [],
        asset_links: [{ label: 'Raw footage (Drive)', url: `https://drive.example/${client.company.toLowerCase().replace(/\s+/g, '-')}/raw` }],
        completed_at: p.status === 'delivered' ? ts(addDays(today, (p.deadline ?? 0) - 1)) : null,
        ...D,
        created_at: ts(start),
        updated_at: ts(start),
      });
      await activity(start, { entity_type: 'project', entity_id: id, client_id: client.id, project_id: id, action: 'created', summary: `Project “${p.name}” created with ${dls.length} deliverables` });
      const ids = await Promise.all(dls.map(async (d, i) => {
        const slug = d.title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
        const approved = d.status === 'approved' || d.status === 'delivered';
        return db.insert('deliverables', {
          project_id: id,
          title: d.title,
          format: d.format ?? (p.type === 'long_form' ? '16:9 horizontal · 4K' : p.type === 'thumbnail' ? 'Thumbnail · 1280×720' : '9:16 vertical · 1080×1920'),
          platform: d.platform ?? (p.type === 'long_form' ? 'youtube' : p.type === 'ad' ? 'meta_ads' : p.type === 'thumbnail' ? 'youtube' : 'youtube_shorts'),
          deadline: d.due === null ? null : addDays(today, d.due),
          status: d.status,
          assignee_id: d.assignee ?? null,
          source_url: `https://drive.example/${slug}/source`,
          review_url: ['client_review', 'revisions', 'approved', 'delivered'].includes(d.status) || d.review ? `https://review.example/${slug}` : null,
          final_url: d.status === 'delivered' || d.final ? `https://delivery.example/${slug}` : null,
          revision_count: d.revisions ?? (d.status === 'revisions' ? 1 : 0),
          estimated_hours: d.hours ?? (p.type === 'long_form' ? 14 : p.type === 'thumbnail' ? 1.5 : p.type === 'ad' ? 6 : 3),
          sort_order: i,
          approved_at: approved ? ts(addDays(today, (d.due ?? 0) - 1)) : null,
          delivered_at: d.status === 'delivered' ? ts(addDays(today, d.due ?? 0)) : null,
          ...D,
          created_at: ts(start),
          updated_at: ts(start),
        });
      }));
      return { id, deliverables: ids };
    };

    const nwShorts = await project(
      northwind,
      { name: `${monthLabel(today.slice(0, 7), 'long').split(' ')[0]} Shorts Pack`, type: 'short_form', billing: 'retainer', status: 'editing', editor: dev, priority: 'high', startOffset: -20, deadline: 6, description: '12 vertical shorts cut from the two long-form uploads. Hook in the first second, yellow captions.', refs: [{ label: 'Hook style board', url: 'https://boards.example/northwind-hooks' }] },
      [
        { title: 'Short #1 — “The 3-second rule”', status: 'delivered', due: -14 },
        { title: 'Short #2 — “Why your thumbnails fail”', status: 'delivered', due: -11 },
        { title: 'Short #3 — “Retention graph explained”', status: 'delivered', due: -8, revisions: 1 },
        { title: 'Short #4 — “Edit like a pro”', status: 'approved', due: -2 },
        { title: 'Short #5 — “B-roll on a budget”', status: 'approved', due: 0 },
        { title: 'Short #6 — “Pacing tricks”', status: 'client_review', due: 1 },
        { title: 'Short #7 — “Sound design matters”', status: 'client_review', due: 2 },
        { title: 'Short #8 — “Color in 60 seconds”', status: 'revisions', due: -1, revisions: 2 },
        { title: 'Short #9 — “The perfect cut”', status: 'editing', due: 3 },
        { title: 'Short #10 — “Story first”', status: 'editing', due: 4 },
        { title: 'Short #11 — “Captions that convert”', status: 'backlog', due: 5 },
        { title: 'Short #12 — “Ending strong”', status: 'backlog', due: 6 },
      ],
    );
    const nwTrailer = await project(northwind, { name: 'Channel Trailer 2026', type: 'motion_graphics', billing: 'fixed', price: 65000, status: 'internal_review', editor: sara, priority: 'medium', startOffset: -12, deadline: 3 }, [
      { title: 'Channel trailer (60s)', status: 'internal_review', due: 3, format: '16:9 horizontal · 1920×1080', platform: 'youtube', hours: 18, assignee: sara },
    ]);
    const lumenReels = await project(lumen, { name: 'Reels — Weeks 44–45', type: 'short_form', billing: 'retainer', status: 'client_review', editor: dev, priority: 'medium', startOffset: -9, deadline: 5 }, [
      { title: 'Reel: 20-minute HIIT', status: 'delivered', due: -5, platform: 'instagram' },
      { title: 'Reel: Form check — squats', status: 'delivered', due: -3, platform: 'instagram' },
      { title: 'Reel: Meal prep Sunday', status: 'client_review', due: 0, platform: 'instagram' },
      { title: 'Reel: Coach Q&A', status: 'client_review', due: 1, platform: 'instagram' },
      { title: 'Reel: Member story — Rhea', status: 'editing', due: 3, platform: 'instagram' },
      { title: 'Reel: Myth vs fact', status: 'backlog', due: 5, platform: 'instagram' },
    ]);
    const lumenAd = await project(lumen, { name: 'Transformation Ad', type: 'ad', billing: 'fixed', price: 3500000, status: 'revisions', editor: sara, priority: 'high', startOffset: -15, deadline: 2 }, [
      { title: 'Transformation ad — 30s', status: 'revisions', due: 2, revisions: 2, assignee: sara, hours: 8 },
      { title: 'Transformation ad — 15s cutdown', status: 'editing', due: 4, assignee: sara },
    ]);
    const atlas41 = await project(atlas, { name: 'Episode 41 — The Index Fund Myth', type: 'long_form', billing: 'retainer', status: 'editing', editor: kabir, priority: 'urgent', startOffset: -6, deadline: 4, description: '28-minute episode. Chapters, animated charts for the returns comparison, end screen.' }, [
      { title: 'Main edit (28 min)', status: 'editing', due: 3, assignee: kabir, hours: 20 },
      { title: 'Thumbnail — 3 options', status: 'internal_review', due: 2, assignee: mira, format: 'Thumbnail · 1280×720' },
      { title: 'Shorts cutdown #1', status: 'backlog', due: 6, assignee: dev, platform: 'youtube_shorts', format: '9:16 vertical · 1080×1920' },
      { title: 'Shorts cutdown #2', status: 'backlog', due: 7, assignee: dev, platform: 'youtube_shorts', format: '9:16 vertical · 1080×1920' },
    ]);
    const atlas40 = await project(atlas, { name: 'Episode 40 — Rent vs Buy', type: 'long_form', billing: 'retainer', status: 'delivered', editor: kabir, priority: 'high', startOffset: -24, deadline: -8 }, [
      { title: 'Main edit (31 min)', status: 'delivered', due: -9, assignee: kabir, revisions: 1 },
      { title: 'Thumbnail', status: 'delivered', due: -9, assignee: mira, format: 'Thumbnail · 1280×720' },
    ]);
    const copperAds = await project(copperleaf, { name: 'Spring Collection Ads', type: 'ad', billing: 'retainer', status: 'backlog', editor: sara, priority: 'medium', startOffset: -2, deadline: 12 }, [
      { title: 'Ad 1 — Hero product (15s)', status: 'editing', due: 6, platform: 'meta_ads', format: '4:5 portrait · 1080×1350' },
      { title: 'Ad 2 — UGC style (20s)', status: 'backlog', due: 8, platform: 'meta_ads', format: '9:16 vertical · 1080×1920' },
      { title: 'Ad 3 — Lookbook (30s)', status: 'backlog', due: 10, platform: 'meta_ads', format: '1:1 square · 1080×1080' },
      { title: 'Ad 4 — Offer (10s)', status: 'backlog', due: 12, platform: 'meta_ads', format: '9:16 vertical · 1080×1920' },
    ]);
    await project(orbit, { name: 'Season Launch Montage', type: 'motion_graphics', billing: 'fixed', price: 120000, status: 'on_hold', editor: kabir, priority: 'low', startOffset: -40, deadline: -5, description: 'Paused by the client until their game update ships.' }, [
      { title: 'Launch montage (90s)', status: 'editing', due: -5, hours: 16 },
    ]);
    const saffronShorts = await project(saffron, { name: 'Festive Recipe Shorts', type: 'short_form', billing: 'retainer', status: 'editing', editor: dev, priority: 'medium', startOffset: -10, deadline: 9 }, [
      { title: 'Recipe: Kaju katli', status: 'delivered', due: -4, platform: 'instagram' },
      { title: 'Recipe: Masala chai 3 ways', status: 'delivered', due: -2, platform: 'instagram' },
      { title: 'Recipe: Paneer tikka', status: 'client_review', due: 1, platform: 'instagram' },
      { title: 'Recipe: Gulab jamun', status: 'editing', due: 2, platform: 'instagram' },
      { title: 'Recipe: Chole bhature', status: 'editing', due: -1, platform: 'instagram' },
      { title: 'Recipe: Rasmalai', status: 'backlog', due: 5, platform: 'instagram' },
      { title: 'Recipe: Dal makhani', status: 'backlog', due: 7, platform: 'instagram' },
      { title: 'Recipe: Jalebi', status: 'backlog', due: 9, platform: 'instagram' },
    ]);
    const saffronThumbs = await project(saffron, { name: 'Thumbnail Refresh', type: 'thumbnail', billing: 'fixed', price: 1200000, status: 'approved', editor: mira, priority: 'low', startOffset: -14, deadline: 1 }, [
      { title: 'Thumbnails 1–3', status: 'approved', due: 0, assignee: mira },
      { title: 'Thumbnails 4–6', status: 'approved', due: 1, assignee: mira },
    ]);

    // ── Feedback ──
    const fb = async (proj: { id: number }, deliverable: number | null, kind: string, author: 'client' | 'team', name: string, body: string, daysAgo: number, extra: Record<string, unknown> = {}) =>
      await db.insert('feedback', { project_id: proj.id, deliverable_id: deliverable, kind, author_type: author, author_name: name, body, visible_to_client: kind === 'internal_note' ? 0 : 1, ...extra, ...D, created_at: ts(addDays(today, -daysAgo), 9 + (daysAgo % 8)) });
    await fb(lumenAd, lumenAd.deliverables[0], 'revision_request', 'client', 'Priya Nair', 'Can the before/after transition be quicker? Also please use the brighter logo version from the brand kit.', 1, { timecode: '00:12', revision_number: 2 });
    await fb(lumenAd, lumenAd.deliverables[0], 'comment', 'team', 'Sara Iqbal', 'On it — tightening the wipe to 8 frames and swapping the logo.', 0);
    await fb(nwShorts, nwShorts.deliverables[5], 'comment', 'client', 'Liam Carter', 'Love this one! Could the captions be a touch bigger on the last line?', 0, { timecode: '00:41' });
    await fb(nwShorts, nwShorts.deliverables[1], 'approval', 'client', 'Liam Carter', 'Approved — ship it.', 12);
    await fb(nwShorts, nwShorts.deliverables[7], 'revision_request', 'client', 'Liam Carter', 'The grade feels too warm compared to the rest of the series.', 3, { revision_number: 2, resolved_at: ts(addDays(today, -2)) });
    await fb(atlas41, atlas41.deliverables[0], 'internal_note', 'team', 'Kabir Mehta', 'Audio needs denoise around 12:40 — HVAC hum in the guest mic.', 1);
    await fb(saffronShorts, saffronShorts.deliverables[2], 'comment', 'client', 'Ananya Rao', 'Can we add the recipe card at the end for 2 seconds?', 0);

    // ── Invoices & payments ──
    const gst: TaxLine[] = [
      { label: 'CGST', rate: 9 },
      { label: 'SGST', rate: 9 },
    ];
    let seq = Math.max(1, (await ctx.settings()).invoice_next_number);
    const prefix = (await ctx.settings()).invoice_prefix;
    const pad = (await ctx.settings()).invoice_number_padding;
    const nextNumber = async () => {
      for (;;) {
        const n = `${prefix}${String(seq++).padStart(pad, '0')}`;
        if (!await db.get('SELECT 1 FROM invoices WHERE number = :n', { n })) return n;
      }
    };
    type Inv = { client: (typeof clients)[number]; issue: string; due?: string; items: { description: string; quantity: number; unit_price_minor: number; service_type: string }[]; taxes?: TaxLine[]; state: 'draft' | 'sent'; kind?: 'standard' | 'retainer'; period?: string; project?: number | null; payments?: { amount: number | 'full'; daysAfterIssue: number; method: string; reference?: string }[]; discountPercent?: number };
    const invoices: { id: number; number: string; total: number }[] = [];
    const invoice = async (i: Inv) => {
      const totals = computeInvoiceTotals({ items: i.items, discount_type: i.discountPercent ? 'percent' : 'none', discount_percent: i.discountPercent ?? 0, taxes: i.taxes ?? [] });
      const number = await nextNumber();
      const due = i.due ?? addDays(i.issue, i.client.terms);
      const id = await db.insert('invoices', {
        number,
        client_id: i.client.id,
        project_id: i.project ?? null,
        kind: i.kind ?? 'standard',
        currency: i.client.currency,
        issue_date: i.issue,
        due_date: due,
        period_start: i.period ?? null,
        period_end: i.period ? endOfMonth(i.period) : null,
        state: i.state,
        discount_type: i.discountPercent ? 'percent' : 'none',
        discount_percent: i.discountPercent ?? 0,
        taxes: i.taxes ?? [],
        subtotal_minor: totals.subtotal_minor,
        discount_minor: totals.discount_minor,
        tax_minor: totals.tax_minor,
        total_minor: totals.total_minor,
        sent_at: i.state === 'sent' ? ts(i.issue, 12) : null,
        terms: null,
        ...D,
        created_at: ts(i.issue, 9),
        updated_at: ts(i.issue, 12),
      });
      for (const [idx, it] of i.items.entries()) await db.insert('invoice_items', { invoice_id: id, ...it, amount_minor: totals.lines[idx].amount_minor, sort_order: idx });
      await activity(i.issue, { entity_type: 'invoice', entity_id: id, client_id: i.client.id, action: 'sent', summary: `Invoice ${number} ${i.state === 'draft' ? 'drafted' : 'sent'} to ${i.client.company}` }, 12);
      let paid = 0;
      for (const p of i.payments ?? []) {
        const amount = p.amount === 'full' ? totals.total_minor - paid : p.amount;
        const paidAt = addDays(i.issue, p.daysAfterIssue);
        if (paidAt > today || amount <= 0) continue;
        await db.insert('payments', { invoice_id: id, client_id: i.client.id, amount_minor: amount, currency: i.client.currency, paid_at: paidAt, method: p.method, reference: p.reference ?? null, ...D, created_at: ts(paidAt, 15) });
        paid += amount;
        await activity(paidAt, { entity_type: 'payment', entity_id: id, client_id: i.client.id, action: 'payment_recorded', summary: `Payment received on ${number} from ${i.client.company}` }, 15);
      }
      invoices.push({ id, number, total: totals.total_minor });
      return id;
    };
    const retainerItem = (c: (typeof clients)[number], period: string) => [{ description: `${c.pkg} — ${monthLabel(period.slice(0, 7), 'long')}`, quantity: 1, unit_price_minor: c.retainer!, service_type: 'retainer' }];

    // Retainer history: earlier months were billed on the 1st–3rd and paid a few days later. The current
    // month was billed a few days ago, so it is open but not yet due. Two invoices are deliberately overdue.
    const retainerSeries = async (c: (typeof clients)[number], months: number, opts: { issueDay: number; taxes?: TaxLine[]; method: string; payDays: number; lastMonth: 'paid' | 'partial' | 'unpaid'; current: 'paid' | 'open'; currentAgo: number }) => {
      for (let m = months; m >= 0; m--) {
        const period = startOfMonth(addMonths(today, -m));
        if (period < c.start) continue;
        const issue = m === 0 ? (addDays(today, -opts.currentAgo) < period ? period : addDays(today, -opts.currentAgo)) : addDays(period, opts.issueDay);
        if (issue > today) continue;
        let payments: NonNullable<Inv['payments']> = [];
        if (m >= 2 || (m === 1 && opts.lastMonth === 'paid') || (m === 0 && opts.current === 'paid')) payments = [{ amount: 'full', daysAfterIssue: m === 0 ? 1 : opts.payDays, method: opts.method, reference: `${opts.method.toUpperCase()}-${period.slice(0, 7)}` }];
        if (m === 1 && opts.lastMonth === 'partial') payments = [{ amount: Math.round(c.retainer! / 2), daysAfterIssue: opts.payDays + 2, method: opts.method, reference: 'PART-1' }];
        await invoice({ client: c, issue, items: retainerItem(c, period), taxes: opts.taxes, state: 'sent', kind: 'retainer', period, payments });
      }
    };
    await retainerSeries(northwind, 7, { issueDay: 1, method: 'wise', payDays: 4, lastMonth: 'partial', current: 'open', currentAgo: 3 });
    await retainerSeries(atlas, 6, { issueDay: 2, method: 'paypal', payDays: 3, lastMonth: 'paid', current: 'open', currentAgo: 2 });
    await retainerSeries(lumen, 5, { issueDay: 3, taxes: gst, method: 'bank_transfer', payDays: 12, lastMonth: 'unpaid', current: 'open', currentAgo: 1 });
    await retainerSeries(saffron, 3, { issueDay: 1, method: 'upi', payDays: 5, lastMonth: 'paid', current: 'paid', currentAgo: 4 });
    // One-off work.
    await invoice({ client: orbit, issue: addDays(today, -62), project: null, items: [{ description: 'Season Launch Montage — 50% deposit', quantity: 1, unit_price_minor: 60000, service_type: 'motion_graphics' }], state: 'sent', payments: [{ amount: 'full', daysAfterIssue: 2, method: 'paypal' }] });
    await invoice({ client: northwind, issue: addDays(today, -9), due: addDays(today, 5), project: nwTrailer.id, items: [{ description: 'Channel trailer 2026 — motion design & edit', quantity: 1, unit_price_minor: 65000, service_type: 'motion_graphics' }], state: 'sent', payments: [{ amount: 32500, daysAfterIssue: 1, method: 'wise', reference: 'WISE-TRAILER-50' }] });
    await invoice({ client: lumen, issue: today, project: lumenAd.id, items: [{ description: 'Transformation ad — 30s master', quantity: 1, unit_price_minor: 2500000, service_type: 'ad' }, { description: '15s cutdown', quantity: 1, unit_price_minor: 1000000, service_type: 'ad' }], taxes: gst, state: 'draft' });
    await invoice({ client: copperleaf, issue: addDays(today, -6) < monthStart ? monthStart : addDays(today, -6), items: retainerItem(copperleaf, monthStart), state: 'sent', kind: 'retainer', period: monthStart });
    await invoice({ client: saffron, issue: addDays(today, -5), due: addDays(today, 2), project: saffronThumbs.id, items: [{ description: 'Thumbnail refresh — 6 designs', quantity: 6, unit_price_minor: 200000, service_type: 'thumbnail' }], state: 'sent', discountPercent: 10 });
    const settingsSeq = (await ctx.settings()).invoice_next_number;
    if (seq > settingsSeq) await db.run(`INSERT INTO settings (key, value) VALUES ('invoice_next_number', :v) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, { v: JSON.stringify(seq) });
    ctx.invalidateSettings();

    // ── Expenses ──
    const expense = async (date: string, category: string, amount: number, currency: string, description: string, vendor: string, extra: Record<string, unknown> = {}) =>
      date <= today && await db.insert('expenses', { date, category, amount_minor: amount, currency, description, vendor, ...extra, ...D, created_at: ts(date, 18), updated_at: ts(date, 18) });
    for (let m = 5; m >= 0; m--) {
      const ms = startOfMonth(addMonths(today, -m));
      await expense(addDays(ms, 2), 'software', 423000, 'INR', 'Adobe Creative Cloud — All Apps', 'Adobe');
      await expense(addDays(ms, 4), 'software', 1500, 'USD', 'Frame.io Pro', 'Frame.io');
      await expense(addDays(ms, 6), 'music_licensing', 1799, 'USD', 'Epidemic Sound — commercial', 'Epidemic Sound');
      await expense(addDays(ms, 9), 'stock_assets', 1650, 'USD', 'Envato Elements', 'Envato');
      await expense(addDays(ms, 14), 'internet_phone', 117900, 'INR', 'Fibre internet 300 Mbps', 'ACT Fibernet');
      await expense(addDays(ms, 20), 'freelancers', m % 2 === 0 ? 1800000 : 1200000, 'INR', 'Freelance colorist — monthly batch', 'Freelance colorist', { team_member_id: null });
    }
    await expense(addDays(today, -47), 'hardware', 1450000, 'INR', 'Samsung T7 2TB SSD', 'Amazon');
    await expense(addDays(today, -21), 'marketing', 600000, 'INR', 'Instagram ads — agency showreel', 'Meta');
    await expense(addDays(today, -3), 'payment_fees', 840, 'USD', 'Wise conversion fees', 'Wise');
    await expense(addDays(today, -16), 'freelancers', 2500000, 'INR', 'Shorts editing overflow — Dev', 'Dev Arora', { team_member_id: dev });

    // ── Leads & outreach ──
    type L = { name: string; company: string; email: string; source: string; value: number; currency: string; deal: 'retainer' | 'one_time'; stage: LeadStage; createdAgo: number; followUp: number | null; lastContactAgo: number | null; reason?: string; client?: number; notes?: string; website: string; social?: string };
    const leadDefs: L[] = [
      { name: 'Ava Collins', company: 'Brightside Labs', email: 'ava@brightside.example', source: 'cold_email', value: 300000, currency: 'USD', deal: 'retainer', stage: 'proposal_sent', createdAgo: 24, followUp: 0, lastContactAgo: 4, website: 'https://brightside.example', notes: 'Wants 3 long-form + 10 shorts a month. Proposal v2 sent with two tiers.' },
      { name: 'Rohan Gupta', company: 'Kettle & Co', email: 'rohan@kettleco.example', source: 'instagram', value: 6000000, currency: 'INR', deal: 'retainer', stage: 'discovery_call', createdAgo: 12, followUp: 1, lastContactAgo: 2, website: 'https://kettleco.example', social: 'https://instagram.com/kettle.and.co' },
      { name: 'Noah Kim', company: 'Pixel Forge Podcast', email: 'noah@pixelforge.example', source: 'referral', value: 220000, currency: 'USD', deal: 'retainer', stage: 'negotiation', createdAgo: 30, followUp: -2, lastContactAgo: 6, website: 'https://pixelforge.example', notes: 'Referred by Liam (Northwind). Negotiating turnaround: wants 48h on clips.' },
      { name: 'Isabella Moore', company: 'Moore Wellness', email: 'isabella@moorewellness.example', source: 'cold_dm', value: 150000, currency: 'USD', deal: 'retainer', stage: 'contacted', createdAgo: 6, followUp: 3, lastContactAgo: 6, website: 'https://moorewellness.example' },
      { name: 'Karan Malhotra', company: 'Stackwise', email: 'karan@stackwise.example', source: 'linkedin', value: 12000000, currency: 'INR', deal: 'retainer', stage: 'replied', createdAgo: 9, followUp: 0, lastContactAgo: 1, website: 'https://stackwise.example' },
      { name: 'Grace Lee', company: 'Daybreak Travel', email: 'grace@daybreak.example', source: 'website', value: 180000, currency: 'USD', deal: 'one_time', stage: 'lead', createdAgo: 2, followUp: 2, lastContactAgo: null, website: 'https://daybreak.example', notes: 'Inbound from the website form: destination launch film.' },
      { name: 'Omar Haddad', company: 'Dune Motors', email: 'omar@dunemotors.example', source: 'referral', value: 900000, currency: 'AED', deal: 'retainer', stage: 'proposal_sent', createdAgo: 15, followUp: 4, lastContactAgo: 3, website: 'https://dunemotors.example' },
      { name: 'Sofia Alvarez', company: 'Verde Skincare', email: 'sofia@verdeskin.example', source: 'instagram', value: 120000, currency: 'EUR', deal: 'retainer', stage: 'contacted', createdAgo: 4, followUp: 5, lastContactAgo: 4, website: 'https://verdeskin.example' },
      { name: 'Chloe Martin', company: 'Little Fern', email: 'chloe@littlefern.example', source: 'upwork', value: 90000, currency: 'USD', deal: 'one_time', stage: 'lost', createdAgo: 40, followUp: null, lastContactAgo: 28, reason: 'Budget too low for the scope', website: 'https://littlefern.example' },
      { name: 'Arjun Shah', company: 'Ledger Lane', email: 'arjun@ledgerlane.example', source: 'cold_email', value: 250000, currency: 'USD', deal: 'retainer', stage: 'lost', createdAgo: 55, followUp: null, lastContactAgo: 35, reason: 'Hired an in-house editor', website: 'https://ledgerlane.example' },
      { name: 'Ananya Rao', company: 'Saffron Kitchen', email: 'ananya@saffronkitchen.example', source: 'referral', value: 4500000, currency: 'INR', deal: 'retainer', stage: 'won', createdAgo: 110, followUp: null, lastContactAgo: 95, reason: 'Loved the recipe-shorts sample edit', client: saffron.id, website: 'https://saffronkitchen.example' },
      { name: 'Elena Rossi', company: 'Copperleaf Studio', email: 'elena@copperleaf.example', source: 'linkedin', value: 150000, currency: 'EUR', deal: 'retainer', stage: 'won', createdAgo: 34, followUp: null, lastContactAgo: 8, reason: 'Fast turnaround and ad-specific portfolio', client: copperleaf.id, website: 'https://copperleaf.example' },
    ];
    const order: LeadStage[] = ['lead', 'contacted', 'replied', 'discovery_call', 'proposal_sent', 'negotiation', 'won'];
    for (const l of leadDefs) {
      const created = addDays(today, -l.createdAgo);
      const closed = l.stage === 'won' || l.stage === 'lost' ? addDays(today, -(l.lastContactAgo ?? 0)) : null;
      const id = await db.insert('leads', {
        name: l.name,
        company: l.company,
        email: l.email,
        website: l.website,
        social_url: l.social ?? null,
        source: l.source,
        deal_type: l.deal,
        estimated_value_minor: l.value,
        currency: l.currency,
        stage: l.stage,
        stage_changed_at: ts(closed ?? addDays(today, -(l.lastContactAgo ?? 0))),
        last_contact_at: l.lastContactAgo === null ? null : addDays(today, -l.lastContactAgo),
        next_follow_up: l.followUp === null ? null : addDays(today, l.followUp),
        notes: l.notes ?? null,
        outcome_reason: l.reason ?? null,
        closed_at: closed ? ts(closed) : null,
        client_id: l.client ?? null,
        ...D,
        created_at: ts(created),
        updated_at: ts(created),
      });
      // Stage history walks the funnel so conversion metrics have something real to count.
      const reached = l.stage === 'lost' ? (l.name === 'Chloe Martin' ? 3 : 4) : order.indexOf(l.stage);
      let prev: string | null = null;
      for (let i = 0; i <= reached; i++) {
        await db.insert('lead_stage_history', { lead_id: id, from_stage: prev, to_stage: order[i], changed_at: ts(addDays(created, Math.round((i * l.createdAgo) / (reached + 2)))) });
        prev = order[i];
      }
      if (l.stage === 'lost') await db.insert('lead_stage_history', { lead_id: id, from_stage: prev, to_stage: 'lost', changed_at: ts(closed!) });
      if (l.lastContactAgo !== null) {
        await db.insert('communications', { lead_id: id, client_id: l.client ?? null, channel: l.source === 'cold_dm' || l.source === 'instagram' ? 'dm' : 'email', direction: 'outbound', subject: 'Intro + 2 sample edits', body: `Shared two sample edits relevant to ${l.company}.`, occurred_at: addDays(created, 1), created_by: actor.id, ...D, created_at: ts(addDays(created, 1)) });
        if (['replied', 'discovery_call', 'proposal_sent', 'negotiation', 'won'].includes(l.stage))
          await db.insert('communications', { lead_id: id, client_id: l.client ?? null, channel: 'email', direction: 'inbound', subject: 'Re: Intro', body: 'Interested — can we hop on a call this week?', occurred_at: addDays(created, 3), created_by: actor.id, ...D, created_at: ts(addDays(created, 3)) });
        if (['discovery_call', 'proposal_sent', 'negotiation', 'won'].includes(l.stage))
          await db.insert('communications', { lead_id: id, client_id: l.client ?? null, channel: 'call', direction: 'outbound', subject: 'Discovery call', body: 'Covered goals, posting cadence, budget and review process.', occurred_at: addDays(created, 6), created_by: actor.id, ...D, created_at: ts(addDays(created, 6)) });
      }
      await activity(created, { entity_type: 'lead', entity_id: id, action: 'created', summary: `Lead ${l.name} (${l.company}) added` });
    }

    // ── Client communications ──
    const comm = async (c: (typeof clients)[number], channel: string, direction: string, subject: string, body: string, daysAgo: number) =>
      await db.insert('communications', { client_id: c.id, channel, direction, subject, body, occurred_at: addDays(today, -daysAgo), created_by: actor.id, ...D, created_at: ts(addDays(today, -daysAgo)) });
    await comm(northwind, 'call', 'outbound', 'Monthly check-in', 'Retention on shorts up 18%. Liam wants to test 45s formats next month.', 6);
    await comm(northwind, 'email', 'inbound', 'Renewal + Q1 plans', 'Asked for a proposal covering 16 shorts/mo from next quarter.', 2);
    await comm(lumen, 'whatsapp', 'inbound', 'Payment', 'Finance team says last month’s invoice will be cleared this week.', 3);
    await comm(atlas, 'meeting', 'outbound', 'Episode 41 kickoff', 'Agreed chapter structure and three chart animations.', 6);
    await comm(copperleaf, 'email', 'outbound', 'Onboarding pack', 'Sent the brief template, Frame.io invite and asset checklist.', 5);

    // ── Tasks & recurring rules ──
    const task = async (title: string, due: number | null, priority: string, extra: Record<string, unknown> = {}) =>
      await db.insert('tasks', { title, due_date: due === null ? null : addDays(today, due), priority, status: 'todo', source: 'manual', ...extra, ...D, created_at: ts(addDays(today, -3)), updated_at: ts(addDays(today, -3)) });
    await task('Upload Episode 41 rough cut to Frame.io', 1, 'high', { client_id: atlas.id, project_id: atlas41.id, assignee_id: kabir });
    await task('Collect product shots list from Copperleaf', 0, 'medium', { client_id: copperleaf.id, project_id: copperAds.id, assignee_id: sara });
    await task('Renew Envato Elements licence', -2, 'medium');
    await task('Prepare Q1 proposal for Northwind (16 shorts/mo)', 5, 'high', { client_id: northwind.id });
    await task('Back up last month’s project files to E:', 1, 'low', { assignee_id: kabir });
    await task('Send Lumen the payment reminder', -1, 'high', { client_id: lumen.id });
    await task('Review Dev’s captions template v3', 2, 'medium', { assignee_id: dev, project_id: nwShorts.id });
    await db.insert('tasks', { title: 'Export Episode 40 final + chapters', status: 'done', priority: 'high', due_date: addDays(today, -9), completed_at: ts(addDays(today, -9)), client_id: atlas.id, project_id: atlas40.id, assignee_id: kabir, source: 'manual', ...D, created_at: ts(addDays(today, -12)), updated_at: ts(addDays(today, -9)) });
    await db.insert('tasks', { title: 'Onboarding call with Copperleaf', status: 'done', priority: 'medium', due_date: addDays(today, -5), completed_at: ts(addDays(today, -5)), client_id: copperleaf.id, source: 'manual', ...D, created_at: ts(addDays(today, -8)), updated_at: ts(addDays(today, -5)) });

    const rule = async (r: Record<string, unknown>) => {
      const shape = { frequency: r.frequency as never, interval: 1, weekday: (r.weekday as number) ?? null, month_day: (r.month_day as number) ?? null, start_date: r.start_date as string };
      return db.insert('recurring_rules', { ...r, interval: 1, next_occurrence: firstOccurrence(shape), active: 1, ...D, created_at: ts(addDays(today, -30)), updated_at: ts(addDays(today, -30)) });
    };
    await rule({ kind: 'task', title: 'Send {{month}} retainer invoices', frequency: 'monthly', month_day: 1, start_date: addDays(today, 1), lead_days: 2, template: { priority: 'high', description: 'Invoices → Draft retainer invoices, review, send, then mark as sent.' } });
    await rule({ kind: 'task', title: 'Weekly update email to Atlas Money Show', frequency: 'weekly', weekday: 5, start_date: addDays(today, 1), lead_days: 0, template: { client_id: atlas.id, priority: 'medium' } });
    await rule({ kind: 'task', title: 'Hand off finished files + project archive ({{month}})', frequency: 'monthly', month_day: 28, start_date: addDays(today, 1), lead_days: 1, template: { assignee_id: kabir, priority: 'low' } });
    await rule({
      kind: 'project',
      title: '{{month}} Recipe Shorts',
      frequency: 'monthly',
      month_day: 1,
      start_date: addDays(today, 1),
      lead_days: 3,
      template: {
        client_id: saffron.id,
        type: 'short_form',
        billing_type: 'retainer',
        editor_id: dev,
        priority: 'medium',
        deadline_offset_days: 27,
        deliverables: Array.from({ length: 8 }, (_, i) => ({ title: `Recipe short #${i + 1}`, platform: 'instagram', format: '9:16 vertical · 1080×1920', deadline_offset_days: 6 + i * 3 })),
      },
    });

    await logActivity(ctx, actor, { entity_type: 'settings', entity_id: null, action: 'demo_loaded', summary: 'Demo data loaded (clearly labelled; remove it any time in Settings)', is_demo: 1 });
    return demoCounts(ctx);
  });
}

/** Deletes every demo row. Refuses if real records were attached to demo clients, so nothing real is lost. */
export async function removeDemoData(ctx: AppContext, actor: Actor) {
  const db = ctx.db;
  const conflicts = await db.get<{ p: number; i: number; pay: number }>(
    `SELECT (SELECT COUNT(*) FROM projects WHERE is_demo = 0 AND client_id IN (SELECT id FROM clients WHERE is_demo = 1)) AS p,
            (SELECT COUNT(*) FROM invoices WHERE is_demo = 0 AND client_id IN (SELECT id FROM clients WHERE is_demo = 1)) AS i,
            (SELECT COUNT(*) FROM payments WHERE is_demo = 0 AND invoice_id IN (SELECT id FROM invoices WHERE is_demo = 1)) AS pay`,
  )!;
  if (conflicts.p || conflicts.i || conflicts.pay) {
    throw conflict(
      `Some of your real records are attached to demo clients (${conflicts.p} projects, ${conflicts.i} invoices, ${conflicts.pay} payments). Move them to a real client first.`,
    );
  }
  const before = await demoCounts(ctx);
  await db.tx(async () => {
    await db.run('DELETE FROM payments WHERE is_demo = 1 OR invoice_id IN (SELECT id FROM invoices WHERE is_demo = 1)');
    await db.run('DELETE FROM outbox WHERE is_demo = 1 OR client_id IN (SELECT id FROM clients WHERE is_demo = 1)');
    await db.run('DELETE FROM invoices WHERE is_demo = 1');
    await db.run('DELETE FROM tasks WHERE is_demo = 1');
    await db.run('DELETE FROM expenses WHERE is_demo = 1');
    await db.run('DELETE FROM projects WHERE is_demo = 1');
    await db.run('DELETE FROM communications WHERE is_demo = 1');
    await db.run('DELETE FROM leads WHERE is_demo = 1');
    await db.run('DELETE FROM clients WHERE is_demo = 1');
    await db.run('DELETE FROM recurring_rules WHERE is_demo = 1');
    await db.run('DELETE FROM team_members WHERE is_demo = 1');
    await db.run('DELETE FROM notifications WHERE is_demo = 1');
    await db.run('DELETE FROM report_snapshots WHERE is_demo = 1');
    await db.run('DELETE FROM activity WHERE is_demo = 1');
    await logActivity(ctx, actor, { entity_type: 'settings', entity_id: null, action: 'demo_removed', summary: 'Demo data removed' });
  });
  return before;
}
