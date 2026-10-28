import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Plus, Trash2 } from 'lucide-react';
import { api, ApiError, errorMessage } from '../lib/api.ts';
import { invalidateAll, useBaseCurrency, useClients, useProjects, useTeam, useToday, type ClientRow, type DeliverableRow, type ProjectRow, type TeamMember } from '../lib/queries.ts';
import { Dialog, useToast } from './overlay.tsx';
import { Button, Checkbox, Field, IconButton, Input, Notice, Select, SelectField, TextareaField, TextField } from './ui.tsx';
import { CurrencySelect, MoneyField, MoneyInput } from './money.tsx';
import { LinkListEditor, TagInput, type LinkItem } from './inputs.tsx';
import {
  BILLING_CYCLE_OPTIONS,
  BILLING_TYPE_OPTIONS,
  CLIENT_STATUS_OPTIONS,
  COMM_CHANNEL_OPTIONS,
  COMM_DIRECTION_OPTIONS,
  COST_UNIT_OPTIONS,
  DEAL_TYPE_OPTIONS,
  EXPENSE_CATEGORY_OPTIONS,
  FORMAT_SUGGESTIONS,
  LEAD_SOURCE_OPTIONS,
  LEAD_STAGE_OPTIONS,
  PAYMENT_METHOD_OPTIONS,
  PLATFORM_OPTIONS,
  PRIORITY_OPTIONS,
  PROJECT_STATUS_OPTIONS,
  PROJECT_TYPE_OPTIONS,
  SOCIAL_KEYS,
  SOCIAL_LABELS,
  STAGE_OPTIONS,
  TASK_STATUS_OPTIONS,
} from '../../shared/constants.ts';
import { formatMoney, fromMinor, toMinor } from '../../shared/money.ts';
import { cx, useDebounced } from '../lib/util.ts';

// Shared helpers ---------------------------------------------------------------

function useFormState<T extends Record<string, unknown>>(initial: T) {
  const [form, setForm] = useState<T>(initial);
  const set =
    <K extends keyof T>(k: K) =>
    (v: T[K]) =>
      setForm((f) => ({ ...f, [k]: v }));
  return { form, setForm, set };
}

function errOf(e: unknown): ApiError | null {
  return e instanceof ApiError ? e : e ? new ApiError(errorMessage(e), 0, null) : null;
}

function FormError({ error }: { error: ApiError | null }) {
  if (!error) return null;
  const fields = error.details?.fields ? Object.keys(error.details.fields) : [];
  return <Notice tone="bad">{fields.length > 1 ? `${error.message} (and ${fields.length - 1} more field${fields.length > 2 ? 's' : ''})` : error.message}</Notice>;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="label-caps mb-1">{title}</legend>
      {children}
    </fieldset>
  );
}

const TERMS = [0, 7, 15, 30, 45, 60];

function TermsSelect({ value, onChange, id }: { value: number; onChange: (v: number) => void; id?: string }) {
  const opts = TERMS.includes(value) ? TERMS : [...TERMS, value].sort((a, b) => a - b);
  return (
    <Select id={id} value={value} onChange={(e) => onChange(Number(e.target.value))}>
      {opts.map((d) => (
        <option key={d} value={d}>
          {d === 0 ? 'Due on receipt' : `Net ${d} days`}
        </option>
      ))}
    </Select>
  );
}

function PeopleSelect({ value, onChange, members, placeholder = 'Unassigned', id }: { value: number | null; onChange: (v: number | null) => void; members: TeamMember[]; placeholder?: string; id?: string }) {
  return (
    <Select id={id} value={value ?? ''} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}>
      <option value="">{placeholder}</option>
      {members
        .filter((m) => m.status === 'active' || m.id === value)
        .map((m) => (
          <option key={m.id} value={m.id}>
            {m.name} · {m.title}
          </option>
        ))}
    </Select>
  );
}

export function ClientSelect({ value, onChange, clients, required, placeholder = 'Choose a client…', id }: { value: number | null; onChange: (id: number | null, c: ClientRow | null) => void; clients: ClientRow[]; required?: boolean; placeholder?: string; id?: string }) {
  return (
    <Select
      id={id}
      value={value ?? ''}
      required={required}
      onChange={(e) => {
        const id = e.target.value ? Number(e.target.value) : null;
        onChange(id, clients.find((c) => c.id === id) ?? null);
      }}
    >
      <option value="">{placeholder}</option>
      {clients.map((c) => (
        <option key={c.id} value={c.id}>
          {c.company ? `${c.company} — ${c.name}` : c.name}
          {c.is_demo ? ' (demo)' : ''}
        </option>
      ))}
    </Select>
  );
}

// ── Client ───────────────────────────────────────────────────────────────────

export function ClientFormDialog({ open, onClose, client, onSaved }: { open: boolean; onClose: () => void; client?: ClientRow | null; onSaved?: (id: number) => void }) {
  return (
    <Dialog open={open} onClose={onClose} title={client ? `Edit ${client.company || client.name}` : 'New client'} description="Contact details, retainer and contract terms." size="lg">
      <ClientForm client={client} onClose={onClose} onSaved={onSaved} />
    </Dialog>
  );
}

