import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Download, Plus, Search, Users } from 'lucide-react';
import { api, qs } from '../lib/api.ts';
import { useIsAdmin, useToday, type ClientRow } from '../lib/queries.ts';
import { Button, Card, DemoBadge, EmptyState, ErrorState, Input, PageHeader, Segmented, Select, Skeleton } from '../components/ui.tsx';
import { MoneyStack } from '../components/money.tsx';
import { ClientFormDialog } from '../components/forms.tsx';
import { ClientStatusBadge, CYCLE_SHORT, DueChip } from '../lib/status.tsx';
import { formatMoney } from '../../shared/money.ts';
import { formatDate } from '../../shared/dates.ts';
import { cx, useDebounced } from '../lib/util.ts';

type Sort = 'company' | 'retainer' | 'renewal' | 'activity' | 'created';

export default function ClientsPage() {
  const admin = useIsAdmin();
  const today = useToday();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const dq = useDebounced(q);
  const status = params.get('status') ?? 'all';
  const tag = params.get('tag') ?? '';
  const sort = (params.get('sort') as Sort) ?? 'company';
  const order = params.get('order') === 'desc' ? 'desc' : 'asc';
  const archived = params.get('archived') === 'only';
  const [creating, setCreating] = useState(params.get('new') === '1');
  useEffect(() => {
    if (params.get('new') === '1') {
      setCreating(true);
      params.delete('new');
      setParams(params, { replace: true });
    }
  }, [params, setParams]);

  const query = qs({ q: dq, status: status === 'all' ? undefined : status, tag, sort, order, archived: archived ? 'only' : undefined });
  const { data, isLoading, error, refetch, isFetching } = useQuery({ queryKey: ['clients', query], queryFn: () => api.get<{ clients: ClientRow[] }>(`/api/clients${query}`) });
  const { data: tags } = useQuery({ queryKey: ['clients', 'tags'], queryFn: () => api.get<{ tags: { tag: string; count: number }[] }>('/api/clients/tags') });
  const { data: all } = useQuery({ queryKey: ['clients', 'counts'], queryFn: () => api.get<{ clients: ClientRow[] }>('/api/clients') });
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: 0 };
    for (const x of all?.clients ?? []) {
      c.all++;
      c[x.status] = (c[x.status] ?? 0) + 1;
    }
    return c;
  }, [all]);

  const setParam = (k: string, v: string | null) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };
  const toggleSort = (s: Sort) => {
    const next = new URLSearchParams(params);
    next.set('sort', s);
    next.set('order', sort === s && order === 'asc' ? 'desc' : 'asc');
    setParams(next, { replace: true });
  };
  const SortHead = ({ s, children, className }: { s: Sort; children: React.ReactNode; className?: string }) => (
    <th scope="col" aria-sort={sort === s ? (order === 'asc' ? 'ascending' : 'descending') : 'none'} className={cx('py-2.5 px-3 font-medium', className)}>
      <button type="button" onClick={() => toggleSort(s)} className="inline-flex items-center gap-1 hover:text-ink cursor-pointer">
        {children}
        {sort === s && (order === 'asc' ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}
      </button>
    </th>
  );

  const clients = data?.clients ?? [];
  return (
    <div>
      <PageHeader
        title="Clients"
        description="Contacts, retainers, contracts and everything you have delivered for each client."
        actions={
          admin && (
            <>
              <Button href="/api/clients/export.csv" download icon={<Download className="size-4" />}>
                Export CSV
              </Button>
              <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
                New client
              </Button>
            </>
          )
        }
      />

      <div className="flex flex-col lg:flex-row lg:items-center gap-3 mb-4">
        <div className="relative w-full lg:max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-ink-3" aria-hidden />
          <Input aria-label="Search clients" placeholder="Search name, company, email, package…" className="!pl-9" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <Segmented
          label="Status"
          value={archived ? 'archived' : status}
          onChange={(v) => {
            const next = new URLSearchParams(params);
            if (v === 'archived') {
              next.set('archived', 'only');
              next.delete('status');
            } else {
              next.delete('archived');
              if (v === 'all') next.delete('status');
              else next.set('status', v);
            }
            setParams(next, { replace: true });
          }}
          options={[
            { value: 'all', label: 'All', count: counts.all },
            { value: 'active', label: 'Active', count: counts.active ?? 0 },
            { value: 'onboarding', label: 'Onboarding', count: counts.onboarding ?? 0 },
            { value: 'paused', label: 'Paused', count: counts.paused ?? 0 },
            { value: 'churned', label: 'Churned', count: counts.churned ?? 0 },
            { value: 'archived', label: 'Archived' },
          ]}
        />
        <Select aria-label="Filter by tag" value={tag} onChange={(e) => setParam('tag', e.target.value || null)} className="lg:!w-44">
          <option value="">All tags</option>
          {(tags?.tags ?? []).map((t) => (
            <option key={t.tag} value={t.tag}>
              #{t.tag} ({t.count})
            </option>
          ))}
        </Select>
      </div>

      <Card className={cx('overflow-hidden transition-opacity', isFetching && !isLoading && 'opacity-70')}>
        {isLoading ? (
          <div className="p-4 flex flex-col gap-2">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-12" />
            ))}
          </div>
        ) : error ? (
          <ErrorState error={error} onRetry={() => refetch()} />
        ) : clients.length === 0 ? (
          <EmptyState
            icon={<Users className="size-5" />}
            title={dq || tag || status !== 'all' || archived ? 'No clients match' : 'No clients yet'}
            body={dq || tag || status !== 'all' ? 'Try another search or filter.' : 'Add your first client to start tracking projects, retainers and invoices.'}
            action={admin && !dq && !tag ? <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>New client</Button> : undefined}
          />
        ) : (
          <>
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead className="text-left text-[12px] text-ink-3 border-b border-line">
                  <tr>
                    <SortHead s="company" className="pl-5">Client</SortHead>
                    <th scope="col" className="py-2.5 px-3 font-medium">Status</th>
                    {admin && <SortHead s="retainer" className="text-right">Retainer</SortHead>}
                    {admin && <th scope="col" className="py-2.5 px-3 font-medium text-right">Outstanding</th>}
                    <th scope="col" className="py-2.5 px-3 font-medium text-right">Active projects</th>
                    <th scope="col" className="py-2.5 px-3 font-medium">Next deadline</th>
                    <SortHead s="renewal">Renewal</SortHead>
                    <th scope="col" className="py-2.5 px-3 pr-5 font-medium">Tags</th>
                  </tr>
                </thead>
                <tbody>
                  {clients.map((c) => (
                    <tr key={c.id} onClick={() => navigate(`/clients/${c.id}`)} className="border-b border-line last:border-0 hover:bg-white/[0.025] cursor-pointer">
                      <td className="py-3 px-3 pl-5">
                        <Link to={`/clients/${c.id}`} onClick={(e) => e.stopPropagation()} className="font-medium text-ink hover:underline">
                          {c.company || c.name}
                        </Link>{' '}
                        {c.is_demo ? <DemoBadge /> : null}
                        <div className="text-[12px] text-ink-3 truncate max-w-64">
                          {c.company ? c.name : c.email}
                          {c.service_package ? ` · ${c.service_package}` : ''}
                        </div>
                      </td>
                      <td className="py-3 px-3">
                        <ClientStatusBadge status={c.status} />
                      </td>
                      {admin && (
                        <td className="py-3 px-3 text-right tabular whitespace-nowrap">
                          {c.retainer_minor ? (
                            <>
                              <span className="text-ink">{formatMoney(c.retainer_minor, c.currency)}</span>
                              <span className="text-ink-3 text-[12px]">/{CYCLE_SHORT[c.billing_cycle]}</span>
                            </>
                          ) : (
                            <span className="text-ink-3">Project-based</span>
                          )}
                        </td>
                      )}
                      {admin && (
                        <td className="py-3 px-3 text-right">
                          <MoneyStack groups={c.outstanding} size="sm" empty={<span className="text-ink-3">—</span>} />
                        </td>
                      )}
                      <td className="py-3 px-3 text-right tabular">{c.active_projects || <span className="text-ink-3">0</span>}</td>
                      <td className="py-3 px-3">{c.next_deadline ? <DueChip date={c.next_deadline} today={today} /> : <span className="text-ink-3 text-[12px]">—</span>}</td>
                      <td className="py-3 px-3 text-[12.5px] tabular">{c.renewal_date ? <span className={c.renewal_date < today ? 'text-bad' : 'text-ink-2'}>{formatDate(c.renewal_date, today)}</span> : <span className="text-ink-3">—</span>}</td>
                      <td className="py-3 px-3 pr-5">
                        <div className="flex flex-wrap gap-1 max-w-48">
                          {c.tags.slice(0, 3).map((t) => (
                            <button
                              key={t}
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setParam('tag', t);
                              }}
                              className="text-[11.5px] text-ink-3 hover:text-accent-ink cursor-pointer"
                            >
                              #{t}
                            </button>
                          ))}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ul className="md:hidden divide-y divide-line">
              {clients.map((c) => (
                <li key={c.id}>
                  <Link to={`/clients/${c.id}`} className="flex items-center gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="font-medium text-ink truncate">
                        {c.company || c.name} {c.is_demo ? <DemoBadge /> : null}
                      </div>
                      <div className="text-[12px] text-ink-3 truncate">{c.service_package ?? c.email ?? '—'}</div>
                    </div>
                    <div className="text-right">
                      <ClientStatusBadge status={c.status} />
                      {admin && c.retainer_minor ? <div className="text-[12px] text-ink-2 mt-1 tabular">{formatMoney(c.retainer_minor, c.currency)}/mo</div> : null}
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>
      <ClientFormDialog open={creating} onClose={() => setCreating(false)} onSaved={(id) => navigate(`/clients/${id}`)} />
    </div>
  );
}
