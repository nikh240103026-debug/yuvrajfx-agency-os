import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, GripVertical, Plus, Trash2 } from 'lucide-react';
import { api, ApiError, errorMessage } from '../lib/api.ts';
import { invalidateAll, useClients, useProjects } from '../lib/queries.ts';
import { Button, Card, Checkbox, Field, IconButton, Input, Notice, PageSkeleton, Select, Textarea, TextField } from '../components/ui.tsx';
import { CurrencySelect, MoneyInput } from '../components/money.tsx';
import { ClientSelect } from '../components/forms.tsx';
import { useToast } from '../components/overlay.tsx';
import type { InvoiceDetail } from '../components/invoice-document.tsx';
import { SERVICE_TYPE_OPTIONS, type ServiceType } from '../../shared/constants.ts';
import { computeInvoiceTotals, formatMoney, fromMinor, toMinor } from '../../shared/money.ts';
import { addDays, isValidDate } from '../../shared/dates.ts';

type Line = { key: number; description: string; quantity: string; rate: string; service_type: ServiceType };
type Meta = { next_number: string; default_taxes: { label: string; rate: number }[]; default_terms: string; default_payment_terms_days: number; today: string };

let keySeq = 1;
const newLine = (service: ServiceType = 'other'): Line => ({ key: keySeq++, description: '', quantity: '1', rate: '', service_type: service });

function serviceForProjectType(type?: string): ServiceType {
  return (SERVICE_TYPE_OPTIONS.find((o) => o.value === type)?.value as ServiceType) ?? 'other';
}

