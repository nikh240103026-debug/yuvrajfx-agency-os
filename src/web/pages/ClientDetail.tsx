import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, ArrowLeft, Copy, FileText, FolderKanban, Globe, KeyRound, Mail, MessageCircle, MoreHorizontal, Pencil, Phone, Plus, RotateCcw, ShieldCheck, Trash2, UserPlus } from 'lucide-react';
import { api, errorMessage } from '../lib/api.ts';
import { invalidateAll, useIsAdmin, useToday, type ClientRow } from '../lib/queries.ts';
import { Badge, Button, Card, CardHeader, DemoBadge, EmptyState, ErrorState, IconButton, Notice, PageSkeleton, Tabs, TextField } from '../components/ui.tsx';
import { Dialog, Menu, useConfirm, useToast } from '../components/overlay.tsx';
import { MoneyStack } from '../components/money.tsx';
import { ClientFormDialog, CommunicationForm, ProjectFormDialog } from '../components/forms.tsx';
import { ExtLink } from '../components/inputs.tsx';
import { ClientStatusBadge, CYCLE_SHORT, DueChip, InvoiceStatusBadge, StageBadge } from '../lib/status.tsx';
import { BILLING_CYCLE_LABELS, COMM_CHANNEL_LABELS, PROJECT_TYPE_LABELS, SOCIAL_KEYS, SOCIAL_LABELS, type InvoiceStatus } from '../../shared/constants.ts';
import { formatMoney, type MoneyGroup } from '../../shared/money.ts';
import { formatDate, formatDateLong } from '../../shared/dates.ts';
import { copyText, cx, safeHref, socialHref, timeAgo } from '../lib/util.ts';

type Detail = {
  client: ClientRow;
  projects: { id: number; name: string; type: string; status: string; priority: string; deadline: string | null; billing_type: string; price_minor?: number | null; currency: string; editor_name: string | null; deliverable_count: number; delivered_count: number; is_demo: number; archived_at: string | null }[];
  deliverables: { id: number; title: string; status: string; deadline: string | null; project_id: number; project_name: string; revision_count: number }[];
  portal_users: { id: number; email: string; name: string; disabled: number; last_login_at: string | null; must_change_password: number }[];
  lead: { id: number; name: string; source: string; closed_at: string | null } | null;
  finance: null | {
    invoices: { id: number; number: string; issue_date: string; due_date: string; status: InvoiceStatus; total_minor: number; balance_minor: number; currency: string; days_overdue: number; is_demo: number }[];
    collected_lifetime: MoneyGroup[];
    outstanding: MoneyGroup[];
    overdue: MoneyGroup[];
    invoiced_lifetime: MoneyGroup[];
  };
};

type TimelineItem = { id: number; kind: 'activity' | 'communication'; summary?: string; action?: string; actor_name: string | null; at: string; channel?: string; direction?: string; subject?: string | null; body?: string | null; occurred_at?: string };

function InfoRow({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3 py-2">
      <span className="mt-0.5 text-ink-3 [&_svg]:size-4" aria-hidden>
        {icon}
      </span>
      <div className="min-w-0">
        <div className="text-[11.5px] text-ink-3">{label}</div>
        <div className="text-[13px] text-ink break-words">{children}</div>
      </div>
    </div>
  );
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="text-[12px] text-ink-3 mb-1">{label}</div>
      {children}
    </div>
  );
}

