import type { AppContext } from '../context.ts';
import { parseCsvObjects } from '../lib/csv.ts';
import { normalizeUrl } from '../lib/validation.ts';
import { isValidCurrency, sumByCurrency, toMinor, type MoneyGroup } from '../../shared/money.ts';
import { isValidDate, diffDays } from '../../shared/dates.ts';
import {
  DEAL_TYPES,
  LEAD_SOURCES,
  LEAD_SOURCE_LABELS,
  LEAD_STAGES,
  LEAD_STAGE_LABELS,
  LEAD_STAGE_PROBABILITY,
  OPEN_LEAD_STAGES,
  type DealType,
  type LeadSource,
  type LeadStage,
} from '../../shared/constants.ts';

// ── Pipeline value & metrics ─────────────────────────────────────────────────

/** Open pipeline value per currency: total estimated value and a probability-weighted forecast. */
export async function pipelineValue(ctx: AppContext) {
  const rows = await ctx.db.all<{ stage: LeadStage; deal_type: DealType; currency: string; total: number; n: number }>(
    `SELECT stage, deal_type, currency, SUM(COALESCE(estimated_value_minor, 0)) AS total, COUNT(*) AS n
       FROM leads WHERE stage IN ('lead','contacted','replied','discovery_call','proposal_sent','negotiation')
      GROUP BY stage, deal_type, currency`,
  );
  const base = (await ctx.settings()).base_currency;
  const weighted = rows.map((r) => ({ currency: r.currency, amount_minor: Math.round(r.total * LEAD_STAGE_PROBABILITY[r.stage]) }));
  return {
    open_count: rows.reduce((s, r) => s + r.n, 0),
    total: sumByCurrency(rows.map((r) => ({ currency: r.currency, amount_minor: r.total })), base),
    weighted: sumByCurrency(weighted, base),
    retainer_monthly: sumByCurrency(rows.filter((r) => r.deal_type === 'retainer').map((r) => ({ currency: r.currency, amount_minor: r.total })), base),
    one_time: sumByCurrency(rows.filter((r) => r.deal_type === 'one_time').map((r) => ({ currency: r.currency, amount_minor: r.total })), base),
    by_stage: OPEN_LEAD_STAGES.map((stage) => ({
      stage,
      count: rows.filter((r) => r.stage === stage).reduce((s, r) => s + r.n, 0),
      total: sumByCurrency(rows.filter((r) => r.stage === stage).map((r) => ({ currency: r.currency, amount_minor: r.total })), base),
    })),
  };
}

const FUNNEL: LeadStage[] = ['lead', 'contacted', 'replied', 'discovery_call', 'proposal_sent', 'negotiation', 'won'];
const stageIndex = (s: string) => FUNNEL.indexOf(s as LeadStage);

