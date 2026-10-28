import { lazy, Suspense, useEffect, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { Lock } from 'lucide-react';
import { queryClient, useAuth, useIsAdmin } from './lib/queries.ts';
import { ConfirmProvider, ToastProvider } from './components/overlay.tsx';
import { AppShell } from './components/layout.tsx';
import { EmptyState, ErrorState, Spinner } from './components/ui.tsx';
import { ChangePasswordPage, LoginPage, SetupPage } from './pages/Auth.tsx';

const Dashboard = lazy(() => import('./pages/Dashboard.tsx'));
const Clients = lazy(() => import('./pages/Clients.tsx'));
const ClientDetail = lazy(() => import('./pages/ClientDetail.tsx'));
const Projects = lazy(() => import('./pages/Projects.tsx'));
const ProjectDetail = lazy(() => import('./pages/ProjectDetail.tsx'));
const CalendarPage = lazy(() => import('./pages/Calendar.tsx'));
const Invoices = lazy(() => import('./pages/Invoices.tsx'));
const InvoiceEditor = lazy(() => import('./pages/InvoiceEditor.tsx'));
const InvoiceDetail = lazy(() => import('./pages/InvoiceDetail.tsx'));
const InvoicePrint = lazy(() => import('./pages/InvoicePrint.tsx'));
const Payments = lazy(() => import('./pages/Payments.tsx'));
const Expenses = lazy(() => import('./pages/Expenses.tsx'));
const Finance = lazy(() => import('./pages/Finance.tsx'));
const Reports = lazy(() => import('./pages/Reports.tsx'));
const Pipeline = lazy(() => import('./pages/Pipeline.tsx'));
const Tasks = lazy(() => import('./pages/Tasks.tsx'));
const Team = lazy(() => import('./pages/Team.tsx'));
const Notifications = lazy(() => import('./pages/Notifications.tsx'));
const Automations = lazy(() => import('./pages/Automations.tsx'));
const SettingsPage = lazy(() => import('./pages/Settings.tsx'));
const PortalApp = lazy(() => import('./portal/Portal.tsx'));

function FullScreen({ children }: { children: ReactNode }) {
  return <div className="min-h-dvh grid place-items-center">{children}</div>;
}

function AdminOnly({ children }: { children: ReactNode }) {
  const admin = useIsAdmin();
  if (!admin)
    return (
      <div className="card">
        <EmptyState icon={<Lock className="size-5" />} title="Owner and admins only" body="Money, sales and settings are visible to the agency owner and admins. Ask the owner if you need access." />
      </div>
    );
  return <>{children}</>;
}

function NotFound() {
  return (
    <div className="card">
      <EmptyState title="Page not found" body="That page does not exist (or moved)." />
    </div>
  );
}

function Gate() {
  const { data, isLoading, error, refetch } = useAuth();
  const qc = useQueryClient();
  useEffect(() => {
    const onUnauthorized = () => qc.invalidateQueries({ queryKey: ['auth'] });
    window.addEventListener('yfx:unauthorized', onUnauthorized);
    return () => window.removeEventListener('yfx:unauthorized', onUnauthorized);
  }, [qc]);

  if (isLoading)
    return (
      <FullScreen>
        <Spinner />
      </FullScreen>
    );
  if (error || !data)
    return (
      <FullScreen>
        <ErrorState error={error} onRetry={() => refetch()} />
      </FullScreen>
    );
  if (data.needs_setup)
    return (
      <Routes>
        <Route path="*" element={<SetupPage />} />
      </Routes>
    );
  if (!data.user)
    return (
      <Routes>
        <Route path="*" element={<LoginPage />} />
      </Routes>
    );
  if (data.user.must_change_password) return <ChangePasswordPage forced />;

  if (data.user.role === 'client')
    return (
      <Suspense
        fallback={
          <FullScreen>
            <Spinner />
          </FullScreen>
        }
      >
        <Routes>
          <Route path="/portal/*" element={<PortalApp />} />
          <Route path="*" element={<Navigate to="/portal" replace />} />
        </Routes>
      </Suspense>
    );

  return (
    <Suspense
      fallback={
        <FullScreen>
          <Spinner />
        </FullScreen>
      }
    >
      <Routes>
        <Route path="/invoices/:id/print" element={<InvoicePrint />} />
        <Route element={<AppShell />}>
          <Route index element={<Dashboard />} />
          <Route path="clients" element={<Clients />} />
          <Route path="clients/:id" element={<ClientDetail />} />
          <Route path="projects" element={<Projects />} />
          <Route path="projects/:id" element={<ProjectDetail />} />
          <Route path="calendar" element={<CalendarPage />} />
          <Route path="tasks" element={<Tasks />} />
          <Route path="team" element={<Team />} />
          <Route path="notifications" element={<Notifications />} />
          <Route path="account" element={<ChangePasswordPage />} />
          <Route path="invoices" element={<AdminOnly><Invoices /></AdminOnly>} />
          <Route path="invoices/new" element={<AdminOnly><InvoiceEditor /></AdminOnly>} />
          <Route path="invoices/:id" element={<AdminOnly><InvoiceDetail /></AdminOnly>} />
          <Route path="invoices/:id/edit" element={<AdminOnly><InvoiceEditor /></AdminOnly>} />
          <Route path="payments" element={<AdminOnly><Payments /></AdminOnly>} />
          <Route path="expenses" element={<AdminOnly><Expenses /></AdminOnly>} />
          <Route path="finance" element={<AdminOnly><Finance /></AdminOnly>} />
          <Route path="reports" element={<AdminOnly><Reports /></AdminOnly>} />
          <Route path="pipeline" element={<AdminOnly><Pipeline /></AdminOnly>} />
          <Route path="automations" element={<AdminOnly><Automations /></AdminOnly>} />
          <Route path="settings" element={<AdminOnly><SettingsPage /></AdminOnly>} />
          <Route path="*" element={<NotFound />} />
        </Route>
        <Route path="/login" element={<Navigate to="/" replace />} />
        <Route path="/portal/*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <ConfirmProvider>
          <BrowserRouter>
            <Gate />
          </BrowserRouter>
        </ConfirmProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
}
