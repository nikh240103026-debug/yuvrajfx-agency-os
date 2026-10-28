import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, MoreHorizontal, Pencil, Plus, Trash2, UsersRound } from 'lucide-react';
import { api, errorMessage } from '../lib/api.ts';
import { invalidateAll, useIsAdmin, useTeam, useToday, type TeamMember } from '../lib/queries.ts';
import { Avatar, Badge, Button, Card, DemoBadge, EmptyState, ErrorState, IconButton, Meter, Notice, PageHeader, Skeleton } from '../components/ui.tsx';
import { Dialog, Menu, useConfirm, useToast } from '../components/overlay.tsx';
import { TeamMemberDialog } from '../components/forms.tsx';
import { DueChip, StageBadge } from '../lib/status.tsx';
import { COST_UNIT_LABELS } from '../../shared/constants.ts';
import { formatMoney } from '../../shared/money.ts';
import { cx } from '../lib/util.ts';

function MemberDrawer({ member, onClose }: { member: TeamMember | null; onClose: () => void }) {
  const today = useToday();
  const { data } = useQuery({
    queryKey: ['team', member?.id],
    queryFn: () => api.get<{ deliverables: { id: number; title: string; status: string; deadline: string | null; estimated_hours: number | null; project_id: number; project_name: string; client_name: string }[]; tasks: { id: number; title: string; status: string; due_date: string | null }[] }>(`/api/team/${member!.id}`),
    enabled: !!member,
  });
  return (
    <Dialog open={!!member} onClose={onClose} variant="drawer" title={member?.name ?? ''} description={member ? `${member.title} · ${member.capacity_hours}h/week capacity` : undefined}>
      {member && (
        <div className="flex flex-col gap-5">
          <section>
            <h3 className="text-[13.5px] font-semibold mb-2">Open deliverables ({data?.deliverables.length ?? '…'})</h3>
            {(data?.deliverables ?? []).length === 0 ? (
              <p className="text-[12.5px] text-ink-3">Nothing assigned.</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {data!.deliverables.map((d) => (
                  <li key={d.id}>
                    <Link to={`/projects/${d.project_id}`} className="flex items-center gap-2 rounded-lg px-2 py-2 hover:bg-white/[0.04]" onClick={onClose}>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] text-ink">{d.title}</span>
                        <span className="block truncate text-[11.5px] text-ink-3">
                          {d.client_name} · {d.project_name}
                          {d.estimated_hours ? ` · ${d.estimated_hours}h` : ''}
                        </span>
                      </span>
                      <StageBadge stage={d.status} />
                      <DueChip date={d.deadline} today={today} compact />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section>
            <h3 className="text-[13.5px] font-semibold mb-2">Open tasks</h3>
            {(data?.tasks ?? []).length === 0 ? (
              <p className="text-[12.5px] text-ink-3">No tasks.</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {data!.tasks.map((t) => (
                  <li key={t.id} className="flex items-center gap-2 px-2 py-1.5 text-[13px]">
                    <span className="flex-1 truncate text-ink">{t.title}</span>
                    <DueChip date={t.due_date} today={today} compact />
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </Dialog>
  );
}

export default function TeamPage() {
  const admin = useIsAdmin();
  const qc = useQueryClient();
  const toast = useToast();
  const { confirm } = useConfirm();
  const { data, isLoading, error, refetch } = useTeam();
  const [editing, setEditing] = useState<TeamMember | null | 'new'>(null);
  const [open, setOpen] = useState<TeamMember | null>(null);
  const remove = useMutation({
    mutationFn: (id: number) => api.del(`/api/team/${id}`),
    onSuccess: () => {
      invalidateAll(qc, 'team');
      toast.success('Team member removed');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const members = data?.members ?? [];
  return (
    <div>
      <PageHeader
        title="Team"
        description="Who is working on what, and how loaded each editor is this week."
        actions={
          admin && (
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
              Add team member
            </Button>
          )
        }
      />
      {!!data?.unassigned_deliverables && (
        <Notice tone="warn" className="mb-4">
          {data.unassigned_deliverables} open deliverable{data.unassigned_deliverables === 1 ? ' has' : 's have'} no editor. Assign one on the project page so nothing slips.
        </Notice>
      )}
      {isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-56" />
          ))}
        </div>
      ) : error ? (
        <ErrorState error={error} onRetry={() => refetch()} />
      ) : members.length === 0 ? (
        <Card>
          <EmptyState icon={<UsersRound className="size-5" />} title="No team members yet" body="Add the editors and designers you work with (including yourself) to assign deliverables and see workload." action={admin ? <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>Add team member</Button> : undefined} />
        </Card>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
          {members.map((m) => {
            const w = m.workload;
            const util = w.utilization;
            const tone = util === null ? 'accent' : util > 1 ? 'bad' : util > 0.85 ? 'warn' : 'accent';
            return (
              <Card key={m.id} className={cx('p-5 flex flex-col gap-4 transition-colors hover:border-white/[0.12]', m.status === 'inactive' && 'opacity-60')}>
                <div className="flex items-start gap-3">
                  <Avatar name={m.name} color={m.color} size={40} className="!ring-0" />
                  <button type="button" className="min-w-0 flex-1 text-left cursor-pointer" onClick={() => setOpen(m)}>
                    <div className="text-[14px] font-semibold text-ink">
                      {m.name} {m.is_demo ? <DemoBadge /> : null}
                    </div>
                    <div className="text-[12.5px] text-ink-3">
                      {m.title}
                      {m.status === 'inactive' ? ' · inactive' : ''}
                    </div>
                  </button>
                  {admin && (
                    <Menu
                      label="Member actions"
                      button={(p) => (
                        <IconButton size="sm" label={`Actions for ${m.name}`} {...p}>
                          <MoreHorizontal className="size-4" />
                        </IconButton>
                      )}
                      items={[
                        { label: 'Edit', icon: <Pencil />, onSelect: () => setEditing(m) },
                        {
                          label: 'Remove',
                          icon: <Trash2 />,
                          danger: true,
                          onSelect: async () => {
                            if (await confirm({ title: `Remove ${m.name}?`, body: 'Only possible when nothing open is assigned to them. You can mark them inactive instead.', confirmLabel: 'Remove', danger: true })) remove.mutate(m.id);
                          },
                        },
                      ]}
                    />
                  )}
                </div>
                <div>
                  <div className="flex items-baseline justify-between text-[12.5px] mb-1.5">
                    <span className="text-ink-3">Booked next 7 days</span>
                    <span className="tabular text-ink">
                      {w.hours_booked_week.toFixed(w.hours_booked_week % 1 ? 1 : 0)}h <span className="text-ink-3">/ {m.capacity_hours}h</span>
                    </span>
                  </div>
                  <Meter value={w.hours_booked_week} max={m.capacity_hours || 1} tone={tone} label={`${m.name} booked hours this week`} />
                  {util !== null && util > 1 && (
                    <p className="mt-1.5 text-[12px] text-bad inline-flex items-center gap-1">
                      <AlertCircle className="size-3.5" /> Over capacity — rebalance or move deadlines.
                    </p>
                  )}
                  {w.hours_booked_week === 0 && w.open_deliverables > 0 && <p className="mt-1.5 text-[11.5px] text-ink-3">Add estimated hours to deliverables for a better picture.</p>}
                </div>
                <dl className="grid grid-cols-3 gap-2 text-center">
                  <div className="rounded-lg bg-white/[0.03] py-2">
                    <dt className="text-[11px] text-ink-3">Open</dt>
                    <dd className="text-[17px] font-semibold">{w.open_deliverables}</dd>
                  </div>
                  <div className="rounded-lg bg-white/[0.03] py-2">
                    <dt className="text-[11px] text-ink-3">Due ≤7d</dt>
                    <dd className="text-[17px] font-semibold">{w.due_this_week}</dd>
                  </div>
                  <div className="rounded-lg bg-white/[0.03] py-2">
                    <dt className="text-[11px] text-ink-3">Overdue</dt>
                    <dd className={cx('text-[17px] font-semibold', w.overdue_deliverables ? 'text-bad' : '')}>{w.overdue_deliverables}</dd>
                  </div>
                </dl>
                <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-ink-3">
                  <Badge>{w.active_projects} projects</Badge>
                  <Badge>{w.in_review} in review</Badge>
                  <Badge tone={w.overdue_tasks ? 'bad' : 'neutral'}>{w.open_tasks} tasks{w.overdue_tasks ? ` · ${w.overdue_tasks} late` : ''}</Badge>
                  {admin && m.cost_rate_minor != null && m.cost_currency && (
                    <span className="ml-auto tabular">
                      {formatMoney(m.cost_rate_minor, m.cost_currency)} {m.cost_unit ? COST_UNIT_LABELS[m.cost_unit as keyof typeof COST_UNIT_LABELS] : ''}
                    </span>
                  )}
                </div>
                {m.skills.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {m.skills.map((s) => (
                      <span key={s} className="text-[11.5px] text-ink-3">
                        #{s}
                      </span>
                    ))}
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}
      <TeamMemberDialog open={editing !== null} onClose={() => setEditing(null)} member={editing === 'new' ? null : editing} />
      <MemberDrawer member={open} onClose={() => setOpen(null)} />
    </div>
  );
}