export async function pipelineMetrics(ctx: AppContext, range: { from?: string; to?: string } = {}) {
  const base = (await ctx.settings()).base_currency;
  const leads = await ctx.db.all<{ id: number; stage: LeadStage; source: LeadSource; created_at: string; closed_at: string | null; outcome_reason: string | null; estimated_value_minor: number | null; currency: string }>(
    'SELECT id, stage, source, created_at, closed_at, outcome_reason, estimated_value_minor, currency FROM leads',
  );
  const history = await ctx.db.all<{ lead_id: number; to_stage: string }>('SELECT lead_id, to_stage FROM lead_stage_history');
  const maxReached = new Map<number, number>();
  for (const l of leads) maxReached.set(l.id, l.stage === 'lost' ? 0 : stageIndex(l.stage));
  for (const h of history) {
    const idx = stageIndex(h.to_stage);
    if (idx >= 0 && idx > (maxReached.get(h.lead_id) ?? 0)) maxReached.set(h.lead_id, idx);
  }
  const inCohort = (l: (typeof leads)[number]) => (!range.from || l.created_at.slice(0, 10) >= range.from) && (!range.to || l.created_at.slice(0, 10) <= range.to);
  const closedInRange = (l: (typeof leads)[number]) =>
    !!l.closed_at && (!range.from || l.closed_at.slice(0, 10) >= range.from) && (!range.to || l.closed_at.slice(0, 10) <= range.to);

  const cohort = leads.filter(inCohort);
  const funnel = FUNNEL.map((stage, i) => ({ stage, reached: cohort.filter((l) => (maxReached.get(l.id) ?? 0) >= i).length }));
  const conversions = funnel.slice(1).map((f, i) => ({
    from: funnel[i].stage,
    to: f.stage,
    rate: funnel[i].reached > 0 ? f.reached / funnel[i].reached : null,
  }));

  const closed = leads.filter(closedInRange);
  const won = closed.filter((l) => l.stage === 'won');
  const lost = closed.filter((l) => l.stage === 'lost');
  const daysToClose = won.map((l) => diffDays(l.created_at.slice(0, 10), l.closed_at!.slice(0, 10)));

  const reasons = (list: typeof closed) => {
    const m = new Map<string, number>();
    for (const l of list) {
      const key = (l.outcome_reason ?? '').trim();
      const k = key ? key.charAt(0).toUpperCase() + key.slice(1) : 'No reason recorded';
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return [...m.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count);
  };

  const bySource = LEAD_SOURCES.map((source) => {
    const all = cohort.filter((l) => l.source === source);
    const w = closed.filter((l) => l.source === source && l.stage === 'won');
    const lo = closed.filter((l) => l.source === source && l.stage === 'lost');
    return {
      source,
      label: LEAD_SOURCE_LABELS[source],
      leads: all.length,
      won: w.length,
      lost: lo.length,
      win_rate: w.length + lo.length > 0 ? w.length / (w.length + lo.length) : null,
      won_value: sumByCurrency(w.filter((l) => l.estimated_value_minor).map((l) => ({ currency: l.currency, amount_minor: l.estimated_value_minor! })), base),
    };
  }).filter((s) => s.leads > 0 || s.won > 0 || s.lost > 0);

  return {
    range,
    value: await pipelineValue(ctx),
    funnel,
    conversions,
    won: won.length,
    lost: lost.length,
    win_rate: won.length + lost.length > 0 ? won.length / (won.length + lost.length) : null,
    won_value: sumByCurrency(won.filter((l) => l.estimated_value_minor).map((l) => ({ currency: l.currency, amount_minor: l.estimated_value_minor! })), base) as MoneyGroup[],
    avg_days_to_close: daysToClose.length ? Math.round(daysToClose.reduce((s, d) => s + d, 0) / daysToClose.length) : null,
    win_reasons: reasons(won),
    loss_reasons: reasons(lost),
    by_source: bySource,
    follow_ups: {
      overdue: await ctx.db.value<number>(`SELECT COUNT(*) FROM leads WHERE next_follow_up < :today AND stage NOT IN ('won','lost')`, { today: await ctx.today() }) ?? 0,
      today: await ctx.db.value<number>(`SELECT COUNT(*) FROM leads WHERE next_follow_up = :today AND stage NOT IN ('won','lost')`, { today: await ctx.today() }) ?? 0,
    },
  };
}

// ── Duplicate detection ──────────────────────────────────────────────────────

export type DuplicateCandidate = {
  name?: string | null;
  company?: string | null;
  email?: string | null;
  phone?: string | null;
  website?: string | null;
  social_url?: string | null;
};

export type DuplicateMatch = {
  type: 'lead' | 'client';
  id: number;
  name: string;
  company: string | null;
  state: string;
  matched_on: ('email' | 'website' | 'company' | 'phone' | 'social' | 'name')[];
};

const COMPANY_SUFFIXES = /\b(inc|incorporated|llc|ltd|limited|pvt|private|co|corp|corporation|company|gmbh|plc|llp|studios?|media|official)\b/g;

export function normCompany(s: string | null | undefined): string | null {
  if (!s) return null;
  const n = s.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9\s]/g, ' ').replace(COMPANY_SUFFIXES, ' ').replace(/\s+/g, ' ').trim();
  return n.length >= 2 ? n : null;
}
export function normDomain(s: string | null | undefined): string | null {
  if (!s) return null;
  const url = normalizeUrl(s);
  if (!url) return null;
  const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  // Shared platforms are not a company identity.
  if (/(^|\.)(youtube\.com|youtu\.be|instagram\.com|tiktok\.com|linkedin\.com|x\.com|twitter\.com|facebook\.com|linktr\.ee|gmail\.com)$/.test(host)) return null;
  return host;
}
export function normSocial(s: string | null | undefined): string | null {
  if (!s) return null;
  const url = normalizeUrl(s);
  if (!url) return s.trim().toLowerCase().replace(/^@/, '') || null;
  const u = new URL(url);
  const path = u.pathname.replace(/\/+$/, '').toLowerCase();
  return path ? `${u.hostname.replace(/^www\./, '').toLowerCase()}${path}` : null;
}
export function normPhone(s: string | null | undefined): string | null {
  if (!s) return null;
  const digits = s.replace(/\D/g, '');
  return digits.length >= 8 ? digits.slice(-10) : null;
}
const normEmail = (s: string | null | undefined) => (s ? s.trim().toLowerCase() || null : null);
const normName = (s: string | null | undefined) => (s ? s.trim().toLowerCase().replace(/\s+/g, ' ') || null : null);

