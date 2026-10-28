import { useEffect, useMemo, useState, type DragEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, Download, FolderKanban, Kanban, Link2, List, MessageSquare, MoreHorizontal, Plus, RotateCcw, Search } from 'lucide-react';
import { api, errorMessage, qs } from '../lib/api.ts';
import { invalidateAll, useClients, useIsAdmin, useTeam, useToday, type DeliverableRow, type ProjectRow } from '../lib/queries.ts';
import { Avatar, Badge, Button, Card, DemoBadge, EmptyState, ErrorState, IconButton, Input, PageHeader, Segmented, Select, Skeleton } from '../components/ui.tsx';
import { Menu, useToast } from '../components/overlay.tsx';
import { DeliverableFormDialog, ProjectFormDialog } from '../components/forms.tsx';
import { DueChip, PriorityBadge, StageBadge, stageColor } from '../lib/status.tsx';
import { PLATFORM_LABELS, PROJECT_STATUS_LABELS, PROJECT_TYPE_LABELS, PROJECT_TYPE_OPTIONS, STAGES, STAGE_LABELS, type ProjectStatus, type Stage } from '../../shared/constants.ts';
import { addDays } from '../../shared/dates.ts';
import { formatMoney } from '../../shared/money.ts';
import { cx, safeHref, useDebounced, useLocalPref } from '../lib/util.ts';
import CalendarView from './Calendar.tsx';

type View = 'board' | 'list' | 'calendar';
type BoardMode = 'deliverables' | 'projects';

function Filters({ q, setQ, clientId, setClientId, personId, setPersonId, overdue, setOverdue, extra }: { q: string; setQ: (v: string) => void; clientId: string; setClientId: (v: string) => void; personId: string; setPersonId: (v: string) => void; overdue: boolean; setOverdue: (v: boolean) => void; extra?: React.ReactNode }) {
  const { data: clients } = useClients();
  const { data: team } = useTeam();
  return (
    <div className="flex flex-col md:flex-row md:items-center gap-2 mb-4">
      <div className="relative md:max-w-64 w-full">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-ink-3" aria-hidden />
        <Input aria-label="Search" placeholder="Search titles, projects, clients…" className="!pl-9" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <Select aria-label="Client" value={clientId} onChange={(e) => setClientId(e.target.value)} className="md:!w-48">
        <option value="">All clients</option>
        {(clients?.clients ?? []).map((c) => (
          <option key={c.id} value={c.id}>
            {c.company || c.name}
          </option>
        ))}
      </Select>
      <Select aria-label="Person" value={personId} onChange={(e) => setPersonId(e.target.value)} className="md:!w-44">
        <option value="">Everyone</option>
        {(team?.members ?? []).map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
          </option>
        ))}
      </Select>
      {extra}
      <button
        type="button"
        aria-pressed={overdue}
        onClick={() => setOverdue(!overdue)}
        className={cx('inline-flex items-center gap-1.5 h-9 px-3 rounded-lg text-[12.5px] font-medium ring-1 ring-inset cursor-pointer whitespace-nowrap', overdue ? 'bg-bad-dot/14 text-bad ring-bad-dot/30' : 'text-ink-2 ring-white/[0.08] hover:bg-white/[0.04]')}
      >
        <span className={cx('size-1.5 rounded-full', overdue ? 'bg-bad-dot' : 'bg-ink-3')} aria-hidden /> Overdue only
      </button>
    </div>
  );
}

