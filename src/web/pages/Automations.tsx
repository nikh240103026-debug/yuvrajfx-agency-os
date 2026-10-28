import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Mail, MailCheck, Play, Send, ShieldCheck, Trash2, Workflow } from 'lucide-react';
import { api, errorMessage } from '../lib/api.ts';
import { invalidateAll } from '../lib/queries.ts';
import { Badge, Button, Card, CardHeader, Checkbox, DemoBadge, EmptyState, ErrorState, Input, Notice, PageHeader, Skeleton, Switch, Tabs, Textarea } from '../components/ui.tsx';
import { useConfirm, useToast } from '../components/overlay.tsx';
import { OUTBOX_STATUS_LABELS, type OutboxStatus } from '../../shared/constants.ts';
import { copyText, cx, timeAgo } from '../lib/util.ts';

type Automation = { key: string; title: string; description: string; external: boolean; enabled: boolean; config: Record<string, number | boolean>; last_run_at: string | null; last_result: Record<string, number> | null };
type Run = { id: number; trigger: string; started_at: string; finished_at: string | null; status: string; summary: Record<string, unknown>; error: string | null };
type Message = { id: number; automation_key: string | null; to_address: string; to_name: string | null; subject: string; body: string; status: OutboxStatus; entity_type: string | null; entity_id: number | null; client_name: string | null; error: string | null; approved_by_name: string | null; sent_at: string | null; created_at: string; is_demo: number };

const CONFIG_LABELS: Record<string, string> = {
  days_before: 'Days before',
  draft_client_emails: 'Draft a reminder email to the client (needs your approval to send)',
  repeat_every_days: 'Remind again every (days)',
  grace_days: 'Wait after due date (days)',
  create_task: 'Also create a follow-up task',
  email_owner: 'Also draft it as an email to me (Settings → reports email)',
};

function summaryText(r: Record<string, unknown> | null): string {
  if (!r) return 'Not run yet';
  const parts = Object.entries(r)
    .filter(([, v]) => typeof v === 'number' && v > 0)
    .map(([k, v]) => `${v} ${k.replace(/_/g, ' ')}`);
  return parts.length ? parts.join(' · ') : 'Nothing new';
}

function AutomationCard({ a, onChanged }: { a: Automation; onChanged: () => void }) {
  const toast = useToast();
  const save = useMutation({ mutationFn: (body: Record<string, unknown>) => api.patch(`/api/automations/${a.key}`, body), onSuccess: onChanged, onError: (e) => toast.error(errorMessage(e)) });
  return (
    <Card className={cx('p-5 flex flex-col gap-3', !a.enabled && 'opacity-70')}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-[14px] font-semibold flex flex-wrap items-center gap-2">
            {a.title}
            {a.external ? <Badge tone="warn">Drafts emails · approval needed</Badge> : <Badge>In-app only</Badge>}
          </h3>
          <p className="text-[12.5px] text-ink-3 mt-1">{a.description}</p>
        </div>
        <Switch label={`${a.enabled ? 'Disable' : 'Enable'} ${a.title}`} checked={a.enabled} onChange={(v) => save.mutate({ enabled: v })} />
      </div>
      {Object.keys(a.config).length > 0 && (
        <div className="flex flex-col gap-2 rounded-xl bg-white/[0.02] ring-1 ring-inset ring-white/[0.05] p-3">
          {Object.entries(a.config).map(([k, v]) =>
            typeof v === 'boolean' ? (
              <Checkbox key={k} label={CONFIG_LABELS[k] ?? k} checked={v} onChange={(nv) => save.mutate({ config: { [k]: nv } })} />
            ) : (
              <label key={k} className="flex items-center justify-between gap-3 text-[13px] text-ink-2">
                {CONFIG_LABELS[k] ?? k}
                <Input type="number" min={0} max={365} defaultValue={v} className="!w-20 !h-8 tabular" onBlur={(e) => Number(e.target.value) !== v && save.mutate({ config: { [k]: Math.max(0, Math.min(365, Number(e.target.value) || 0)) } })} />
              </label>
            ),
          )}
        </div>
      )}
      <div className="text-[12px] text-ink-3">
        {a.last_run_at ? `Last checked ${timeAgo(a.last_run_at)} · ${summaryText(a.last_result)}` : 'Not run yet'}
      </div>
    </Card>
  );
}

