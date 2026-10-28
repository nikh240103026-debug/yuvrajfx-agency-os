import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { api, qs } from '../lib/api.ts';
import { useIsAdmin, useToday } from '../lib/queries.ts';
import { Button, Card, ErrorState, IconButton, PageHeader, Skeleton } from '../components/ui.tsx';
import { Dialog } from '../components/overlay.tsx';
import { addDays, addMonths, formatDateLong, monthLabel, startOfMonth, startOfWeek } from '../../shared/dates.ts';
import { formatMoney } from '../../shared/money.ts';
import { STAGE_LABELS, type Stage } from '../../shared/constants.ts';
import { cx } from '../lib/util.ts';

type Event = {
  id: number;
  type: 'deliverable' | 'project' | 'task' | 'invoice' | 'renewal' | 'follow_up';
  title: string;
  date: string;
  status?: string;
  client_name?: string;
  project_name?: string;
  overdue: number;
  link: string;
  balance_minor?: number;
  currency?: string;
  color?: string | null;
};

const TYPES: { key: Event['type']; label: string; color: string; admin?: boolean }[] = [
  { key: 'deliverable', label: 'Deliverables', color: 'var(--color-series-1)' },
  { key: 'project', label: 'Project deadlines', color: '#cdc4ff' },
  { key: 'task', label: 'Tasks', color: '#3987e5' },
  { key: 'invoice', label: 'Invoices due', color: 'var(--color-series-2)', admin: true },
  { key: 'renewal', label: 'Renewals', color: '#c98500', admin: true },
  { key: 'follow_up', label: 'Follow-ups', color: '#d55181', admin: true },
];
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function isDone(e: Event) {
  return e.status === 'delivered' || e.status === 'done' || e.status === 'cancelled';
}

function EventChip({ e, compact }: { e: Event; compact?: boolean }) {
  const t = TYPES.find((x) => x.key === e.type)!;
  return (
    <Link
      to={e.link}
      title={`${t.label.replace(/s$/, '')}: ${e.title}${e.client_name ? ` · ${e.client_name}` : ''}${e.overdue ? ' · OVERDUE' : ''}`}
      className={cx('flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[11.5px] leading-tight hover:bg-white/[0.07] min-w-0', e.overdue ? 'text-bad bg-bad-dot/10' : isDone(e) ? 'text-ink-3 line-through' : 'text-ink-2')}
    >
      <span className="size-1.5 rounded-full shrink-0" style={{ background: e.overdue ? 'var(--color-bad-dot)' : t.color }} aria-hidden />
      <span className="truncate">{e.title}</span>
      {!compact && e.type === 'invoice' && e.balance_minor != null && e.currency && <span className="ml-auto tabular text-ink-3">{formatMoney(e.balance_minor, e.currency)}</span>}
    </Link>
  );
}