type Indexed = { type: 'lead' | 'client'; id: number; name: string; company: string | null; state: string; email: string | null; phone: string | null; website: string | null; social: string | null; company_n: string | null; name_n: string | null };

async function index(ctx: AppContext): Promise<Indexed[]> {
  const leads = await ctx.db.all<{ id: number; name: string; company: string | null; stage: string; email: string | null; phone: string | null; website: string | null; social_url: string | null }>(
    'SELECT id, name, company, stage, email, phone, website, social_url FROM leads',
  );
  const clients = await ctx.db.all<{ id: number; name: string; company: string | null; status: string; email: string | null; phone: string | null; whatsapp: string | null; website: string | null; socials: string }>(
    'SELECT id, name, company, status, email, phone, whatsapp, website, socials FROM clients',
  );
  return [
    ...leads.map((l) => ({
      type: 'lead' as const,
      id: l.id,
      name: l.name,
      company: l.company,
      state: LEAD_STAGE_LABELS[l.stage as LeadStage] ?? l.stage,
      email: normEmail(l.email),
      phone: normPhone(l.phone),
      website: normDomain(l.website),
      social: normSocial(l.social_url),
      company_n: normCompany(l.company),
      name_n: normName(l.name),
    })),
    ...clients.flatMap((c): Indexed[] => {
      let socials: Record<string, string> = {};
      try {
        socials = JSON.parse(c.socials || '{}');
      } catch {
        /* ignore */
      }
      const base: Omit<Indexed, 'social'> = {
        type: 'client' as const,
        id: c.id,
        name: c.name,
        company: c.company,
        state: `Client · ${c.status}`,
        email: normEmail(c.email),
        phone: normPhone(c.phone) ?? normPhone(c.whatsapp),
        website: normDomain(c.website),
        company_n: normCompany(c.company),
        name_n: normName(c.name),
      };
      const socialList = Object.values(socials).map(normSocial).filter((s): s is string => !!s);
      return socialList.length ? socialList.map((social) => ({ ...base, social })) : [{ ...base, social: null }];
    }),
  ];
}

/** Find existing leads or clients that look like the same person or company. */
export async function findDuplicates(ctx: AppContext, c: DuplicateCandidate, opts: { excludeLeadId?: number; indexCache?: Indexed[] } = {}): Promise<DuplicateMatch[]> {
  const email = normEmail(c.email);
  const phone = normPhone(c.phone);
  const website = normDomain(c.website);
  const social = normSocial(c.social_url);
  const company = normCompany(c.company);
  const name = normName(c.name);
  const out = new Map<string, DuplicateMatch>();
  for (const row of opts.indexCache ?? await index(ctx)) {
    if (row.type === 'lead' && row.id === opts.excludeLeadId) continue;
    const matched: DuplicateMatch['matched_on'] = [];
    if (email && row.email === email) matched.push('email');
    if (website && row.website === website) matched.push('website');
    if (company && row.company_n === company) matched.push('company');
    if (phone && row.phone === phone) matched.push('phone');
    if (social && row.social === social) matched.push('social');
    // A bare name match only counts when neither side has a company to tell them apart.
    if (name && row.name_n === name && !company && !row.company_n) matched.push('name');
    if (!matched.length) continue;
    const key = `${row.type}:${row.id}`;
    const prev = out.get(key);
    if (prev) prev.matched_on = [...new Set([...prev.matched_on, ...matched])];
    else out.set(key, { type: row.type, id: row.id, name: row.name, company: row.company, state: row.state, matched_on: matched });
  }
  return [...out.values()];
}

