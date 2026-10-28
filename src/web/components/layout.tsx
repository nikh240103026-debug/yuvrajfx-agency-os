import { Suspense, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bell,
  CalendarDays,
  CheckSquare,
  ChevronRight,
  CircleDollarSign,
  ClipboardList,
  CreditCard,
  FileText,
  FolderKanban,
  LayoutDashboard,
  LogOut,
  Menu as MenuIcon,
  Plus,
  Receipt,
  Search,
  Settings,
  Sparkles,
  Target,
  Users,
  UsersRound,
  Workflow,
  X,
  KeyRound,
  BarChart3,
} from 'lucide-react';
import { api } from '../lib/api.ts';
import { useAuth, useIsAdmin } from '../lib/queries.ts';
import { cx, timeAgo, useDebounced, useHotkey } from '../lib/util.ts';
import { Avatar, Badge, IconButton, Kbd, PageSkeleton, Spinner } from './ui.tsx';
import { Dialog, Menu } from './overlay.tsx';
import { ROLE_LABELS } from '../../shared/constants.ts';

export function Logo({ compact }: { compact?: boolean }) {
  // Unique per instance: a gradient defined inside a hidden copy of the logo would not paint the visible one.
  const gid = `yfx-g-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  return (
    <div className="flex items-center gap-2.5">
      <svg viewBox="0 0 64 64" className="size-8 shrink-0" aria-hidden>
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#b1a6ff" />
            <stop offset="1" stopColor="#5b4bd6" />
          </linearGradient>
        </defs>
        <rect width="64" height="64" rx="16" fill="#18181f" />
        <rect x="1" y="1" width="62" height="62" rx="15" fill="none" stroke="#fff" strokeOpacity=".09" strokeWidth="2" />
        <path d="M19 17h9l4 10 4-10h9l-9 18v12h-8V35z" fill={`url(#${gid})`} />
      </svg>
      {!compact && (
        <div className="leading-none">
          <div className="text-[15px] font-semibold tracking-tight text-ink">
            Yuvraj<span className="text-accent-ink">FX</span>
          </div>
          <div className="mt-1 text-[10.5px] font-medium tracking-[0.14em] uppercase text-ink-3">Agency OS</div>
        </div>
      )}
    </div>
  );
}

type NavItem = { to: string; label: string; icon: ReactNode; admin?: boolean; end?: boolean };
const NAV: { group: string; items: NavItem[] }[] = [
  {
    group: 'Overview',
    items: [
      { to: '/', label: 'Dashboard', icon: <LayoutDashboard />, end: true },
      { to: '/tasks', label: 'Tasks', icon: <CheckSquare /> },
      { to: '/notifications', label: 'Notifications', icon: <Bell /> },
    ],
  },
  {
    group: 'Production',
    items: [
      { to: '/projects', label: 'Projects', icon: <FolderKanban /> },
      { to: '/calendar', label: 'Calendar', icon: <CalendarDays /> },
      { to: '/team', label: 'Team', icon: <UsersRound /> },
    ],
  },
  {
    group: 'Clients',
    items: [
      { to: '/clients', label: 'Clients', icon: <Users /> },
      { to: '/pipeline', label: 'Pipeline', icon: <Target />, admin: true },
    ],
  },
  {
    group: 'Money',
    items: [
      { to: '/invoices', label: 'Invoices', icon: <FileText />, admin: true },
      { to: '/payments', label: 'Payments', icon: <CreditCard />, admin: true },
      { to: '/expenses', label: 'Expenses', icon: <Receipt />, admin: true },
      { to: '/finance', label: 'Finance', icon: <CircleDollarSign />, admin: true },
      { to: '/reports', label: 'Reports', icon: <BarChart3 />, admin: true },
    ],
  },
  {
    group: 'System',
    items: [
      { to: '/automations', label: 'Automations', icon: <Workflow />, admin: true },
      { to: '/settings', label: 'Settings', icon: <Settings />, admin: true },
    ],
  },
];

