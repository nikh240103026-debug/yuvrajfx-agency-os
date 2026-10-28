import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, ArrowLeft, CheckCircle2, CircleDashed, Download, Eye, EyeOff, FileText, FolderInput, MessageSquare, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react';
import { api, errorMessage } from '../lib/api.ts';
import { invalidateAll, useIsAdmin, useToday, type DeliverableRow, type ProjectRow } from '../lib/queries.ts';
import { Avatar, Badge, Button, Card, CardHeader, Checkbox, DemoBadge, EmptyState, ErrorState, IconButton, Input, Notice, PageSkeleton, Select } from '../components/ui.tsx';
import { Menu, useConfirm, useToast } from '../components/overlay.tsx';
import { DeliverableFormDialog, ProjectFormDialog, TaskFormDialog } from '../components/forms.tsx';
import { LinkChips } from '../components/inputs.tsx';
import { DueChip, InvoiceStatusBadge, PriorityBadge, StageBadge, stageColor } from '../lib/status.tsx';
import { BILLING_TYPE_LABELS, FEEDBACK_KIND_LABELS, PLATFORM_LABELS, PROJECT_STATUS_OPTIONS, PROJECT_TYPE_LABELS, STAGE_OPTIONS, type InvoiceStatus } from '../../shared/constants.ts';
import { formatMoney } from '../../shared/money.ts';
import { formatDate } from '../../shared/dates.ts';
import { cx, safeHref, timeAgo } from '../lib/util.ts';

type Feedback = { id: number; deliverable_id: number | null; deliverable_title: string | null; kind: keyof typeof FEEDBACK_KIND_LABELS; author_type: 'team' | 'client'; author_name: string; body: string; timecode: string | null; revision_number: number | null; visible_to_client: number; resolved_at: string | null; created_at: string; is_demo: number };
type Detail = {
  project: ProjectRow & { client_contact: string; client_email: string | null };
  deliverables: DeliverableRow[];
  feedback: Feedback[];
  activity: { id: number; summary: string; actor_name: string | null; created_at: string }[];
  tasks: { id: number; title: string; status: string; priority: string; due_date: string | null }[];
  invoices: { id: number; number: string; status: InvoiceStatus; total_minor: number; balance_minor: number; currency: string; issue_date: string; days_overdue: number }[];
};

