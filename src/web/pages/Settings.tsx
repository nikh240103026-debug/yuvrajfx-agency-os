import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Database, Download, KeyRound, MoreHorizontal, Plus, ShieldCheck, Sparkles, Trash2, UserPlus } from 'lucide-react';
import { api, ApiError, errorMessage } from '../lib/api.ts';
import { invalidateAll, useAuth, useTeam } from '../lib/queries.ts';
import { Badge, Button, Card, CardHeader, ErrorState, Field, IconButton, Input, Notice, PageHeader, PageSkeleton, Select, SelectField, Tabs, TextareaField, TextField } from '../components/ui.tsx';
import { Dialog, Menu, useConfirm, useToast } from '../components/overlay.tsx';
import { CurrencySelect } from '../components/money.tsx';
import { COMMON_CURRENCIES, ROLE_LABELS, type Role } from '../../shared/constants.ts';
import { copyText, timeAgo } from '../lib/util.ts';

type Settings = {
  business_name: string;
  business_email: string;
  business_phone: string;
  business_address: string;
  business_website: string;
  tax_id_label: string;
  tax_id: string;
  base_currency: string;
  timezone: string;
  fx_rates: Record<string, number>;
  fx_as_of: string | null;
  invoice_prefix: string;
  invoice_next_number: number;
  invoice_number_padding: number;
  default_payment_terms_days: number;
  default_taxes: { label: string; rate: number }[];
  default_invoice_terms: string;
  payment_instructions: string;
  invoice_footer: string;
  owner_report_email: string;
};
type System = { database: string; node: string; email: { configured: boolean; description: string }; demo: Record<string, number>; today: string };
type UserRow = { id: number; email: string; name: string; role: Role; client_id: number | null; client_name: string | null; team_member_id: number | null; team_member_name: string | null; disabled: number; must_change_password: number; last_login_at: string | null };

const TIMEZONES = ['Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Chicago', 'America/Los_Angeles', 'Australia/Sydney', 'UTC'];

