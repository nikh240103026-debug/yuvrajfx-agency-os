import { useQuery, QueryClient } from '@tanstack/react-query';
import { api, ApiError } from './api.ts';
import type { MoneyGroup } from '../../shared/money.ts';
import type { ClientStatus, Role } from '../../shared/constants.ts';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: true,
      retry: (count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2,
    },
  },
});

export type User = { id: number; email: string; name: string; role: Role; client_id: number | null; team_member_id: number | null; must_change_password: boolean };
export type AuthState = { needs_setup: boolean; user: User | null; client: { id: number; name: string; company: string | null } | null; business_name: string; base_currency: string; today: string; demo_data: boolean };

export function useAuth() {
  return useQuery({ queryKey: ['auth'], queryFn: () => api.get<AuthState>('/api/auth/state'), staleTime: 60_000 });
}

export function useIsAdmin(): boolean {
  const { data } = useAuth();
  return data?.user?.role === 'owner' || data?.user?.role === 'admin';
}

export type ClientRow = {
  id: number;
  name: string;
  company: string | null;
  email: string | null;
  phone: string | null;
  whatsapp: string | null;
  other_contact: string | null;
  website: string | null;
  socials: Record<string, string>;
  billing_address: string | null;
  tax_id: string | null;
  country: string | null;
  timezone: string | null;
  service_package: string | null;
  retainer_minor?: number | null;
  currency: string;
  billing_cycle: 'monthly' | 'quarterly' | 'yearly';
  billing_day: number | null;
  contract_start: string | null;
  renewal_date: string | null;
  payment_terms_days: number;
  payment_terms_note?: string | null;
  status: ClientStatus;
  tags: string[];
  notes: string | null;
  is_demo: number;
  archived_at: string | null;
  created_at: string;
  active_projects?: number;
  open_deliverables?: number;
  next_deadline?: string | null;
  last_activity_at?: string | null;
  portal_users?: number;
  outstanding?: MoneyGroup[];
};

export function useClients(params = '') {
  return useQuery({ queryKey: ['clients', params], queryFn: () => api.get<{ clients: ClientRow[] }>(`/api/clients${params}`) });
}

export type TeamMember = {
  id: number;
  name: string;
  email: string | null;
  title: string;
  skills: string[];
  capacity_hours: number;
  cost_rate_minor?: number | null;
  cost_currency?: string | null;
  cost_unit?: string | null;
  status: 'active' | 'inactive';
  color: string | null;
  notes: string | null;
  is_demo: number;
  workload: {
    open_deliverables: number;
    overdue_deliverables: number;
    due_this_week: number;
    in_review: number;
    hours_booked_week: number;
    hours_open: number;
    utilization: number | null;
    open_tasks: number;
    overdue_tasks: number;
    tasks_due_today: number;
    active_projects: number;
  };
};

export function useTeam() {
  return useQuery({ queryKey: ['team'], queryFn: () => api.get<{ members: TeamMember[]; unassigned_deliverables: number }>('/api/team') });
}

export type ProjectRow = {
  id: number;
  client_id: number;
  client_name: string;
  name: string;
  description: string | null;
  type: string;
  billing_type?: string;
  price_minor?: number | null;
  currency: string;
  start_date: string | null;
  deadline: string | null;
  priority: 'low' | 'medium' | 'high' | 'urgent';
  status: string;
  editor_id: number | null;
  editor_name: string | null;
  editor_color: string | null;
  reference_links: { label: string; url: string }[];
  asset_links: { label: string; url: string }[];
  portal_visible: number;
  deliverable_count: number;
  delivered_count: number;
  overdue_deliverables: number;
  next_deliverable_deadline: string | null;
  revision_total: number;
  is_overdue: number;
  is_demo: number;
  archived_at: string | null;
  completed_at: string | null;
};

export function useProjects(params = '?scope=all') {
  return useQuery({ queryKey: ['projects', params], queryFn: () => api.get<{ projects: ProjectRow[] }>(`/api/projects${params}`) });
}

export type DeliverableRow = {
  id: number;
  project_id: number;
  project_name: string;
  project_type: string;
  project_priority: string;
  client_id: number;
  client_name: string;
  title: string;
  format: string | null;
  platform: string | null;
  deadline: string | null;
  status: string;
  assignee_id: number | null;
  effective_assignee_id: number | null;
  assignee_name: string | null;
  assignee_color: string | null;
  source_url: string | null;
  review_url: string | null;
  final_url: string | null;
  revision_count: number;
  estimated_hours: number | null;
  notes: string | null;
  sort_order: number;
  approved_at: string | null;
  delivered_at: string | null;
  is_overdue: number;
  open_client_feedback: number;
  is_demo: number;
};

/** Today's date as the server sees it (business timezone), refreshed with the auth state. */
export function useToday(): string {
  const { data } = useAuth();
  if (data?.today) return data.today;
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function useBaseCurrency(): string {
  return useAuth().data?.base_currency ?? 'INR';
}

/** Views that aggregate across entities (the client page bundles its projects, deliverables and invoices). */
const SUMMARY_KEYS = ['dashboard', 'notifications', 'activity', 'client', 'team', 'calendar', 'finance', 'report', 'search'];

/** Invalidate the changed entities plus everything that summarises production or money. Only mounted queries refetch. */
export function invalidateAll(qc: QueryClient, ...keys: string[]) {
  for (const k of new Set([...keys, ...SUMMARY_KEYS])) qc.invalidateQueries({ queryKey: [k] });
}