// ── CSV import ───────────────────────────────────────────────────────────────

const ALIASES: Record<string, string[]> = {
  name: ['name', 'full_name', 'contact', 'contact_name', 'person', 'lead', 'lead_name', 'prospect'],
  first_name: ['first_name', 'firstname', 'given_name'],
  last_name: ['last_name', 'lastname', 'surname', 'family_name'],
  company: ['company', 'company_name', 'business', 'brand', 'organization', 'organisation', 'channel', 'channel_name'],
  email: ['email', 'email_address', 'e_mail', 'mail'],
  phone: ['phone', 'phone_number', 'mobile', 'whatsapp', 'tel', 'telephone'],
  website: ['website', 'site', 'url', 'web', 'domain', 'website_url'],
  social_url: ['social', 'social_url', 'social_profile', 'profile', 'profile_url', 'instagram', 'youtube', 'linkedin', 'twitter', 'x', 'tiktok', 'channel_url'],
  source: ['source', 'lead_source', 'origin'],
  estimated_value: ['value', 'deal_value', 'estimated_value', 'estimated_deal_value', 'budget', 'amount', 'deal_size'],
  currency: ['currency', 'cur'],
  stage: ['stage', 'status', 'pipeline_stage'],
  deal_type: ['deal_type', 'type', 'deal'],
  notes: ['notes', 'note', 'comments', 'comment', 'description'],
  next_follow_up: ['next_follow_up', 'follow_up', 'follow_up_date', 'next_contact', 'next_step_date'],
  last_contact_at: ['last_contact', 'last_contacted', 'last_contact_date', 'last_contact_at'],
  tags: ['tags', 'labels'],
};

function pick(row: Record<string, string>, key: string): string {
  for (const alias of ALIASES[key]) if (row[alias]) return row[alias];
  return '';
}

function matchEnum<T extends string>(raw: string, values: readonly T[], labels: Record<T, string>): T | null {
  const n = raw.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  if (!n) return null;
  for (const v of values) if (v === n || labels[v].toLowerCase().replace(/[^a-z0-9]+/g, '_') === n) return v;
  for (const v of values) if (n.startsWith(v) || v.startsWith(n) || labels[v].toLowerCase().startsWith(raw.trim().toLowerCase())) return v;
  return null;
}

function parseDateLoose(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  if (isValidDate(s)) return s;
  const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s); // DD/MM/YYYY (India/UK style)
  if (m) {
    const iso = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    if (isValidDate(iso)) return iso;
  }
  return null;
}

export type ImportLead = {
  name: string;
  company: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  social_url: string | null;
  source: LeadSource;
  deal_type: DealType;
  estimated_value_minor: number | null;
  currency: string;
  stage: LeadStage;
  notes: string | null;
  next_follow_up: string | null;
  last_contact_at: string | null;
  tags: string[];
};

