import { useState, type FormEvent } from 'react';
import { Link, NavLink, Route, Routes, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CheckCircle2, Download, Eye, FileText, FolderKanban, KeyRound, LogOut, MessageSquare, Printer, RotateCcw } from 'lucide-react';
import { api, errorMessage } from '../lib/api.ts';
import { useAuth, useToday } from '../lib/queries.ts';
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, Input, Notice, PageSkeleton } from '../components/ui.tsx';
import { Dialog, useToast } from '../components/overlay.tsx';
import { Logo } from '../components/layout.tsx';
import { InvoiceDocument, type BusinessProfile, type InvoiceDetail } from '../components/invoice-document.tsx';
import { InvoiceStatusBadge } from '../lib/status.tsx';
import InvoicePrintPage from '../pages/InvoicePrint.tsx';
import { ChangePasswordPage } from '../pages/Auth.tsx';
import { PLATFORM_LABELS, PROJECT_TYPE_LABELS, type InvoiceStatus, type Stage } from '../../shared/constants.ts';
import { formatMoney } from '../../shared/money.ts';
import { formatDate, formatDateLong } from '../../shared/dates.ts';
import { cx, safeHref, timeAgo } from '../lib/util.ts';

// The client portal. It only ever talks to /api/portal/*, which scopes every query to the
// signed-in client's own records on the server.

type Me = { client: { id: number; name: string; company: string | null; service_package: string | null }; counts: { active_projects: number; awaiting_review: number; downloads: number; open_invoices: number }; business: { name: string; email: string; website: string } };
type PortalProject = { id: number; name: string; type: string; status: string; start_date: string | null; deadline: string | null; deliverable_count?: number; delivered_count?: number; awaiting_review?: number };
type PortalDeliverable = { id: number; project_id: number; title: string; format: string | null; platform: string | null; deadline: string | null; status: Stage; status_label: string; revision_count: number; review_url: string | null; final_url: string | null; approved_at: string | null; delivered_at: string | null; can_review: boolean };
type PortalFeedback = { id: number; deliverable_id: number | null; kind: string; author_type: 'team' | 'client'; author_name: string; body: string; timecode: string | null; created_at: string };

function statusTone(s: Stage) {
  return s === 'delivered' || s === 'approved' ? 'good' : s === 'client_review' ? 'accent' : s === 'revisions' ? 'warn' : 'neutral';
}

function Shell({ children, me }: { children: React.ReactNode; me?: Me }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data: auth } = useAuth();
  const logout = useMutation({
    mutationFn: () => api.post('/api/auth/logout'),
    onSuccess: () => {
      qc.clear();
      navigate('/login');
    },
  });
  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-20 border-b border-line bg-bg/80 backdrop-blur-xl no-print">
        <div className="mx-auto max-w-5xl flex h-16 items-center gap-4 px-4 sm:px-6">
          <Logo compact />
          <div className="min-w-0">
            <div className="text-[13.5px] font-semibold truncate">{me?.business.name ?? auth?.business_name ?? 'YuvrajFX'} · Client portal</div>
            <div className="text-[11.5px] text-ink-3 truncate">{me?.client.company || me?.client.name || auth?.client?.company || auth?.client?.name}</div>
          </div>
          <nav className="ml-auto flex items-center gap-1" aria-label="Portal">
            {[
              ['/portal', 'Projects', <FolderKanban key="p" className="size-4" />],
              ['/portal/invoices', 'Invoices', <FileText key="i" className="size-4" />],
            ].map(([to, label, icon]) => (
              <NavLink key={to as string} to={to as string} end className={({ isActive }) => cx('inline-flex items-center gap-1.5 h-9 px-3 rounded-lg text-[13px]', isActive ? 'bg-white/[0.07] text-ink' : 'text-ink-2 hover:text-ink hover:bg-white/[0.04]')}>
                {icon}
                <span className="hidden sm:inline">{label as string}</span>
              </NavLink>
            ))}
            <NavLink to="/portal/account" className={({ isActive }) => cx('inline-grid place-items-center size-9 rounded-lg', isActive ? 'bg-white/[0.07] text-ink' : 'text-ink-2 hover:text-ink')} aria-label="Account">
              <KeyRound className="size-4" />
            </NavLink>
            <button type="button" onClick={() => logout.mutate()} className="inline-grid place-items-center size-9 rounded-lg text-ink-2 hover:text-ink cursor-pointer" aria-label="Sign out" title="Sign out">
              <LogOut className="size-4" />
            </button>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 sm:px-6 py-8">{children}</main>
      <footer className="mx-auto max-w-5xl px-4 sm:px-6 pb-10 text-[12px] text-ink-3 no-print">
        Questions? {me?.business.email ? <a className="text-accent-ink hover:underline" href={`mailto:${me.business.email}`}>{me.business.email}</a> : 'Reply to your producer directly.'}
      </footer>
    </div>
  );
}

