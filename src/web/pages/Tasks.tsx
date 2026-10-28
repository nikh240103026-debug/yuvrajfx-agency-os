import { useEffect, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, CheckCircle2, Download, MoreHorizontal, Pencil, Play, Plus, Repeat, Trash2 } from 'lucide-react';
import { api, errorMessage, qs } from '../lib/api.ts';
import { invalidateAll, useClients, useProjects, useTeam, useToday } from '../lib/queries.ts';
import { Avatar, Badge, Button, Card, CardHeader, EmptyState, ErrorState, Field, IconButton, Input, Notice, PageHeader, Segmented, Select, SelectField, Skeleton, Switch, Tabs, TextField } from '../components/ui.tsx';
import { Dialog, Menu, useConfirm, useToast } from '../components/overlay.tsx';
import { ClientSelect, TaskFormDialog, type TaskRow } from '../components/forms.tsx';
import { DueChip, PriorityBadge } from '../lib/status.tsx';
import { FREQUENCY_LABELS, FREQUENCY_OPTIONS, PLATFORM_OPTIONS, PRIORITY_OPTIONS, PROJECT_TYPE_OPTIONS, WEEKDAY_LABELS, type Frequency } from '../../shared/constants.ts';
import { formatDate } from '../../shared/dates.ts';
import { cx, timeAgo } from '../lib/util.ts';

type View = 'today' | 'upcoming' | 'overdue' | 'open' | 'done';

function QuickAdd() {
  const qc = useQueryClient();
  const toast = useToast();
  const today = useToday();
  const { data: team } = useTeam();
  const [form, setForm] = useState({ title: '', due_date: today, priority: 'medium', assignee_id: '' });
  const add = useMutation({
    mutationFn: () => api.post('/api/tasks', { ...form, assignee_id: form.assignee_id ? Number(form.assignee_id) : null }),
    onSuccess: () => {
      invalidateAll(qc, 'tasks', 'team');
      setForm((f) => ({ ...f, title: '' }));
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (form.title.trim()) add.mutate();
  };
  return (
    <form onSubmit={submit} className="card p-2 flex flex-col md:flex-row gap-2 mb-4">
      <Input aria-label="New task" placeholder="Add a task… (press Enter)" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} className="!border-transparent !bg-transparent focus:!bg-bg-subtle" />
      <div className="flex flex-wrap gap-2">
        <Input aria-label="Due date" type="date" value={form.due_date} onChange={(e) => setForm({ ...form, due_date: e.target.value })} className="!w-40" />
        <Select aria-label="Priority" value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })} className="!w-28">
          {PRIORITY_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
        <Select aria-label="Assignee" value={form.assignee_id} onChange={(e) => setForm({ ...form, assignee_id: e.target.value })} className="!w-36">
          <option value="">Me / nobody</option>
          {(team?.members ?? []).filter((m) => m.status === 'active').map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </Select>
        <Button type="submit" variant="primary" icon={<Plus className="size-4" />} loading={add.isPending}>
          Add
        </Button>
      </div>
    </form>
  );
}

