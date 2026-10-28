import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRightLeft, BarChart3, CalendarClock, Download, ExternalLink, Kanban, List, Pencil, Plus, Search, Trash2, Trophy, Upload, UserCheck } from 'lucide-react';
import { api, errorMessage, qs } from '../lib/api.ts';
import { invalidateAll, useBaseCurrency, useToday } from '../lib/queries.ts';
import { Badge, Button, Card, CardHeader, DemoBadge, EmptyState, ErrorState, Field, Input, Notice, PageHeader, PageSkeleton, Segmented, Select, Skeleton } from '../components/ui.tsx';
import { Dialog, useConfirm, useToast } from '../components/overlay.tsx';
import { MoneyStack, groupsText } from '../components/money.tsx';
import { Funnel } from '../components/charts.tsx';
import { CommunicationForm, DuplicateWarning, LeadFormDialog, type LeadRow } from '../components/forms.tsx';
import { DueChip, LeadStageBadge } from '../lib/status.tsx';
import { COMM_CHANNEL_LABELS, DEAL_TYPE_LABELS, LEAD_SOURCE_LABELS, LEAD_SOURCE_OPTIONS, LEAD_STAGES, LEAD_STAGE_LABELS, LEAD_STAGE_OPTIONS, OPEN_LEAD_STAGES, type LeadStage } from '../../shared/constants.ts';
import { formatMoney, type MoneyGroup } from '../../shared/money.ts';
import { formatDate } from '../../shared/dates.ts';
import { cx, pct, safeHref, timeAgo, useDebounced, useLocalPref } from '../lib/util.ts';

type Metrics = {
  value: { open_count: number; total: MoneyGroup[]; weighted: MoneyGroup[]; retainer_monthly: MoneyGroup[]; one_time: MoneyGroup[]; by_stage: { stage: LeadStage; count: number; total: MoneyGroup[] }[] };
  funnel: { stage: LeadStage; reached: number }[];
  conversions: { from: LeadStage; to: LeadStage; rate: number | null }[];
  won: number;
  lost: number;
  win_rate: number | null;
  won_value: MoneyGroup[];
  avg_days_to_close: number | null;
  win_reasons: { reason: string; count: number }[];
  loss_reasons: { reason: string; count: number }[];
  by_source: { source: string; label: string; leads: number; won: number; lost: number; win_rate: number | null; won_value: MoneyGroup[] }[];
  follow_ups: { overdue: number; today: number };
};

type Duplicate = { type: 'lead' | 'client'; id: number; name: string; company: string | null; state: string; matched_on: string[] };

function Value({ l }: { l: LeadRow }) {
  if (!l.estimated_value_minor) return <span className="text-ink-3 text-[12px]">No value</span>;
  return (
    <span className="text-[12.5px] font-medium tabular text-ink">
      {formatMoney(l.estimated_value_minor, l.currency)}
      {l.deal_type === 'retainer' && <span className="text-ink-3 font-normal">/mo</span>}
    </span>
  );
}