export default function CalendarPage({ embedded }: { embedded?: boolean }) {
  const today = useToday();
  const admin = useIsAdmin();
  const [month, setMonth] = useState(startOfMonth(today));
  const [types, setTypes] = useState<Set<Event['type']>>(new Set(TYPES.filter((t) => admin || !t.admin).map((t) => t.key)));
  const [day, setDay] = useState<string | null>(null);
  const gridStart = startOfWeek(month);
  const gridEnd = addDays(gridStart, 41);
  const query = qs({ from: gridStart, to: gridEnd, types: [...types].join(',') });
  const { data, isLoading, error, refetch, isFetching } = useQuery({ queryKey: ['calendar', query], queryFn: () => api.get<{ events: Event[] }>(`/api/calendar${query}`), enabled: types.size > 0 });
  const byDay = useMemo(() => {
    const m = new Map<string, Event[]>();
    for (const e of data?.events ?? []) m.set(e.date, [...(m.get(e.date) ?? []), e]);
    return m;
  }, [data]);
  const days = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
  const monthKey = month.slice(0, 7);
  const overdueCount = (data?.events ?? []).filter((e) => e.overdue).length;
  const toggle = (k: Event['type']) => {
    const next = new Set(types);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    setTypes(next);
  };
  const header = (
    <div className="flex flex-wrap items-center gap-2">
      <IconButton label="Previous month" onClick={() => setMonth(addMonths(month, -1, 1))}>
        <ChevronLeft className="size-4" />
      </IconButton>
      <div className="min-w-36 text-center text-[15px] font-semibold">{monthLabel(monthKey, 'long')}</div>
      <IconButton label="Next month" onClick={() => setMonth(addMonths(month, 1, 1))}>
        <ChevronRight className="size-4" />
      </IconButton>
      <Button size="sm" variant="ghost" onClick={() => setMonth(startOfMonth(today))}>
        Today
      </Button>
      {overdueCount > 0 && <span className="text-[12px] font-medium text-bad ml-1">{overdueCount} overdue in view</span>}
    </div>
  );
  const legend = (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label="Show">
      {TYPES.filter((t) => admin || !t.admin).map((t) => (
        <button key={t.key} type="button" aria-pressed={types.has(t.key)} onClick={() => toggle(t.key)} className={cx('inline-flex items-center gap-1.5 h-7 px-2.5 rounded-lg text-[12px] ring-1 ring-inset cursor-pointer', types.has(t.key) ? 'ring-white/[0.12] text-ink bg-white/[0.04]' : 'ring-white/[0.05] text-ink-3')}>
          <span className="size-2 rounded-full" style={{ background: types.has(t.key) ? t.color : 'transparent', boxShadow: `inset 0 0 0 1.5px ${t.color}` }} aria-hidden />
          {t.label}
        </button>
      ))}
    </div>
  );
  const dayEvents = day ? byDay.get(day) ?? [] : [];

  return (
    <div>
      {!embedded && <PageHeader title="Calendar" description="Deadlines for deliverables, projects and tasks — plus invoice due dates, renewals and follow-ups. Overdue items are red." />}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 mb-4">
        {header}
        {legend}
      </div>
      {error ? (
        <ErrorState error={error} onRetry={() => refetch()} />
      ) : (
        <>
          <Card className={cx('hidden md:block overflow-hidden transition-opacity', isFetching && !isLoading && 'opacity-80')}>
            <div className="grid grid-cols-7 border-b border-line">
              {WEEKDAYS.map((w) => (
                <div key={w} className="px-3 py-2 text-[11.5px] font-medium text-ink-3">
                  {w}
                </div>
              ))}
            </div>
            <div className="grid grid-cols-7 grid-rows-6">
              {days.map((d) => {
                const events = byDay.get(d) ?? [];
                const inMonth = d.slice(0, 7) === monthKey;
                const isToday = d === today;
                return (
                  <div key={d} className={cx('min-h-[112px] border-b border-r border-line p-1.5 [&:nth-child(7n)]:border-r-0', !inMonth && 'bg-black/[0.12]')}>
                    <button type="button" onClick={() => setDay(d)} className={cx('mb-1 inline-grid place-items-center size-6 rounded-full text-[12px] tabular cursor-pointer hover:bg-white/[0.07]', isToday ? 'bg-accent text-white font-semibold' : inMonth ? 'text-ink-2' : 'text-ink-3/60')} aria-label={`${formatDateLong(d)}: ${events.length} items`}>
                      {Number(d.slice(8))}
                    </button>
                    {isLoading ? (
                      d.endsWith('5') && <Skeleton className="h-4" />
                    ) : (
                      <div className="flex flex-col gap-0.5">
                        {events.slice(0, 3).map((e) => (
                          <EventChip key={`${e.type}-${e.id}`} e={e} compact />
                        ))}
                        {events.length > 3 && (
                          <button type="button" onClick={() => setDay(d)} className="text-left px-1.5 text-[11px] text-ink-3 hover:text-ink cursor-pointer">
                            +{events.length - 3} more
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </Card>
          {/* Phone: agenda list */}
          <div className="md:hidden flex flex-col gap-3">
            {days
              .filter((d) => d.slice(0, 7) === monthKey && (byDay.get(d)?.length ?? 0) > 0)
              .map((d) => (
                <Card key={d} className="p-3">
                  <div className={cx('text-[12px] font-semibold mb-1.5', d === today ? 'text-accent-ink' : 'text-ink-2')}>{formatDateLong(d)}</div>
                  <div className="flex flex-col gap-1">
                    {(byDay.get(d) ?? []).map((e) => (
                      <EventChip key={`${e.type}-${e.id}`} e={e} />
                    ))}
                  </div>
                </Card>
              ))}
            {!isLoading && (data?.events ?? []).filter((e) => e.date.slice(0, 7) === monthKey).length === 0 && <p className="text-center text-[13px] text-ink-3 py-8">Nothing scheduled this month.</p>}
          </div>
        </>
      )}
      <Dialog open={!!day} onClose={() => setDay(null)} title={day ? formatDateLong(day) : ''} size="sm">
        {dayEvents.length === 0 ? (
          <p className="text-[13px] text-ink-3">Nothing scheduled.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {dayEvents.map((e) => (
              <li key={`${e.type}-${e.id}`} className="rounded-lg bg-white/[0.03] p-2.5">
                <EventChip e={e} />
                <div className="pl-5 text-[11.5px] text-ink-3">
                  {TYPES.find((t) => t.key === e.type)?.label.replace(/s$/, '')}
                  {e.client_name ? ` · ${e.client_name}` : ''}
                  {e.project_name ? ` · ${e.project_name}` : ''}
                  {e.status && e.type === 'deliverable' ? ` · ${STAGE_LABELS[e.status as Stage] ?? e.status}` : ''}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Dialog>
    </div>
  );
}