function DeliverableCard({ d, today, onOpen, onMove, dragging, onDragStart, onDragEnd }: { d: DeliverableRow; today: string; onOpen: () => void; onMove: (s: Stage) => void; dragging: boolean; onDragStart: (e: DragEvent) => void; onDragEnd: () => void }) {
  return (
    <article
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={cx(
        'group rounded-xl bg-surface-2 ring-1 ring-inset p-3 cursor-grab active:cursor-grabbing transition-[box-shadow,opacity,transform] hover:ring-white/[0.14] hover:shadow-[0_8px_24px_-12px_rgb(0_0_0/0.8)]',
        d.is_overdue ? 'ring-bad-dot/40' : 'ring-white/[0.07]',
        dragging && 'opacity-40 rotate-[0.6deg]',
      )}
    >
      <div className="flex items-start gap-2">
        <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left cursor-pointer">
          <h3 className="text-[13px] font-medium text-ink leading-snug line-clamp-2">{d.title}</h3>
          <p className="mt-0.5 text-[11.5px] text-ink-3 truncate">
            {d.client_name} · {d.project_name}
          </p>
        </button>
        <Menu
          label="Move to stage"
          button={(p) => (
            <IconButton label={`Move “${d.title}”`} size="sm" className="opacity-60 group-hover:opacity-100 focus:opacity-100 -mr-1 -mt-1" {...p}>
              <MoreHorizontal className="size-4" />
            </IconButton>
          )}
          items={[{ heading: 'Move to' }, ...STAGES.filter((s) => s !== d.status).map((s) => ({ label: STAGE_LABELS[s], icon: <span className="block size-2 rounded-full" style={{ background: stageColor(s) }} />, onSelect: () => onMove(s) })), { divider: true as const }, { label: 'Open details', onSelect: onOpen }]}
        />
      </div>
      <div className="mt-2.5 flex items-center gap-2 flex-wrap">
        <DueChip date={d.deadline} today={today} done={d.status === 'delivered'} compact />
        {d.platform && <span className="text-[11px] text-ink-3">{PLATFORM_LABELS[d.platform as keyof typeof PLATFORM_LABELS]}</span>}
        <span className="ml-auto flex items-center gap-1.5">
          {d.revision_count > 0 && (
            <Badge tone={d.revision_count >= 3 ? 'serious' : 'neutral'} title={`${d.revision_count} revision round(s)`}>
              R{d.revision_count}
            </Badge>
          )}
          {d.open_client_feedback > 0 && (
            <span className="inline-flex items-center gap-0.5 text-[11px] text-warn" title="Unresolved client feedback">
              <MessageSquare className="size-3.5" aria-hidden />
              {d.open_client_feedback}
            </span>
          )}
          {safeHref(d.review_url) && (
            <a href={safeHref(d.review_url)} target="_blank" rel="noreferrer noopener" onClick={(e) => e.stopPropagation()} className="text-ink-3 hover:text-accent-ink" title="Open review link">
              <Link2 className="size-3.5" />
            </a>
          )}
          {d.assignee_name && <Avatar name={d.assignee_name} color={d.assignee_color} size={20} />}
        </span>
      </div>
      {d.is_demo ? (
        <div className="mt-2">
          <DemoBadge />
        </div>
      ) : null}
    </article>
  );
}