export default function InvoiceEditorPage() {
  const { id } = useParams();
  const editing = !!id;
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { data: meta } = useQuery({ queryKey: ['invoice-meta'], queryFn: () => api.get<Meta>('/api/invoices/meta') });
  const existing = useQuery({ queryKey: ['invoice', id], queryFn: () => api.get<{ invoice: InvoiceDetail }>(`/api/invoices/${id}`), enabled: editing });
  const { data: clientsData } = useClients();
  const clients = clientsData?.clients ?? [];
  const [clientId, setClientId] = useState<number | null>(params.get('client') ? Number(params.get('client')) : null);
  const { data: projectsData } = useProjects('?scope=all');
  const projects = (projectsData?.projects ?? []).filter((p) => p.client_id === clientId);

  const [form, setForm] = useState({
    number: '',
    project_id: params.get('project') ? Number(params.get('project')) : (null as number | null),
    currency: 'USD',
    issue_date: '',
    due_date: '',
    period_start: '',
    period_end: '',
    discount_type: 'none' as 'none' | 'percent' | 'fixed',
    discount_percent: '',
    discount_fixed: '',
    notes: '',
    terms: '',
    internal_notes: '',
    portal_visible: true,
  });
  const [taxes, setTaxes] = useState<{ label: string; rate: string }[]>([]);
  const [lines, setLines] = useState<Line[]>([newLine()]);
  const [dueTouched, setDueTouched] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const initialised = useRef(false);

  // Initialise once from the invoice being edited, or from defaults for a new one.
  useEffect(() => {
    if (initialised.current) return;
    if (editing) {
      const inv = existing.data?.invoice;
      if (!inv) return;
      initialised.current = true;
      setClientId(inv.client_id);
      setForm({
        number: inv.number,
        project_id: inv.project_id,
        currency: inv.currency,
        issue_date: inv.issue_date,
        due_date: inv.due_date,
        period_start: inv.period_start ?? '',
        period_end: inv.period_end ?? '',
        discount_type: inv.discount_type,
        discount_percent: inv.discount_type === 'percent' ? String(inv.discount_percent) : '',
        discount_fixed: inv.discount_type === 'fixed' ? fromMinor(inv.discount_fixed_minor, inv.currency) : '',
        notes: inv.notes ?? '',
        terms: inv.terms ?? '',
        internal_notes: inv.internal_notes ?? '',
        portal_visible: !!inv.portal_visible,
      });
      setTaxes(inv.taxes.map((t) => ({ label: t.label, rate: String(t.rate) })));
      setLines(inv.items.map((it) => ({ key: keySeq++, description: it.description, quantity: String(it.quantity), rate: fromMinor(it.unit_price_minor, inv.currency), service_type: it.service_type as ServiceType })));
      setDueTouched(true);
    } else if (meta && clientsData) {
      initialised.current = true;
      const client = clients.find((c) => c.id === clientId);
      const project = projectsData?.projects.find((p) => p.id === form.project_id);
      setForm((f) => ({
        ...f,
        currency: client?.currency ?? f.currency,
        issue_date: meta.today,
        due_date: addDays(meta.today, client?.payment_terms_days ?? meta.default_payment_terms_days),
        terms: meta.default_terms,
      }));
      setTaxes(meta.default_taxes.map((t) => ({ label: t.label, rate: String(t.rate) })));
      setLines([{ ...newLine(project ? serviceForProjectType(project.type) : client?.retainer_minor ? 'retainer' : 'other'), description: project ? project.name : '' }]);
    }
  }, [editing, existing.data, meta, clientsData, clients, clientId, projectsData, form.project_id]);

  // Prefill currency once clients load (for links like /invoices/new?client=3).
  useEffect(() => {
    if (editing || !clientId) return;
    const client = clients.find((c) => c.id === clientId);
    if (client) setForm((f) => ({ ...f, currency: client.currency }));
  }, [clients, clientId, editing]);

  const onClient = (cid: number | null) => {
    setClientId(cid);
    const c = clients.find((x) => x.id === cid);
    setForm((f) => ({ ...f, project_id: null, currency: c?.currency ?? f.currency, due_date: !dueTouched && f.issue_date && isValidDate(f.issue_date) ? addDays(f.issue_date, c?.payment_terms_days ?? meta?.default_payment_terms_days ?? 7) : f.due_date }));
    if (c?.retainer_minor && lines.length === 1 && !lines[0].description && !lines[0].rate) setLines([{ ...lines[0], service_type: 'retainer', description: c.service_package ?? 'Monthly retainer', rate: fromMinor(c.retainer_minor, c.currency) }]);
  };
  const onIssue = (v: string) => {
    const c = clients.find((x) => x.id === clientId);
    setForm((f) => ({ ...f, issue_date: v, due_date: !dueTouched && isValidDate(v) ? addDays(v, c?.payment_terms_days ?? meta?.default_payment_terms_days ?? 7) : f.due_date }));
  };

  const parsed = useMemo(() => {
    const items = lines.map((l) => ({ quantity: Number(l.quantity.replace(',', '.')), unit_price_minor: toMinor(l.rate || '0', form.currency) }));
    const valid = items.every((i) => Number.isFinite(i.quantity) && i.quantity > 0 && i.unit_price_minor !== null);
    const totals = valid
      ? computeInvoiceTotals({
          items: items as { quantity: number; unit_price_minor: number }[],
          discount_type: form.discount_type,
          discount_percent: Number(form.discount_percent) || 0,
          discount_fixed_minor: toMinor(form.discount_fixed || '0', form.currency) ?? 0,
          taxes: taxes.filter((t) => t.label.trim() && t.rate !== '').map((t) => ({ label: t.label.trim(), rate: Number(t.rate) || 0 })),
        })
      : null;
    return { items, valid, totals };
  }, [lines, form.currency, form.discount_type, form.discount_percent, form.discount_fixed, taxes]);

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>): Promise<{ id?: number }> => (editing ? api.put(`/api/invoices/${id}`, body) : api.post('/api/invoices', body)),
    onSuccess: (res) => {
      invalidateAll(qc, 'invoices', 'invoice', 'client', 'clients', 'finance');
      toast.success(editing ? 'Invoice saved' : 'Draft invoice created');
      navigate(`/invoices/${editing ? id : res.id}`);
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setLocalError(null);
    if (!clientId) return setLocalError('Choose a client.');
    if (lines.some((l) => !l.description.trim())) return setLocalError('Every line needs a description.');
    if (!parsed.valid) return setLocalError('Check the quantities and rates — they must be numbers, with at most two decimals for most currencies.');
    if (form.discount_type === 'fixed' && toMinor(form.discount_fixed || '0', form.currency) === null) return setLocalError('Discount amount is not valid.');
    save.mutate({
      number: form.number.trim() || null,
      client_id: clientId,
      project_id: form.project_id,
      currency: form.currency,
      issue_date: form.issue_date,
      due_date: form.due_date,
      period_start: form.period_start || null,
      period_end: form.period_end || null,
      discount_type: form.discount_type,
      discount_percent: Number(form.discount_percent) || 0,
      discount_fixed_minor: toMinor(form.discount_fixed || '0', form.currency) ?? 0,
      taxes: taxes.filter((t) => t.label.trim()).map((t) => ({ label: t.label.trim(), rate: Number(t.rate) || 0 })),
      notes: form.notes,
      terms: form.terms,
      internal_notes: form.internal_notes,
      portal_visible: form.portal_visible,
      items: lines.map((l, i) => ({ description: l.description.trim(), quantity: parsed.items[i].quantity, unit_price_minor: parsed.items[i].unit_price_minor, service_type: l.service_type })),
    });
  };

  if ((editing && existing.isLoading) || !meta) return <PageSkeleton />;
  if (editing && existing.error) return <Notice tone="bad">{errorMessage(existing.error)}</Notice>;
  const inv = existing.data?.invoice;
  const error = save.error instanceof ApiError ? save.error : null;
  const m = (v: number) => formatMoney(v, form.currency, { decimals: 'always' });
  const hasPayments = (inv?.paid_minor ?? 0) > 0;

  return (
    <form onSubmit={submit}>
      <Link to={editing ? `/invoices/${id}` : '/invoices'} className="inline-flex items-center gap-1 text-[12.5px] text-ink-3 hover:text-ink mb-3">
        <ArrowLeft className="size-3.5" /> {editing ? inv?.number : 'Invoices'}
      </Link>
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3 mb-6">
        <div>
          <h1 className="text-[24px] font-semibold tracking-tight">{editing ? `Edit ${inv?.number}` : 'New invoice'}</h1>
          <p className="text-[13.5px] text-ink-3 mt-1">{editing ? (inv?.state === 'sent' ? 'This invoice was already sent — the client will need the updated version.' : 'Draft — nothing has been sent.') : 'Saved as a draft. You send it yourself, then mark it as sent.'}</p>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" to={editing ? `/invoices/${id}` : '/invoices'}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={save.isPending}>
            {editing ? 'Save invoice' : 'Save draft'}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_340px] gap-4">
        <div className="flex flex-col gap-4 min-w-0">
          <Card className="p-5">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <Field label="Client" required error={error?.field('client_id')}>
                <ClientSelect required value={clientId} clients={clients.filter((c) => !c.archived_at || c.id === clientId)} onChange={(cid) => onClient(cid)} />
              </Field>
              <Field label="Project" optional>
                <Select value={form.project_id ?? ''} onChange={(e) => setForm({ ...form, project_id: e.target.value ? Number(e.target.value) : null })} disabled={!clientId}>
                  <option value="">Not linked to a project</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <TextField label="Invoice number" value={form.number} placeholder={editing ? undefined : `${meta.next_number} (automatic)`} onChange={(e) => setForm({ ...form, number: e.target.value })} error={error?.field('number')} hint={editing ? undefined : 'Leave empty to use the next number.'} />
              <Field label="Currency" hint={hasPayments ? 'Locked: payments are recorded in this currency.' : 'Invoices are always in a single currency.'}>
                {hasPayments ? <Input value={form.currency} disabled /> : <CurrencySelect value={form.currency} onChange={(v) => setForm({ ...form, currency: v })} />}
              </Field>
              <TextField label="Issue date" type="date" required value={form.issue_date} onChange={(e) => onIssue(e.target.value)} error={error?.field('issue_date')} />
              <TextField
                label="Due date"
                type="date"
                required
                value={form.due_date}
                onChange={(e) => {
                  setDueTouched(true);
                  setForm({ ...form, due_date: e.target.value });
                }}
                error={error?.field('due_date')}
                hint={!dueTouched ? 'Set from the client’s payment terms.' : undefined}
              />
              <TextField label="Service period from" optional type="date" value={form.period_start} onChange={(e) => setForm({ ...form, period_start: e.target.value })} />
              <TextField label="Service period to" optional type="date" value={form.period_end} onChange={(e) => setForm({ ...form, period_end: e.target.value })} />
            </div>
          </Card>

          <Card className="p-5">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-[14px] font-semibold">Line items</h2>
              <span className="text-[12px] text-ink-3">Service type powers “revenue by service”.</span>
            </div>
            <div className="hidden md:grid grid-cols-[18px_minmax(0,1fr)_150px_80px_140px_120px_36px] gap-2 px-1 mb-1.5 text-[11.5px] text-ink-3">
              <span />
              <span>Description</span>
              <span>Service</span>
              <span>Qty</span>
              <span>Rate</span>
              <span className="text-right">Amount</span>
              <span />
            </div>
            <ul className="flex flex-col gap-2">
              {lines.map((l, i) => {
                const amount = parsed.valid && parsed.totals ? parsed.totals.lines[i]?.amount_minor ?? 0 : null;
                const update = (patch: Partial<Line>) => setLines(lines.map((x) => (x.key === l.key ? { ...x, ...patch } : x)));
                return (
                  <li key={l.key} className="grid grid-cols-2 md:grid-cols-[18px_minmax(0,1fr)_150px_80px_140px_120px_36px] gap-2 items-start rounded-xl md:rounded-none p-3 md:p-0 bg-white/[0.02] md:bg-transparent">
                    <span className="hidden md:grid place-items-center h-9 text-ink-3/60" aria-hidden>
                      <GripVertical className="size-4" />
                    </span>
                    <Input aria-label={`Line ${i + 1} description`} className="col-span-2 md:col-span-1" placeholder="e.g. 12 short-form edits — October" value={l.description} onChange={(e) => update({ description: e.target.value })} />
                    <Select aria-label={`Line ${i + 1} service`} value={l.service_type} onChange={(e) => update({ service_type: e.target.value as ServiceType })}>
                      {SERVICE_TYPE_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </Select>
                    <Input aria-label={`Line ${i + 1} quantity`} inputMode="decimal" className="tabular" value={l.quantity} onChange={(e) => update({ quantity: e.target.value.replace(/[^\d.,]/g, '') })} />
                    <MoneyInput aria-label={`Line ${i + 1} rate`} currency={form.currency} value={l.rate} onChange={(v) => update({ rate: v })} />
                    <div className="h-9 flex items-center justify-end text-[13px] font-medium tabular text-ink">{amount === null ? <span className="text-bad text-[12px]">check</span> : m(amount)}</div>
                    <IconButton label={`Remove line ${i + 1}`} disabled={lines.length === 1} onClick={() => setLines(lines.filter((x) => x.key !== l.key))}>
                      <Trash2 className="size-4" />
                    </IconButton>
                  </li>
                );
              })}
            </ul>
            <Button size="sm" variant="ghost" className="mt-2 -ml-2" icon={<Plus className="size-3.5" />} onClick={() => setLines([...lines, newLine(lines[lines.length - 1]?.service_type)])}>
              Add line
            </Button>
          </Card>

          <Card className="p-5 grid md:grid-cols-2 gap-3">
            <Field label="Notes" hint="Shown on the invoice.">
              <Textarea rows={3} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Thank you for the project!" />
            </Field>
            <Field label="Terms" hint="Shown on the invoice. Default comes from Settings.">
              <Textarea rows={3} value={form.terms} onChange={(e) => setForm({ ...form, terms: e.target.value })} placeholder="Payment due within 7 days." />
            </Field>
            <Field label="Internal notes" hint="Only you see these.">
              <Textarea rows={2} value={form.internal_notes} onChange={(e) => setForm({ ...form, internal_notes: e.target.value })} />
            </Field>
            <div className="flex items-end pb-1">
              <Checkbox label="Visible in the client portal once sent" checked={form.portal_visible} onChange={(v) => setForm({ ...form, portal_visible: v })} />
            </div>
          </Card>
        </div>

        <aside className="xl:sticky xl:top-20 h-fit flex flex-col gap-4">
          <Card className="p-5">
            <h2 className="text-[14px] font-semibold mb-3">Discount & tax</h2>
            <div className="grid grid-cols-[1fr_1fr] gap-2">
              <Select aria-label="Discount type" value={form.discount_type} onChange={(e) => setForm({ ...form, discount_type: e.target.value as typeof form.discount_type })}>
                <option value="none">No discount</option>
                <option value="percent">Discount %</option>
                <option value="fixed">Discount amount</option>
              </Select>
              {form.discount_type === 'percent' && <Input aria-label="Discount percent" inputMode="decimal" placeholder="10" value={form.discount_percent} onChange={(e) => setForm({ ...form, discount_percent: e.target.value.replace(/[^\d.]/g, '') })} />}
              {form.discount_type === 'fixed' && <MoneyInput aria-label="Discount amount" currency={form.currency} value={form.discount_fixed} onChange={(v) => setForm({ ...form, discount_fixed: v })} />}
            </div>
            <div className="mt-4 flex flex-col gap-2">
              {taxes.map((t, i) => (
                <div key={i} className="grid grid-cols-[1fr_80px_36px] gap-2">
                  <Input aria-label="Tax label" placeholder="GST / VAT" value={t.label} onChange={(e) => setTaxes(taxes.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
                  <div className="relative">
                    <Input aria-label="Tax rate" inputMode="decimal" className="tabular !pr-6" value={t.rate} onChange={(e) => setTaxes(taxes.map((x, j) => (j === i ? { ...x, rate: e.target.value.replace(/[^\d.]/g, '') } : x)))} />
                    <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[12px] text-ink-3">%</span>
                  </div>
                  <IconButton label="Remove tax" onClick={() => setTaxes(taxes.filter((_, j) => j !== i))}>
                    <Trash2 className="size-4" />
                  </IconButton>
                </div>
              ))}
              {taxes.length < 4 && (
                <Button size="sm" variant="ghost" className="self-start -ml-2" icon={<Plus className="size-3.5" />} onClick={() => setTaxes([...taxes, { label: taxes.length === 0 ? 'GST' : '', rate: taxes.length === 0 ? '18' : '' }])}>
                  Add tax
                </Button>
              )}
              <p className="text-[11.5px] text-ink-3">Taxes apply to the subtotal after discount. For Indian intra-state GST use CGST 9% + SGST 9%; inter-state IGST 18%; exports under LUT usually 0%.</p>
            </div>
          </Card>
          <Card className="p-5">
            <h2 className="text-[14px] font-semibold mb-3">Totals</h2>
            {parsed.totals ? (
              <dl className="text-[13px] flex flex-col gap-1.5">
                <div className="flex justify-between">
                  <dt className="text-ink-3">Subtotal</dt>
                  <dd className="tabular">{m(parsed.totals.subtotal_minor)}</dd>
                </div>
                {parsed.totals.discount_minor > 0 && (
                  <div className="flex justify-between">
                    <dt className="text-ink-3">Discount</dt>
                    <dd className="tabular">−{m(parsed.totals.discount_minor)}</dd>
                  </div>
                )}
                {parsed.totals.tax_lines.map((t) => (
                  <div key={t.label} className="flex justify-between">
                    <dt className="text-ink-3">
                      {t.label} {t.rate}%
                    </dt>
                    <dd className="tabular">{m(t.amount_minor)}</dd>
                  </div>
                ))}
                <div className="flex justify-between pt-2 mt-1 border-t border-line text-[16px] font-semibold">
                  <dt>Total</dt>
                  <dd className="tabular">{m(parsed.totals.total_minor)}</dd>
                </div>
                {hasPayments && (
                  <>
                    <div className="flex justify-between text-good">
                      <dt>Already paid</dt>
                      <dd className="tabular">−{m(inv!.paid_minor)}</dd>
                    </div>
                    {parsed.totals.total_minor < inv!.paid_minor && <Notice tone="bad">The total can’t be lower than what has already been paid.</Notice>}
                  </>
                )}
              </dl>
            ) : (
              <p className="text-[13px] text-bad">Fix the highlighted lines to see totals.</p>
            )}
          </Card>
          {(localError || error) && <Notice tone="bad">{localError ?? error?.message}</Notice>}
          <Button type="submit" variant="primary" loading={save.isPending} className="w-full">
            {editing ? 'Save invoice' : 'Save draft'}
          </Button>
        </aside>
      </div>
    </form>
  );
}