function ClientForm({ client, onClose, onSaved }: { client?: ClientRow | null; onClose: () => void; onSaved?: (id: number) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const base = useBaseCurrency();
  const { data: meta } = useQuery({ queryKey: ['clients', 'tags'], queryFn: () => api.get<{ tags: { tag: string }[]; packages: string[] }>('/api/clients/tags') });
  const { form, set } = useFormState({
    name: client?.name ?? '',
    company: client?.company ?? '',
    email: client?.email ?? '',
    phone: client?.phone ?? '',
    whatsapp: client?.whatsapp ?? '',
    other_contact: client?.other_contact ?? '',
    website: client?.website ?? '',
    socials: { ...(client?.socials ?? {}) } as Record<string, string>,
    billing_address: client?.billing_address ?? '',
    tax_id: client?.tax_id ?? '',
    country: client?.country ?? '',
    service_package: client?.service_package ?? '',
    retainer: client?.retainer_minor != null ? fromMinor(client.retainer_minor, client.currency) : '',
    currency: client?.currency ?? (base === 'INR' ? 'USD' : base),
    billing_cycle: client?.billing_cycle ?? 'monthly',
    contract_start: client?.contract_start ?? '',
    renewal_date: client?.renewal_date ?? '',
    payment_terms_days: client?.payment_terms_days ?? 7,
    payment_terms_note: client?.payment_terms_note ?? '',
    status: client?.status ?? 'active',
    tags: client?.tags ?? [],
    notes: client?.notes ?? '',
  });
  const [localError, setLocalError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>): Promise<{ id?: number }> => (client ? api.patch(`/api/clients/${client.id}`, body) : api.post('/api/clients', body)),
    onSuccess: (res) => {
      // The client's name and currency show up on most other screens too.
      invalidateAll(qc, 'clients', 'timeline', 'projects', 'project', 'deliverables', 'invoices', 'invoice', 'payments', 'tasks');
      toast.success(client ? 'Client updated' : 'Client added');
      const id = client ? client.id : res.id;
      if (id) onSaved?.(id);
      onClose();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setLocalError(null);
    const retainer = form.retainer.trim() ? toMinor(form.retainer, form.currency) : null;
    if (form.retainer.trim() && retainer === null) return setLocalError('Retainer must be a valid amount.');
    const { retainer: _r, ...rest } = form;
    save.mutate({ ...rest, retainer_minor: retainer });
  };
  const error = errOf(save.error);
  const f = (k: string) => error?.field(k);
  return (
    <form onSubmit={submit} className="flex flex-col gap-6">
      <Section title="Contact">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <TextField label="Contact name" required value={form.name} onChange={(e) => set('name')(e.target.value)} error={f('name')} autoFocus />
          <TextField label="Company / channel" value={form.company} onChange={(e) => set('company')(e.target.value)} error={f('company')} />
          <TextField label="Email" type="email" value={form.email} onChange={(e) => set('email')(e.target.value)} error={f('email')} />
          <TextField label="Phone" value={form.phone} onChange={(e) => set('phone')(e.target.value)} error={f('phone')} />
          <TextField label="WhatsApp" value={form.whatsapp} onChange={(e) => set('whatsapp')(e.target.value)} />
          <TextField label="Other contact" placeholder="Slack, Telegram, assistant…" value={form.other_contact} onChange={(e) => set('other_contact')(e.target.value)} />
          <TextField label="Website" placeholder="example.com" value={form.website} onChange={(e) => set('website')(e.target.value)} error={f('website')} />
          <TextField label="Country" value={form.country} onChange={(e) => set('country')(e.target.value)} />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {SOCIAL_KEYS.map((k) => (
            <TextField key={k} label={SOCIAL_LABELS[k]} placeholder={k === 'other' ? 'https://…' : '@handle or link'} value={form.socials[k] ?? ''} onChange={(e) => set('socials')({ ...form.socials, [k]: e.target.value })} />
          ))}
        </div>
      </Section>

      <Section title="Contract & billing">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Service package" htmlFor="client-package" hint="e.g. “Shorts Growth · 12 shorts/mo”">
            <Input id="client-package" list="yfx-packages" value={form.service_package} onChange={(e) => set('service_package')(e.target.value)} />
            <datalist id="yfx-packages">
              {(meta?.packages ?? []).map((p) => (
                <option key={p} value={p} />
              ))}
            </datalist>
          </Field>
          <SelectField label="Status" value={form.status} onChange={(e) => set('status')(e.target.value as ClientRow['status'])}>
            {CLIENT_STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </SelectField>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-[1.4fr_1fr_1fr] gap-3">
          <MoneyField label="Retainer" optional currency={form.currency} value={form.retainer} onChange={set('retainer')} error={localError ?? f('retainer_minor')} hint="Contracted amount per billing cycle. Leave empty for project-based clients." />
          <Field label="Currency">
            <CurrencySelect value={form.currency} onChange={set('currency')} />
          </Field>
          <SelectField label="Billing cycle" value={form.billing_cycle} onChange={(e) => set('billing_cycle')(e.target.value as ClientRow['billing_cycle'])}>
            {BILLING_CYCLE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </SelectField>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <TextField label="Contract start" type="date" value={form.contract_start} onChange={(e) => set('contract_start')(e.target.value)} error={f('contract_start')} />
          <TextField label="Renewal date" type="date" value={form.renewal_date} onChange={(e) => set('renewal_date')(e.target.value)} error={f('renewal_date')} />
          <Field label="Payment terms">
            <TermsSelect value={form.payment_terms_days} onChange={set('payment_terms_days')} />
          </Field>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <TextField label="Payment terms note" optional placeholder="e.g. 50% upfront for new projects" value={form.payment_terms_note} onChange={(e) => set('payment_terms_note')(e.target.value)} />
          <TextField label="Client tax ID" optional placeholder="GSTIN / VAT number" value={form.tax_id} onChange={(e) => set('tax_id')(e.target.value)} />
        </div>
        <TextareaField label="Billing address" optional rows={2} value={form.billing_address} onChange={(e) => set('billing_address')(e.target.value)} />
      </Section>

      <Section title="Tags & notes">
        <Field label="Tags">
          <TagInput id="client-tags" value={form.tags} onChange={set('tags')} suggestions={(meta?.tags ?? []).map((t) => t.tag)} />
        </Field>
        <TextareaField label="Notes" rows={3} value={form.notes} onChange={(e) => set('notes')(e.target.value)} placeholder="Preferences, brand rules, anything the team should know." />
      </Section>

      <FormError error={error} />
      <div className="flex justify-end gap-2 sticky bottom-0 -mx-5 -mb-4 px-5 py-3 bg-surface border-t border-line">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={save.isPending}>
          {client ? 'Save changes' : 'Add client'}
        </Button>
      </div>
    </form>
  );
}

// ── Project ──────────────────────────────────────────────────────────────────

type DraftDeliverable = { title: string; deadline: string; platform: string; format: string };

export function ProjectFormDialog({ open, onClose, project, defaultClientId, onSaved }: { open: boolean; onClose: () => void; project?: ProjectRow | null; defaultClientId?: number | null; onSaved?: (id: number) => void }) {
  return (
    <Dialog open={open} onClose={onClose} title={project ? `Edit ${project.name}` : 'New project'} description={project ? undefined : 'A project groups the videos and assets you deliver for one brief.'} size="lg">
      <ProjectForm project={project} defaultClientId={defaultClientId} onClose={onClose} onSaved={onSaved} />
    </Dialog>
  );
}

function ProjectForm({ project, defaultClientId, onClose, onSaved }: { project?: ProjectRow | null; defaultClientId?: number | null; onClose: () => void; onSaved?: (id: number) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: clientsData } = useClients();
  const { data: teamData } = useTeam();
  const clients = clientsData?.clients ?? [];
  const members = teamData?.members ?? [];
  const initialClient = clients.find((c) => c.id === (project?.client_id ?? defaultClientId)) ?? null;
  const { form, set, setForm } = useFormState({
    client_id: project?.client_id ?? defaultClientId ?? null,
    name: project?.name ?? '',
    type: project?.type ?? 'short_form',
    billing_type: project?.billing_type ?? (initialClient?.retainer_minor ? 'retainer' : 'fixed'),
    price: project?.price_minor != null ? fromMinor(project.price_minor, project.currency) : '',
    currency: project?.currency ?? initialClient?.currency ?? 'USD',
    start_date: project?.start_date ?? '',
    deadline: project?.deadline ?? '',
    priority: project?.priority ?? 'medium',
    status: project?.status ?? 'backlog',
    editor_id: project?.editor_id ?? null,
    description: project?.description ?? '',
    reference_links: (project?.reference_links ?? []) as LinkItem[],
    asset_links: (project?.asset_links ?? []) as LinkItem[],
    portal_visible: project ? !!project.portal_visible : true,
  });
  const [deliverables, setDeliverables] = useState<DraftDeliverable[]>([]);
  const [bulk, setBulk] = useState({ count: '', prefix: '' });
  const [localError, setLocalError] = useState<string | null>(null);
  // Client list may arrive after the dialog opens: then adopt the client's currency and retainer billing.
  useEffect(() => {
    if (project || !initialClient) return;
    setForm((f) => (f.client_id && f.client_id !== initialClient.id ? f : { ...f, client_id: initialClient.id, currency: initialClient.currency, billing_type: initialClient.retainer_minor ? 'retainer' : f.billing_type }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialClient?.id]);
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => (project ? api.patch(`/api/projects/${project.id}`, body) : api.post<{ id: number }>('/api/projects', body)),
    onSuccess: (res) => {
      invalidateAll(qc, 'projects', 'project', 'deliverables', 'clients', 'tasks');
      toast.success(project ? 'Project updated' : 'Project created');
      onSaved?.(project ? project.id : (res as { id: number }).id);
      onClose();
    },
  });
  const addBulk = () => {
    const n = Math.min(60, Math.max(0, Number(bulk.count) || 0));
    if (!n) return;
    const prefix = bulk.prefix.trim() || (form.type === 'thumbnail' ? 'Thumbnail' : form.type === 'long_form' ? 'Episode' : form.type === 'ad' ? 'Ad' : 'Short');
    const start = deliverables.length;
    setDeliverables([...deliverables, ...Array.from({ length: n }, (_, i) => ({ title: `${prefix} #${start + i + 1}`, deadline: form.deadline, platform: '', format: '' }))]);
    setBulk({ count: '', prefix: '' });
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setLocalError(null);
    const price = form.price.trim() ? toMinor(form.price, form.currency) : null;
    if (form.price.trim() && price === null) return setLocalError('Price must be a valid amount.');
    const { price: _p, ...rest } = form;
    const body: Record<string, unknown> = { ...rest, price_minor: price, reference_links: form.reference_links.filter((l) => l.url.trim()), asset_links: form.asset_links.filter((l) => l.url.trim()) };
    if (!project) body.deliverables = deliverables.filter((d) => d.title.trim()).map((d) => ({ title: d.title, deadline: d.deadline || null, platform: d.platform || null, format: d.format || null }));
    save.mutate(body);
  };
  const error = errOf(save.error);
  const f = (k: string) => error?.field(k);
  return (
    <form onSubmit={submit} className="flex flex-col gap-6">
      <Section title="Brief">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Client" required error={f('client_id')}>
            <ClientSelect
              required
              value={form.client_id}
              clients={clients.filter((c) => !c.archived_at || c.id === form.client_id)}
              onChange={(id, c) => setForm((x) => ({ ...x, client_id: id, currency: project ? x.currency : c?.currency ?? x.currency, billing_type: project ? x.billing_type : c?.retainer_minor ? 'retainer' : x.billing_type }))}
            />
          </Field>
          <TextField label="Project name" required value={form.name} onChange={(e) => set('name')(e.target.value)} error={f('name')} placeholder="e.g. November Shorts Pack" />
          <SelectField label="Type" value={form.type} onChange={(e) => set('type')(e.target.value)}>
            {PROJECT_TYPE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </SelectField>
          <Field label="Lead editor">
            <PeopleSelect value={form.editor_id} onChange={set('editor_id')} members={members} />
          </Field>
        </div>
        <TextareaField label="Description" rows={3} value={form.description} onChange={(e) => set('description')(e.target.value)} placeholder="Scope, style, hooks, music, captions…" />
      </Section>

      <Section title="Schedule & pricing">
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
          <TextField label="Start" type="date" value={form.start_date} onChange={(e) => set('start_date')(e.target.value)} error={f('start_date')} />
          <TextField label="Deadline" type="date" value={form.deadline} onChange={(e) => set('deadline')(e.target.value)} error={f('deadline')} />
          <SelectField label="Priority" value={form.priority} onChange={(e) => set('priority')(e.target.value as ProjectRow['priority'])}>
            {PRIORITY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </SelectField>
          <SelectField label="Status" value={form.status} onChange={(e) => set('status')(e.target.value)}>
            {PROJECT_STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </SelectField>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_1.2fr_1fr] gap-3">
          <SelectField label="Billing" value={form.billing_type} onChange={(e) => set('billing_type')(e.target.value)}>
            {BILLING_TYPE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </SelectField>
          <MoneyField label={form.billing_type === 'retainer' ? 'Allocated value' : form.billing_type === 'hourly' ? 'Hourly rate' : 'Agreed price'} optional currency={form.currency} value={form.price} onChange={set('price')} error={localError ?? f('price_minor')} />
          <Field label="Currency">
            <CurrencySelect value={form.currency} onChange={set('currency')} />
          </Field>
        </div>
      </Section>

      <Section title="Links">
        <Field label="References" hint="Style references, boards, example videos." group>
          <LinkListEditor value={form.reference_links} onChange={set('reference_links')} />
        </Field>
        <Field label="Assets" hint="Raw footage folders, brand kit, music." group>
          <LinkListEditor value={form.asset_links} onChange={set('asset_links')} />
        </Field>
        {(f('reference_links') || f('asset_links')) && <Notice tone="bad">{f('reference_links') ?? f('asset_links')}</Notice>}
        <Checkbox label="Show in the client portal" description="The client can see this project’s deliverables and review links." checked={form.portal_visible} onChange={set('portal_visible')} />
      </Section>

      {!project && (
        <Section title="Deliverables">
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Add numbered" className="w-28">
              <Input type="number" min={1} max={60} placeholder="12" value={bulk.count} onChange={(e) => setBulk({ ...bulk, count: e.target.value })} />
            </Field>
            <Field label="Named" className="flex-1 min-w-40">
              <Input placeholder="Short" value={bulk.prefix} onChange={(e) => setBulk({ ...bulk, prefix: e.target.value })} />
            </Field>
            <Button onClick={addBulk} icon={<Plus className="size-4" />}>
              Add
            </Button>
            <Button variant="ghost" onClick={() => setDeliverables([...deliverables, { title: '', deadline: form.deadline, platform: '', format: '' }])}>
              Add one
            </Button>
          </div>
          {deliverables.length > 0 && (
            <div className="flex flex-col gap-2 max-h-72 overflow-y-auto pr-1">
              {deliverables.map((d, i) => (
                <div key={i} className="grid grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)_auto] gap-2">
                  <Input aria-label="Deliverable title" value={d.title} onChange={(e) => setDeliverables(deliverables.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))} />
                  <Input aria-label="Deadline" type="date" value={d.deadline} onChange={(e) => setDeliverables(deliverables.map((x, j) => (j === i ? { ...x, deadline: e.target.value } : x)))} />
                  <Select aria-label="Platform" value={d.platform} onChange={(e) => setDeliverables(deliverables.map((x, j) => (j === i ? { ...x, platform: e.target.value } : x)))}>
                    <option value="">Platform…</option>
                    {PLATFORM_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </Select>
                  <IconButton label="Remove" onClick={() => setDeliverables(deliverables.filter((_, j) => j !== i))}>
                    <Trash2 className="size-4" />
                  </IconButton>
                </div>
              ))}
            </div>
          )}
        </Section>
      )}

      <FormError error={error} />
      <div className="flex justify-end gap-2 sticky bottom-0 -mx-5 -mb-4 px-5 py-3 bg-surface border-t border-line">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={save.isPending}>
          {project ? 'Save changes' : `Create project${deliverables.length ? ` + ${deliverables.length}` : ''}`}
        </Button>
      </div>
    </form>
  );
}

// ── Deliverable ──────────────────────────────────────────────────────────────

export function DeliverableFormDialog({ open, onClose, projectId, deliverable, onSaved }: { open: boolean; onClose: () => void; projectId?: number; deliverable?: DeliverableRow | null; onSaved?: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} variant="drawer" title={deliverable ? deliverable.title : 'New deliverable'} description={deliverable ? `${deliverable.client_name} · ${deliverable.project_name}` : undefined}>
      <DeliverableForm projectId={projectId ?? deliverable?.project_id} deliverable={deliverable} onClose={onClose} onSaved={onSaved} />
    </Dialog>
  );
}

function DeliverableForm({ projectId, deliverable, onClose, onSaved }: { projectId?: number; deliverable?: DeliverableRow | null; onClose: () => void; onSaved?: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: teamData } = useTeam();
  const { form, set } = useFormState({
    title: deliverable?.title ?? '',
    format: deliverable?.format ?? '',
    platform: deliverable?.platform ?? '',
    deadline: deliverable?.deadline ?? '',
    status: deliverable?.status ?? 'backlog',
    assignee_id: deliverable?.assignee_id ?? null,
    source_url: deliverable?.source_url ?? '',
    review_url: deliverable?.review_url ?? '',
    final_url: deliverable?.final_url ?? '',
    revision_count: deliverable?.revision_count ?? 0,
    estimated_hours: deliverable?.estimated_hours != null ? String(deliverable.estimated_hours) : '',
    notes: deliverable?.notes ?? '',
  });
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => (deliverable ? api.patch(`/api/deliverables/${deliverable.id}`, body) : api.post(`/api/projects/${projectId}/deliverables`, body)),
    onSuccess: () => {
      invalidateAll(qc, 'projects', 'deliverables', 'project', 'team', 'calendar');
      toast.success(deliverable ? 'Deliverable saved' : 'Deliverable added');
      onSaved?.();
      onClose();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const hours = form.estimated_hours.trim() ? Number(form.estimated_hours) : null;
    const body: Record<string, unknown> = { ...form, platform: form.platform || null, estimated_hours: hours !== null && Number.isFinite(hours) ? hours : null };
    if (!deliverable) delete body.revision_count;
    else if (form.revision_count === deliverable.revision_count) delete body.revision_count;
    if (deliverable && form.status === deliverable.status) delete body.status;
    save.mutate(body);
  };
  const error = errOf(save.error);
  const f = (k: string) => error?.field(k);
  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <TextField label="Title" required autoFocus value={form.title} onChange={(e) => set('title')(e.target.value)} error={f('title')} />
      <div className="grid grid-cols-2 gap-3">
        <SelectField label="Stage" value={form.status} onChange={(e) => set('status')(e.target.value)}>
          {STAGE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </SelectField>
        <TextField label="Deadline" type="date" value={form.deadline} onChange={(e) => set('deadline')(e.target.value)} error={f('deadline')} />
        <SelectField label="Platform" value={form.platform} onChange={(e) => set('platform')(e.target.value)}>
          <option value="">—</option>
          {PLATFORM_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </SelectField>
        <Field label="Format" htmlFor="deliverable-format">
          <Input id="deliverable-format" list="yfx-formats" value={form.format} onChange={(e) => set('format')(e.target.value)} placeholder="9:16 vertical · 1080×1920" />
          <datalist id="yfx-formats">
            {FORMAT_SUGGESTIONS.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </Field>
        <Field label="Assignee" hint={!form.assignee_id ? 'Defaults to the project’s lead editor.' : undefined}>
          <PeopleSelect value={form.assignee_id} onChange={set('assignee_id')} members={teamData?.members ?? []} placeholder="Project editor" />
        </Field>
        <TextField label="Estimated hours" type="number" min={0} step={0.5} value={form.estimated_hours} onChange={(e) => set('estimated_hours')(e.target.value)} />
      </div>
      <TextField label="Source footage link" placeholder="Drive / Dropbox / Frame.io" value={form.source_url} onChange={(e) => set('source_url')(e.target.value)} error={f('source_url')} />
      <TextField label="Review link" placeholder="Frame.io / Vimeo review link" value={form.review_url} onChange={(e) => set('review_url')(e.target.value)} error={f('review_url')} hint="Shown to the client in the portal once the video is in client review." />
      <TextField label="Final delivery link" value={form.final_url} onChange={(e) => set('final_url')(e.target.value)} error={f('final_url')} hint="Shown to the client as a download once approved." />
      {deliverable && (
        <TextField label="Revision rounds" type="number" min={0} max={999} value={form.revision_count} onChange={(e) => set('revision_count')(Math.max(0, Number(e.target.value) || 0))} hint="Counted automatically each time it moves into Revisions; adjust if needed." />
      )}
      <TextareaField label="Internal notes" rows={3} value={form.notes} onChange={(e) => set('notes')(e.target.value)} hint="Never shown to the client." />
      <FormError error={error} />
      <div className="flex justify-end gap-2 pt-1">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={save.isPending}>
          {deliverable ? 'Save' : 'Add deliverable'}
        </Button>
      </div>
    </form>
  );
}

// ── Task ─────────────────────────────────────────────────────────────────────

export type TaskRow = {
  id: number;
  title: string;
  description: string | null;
  client_id: number | null;
  client_name: string | null;
  project_id: number | null;
  project_name: string | null;
  lead_id: number | null;
  lead_name: string | null;
  priority: 'low' | 'medium' | 'high' | 'urgent';
  assignee_id: number | null;
  assignee_name: string | null;
  assignee_color: string | null;
  due_date: string | null;
  status: 'todo' | 'in_progress' | 'done' | 'cancelled';
  completed_at: string | null;
  recurrence_frequency: string | null;
  source: string;
  is_overdue: number;
  is_demo: number;
};

export function TaskFormDialog({ open, onClose, task, defaults }: { open: boolean; onClose: () => void; task?: TaskRow | null; defaults?: Partial<{ client_id: number; project_id: number; lead_id: number; due_date: string }> }) {
  return (
    <Dialog open={open} onClose={onClose} title={task ? 'Edit task' : 'New task'}>
      <TaskForm task={task} defaults={defaults} onClose={onClose} />
    </Dialog>
  );
}

function TaskForm({ task, defaults, onClose }: { task?: TaskRow | null; defaults?: Partial<{ client_id: number; project_id: number; lead_id: number; due_date: string }>; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const today = useToday();
  const { data: teamData } = useTeam();
  const { data: clientsData } = useClients();
  const { data: projectsData } = useProjects('?scope=active');
  const { form, set, setForm } = useFormState({
    title: task?.title ?? '',
    description: task?.description ?? '',
    due_date: task?.due_date ?? defaults?.due_date ?? today,
    priority: task?.priority ?? 'medium',
    status: task?.status ?? 'todo',
    assignee_id: task?.assignee_id ?? null,
    client_id: task?.client_id ?? defaults?.client_id ?? null,
    project_id: task?.project_id ?? defaults?.project_id ?? null,
    lead_id: task?.lead_id ?? defaults?.lead_id ?? null,
  });
  const projects = (projectsData?.projects ?? []).filter((p) => !form.client_id || p.client_id === form.client_id);
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => (task ? api.patch(`/api/tasks/${task.id}`, body) : api.post('/api/tasks', body)),
    onSuccess: () => {
      invalidateAll(qc, 'tasks', 'team', 'calendar', 'project');
      toast.success(task ? 'Task saved' : 'Task added');
      onClose();
    },
  });
  const error = errOf(save.error);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate(form);
      }}
      className="flex flex-col gap-4"
    >
      <TextField label="Task" required autoFocus value={form.title} onChange={(e) => set('title')(e.target.value)} error={error?.field('title')} placeholder="e.g. Send weekly update to Atlas" />
      <TextareaField label="Details" optional rows={2} value={form.description} onChange={(e) => set('description')(e.target.value)} />
      <div className="grid grid-cols-2 gap-3">
        <TextField label="Due" type="date" value={form.due_date ?? ''} onChange={(e) => set('due_date')(e.target.value)} />
        <SelectField label="Priority" value={form.priority} onChange={(e) => set('priority')(e.target.value as TaskRow['priority'])}>
          {PRIORITY_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </SelectField>
        <Field label="Assignee">
          <PeopleSelect value={form.assignee_id} onChange={set('assignee_id')} members={teamData?.members ?? []} />
        </Field>
        {task && (
          <SelectField label="Status" value={form.status} onChange={(e) => set('status')(e.target.value as TaskRow['status'])}>
            {TASK_STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </SelectField>
        )}
        <Field label="Client" optional>
          <ClientSelect value={form.client_id} clients={clientsData?.clients ?? []} placeholder="None" onChange={(id) => setForm((f) => ({ ...f, client_id: id, project_id: null }))} />
        </Field>
        <Field label="Project" optional>
          <Select value={form.project_id ?? ''} onChange={(e) => set('project_id')(e.target.value ? Number(e.target.value) : null)}>
            <option value="">None</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <FormError error={error} />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={save.isPending}>
          {task ? 'Save' : 'Add task'}
        </Button>
      </div>
    </form>
  );
}

// ── Lead ─────────────────────────────────────────────────────────────────────

export type LeadRow = {
  id: number;
  name: string;
  company: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  social_url: string | null;
  source: string;
  deal_type: 'retainer' | 'one_time';
  estimated_value_minor: number | null;
  currency: string;
  stage: (typeof LEAD_STAGE_OPTIONS)[number]['value'];
  stage_changed_at: string;
  last_contact_at: string | null;
  next_follow_up: string | null;
  notes: string | null;
  outcome_reason: string | null;
  closed_at: string | null;
  client_id: number | null;
  tags: string[];
  is_demo: number;
  created_at: string;
  follow_up_overdue?: number;
  follow_up_today?: number;
  touchpoints?: number;
};

type Duplicate = { type: 'lead' | 'client'; id: number; name: string; company: string | null; state: string; matched_on: string[] };

export function DuplicateWarning({ duplicates }: { duplicates: Duplicate[] }) {
  if (!duplicates.length) return null;
  return (
    <Notice tone="warn">
      <div className="font-medium text-warn mb-1">Possible duplicate{duplicates.length > 1 ? 's' : ''}</div>
      <ul className="flex flex-col gap-0.5">
        {duplicates.slice(0, 5).map((d) => (
          <li key={`${d.type}-${d.id}`}>
            <a className="text-ink hover:underline" href={d.type === 'client' ? `/clients/${d.id}` : `/pipeline?lead=${d.id}`} target="_blank" rel="noreferrer">
              {d.company ? `${d.company} — ${d.name}` : d.name}
            </a>{' '}
            <span className="text-ink-3">
              · {d.state} · same {d.matched_on.join(', ')}
            </span>
          </li>
        ))}
      </ul>
    </Notice>
  );
}

export function LeadFormDialog({ open, onClose, lead, onSaved }: { open: boolean; onClose: () => void; lead?: LeadRow | null; onSaved?: (id: number) => void }) {
  return (
    <Dialog open={open} onClose={onClose} title={lead ? `Edit ${lead.company || lead.name}` : 'New lead'} description={lead ? undefined : 'Only add prospects you have actually found or talked to.'} size="lg">
      <LeadForm lead={lead} onClose={onClose} onSaved={onSaved} />
    </Dialog>
  );
}

function LeadForm({ lead, onClose, onSaved }: { lead?: LeadRow | null; onClose: () => void; onSaved?: (id: number) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const base = useBaseCurrency();
  const { form, set } = useFormState({
    name: lead?.name ?? '',
    company: lead?.company ?? '',
    email: lead?.email ?? '',
    phone: lead?.phone ?? '',
    website: lead?.website ?? '',
    social_url: lead?.social_url ?? '',
    source: lead?.source ?? 'cold_email',
    deal_type: lead?.deal_type ?? 'retainer',
    value: lead?.estimated_value_minor != null ? fromMinor(lead.estimated_value_minor, lead.currency) : '',
    currency: lead?.currency ?? (base === 'INR' ? 'USD' : base),
    stage: lead?.stage ?? 'lead',
    last_contact_at: lead?.last_contact_at ?? '',
    next_follow_up: lead?.next_follow_up ?? '',
    notes: lead?.notes ?? '',
    outcome_reason: lead?.outcome_reason ?? '',
    tags: lead?.tags ?? [],
  });
  const [localError, setLocalError] = useState<string | null>(null);
  const [forceDuplicates, setForceDuplicates] = useState(false);
  const probe = useDebounced(JSON.stringify({ name: form.name, company: form.company, email: form.email, website: form.website, phone: form.phone, social_url: form.social_url }), 450);
  const { data: dupData } = useQuery({
    queryKey: ['lead-dupes', probe, lead?.id],
    queryFn: () => api.post<{ duplicates: Duplicate[] }>('/api/leads/check-duplicates', { ...JSON.parse(probe), exclude_id: lead?.id }),
    enabled: (form.email + form.website + form.company + form.name).trim().length > 2,
  });
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => (lead ? api.patch(`/api/leads/${lead.id}`, body) : api.post<{ id: number }>('/api/leads', body)),
    onSuccess: (res) => {
      invalidateAll(qc, 'leads', 'lead');
      toast.success(lead ? 'Lead saved' : 'Lead added');
      onSaved?.(lead ? lead.id : (res as { id: number }).id);
      onClose();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setLocalError(null);
    const value = form.value.trim() ? toMinor(form.value, form.currency) : null;
    if (form.value.trim() && value === null) return setLocalError('Enter a valid amount.');
    const { value: _v, ...rest } = form;
    save.mutate({ ...rest, estimated_value_minor: value, ...(lead ? {} : { force: forceDuplicates }) });
  };
  const error = errOf(save.error);
  const conflictDupes = (error?.status === 409 ? (error.details?.duplicates as Duplicate[] | undefined) : undefined) ?? [];
  const dupes = conflictDupes.length ? conflictDupes : dupData?.duplicates ?? [];
  const f = (k: string) => error?.field(k);
  return (
    <form onSubmit={submit} className="flex flex-col gap-5">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <TextField label="Name" required autoFocus value={form.name} onChange={(e) => set('name')(e.target.value)} error={f('name')} />
        <TextField label="Company / channel" value={form.company} onChange={(e) => set('company')(e.target.value)} />
        <TextField label="Email" type="email" value={form.email} onChange={(e) => set('email')(e.target.value)} error={f('email')} />
        <TextField label="Phone" value={form.phone} onChange={(e) => set('phone')(e.target.value)} />
        <TextField label="Website" placeholder="example.com" value={form.website} onChange={(e) => set('website')(e.target.value)} error={f('website')} />
        <TextField label="Social profile" placeholder="https://youtube.com/@channel" value={form.social_url} onChange={(e) => set('social_url')(e.target.value)} />
      </div>
      <DuplicateWarning duplicates={dupes} />
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <SelectField label="Source" value={form.source} onChange={(e) => set('source')(e.target.value)}>
          {LEAD_SOURCE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </SelectField>
        <SelectField label="Stage" value={form.stage} onChange={(e) => set('stage')(e.target.value as LeadRow['stage'])}>
          {LEAD_STAGE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </SelectField>
        <SelectField label="Deal type" value={form.deal_type} onChange={(e) => set('deal_type')(e.target.value as LeadRow['deal_type'])}>
          {DEAL_TYPE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </SelectField>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-[1.4fr_1fr_1fr_1fr] gap-3">
        <MoneyField label={form.deal_type === 'retainer' ? 'Estimated value / month' : 'Estimated value'} optional currency={form.currency} value={form.value} onChange={set('value')} error={localError ?? f('estimated_value_minor')} />
        <Field label="Currency">
          <CurrencySelect value={form.currency} onChange={set('currency')} />
        </Field>
        <TextField label="Last contact" type="date" value={form.last_contact_at} onChange={(e) => set('last_contact_at')(e.target.value)} />
        <TextField label="Next follow-up" type="date" value={form.next_follow_up} onChange={(e) => set('next_follow_up')(e.target.value)} />
      </div>
      {(form.stage === 'won' || form.stage === 'lost') && <TextField label={form.stage === 'won' ? 'Why we won' : 'Why we lost'} value={form.outcome_reason} onChange={(e) => set('outcome_reason')(e.target.value)} placeholder={form.stage === 'won' ? 'e.g. Fast turnaround, strong samples' : 'e.g. Budget, timing, went in-house'} />}
      <TextareaField label="Notes" rows={3} value={form.notes} onChange={(e) => set('notes')(e.target.value)} />
      <Field label="Tags">
        <TagInput value={form.tags} onChange={set('tags')} />
      </Field>
      {conflictDupes.length > 0 && !lead && <Checkbox label="This is a different prospect — create it anyway" checked={forceDuplicates} onChange={setForceDuplicates} />}
      <FormError error={error} />
      <div className="flex justify-end gap-2 sticky bottom-0 -mx-5 -mb-4 px-5 py-3 bg-surface border-t border-line">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={save.isPending}>
          {lead ? 'Save' : 'Add lead'}
        </Button>
      </div>
    </form>
  );
}

// ── Expense ──────────────────────────────────────────────────────────────────

export type ExpenseRow = {
  id: number;
  date: string;
  category: string;
  amount_minor: number;
  currency: string;
  description: string;
  vendor: string | null;
  client_id: number | null;
  client_name: string | null;
  project_id: number | null;
  project_name: string | null;
  team_member_id: number | null;
  member_name: string | null;
  receipt_url: string | null;
  notes: string | null;
  is_demo: number;
};

export function ExpenseFormDialog({ open, onClose, expense, copyFrom }: { open: boolean; onClose: () => void; expense?: ExpenseRow | null; copyFrom?: ExpenseRow | null }) {
  return (
    <Dialog open={open} onClose={onClose} title={expense ? 'Edit expense' : 'Record an expense'}>
      <ExpenseForm expense={expense} copyFrom={copyFrom} onClose={onClose} />
    </Dialog>
  );
}

function ExpenseForm({ expense, copyFrom, onClose }: { expense?: ExpenseRow | null; copyFrom?: ExpenseRow | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const today = useToday();
  const base = useBaseCurrency();
  const { data: clientsData } = useClients();
  const { data: teamData } = useTeam();
  const src = expense ?? copyFrom;
  const { form, set } = useFormState({
    date: expense?.date ?? today,
    category: src?.category ?? 'software',
    amount: src ? fromMinor(src.amount_minor, src.currency) : '',
    currency: src?.currency ?? base,
    description: src?.description ?? '',
    vendor: src?.vendor ?? '',
    client_id: src?.client_id ?? null,
    team_member_id: src?.team_member_id ?? null,
    receipt_url: expense?.receipt_url ?? '',
    notes: expense?.notes ?? '',
  });
  const [localError, setLocalError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => (expense ? api.patch(`/api/expenses/${expense.id}`, body) : api.post('/api/expenses', body)),
    onSuccess: () => {
      invalidateAll(qc, 'expenses', 'finance');
      toast.success(expense ? 'Expense saved' : 'Expense recorded');
      onClose();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setLocalError(null);
    const amount = toMinor(form.amount, form.currency);
    if (!amount) return setLocalError('Enter the amount paid.');
    const { amount: _a, ...rest } = form;
    save.mutate({ ...rest, amount_minor: amount });
  };
  const error = errOf(save.error);
  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <TextField label="What was it for?" required autoFocus value={form.description} onChange={(e) => set('description')(e.target.value)} error={error?.field('description')} placeholder="e.g. Adobe Creative Cloud — November" />
      <div className="grid grid-cols-[1.4fr_1fr] gap-3">
        <MoneyField label="Amount" required currency={form.currency} value={form.amount} onChange={set('amount')} error={localError ?? error?.field('amount_minor')} />
        <Field label="Currency">
          <CurrencySelect value={form.currency} onChange={set('currency')} />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <TextField label="Date paid" type="date" required value={form.date} onChange={(e) => set('date')(e.target.value)} error={error?.field('date')} />
        <SelectField label="Category" value={form.category} onChange={(e) => set('category')(e.target.value)}>
          {EXPENSE_CATEGORY_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </SelectField>
        <TextField label="Vendor" optional value={form.vendor} onChange={(e) => set('vendor')(e.target.value)} />
        <Field label="Paid to team member" optional>
          <PeopleSelect value={form.team_member_id} onChange={set('team_member_id')} members={teamData?.members ?? []} placeholder="None" />
        </Field>
        <Field label="For client" optional className="col-span-2">
          <ClientSelect value={form.client_id} clients={clientsData?.clients ?? []} placeholder="Not client-specific" onChange={(id) => set('client_id')(id)} />
        </Field>
      </div>
      <TextField label="Receipt link" optional value={form.receipt_url} onChange={(e) => set('receipt_url')(e.target.value)} error={error?.field('receipt_url')} />
      <TextareaField label="Notes" optional rows={2} value={form.notes} onChange={(e) => set('notes')(e.target.value)} />
      <FormError error={error} />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={save.isPending}>
          {expense ? 'Save' : 'Record expense'}
        </Button>
      </div>
    </form>
  );
}

// ── Payment ──────────────────────────────────────────────────────────────────

export function PaymentDialog({ open, onClose, invoice }: { open: boolean; onClose: () => void; invoice: { id: number; number: string; currency: string; balance_minor: number; total_minor: number; state: string } }) {
  return (
    <Dialog open={open} onClose={onClose} title={`Record payment · ${invoice.number}`} description={`Outstanding: ${formatMoney(invoice.balance_minor, invoice.currency, { decimals: 'always' })} of ${formatMoney(invoice.total_minor, invoice.currency, { decimals: 'always' })}`} size="sm">
      <PaymentForm invoice={invoice} onClose={onClose} />
    </Dialog>
  );
}

function PaymentForm({ invoice, onClose }: { invoice: { id: number; number: string; currency: string; balance_minor: number; state: string }; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const today = useToday();
  const { form, set } = useFormState({ amount: fromMinor(invoice.balance_minor, invoice.currency), paid_at: today, method: 'bank_transfer', reference: '', notes: '' });
  const [localError, setLocalError] = useState<string | null>(null);
  const amountMinor = toMinor(form.amount, invoice.currency);
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post<{ status: string; balance_minor: number }>(`/api/invoices/${invoice.id}/payments`, body),
    onSuccess: (res) => {
      invalidateAll(qc, 'invoices', 'invoice', 'payments', 'finance', 'clients', 'client');
      toast.success(res.status === 'paid' ? `Invoice ${invoice.number} is now fully paid` : `Payment recorded · ${formatMoney(res.balance_minor, invoice.currency, { decimals: 'always' })} still outstanding`);
      onClose();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setLocalError(null);
    if (!amountMinor) return setLocalError('Enter the amount received.');
    if (amountMinor > invoice.balance_minor) return setLocalError(`That is more than the outstanding ${formatMoney(invoice.balance_minor, invoice.currency, { decimals: 'always' })}.`);
    save.mutate({ amount_minor: amountMinor, paid_at: form.paid_at, method: form.method, reference: form.reference, notes: form.notes });
  };
  const error = errOf(save.error);
  const partial = amountMinor !== null && amountMinor > 0 && amountMinor < invoice.balance_minor;
  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <MoneyField label="Amount received" required currency={invoice.currency} value={form.amount} onChange={set('amount')} error={localError ?? error?.field('amount_minor')} hint={partial ? `Partial payment — ${formatMoney(invoice.balance_minor - amountMinor!, invoice.currency, { decimals: 'always' })} will remain outstanding.` : 'Record exactly what arrived in your account.'} />
      <div className="grid grid-cols-2 gap-3">
        <TextField label="Date received" type="date" required max={today} value={form.paid_at} onChange={(e) => set('paid_at')(e.target.value)} error={error?.field('paid_at')} />
        <SelectField label="Method" value={form.method} onChange={(e) => set('method')(e.target.value)}>
          {PAYMENT_METHOD_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </SelectField>
      </div>
      <TextField label="Reference" optional placeholder="Transaction ID, UTR, PayPal ID…" value={form.reference} onChange={(e) => set('reference')(e.target.value)} />
      <TextareaField label="Notes" optional rows={2} value={form.notes} onChange={(e) => set('notes')(e.target.value)} />
      {invoice.state === 'draft' && <Notice tone="info">This invoice is still a draft. Recording a payment will mark it as sent.</Notice>}
      <FormError error={error} />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={save.isPending}>
          Record payment
        </Button>
      </div>
    </form>
  );
}

// ── Team member ──────────────────────────────────────────────────────────────

const SWATCHES = ['#9085e9', '#199e70', '#d95926', '#3987e5', '#c98500', '#d55181', '#e66767', '#7469b8'];

export function TeamMemberDialog({ open, onClose, member }: { open: boolean; onClose: () => void; member?: TeamMember | null }) {
  return (
    <Dialog open={open} onClose={onClose} title={member ? `Edit ${member.name}` : 'Add team member'}>
      <TeamMemberForm member={member} onClose={onClose} />
    </Dialog>
  );
}

function TeamMemberForm({ member, onClose }: { member?: TeamMember | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const base = useBaseCurrency();
  const { form, set } = useFormState({
    name: member?.name ?? '',
    email: member?.email ?? '',
    title: member?.title ?? 'Editor',
    skills: member?.skills ?? [],
    capacity_hours: member?.capacity_hours ?? 40,
    cost: member?.cost_rate_minor != null && member.cost_currency ? fromMinor(member.cost_rate_minor, member.cost_currency) : '',
    cost_currency: member?.cost_currency ?? base,
    cost_unit: member?.cost_unit ?? 'hour',
    status: member?.status ?? 'active',
    color: member?.color ?? SWATCHES[0],
    notes: member?.notes ?? '',
  });
  const [localError, setLocalError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => (member ? api.patch(`/api/team/${member.id}`, body) : api.post('/api/team', body)),
    onSuccess: () => {
      invalidateAll(qc, 'team');
      toast.success(member ? 'Team member saved' : 'Team member added');
      onClose();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setLocalError(null);
    const cost = form.cost.trim() ? toMinor(form.cost, form.cost_currency) : null;
    if (form.cost.trim() && cost === null) return setLocalError('Enter a valid amount.');
    const { cost: _c, ...rest } = form;
    save.mutate({ ...rest, cost_rate_minor: cost, cost_currency: cost !== null ? form.cost_currency : null, cost_unit: cost !== null ? form.cost_unit : null });
  };
  const error = errOf(save.error);
  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3">
        <TextField label="Name" required autoFocus value={form.name} onChange={(e) => set('name')(e.target.value)} error={error?.field('name')} />
        <TextField label="Role" value={form.title} onChange={(e) => set('title')(e.target.value)} placeholder="Editor, Motion designer…" />
        <TextField label="Email" optional type="email" value={form.email} onChange={(e) => set('email')(e.target.value)} error={error?.field('email')} />
        <TextField label="Weekly capacity (hours)" type="number" min={0} max={168} value={form.capacity_hours} onChange={(e) => set('capacity_hours')(Number(e.target.value) || 0)} />
      </div>
      <Field label="Skills">
        <TagInput value={form.skills} onChange={set('skills')} placeholder="shorts, color, after effects…" />
      </Field>
      <div className="grid grid-cols-[1.3fr_1fr_1fr] gap-3">
        <Field label="Cost rate" optional error={localError ?? undefined}>
          <MoneyInput currency={form.cost_currency} value={form.cost} onChange={set('cost')} invalid={!!localError} />
        </Field>
        <Field label="Currency">
          <CurrencySelect value={form.cost_currency} onChange={set('cost_currency')} />
        </Field>
        <SelectField label="Per" value={form.cost_unit} onChange={(e) => set('cost_unit')(e.target.value)}>
          {COST_UNIT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </SelectField>
      </div>
      <div className="grid grid-cols-2 gap-3 items-end">
        <SelectField label="Status" value={form.status} onChange={(e) => set('status')(e.target.value as 'active' | 'inactive')}>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
        </SelectField>
        <Field label="Colour">
          <div className="flex gap-1.5 h-9 items-center" role="radiogroup" aria-label="Colour">
            {SWATCHES.map((c) => (
              <button key={c} type="button" role="radio" aria-checked={form.color === c} aria-label={c} onClick={() => set('color')(c)} className={cx('size-6 rounded-full cursor-pointer ring-offset-2 ring-offset-surface', form.color === c && 'ring-2 ring-white/80')} style={{ background: c }} />
            ))}
          </div>
        </Field>
      </div>
      <TextareaField label="Notes" optional rows={2} value={form.notes} onChange={(e) => set('notes')(e.target.value)} />
      <FormError error={error} />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={save.isPending}>
          {member ? 'Save' : 'Add member'}
        </Button>
      </div>
    </form>
  );
}

// ── Communication log ────────────────────────────────────────────────────────

export function CommunicationForm({ endpoint, onDone, showFollowUp }: { endpoint: string; onDone?: () => void; showFollowUp?: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const today = useToday();
  const { form, set, setForm } = useFormState({ channel: 'email', direction: 'outbound', subject: '', body: '', occurred_at: today, next_follow_up: '' });
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post(endpoint, body),
    onSuccess: () => {
      invalidateAll(qc, 'client', 'lead', 'leads', 'timeline');
      toast.success('Logged');
      setForm({ channel: form.channel, direction: form.direction, subject: '', body: '', occurred_at: today, next_follow_up: '' });
      onDone?.();
    },
  });
  const error = errOf(save.error);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate({ ...form, next_follow_up: showFollowUp ? form.next_follow_up || null : undefined });
      }}
      className="flex flex-col gap-3"
    >
      <div className="grid grid-cols-3 gap-2">
        <Select aria-label="Channel" value={form.channel} onChange={(e) => set('channel')(e.target.value)}>
          {COMM_CHANNEL_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
        <Select aria-label="Direction" value={form.direction} onChange={(e) => set('direction')(e.target.value)}>
          {COMM_DIRECTION_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
        <Input aria-label="Date" type="date" max={today} value={form.occurred_at} onChange={(e) => set('occurred_at')(e.target.value)} />
      </div>
      <Input aria-label="Subject" placeholder="Subject (optional)" value={form.subject} onChange={(e) => set('subject')(e.target.value)} />
      <textarea className="field-input" rows={3} aria-label="What happened" placeholder="What was discussed, agreed or asked…" value={form.body} onChange={(e) => set('body')(e.target.value)} />
      {showFollowUp && (
        <Field label="Next follow-up" optional>
          <Input type="date" value={form.next_follow_up} onChange={(e) => set('next_follow_up')(e.target.value)} />
        </Field>
      )}
      <FormError error={error} />
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11.5px] text-ink-3 flex items-center gap-1">
          <AlertTriangle className="size-3" aria-hidden /> This only logs what happened. Nothing is sent.
        </p>
        <Button type="submit" size="sm" variant="primary" loading={save.isPending}>
          Log it
        </Button>
      </div>
    </form>
  );
}

export function useClientOptions() {
  const { data } = useClients();
  return useMemo(() => data?.clients ?? [], [data]);
}