function DeliverableBoard({ q, clientId, personId, overdue }: { q: string; clientId: string; personId: string; overdue: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const today = useToday();
  const [open, setOpen] = useState<DeliverableRow | null>(null);
  const [dragId, setDragId] = useState<number | null>(null);
  const [over, setOver] = useState<Stage | null>(null);
  const query = qs({ q, client_id: clientId, assignee_id: personId, overdue, delivered_since: addDays(today, -21) });
  const key = ['deliverables', 'board', query];
  const { data, isLoading, error, refetch } = useQuery({ queryKey: key, queryFn: () => api.get<{ deliverables: DeliverableRow[] }>(`/api/deliverables${query}`) });
  const move = useMutation({
    mutationFn: ({ id, status }: { id: number; status: Stage }) => api.patch(`/api/deliverables/${id}`, { status }),
    onMutate: async ({ id, status }) => {
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<{ deliverables: DeliverableRow[] }>(key);
      qc.setQueryData<{ deliverables: DeliverableRow[] }>(key, (old) => old && { deliverables: old.deliverables.map((d) => (d.id === id ? { ...d, status, revision_count: status === 'revisions' && d.status !== 'revisions' ? d.revision_count + 1 : d.revision_count, is_overdue: status === 'delivered' ? 0 : d.is_overdue } : d)) });
      return { prev };
    },
    onError: (e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(key, ctx.prev);
      toast.error(errorMessage(e));
    },
    onSuccess: (_r, v) => {
      const d = data?.deliverables.find((x) => x.id === v.id);
      toast.success(`Moved to ${STAGE_LABELS[v.status]}${v.status === 'revisions' ? ' · revision counted' : ''}`, d && d.status !== v.status ? { label: 'Undo', onClick: () => move.mutate({ id: v.id, status: d.status as Stage }) } : undefined);
    },
    onSettled: () => invalidateAll(qc, 'deliverables', 'projects', 'project', 'team'),
  });
  const columns = useMemo(() => {
    const map = new Map<Stage, DeliverableRow[]>(STAGES.map((s) => [s, []]));
    for (const d of data?.deliverables ?? []) map.get(d.status as Stage)?.push(d);
    return map;
  }, [data]);
  if (error) return <ErrorState error={error} onRetry={() => refetch()} />;
  const onDrop = (stage: Stage) => (e: DragEvent) => {
    e.preventDefault();
    setOver(null);
    const id = Number(e.dataTransfer.getData('text/plain'));
    const d = data?.deliverables.find((x) => x.id === id);
    if (d && d.status !== stage) move.mutate({ id, status: stage });
  };
  return (
    <>
      <div className="-mx-4 sm:-mx-6 px-4 sm:px-6 overflow-x-auto pb-4">
        <div className="grid grid-flow-col auto-cols-[minmax(264px,1fr)] gap-3 min-w-max xl:min-w-0">
          {STAGES.map((stage) => {
            const items = columns.get(stage) ?? [];
            return (
              <section
                key={stage}
                aria-label={STAGE_LABELS[stage]}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                  if (over !== stage) setOver(stage);
                }}
                onDragLeave={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(null);
                }}
                onDrop={onDrop(stage)}
                className={cx('flex flex-col rounded-2xl bg-white/[0.02] ring-1 ring-inset transition-colors min-h-[420px]', over === stage ? 'ring-accent/50 bg-accent/[0.05]' : 'ring-white/[0.05]')}
              >
                <header className="flex items-center gap-2 px-3 pt-3 pb-2">
                  <span className="size-2 rounded-full" style={{ background: stageColor(stage) }} aria-hidden />
                  <h2 className="text-[12.5px] font-semibold text-ink-2">{STAGE_LABELS[stage]}</h2>
                  <span className="ml-auto text-[11.5px] tabular text-ink-3">{items.length}</span>
                </header>
                <div className="flex flex-col gap-2 p-2 pt-0 flex-1">
                  {isLoading ? (
                    <>
                      <Skeleton className="h-20" />
                      <Skeleton className="h-20" />
                    </>
                  ) : items.length === 0 ? (
                    <p className="px-2 py-6 text-center text-[12px] text-ink-3">{over === stage ? 'Drop here' : stage === 'delivered' ? 'Delivered in the last 3 weeks shows here' : 'Nothing here'}</p>
                  ) : (
                    items.map((d) => (
                      <DeliverableCard
                        key={d.id}
                        d={d}
                        today={today}
                        dragging={dragId === d.id}
                        onOpen={() => setOpen(d)}
                        onMove={(s) => move.mutate({ id: d.id, status: s })}
                        onDragStart={(e) => {
                          e.dataTransfer.setData('text/plain', String(d.id));
                          e.dataTransfer.effectAllowed = 'move';
                          setDragId(d.id);
                        }}
                        onDragEnd={() => setDragId(null)}
                      />
                    ))
                  )}
                </div>
              </section>
            );
          })}
        </div>
      </div>
      <DeliverableFormDialog open={!!open} onClose={() => setOpen(null)} deliverable={open} />
    </>
  );
}

const PROJECT_COLUMNS: ProjectStatus[] = [...STAGES, 'on_hold'];