function PortalAccess({ client, users }: { client: ClientRow; users: Detail['portal_users'] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { confirm } = useConfirm();
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: client.name, email: client.email ?? '' });
  const [secret, setSecret] = useState<{ email: string; password: string } | null>(null);
  const refresh = () => invalidateAll(qc, 'client', 'clients');
  const create = useMutation({
    mutationFn: () => api.post<{ temporary_password: string }>('/api/settings/users', { ...form, role: 'client', client_id: client.id }),
    onSuccess: (r) => {
      setSecret({ email: form.email, password: r.temporary_password });
      setCreating(false);
      refresh();
    },
  });
  const reset = useMutation({
    mutationFn: (u: { id: number; email: string }) => api.post<{ temporary_password: string }>(`/api/settings/users/${u.id}/reset-password`).then((r) => ({ ...r, email: u.email })),
    onSuccess: (r) => {
      setSecret({ email: r.email, password: r.temporary_password });
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const toggle = useMutation({
    mutationFn: (u: { id: number; disabled: boolean }) => api.patch(`/api/settings/users/${u.id}`, { disabled: u.disabled }),
    onSuccess: refresh,
    onError: (e) => toast.error(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: (id: number) => api.del(`/api/settings/users/${id}`),
    onSuccess: refresh,
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1.4fr_1fr] gap-4">
      <Card>
        <CardHeader title="Portal logins" description="People at this client who can sign in to see their projects, review videos and view invoices." action={<Button size="sm" variant="primary" icon={<UserPlus className="size-3.5" />} onClick={() => setCreating(true)}>Create login</Button>} />
        {users.length === 0 ? (
          <EmptyState compact icon={<ShieldCheck className="size-5" />} title="No portal access yet" body="Create a login and share the one-time password with your client yourself. Nothing is emailed automatically." />
        ) : (
          <ul className="px-5 pb-4 divide-y divide-line">
            {users.map((u) => (
              <li key={u.id} className="flex items-center gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] text-ink">
                    {u.name} {u.disabled ? <Badge tone="bad">Disabled</Badge> : u.must_change_password ? <Badge tone="warn">Not signed in yet</Badge> : <Badge tone="good">Active</Badge>}
                  </div>
                  <div className="text-[12px] text-ink-3">
                    {u.email} · {u.last_login_at ? `last sign-in ${timeAgo(u.last_login_at)}` : 'never signed in'}
                  </div>
                </div>
                <Menu
                  label="Login actions"
                  button={(p) => (
                    <IconButton label="Login actions" {...p}>
                      <MoreHorizontal className="size-4" />
                    </IconButton>
                  )}
                  items={[
                    { label: 'Reset password', icon: <KeyRound />, onSelect: () => reset.mutate({ id: u.id, email: u.email }) },
                    { label: u.disabled ? 'Enable login' : 'Disable login', icon: <ShieldCheck />, onSelect: () => toggle.mutate({ id: u.id, disabled: !u.disabled }) },
                    { divider: true },
                    {
                      label: 'Delete login',
                      icon: <Trash2 />,
                      danger: true,
                      onSelect: async () => {
                        if (await confirm({ title: 'Delete this portal login?', body: `${u.email} will no longer be able to sign in. Their past feedback stays on the projects.`, confirmLabel: 'Delete login', danger: true })) remove.mutate(u.id);
                      },
                    },
                  ]}
                />
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card className="p-5">
        <h3 className="text-[13.5px] font-semibold mb-2">What the client sees</h3>
        <ul className="text-[12.5px] text-ink-2 flex flex-col gap-1.5 list-disc pl-4">
          <li>Only their own projects marked “show in portal”.</li>
          <li>Deliverable status in client-friendly words; review links once a video is in client review; download links once approved.</li>
          <li>Approve / request changes / comment on videos waiting for review.</li>
          <li>Their sent invoices and payment status (never drafts).</li>
          <li>Never: prices of your projects, internal notes, team costs or other clients.</li>
        </ul>
        <Notice tone="warn" className="mt-4">
          The portal runs wherever this app runs. Clients can only reach it once you host the app online behind HTTPS (see README → Client portal).
        </Notice>
      </Card>

      <Dialog
        open={creating}
        onClose={() => setCreating(false)}
        title="Create portal login"
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button variant="primary" loading={create.isPending} onClick={() => create.mutate()}>
              Create login
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <TextField label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <TextField label="Email (their sign-in)" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          {create.error && <Notice tone="bad">{errorMessage(create.error)}</Notice>}
          <p className="text-[12px] text-ink-3">A one-time password is generated. They must choose their own password at first sign-in.</p>
        </div>
      </Dialog>
      <Dialog open={!!secret} onClose={() => setSecret(null)} title="One-time password" size="sm" footer={<Button variant="primary" onClick={() => setSecret(null)}>Done</Button>}>
        {secret && (
          <div className="flex flex-col gap-3">
            <p className="text-[13px] text-ink-2">Share these sign-in details with your client yourself (for example over WhatsApp). This password is shown only once.</p>
            <div className="rounded-xl bg-bg-subtle ring-1 ring-inset ring-white/[0.08] p-3 font-mono text-[13px]">
              <div className="text-ink-3 text-[11px] font-sans">Email</div>
              <div className="text-ink">{secret.email}</div>
              <div className="text-ink-3 text-[11px] font-sans mt-2">Temporary password</div>
              <div className="text-ink select-all">{secret.password}</div>
            </div>
            <Button
              icon={<Copy className="size-4" />}
              onClick={async () => {
                const ok = await copyText(`Sign in at ${window.location.origin}/login\nEmail: ${secret.email}\nTemporary password: ${secret.password}`);
                toast[ok ? 'success' : 'error'](ok ? 'Copied' : 'Copy failed — select the text instead');
              }}
            >
              Copy sign-in details
            </Button>
          </div>
        )}
      </Dialog>
    </div>
  );
}

export default function ClientDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const admin = useIsAdmin();
  const today = useToday();
  const qc = useQueryClient();
  const toast = useToast();
  const { confirm } = useConfirm();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'overview';
  const [editing, setEditing] = useState(false);
  const [newProject, setNewProject] = useState(false);
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['client', id], queryFn: () => api.get<Detail>(`/api/clients/${id}`) });
  const timeline = useQuery({ queryKey: ['timeline', id], queryFn: () => api.get<{ items: TimelineItem[] }>(`/api/clients/${id}/timeline`), enabled: tab === 'activity' || tab === 'communication' });
  const act = useMutation({
    mutationFn: (path: string) => (path === 'delete' ? api.del(`/api/clients/${id}`) : api.post(`/api/clients/${id}/${path}`)),
    onSuccess: (_r, path) => {
      invalidateAll(qc, 'clients', 'client');
      toast.success(path === 'archive' ? 'Client archived' : path === 'restore' ? 'Client restored' : 'Client deleted');
      if (path === 'delete') navigate('/clients');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  if (isLoading) return <PageSkeleton />;
  if (error || !data) return <ErrorState error={error} onRetry={() => refetch()} />;
  const c = data.client;
  const f = data.finance;
  const setTab = (t: string) => {
    const next = new URLSearchParams(params);
    next.set('tab', t);
    setParams(next, { replace: true });
  };
  const socials = SOCIAL_KEYS.filter((k) => c.socials?.[k]);
  const comms = (timeline.data?.items ?? []).filter((i) => i.kind === 'communication');

  return (
    <div>
      <Link to="/clients" className="inline-flex items-center gap-1 text-[12.5px] text-ink-3 hover:text-ink mb-3">
        <ArrowLeft className="size-3.5" /> Clients
      </Link>
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between mb-6 animate-enter">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-[24px] font-semibold tracking-tight">{c.company || c.name}</h1>
            <ClientStatusBadge status={c.status} />
            {c.is_demo ? <DemoBadge /> : null}
            {c.archived_at && <Badge tone="warn">Archived</Badge>}
          </div>
          <p className="mt-1 text-[13.5px] text-ink-3">
            {c.company ? `${c.name} · ` : ''}
            {c.service_package ?? 'No package set'}
            {data.lead ? (
              <>
                {' · '}
                <Link className="hover:text-ink underline-offset-2 hover:underline" to={`/pipeline?lead=${data.lead.id}`}>
                  won from pipeline
                </Link>
              </>
            ) : null}
          </p>
          {c.tags.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {c.tags.map((t) => (
                <Link key={t} to={`/clients?tag=${encodeURIComponent(t)}`} className="text-[12px] text-ink-3 hover:text-accent-ink">
                  #{t}
                </Link>
              ))}
            </div>
          )}
        </div>
        {admin && (
          <div className="flex flex-wrap gap-2">
            <Button icon={<Pencil className="size-4" />} onClick={() => setEditing(true)}>
              Edit
            </Button>
            <Button icon={<FolderKanban className="size-4" />} onClick={() => setNewProject(true)}>
              New project
            </Button>
            <Button variant="primary" icon={<FileText className="size-4" />} to={`/invoices/new?client=${c.id}`}>
              New invoice
            </Button>
            <Menu
              label="More"
              button={(p) => (
                <IconButton label="More actions" {...p}>
                  <MoreHorizontal className="size-4" />
                </IconButton>
              )}
              items={[
                c.archived_at
                  ? { label: 'Restore client', icon: <RotateCcw />, onSelect: () => act.mutate('restore') }
                  : {
                      label: 'Archive client',
                      icon: <Archive />,
                      onSelect: async () => {
                        if (await confirm({ title: 'Archive this client?', body: 'They disappear from lists and lose portal access. Projects, invoices and history are kept and you can restore them any time.', confirmLabel: 'Archive' })) act.mutate('archive');
                      },
                    },
                {
                  label: 'Delete client',
                  icon: <Trash2 />,
                  danger: true,
                  onSelect: async () => {
                    if (await confirm({ title: 'Delete this client permanently?', body: 'Only possible when the client has no projects or invoices. Archiving is usually what you want.', confirmLabel: 'Delete', danger: true })) act.mutate('delete');
                  },
                },
              ]}
            />
          </div>
        )}
      </header>

      <Tabs
        label="Client sections"
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'overview', label: 'Overview' },
          { value: 'projects', label: 'Projects', count: data.projects.length },
          ...(f ? [{ value: 'invoices', label: 'Invoices', count: f.invoices.length }] : []),
          { value: 'communication', label: 'Communication' },
          { value: 'activity', label: 'Activity' },
          ...(admin ? [{ value: 'portal', label: 'Portal access', count: data.portal_users.length }] : []),
        ]}
      />

      {tab === 'overview' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 animate-enter">
          <div className="flex flex-col gap-4">
            <Card className="px-5 py-3">
              <InfoRow icon={<Mail />} label="Email">
                {c.email ? <a className="text-accent-ink hover:underline" href={`mailto:${c.email}`}>{c.email}</a> : '—'}
              </InfoRow>
              <InfoRow icon={<Phone />} label="Phone / WhatsApp">
                {[c.phone, c.whatsapp].filter(Boolean).join(' · ') || '—'}
              </InfoRow>
              {c.other_contact && (
                <InfoRow icon={<MessageCircle />} label="Other contact">
                  {c.other_contact}
                </InfoRow>
              )}
              <InfoRow icon={<Globe />} label="Website & socials">
                <div className="flex flex-wrap gap-x-3 gap-y-1">
                  {c.website ? <ExtLink url={c.website} /> : null}
                  {socials.map((k) => {
                    const href = socialHref(k, c.socials[k]);
                    return href ? (
                      <a key={k} href={safeHref(href)} target="_blank" rel="noreferrer noopener" className="text-accent-ink hover:underline">
                        {SOCIAL_LABELS[k]}
                      </a>
                    ) : (
                      <span key={k} className="text-ink-2">
                        {SOCIAL_LABELS[k]}: {c.socials[k]}
                      </span>
                    );
                  })}
                  {!c.website && socials.length === 0 && '—'}
                </div>
              </InfoRow>
            </Card>
            {c.notes && (
              <Card className="p-5">
                <h3 className="label-caps mb-2">Notes</h3>
                <p className="text-[13px] text-ink-2 whitespace-pre-wrap leading-relaxed">{c.notes}</p>
              </Card>
            )}
          </div>
          <Card className="p-5 lg:col-span-2">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
              {admin && (
                <Stat label="Retainer">
                  {c.retainer_minor ? (
                    <div className="text-[20px] font-semibold tabular">
                      {formatMoney(c.retainer_minor, c.currency)}
                      <span className="text-[13px] text-ink-3 font-normal">/{CYCLE_SHORT[c.billing_cycle]}</span>
                    </div>
                  ) : (
                    <div className="text-[14px] text-ink-3">Project-based</div>
                  )}
                  <div className="text-[12px] text-ink-3 mt-0.5">
                    {c.currency} · {BILLING_CYCLE_LABELS[c.billing_cycle]}
                  </div>
                </Stat>
              )}
              <Stat label="Contract">
                <div className="text-[13.5px] text-ink">{c.contract_start ? `Since ${formatDateLong(c.contract_start)}` : 'No start date'}</div>
                <div className={cx('text-[12px] mt-0.5', c.renewal_date && c.renewal_date < today ? 'text-bad' : 'text-ink-3')}>{c.renewal_date ? `Renews ${formatDate(c.renewal_date, today)}` : 'No renewal date'}</div>
              </Stat>
              <Stat label="Payment terms">
                <div className="text-[13.5px] text-ink">{c.payment_terms_days === 0 ? 'Due on receipt' : `Net ${c.payment_terms_days} days`}</div>
                {c.payment_terms_note && <div className="text-[12px] text-ink-3 mt-0.5">{c.payment_terms_note}</div>}
              </Stat>
            </div>
            {f && (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-5 mt-6 pt-5 border-t border-line">
                <Stat label="Collected (lifetime)">
                  <MoneyStack groups={f.collected_lifetime} size="md" empty="Nothing yet" />
                </Stat>
                <Stat label="Outstanding">
                  <MoneyStack groups={f.outstanding} size="md" empty="All paid" />
                </Stat>
                <Stat label="Overdue">
                  <MoneyStack groups={f.overdue} size="md" tone="bad" empty={<span className="text-good">None</span>} />
                </Stat>
              </div>
            )}
            <div className="mt-6 pt-5 border-t border-line">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-[13.5px] font-semibold">Open deliverables</h3>
                <Button size="xs" variant="ghost" onClick={() => setTab('projects')}>
                  All projects
                </Button>
              </div>
              {data.deliverables.length === 0 ? (
                <p className="text-[13px] text-ink-3 py-2">Nothing in production for this client.</p>
              ) : (
                <ul className="divide-y divide-line">
                  {data.deliverables.slice(0, 10).map((d) => (
                    <li key={d.id}>
                      <Link to={`/projects/${d.project_id}`} className="flex items-center gap-3 py-2 hover:bg-white/[0.02] -mx-2 px-2 rounded-lg">
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] text-ink">{d.title}</span>
                          <span className="block truncate text-[12px] text-ink-3">{d.project_name}</span>
                        </span>
                        <StageBadge stage={d.status} />
                        <DueChip date={d.deadline} today={today} compact className="w-24 text-right justify-end" />
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Card>
        </div>
      )}

      {tab === 'projects' && (
        <Card className="animate-enter">
          <CardHeader title="Projects" action={admin && <Button size="sm" variant="primary" icon={<Plus className="size-3.5" />} onClick={() => setNewProject(true)}>New project</Button>} />
          {data.projects.length === 0 ? (
            <EmptyState compact icon={<FolderKanban className="size-5" />} title="No projects yet" />
          ) : (
            <ul className="px-5 pb-3 divide-y divide-line">
              {data.projects.map((p) => (
                <li key={p.id}>
                  <Link to={`/projects/${p.id}`} className="flex flex-wrap items-center gap-3 py-3">
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13.5px] text-ink font-medium truncate">
                        {p.name} {p.is_demo ? <DemoBadge /> : null}
                      </span>
                      <span className="block text-[12px] text-ink-3">
                        {PROJECT_TYPE_LABELS[p.type as keyof typeof PROJECT_TYPE_LABELS]} · {p.delivered_count}/{p.deliverable_count} delivered{p.editor_name ? ` · ${p.editor_name}` : ''}
                      </span>
                    </span>
                    {admin && p.price_minor ? <span className="text-[12.5px] text-ink-2 tabular">{formatMoney(p.price_minor, p.currency)}</span> : null}
                    <StageBadge stage={p.status} />
                    <DueChip date={p.deadline} today={today} done={p.status === 'delivered' || p.status === 'cancelled'} className="w-28 text-right" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {tab === 'invoices' && f && (
        <Card className="animate-enter">
          <CardHeader title="Invoices" action={<Button size="sm" variant="primary" icon={<Plus className="size-3.5" />} to={`/invoices/new?client=${c.id}`}>New invoice</Button>} />
          {f.invoices.length === 0 ? (
            <EmptyState compact icon={<FileText className="size-5" />} title="No invoices yet" />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead className="text-left text-[12px] text-ink-3 border-y border-line">
                  <tr>
                    <th className="py-2 px-5 font-medium">Invoice</th>
                    <th className="py-2 px-3 font-medium">Issued</th>
                    <th className="py-2 px-3 font-medium">Due</th>
                    <th className="py-2 px-3 font-medium">Status</th>
                    <th className="py-2 px-3 font-medium text-right">Total</th>
                    <th className="py-2 px-5 font-medium text-right">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {f.invoices.map((i) => (
                    <tr key={i.id} className="border-b border-line last:border-0 hover:bg-white/[0.02] cursor-pointer" onClick={() => navigate(`/invoices/${i.id}`)}>
                      <td className="py-2.5 px-5 font-medium text-ink">{i.number}</td>
                      <td className="py-2.5 px-3 text-ink-2 tabular">{formatDate(i.issue_date, today)}</td>
                      <td className="py-2.5 px-3 text-ink-2 tabular">{formatDate(i.due_date, today)}</td>
                      <td className="py-2.5 px-3">
                        <InvoiceStatusBadge status={i.status} daysOverdue={i.days_overdue} />
                      </td>
                      <td className="py-2.5 px-3 text-right tabular">{formatMoney(i.total_minor, i.currency)}</td>
                      <td className={cx('py-2.5 px-5 text-right tabular', i.balance_minor > 0 && i.status !== 'draft' && i.status !== 'void' ? 'text-ink' : 'text-ink-3')}>{formatMoney(i.balance_minor, i.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {tab === 'communication' && (
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_1.4fr] gap-4 animate-enter">
          <Card className="p-5 h-fit">
            <h3 className="text-[13.5px] font-semibold mb-3">Log a conversation</h3>
            <CommunicationForm endpoint={`/api/clients/${c.id}/communications`} onDone={() => timeline.refetch()} />
          </Card>
          <Card>
            <CardHeader title="Communication history" />
            {timeline.isLoading ? (
              <div className="p-5 text-ink-3 text-[13px]">Loading…</div>
            ) : comms.length === 0 ? (
              <EmptyState compact title="Nothing logged yet" body="Calls, emails, WhatsApp messages and meeting notes you log appear here." />
            ) : (
              <ol className="px-5 pb-4 flex flex-col gap-3">
                {comms.map((m) => (
                  <li key={m.id} className="rounded-xl bg-white/[0.025] ring-1 ring-inset ring-white/[0.05] p-3">
                    <div className="flex flex-wrap items-center gap-2 text-[12px] text-ink-3">
                      <Badge tone={m.direction === 'inbound' ? 'info' : m.direction === 'internal' ? 'neutral' : 'accent'}>
                        {COMM_CHANNEL_LABELS[m.channel as keyof typeof COMM_CHANNEL_LABELS]} · {m.direction}
                      </Badge>
                      {formatDate(m.occurred_at, today)} · {m.actor_name ?? '—'}
                    </div>
                    {m.subject && <div className="mt-1.5 text-[13px] font-medium text-ink">{m.subject}</div>}
                    {m.body && <p className="mt-1 text-[13px] text-ink-2 whitespace-pre-wrap">{m.body}</p>}
                  </li>
                ))}
              </ol>
            )}
          </Card>
        </div>
      )}

      {tab === 'activity' && (
        <Card className="animate-enter">
          <CardHeader title="Activity timeline" description="Everything that happened with this client: projects, deliverables, invoices, payments and conversations." />
          {timeline.isLoading ? (
            <div className="p-5 text-ink-3 text-[13px]">Loading…</div>
          ) : (timeline.data?.items ?? []).length === 0 ? (
            <EmptyState compact title="No activity yet" />
          ) : (
            <ol className="relative px-5 pb-5 ml-2">
              <span className="absolute left-[27px] top-0 bottom-5 w-px bg-line" aria-hidden />
              {(timeline.data?.items ?? []).map((i) => (
                <li key={`${i.kind}-${i.id}`} className="relative flex gap-3 py-2">
                  <span className={cx('relative z-10 mt-1.5 size-2.5 rounded-full ring-4 ring-surface shrink-0', i.kind === 'communication' ? 'bg-[#3987e5]' : i.action?.includes('payment') ? 'bg-good-dot' : 'bg-accent-ink')} aria-hidden />
                  <div className="min-w-0">
                    <p className="text-[13px] text-ink-2">{i.kind === 'communication' ? `${COMM_CHANNEL_LABELS[i.channel as keyof typeof COMM_CHANNEL_LABELS]} (${i.direction})${i.subject ? `: ${i.subject}` : ''}` : i.summary}</p>
                    <p className="text-[11.5px] text-ink-3">
                      {i.actor_name ?? 'System'} · {i.kind === 'communication' ? formatDate(i.occurred_at, today) : timeAgo(i.at)}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </Card>
      )}

      {tab === 'portal' && admin && <PortalAccess client={c} users={data.portal_users} />}

      <ClientFormDialog open={editing} onClose={() => setEditing(false)} client={c} />
      <ProjectFormDialog open={newProject} onClose={() => setNewProject(false)} defaultClientId={c.id} onSaved={(pid) => navigate(`/projects/${pid}`)} />
    </div>
  );
}