function SettingsForm({ settings, tab }: { settings: Settings; tab: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState(settings);
  const [rates, setRates] = useState(Object.entries(settings.fx_rates).map(([c, r]) => ({ currency: c, rate: String(r) })));
  const [taxes, setTaxes] = useState(settings.default_taxes.map((t) => ({ label: t.label, rate: String(t.rate) })));
  useEffect(() => setForm(settings), [settings]);
  const save = useMutation({
    mutationFn: () =>
      api.put('/api/settings', {
        ...form,
        fx_rates: Object.fromEntries(rates.filter((r) => r.currency && Number(r.rate) > 0 && r.currency !== form.base_currency).map((r) => [r.currency, Number(r.rate)])),
        default_taxes: taxes.filter((t) => t.label.trim()).map((t) => ({ label: t.label.trim(), rate: Number(t.rate) || 0 })),
      }),
    onSuccess: () => {
      invalidateAll(qc, 'settings', 'auth', 'finance', 'invoice-meta');
      toast.success('Settings saved');
    },
  });
  const error = save.error instanceof ApiError ? save.error : null;
  const set = <K extends keyof Settings>(k: K) => (v: Settings[K]) => setForm((f) => ({ ...f, [k]: v }));
  const nextNumber = `${form.invoice_prefix}${String(form.invoice_next_number || 1).padStart(Math.min(8, Math.max(1, form.invoice_number_padding || 1)), '0')}`;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      {tab === 'business' && (
        <Card className="p-5 sm:p-6 flex flex-col gap-4 max-w-3xl">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <TextField label="Business name" required value={form.business_name} onChange={(e) => set('business_name')(e.target.value)} error={error?.field('business_name')} />
            <TextField label="Business email" type="email" value={form.business_email} onChange={(e) => set('business_email')(e.target.value)} error={error?.field('business_email')} />
            <TextField label="Phone" value={form.business_phone} onChange={(e) => set('business_phone')(e.target.value)} />
            <TextField label="Website" value={form.business_website} onChange={(e) => set('business_website')(e.target.value)} error={error?.field('business_website')} />
            <TextField label="Tax ID label" placeholder="GSTIN / VAT / PAN" value={form.tax_id_label} onChange={(e) => set('tax_id_label')(e.target.value)} />
            <TextField label="Tax ID" value={form.tax_id} onChange={(e) => set('tax_id')(e.target.value)} />
          </div>
          <TextareaField label="Address" rows={3} value={form.business_address} onChange={(e) => set('business_address')(e.target.value)} hint="Printed on invoices." />
          <TextField label="Email for reports" type="email" value={form.owner_report_email} onChange={(e) => set('owner_report_email')(e.target.value)} hint="Where weekly and monthly summaries are drafted to, if you turn that on in Automations." error={error?.field('owner_report_email')} />
        </Card>
      )}
      {tab === 'invoicing' && (
        <Card className="p-5 sm:p-6 flex flex-col gap-4 max-w-3xl">
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
            <TextField label="Number prefix" value={form.invoice_prefix} onChange={(e) => set('invoice_prefix')(e.target.value)} error={error?.field('invoice_prefix')} />
            <TextField label="Next number" type="number" min={1} value={form.invoice_next_number} onChange={(e) => set('invoice_next_number')(Number(e.target.value) || 1)} />
            <TextField label="Digits" type="number" min={1} max={8} value={form.invoice_number_padding} onChange={(e) => set('invoice_number_padding')(Number(e.target.value) || 1)} />
            <Field label="Next invoice">
              <div className="h-9 flex items-center text-[14px] font-medium tabular">{nextNumber}</div>
            </Field>
          </div>
          <SelectField label="Default payment terms" value={form.default_payment_terms_days} onChange={(e) => set('default_payment_terms_days')(Number(e.target.value))} hint="Used for new clients and invoices without client terms.">
            {[0, 7, 15, 30, 45, 60].map((d) => (
              <option key={d} value={d}>
                {d === 0 ? 'Due on receipt' : `Net ${d} days`}
              </option>
            ))}
          </SelectField>
          <Field label="Default taxes on new invoices" hint="E.g. CGST 9% + SGST 9% for intra-state Indian clients. Leave empty for exports.">
            <div className="flex flex-col gap-2">
              {taxes.map((t, i) => (
                <div key={i} className="grid grid-cols-[1fr_100px_36px] gap-2 max-w-md">
                  <Input aria-label="Tax label" value={t.label} onChange={(e) => setTaxes(taxes.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
                  <Input aria-label="Rate %" inputMode="decimal" value={t.rate} onChange={(e) => setTaxes(taxes.map((x, j) => (j === i ? { ...x, rate: e.target.value.replace(/[^\d.]/g, '') } : x)))} />
                  <IconButton label="Remove tax" onClick={() => setTaxes(taxes.filter((_, j) => j !== i))}>
                    <Trash2 className="size-4" />
                  </IconButton>
                </div>
              ))}
              {taxes.length < 4 && (
                <Button size="sm" variant="ghost" className="self-start -ml-2" icon={<Plus className="size-3.5" />} onClick={() => setTaxes([...taxes, { label: '', rate: '' }])}>
                  Add tax
                </Button>
              )}
            </div>
          </Field>
          <TextareaField label="Payment instructions" rows={4} value={form.payment_instructions} onChange={(e) => set('payment_instructions')(e.target.value)} hint="Printed on every invoice under “How to pay” — bank details, UPI ID, Wise or PayPal link. You enter these; nothing is pre-filled." />
          <TextareaField label="Default invoice terms" rows={2} value={form.default_invoice_terms} onChange={(e) => set('default_invoice_terms')(e.target.value)} />
          <TextField label="Invoice footer" value={form.invoice_footer} onChange={(e) => set('invoice_footer')(e.target.value)} />
        </Card>
      )}
      {tab === 'currency' && (
        <Card className="p-5 sm:p-6 flex flex-col gap-4 max-w-3xl">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Reporting currency" hint="Listed first in totals and used for the optional ≈ estimate.">
              <CurrencySelect value={form.base_currency} onChange={set('base_currency')} />
            </Field>
            <SelectField label="Business timezone" value={form.timezone} onChange={(e) => set('timezone')(e.target.value)} hint="Decides what “today”, “due” and “overdue” mean.">
              {[...new Set([form.timezone, ...TIMEZONES])].map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </SelectField>
          </div>
          <Notice tone="info">
            Amounts in different currencies are always shown separately. If you add exchange rates below, the app also shows an approximate combined total marked “≈ … at your rates”. These rates are yours: they are never fetched from the internet and never change recorded amounts.
          </Notice>
          <Field label={`Exchange rates (1 unit = ? ${form.base_currency})`}>
            <div className="flex flex-col gap-2">
              {rates.map((r, i) => (
                <div key={i} className="grid grid-cols-[120px_1fr_36px] gap-2 max-w-md items-center">
                  <Select aria-label="Currency" value={r.currency} onChange={(e) => setRates(rates.map((x, j) => (j === i ? { ...x, currency: e.target.value } : x)))}>
                    {COMMON_CURRENCIES.filter((c) => c !== form.base_currency).map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </Select>
                  <Input aria-label="Rate" inputMode="decimal" placeholder="84.20" value={r.rate} onChange={(e) => setRates(rates.map((x, j) => (j === i ? { ...x, rate: e.target.value.replace(/[^\d.]/g, '') } : x)))} />
                  <IconButton label="Remove rate" onClick={() => setRates(rates.filter((_, j) => j !== i))}>
                    <Trash2 className="size-4" />
                  </IconButton>
                </div>
              ))}
              <Button size="sm" variant="ghost" className="self-start -ml-2" icon={<Plus className="size-3.5" />} onClick={() => setRates([...rates, { currency: COMMON_CURRENCIES.find((c) => c !== form.base_currency && !rates.some((r) => r.currency === c)) ?? 'USD', rate: '' }])}>
                Add rate
              </Button>
            </div>
          </Field>
          <TextField label="Rates as of" type="date" value={form.fx_as_of ?? ''} onChange={(e) => set('fx_as_of')(e.target.value || null)} className="max-w-xs" />
        </Card>
      )}
      {['business', 'invoicing', 'currency'].includes(tab) && (
        <div className="mt-4 flex items-center gap-3">
          <Button type="submit" variant="primary" loading={save.isPending}>
            Save settings
          </Button>
          {error && !error.details?.fields && <span className="text-[13px] text-bad">{error.message}</span>}
          {error?.details?.fields && <span className="text-[13px] text-bad">{error.message}</span>}
        </div>
      )}
    </form>
  );
}

function Users() {
  const qc = useQueryClient();
  const toast = useToast();
  const { confirm } = useConfirm();
  const { data: auth } = useAuth();
  const { data: team } = useTeam();
  const { data, isLoading } = useQuery({ queryKey: ['settings', 'users'], queryFn: () => api.get<{ users: UserRow[] }>('/api/settings/users') });
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: '', email: '', role: 'member', team_member_id: '' });
  const [secret, setSecret] = useState<{ email: string; password: string } | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['settings', 'users'] });
  const create = useMutation({
    mutationFn: () => api.post<{ temporary_password: string }>('/api/settings/users', { ...form, team_member_id: form.team_member_id ? Number(form.team_member_id) : null }),
    onSuccess: (r) => {
      setSecret({ email: form.email, password: r.temporary_password });
      setCreating(false);
      setForm({ name: '', email: '', role: 'member', team_member_id: '' });
      refresh();
    },
  });
  const act = useMutation({
    mutationFn: (v: { id: number; path: 'reset' | 'disable' | 'enable' | 'delete'; email: string }) =>
      v.path === 'reset' ? api.post<{ temporary_password: string }>(`/api/settings/users/${v.id}/reset-password`) : v.path === 'delete' ? api.del(`/api/settings/users/${v.id}`) : api.patch(`/api/settings/users/${v.id}`, { disabled: v.path === 'disable' }),
    onSuccess: (r, v) => {
      refresh();
      if (v.path === 'reset') setSecret({ email: v.email, password: (r as { temporary_password: string }).temporary_password });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const users = data?.users ?? [];
  return (
    <>
      <Card>
        <CardHeader title="Logins" description="Owner and admins see everything. Team members see production (no money). Client logins only see their own portal." action={<Button size="sm" variant="primary" icon={<UserPlus className="size-3.5" />} onClick={() => setCreating(true)}>Add team login</Button>} />
        {isLoading ? (
          <div className="p-5 text-ink-3">Loading…</div>
        ) : (
          <ul className="divide-y divide-line">
            {users.map((u) => (
              <li key={u.id} className="flex items-center gap-3 px-5 py-3">
                <div className="min-w-0 flex-1">
                  <div className="text-[13.5px] text-ink flex flex-wrap items-center gap-2">
                    {u.name}
                    <Badge tone={u.role === 'owner' ? 'accent' : u.role === 'client' ? 'info' : 'neutral'}>{ROLE_LABELS[u.role]}</Badge>
                    {u.disabled ? <Badge tone="bad">Disabled</Badge> : u.must_change_password ? <Badge tone="warn">Pending first sign-in</Badge> : null}
                    {u.id === auth?.user?.id && <Badge>You</Badge>}
                  </div>
                  <div className="text-[12px] text-ink-3">
                    {u.email}
                    {u.client_name ? ` · ${u.client_name}` : ''}
                    {u.team_member_name ? ` · ${u.team_member_name}` : ''} · {u.last_login_at ? `signed in ${timeAgo(u.last_login_at)}` : 'never signed in'}
                  </div>
                </div>
                {u.role !== 'owner' && u.id !== auth?.user?.id && (
                  <Menu
                    label="Login actions"
                    button={(p) => (
                      <IconButton size="sm" label={`Actions for ${u.email}`} {...p}>
                        <MoreHorizontal className="size-4" />
                      </IconButton>
                    )}
                    items={[
                      { label: 'Reset password', icon: <KeyRound />, onSelect: () => act.mutate({ id: u.id, path: 'reset', email: u.email }) },
                      { label: u.disabled ? 'Enable' : 'Disable', icon: <ShieldCheck />, onSelect: () => act.mutate({ id: u.id, path: u.disabled ? 'enable' : 'disable', email: u.email }) },
                      {
                        label: 'Delete login',
                        icon: <Trash2 />,
                        danger: true,
                        onSelect: async () => {
                          if (await confirm({ title: `Delete ${u.email}?`, confirmLabel: 'Delete', danger: true })) act.mutate({ id: u.id, path: 'delete', email: u.email });
                        },
                      },
                    ]}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
      <p className="mt-3 text-[12.5px] text-ink-3">Client portal logins are created from each client’s page → Portal access.</p>
      <Dialog
        open={creating}
        onClose={() => setCreating(false)}
        title="Add a team login"
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
          <TextField label="Email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          <SelectField label="Role" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
            <option value="member">Team member — production only, no money</option>
            {auth?.user?.role === 'owner' && <option value="admin">Admin — everything</option>}
          </SelectField>
          <SelectField label="Linked team member" optional value={form.team_member_id} onChange={(e) => setForm({ ...form, team_member_id: e.target.value })}>
            <option value="">None</option>
            {(team?.members ?? []).map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </SelectField>
          {create.error && <Notice tone="bad">{errorMessage(create.error)}</Notice>}
        </div>
      </Dialog>
      <Dialog open={!!secret} onClose={() => setSecret(null)} title="One-time password" size="sm" footer={<Button variant="primary" onClick={() => setSecret(null)}>Done</Button>}>
        {secret && (
          <div className="flex flex-col gap-3">
            <p className="text-[13px] text-ink-2">Share it privately. It is shown only once and must be changed at first sign-in.</p>
            <div className="rounded-xl bg-bg-subtle ring-1 ring-inset ring-white/[0.08] p-3 font-mono text-[13px]">
              <div className="text-ink">{secret.email}</div>
              <div className="text-ink select-all mt-1">{secret.password}</div>
            </div>
            <Button
              icon={<Copy className="size-4" />}
              onClick={async () => {
                const ok = await copyText(`Sign in at ${window.location.origin}/login\nEmail: ${secret.email}\nTemporary password: ${secret.password}`);
                toast[ok ? 'success' : 'error'](ok ? 'Copied' : 'Copy failed');
              }}
            >
              Copy sign-in details
            </Button>
          </div>
        )}
      </Dialog>
    </>
  );
}

function DataTab({ system }: { system: System }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { confirm } = useConfirm();
  const demoTotal = system.demo.total ?? 0;
  const demo = useMutation({
    mutationFn: (load: boolean) => (load ? api.post('/api/settings/demo') : api.del('/api/settings/demo')),
    onSuccess: (_r, load) => {
      qc.invalidateQueries();
      toast.success(load ? 'Demo data loaded — every record is marked DEMO' : 'Demo data removed. Your own records were not touched.');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const counts = Object.entries(system.demo).filter(([k, v]) => k !== 'total' && v > 0);
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <Card className="p-5">
        <h3 className="text-[14px] font-semibold flex items-center gap-2">
          <Sparkles className="size-4 text-warn" /> Demo data
        </h3>
        <p className="text-[12.5px] text-ink-3 mt-1 mb-4">Fictional clients (with .example domains), projects, invoices, payments, expenses and leads, so you can explore every screen. Everything is marked DEMO and removable in one click.</p>
        {demoTotal > 0 ? (
          <>
            <p className="text-[12.5px] text-ink-2 mb-3">{counts.map(([k, v]) => `${v} ${k.replace(/_/g, ' ')}`).join(' · ')}</p>
            <Button
              variant="danger"
              icon={<Trash2 className="size-4" />}
              loading={demo.isPending}
              onClick={async () => {
                if (await confirm({ title: 'Remove all demo data?', body: 'Deletes every record marked DEMO, including anything generated from it (notifications, drafted emails, report snapshots). Your real records stay untouched. If you attached real work to a demo client, the removal is refused so nothing real is lost.', confirmLabel: 'Remove demo data', danger: true })) demo.mutate(false);
              }}
            >
              Remove demo data
            </Button>
          </>
        ) : (
          <Button icon={<Sparkles className="size-4" />} loading={demo.isPending} onClick={() => demo.mutate(true)}>
            Load demo data
          </Button>
        )}
      </Card>
      <Card className="p-5">
        <h3 className="text-[14px] font-semibold flex items-center gap-2">
          <Database className="size-4 text-ink-3" /> Database & backup
        </h3>
        <dl className="mt-3 text-[12.5px] flex flex-col gap-1.5">
          <div>
            <dt className="text-ink-3">Database engine</dt>
            <dd className="text-ink-2 font-mono text-[12px] break-all">{system.database}</dd>
          </div>
        </dl>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button href="/api/settings/backup" download icon={<Download className="size-4" />}>
            Download backup
          </Button>
        </div>
        <p className="mt-2 text-[12px] text-ink-3">Downloads a PostgreSQL custom-format dump when pg_dump is installed on the server. Also configure automated backups with your database provider.</p>
      </Card>
      <Card className="p-5 lg:col-span-2">
        <h3 className="text-[14px] font-semibold">CSV exports</h3>
        <p className="text-[12.5px] text-ink-3 mt-1 mb-3">Open in Excel or Google Sheets. Text that looks like a formula is escaped for safety.</p>
        <div className="flex flex-wrap gap-2">
          {[
            ['Clients', '/api/clients/export.csv'],
            ['Projects', '/api/projects/export.csv'],
            ['Deliverables', '/api/deliverables/export.csv'],
            ['Invoices', '/api/invoices/export.csv'],
            ['Payments', '/api/payments/export.csv'],
            ['Expenses', '/api/expenses/export.csv'],
            ['Pipeline', '/api/leads/export.csv'],
            ['Tasks', '/api/tasks/export.csv'],
            ['This month’s report', '/api/finance/report.csv?period=month'],
          ].map(([label, href]) => (
            <Button key={href} size="sm" href={href} download icon={<Download className="size-3.5" />}>
              {label}
            </Button>
          ))}
        </div>
      </Card>
    </div>
  );
}

export default function SettingsPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'business';
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['settings'], queryFn: () => api.get<{ settings: Settings; system: System }>('/api/settings') });
  if (isLoading) return <PageSkeleton />;
  if (error || !data) return <ErrorState error={error} onRetry={() => refetch()} />;
  return (
    <div>
      <PageHeader title="Settings" description="Business details for invoices, numbering, currencies, logins and your data." />
      <Tabs
        label="Settings sections"
        value={tab}
        onChange={(t) => {
          const next = new URLSearchParams(params);
          next.set('tab', t);
          setParams(next, { replace: true });
        }}
        tabs={[
          { value: 'business', label: 'Business' },
          { value: 'invoicing', label: 'Invoicing' },
          { value: 'currency', label: 'Currency & time' },
          { value: 'access', label: 'Logins & access' },
          { value: 'data', label: 'Data' },
        ]}
      />
      {['business', 'invoicing', 'currency'].includes(tab) && <SettingsForm settings={data.settings} tab={tab} />}
      {tab === 'access' && <Users />}
      {tab === 'data' && <DataTab system={data.system} />}
    </div>
  );
}
