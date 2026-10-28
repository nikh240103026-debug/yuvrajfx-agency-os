import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, CheckCheck, RefreshCcw } from 'lucide-react';
import { api, errorMessage } from '../lib/api.ts';
import { invalidateAll, useIsAdmin } from '../lib/queries.ts';
import { Button, Card, DemoBadge, EmptyState, ErrorState, PageHeader, Segmented, Skeleton } from '../components/ui.tsx';
import { SeverityDot } from '../components/layout.tsx';
import { useToast } from '../components/overlay.tsx';
import { cx, timeAgo } from '../lib/util.ts';

type N = { id: number; kind: string; severity: string; title: string; body: string | null; link: string | null; created_at: string; read_at: string | null; is_demo: number };

function group(created: string): string {
  const d = Date.now() - Date.parse(created);
  if (d < 86_400_000) return 'Today';
  if (d < 7 * 86_400_000) return 'This week';
  return 'Earlier';
}

export default function NotificationsPage() {
  const admin = useIsAdmin();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const [filter, setFilter] = useState<'all' | 'unread'>('unread');
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['notifications', 'page', filter], queryFn: () => api.get<{ notifications: N[]; unread: number }>(`/api/notifications?limit=300${filter === 'unread' ? '&unread=1' : ''}`) });
  const read = useMutation({ mutationFn: (ids: number[] | 'all') => api.post('/api/notifications/read', { ids }), onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }) });
  const run = useMutation({
    mutationFn: () => api.post<{ status: string }>('/api/automations/run'),
    onSuccess: (r) => {
      invalidateAll(qc, 'notifications', 'automations', 'tasks', 'outbox');
      toast[r.status === 'ok' ? 'success' : 'error'](r.status === 'ok' ? 'Checked everything. New alerts appear below.' : 'Some automations failed — see Automations.');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const list = data?.notifications ?? [];
  const groups = ['Today', 'This week', 'Earlier'].map((g) => ({ g, items: list.filter((n) => group(n.created_at) === g) })).filter((x) => x.items.length);
  return (
    <div>
      <PageHeader
        title="Notifications"
        description="Deadlines, overdue work and invoices, client feedback, renewals, follow-ups and reports — generated from your data."
        actions={
          <>
            {admin && (
              <Button icon={<RefreshCcw className="size-4" />} loading={run.isPending} onClick={() => run.mutate()}>
                Check now
              </Button>
            )}
            <Button icon={<CheckCheck className="size-4" />} disabled={!data?.unread} onClick={() => read.mutate('all')}>
              Mark all read
            </Button>
          </>
        }
      />
      <div className="mb-4">
        <Segmented label="Show" value={filter} onChange={setFilter} options={[{ value: 'unread', label: 'Unread', count: data?.unread }, { value: 'all', label: 'All' }]} />
      </div>
      {isLoading ? (
        <Skeleton className="h-64" />
      ) : error ? (
        <ErrorState error={error} onRetry={() => refetch()} />
      ) : list.length === 0 ? (
        <Card>
          <EmptyState icon={<Bell className="size-5" />} title={filter === 'unread' ? 'You’re all caught up' : 'No notifications yet'} body="Alerts are created automatically every 15 minutes while the app runs." />
        </Card>
      ) : (
        <div className="flex flex-col gap-5">
          {groups.map(({ g, items }) => (
            <section key={g}>
              <h2 className="label-caps mb-2 px-1">{g}</h2>
              <Card>
                <ul className="divide-y divide-line">
                  {items.map((n) => (
                    <li key={n.id}>
                      <button
                        type="button"
                        className="flex w-full items-start gap-3 px-5 py-3 text-left hover:bg-white/[0.02] cursor-pointer"
                        onClick={() => {
                          if (!n.read_at) read.mutate([n.id]);
                          if (n.link) navigate(n.link);
                        }}
                      >
                        <SeverityDot severity={n.severity} />
                        <span className="min-w-0 flex-1">
                          <span className={cx('block text-[13.5px]', n.read_at ? 'text-ink-2' : 'text-ink font-medium')}>
                            {n.title} {n.is_demo ? <DemoBadge /> : null}
                          </span>
                          {n.body && <span className="block text-[12.5px] text-ink-3">{n.body}</span>}
                        </span>
                        <span className="text-[11.5px] text-ink-3 whitespace-nowrap">{timeAgo(n.created_at)}</span>
                        {!n.read_at && <span className="mt-1.5 size-1.5 rounded-full bg-accent-ink shrink-0" aria-label="Unread" />}
                      </button>
                    </li>
                  ))}
                </ul>
              </Card>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