function FeedbackComposer({ projectId, deliverables }: { projectId: number; deliverables: DeliverableRow[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState({ deliverable_id: '', kind: 'comment', body: '', timecode: '', visible_to_client: true, move_to_revisions: true });
  const save = useMutation({
    mutationFn: () =>
      api.post(`/api/projects/${projectId}/feedback`, {
        deliverable_id: form.deliverable_id ? Number(form.deliverable_id) : null,
        kind: form.kind,
        body: form.body,
        timecode: form.timecode,
        visible_to_client: form.kind === 'internal_note' ? false : form.visible_to_client,
        move_to_revisions: form.move_to_revisions,
      }),
    onSuccess: () => {
      invalidateAll(qc, 'project', 'deliverables', 'projects');
      setForm((f) => ({ ...f, body: '', timecode: '' }));
      toast.success(form.kind === 'revision_request' && form.move_to_revisions && form.deliverable_id ? 'Revision request logged · moved to Revisions' : 'Added to the history');
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (form.body.trim()) save.mutate();
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <div className="grid grid-cols-1 sm:grid-cols-[1.3fr_1fr_110px] gap-2">
        <Select aria-label="Deliverable" value={form.deliverable_id} onChange={(e) => setForm({ ...form, deliverable_id: e.target.value })}>
          <option value="">Whole project</option>
          {deliverables.map((d) => (
            <option key={d.id} value={d.id}>
              {d.title}
            </option>
          ))}
        </Select>
        <Select aria-label="Type" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
          {Object.entries(FEEDBACK_KIND_LABELS).map(([v, l]) => (
            <option key={v} value={v} disabled={v === 'approval' && !form.deliverable_id}>
              {l}
            </option>
          ))}
        </Select>
        <Input aria-label="Timecode" placeholder="00:42" value={form.timecode} onChange={(e) => setForm({ ...form, timecode: e.target.value })} />
      </div>
      <textarea className="field-input" rows={3} aria-label="Feedback" placeholder={form.kind === 'internal_note' ? 'Only the team sees this.' : 'Paste the client’s notes or write a reply…'} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} />
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        {form.kind !== 'internal_note' && <Checkbox label="Visible in client portal" checked={form.visible_to_client} onChange={(v) => setForm({ ...form, visible_to_client: v })} />}
        {form.kind === 'revision_request' && form.deliverable_id && <Checkbox label="Move to Revisions (counts a round)" checked={form.move_to_revisions} onChange={(v) => setForm({ ...form, move_to_revisions: v })} />}
        <Button type="submit" size="sm" variant="primary" className="ml-auto" loading={save.isPending} disabled={!form.body.trim()}>
          Add
        </Button>
      </div>
      {save.error && <Notice tone="bad">{errorMessage(save.error)}</Notice>}
    </form>
  );
}

export default function ProjectDetailPage() {
  const { id } = useParams();
  const admin = useIsAdmin();
  const today = useToday();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { confirm } = useConfirm();
  const [editing, setEditing] = useState(false);
  const [deliverable, setDeliverable] = useState<DeliverableRow | null | 'new'>(null);
  const [taskOpen, setTaskOpen] = useState(false);
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['project', id], queryFn: () => api.get<Detail>(`/api/projects/${id}`) });
  const refresh = () => invalidateAll(qc, 'project', 'projects', 'deliverables', 'team', 'calendar');
  const status = useMutation({
    mutationFn: (s: string) => api.patch(`/api/projects/${id}`, { status: s }),
    onSuccess: refresh,
    onError: (e) => toast.error(errorMessage(e)),
  });
  const stage = useMutation({
    mutationFn: ({ did, s }: { did: number; s: string }) => api.patch(`/api/deliverables/${did}`, { status: s }),
    onSuccess: (_r, v) => {
      refresh();
      if (v.s === 'revisions') toast.info('Moved to Revisions — revision round counted.');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const removeDeliverable = useMutation({ mutationFn: (did: number) => api.del(`/api/deliverables/${did}`), onSuccess: refresh, onError: (e) => toast.error(errorMessage(e)) });
  const feedbackAction = useMutation({
    mutationFn: ({ fid, action }: { fid: number; action: 'resolve' | 'reopen' | 'delete' }) => (action === 'delete' ? api.del(`/api/feedback/${fid}`) : api.patch(`/api/feedback/${fid}`, { resolved: action === 'resolve' })),
    onSuccess: refresh,
    onError: (e) => toast.error(errorMessage(e)),
  });
  const projectAction = useMutation({
    mutationFn: (a: 'archive' | 'delete') => (a === 'delete' ? api.del(`/api/projects/${id}`) : api.post(`/api/projects/${id}/archive`)),
    onSuccess: (_r, a) => {
      refresh();
      toast.success(a === 'delete' ? 'Project deleted' : 'Project archived');
      navigate('/projects');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const toggleTask = useMutation({ mutationFn: (t: { id: number; done: boolean }) => api.patch(`/api/tasks/${t.id}`, { status: t.done ? 'done' : 'todo' }), onSuccess: () => invalidateAll(qc, 'project', 'tasks') });

  if (isLoading) return <PageSkeleton />;
  if (error || !data) return <ErrorState error={error} onRetry={() => refetch()} />;
  const p = data.project;
  const pct = p.deliverable_count ? p.delivered_count / p.deliverable_count : 0;
  const openFeedback = data.feedback.filter((f) => f.author_type === 'client' && !f.resolved_at && f.kind !== 'approval').length;

  return (
    <div>
      <Link to="/projects" className="inline-flex items-center gap-1 text-[12.5px] text-ink-3 hover:text-ink mb-3">
        <ArrowLeft className="size-3.5" /> Projects
      </Link>
      <header className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between mb-6 animate-enter">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-[24px] font-semibold tracking-tight">{p.name}</h1>
            <PriorityBadge priority={p.priority} hideMedium />
            {p.is_demo ? <DemoBadge /> : null}
            {!p.portal_visible && (
              <Badge title="Hidden from the client portal">
                <EyeOff className="size-3" /> Hidden from client
              </Badge>
            )}
          </div>
          <p className="mt-1 text-[13.5px] text-ink-3">
            <Link to={`/clients/${p.client_id}`} className="text-ink-2 hover:text-ink hover:underline">
              {p.client_name}
            </Link>{' '}
            · {PROJECT_TYPE_LABELS[p.type as keyof typeof PROJECT_TYPE_LABELS]}
            {p.editor_name ? ` · led by ${p.editor_name}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select aria-label="Project status" value={p.status} onChange={(e) => status.mutate(e.target.value)} className="!w-44">
            {PROJECT_STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
          <Button icon={<Pencil className="size-4" />} onClick={() => setEditing(true)}>
            Edit
          </Button>
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setDeliverable('new')}>
            Deliverable
          </Button>
          {admin && (
            <Menu
              label="More"
              button={(props) => (
                <IconButton label="More actions" {...props}>
                  <MoreHorizontal className="size-4" />
                </IconButton>
              )}
              items={[
                { label: 'New invoice for this project', icon: <FileText />, onSelect: () => navigate(`/invoices/new?client=${p.client_id}&project=${p.id}`) },
                { label: 'Add a task', icon: <CheckCircle2 />, onSelect: () => setTaskOpen(true) },
                { divider: true },
                {
                  label: 'Archive project',
                  icon: <Archive />,
                  onSelect: async () => {
                    if (await confirm({ title: 'Archive this project?', body: 'It leaves the board and lists; deliverables and history are kept. Restore it from Projects → List → Archived.', confirmLabel: 'Archive' })) projectAction.mutate('archive');
                  },
                },
                {
                  label: 'Delete project',
                  icon: <Trash2 />,
                  danger: true,
                  onSelect: async () => {
                    if (await confirm({ title: 'Delete this project and all its deliverables?', body: 'This cannot be undone. Projects that have invoices cannot be deleted — archive them instead.', confirmLabel: 'Delete project', danger: true })) projectAction.mutate('delete');
                  },
                },
              ]}
            />
          )}
        </div>
      </header>

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 mb-4 animate-enter">
        <Card className="p-4">
          <div className="text-[12px] text-ink-3 mb-2">Progress</div>
          <div className="text-[22px] font-semibold tabular">
            {p.delivered_count}
            <span className="text-ink-3 text-[15px] font-normal"> / {p.deliverable_count} delivered</span>
          </div>
          <div className="mt-2 h-1.5 rounded-full bg-series-1/15 overflow-hidden">
            <div className="h-full rounded-full bg-series-1 transition-[width] duration-500" style={{ width: `${pct * 100}%` }} />
          </div>
        </Card>
        <Card className="p-4">
          <div className="text-[12px] text-ink-3 mb-2">Deadline</div>
          <div className="text-[15px] font-medium">{p.deadline ? formatDate(p.deadline, today) : 'Not set'}</div>
          <div className="mt-1">
            <DueChip date={p.deadline} today={today} done={p.status === 'delivered' || p.status === 'cancelled'} />
          </div>
        </Card>
        <Card className="p-4">
          <div className="text-[12px] text-ink-3 mb-2">Revisions & feedback</div>
          <div className="text-[22px] font-semibold tabular">{p.revision_total}</div>
          <div className="text-[12px] text-ink-3">{openFeedback ? <span className="text-warn">{openFeedback} client note{openFeedback > 1 ? 's' : ''} to address</span> : 'revision rounds in total'}</div>
        </Card>
        <Card className="p-4">
          <div className="text-[12px] text-ink-3 mb-2">{admin ? BILLING_TYPE_LABELS[(p.billing_type ?? 'fixed') as keyof typeof BILLING_TYPE_LABELS] : 'Overdue deliverables'}</div>
          {admin ? (
            <div className="text-[22px] font-semibold tabular">{p.price_minor != null ? formatMoney(p.price_minor, p.currency) : <span className="text-ink-3 text-[15px] font-normal">{p.billing_type === 'retainer' ? 'Part of retainer' : 'No price set'}</span>}</div>
          ) : (
            <div className={cx('text-[22px] font-semibold', p.overdue_deliverables ? 'text-bad' : '')}>{p.overdue_deliverables}</div>
          )}
          {admin && p.overdue_deliverables > 0 && <div className="text-[12px] text-bad">{p.overdue_deliverables} deliverable{p.overdue_deliverables > 1 ? 's' : ''} overdue</div>}
        </Card>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_360px] gap-4">
        <div className="flex flex-col gap-4 min-w-0">
          <Card>
            <CardHeader title="Deliverables" description="Change a stage right here, or open one for links, notes and revision count." action={<Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => setDeliverable('new')}>Add</Button>} />
            {data.deliverables.length === 0 ? (
              <EmptyState compact icon={<CircleDashed className="size-5" />} title="No deliverables yet" body="Add each video, cutdown or thumbnail you will deliver." action={<Button size="sm" variant="primary" onClick={() => setDeliverable('new')}>Add deliverable</Button>} />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-[13px]">
                  <thead className="text-left text-[12px] text-ink-3 border-y border-line">
                    <tr>
                      <th className="py-2 px-5 font-medium">Deliverable</th>
                      <th className="py-2 px-3 font-medium">Stage</th>
                      <th className="py-2 px-3 font-medium">Deadline</th>
                      <th className="py-2 px-3 font-medium">Assignee</th>
                      <th className="py-2 px-3 font-medium text-center">Rev.</th>
                      <th className="py-2 px-3 font-medium">Links</th>
                      <th className="py-2 px-3" aria-label="Actions" />
                    </tr>
                  </thead>
                  <tbody>
                    {data.deliverables.map((d) => (
                      <tr key={d.id} className={cx('border-b border-line last:border-0', d.is_overdue ? 'bg-bad-dot/[0.04]' : '')}>
                        <td className="py-2.5 px-5 min-w-48">
                          <button type="button" className="text-left font-medium text-ink hover:underline cursor-pointer" onClick={() => setDeliverable(d)}>
                            {d.title}
                          </button>
                          <div className="text-[11.5px] text-ink-3">{[d.platform ? PLATFORM_LABELS[d.platform as keyof typeof PLATFORM_LABELS] : null, d.format].filter(Boolean).join(' · ') || '—'}</div>
                        </td>
                        <td className="py-2.5 px-3">
                          <div className="relative">
                            <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 size-2 rounded-full" style={{ background: stageColor(d.status) }} aria-hidden />
                            <select aria-label={`Stage of ${d.title}`} value={d.status} onChange={(e) => stage.mutate({ did: d.id, s: e.target.value })} className="field-input !h-8 !pl-6 !w-40 text-[12.5px] cursor-pointer">
                              {STAGE_OPTIONS.map((o) => (
                                <option key={o.value} value={o.value}>
                                  {o.label}
                                </option>
                              ))}
                            </select>
                          </div>
                        </td>
                        <td className="py-2.5 px-3 whitespace-nowrap">
                          <DueChip date={d.deadline} today={today} done={d.status === 'delivered'} />
                        </td>
                        <td className="py-2.5 px-3">{d.assignee_name ? <span className="inline-flex items-center gap-1.5"><Avatar name={d.assignee_name} color={d.assignee_color} size={20} /><span className="text-ink-2 text-[12.5px] hidden 2xl:inline">{d.assignee_name}</span></span> : <span className="text-ink-3">—</span>}</td>
                        <td className="py-2.5 px-3 text-center tabular">{d.revision_count ? <Badge tone={d.revision_count >= 3 ? 'serious' : 'neutral'}>{d.revision_count}</Badge> : <span className="text-ink-3">0</span>}</td>
                        <td className="py-2.5 px-3">
                          <div className="flex items-center gap-2 text-ink-3">
                            {safeHref(d.source_url) && (
                              <a href={safeHref(d.source_url)} target="_blank" rel="noreferrer noopener" title="Source footage" className="hover:text-ink">
                                <FolderInput className="size-4" />
                              </a>
                            )}
                            {safeHref(d.review_url) && (
                              <a href={safeHref(d.review_url)} target="_blank" rel="noreferrer noopener" title="Review link" className="hover:text-ink">
                                <Eye className="size-4" />
                              </a>
                            )}
                            {safeHref(d.final_url) && (
                              <a href={safeHref(d.final_url)} target="_blank" rel="noreferrer noopener" title="Final delivery" className="hover:text-good">
                                <Download className="size-4" />
                              </a>
                            )}
                            {d.open_client_feedback > 0 && (
                              <span className="inline-flex items-center gap-0.5 text-warn text-[11.5px]" title="Unresolved client feedback">
                                <MessageSquare className="size-3.5" />
                                {d.open_client_feedback}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="py-2.5 px-3 text-right">
                          <Menu
                            label="Deliverable actions"
                            button={(props) => (
                              <IconButton label={`Actions for ${d.title}`} size="sm" {...props}>
                                <MoreHorizontal className="size-4" />
                              </IconButton>
                            )}
                            items={[
                              { label: 'Open details', icon: <Pencil />, onSelect: () => setDeliverable(d) },
                              {
                                label: 'Delete deliverable',
                                icon: <Trash2 />,
                                danger: true,
                                onSelect: async () => {
                                  if (await confirm({ title: `Delete “${d.title}”?`, body: 'Its feedback history is deleted too.', confirmLabel: 'Delete', danger: true })) removeDeliverable.mutate(d.id);
                                },
                              },
                            ]}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card>
            <CardHeader title="Feedback & revision history" description="Client notes, revision requests, approvals and internal notes, newest first." />
            <div className="px-5 pb-4">
              <FeedbackComposer projectId={p.id} deliverables={data.deliverables} />
            </div>
            {data.feedback.length === 0 ? (
              <EmptyState compact title="No feedback yet" body="Client comments from the portal and anything you log here will build the revision history." />
            ) : (
              <ol className="px-5 pb-5 flex flex-col gap-2.5">
                {data.feedback.map((fb) => (
                  <li key={fb.id} className={cx('rounded-xl p-3 ring-1 ring-inset', fb.kind === 'internal_note' ? 'bg-white/[0.02] ring-white/[0.05] border-l-2 border-l-ink-3' : fb.author_type === 'client' ? 'bg-accent/[0.05] ring-accent/20' : 'bg-white/[0.025] ring-white/[0.06]', fb.resolved_at && 'opacity-60')}>
                    <div className="flex flex-wrap items-center gap-2 text-[12px]">
                      <span className="font-medium text-ink">{fb.author_name}</span>
                      <Badge tone={fb.kind === 'revision_request' ? 'serious' : fb.kind === 'approval' ? 'good' : fb.kind === 'internal_note' ? 'neutral' : fb.author_type === 'client' ? 'accent' : 'neutral'}>
                        {FEEDBACK_KIND_LABELS[fb.kind]}
                        {fb.revision_number ? ` · round ${fb.revision_number}` : ''}
                      </Badge>
                      {fb.author_type === 'client' && <Badge tone="info">Client</Badge>}
                      {fb.deliverable_title && <span className="text-ink-3">on “{fb.deliverable_title}”</span>}
                      {fb.timecode && <span className="text-ink-3 tabular">@ {fb.timecode}</span>}
                      <span className="text-ink-3 ml-auto">{timeAgo(fb.created_at)}</span>
                    </div>
                    <p className="mt-1.5 text-[13px] text-ink-2 whitespace-pre-wrap">{fb.body}</p>
                    <div className="mt-2 flex items-center gap-3 text-[12px]">
                      {fb.kind !== 'internal_note' && fb.kind !== 'approval' && (
                        <button type="button" className="text-ink-3 hover:text-ink cursor-pointer" onClick={() => feedbackAction.mutate({ fid: fb.id, action: fb.resolved_at ? 'reopen' : 'resolve' })}>
                          {fb.resolved_at ? 'Reopen' : 'Mark resolved'}
                        </button>
                      )}
                      {!fb.visible_to_client && <span className="text-ink-3 inline-flex items-center gap-1"><EyeOff className="size-3" /> team only</span>}
                      {(fb.author_type === 'team' || admin) && (
                        <button
                          type="button"
                          className="text-ink-3 hover:text-bad cursor-pointer ml-auto"
                          onClick={async () => {
                            if (await confirm({ title: 'Delete this entry?', confirmLabel: 'Delete', danger: true })) feedbackAction.mutate({ fid: fb.id, action: 'delete' });
                          }}
                        >
                          Delete
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </Card>
        </div>

        <aside className="flex flex-col gap-4">
          {p.description && (
            <Card className="p-5">
              <h3 className="label-caps mb-2">Brief</h3>
              <p className="text-[13px] text-ink-2 whitespace-pre-wrap leading-relaxed">{p.description}</p>
            </Card>
          )}
          <Card className="p-5 flex flex-col gap-4">
            <div>
              <h3 className="label-caps mb-2">References</h3>
              <LinkChips links={p.reference_links} empty="No reference links." />
            </div>
            <div>
              <h3 className="label-caps mb-2">Assets</h3>
              <LinkChips links={p.asset_links} empty="No asset links." />
            </div>
            <Button size="sm" variant="ghost" icon={<Pencil className="size-3.5" />} onClick={() => setEditing(true)} className="self-start -ml-2">
              Edit links
            </Button>
          </Card>
          <Card>
            <CardHeader title="Tasks" action={<Button size="xs" icon={<Plus className="size-3" />} onClick={() => setTaskOpen(true)}>Add</Button>} />
            {data.tasks.length === 0 ? (
              <p className="px-5 pb-4 text-[12.5px] text-ink-3">No tasks linked to this project.</p>
            ) : (
              <ul className="px-3 pb-3">
                {data.tasks.map((t) => (
                  <li key={t.id} className="flex items-center gap-2.5 px-2 py-1.5">
                    <input type="checkbox" aria-label={`Done: ${t.title}`} className="size-4 accent-[#6c5ce7] cursor-pointer" checked={t.status === 'done'} onChange={(e) => toggleTask.mutate({ id: t.id, done: e.target.checked })} />
                    <span className={cx('flex-1 text-[13px] truncate', t.status === 'done' ? 'text-ink-3 line-through' : 'text-ink')}>{t.title}</span>
                    <DueChip date={t.due_date} today={today} done={t.status === 'done'} compact />
                  </li>
                ))}
              </ul>
            )}
          </Card>
          {admin && (
            <Card>
              <CardHeader title="Invoices" action={<Button size="xs" icon={<Plus className="size-3" />} to={`/invoices/new?client=${p.client_id}&project=${p.id}`}>New</Button>} />
              {data.invoices.length === 0 ? (
                <p className="px-5 pb-4 text-[12.5px] text-ink-3">Not invoiced yet{p.billing_type === 'retainer' ? ' (covered by the retainer).' : '.'}</p>
              ) : (
                <ul className="px-3 pb-3">
                  {data.invoices.map((i) => (
                    <li key={i.id}>
                      <Link to={`/invoices/${i.id}`} className="flex items-center gap-2 px-2 py-2 rounded-lg hover:bg-white/[0.03]">
                        <span className="text-[13px] text-ink flex-1">{i.number}</span>
                        <span className="text-[12.5px] tabular text-ink-2">{formatMoney(i.total_minor, i.currency)}</span>
                        <InvoiceStatusBadge status={i.status} daysOverdue={i.days_overdue} />
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )}
          <Card>
            <CardHeader title="Activity" />
            <ol className="px-5 pb-4 flex flex-col gap-2.5 max-h-96 overflow-y-auto">
              {data.activity.length === 0 && <li className="text-[12.5px] text-ink-3">No activity yet.</li>}
              {data.activity.map((a) => (
                <li key={a.id} className="text-[12.5px]">
                  <p className="text-ink-2 leading-snug">{a.summary}</p>
                  <p className="text-[11px] text-ink-3">
                    {a.actor_name ?? 'System'} · {timeAgo(a.created_at)}
                  </p>
                </li>
              ))}
            </ol>
          </Card>
        </aside>
      </div>

      <ProjectFormDialog open={editing} onClose={() => setEditing(false)} project={p} />
      <DeliverableFormDialog open={deliverable !== null} onClose={() => setDeliverable(null)} projectId={p.id} deliverable={deliverable === 'new' ? null : deliverable} />
      <TaskFormDialog open={taskOpen} onClose={() => setTaskOpen(false)} defaults={{ client_id: p.client_id, project_id: p.id }} />
    </div>
  );
}