function Home({ me }: { me: Me }) {
  const today = useToday();
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['portal', 'projects'], queryFn: () => api.get<{ projects: PortalProject[] }>('/api/portal/projects') });
  const firstName = me.client.name.split(' ')[0];
  return (
    <div className="animate-enter">
      <h1 className="text-[24px] font-semibold tracking-tight">Hi {firstName}</h1>
      <p className="mt-1 text-[13.5px] text-ink-3">{me.client.service_package ?? 'Your projects with us'}</p>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-6">
        {[
          ['Waiting for your review', me.counts.awaiting_review, me.counts.awaiting_review ? 'text-accent-ink' : ''],
          ['Active projects', me.counts.active_projects, ''],
          ['Ready to download', me.counts.downloads, ''],
          ['Open invoices', me.counts.open_invoices, ''],
        ].map(([label, value, cls]) => (
          <Card key={label as string} className="p-4">
            <div className="text-[12px] text-ink-3">{label as string}</div>
            <div className={cx('text-[24px] font-semibold mt-1', cls as string)}>{value as number}</div>
          </Card>
        ))}
      </div>
      <h2 className="text-[15px] font-semibold mt-8 mb-3">Projects</h2>
      {isLoading ? (
        <PageSkeleton />
      ) : error ? (
        <ErrorState error={error} onRetry={() => refetch()} />
      ) : (data?.projects ?? []).length === 0 ? (
        <Card>
          <EmptyState icon={<FolderKanban className="size-5" />} title="No projects to show yet" body="Your projects will appear here once production starts." />
        </Card>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {data!.projects.map((p) => {
            const pct = p.deliverable_count ? (p.delivered_count ?? 0) / p.deliverable_count : 0;
            return (
              <Link key={p.id} to={`/portal/projects/${p.id}`} className="card p-5 hover:border-white/[0.14] transition-colors block">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="text-[14.5px] font-semibold truncate">{p.name}</h3>
                    <p className="text-[12.5px] text-ink-3">{PROJECT_TYPE_LABELS[p.type as keyof typeof PROJECT_TYPE_LABELS]}</p>
                  </div>
                  {p.awaiting_review ? <Badge tone="accent">{p.awaiting_review} to review</Badge> : p.status === 'delivered' ? <Badge tone="good">Delivered</Badge> : null}
                </div>
                <div className="mt-4 h-1.5 rounded-full bg-series-1/15 overflow-hidden">
                  <div className="h-full rounded-full bg-series-1" style={{ width: `${pct * 100}%` }} />
                </div>
                <div className="mt-2 flex justify-between text-[12px] text-ink-3">
                  <span>
                    {p.delivered_count}/{p.deliverable_count} delivered
                  </span>
                  <span>{p.deadline ? `Due ${formatDate(p.deadline, today)}` : ''}</span>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ReviewDialog({ d, mode, onClose }: { d: PortalDeliverable | null; mode: 'approve' | 'changes' | 'comment'; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [body, setBody] = useState('');
  const [timecode, setTimecode] = useState('');
  const send = useMutation({
    mutationFn: () => {
      const path = mode === 'approve' ? 'approve' : mode === 'changes' ? 'request-changes' : 'feedback';
      return api.post(`/api/portal/deliverables/${d!.id}/${path}`, { body: body || undefined, timecode: timecode || undefined });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['portal'] });
      toast.success(mode === 'approve' ? 'Approved — thank you! The team has been notified.' : mode === 'changes' ? 'Change request sent to the team.' : 'Comment sent.');
      onClose();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    send.mutate();
  };
  const needsBody = mode !== 'approve';
  return (
    <Dialog
      open={!!d}
      onClose={onClose}
      size="sm"
      title={mode === 'approve' ? `Approve “${d?.title}”` : mode === 'changes' ? `Request changes on “${d?.title}”` : `Comment on “${d?.title}”`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={send.isPending} disabled={needsBody && !body.trim()} onClick={() => send.mutate()}>
            {mode === 'approve' ? 'Approve' : 'Send'}
          </Button>
        </>
      }
    >
      <form onSubmit={submit} className="flex flex-col gap-3">
        {mode === 'approve' && <p className="text-[13px] text-ink-2">Approving tells the team this version is final. You’ll get the download link once it’s delivered.</p>}
        {mode === 'changes' && <p className="text-[13px] text-ink-2">Be as specific as you can. Timecodes help a lot (e.g. 00:42).</p>}
        <textarea className="field-input" rows={5} autoFocus placeholder={mode === 'approve' ? 'Optional note for the team' : 'What should change?'} value={body} onChange={(e) => setBody(e.target.value)} aria-label="Message" />
        {mode !== 'approve' && <Input aria-label="Timecode" placeholder="Timecode (optional), e.g. 00:42" value={timecode} onChange={(e) => setTimecode(e.target.value)} />}
        {send.error && <Notice tone="bad">{errorMessage(send.error)}</Notice>}
      </form>
    </Dialog>
  );
}

function ProjectView() {
  const { id } = useParams();
  const today = useToday();
  const [review, setReview] = useState<{ d: PortalDeliverable; mode: 'approve' | 'changes' | 'comment' } | null>(null);
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['portal', 'project', id], queryFn: () => api.get<{ project: PortalProject; deliverables: PortalDeliverable[]; feedback: PortalFeedback[] }>(`/api/portal/projects/${id}`) });
  if (isLoading) return <PageSkeleton />;
  if (error || !data) return <ErrorState error={error} onRetry={() => refetch()} />;
  const p = data.project;
  const toReview = data.deliverables.filter((d) => d.can_review);
  return (
    <div className="animate-enter">
      <Link to="/portal" className="inline-flex items-center gap-1 text-[12.5px] text-ink-3 hover:text-ink mb-3">
        <ArrowLeft className="size-3.5" /> All projects
      </Link>
      <h1 className="text-[24px] font-semibold tracking-tight">{p.name}</h1>
      <p className="mt-1 text-[13.5px] text-ink-3">
        {PROJECT_TYPE_LABELS[p.type as keyof typeof PROJECT_TYPE_LABELS]}
        {p.deadline ? ` · due ${formatDateLong(p.deadline)}` : ''}
      </p>
      {toReview.length > 0 && (
        <Notice tone="info" className="mt-5">
          {toReview.length} video{toReview.length > 1 ? 's are' : ' is'} ready for your review. Open the review link, then approve or request changes below.
        </Notice>
      )}
      <Card className="mt-5">
        <CardHeader title="Deliverables" />
        <ul className="divide-y divide-line">
          {data.deliverables.map((d) => {
            const fb = data.feedback.filter((f) => f.deliverable_id === d.id);
            return (
              <li key={d.id} className="px-5 py-4">
                <div className="flex flex-wrap items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-[14px] font-medium text-ink">{d.title}</div>
                    <div className="text-[12px] text-ink-3">
                      {[d.platform ? PLATFORM_LABELS[d.platform as keyof typeof PLATFORM_LABELS] : null, d.format, d.deadline ? `due ${formatDate(d.deadline, today)}` : null, d.revision_count ? `${d.revision_count} revision round${d.revision_count > 1 ? 's' : ''}` : null].filter(Boolean).join(' · ')}
                    </div>
                  </div>
                  <Badge tone={statusTone(d.status)}>{d.status_label}</Badge>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {safeHref(d.review_url) && (
                    <Button size="sm" href={safeHref(d.review_url)} icon={<Eye className="size-3.5" />}>
                      Open review link
                    </Button>
                  )}
                  {safeHref(d.final_url) && (
                    <Button size="sm" variant="primary" href={safeHref(d.final_url)} icon={<Download className="size-3.5" />}>
                      Download final
                    </Button>
                  )}
                  {d.can_review && (
                    <>
                      <Button size="sm" variant="primary" icon={<CheckCircle2 className="size-3.5" />} onClick={() => setReview({ d, mode: 'approve' })}>
                        Approve
                      </Button>
                      <Button size="sm" icon={<RotateCcw className="size-3.5" />} onClick={() => setReview({ d, mode: 'changes' })}>
                        Request changes
                      </Button>
                    </>
                  )}
                  <Button size="sm" variant="ghost" icon={<MessageSquare className="size-3.5" />} onClick={() => setReview({ d, mode: 'comment' })}>
                    Comment
                  </Button>
                </div>
                {fb.length > 0 && (
                  <ol className="mt-3 flex flex-col gap-2">
                    {fb.map((f) => (
                      <li key={f.id} className={cx('rounded-xl p-3 text-[12.5px]', f.author_type === 'client' ? 'bg-accent/[0.06] ring-1 ring-inset ring-accent/15' : 'bg-white/[0.03]')}>
                        <div className="text-ink-3 mb-0.5">
                          <span className="text-ink-2 font-medium">{f.author_type === 'client' ? 'You' : f.author_name}</span> · {f.kind === 'revision_request' ? 'requested changes' : f.kind === 'approval' ? 'approved' : 'commented'}
                          {f.timecode ? ` @ ${f.timecode}` : ''} · {timeAgo(f.created_at)}
                        </div>
                        <p className="text-ink-2 whitespace-pre-wrap">{f.body}</p>
                      </li>
                    ))}
                  </ol>
                )}
              </li>
            );
          })}
          {data.deliverables.length === 0 && <li className="px-5 py-8 text-center text-[13px] text-ink-3">Nothing scheduled yet.</li>}
        </ul>
      </Card>
      {data.feedback.some((f) => !f.deliverable_id) && (
        <Card className="mt-4 p-5">
          <h2 className="text-[14px] font-semibold mb-2">Project notes</h2>
          <ol className="flex flex-col gap-2">
            {data.feedback
              .filter((f) => !f.deliverable_id)
              .map((f) => (
                <li key={f.id} className="text-[12.5px] text-ink-2">
                  <span className="text-ink-3">{f.author_type === 'client' ? 'You' : f.author_name}: </span>
                  {f.body}
                </li>
              ))}
          </ol>
        </Card>
      )}
      <ReviewDialog d={review?.d ?? null} mode={review?.mode ?? 'comment'} onClose={() => setReview(null)} />
    </div>
  );
}

function Invoices() {
  const today = useToday();
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['portal', 'invoices'], queryFn: () => api.get<{ invoices: { id: number; number: string; issue_date: string; due_date: string; status: InvoiceStatus; currency: string; total_minor: number; paid_minor: number; balance_minor: number; project_name: string | null }[] }>('/api/portal/invoices') });
  if (isLoading) return <PageSkeleton />;
  if (error || !data) return <ErrorState error={error} onRetry={() => refetch()} />;
  return (
    <div className="animate-enter">
      <h1 className="text-[24px] font-semibold tracking-tight mb-1">Invoices</h1>
      <p className="text-[13.5px] text-ink-3 mb-6">Your invoices and what is still due.</p>
      <Card>
        {data.invoices.length === 0 ? (
          <EmptyState icon={<FileText className="size-5" />} title="No invoices yet" />
        ) : (
          <ul className="divide-y divide-line">
            {data.invoices.map((i) => (
              <li key={i.id}>
                <Link to={`/portal/invoices/${i.id}`} className="flex flex-wrap items-center gap-3 px-5 py-3.5 hover:bg-white/[0.02]">
                  <div className="min-w-0 flex-1">
                    <div className="text-[13.5px] font-medium text-ink">{i.number}</div>
                    <div className="text-[12px] text-ink-3">
                      Issued {formatDate(i.issue_date, today)} · due {formatDate(i.due_date, today)}
                      {i.project_name ? ` · ${i.project_name}` : ''}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-[13.5px] tabular">{formatMoney(i.total_minor, i.currency, { decimals: 'always' })}</div>
                    {i.balance_minor > 0 && i.status !== 'void' && <div className="text-[12px] text-ink-3 tabular">{formatMoney(i.balance_minor, i.currency, { decimals: 'always' })} due</div>}
                  </div>
                  <InvoiceStatusBadge status={i.status} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function InvoiceView() {
  const { id } = useParams();
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['portal', 'invoice', id], queryFn: () => api.get<{ invoice: InvoiceDetail; business: BusinessProfile }>(`/api/portal/invoices/${id}`) });
  if (isLoading) return <PageSkeleton />;
  if (error || !data) return <ErrorState error={error} onRetry={() => refetch()} />;
  return (
    <div className="animate-enter">
      <div className="flex items-center justify-between gap-3 mb-4 no-print">
        <Link to="/portal/invoices" className="inline-flex items-center gap-1 text-[12.5px] text-ink-3 hover:text-ink">
          <ArrowLeft className="size-3.5" /> Invoices
        </Link>
        <Button icon={<Printer className="size-4" />} href={`/portal/invoices/${data.invoice.id}/print`}>
          Print / PDF
        </Button>
      </div>
      <InvoiceDocument invoice={data.invoice} business={data.business} className="max-w-[820px]" />
    </div>
  );
}

export default function PortalApp() {
  const { data: me, isLoading, error, refetch } = useQuery({ queryKey: ['portal', 'me'], queryFn: () => api.get<Me>('/api/portal/me') });
  return (
    <Routes>
      <Route path="invoices/:id/print" element={<InvoicePrintPage portal />} />
      <Route
        path="*"
        element={
          <Shell me={me}>
            {isLoading ? (
              <PageSkeleton />
            ) : error || !me ? (
              <ErrorState error={error} onRetry={() => refetch()} />
            ) : (
              <Routes>
                <Route index element={<Home me={me} />} />
                <Route path="projects/:id" element={<ProjectView />} />
                <Route path="invoices" element={<Invoices />} />
                <Route path="invoices/:id" element={<InvoiceView />} />
                <Route path="account" element={<ChangePasswordPage />} />
                <Route path="*" element={<EmptyState title="Page not found" />} />
              </Routes>
            )}
          </Shell>
        }
      />
    </Routes>
  );
}