export type ImportPreviewRow = {
  row: number;
  lead: ImportLead | null;
  errors: string[];
  warnings: string[];
  duplicates: DuplicateMatch[];
  duplicate_in_file: number | null;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function previewLeadImport(ctx: AppContext, csvText: string, defaultCurrency: string): Promise<{ headers: string[]; rows: ImportPreviewRow[]; recognized: string[] }> {
  const { headers, rows } = parseCsvObjects(csvText);
  const recognized = Object.keys(ALIASES).filter((k) => ALIASES[k].some((a) => headers.includes(a)));
  const idx = await index(ctx);
  const seen = new Map<string, number>();
  const out: ImportPreviewRow[] = await Promise.all(rows.slice(0, 2000).map(async (raw, i) => {
    const errors: string[] = [];
    const warnings: string[] = [];
    let name = pick(raw, 'name');
    if (!name) name = [pick(raw, 'first_name'), pick(raw, 'last_name')].filter(Boolean).join(' ');
    const company = pick(raw, 'company') || null;
    if (!name && company) name = company;
    if (!name) errors.push('Missing a name or company.');
    const emailRaw = pick(raw, 'email');
    const email = emailRaw ? emailRaw.toLowerCase() : null;
    if (email && !EMAIL_RE.test(email)) errors.push(`“${emailRaw}” is not a valid email.`);
    const websiteRaw = pick(raw, 'website');
    const website = websiteRaw ? normalizeUrl(websiteRaw) : null;
    if (websiteRaw && !website) warnings.push(`Website “${websiteRaw}” was not a valid link and was skipped.`);
    const socialRaw = pick(raw, 'social_url');
    const social = socialRaw ? normalizeUrl(socialRaw) ?? socialRaw : null;
    const currencyRaw = pick(raw, 'currency').toUpperCase();
    const currency = currencyRaw && isValidCurrency(currencyRaw) ? currencyRaw : defaultCurrency;
    if (currencyRaw && !isValidCurrency(currencyRaw)) warnings.push(`Unknown currency “${currencyRaw}”, used ${defaultCurrency}.`);
    const valueRaw = pick(raw, 'estimated_value');
    let value: number | null = null;
    if (valueRaw) {
      value = toMinor(valueRaw, currency);
      if (value === null) errors.push(`Value “${valueRaw}” is not a valid amount.`);
    }
    const stageRaw = pick(raw, 'stage');
    let stage: LeadStage = 'lead';
    if (stageRaw) {
      const s = matchEnum(stageRaw, LEAD_STAGES, LEAD_STAGE_LABELS);
      if (s) stage = s;
      else warnings.push(`Unknown stage “${stageRaw}”, imported as Lead.`);
    }
    const sourceRaw = pick(raw, 'source');
    let source: LeadSource = 'other';
    let notes = pick(raw, 'notes') || null;
    if (sourceRaw) {
      const s = matchEnum(sourceRaw, LEAD_SOURCES, LEAD_SOURCE_LABELS);
      if (s) source = s;
      else notes = [notes, `Source: ${sourceRaw}`].filter(Boolean).join('\n');
    }
    const dealRaw = pick(raw, 'deal_type').toLowerCase();
    const deal_type: DealType = /one|project|single/.test(dealRaw) ? 'one_time' : DEAL_TYPES.includes(dealRaw as DealType) ? (dealRaw as DealType) : 'retainer';
    const fuRaw = pick(raw, 'next_follow_up');
    const next_follow_up = fuRaw ? parseDateLoose(fuRaw) : null;
    if (fuRaw && !next_follow_up) warnings.push(`Follow-up date “${fuRaw}” not understood (use YYYY-MM-DD).`);
    const lcRaw = pick(raw, 'last_contact_at');
    const last_contact_at = lcRaw ? parseDateLoose(lcRaw) : null;
    if (lcRaw && !last_contact_at) warnings.push(`Last-contact date “${lcRaw}” not understood.`);
    const tags = pick(raw, 'tags')
      .split(/[;,|]/)
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean)
      .slice(0, 20);
    if (name.length > 120) errors.push('Name is longer than 120 characters.');

    const lead: ImportLead | null = errors.length
      ? null
      : { name, company, email, phone: pick(raw, 'phone') || null, website, social_url: social, source, deal_type, estimated_value_minor: value, currency, stage, notes, next_follow_up, last_contact_at, tags };
    const duplicates = lead ? await findDuplicates(ctx, lead, { indexCache: idx }) : [];
    let duplicate_in_file: number | null = null;
    if (lead) {
      const keys = [normEmail(lead.email), normDomain(lead.website), normCompany(lead.company)].filter(Boolean) as string[];
      for (const k of keys) {
        if (seen.has(k)) {
          duplicate_in_file = seen.get(k)!;
          break;
        }
      }
      for (const k of keys) if (!seen.has(k)) seen.set(k, i + 2);
    }
    return { row: i + 2, lead, errors, warnings, duplicates, duplicate_in_file };
  }));
  return { headers, rows: out, recognized };
}