function ProjectBoard({ q, clientId, personId, overdue }: { q: string; clientId: string; personId: string; overdue: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const today = useToday();
  const navigate = useNavigate();
  const [over, setOver] = useState<string | null>(null);
  const query = qs({ scope: 'all', q, client_id: clientId, editor_id: personId, overdue });
  const key = ['projects', 'board', query];
  const { data, isLoading, error, refetch } = useQuery({ queryKey: key, queryFn: () => api.get<{ projects: ProjectRow[] }>(`/api/projects${query}`) });
  const move = useMutation({
    mutationFn: ({ id, status }: { id: number; status: ProjectStatus }) => api.patch(`/api/projects/${id}`, { status }),
    onMutate: async ({ id, status }) => {
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<{ projects: ProjectRow[] }>(key);
      qc.setQueryData<{ projects: ProjectRow[] }>(key, (old) => old && { projects: old.projects.map((p) => (p.id === id ? { ...p, status } : p)) });
      return { prev };
    },
    onError: (e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(key, ctx.prev);
      toast.error(errorMessage(e));
    },
    onSettled: () => invalidateAll(qc, 'projects', 'project'),
  });
  if (error) return <ErrorState error={error} onRetry={() => refetch()} />;
  const recent = addDays(today, -21);
  const projects = (data?.projects ?? []).filter((p) => p.status !== 'cancelled' && (p.status !== 'delivered' || (p.completed_at ?? '').slice(0, 10) >= recent));
  return (
    <div className="-mx-4 sm:-mx-6 px-4 sm:px-6 overflow-x-auto pb-4">
      <div className="grid grid-flow-col auto-cols-[minmax(264px,1fr)] gap-3 min-w-max">
        {PROJECT_COLUMNS.map((status) => {
          const items = projects.filter((p) => p.status === status);
          return (
            <section
              key={status}
              aria-label={PROJECT_STATUS_LABELS[status]}
              onDragOver={(e) => {
                e.preventDefault();
                setOver(status);
              }}
              onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setOver(null)}
              onDrop={(e) => {
                e.preventDefault();
                setOver(null);
                const id = Number(e.dataTransfer.getData('text/plain'));
                const p = projects.find((x) => x.id === id);
                if (p && p.status !== status) move.mutate({ id, status });
              }}
              className={cx('flex flex-col rounded-2xl bg-white/[0.02] ring-1 ring-inset min-h-[360px]', over === status ? 'ring-accent/50 bg-accent/[0.05]' : 'ring-white/[0.05]')}
            >
              <header className="flex items-center gap-2 px-3 pt-3 pb-2">
                <span className="size-2 rounded-full" style={{ background: status === 'on_hold' ? 'var(--color-warn)' : stageColor(status) }} aria-hidden />
                <h2 className="text-[12.5px] font-semibold text-ink-2">{PROJECT_STATUS_LABELS[status]}</h2>
                <span className="ml-auto text-[11.5px] tabular text-ink-3">{items.length}</span>
              </header>
              <div className="flex flex-col gap-2 p-2 pt-0">
                {isLoading && <Skeleton className="h-24" />}
                {items.map((p) => {
                  const pct = p.deliverable_count ? p.delivered_count / p.deliverable_count : 0;
                  return (
                    <article
                      key={p.id}
                      draggable
                      onDragStart={(e) => e.dataTransfer.setData('text/plain', String(p.id))}
                      onClick={() => navigate(`/projects/${p.id}`)}
                      className={cx('rounded-xl bg-surface-2 ring-1 ring-inset p-3 cursor-pointer hover:ring-white/[0.14]', p.is_overdue || p.overdue_deliverables ? 'ring-bad-dot/40' : 'ring-white/[0.07]')}
                    >
                      <h3 className="text-[13px] font-medium text-ink leading-snug">{p.name}</h3>
                      <p className="text-[11.5px] text-ink-3 truncate">
                        {p.client_name} · {PROJECT_TYPE_LABELS[p.type as keyof typeof PROJECT_TYPE_LABELS]}
                      </p>
                      <div className="mt-2.5 h-1 rounded-full bg-white/[0.06] overflow-hidden" aria-label={`${p.delivered_count} of ${p.deliverable_count} delivered`}>
                        <div className="h-full rounded-full bg-series-1" style={{ width: `${pct * 100}%` }} />
                      </div>
                      <div className="mt-2 flex items-center gap-2">
                        <DueChip date={p.deadline} today={today} done={p.status === 'delivered'} compact />
                        <span className="text-[11px] text-ink-3 tabular">
                          {p.delivered_count}/{p.deliverable_count}
                        </span>
                        {p.overdue_deliverables > 0 && <Badge tone="bad">{p.overdue_deliverables} late</Badge>}
                        <span className="ml-auto">{p.editor_name && <Avatar name={p.editor_name} color={p.editor_color} size={20} />}</span>
                      </div>
                    </article>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function ProjectList({ q, clientId, personId, overdue }: { q: string; clientId: string; personId: string; overdue: boolean }) {
  const admin = useIsAdmin();
  const today = useToday();
  const navigate = useNavigate();
  const [scope, setScope] = useLocalPref<'active' | 'done' | 'all' | 'archived'>('projects-scope', 'active');
  const [type, setType] = useState('');
  const query = qs({ scope, q, client_id: clientId, editor_id: personId, overdue, type });
  const { data, isLoading, error, refetch, isFetching } = useQuery({ queryKey: ['projects', 'list', query], queryFn: () => api.get<{ projects: ProjectRow[] }>(`/api/projects${query}`) });
  const qc = useQueryClient();
  const restore = useMutation({ mutationFn: (id: number) => api.post(`/api/projects/${id}/restore`), onSuccess: () => invalidateAll(qc, 'projects') });
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <Segmented label="Scope" value={scope} onChange={setScope} options={[{ value: 'active', label: 'In production' }, { value: 'done', label: 'Delivered' }, { value: 'all', label: 'All' }, { value: 'archived', label: 'Archived' }]} />
        <Select aria-label="Type" value={type} onChange={(e) => setType(e.target.value)} className="!w-auto !h-8 text-[12.5px]">
          <option value="">All types</option>
          {PROJECT_TYPE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      </div>
      <Card className={cx('overflow-hidden', isFetching && !isLoading && 'opacity-70')}>
        {isLoading ? (
          <div className="p-4 flex flex-col gap-2">
            {Array.from({ length: 5 }, (_, i) => (
              <Skeleton key={i} className="h-12" />
            ))}
          </div>
        ) : error ? (
          <ErrorState error={error} onRetry={() => refetch()} />
        ) : (data?.projects ?? []).length === 0 ? (
          <EmptyState icon={<FolderKanban className="size-5" />} title="No projects here" body="Try another filter, or create a project." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead className="text-left text-[12px] text-ink-3 border-b border-line">
                <tr>
                  <th className="py-2.5 px-5 font-medium">Project</th>
                  <th className="py-2.5 px-3 font-medium">Status</th>
                  <th className="py-2.5 px-3 font-medium">Priority</th>
                  <th className="py-2.5 px-3 font-medium">Editor</th>
                  <th className="py-2.5 px-3 font-medium">Progress</th>
                  <th className="py-2.5 px-3 font-medium">Deadline</th>
                  {admin && <th className="py-2.5 px-5 font-medium text-right">Price</th>}
                </tr>
              </thead>
              <tbody>
                {data!.projects.map((p) => (
                  <tr key={p.id} className="border-b border-line last:border-0 hover:bg-white/[0.025] cursor-pointer" onClick={() => navigate(`/projects/${p.id}`)}>
                    <td className="py-3 px-5">
                      <Link to={`/projects/${p.id}`} onClick={(e) => e.stopPropagation()} className="font-medium text-ink hover:underline">
                        {p.name}
                      </Link>{' '}
                      {p.is_demo ? <DemoBadge /> : null}
                      <div className="text-[12px] text-ink-3">
                        {p.client_name} · {PROJECT_TYPE_LABELS[p.type as keyof typeof PROJECT_TYPE_LABELS]}
                      </div>
                    </td>
                    <td className="py-3 px-3">
                      <StageBadge stage={p.status} />
                    </td>
                    <td className="py-3 px-3">
                      <PriorityBadge priority={p.priority} />
                    </td>
                    <td className="py-3 px-3">{p.editor_name ? <span className="inline-flex items-center gap-2"><Avatar name={p.editor_name} color={p.editor_color} size={20} /> <span className="text-ink-2">{p.editor_name}</span></span> : <span className="text-ink-3">—</span>}</td>
                    <td className="py-3 px-3 w-40">
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 flex-1 rounded-full bg-white/[0.06] overflow-hidden">
                          <div className="h-full rounded-full bg-series-1" style={{ width: `${p.deliverable_count ? (p.delivered_count / p.deliverable_count) * 100 : 0}%` }} />
                        </div>
                        <span className="text-[11.5px] text-ink-3 tabular">
                          {p.delivered_count}/{p.deliverable_count}
                        </span>
                      </div>
                      {p.overdue_deliverables > 0 && <div className="text-[11.5px] text-bad mt-0.5">{p.overdue_deliverables} deliverable{p.overdue_deliverables > 1 ? 's' : ''} overdue</div>}
                    </td>
                    <td className="py-3 px-3">
                      <DueChip date={p.deadline} today={today} done={p.status === 'delivered' || p.status === 'cancelled'} />
                    </td>
                    {admin && (
                      <td className="py-3 px-5 text-right tabular text-ink-2">
                        {scope === 'archived' ? (
                          <Button size="xs" icon={<RotateCcw className="size-3" />} onClick={(e) => { e.stopPropagation(); restore.mutate(p.id); }}>
                            Restore
                          </Button>
                        ) : p.price_minor ? (
                          formatMoney(p.price_minor, p.currency)
                        ) : (
                          <span className="text-ink-3">{p.billing_type === 'retainer' ? 'Retainer' : '—'}</span>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

export default function ProjectsPage() {
  const admin = useIsAdmin();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [prefView, setPrefView] = useLocalPref<View>('projects-view', 'board');
  const view = (params.get('view') as View) ?? prefView;
  const [mode, setMode] = useLocalPref<BoardMode>('board-mode', 'deliverables');
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const [clientId, setClientId] = useState('');
  const [personId, setPersonId] = useState('');
  const [overdue, setOverdue] = useState(params.get('overdue') === '1');
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    if (params.get('new') === '1') {
      setCreating(true);
      params.delete('new');
      setParams(params, { replace: true });
    }
  }, [params, setParams]);
  const setView = (v: View) => {
    setPrefView(v);
    const next = new URLSearchParams(params);
    next.set('view', v);
    setParams(next, { replace: true });
  };
  return (
    <div>
      <PageHeader
        title="Projects"
        description="Production for every client: drag deliverables through the stages, or switch to the list and calendar."
        actions={
          <>
            <Segmented
              label="View"
              value={view}
              onChange={setView}
              options={[
                { value: 'board', label: <span className="inline-flex items-center gap-1.5"><Kanban className="size-3.5" />Board</span> },
                { value: 'list', label: <span className="inline-flex items-center gap-1.5"><List className="size-3.5" />List</span> },
                { value: 'calendar', label: <span className="inline-flex items-center gap-1.5"><CalendarDays className="size-3.5" />Calendar</span> },
              ]}
            />
            {admin && (
              <>
                <Button href="/api/projects/export.csv" download icon={<Download className="size-4" />}>
                  Export
                </Button>
                <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
                  New project
                </Button>
              </>
            )}
          </>
        }
      />
      {view !== 'calendar' && (
        <Filters
          q={q}
          setQ={setQ}
          clientId={clientId}
          setClientId={setClientId}
          personId={personId}
          setPersonId={setPersonId}
          overdue={overdue}
          setOverdue={setOverdue}
          extra={view === 'board' ? <Segmented label="Board shows" value={mode} onChange={setMode} options={[{ value: 'deliverables', label: 'Deliverables' }, { value: 'projects', label: 'Projects' }]} /> : undefined}
        />
      )}
      {view === 'board' && mode === 'deliverables' && <DeliverableBoard q={dq} clientId={clientId} personId={personId} overdue={overdue} />}
      {view === 'board' && mode === 'projects' && <ProjectBoard q={dq} clientId={clientId} personId={personId} overdue={overdue} />}
      {view === 'list' && <ProjectList q={dq} clientId={clientId} personId={personId} overdue={overdue} />}
      {view === 'calendar' && <CalendarView embedded />}
      <ProjectFormDialog open={creating} onClose={() => setCreating(false)} onSaved={(id) => navigate(`/projects/${id}`)} />
    </div>
  );
}