function TaskList({ view }: { view: View }) {
  const qc = useQueryClient();
  const today = useToday();
  const toast = useToast();
  const { confirm } = useConfirm();
  const [editing, setEditing] = useState<TaskRow | null>(null);
  const [personId, setPersonId] = useState('');
  const { data: team } = useTeam();
  const query = qs({ view, assignee_id: personId });
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['tasks', query], queryFn: () => api.get<{ tasks: TaskRow[] }>(`/api/tasks${query}`) });
  const update = useMutation({
    mutationFn: ({ id, ...body }: { id: number; status?: string; due_date?: string }) => api.patch(`/api/tasks/${id}`, body),
    onSuccess: (_r, v) => {
      invalidateAll(qc, 'tasks', 'team', 'project');
      if (v.status === 'done') toast.success('Task done', { label: 'Undo', onClick: () => update.mutate({ id: v.id, status: 'todo' }) });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const remove = useMutation({ mutationFn: (id: number) => api.del(`/api/tasks/${id}`), onSuccess: () => invalidateAll(qc, 'tasks') });
  const tasks = data?.tasks ?? [];
  return (
    <>
      <div className="flex justify-end mb-2">
        <Select aria-label="Assignee filter" value={personId} onChange={(e) => setPersonId(e.target.value)} className="!w-44 !h-8 text-[12.5px]">
          <option value="">Everyone</option>
          {(team?.members ?? []).map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </Select>
      </div>
      <Card>
        {isLoading ? (
          <div className="p-4 flex flex-col gap-2">
            {Array.from({ length: 5 }, (_, i) => (
              <Skeleton key={i} className="h-11" />
            ))}
          </div>
        ) : error ? (
          <ErrorState error={error} onRetry={() => refetch()} />
        ) : tasks.length === 0 ? (
          <EmptyState icon={<CheckCircle2 className="size-5" />} title={view === 'overdue' ? 'Nothing overdue' : view === 'today' ? 'Nothing due today' : view === 'done' ? 'Nothing completed yet' : 'No tasks'} body={view === 'today' ? 'Enjoy the focus time.' : undefined} />
        ) : (
          <ul className="divide-y divide-line">
            {tasks.map((t) => {
              const done = t.status === 'done' || t.status === 'cancelled';
              return (
                <li key={t.id} className={cx('flex items-center gap-3 px-4 sm:px-5 py-3 group', t.is_overdue ? 'bg-bad-dot/[0.035]' : '')}>
                  <input type="checkbox" aria-label={`Mark “${t.title}” done`} className="size-[18px] accent-[#6c5ce7] cursor-pointer shrink-0" checked={t.status === 'done'} onChange={(e) => update.mutate({ id: t.id, status: e.target.checked ? 'done' : 'todo' })} />
                  <button type="button" className="min-w-0 flex-1 text-left cursor-pointer" onClick={() => setEditing(t)}>
                    <span className={cx('block text-[13.5px] truncate', done ? 'text-ink-3 line-through' : 'text-ink')}>{t.title}</span>
                    <span className="flex flex-wrap items-center gap-x-2 text-[12px] text-ink-3">
                      {t.client_name && <span>{t.client_name}</span>}
                      {t.project_name && <span>· {t.project_name}</span>}
                      {t.lead_name && <span>· lead: {t.lead_name}</span>}
                      {t.recurrence_frequency && (
                        <span className="inline-flex items-center gap-1">
                          <Repeat className="size-3" /> {FREQUENCY_LABELS[t.recurrence_frequency as Frequency]}
                        </span>
                      )}
                      {t.source === 'automation' && <span>· from automation</span>}
                    </span>
                  </button>
                  <PriorityBadge priority={t.priority} hideMedium />
                  <DueChip date={t.due_date} today={today} done={done} className="w-28 text-right justify-end hidden sm:inline-flex" />
                  {t.assignee_name ? <Avatar name={t.assignee_name} color={t.assignee_color} size={24} /> : <span className="size-6" />}
                  <Menu
                    label="Task actions"
                    button={(p) => (
                      <IconButton size="sm" label={`Actions for ${t.title}`} className="opacity-60 group-hover:opacity-100" {...p}>
                        <MoreHorizontal className="size-4" />
                      </IconButton>
                    )}
                    items={[
                      { label: 'Edit', icon: <Pencil />, onSelect: () => setEditing(t) },
                      ...(!done
                        ? [
                            { label: 'Move to today', icon: <CalendarClock />, onSelect: () => update.mutate({ id: t.id, due_date: today }) },
                            { label: 'Cancel task', icon: <CheckCircle2 />, onSelect: () => update.mutate({ id: t.id, status: 'cancelled' }) },
                          ]
                        : []),
                      { divider: true as const },
                      {
                        label: 'Delete',
                        icon: <Trash2 />,
                        danger: true,
                        onSelect: async () => {
                          if (await confirm({ title: 'Delete this task?', confirmLabel: 'Delete', danger: true })) remove.mutate(t.id);
                        },
                      },
                    ]}
                  />
                </li>
              );
            })}
          </ul>
        )}
      </Card>
      <TaskFormDialog open={!!editing} onClose={() => setEditing(null)} task={editing} />
    </>
  );
}

type Rule = { id: number; kind: 'task' | 'project'; title: string; frequency: Frequency; interval: number; weekday: number | null; month_day: number | null; start_date: string; end_date: string | null; next_occurrence: string; lead_days: number; template: Record<string, unknown>; active: number; last_generated_at: string | null; upcoming: string[]; generated: number; is_demo: number };

function describe(r: Pick<Rule, 'frequency' | 'interval' | 'weekday' | 'month_day'>): string {
  const every = r.interval > 1 ? `Every ${r.interval} ` : 'Every ';
  if (r.frequency === 'daily') return r.interval > 1 ? `${every}days` : 'Every day';
  if (r.frequency === 'weekly') return `${every}${r.interval > 1 ? 'weeks' : 'week'} on ${WEEKDAY_LABELS[r.weekday ?? 1]}`;
  const day = r.month_day ? `on day ${r.month_day}` : '';
  if (r.frequency === 'monthly') return `${every}${r.interval > 1 ? 'months' : 'month'} ${day}`.trim();
  if (r.frequency === 'quarterly') return `${r.interval > 1 ? `Every ${r.interval} quarters` : 'Every quarter'} ${day}`.trim();
  return `${r.interval > 1 ? `Every ${r.interval} years` : 'Every year'} ${day}`.trim();
}

function RuleDialog({ open, onClose, rule }: { open: boolean; onClose: () => void; rule?: Rule | null }) {
  const qc = useQueryClient();
  const toast = useToast();
  const today = useToday();
  const { data: clients } = useClients();
  const { data: team } = useTeam();
  const { data: projects } = useProjects('?scope=active');
  const tpl = (rule?.template ?? {}) as Record<string, unknown>;
  const [form, setForm] = useState({
    kind: rule?.kind ?? 'task',
    title: rule?.title ?? '',
    frequency: rule?.frequency ?? 'monthly',
    interval: rule?.interval ?? 1,
    weekday: rule?.weekday ?? 1,
    month_day: rule?.month_day ?? 1,
    start_date: rule?.start_date ?? today,
    end_date: rule?.end_date ?? '',
    lead_days: rule?.lead_days ?? 0,
    client_id: (tpl.client_id as number | null) ?? null,
    project_id: (tpl.project_id as number | null) ?? null,
    assignee_id: (tpl.assignee_id as number | null) ?? null,
    editor_id: (tpl.editor_id as number | null) ?? null,
    priority: (tpl.priority as string) ?? 'medium',
    description: (tpl.description as string) ?? '',
    type: (tpl.type as string) ?? 'short_form',
    deadline_offset_days: ((tpl.deadline_offset_days as number | null | undefined) ?? 27) as number | null,
    deliverable_count: ((tpl.deliverables as unknown[]) ?? []).length || 8,
    deliverable_title: ((tpl.deliverables as { title: string }[]) ?? [])[0]?.title.replace(/#\d+$/, '').trim() || 'Short',
    platform: ((tpl.deliverables as { platform?: string }[]) ?? [])[0]?.platform ?? '',
  });
  const save = useMutation({
    mutationFn: () => {
      const template =
        form.kind === 'task'
          ? { client_id: form.client_id, project_id: form.project_id, assignee_id: form.assignee_id, priority: form.priority, description: form.description }
          : {
              client_id: form.client_id,
              type: form.type,
              editor_id: form.editor_id,
              priority: form.priority,
              description: form.description,
              billing_type: 'retainer',
              deadline_offset_days: form.deadline_offset_days,
              deliverables: Array.from({ length: Math.max(0, Math.min(60, form.deliverable_count)) }, (_, i) => ({
                title: `${form.deliverable_title || 'Deliverable'} #${i + 1}`,
                platform: form.platform || null,
                deadline_offset_days: form.deadline_offset_days != null ? Math.round(((i + 1) * form.deadline_offset_days) / Math.max(1, form.deliverable_count)) : null,
              })),
            };
      const body = {
        kind: form.kind,
        title: form.title,
        frequency: form.frequency,
        interval: form.interval,
        weekday: form.frequency === 'weekly' ? form.weekday : null,
        month_day: ['monthly', 'quarterly', 'yearly'].includes(form.frequency) ? form.month_day : null,
        start_date: form.start_date,
        end_date: form.end_date || null,
        lead_days: form.lead_days,
        template,
      };
      return rule ? api.patch(`/api/recurring/${rule.id}`, body) : api.post<{ generated: { tasks: number; projects: number } }>('/api/recurring', body);
    },
    onSuccess: (r) => {
      invalidateAll(qc, 'recurring', 'tasks', 'projects');
      const g = (r as { generated?: { tasks: number; projects: number } }).generated;
      toast.success(rule ? 'Recurring rule saved' : `Recurring ${form.kind} set up${g && g.tasks + g.projects ? ` · ${g.tasks + g.projects} created now` : ''}`);
      onClose();
    },
  });
  const err = save.error ? errorMessage(save.error) : null;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={rule ? 'Edit recurring rule' : 'New recurring task or project'}
      description="Examples: monthly invoicing, weekly client updates, project handoffs, or a fresh monthly content pack for a retainer client."
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()} disabled={!form.title.trim() || (form.kind === 'project' && !form.client_id)}>
            {rule ? 'Save' : 'Create rule'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {!rule && <Segmented label="Creates" value={form.kind} onChange={(v) => setForm({ ...form, kind: v })} options={[{ value: 'task', label: 'A task' }, { value: 'project', label: 'A project with deliverables' }]} />}
        <TextField label={form.kind === 'task' ? 'Task title' : 'Project name'} required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} hint="Use {{month}}, {{month_short}}, {{quarter}}, {{year}} or {{date}} — e.g. “Send {{month}} retainer invoices”." />
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
          <SelectField label="Repeats" value={form.frequency} onChange={(e) => setForm({ ...form, frequency: e.target.value as Frequency })}>
            {FREQUENCY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </SelectField>
          <TextField label="Every" type="number" min={1} max={52} value={form.interval} onChange={(e) => setForm({ ...form, interval: Math.max(1, Number(e.target.value) || 1) })} />
          {form.frequency === 'weekly' && (
            <SelectField label="On" value={form.weekday} onChange={(e) => setForm({ ...form, weekday: Number(e.target.value) })}>
              {WEEKDAY_LABELS.map((d, i) => (
                <option key={d} value={i}>
                  {d}
                </option>
              ))}
            </SelectField>
          )}
          {['monthly', 'quarterly', 'yearly'].includes(form.frequency) && <TextField label="Day of month" type="number" min={1} max={31} value={form.month_day} onChange={(e) => setForm({ ...form, month_day: Math.min(31, Math.max(1, Number(e.target.value) || 1)) })} hint="31 = last day" />}
          <TextField label="Create days early" type="number" min={0} max={60} value={form.lead_days} onChange={(e) => setForm({ ...form, lead_days: Math.max(0, Number(e.target.value) || 0) })} />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <TextField label="Starts" type="date" value={form.start_date} onChange={(e) => setForm({ ...form, start_date: e.target.value })} />
          <TextField label="Ends" optional type="date" value={form.end_date} onChange={(e) => setForm({ ...form, end_date: e.target.value })} />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Client" required={form.kind === 'project'} optional={form.kind === 'task'}>
            <ClientSelect value={form.client_id} clients={clients?.clients ?? []} placeholder={form.kind === 'task' ? 'None' : 'Choose…'} onChange={(id) => setForm({ ...form, client_id: id, project_id: null })} />
          </Field>
          {form.kind === 'task' ? (
            <Field label="Assignee" optional>
              <Select value={form.assignee_id ?? ''} onChange={(e) => setForm({ ...form, assignee_id: e.target.value ? Number(e.target.value) : null })}>
                <option value="">Nobody</option>
                {(team?.members ?? []).map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </Select>
            </Field>
          ) : (
            <SelectField label="Project type" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
              {PROJECT_TYPE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </SelectField>
          )}
          {form.kind === 'task' && (
            <Field label="Project" optional>
              <Select value={form.project_id ?? ''} onChange={(e) => setForm({ ...form, project_id: e.target.value ? Number(e.target.value) : null })}>
                <option value="">None</option>
                {(projects?.projects ?? []).filter((p) => !form.client_id || p.client_id === form.client_id).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <SelectField label="Priority" value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })}>
            {PRIORITY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </SelectField>
        </div>
        {form.kind === 'project' && (
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
            <Field label="Lead editor" optional>
              <Select value={form.editor_id ?? ''} onChange={(e) => setForm({ ...form, editor_id: e.target.value ? Number(e.target.value) : null })}>
                <option value="">None</option>
                {(team?.members ?? []).map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </Select>
            </Field>
            <TextField label="Deliverables" type="number" min={0} max={60} value={form.deliverable_count} onChange={(e) => setForm({ ...form, deliverable_count: Math.max(0, Number(e.target.value) || 0) })} />
            <TextField label="Named" value={form.deliverable_title} onChange={(e) => setForm({ ...form, deliverable_title: e.target.value })} />
            <TextField label="Deadline after (days)" type="number" min={0} max={365} value={form.deadline_offset_days ?? ''} onChange={(e) => setForm({ ...form, deadline_offset_days: e.target.value === '' ? null : Number(e.target.value) })} />
            <SelectField label="Platform" value={form.platform} onChange={(e) => setForm({ ...form, platform: e.target.value })}>
              <option value="">—</option>
              {PLATFORM_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </SelectField>
          </div>
        )}
        <Notice tone="info">Preview: {describe(form)}{form.lead_days ? `, created ${form.lead_days} day${form.lead_days > 1 ? 's' : ''} early` : ''}. If the app was closed for a while, only the latest missed occurrence is created — no flood of stale items.</Notice>
        {err && <Notice tone="bad">{err}</Notice>}
      </div>
    </Dialog>
  );
}

function RecurringRules() {
  const qc = useQueryClient();
  const toast = useToast();
  const { confirm } = useConfirm();
  const [editing, setEditing] = useState<Rule | null | 'new'>(null);
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['recurring'], queryFn: () => api.get<{ rules: Rule[] }>('/api/recurring') });
  const patch = useMutation({ mutationFn: ({ id, ...b }: { id: number; active: boolean }) => api.patch(`/api/recurring/${id}`, b), onSuccess: () => invalidateAll(qc, 'recurring') });
  const run = useMutation({
    mutationFn: (id: number) => api.post<{ generated: { tasks: number; projects: number; skipped: number } }>(`/api/recurring/${id}/run`),
    onSuccess: (r) => {
      invalidateAll(qc, 'recurring', 'tasks', 'projects');
      const n = r.generated.tasks + r.generated.projects;
      toast.info(n ? `${n} created` : 'Nothing due yet — the next occurrence is created when it comes up.');
    },
  });
  const remove = useMutation({ mutationFn: (id: number) => api.del(`/api/recurring/${id}`), onSuccess: () => invalidateAll(qc, 'recurring') });
  return (
    <>
      <Card>
        <CardHeader title="Recurring tasks & projects" description="Checked automatically every 15 minutes while the app runs." action={<Button size="sm" variant="primary" icon={<Plus className="size-3.5" />} onClick={() => setEditing('new')}>New rule</Button>} />
        {isLoading ? (
          <div className="p-5">
            <Skeleton className="h-16" />
          </div>
        ) : error ? (
          <ErrorState error={error} onRetry={() => refetch()} />
        ) : (data?.rules ?? []).length === 0 ? (
          <EmptyState compact icon={<Repeat className="size-5" />} title="No recurring work yet" body="Set up monthly invoicing, weekly updates or a monthly content pack once, and it appears on time." />
        ) : (
          <ul className="divide-y divide-line">
            {data!.rules.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                <Switch label={r.active ? 'Pause rule' : 'Resume rule'} checked={!!r.active} onChange={(v) => patch.mutate({ id: r.id, active: v })} />
                <div className="min-w-0 flex-1">
                  <div className="text-[13.5px] text-ink">
                    {r.title} <Badge tone={r.kind === 'project' ? 'accent' : 'neutral'}>{r.kind}</Badge> {r.is_demo ? <Badge tone="warn">Demo</Badge> : null}
                  </div>
                  <div className="text-[12px] text-ink-3">
                    {describe(r)} · next {r.upcoming.length ? r.upcoming.map((d) => formatDate(d)).join(', ') : formatDate(r.next_occurrence)} · {r.generated} created so far
                    {r.last_generated_at ? ` · checked ${timeAgo(r.last_generated_at)}` : ''}
                  </div>
                </div>
                <Button size="xs" variant="ghost" icon={<Play className="size-3" />} onClick={() => run.mutate(r.id)}>
                  Run now
                </Button>
                <Menu
                  label="Rule actions"
                  button={(p) => (
                    <IconButton size="sm" label="Rule actions" {...p}>
                      <MoreHorizontal className="size-4" />
                    </IconButton>
                  )}
                  items={[
                    { label: 'Edit', icon: <Pencil />, onSelect: () => setEditing(r) },
                    {
                      label: 'Delete rule',
                      icon: <Trash2 />,
                      danger: true,
                      onSelect: async () => {
                        if (await confirm({ title: 'Delete this rule?', body: 'Tasks and projects it already created are kept.', confirmLabel: 'Delete', danger: true })) remove.mutate(r.id);
                      },
                    },
                  ]}
                />
              </li>
            ))}
          </ul>
        )}
      </Card>
      {editing !== null && <RuleDialog open onClose={() => setEditing(null)} rule={editing === 'new' ? null : editing} />}
    </>
  );
}

export default function TasksPage() {
  const [params, setParams] = useSearchParams();
  const tab = (params.get('view') as View | 'recurring') ?? 'today';
  const [creating, setCreating] = useState(false);
  const { data } = useQuery({ queryKey: ['tasks', 'counts'], queryFn: () => api.get<{ counts: Record<string, number | null> }>('/api/tasks?view=open') });
  useEffect(() => {
    if (params.get('new') === '1') {
      setCreating(true);
      params.delete('new');
      setParams(params, { replace: true });
    }
  }, [params, setParams]);
  const c = data?.counts ?? {};
  const setTab = (v: string) => {
    const next = new URLSearchParams(params);
    next.set('view', v);
    setParams(next, { replace: true });
  };
  return (
    <div>
      <PageHeader
        title="Tasks"
        description="Follow-ups, admin and production to-dos — including the ones your recurring rules create."
        actions={
          <>
            <Button href="/api/tasks/export.csv" download icon={<Download className="size-4" />}>
              Export
            </Button>
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
              New task
            </Button>
          </>
        }
      />
      <Tabs
        label="Task views"
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'today', label: 'Today', count: c.today },
          { value: 'upcoming', label: 'Upcoming', count: c.upcoming },
          { value: 'overdue', label: <span className={(c.overdue ?? 0) > 0 ? 'text-bad' : ''}>Overdue</span>, count: c.overdue },
          { value: 'open', label: 'All open', count: c.open },
          { value: 'done', label: 'Done' },
          { value: 'recurring', label: <span className="inline-flex items-center gap-1"><Repeat className="size-3.5" />Recurring</span> },
        ]}
      />
      {tab === 'recurring' ? (
        <RecurringRules />
      ) : (
        <>
          {tab !== 'done' && <QuickAdd />}
          <TaskList view={tab} />
        </>
      )}
      <TaskFormDialog open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}