function NavList({ onNavigate }: { onNavigate?: () => void }) {
  const admin = useIsAdmin();
  const { data: count } = useQuery({ queryKey: ['notifications', 'count'], queryFn: () => api.get<{ unread: number }>('/api/notifications/count'), refetchInterval: 60_000 });
  return (
    <nav aria-label="Main" className="flex flex-col gap-5">
      {NAV.map((g) => {
        const items = g.items.filter((i) => admin || !i.admin);
        if (!items.length) return null;
        return (
          <div key={g.group}>
            <div className="px-3 mb-1.5 label-caps !text-[10.5px]">{g.group}</div>
            <ul className="flex flex-col gap-0.5">
              {items.map((i) => (
                <li key={i.to}>
                  <NavLink
                    to={i.to}
                    end={i.end}
                    onClick={onNavigate}
                    className={({ isActive }) =>
                      cx(
                        'group relative flex items-center gap-2.5 h-8 px-3 rounded-lg text-[13.5px] transition-colors [&_svg]:size-[17px] [&_svg]:shrink-0',
                        isActive ? 'bg-white/[0.07] text-ink font-medium' : 'text-ink-2 hover:text-ink hover:bg-white/[0.04]',
                      )
                    }
                  >
                    {({ isActive }) => (
                      <>
                        {isActive && <span className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-r bg-accent-ink" aria-hidden />}
                        <span className={isActive ? 'text-accent-ink' : 'text-ink-3 group-hover:text-ink-2'}>{i.icon}</span>
                        <span className="flex-1">{i.label}</span>
                        {i.to === '/notifications' && !!count?.unread && (
                          <span className="min-w-5 h-5 px-1.5 grid place-items-center rounded-full bg-accent text-[10.5px] font-semibold text-white tabular">{count.unread > 99 ? '99+' : count.unread}</span>
                        )}
                      </>
                    )}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}

function UserCard() {
  const { data } = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const logout = useMutation({
    mutationFn: () => api.post('/api/auth/logout'),
    onSuccess: () => {
      qc.clear();
      navigate('/login');
    },
  });
  if (!data?.user) return null;
  return (
    <Menu
      label="Account"
      align="start"
      button={(props) => (
        <button {...props} type="button" className="flex w-full items-center gap-2.5 rounded-xl p-2 hover:bg-white/[0.05] cursor-pointer text-left">
          <Avatar name={data.user!.name} color="#5f54a1" size={30} className="!ring-0" />
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium text-ink truncate">{data.user!.name}</div>
            <div className="text-[11.5px] text-ink-3 truncate">{ROLE_LABELS[data.user!.role]}</div>
          </div>
        </button>
      )}
      items={[
        { heading: data.user.email },
        { label: 'Change password', icon: <KeyRound />, onSelect: () => navigate('/account') },
        { label: 'Sign out', icon: <LogOut />, onSelect: () => logout.mutate() },
      ]}
    />
  );
}

function Sidebar() {
  return (
    <aside className="hidden lg:flex fixed inset-y-0 left-0 z-30 w-[244px] flex-col border-r border-line bg-bg-subtle/80 backdrop-blur-xl">
      <div className="px-4 pt-5 pb-6">
        <Logo />
      </div>
      <div className="flex-1 overflow-y-auto px-2 pb-4">
        <NavList />
      </div>
      <div className="border-t border-line p-2">
        <UserCard />
      </div>
    </aside>
  );
}

// ── Command palette (Ctrl/⌘ K) ────────────────────────────────────────────────

type SearchResult = { type: string; id: number; title: string; subtitle: string | null; link: string };

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const navigate = useNavigate();
  const admin = useIsAdmin();
  const dq = useDebounced(q, 160);
  const { data, isFetching } = useQuery({
    queryKey: ['search', dq],
    queryFn: () => api.get<{ results: SearchResult[] }>(`/api/search?q=${encodeURIComponent(dq)}`),
    enabled: open && dq.trim().length >= 2,
  });
  const actions = useMemo(
    () =>
      [
        { title: 'New client', link: '/clients?new=1', admin: true },
        { title: 'New project', link: '/projects?new=1', admin: true },
        { title: 'New invoice', link: '/invoices/new', admin: true },
        { title: 'Record an expense', link: '/expenses?new=1', admin: true },
        { title: 'New lead', link: '/pipeline?new=1', admin: true },
        { title: 'New task', link: '/tasks?new=1' },
        { title: 'Go to dashboard', link: '/' },
        { title: 'Go to production board', link: '/projects?view=board' },
        { title: 'Go to calendar', link: '/calendar' },
        { title: 'Go to finance', link: '/finance', admin: true },
        { title: 'Go to settings', link: '/settings', admin: true },
      ]
        .filter((a) => admin || !a.admin)
        .filter((a) => !q.trim() || a.title.toLowerCase().includes(q.trim().toLowerCase()))
        .map((a) => ({ type: 'action', id: 0, title: a.title, subtitle: null, link: a.link })),
    [q, admin],
  );
  const results: SearchResult[] = [...(dq.trim().length >= 2 ? data?.results ?? [] : []), ...actions];
  useEffect(() => {
    if (open) {
      setQ('');
      setActive(0);
    }
  }, [open]);
  useEffect(() => setActive(0), [dq]);
  const go = (r: SearchResult) => {
    onClose();
    navigate(r.link);
  };
  return (
    <Dialog open={open} onClose={onClose} title="Search & jump" size="md">
      <div className="-mt-1">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-ink-3" aria-hidden />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((a) => Math.min(a + 1, results.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((a) => Math.max(a - 1, 0));
              } else if (e.key === 'Enter' && results[active]) {
                e.preventDefault();
                go(results[active]);
              }
            }}
            placeholder="Search clients, projects, deliverables, invoices, leads…"
            className="field-input !h-11 !pl-9 text-[14px]"
            role="combobox"
            aria-expanded="true"
            aria-controls="cmdk-list"
            aria-activedescendant={results[active] ? `cmdk-${active}` : undefined}
          />
          {isFetching && <Spinner className="absolute right-3 top-1/2 -translate-y-1/2" />}
        </div>
        <ul id="cmdk-list" role="listbox" className="mt-3 max-h-[50vh] overflow-y-auto -mx-1">
          {results.length === 0 && <li className="px-3 py-6 text-center text-[13px] text-ink-3">No matches.</li>}
          {results.map((r, i) => (
            <li
              key={`${r.type}-${r.id}-${r.link}`}
              id={`cmdk-${i}`}
              role="option"
              aria-selected={i === active}
              onMouseEnter={() => setActive(i)}
              onClick={() => go(r)}
              className={cx('flex items-center gap-3 rounded-lg px-3 py-2 cursor-pointer', i === active ? 'bg-white/[0.07]' : '')}
            >
              <span className="w-[74px] shrink-0">
                <Badge tone={r.type === 'action' ? 'accent' : 'neutral'}>{r.type}</Badge>
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px] text-ink">{r.title}</span>
                {r.subtitle && <span className="block truncate text-[12px] text-ink-3">{r.subtitle}</span>}
              </span>
              <ChevronRight className="size-4 text-ink-3" aria-hidden />
            </li>
          ))}
        </ul>
        <div className="mt-3 flex items-center gap-3 text-[11.5px] text-ink-3">
          <span className="flex items-center gap-1">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd> move
          </span>
          <span className="flex items-center gap-1">
            <Kbd>Enter</Kbd> open
          </span>
          <span className="flex items-center gap-1">
            <Kbd>Esc</Kbd> close
          </span>
        </div>
      </div>
    </Dialog>
  );
}

// ── Notification bell ────────────────────────────────────────────────────────

type Notification = { id: number; kind: string; severity: string; title: string; body: string | null; link: string | null; created_at: string; read_at: string | null };

function NotificationBell() {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data } = useQuery({ queryKey: ['notifications', 'recent'], queryFn: () => api.get<{ notifications: Notification[]; unread: number }>('/api/notifications?limit=8'), refetchInterval: 60_000 });
  const read = useMutation({
    mutationFn: (ids: number[] | 'all') => api.post('/api/notifications/read', { ids }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !wrap.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  const unread = data?.unread ?? 0;
  return (
    <div ref={wrap} className="relative">
      <IconButton label={unread ? `Notifications (${unread} unread)` : 'Notifications'} onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <Bell className="size-[18px]" />
        {unread > 0 && <span className="absolute top-1.5 right-1.5 size-2 rounded-full bg-accent-ink ring-2 ring-bg" aria-hidden />}
      </IconButton>
      {open && (
        <div className="absolute right-0 top-full mt-2 z-40 w-[min(380px,calc(100vw-24px))] rounded-2xl bg-surface-2 border border-line-strong shadow-[0_20px_60px_-10px_rgb(0_0_0/0.7)] animate-pop">
          <div className="flex items-center justify-between px-4 py-3 border-b border-line">
            <div className="text-[13.5px] font-semibold">Notifications</div>
            {unread > 0 && (
              <button type="button" className="text-[12px] text-accent-ink hover:underline cursor-pointer" onClick={() => read.mutate('all')}>
                Mark all read
              </button>
            )}
          </div>
          <ul className="max-h-[60vh] overflow-y-auto p-1.5">
            {(data?.notifications ?? []).length === 0 && <li className="px-3 py-8 text-center text-[13px] text-ink-3">You’re all caught up.</li>}
            {(data?.notifications ?? []).map((n) => (
              <li key={n.id}>
                <button
                  type="button"
                  onClick={() => {
                    if (!n.read_at) read.mutate([n.id]);
                    setOpen(false);
                    if (n.link) navigate(n.link);
                  }}
                  className="flex w-full gap-3 rounded-xl px-2.5 py-2 text-left hover:bg-white/[0.05] cursor-pointer"
                >
                  <SeverityDot severity={n.severity} />
                  <span className="min-w-0 flex-1">
                    <span className={cx('block text-[13px] leading-snug', n.read_at ? 'text-ink-2' : 'text-ink font-medium')}>{n.title}</span>
                    {n.body && <span className="block text-[12px] text-ink-3 truncate">{n.body}</span>}
                    <span className="block text-[11px] text-ink-3 mt-0.5">{timeAgo(n.created_at)}</span>
                  </span>
                  {!n.read_at && <span className="mt-1.5 size-1.5 rounded-full bg-accent-ink shrink-0" aria-label="Unread" />}
                </button>
              </li>
            ))}
          </ul>
          <div className="border-t border-line p-1.5">
            <button
              type="button"
              className="w-full h-8 rounded-lg text-[12.5px] text-ink-2 hover:bg-white/[0.05] hover:text-ink cursor-pointer"
              onClick={() => {
                setOpen(false);
                navigate('/notifications');
              }}
            >
              View all notifications
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function SeverityDot({ severity }: { severity: string }) {
  const color = severity === 'critical' ? 'bg-bad-dot' : severity === 'warning' ? 'bg-warn' : severity === 'success' ? 'bg-good-dot' : 'bg-[#3987e5]';
  return <span className={cx('mt-1.5 size-2 rounded-full shrink-0', color)} aria-label={severity} />;
}

// ── Top bar & shell ──────────────────────────────────────────────────────────

function Topbar({ onSearch, onMenu }: { onSearch: () => void; onMenu: () => void }) {
  const admin = useIsAdmin();
  const navigate = useNavigate();
  return (
    <header className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b border-line bg-bg/75 backdrop-blur-xl px-3 sm:px-5 no-print">
      <IconButton label="Open menu" className="lg:hidden" onClick={onMenu}>
        <MenuIcon className="size-5" />
      </IconButton>
      <div className="lg:hidden">
        <Logo compact />
      </div>
      <button
        type="button"
        onClick={onSearch}
        className="flex items-center gap-2 h-9 w-full max-w-[420px] rounded-lg border border-line-strong bg-white/[0.03] px-3 text-[13px] text-ink-3 hover:bg-white/[0.05] hover:text-ink-2 cursor-pointer transition-colors"
      >
        <Search className="size-4" aria-hidden />
        <span className="flex-1 text-left truncate">Search or jump to…</span>
        <span className="hidden sm:flex items-center gap-0.5">
          <Kbd>Ctrl</Kbd>
          <Kbd>K</Kbd>
        </span>
      </button>
      <div className="ml-auto flex items-center gap-1">
        <Menu
          label="Create"
          button={(props) => (
            <button {...props} type="button" className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg bg-accent text-white text-[13px] font-medium hover:bg-accent-hover cursor-pointer shadow-[inset_0_1px_0_rgb(255_255_255/0.18)]">
              <Plus className="size-4" aria-hidden />
              <span className="hidden sm:inline">New</span>
            </button>
          )}
          items={[
            ...(admin
              ? [
                  { label: 'Client', icon: <Users />, onSelect: () => navigate('/clients?new=1') },
                  { label: 'Project', icon: <FolderKanban />, onSelect: () => navigate('/projects?new=1') },
                  { label: 'Invoice', icon: <FileText />, onSelect: () => navigate('/invoices/new') },
                  { label: 'Expense', icon: <Receipt />, onSelect: () => navigate('/expenses?new=1') },
                  { label: 'Lead', icon: <Target />, onSelect: () => navigate('/pipeline?new=1') },
                ]
              : []),
            { label: 'Task', icon: <ClipboardList />, onSelect: () => navigate('/tasks?new=1') },
          ]}
        />
        <NotificationBell />
      </div>
    </header>
  );
}

function DemoBanner() {
  const admin = useIsAdmin();
  const { data } = useAuth();
  const navigate = useNavigate();
  if (!data?.demo_data) return null;
  return (
    <div className="flex items-center gap-2 border-b border-warn/20 bg-warn/[0.06] px-4 sm:px-6 py-2 text-[12.5px] text-ink-2 no-print">
      <Sparkles className="size-3.5 text-warn shrink-0" aria-hidden />
      <span className="flex-1">
        <span className="font-medium text-warn">Demo data is loaded.</span> Records marked <span className="text-warn font-medium">DEMO</span> are fictional examples, included in every total until you remove them.
      </span>
      {admin && (
        <button type="button" className="text-warn font-medium hover:underline cursor-pointer whitespace-nowrap" onClick={() => navigate('/settings?tab=data')}>
          Remove demo data
        </button>
      )}
    </div>
  );
}

export function AppShell() {
  const [search, setSearch] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const location = useLocation();
  useHotkey('mod+k', (e) => {
    e.preventDefault();
    setSearch(true);
  });
  useEffect(() => {
    setMobileNav(false);
    window.scrollTo({ top: 0 });
  }, [location.pathname]);
  return (
    <div className="min-h-dvh">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-lg focus:bg-accent focus:px-3 focus:py-2 focus:text-white">
        Skip to content
      </a>
      <Sidebar />
      <div className="lg:pl-[244px]">
        <Topbar onSearch={() => setSearch(true)} onMenu={() => setMobileNav(true)} />
        <DemoBanner />
        <main id="main" className="mx-auto max-w-[1440px] px-4 sm:px-6 py-6 sm:py-8" key={location.pathname}>
          <Suspense fallback={<PageSkeleton />}>
            <Outlet />
          </Suspense>
        </main>
      </div>
      <CommandPalette open={search} onClose={() => setSearch(false)} />
      {mobileNav && (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Menu">
          <div className="absolute inset-0 bg-black/60" onClick={() => setMobileNav(false)} />
          <div className="absolute inset-y-0 left-0 w-[280px] max-w-[85vw] flex flex-col bg-bg-subtle border-r border-line animate-slide-in">
            <div className="flex items-center justify-between px-4 pt-4 pb-5">
              <Logo />
              <IconButton label="Close menu" onClick={() => setMobileNav(false)}>
                <X className="size-5" />
              </IconButton>
            </div>
            <div className="flex-1 overflow-y-auto px-2 pb-4">
              <NavList onNavigate={() => setMobileNav(false)} />
            </div>
            <div className="border-t border-line p-2">
              <UserCard />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function CenteredCard({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh grid place-items-center px-4 py-10">
      <div className="w-full max-w-[420px] animate-enter">{children}</div>
    </div>
  );
}