function LeadDrawer({ id, onClose, onEdit }: { id: number | null; onClose: () => void; onEdit: (l: LeadRow) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const today = useToday();
  const { confirm, prompt } = useConfirm();
  const { data, isLoading } = useQuery({
    queryKey: ['lead', id],
    queryFn: () => api.get<{ lead: LeadRow; outreach: { id: number; channel: string; direction: string; subject: string | null; body: string | null; occurred_at: string; created_by_name: string | null }[]; history: { id: number; from_stage: string | null; to_stage: LeadStage; changed_at: string }[]; duplicates: Duplicate[]; client: { id: number; name: string; company: string | null } | null }>(`/api/leads/${id}`),
    enabled: id !== null,
  });
  const refresh = () => invalidateAll(qc, 'leads', 'lead');
  const patch = useMutation({ mutationFn: (body: Record<string, unknown>) => api.patch(`/api/leads/${id}`, body), onSuccess: refresh, onError: (e) => toast.error(errorMessage(e)) });
  const convert = useMutation({
    mutationFn: (reason: string) => api.post<{ client_id: number }>(`/api/leads/${id}/convert`, { outcome_reason: reason }),
    onSuccess: (r) => {
      refresh();
      invalidateAll(qc, 'clients');
      toast.success('Deal won — client created', { label: 'Open client', onClick: () => navigate(`/clients/${r.client_id}`) });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: () => api.del(`/api/leads/${id}`),
    onSuccess: () => {
      refresh();
      onClose();
      toast.success('Lead deleted');
    },
  });
  const l = data?.lead;
  const setStage = async (stage: LeadStage) => {
    if (!l || stage === l.stage) return;
    if (stage === 'won' || stage === 'lost') {
      const reason = await prompt({ title: stage === 'won' ? 'Nice! Why did you win it?' : 'Why was it lost?', input: { label: 'Reason', placeholder: stage === 'won' ? 'e.g. Strong samples, fast turnaround' : 'e.g. Budget, timing, went in-house' }, confirmLabel: stage === 'won' ? 'Mark won' : 'Mark lost' });
      if (reason === null) return;
      patch.mutate({ stage, outcome_reason: reason || null });
    } else patch.mutate({ stage });
  };
  return (
    <Dialog open={id !== null} onClose={onClose} variant="drawer" title={l ? l.company || l.name : 'Lead'} description={l ? `${l.company ? `${l.name} · ` : ''}${LEAD_SOURCE_LABELS[l.source as keyof typeof LEAD_SOURCE_LABELS] ?? l.source}` : undefined}>
      {isLoading || !l || !data ? (
        <Skeleton className="h-64" />
      ) : (
        <div className="flex flex-col gap-5">
          <div className="flex flex-wrap items-center gap-2">
            <LeadStageBadge stage={l.stage} />
            {l.is_demo ? <DemoBadge /> : null}
            <Value l={l} />
            {l.next_follow_up && l.stage !== 'won' && l.stage !== 'lost' && <DueChip date={l.next_follow_up} today={today} />}
          </div>
          <DuplicateWarning duplicates={data.duplicates} />
          <div className="grid grid-cols-2 gap-3">
            <Field label="Stage">
              <Select value={l.stage} onChange={(e) => setStage(e.target.value as LeadStage)}>
                {LEAD_STAGE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Next follow-up">
              <Input type="date" value={l.next_follow_up ?? ''} onChange={(e) => patch.mutate({ next_follow_up: e.target.value || null })} />
            </Field>
          </div>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-[13px]">
            <div>
              <dt className="text-[11.5px] text-ink-3">Email</dt>
              <dd className="truncate">{l.email ? <a className="text-accent-ink hover:underline" href={`mailto:${l.email}`}>{l.email}</a> : '—'}</dd>
            </div>
            <div>
              <dt className="text-[11.5px] text-ink-3">Phone</dt>
              <dd>{l.phone ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-[11.5px] text-ink-3">Website</dt>
              <dd className="truncate">{safeHref(l.website) ? <a className="text-accent-ink hover:underline" href={safeHref(l.website)} target="_blank" rel="noreferrer noopener">{new URL(l.website!).hostname}</a> : '—'}</dd>
            </div>
            <div>
              <dt className="text-[11.5px] text-ink-3">Social</dt>
              <dd className="truncate">{safeHref(l.social_url) ? <a className="text-accent-ink hover:underline inline-flex items-center gap-1" href={safeHref(l.social_url)} target="_blank" rel="noreferrer noopener">Profile <ExternalLink className="size-3" /></a> : l.social_url ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-[11.5px] text-ink-3">Deal</dt>
              <dd>{DEAL_TYPE_LABELS[l.deal_type]}</dd>
            </div>
            <div>
              <dt className="text-[11.5px] text-ink-3">Last contact</dt>
              <dd>{l.last_contact_at ? formatDate(l.last_contact_at, today) : 'Never'}</dd>
            </div>
            {l.outcome_reason && (
              <div className="col-span-2">
                <dt className="text-[11.5px] text-ink-3">{l.stage === 'won' ? 'Why we won' : l.stage === 'lost' ? 'Why we lost' : 'Outcome note'}</dt>
                <dd>{l.outcome_reason}</dd>
              </div>
            )}
          </dl>
          {l.notes && <p className="text-[13px] text-ink-2 whitespace-pre-wrap rounded-xl bg-white/[0.03] p-3">{l.notes}</p>}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" icon={<Pencil className="size-3.5" />} onClick={() => onEdit(l)}>
              Edit
            </Button>
            {data.client ? (
              <Button size="sm" icon={<UserCheck className="size-3.5" />} to={`/clients/${data.client.id}`}>
                Open client
              </Button>
            ) : (
              <Button
                size="sm"
                variant="primary"
                icon={<Trophy className="size-3.5" />}
                loading={convert.isPending}
                onClick={async () => {
                  const reason = await prompt({ title: 'Convert to client', body: 'Creates a client (onboarding) from this lead, marks the deal won and links the outreach history.', input: { label: 'Why did you win it? (optional)' }, confirmLabel: 'Create client' });
                  if (reason !== null) convert.mutate(reason);
                }}
              >
                Won → create client
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              icon={<Trash2 className="size-3.5" />}
              onClick={async () => {
                if (await confirm({ title: 'Delete this lead?', body: 'Its outreach log is deleted too. Consider marking it lost instead, so win/loss stats stay accurate.', confirmLabel: 'Delete', danger: true })) remove.mutate();
              }}
            >
              Delete
            </Button>
          </div>

          <section>
            <h3 className="text-[13.5px] font-semibold mb-2">Log outreach</h3>
            <div className="rounded-xl ring-1 ring-inset ring-white/[0.06] p-3">
              <CommunicationForm endpoint={`/api/leads/${l.id}/activities`} showFollowUp />
            </div>
            <p className="mt-1.5 text-[11.5px] text-ink-3">Logging an outbound message moves a new lead to Contacted; an inbound reply moves it to Replied.</p>
          </section>

          <section>
            <h3 className="text-[13.5px] font-semibold mb-2">Outreach history</h3>
            {data.outreach.length === 0 ? (
              <p className="text-[12.5px] text-ink-3">Nothing logged yet.</p>
            ) : (
              <ol className="flex flex-col gap-2">
                {data.outreach.map((o) => (
                  <li key={o.id} className="rounded-lg bg-white/[0.025] p-2.5">
                    <div className="flex items-center gap-2 text-[11.5px] text-ink-3">
                      <Badge tone={o.direction === 'inbound' ? 'info' : 'neutral'}>
                        {COMM_CHANNEL_LABELS[o.channel as keyof typeof COMM_CHANNEL_LABELS]} · {o.direction}
                      </Badge>
                      {formatDate(o.occurred_at, today)}
                    </div>
                    {o.subject && <div className="mt-1 text-[13px] text-ink">{o.subject}</div>}
                    {o.body && <div className="mt-0.5 text-[12.5px] text-ink-2 whitespace-pre-wrap">{o.body}</div>}
                  </li>
                ))}
              </ol>
            )}
          </section>

          <section>
            <h3 className="text-[13.5px] font-semibold mb-2">Stage history</h3>
            <ol className="flex flex-col gap-1 text-[12.5px]">
              {data.history.map((h) => (
                <li key={h.id} className="flex items-center gap-2 text-ink-2">
                  <ArrowRightLeft className="size-3.5 text-ink-3" />
                  {h.from_stage ? `${LEAD_STAGE_LABELS[h.from_stage as LeadStage]} → ` : 'Created as '}
                  {LEAD_STAGE_LABELS[h.to_stage]}
                  <span className="text-ink-3 ml-auto">{timeAgo(h.changed_at)}</span>
                </li>
              ))}
            </ol>
          </section>
        </div>
      )}
    </Dialog>
  );
}

type PreviewRow = { row: number; lead: (Omit<LeadRow, 'id'> & { estimated_value_minor: number | null }) | null; errors: string[]; warnings: string[]; duplicates: Duplicate[]; duplicate_in_file: number | null };

function ImportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const base = useBaseCurrency();
  const fileRef = useRef<HTMLInputElement>(null);
  const [csv, setCsv] = useState<string | null>(null);
  const [fileName, setFileName] = useState('');
  const [currency, setCurrency] = useState(base === 'INR' ? 'USD' : base);
  const [includeDupes, setIncludeDupes] = useState<Set<number>>(new Set());
  const [skipRows, setSkipRows] = useState<Set<number>>(new Set());
  useEffect(() => {
    if (!open) {
      setCsv(null);
      setFileName('');
      setIncludeDupes(new Set());
      setSkipRows(new Set());
    }
  }, [open]);
  const preview = useQuery({
    queryKey: ['lead-import', csv, currency],
    queryFn: () => api.post<{ rows: PreviewRow[]; recognized: string[]; headers: string[] }>('/api/leads/import/preview', { csv, default_currency: currency }),
    enabled: !!csv,
    retry: false,
  });
  const rows = preview.data?.rows ?? [];
  const willImport = rows.filter((r) => r.lead && !skipRows.has(r.row) && (!(r.duplicates.length || r.duplicate_in_file) || includeDupes.has(r.row)));
  const run = useMutation({
    mutationFn: () =>
      api.post<{ imported: number; skipped: number }>('/api/leads/import', {
        csv,
        default_currency: currency,
        skip_duplicates: false,
        skip_rows: rows.filter((r) => !willImport.includes(r)).map((r) => r.row),
      }),
    onSuccess: (r) => {
      invalidateAll(qc, 'leads');
      toast.success(`${r.imported} lead${r.imported === 1 ? '' : 's'} imported · ${r.skipped} skipped`);
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="xl"
      title="Import leads from CSV"
      description="Only rows from your file are imported. Nothing is looked up, enriched or contacted."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!willImport.length} loading={run.isPending} onClick={() => run.mutate()}>
            Import {willImport.length || ''} lead{willImport.length === 1 ? '' : 's'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="CSV file">
            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv"
              className="text-[13px] text-ink-2 file:mr-3 file:h-9 file:px-3 file:rounded-lg file:border-0 file:bg-surface-3 file:text-ink file:cursor-pointer"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                if (f.size > 4_000_000) return toast.error('That file is larger than 4 MB.');
                setFileName(f.name);
                setCsv(await f.text());
              }}
            />
          </Field>
          <Field label="Currency for rows without one">
            <Select value={currency} onChange={(e) => setCurrency(e.target.value)} className="!w-32">
              {['USD', 'INR', 'EUR', 'GBP', 'AED', 'CAD', 'AUD', 'SGD'].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </Select>
          </Field>
        </div>
        {!csv && (
          <Notice tone="info">
            The first row must be headers. Recognised columns: Name (or First/Last name), Company, Email, Phone, Website, Social/Instagram/YouTube, Source, Value, Currency, Stage, Deal type, Next follow-up, Last contact, Notes, Tags. Dates as YYYY-MM-DD or DD/MM/YYYY.
          </Notice>
        )}
        {preview.isFetching && <Skeleton className="h-32" />}
        {preview.error && <Notice tone="bad">{errorMessage(preview.error)}</Notice>}
        {preview.data && !preview.isFetching && (
          <>
            <div className="flex flex-wrap gap-2 text-[12.5px]">
              <Badge>{fileName}</Badge>
              <Badge tone="good">{rows.filter((r) => r.lead && !r.duplicates.length && !r.duplicate_in_file).length} new</Badge>
              <Badge tone="warn">{rows.filter((r) => r.lead && (r.duplicates.length || r.duplicate_in_file)).length} possible duplicates</Badge>
              <Badge tone="bad">{rows.filter((r) => !r.lead).length} with errors</Badge>
              <span className="text-ink-3">Columns used: {preview.data.recognized.join(', ') || 'none recognised'}</span>
            </div>
            <div className="max-h-[46vh] overflow-auto rounded-xl ring-1 ring-inset ring-white/[0.06]">
              <table className="w-full text-[12.5px]">
                <thead className="sticky top-0 bg-surface-2 text-left text-ink-3">
                  <tr>
                    <th className="py-2 px-3 font-medium w-10">Use</th>
                    <th className="py-2 px-3 font-medium">Row</th>
                    <th className="py-2 px-3 font-medium">Lead</th>
                    <th className="py-2 px-3 font-medium">Stage · value</th>
                    <th className="py-2 px-3 font-medium">Check</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const dup = r.duplicates.length > 0 || !!r.duplicate_in_file;
                    const included = willImport.includes(r);
                    return (
                      <tr key={r.row} className={cx('border-t border-line align-top', !r.lead && 'opacity-70')}>
                        <td className="py-2 px-3">
                          {r.lead && (
                            <input
                              type="checkbox"
                              aria-label={`Import row ${r.row}`}
                              className="size-4 accent-[#6c5ce7] cursor-pointer"
                              checked={included}
                              onChange={(e) => {
                                const sk = new Set(skipRows);
                                const inc = new Set(includeDupes);
                                if (e.target.checked) {
                                  sk.delete(r.row);
                                  if (dup) inc.add(r.row);
                                } else {
                                  sk.add(r.row);
                                  inc.delete(r.row);
                                }
                                setSkipRows(sk);
                                setIncludeDupes(inc);
                              }}
                            />
                          )}
                        </td>
                        <td className="py-2 px-3 text-ink-3 tabular">{r.row}</td>
                        <td className="py-2 px-3">
                          {r.lead ? (
                            <>
                              <div className="text-ink">{r.lead.company ? `${r.lead.company} — ${r.lead.name}` : r.lead.name}</div>
                              <div className="text-ink-3">{[r.lead.email, LEAD_SOURCE_LABELS[r.lead.source as keyof typeof LEAD_SOURCE_LABELS]].filter(Boolean).join(' · ')}</div>
                            </>
                          ) : (
                            <span className="text-ink-3">—</span>
                          )}
                        </td>
                        <td className="py-2 px-3 text-ink-2">
                          {r.lead && (
                            <>
                              {LEAD_STAGE_LABELS[r.lead.stage]}
                              {r.lead.estimated_value_minor ? ` · ${formatMoney(r.lead.estimated_value_minor, r.lead.currency)}` : ''}
                            </>
                          )}
                        </td>
                        <td className="py-2 px-3">
                          {r.errors.map((e) => (
                            <div key={e} className="text-bad">
                              {e}
                            </div>
                          ))}
                          {r.duplicates.map((d) => (
                            <div key={`${d.type}${d.id}`} className="text-warn">
                              Matches {d.type} “{d.company || d.name}” ({d.matched_on.join(', ')})
                            </div>
                          ))}
                          {r.duplicate_in_file && <div className="text-warn">Same as row {r.duplicate_in_file} in this file</div>}
                          {r.warnings.map((w) => (
                            <div key={w} className="text-ink-3">
                              {w}
                            </div>
                          ))}
                          {r.lead && !dup && !r.warnings.length && <span className="text-good">OK</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="text-[12px] text-ink-3">Possible duplicates are unticked by default. Tick them only if they really are different prospects.</p>
          </>
        )}
        {csv && (
          <div>
            <Button size="sm" variant="ghost" onClick={() => fileRef.current?.click()} icon={<Upload className="size-3.5" />} className="-ml-2">
              Choose a different file
            </Button>
          </div>
        )}
      </div>
    </Dialog>
  );
}

function Insights({ m }: { m: Metrics }) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <Card className="p-5">
        <h2 className="text-[14px] font-semibold">Conversion funnel</h2>
        <p className="text-[12.5px] text-ink-3 mb-4">How many prospects ever reached each stage, and the step-to-step conversion.</p>
        <Funnel steps={m.funnel.map((f, i) => ({ key: f.stage, label: LEAD_STAGE_LABELS[f.stage], value: f.reached, rate: i === 0 ? undefined : m.conversions[i - 1]?.rate ?? null }))} />
      </Card>
      <Card className="p-5">
        <h2 className="text-[14px] font-semibold mb-4">Win / loss</h2>
        <div className="grid grid-cols-3 gap-3 mb-5">
          <div className="rounded-xl bg-white/[0.03] p-3">
            <div className="text-[11.5px] text-ink-3">Won</div>
            <div className="text-[22px] font-semibold text-good">{m.won}</div>
          </div>
          <div className="rounded-xl bg-white/[0.03] p-3">
            <div className="text-[11.5px] text-ink-3">Lost</div>
            <div className="text-[22px] font-semibold">{m.lost}</div>
          </div>
          <div className="rounded-xl bg-white/[0.03] p-3">
            <div className="text-[11.5px] text-ink-3">Win rate</div>
            <div className="text-[22px] font-semibold">{pct(m.win_rate)}</div>
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-[12.5px]">
          <div>
            <h3 className="label-caps mb-2">Why we win</h3>
            {m.win_reasons.length === 0 ? <p className="text-ink-3">No wins recorded.</p> : (
              <ul className="flex flex-col gap-1">
                {m.win_reasons.map((r) => (
                  <li key={r.reason} className="flex justify-between gap-2"><span className="text-ink-2">{r.reason}</span><span className="tabular text-ink-3">{r.count}</span></li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <h3 className="label-caps mb-2">Why we lose</h3>
            {m.loss_reasons.length === 0 ? <p className="text-ink-3">No losses recorded.</p> : (
              <ul className="flex flex-col gap-1">
                {m.loss_reasons.map((r) => (
                  <li key={r.reason} className="flex justify-between gap-2"><span className="text-ink-2">{r.reason}</span><span className="tabular text-ink-3">{r.count}</span></li>
                ))}
              </ul>
            )}
          </div>
        </div>
        <div className="mt-5 text-[12.5px] text-ink-3">
          Won value: <span className="text-ink">{groupsText(m.won_value)}</span>
          {m.avg_days_to_close !== null && <> · average {m.avg_days_to_close} days from first contact to win</>}
        </div>
      </Card>
      <Card className="lg:col-span-2">
        <CardHeader title="By source" description="Where your leads come from and which channels actually convert." />
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead className="text-left text-[12px] text-ink-3 border-y border-line">
              <tr>
                <th className="py-2 px-5 font-medium">Source</th>
                <th className="py-2 px-3 font-medium text-right">Leads</th>
                <th className="py-2 px-3 font-medium text-right">Won</th>
                <th className="py-2 px-3 font-medium text-right">Lost</th>
                <th className="py-2 px-3 font-medium text-right">Win rate</th>
                <th className="py-2 px-5 font-medium text-right">Won value</th>
              </tr>
            </thead>
            <tbody className="tabular">
              {m.by_source.map((s) => (
                <tr key={s.source} className="border-b border-line last:border-0">
                  <td className="py-2 px-5 text-ink-2">{s.label}</td>
                  <td className="py-2 px-3 text-right">{s.leads}</td>
                  <td className="py-2 px-3 text-right text-good">{s.won}</td>
                  <td className="py-2 px-3 text-right">{s.lost}</td>
                  <td className="py-2 px-3 text-right">{pct(s.win_rate)}</td>
                  <td className="py-2 px-5 text-right text-ink-2">{groupsText(s.won_value)}</td>
                </tr>
              ))}
              {m.by_source.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-6 text-center text-ink-3">No leads yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

const BOARD_STAGES: LeadStage[] = [...OPEN_LEAD_STAGES, 'won', 'lost'];

export default function PipelinePage() {
  const today = useToday();
  const qc = useQueryClient();
  const toast = useToast();
  const { prompt } = useConfirm();
  const [params, setParams] = useSearchParams();
  const [view, setView] = useLocalPref<'board' | 'table' | 'insights'>('pipeline-view', 'board');
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const [source, setSource] = useState('');
  const [followUp, setFollowUp] = useState('');
  const [openId, setOpenId] = useState<number | null>(params.get('lead') ? Number(params.get('lead')) : null);
  const [editing, setEditing] = useState<LeadRow | null | 'new'>(params.get('new') === '1' ? 'new' : null);
  const [importing, setImporting] = useState(false);
  const [over, setOver] = useState<LeadStage | null>(null);
  useEffect(() => {
    const lead = params.get('lead');
    if (lead) setOpenId(Number(lead));
    if (params.get('new') === '1') setEditing('new');
    if (lead || params.get('new')) {
      params.delete('lead');
      params.delete('new');
      setParams(params, { replace: true });
    }
  }, [params, setParams]);
  const query = qs({ q: dq, source, follow_up: followUp });
  const leads = useQuery({ queryKey: ['leads', query], queryFn: () => api.get<{ leads: LeadRow[] }>(`/api/leads${query}`) });
  const metrics = useQuery({ queryKey: ['leads', 'metrics'], queryFn: () => api.get<Metrics>('/api/leads/metrics') });
  const move = useMutation({
    mutationFn: (v: { id: number; stage: LeadStage; outcome_reason?: string | null }) => api.patch(`/api/leads/${v.id}`, v),
    onMutate: async (v) => {
      const key = ['leads', query];
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<{ leads: LeadRow[] }>(key);
      qc.setQueryData<{ leads: LeadRow[] }>(key, (old) => old && { leads: old.leads.map((l) => (l.id === v.id ? { ...l, stage: v.stage } : l)) });
      return { prev, key };
    },
    onError: (e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(ctx.key, ctx.prev);
      toast.error(errorMessage(e));
    },
    onSettled: () => invalidateAll(qc, 'leads', 'lead'),
  });
  const dropTo = async (id: number, stage: LeadStage) => {
    const l = leads.data?.leads.find((x) => x.id === id);
    if (!l || l.stage === stage) return;
    if (stage === 'won' || stage === 'lost') {
      const reason = await prompt({ title: stage === 'won' ? `Won ${l.company || l.name} — why?` : `Lost ${l.company || l.name} — why?`, input: { label: 'Reason', placeholder: stage === 'won' ? 'e.g. Strong samples' : 'e.g. Budget' }, confirmLabel: stage === 'won' ? 'Mark won' : 'Mark lost' });
      if (reason === null) return;
      move.mutate({ id, stage, outcome_reason: reason || null });
      if (stage === 'won' && !l.client_id) toast.info('Open the lead and use “Won → create client” to start onboarding.', { label: 'Open', onClick: () => setOpenId(id) });
    } else move.mutate({ id, stage });
  };
  const byStage = useMemo(() => {
    const m = new Map<LeadStage, LeadRow[]>(BOARD_STAGES.map((s) => [s, []]));
    for (const l of leads.data?.leads ?? []) m.get(l.stage)?.push(l);
    return m;
  }, [leads.data]);
  if (metrics.isLoading && leads.isLoading) return <PageSkeleton />;
  const m = metrics.data;

  return (
    <div>
      <PageHeader
        title="Sales pipeline"
        description="Prospects from first contact to signed retainer. Nothing here contacts anyone — you log the outreach you did."
        actions={
          <>
            <Button icon={<Upload className="size-4" />} onClick={() => setImporting(true)}>
              Import CSV
            </Button>
            <Button href={`/api/leads/export.csv${query}`} download icon={<Download className="size-4" />}>
              Export
            </Button>
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
              New lead
            </Button>
          </>
        }
      />

      {m && (
        <div className="grid grid-cols-2 xl:grid-cols-5 gap-4 mb-5">
          <Card className="p-4">
            <div className="text-[12px] text-ink-3 mb-2">Open pipeline</div>
            <MoneyStack groups={m.value.total} size="md" empty="—" />
            <div className="text-[11.5px] text-ink-3 mt-1">{m.value.open_count} open deals</div>
          </Card>
          <Card className="p-4">
            <div className="text-[12px] text-ink-3 mb-2" title="Each open deal × the typical win chance of its stage">Weighted forecast</div>
            <MoneyStack groups={m.value.weighted} size="md" empty="—" />
            <div className="text-[11.5px] text-ink-3 mt-1">a forecast, not booked revenue</div>
          </Card>
          <Card className="p-4">
            <div className="text-[12px] text-ink-3 mb-2">Win rate</div>
            <div className="text-[20px] font-semibold">{pct(m.win_rate)}</div>
            <div className="text-[11.5px] text-ink-3 mt-1">
              {m.won} won · {m.lost} lost
            </div>
          </Card>
          <Card className="p-4">
            <div className="text-[12px] text-ink-3 mb-2">Avg. time to close</div>
            <div className="text-[20px] font-semibold">{m.avg_days_to_close === null ? '—' : `${m.avg_days_to_close} days`}</div>
            <div className="text-[11.5px] text-ink-3 mt-1">created → won</div>
          </Card>
          <Card className="p-4 col-span-2 xl:col-span-1">
            <div className="text-[12px] text-ink-3 mb-2">Follow-ups</div>
            <div className="flex items-baseline gap-3">
              <button type="button" className="text-[20px] font-semibold text-bad cursor-pointer hover:underline" onClick={() => setFollowUp(followUp === 'overdue' ? '' : 'overdue')}>
                {m.follow_ups.overdue}
              </button>
              <span className="text-[12px] text-ink-3">overdue</span>
              <button type="button" className="text-[20px] font-semibold text-warn cursor-pointer hover:underline" onClick={() => setFollowUp(followUp === 'today' ? '' : 'today')}>
                {m.follow_ups.today}
              </button>
              <span className="text-[12px] text-ink-3">today</span>
            </div>
          </Card>
        </div>
      )}

      <div className="flex flex-col md:flex-row md:items-center gap-2 mb-4">
        <Segmented
          label="View"
          value={view}
          onChange={setView}
          options={[
            { value: 'board', label: <span className="inline-flex items-center gap-1.5"><Kanban className="size-3.5" />Board</span> },
            { value: 'table', label: <span className="inline-flex items-center gap-1.5"><List className="size-3.5" />Table</span> },
            { value: 'insights', label: <span className="inline-flex items-center gap-1.5"><BarChart3 className="size-3.5" />Insights</span> },
          ]}
        />
        {view !== 'insights' && (
          <>
          <div className="relative md:max-w-64 w-full">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-ink-3" aria-hidden />
            <Input aria-label="Search leads" placeholder="Name, company, email, website…" className="!pl-9" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <Select aria-label="Source" value={source} onChange={(e) => setSource(e.target.value)} className="md:!w-44">
            <option value="">All sources</option>
            {LEAD_SOURCE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
          <Segmented label="Follow-up" value={followUp || 'all'} onChange={(v) => setFollowUp(v === 'all' ? '' : v)} options={[{ value: 'all', label: 'All' }, { value: 'due', label: 'Due now' }, { value: 'overdue', label: 'Overdue' }, { value: 'today', label: 'Today' }]} />
          </>
        )}
      </div>

      {leads.error ? (
        <ErrorState error={leads.error} onRetry={() => leads.refetch()} />
      ) : view === 'insights' ? (
        m ? <Insights m={m} /> : <Skeleton className="h-64" />
      ) : (leads.data?.leads ?? []).length === 0 && !dq && !source && !followUp ? (
        <Card>
          <EmptyState icon={<UserCheck className="size-5" />} title="No leads yet" body="Add prospects you are talking to, or import a CSV you exported from a spreadsheet or another CRM." action={<><Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>New lead</Button><Button icon={<Upload className="size-4" />} onClick={() => setImporting(true)}>Import CSV</Button></>} />
        </Card>
      ) : view === 'board' ? (
        <div className="-mx-4 sm:-mx-6 px-4 sm:px-6 overflow-x-auto pb-4">
          <div className="grid grid-flow-col auto-cols-[minmax(240px,1fr)] gap-3 min-w-max">
            {BOARD_STAGES.map((stage) => {
              const items = byStage.get(stage) ?? [];
              const stageValue = m?.value.by_stage.find((s) => s.stage === stage)?.total;
              return (
                <section
                  key={stage}
                  aria-label={LEAD_STAGE_LABELS[stage]}
                  onDragOver={(e: DragEvent) => {
                    e.preventDefault();
                    setOver(stage);
                  }}
                  onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setOver(null)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setOver(null);
                    dropTo(Number(e.dataTransfer.getData('text/plain')), stage);
                  }}
                  className={cx('flex flex-col rounded-2xl ring-1 ring-inset min-h-[380px]', over === stage ? 'ring-accent/50 bg-accent/[0.05]' : stage === 'won' ? 'ring-good-dot/15 bg-good-dot/[0.03]' : stage === 'lost' ? 'ring-white/[0.04] bg-black/10' : 'ring-white/[0.05] bg-white/[0.02]')}
                >
                  <header className="px-3 pt-3 pb-2">
                    <div className="flex items-center gap-2">
                      <span className="size-2 rounded-full" style={{ background: stage === 'won' ? 'var(--color-good-dot)' : stage === 'lost' ? 'var(--color-ink-3)' : `var(--color-stage-${LEAD_STAGES.indexOf(stage) + 1})` }} aria-hidden />
                      <h2 className="text-[12.5px] font-semibold text-ink-2">{LEAD_STAGE_LABELS[stage]}</h2>
                      <span className="ml-auto text-[11.5px] tabular text-ink-3">{items.length}</span>
                    </div>
                    {stageValue && stageValue.length > 0 && <div className="text-[11.5px] text-ink-3 mt-0.5 tabular">{groupsText(stageValue)}</div>}
                  </header>
                  <div className="flex flex-col gap-2 p-2 pt-0">
                    {items.map((l) => (
                      <article
                        key={l.id}
                        draggable
                        onDragStart={(e) => e.dataTransfer.setData('text/plain', String(l.id))}
                        onClick={() => setOpenId(l.id)}
                        className={cx('rounded-xl bg-surface-2 ring-1 ring-inset p-3 cursor-pointer hover:ring-white/[0.14]', l.follow_up_overdue ? 'ring-bad-dot/40' : 'ring-white/[0.07]')}
                      >
                        <h3 className="text-[13px] font-medium text-ink leading-snug">{l.company || l.name}</h3>
                        <p className="text-[11.5px] text-ink-3 truncate">
                          {l.company ? `${l.name} · ` : ''}
                          {LEAD_SOURCE_LABELS[l.source as keyof typeof LEAD_SOURCE_LABELS] ?? l.source}
                        </p>
                        <div className="mt-2 flex items-center gap-2 flex-wrap">
                          <Value l={l} />
                          {l.next_follow_up && stage !== 'won' && stage !== 'lost' && (
                            <span className="ml-auto inline-flex items-center gap-1">
                              <CalendarClock className="size-3 text-ink-3" aria-hidden />
                              <DueChip date={l.next_follow_up} today={today} compact />
                            </span>
                          )}
                          {(stage === 'won' || stage === 'lost') && l.outcome_reason && <span className="text-[11.5px] text-ink-3 truncate w-full">“{l.outcome_reason}”</span>}
                        </div>
                        {l.is_demo ? <div className="mt-2"><DemoBadge /></div> : null}
                      </article>
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        </div>
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead className="text-left text-[12px] text-ink-3 border-b border-line">
                <tr>
                  <th className="py-2.5 px-5 font-medium">Prospect</th>
                  <th className="py-2.5 px-3 font-medium">Stage</th>
                  <th className="py-2.5 px-3 font-medium">Source</th>
                  <th className="py-2.5 px-3 font-medium text-right">Value</th>
                  <th className="py-2.5 px-3 font-medium">Last contact</th>
                  <th className="py-2.5 px-5 font-medium">Next follow-up</th>
                </tr>
              </thead>
              <tbody>
                {(leads.data?.leads ?? []).map((l) => (
                  <tr key={l.id} className="border-b border-line last:border-0 hover:bg-white/[0.025] cursor-pointer" onClick={() => setOpenId(l.id)}>
                    <td className="py-2.5 px-5">
                      <div className="text-ink font-medium">
                        {l.company || l.name} {l.is_demo ? <DemoBadge /> : null}
                      </div>
                      <div className="text-[11.5px] text-ink-3">{l.company ? l.name : l.email}</div>
                    </td>
                    <td className="py-2.5 px-3">
                      <LeadStageBadge stage={l.stage} />
                    </td>
                    <td className="py-2.5 px-3 text-ink-2">{LEAD_SOURCE_LABELS[l.source as keyof typeof LEAD_SOURCE_LABELS] ?? l.source}</td>
                    <td className="py-2.5 px-3 text-right">
                      <Value l={l} />
                    </td>
                    <td className="py-2.5 px-3 text-ink-2 tabular">{l.last_contact_at ? formatDate(l.last_contact_at, today) : '—'}</td>
                    <td className="py-2.5 px-5">{l.next_follow_up && l.stage !== 'won' && l.stage !== 'lost' ? <DueChip date={l.next_follow_up} today={today} /> : <span className="text-ink-3">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {(leads.data?.leads ?? []).length === 0 && <p className="py-10 text-center text-[13px] text-ink-3">No leads match these filters.</p>}
          </div>
        </Card>
      )}

      <LeadDrawer id={openId} onClose={() => setOpenId(null)} onEdit={(l) => setEditing(l)} />
      <LeadFormDialog open={editing !== null} onClose={() => setEditing(null)} lead={editing === 'new' ? null : editing} onSaved={(id) => editing === 'new' && setOpenId(id)} />
      <ImportDialog open={importing} onClose={() => setImporting(false)} />
    </div>
  );
}