function OutboxItem({ m, configured }: { m: Message; configured: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { confirm } = useConfirm();
  const [open, setOpen] = useState(m.status === 'pending_approval');
  const [draft, setDraft] = useState({ to_address: m.to_address, subject: m.subject, body: m.body });
  const dirty = draft.to_address !== m.to_address || draft.subject !== m.subject || draft.body !== m.body;
  const refresh = () => invalidateAll(qc, 'outbox', 'automations', 'invoice', 'invoices');
  const save = useMutation({ mutationFn: () => api.patch(`/api/outbox/${m.id}`, draft), onSuccess: () => { refresh(); toast.success('Draft saved'); }, onError: (e) => toast.error(errorMessage(e)) });
  const act = useMutation({
    mutationFn: (path: 'approve-send' | 'mark-sent' | 'discard') => api.post(`/api/outbox/${m.id}/${path}`),
    onSuccess: (_r, path) => {
      refresh();
      toast.success(path === 'approve-send' ? `Sent to ${m.to_address}` : path === 'mark-sent' ? 'Marked as sent manually' : 'Draft discarded');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const pending = m.status === 'pending_approval' || m.status === 'failed';
  const mailto = `mailto:${encodeURIComponent(draft.to_address)}?subject=${encodeURIComponent(draft.subject)}&body=${encodeURIComponent(draft.body)}`;
  return (
    <li className="px-5 py-4">
      <button type="button" className="flex w-full items-start gap-3 text-left cursor-pointer" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className={cx('mt-0.5 grid place-items-center size-8 rounded-lg shrink-0', pending ? 'bg-warn/10 text-warn' : 'bg-good-dot/12 text-good')}>{pending ? <Mail className="size-4" /> : <MailCheck className="size-4" />}</span>
        <span className="min-w-0 flex-1">
          <span className="block text-[13.5px] text-ink truncate">
            {m.subject} {m.is_demo ? <DemoBadge /> : null}
          </span>
          <span className="block text-[12px] text-ink-3 truncate">
            To {m.to_name ? `${m.to_name} <${m.to_address}>` : m.to_address}
            {m.client_name ? ` · ${m.client_name}` : ''} · drafted {timeAgo(m.created_at)}
            {m.sent_at ? ` · sent ${timeAgo(m.sent_at)}${m.approved_by_name ? ` by ${m.approved_by_name}` : ''}` : ''}
          </span>
        </span>
        <Badge tone={m.status === 'sent' || m.status === 'sent_manually' ? 'good' : m.status === 'failed' ? 'bad' : m.status === 'rejected' ? 'neutral' : 'warn'}>{OUTBOX_STATUS_LABELS[m.status]}</Badge>
      </button>
      {open && (
        <div className="mt-3 ml-11 flex flex-col gap-2.5">
          {m.error && <Notice tone="bad">Last attempt failed: {m.error}</Notice>}
          {pending ? (
            <>
              <Input aria-label="To" value={draft.to_address} onChange={(e) => setDraft({ ...draft, to_address: e.target.value })} />
              <Input aria-label="Subject" value={draft.subject} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} />
              <Textarea aria-label="Message" rows={10} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} className="font-sans" />
            </>
          ) : (
            <pre className="whitespace-pre-wrap rounded-xl bg-white/[0.03] p-3 text-[12.5px] text-ink-2 font-sans">{m.body}</pre>
          )}
          {pending && (
            <div className="flex flex-wrap items-center gap-2">
              {dirty && (
                <Button size="sm" onClick={() => save.mutate()} loading={save.isPending}>
                  Save changes
                </Button>
              )}
              <Button
                size="sm"
                variant="primary"
                icon={<Send className="size-3.5" />}
                disabled={!configured || dirty}
                title={!configured ? 'Email is not set up — use your own mail app instead' : dirty ? 'Save your changes first' : undefined}
                loading={act.isPending && act.variables === 'approve-send'}
                onClick={async () => {
                  if (await confirm({ title: 'Send this email now?', body: `To ${m.to_address}: “${m.subject}”. It is sent from your configured SMTP account.`, confirmLabel: 'Approve & send' })) act.mutate('approve-send');
                }}
              >
                Approve & send
              </Button>
              <Button size="sm" icon={<Mail className="size-3.5" />} href={mailto}>
                Open in my mail app
              </Button>
              <Button
                size="sm"
                variant="ghost"
                icon={<Copy className="size-3.5" />}
                onClick={async () => {
                  const ok = await copyText(`To: ${draft.to_address}\nSubject: ${draft.subject}\n\n${draft.body}`);
                  toast[ok ? 'success' : 'error'](ok ? 'Copied to clipboard' : 'Copy failed');
                }}
              >
                Copy
              </Button>
              <Button size="sm" variant="ghost" icon={<Check className="size-3.5" />} onClick={() => act.mutate('mark-sent')}>
                I sent it myself
              </Button>
              <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={() => act.mutate('discard')} className="ml-auto">
                Discard
              </Button>
            </div>
          )}
          {m.entity_type === 'invoice' && m.entity_id && (
            <Link className="text-[12px] text-accent-ink hover:underline" to={`/invoices/${m.entity_id}`}>
              Open the invoice
            </Link>
          )}
        </div>
      )}
    </li>
  );
}

export default function AutomationsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'rules';
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['automations'], queryFn: () => api.get<{ automations: Automation[]; runs: Run[]; email: { configured: boolean; description: string }; owner_report_email: string | null; pending_approval: number }>('/api/automations') });
  const outbox = useQuery({ queryKey: ['outbox'], queryFn: () => api.get<{ messages: Message[]; email: { configured: boolean } }>('/api/outbox'), enabled: tab === 'outbox' });
  const run = useMutation({
    mutationFn: () => api.post<{ status: string; summary: Record<string, unknown> }>('/api/automations/run'),
    onSuccess: (r) => {
      invalidateAll(qc, 'automations', 'outbox', 'tasks', 'projects', 'snapshots');
      toast[r.status === 'ok' ? 'success' : 'error'](r.status === 'ok' ? 'All automations ran. Anything new is in Notifications and the Outbox.' : 'Some automations failed — see the run history.');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const verify = useMutation({
    mutationFn: () => api.post<{ ok: boolean; error?: string }>('/api/automations/test-email'),
    onSuccess: (r) => toast[r.ok ? 'success' : 'error'](r.ok ? 'SMTP connection works.' : `SMTP check failed: ${r.error}`),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const setTab = (t: string) => {
    const next = new URLSearchParams(params);
    next.set('tab', t);
    setParams(next, { replace: true });
  };
  if (isLoading) return <Skeleton className="h-96" />;
  if (error || !data) return <ErrorState error={error} onRetry={() => refetch()} />;
  const messages = outbox.data?.messages ?? [];
  return (
    <div>
      <PageHeader
        title="Automations"
        description="Reminders, recurring work and reports that run every 15 minutes while the app is open. Nothing leaves the app without your approval."
        actions={
          <Button variant="primary" icon={<Play className="size-4" />} loading={run.isPending} onClick={() => run.mutate()}>
            Run all now
          </Button>
        }
      />
      {data.email.configured ? (
        <Notice tone="good" className="mb-4">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>
              <ShieldCheck className="size-4 inline -mt-0.5 mr-1" />
              Email is set up ({data.email.description}). Drafted emails still wait in the Outbox until you press <strong>Approve & send</strong>.
            </span>
            <button type="button" className="text-accent-ink hover:underline cursor-pointer" onClick={() => verify.mutate()}>
              Test connection
            </button>
          </div>
        </Notice>
      ) : (
        <Notice tone="info" className="mb-4">
          Email sending is off — no SMTP settings are configured. Drafted messages wait in the Outbox, where you can open them in your own mail app, copy them, or mark them as sent. To enable sending, add SMTP_HOST, SMTP_USER, SMTP_PASS and SMTP_FROM to the <code>.env</code> file and restart the app.
        </Notice>
      )}
      <Tabs
        label="Automation sections"
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'rules', label: 'Automations' },
          { value: 'outbox', label: 'Outbox', count: data.pending_approval },
          { value: 'history', label: 'Run history' },
        ]}
      />
      {tab === 'rules' && (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {data.automations.map((a) => (
              <AutomationCard key={a.key} a={a} onChanged={() => invalidateAll(qc, 'automations')} />
            ))}
          </div>
          <p className="mt-4 text-[12.5px] text-ink-3">
            Recurring tasks and projects are set up in <Link to="/tasks?view=recurring" className="text-accent-ink hover:underline">Tasks → Recurring</Link>.
            {!data.owner_report_email && ' Set a reports email in Settings → Business to receive summaries by email.'}
          </p>
        </>
      )}
      {tab === 'outbox' && (
        <Card>
          <CardHeader title="Outbox" description="Emails drafted by automations or from an invoice. Review, edit and approve each one — or send it yourself." />
          {outbox.isLoading ? (
            <div className="p-5">
              <Skeleton className="h-24" />
            </div>
          ) : messages.length === 0 ? (
            <EmptyState compact icon={<Mail className="size-5" />} title="Nothing drafted" body="Overdue invoice reminders and summaries you opt into will appear here for approval." />
          ) : (
            <ul className="divide-y divide-line">
              {messages.map((m) => (
                <OutboxItem key={m.id} m={m} configured={data.email.configured} />
              ))}
            </ul>
          )}
        </Card>
      )}
      {tab === 'history' && (
        <Card>
          <CardHeader title="Run history" description="The last 20 runs." />
          {data.runs.length === 0 ? (
            <EmptyState compact icon={<Workflow className="size-5" />} title="No runs yet" />
          ) : (
            <ul className="divide-y divide-line">
              {data.runs.map((r) => (
                <li key={r.id} className="px-5 py-3">
                  <div className="flex flex-wrap items-center gap-2 text-[13px]">
                    <Badge tone={r.status === 'ok' ? 'good' : r.status === 'error' ? 'bad' : 'warn'}>{r.status}</Badge>
                    <span className="text-ink-2">{r.trigger}</span>
                    <span className="text-ink-3">{timeAgo(r.started_at)}</span>
                  </div>
                  {r.error && <p className="text-[12px] text-bad mt-1">{r.error}</p>}
                  <p className="text-[12px] text-ink-3 mt-1">
                    {Object.entries(r.summary)
                      .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${typeof v === 'object' && v ? summaryText(v as Record<string, number>) : String(v)}`)
                      .join(' · ')}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </div>
  );
}
