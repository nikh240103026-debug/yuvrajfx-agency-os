// Shared enums and labels. The server validates against these and the web app renders their labels,
// so a value can never exist on one side without the other knowing about it.

type Option<V extends string> = { readonly value: V; readonly label: string };

function labels<V extends string>(options: readonly Option<V>[]): Record<V, string> {
  return Object.fromEntries(options.map((o) => [o.value, o.label])) as Record<V, string>;
}
function values<V extends string>(options: readonly Option<V>[]): [V, ...V[]] {
  return options.map((o) => o.value) as [V, ...V[]];
}

// ── Roles ────────────────────────────────────────────────────────────────────
export const ROLE_OPTIONS = [
  { value: 'owner', label: 'Owner' },
  { value: 'admin', label: 'Admin' },
  { value: 'member', label: 'Team member' },
  { value: 'client', label: 'Client (portal)' },
] as const;
export type Role = (typeof ROLE_OPTIONS)[number]['value'];
export const ROLES = values(ROLE_OPTIONS);
export const ROLE_LABELS = labels(ROLE_OPTIONS);
export const STAFF_ROLES: readonly Role[] = ['owner', 'admin', 'member'];
export const ADMIN_ROLES: readonly Role[] = ['owner', 'admin'];

// ── Clients ──────────────────────────────────────────────────────────────────
export const CLIENT_STATUS_OPTIONS = [
  { value: 'onboarding', label: 'Onboarding' },
  { value: 'active', label: 'Active' },
  { value: 'paused', label: 'Paused' },
  { value: 'completed', label: 'Completed' },
  { value: 'churned', label: 'Churned' },
] as const;
export type ClientStatus = (typeof CLIENT_STATUS_OPTIONS)[number]['value'];
export const CLIENT_STATUSES = values(CLIENT_STATUS_OPTIONS);
export const CLIENT_STATUS_LABELS = labels(CLIENT_STATUS_OPTIONS);

export const BILLING_CYCLE_OPTIONS = [
  { value: 'monthly', label: 'Monthly' },
  { value: 'quarterly', label: 'Quarterly' },
  { value: 'yearly', label: 'Yearly' },
] as const;
export type BillingCycle = (typeof BILLING_CYCLE_OPTIONS)[number]['value'];
export const BILLING_CYCLES = values(BILLING_CYCLE_OPTIONS);
export const BILLING_CYCLE_LABELS = labels(BILLING_CYCLE_OPTIONS);
/** Months covered by one billing cycle, used to normalise retainers into MRR. */
export const BILLING_CYCLE_MONTHS: Record<BillingCycle, number> = { monthly: 1, quarterly: 3, yearly: 12 };

export const SOCIAL_KEYS = ['instagram', 'youtube', 'tiktok', 'x', 'linkedin', 'other'] as const;
export type SocialKey = (typeof SOCIAL_KEYS)[number];
export const SOCIAL_LABELS: Record<SocialKey, string> = {
  instagram: 'Instagram',
  youtube: 'YouTube',
  tiktok: 'TikTok',
  x: 'X / Twitter',
  linkedin: 'LinkedIn',
  other: 'Other link',
};

export const COMM_CHANNEL_OPTIONS = [
  { value: 'email', label: 'Email' },
  { value: 'call', label: 'Call' },
  { value: 'meeting', label: 'Meeting' },
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'dm', label: 'DM' },
  { value: 'note', label: 'Note' },
  { value: 'other', label: 'Other' },
] as const;
export type CommChannel = (typeof COMM_CHANNEL_OPTIONS)[number]['value'];
export const COMM_CHANNELS = values(COMM_CHANNEL_OPTIONS);
export const COMM_CHANNEL_LABELS = labels(COMM_CHANNEL_OPTIONS);

export const COMM_DIRECTION_OPTIONS = [
  { value: 'outbound', label: 'Outbound' },
  { value: 'inbound', label: 'Inbound' },
  { value: 'internal', label: 'Internal' },
] as const;
export type CommDirection = (typeof COMM_DIRECTION_OPTIONS)[number]['value'];
export const COMM_DIRECTIONS = values(COMM_DIRECTION_OPTIONS);
export const COMM_DIRECTION_LABELS = labels(COMM_DIRECTION_OPTIONS);

// ── Projects & deliverables ──────────────────────────────────────────────────
export const PROJECT_TYPE_OPTIONS = [
  { value: 'short_form', label: 'Short-form' },
  { value: 'long_form', label: 'Long-form YouTube' },
  { value: 'ad', label: 'Video ad' },
  { value: 'motion_graphics', label: 'Motion graphics' },
  { value: 'thumbnail', label: 'Thumbnails & assets' },
  { value: 'other', label: 'Other' },
] as const;
export type ProjectType = (typeof PROJECT_TYPE_OPTIONS)[number]['value'];
export const PROJECT_TYPES = values(PROJECT_TYPE_OPTIONS);
export const PROJECT_TYPE_LABELS = labels(PROJECT_TYPE_OPTIONS);

/** Service lines used for "revenue by service". Retainer covers monthly packages. */
export const SERVICE_TYPE_OPTIONS = [
  { value: 'retainer', label: 'Retainer' },
  ...PROJECT_TYPE_OPTIONS,
] as const;
export type ServiceType = (typeof SERVICE_TYPE_OPTIONS)[number]['value'];
export const SERVICE_TYPES = values(SERVICE_TYPE_OPTIONS);
export const SERVICE_TYPE_LABELS = labels(SERVICE_TYPE_OPTIONS);

/** The production stages a deliverable moves through, in order. */
export const STAGE_OPTIONS = [
  { value: 'backlog', label: 'Backlog' },
  { value: 'editing', label: 'Editing' },
  { value: 'internal_review', label: 'Internal review' },
  { value: 'client_review', label: 'Client review' },
  { value: 'revisions', label: 'Revisions' },
  { value: 'approved', label: 'Approved' },
  { value: 'delivered', label: 'Delivered' },
] as const;
export type Stage = (typeof STAGE_OPTIONS)[number]['value'];
export const STAGES = values(STAGE_OPTIONS);
export const STAGE_LABELS = labels(STAGE_OPTIONS);

/** Projects use the same stages plus two parking states. */
export const PROJECT_STATUS_OPTIONS = [
  ...STAGE_OPTIONS,
  { value: 'on_hold', label: 'On hold' },
  { value: 'cancelled', label: 'Cancelled' },
] as const;
export type ProjectStatus = (typeof PROJECT_STATUS_OPTIONS)[number]['value'];
export const PROJECT_STATUSES = values(PROJECT_STATUS_OPTIONS);
export const PROJECT_STATUS_LABELS = labels(PROJECT_STATUS_OPTIONS);
/** Statuses that still count as live production work. */
export const ACTIVE_PROJECT_STATUSES: readonly ProjectStatus[] = [
  'backlog',
  'editing',
  'internal_review',
  'client_review',
  'revisions',
  'approved',
];

/** Client-facing wording for each stage in the portal. Internal stages are not exposed as such. */
export const PORTAL_STAGE_LABELS: Record<Stage, string> = {
  backlog: 'Scheduled',
  editing: 'In production',
  internal_review: 'In production',
  client_review: 'Ready for your review',
  revisions: 'Revisions in progress',
  approved: 'Approved',
  delivered: 'Delivered',
};

export const BILLING_TYPE_OPTIONS = [
  { value: 'fixed', label: 'Fixed price' },
  { value: 'retainer', label: 'Covered by retainer' },
  { value: 'hourly', label: 'Hourly' },
] as const;
export type BillingType = (typeof BILLING_TYPE_OPTIONS)[number]['value'];
export const BILLING_TYPES = values(BILLING_TYPE_OPTIONS);
export const BILLING_TYPE_LABELS = labels(BILLING_TYPE_OPTIONS);

export const PRIORITY_OPTIONS = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'urgent', label: 'Urgent' },
] as const;
export type Priority = (typeof PRIORITY_OPTIONS)[number]['value'];
export const PRIORITIES = values(PRIORITY_OPTIONS);
export const PRIORITY_LABELS = labels(PRIORITY_OPTIONS);
export const PRIORITY_RANK: Record<Priority, number> = { urgent: 0, high: 1, medium: 2, low: 3 };

export const PLATFORM_OPTIONS = [
  { value: 'youtube', label: 'YouTube' },
  { value: 'youtube_shorts', label: 'YouTube Shorts' },
  { value: 'instagram', label: 'Instagram Reels' },
  { value: 'tiktok', label: 'TikTok' },
  { value: 'linkedin', label: 'LinkedIn' },
  { value: 'x', label: 'X / Twitter' },
  { value: 'facebook', label: 'Facebook' },
  { value: 'meta_ads', label: 'Meta ads' },
  { value: 'google_ads', label: 'Google / YouTube ads' },
  { value: 'website', label: 'Website' },
  { value: 'other', label: 'Other' },
] as const;
export type Platform = (typeof PLATFORM_OPTIONS)[number]['value'];
export const PLATFORMS = values(PLATFORM_OPTIONS);
export const PLATFORM_LABELS = labels(PLATFORM_OPTIONS);

export const FORMAT_SUGGESTIONS = [
  '9:16 vertical · 1080×1920',
  '16:9 horizontal · 1920×1080',
  '16:9 horizontal · 4K',
  '1:1 square · 1080×1080',
  '4:5 portrait · 1080×1350',
  'Thumbnail · 1280×720',
] as const;

export const FEEDBACK_KIND_OPTIONS = [
  { value: 'comment', label: 'Comment' },
  { value: 'revision_request', label: 'Revision request' },
  { value: 'approval', label: 'Approval' },
  { value: 'internal_note', label: 'Internal note' },
] as const;
export type FeedbackKind = (typeof FEEDBACK_KIND_OPTIONS)[number]['value'];
export const FEEDBACK_KINDS = values(FEEDBACK_KIND_OPTIONS);
export const FEEDBACK_KIND_LABELS = labels(FEEDBACK_KIND_OPTIONS);

// ── Invoices & payments ──────────────────────────────────────────────────────
export const INVOICE_STATE_OPTIONS = [
  { value: 'draft', label: 'Draft' },
  { value: 'sent', label: 'Sent' },
  { value: 'void', label: 'Void' },
] as const;
export type InvoiceState = (typeof INVOICE_STATE_OPTIONS)[number]['value'];
export const INVOICE_STATES = values(INVOICE_STATE_OPTIONS);

/** Derived status: computed from state, payments and the due date — never stored. */
export const INVOICE_STATUS_OPTIONS = [
  { value: 'draft', label: 'Draft' },
  { value: 'sent', label: 'Sent' },
  { value: 'partially_paid', label: 'Partially paid' },
  { value: 'paid', label: 'Paid' },
  { value: 'overdue', label: 'Overdue' },
  { value: 'void', label: 'Void' },
] as const;
export type InvoiceStatus = (typeof INVOICE_STATUS_OPTIONS)[number]['value'];
export const INVOICE_STATUSES = values(INVOICE_STATUS_OPTIONS);
export const INVOICE_STATUS_LABELS = labels(INVOICE_STATUS_OPTIONS);

export const DISCOUNT_TYPE_OPTIONS = [
  { value: 'none', label: 'No discount' },
  { value: 'percent', label: 'Percent' },
  { value: 'fixed', label: 'Fixed amount' },
] as const;
export type DiscountType = (typeof DISCOUNT_TYPE_OPTIONS)[number]['value'];
export const DISCOUNT_TYPES = values(DISCOUNT_TYPE_OPTIONS);

export const PAYMENT_METHOD_OPTIONS = [
  { value: 'bank_transfer', label: 'Bank transfer' },
  { value: 'upi', label: 'UPI' },
  { value: 'paypal', label: 'PayPal' },
  { value: 'wise', label: 'Wise' },
  { value: 'payoneer', label: 'Payoneer' },
  { value: 'stripe', label: 'Stripe' },
  { value: 'cash', label: 'Cash' },
  { value: 'other', label: 'Other' },
] as const;
export type PaymentMethod = (typeof PAYMENT_METHOD_OPTIONS)[number]['value'];
export const PAYMENT_METHODS = values(PAYMENT_METHOD_OPTIONS);
export const PAYMENT_METHOD_LABELS = labels(PAYMENT_METHOD_OPTIONS);

// ── Expenses ─────────────────────────────────────────────────────────────────
export const EXPENSE_CATEGORY_OPTIONS = [
  { value: 'software', label: 'Software & subscriptions' },
  { value: 'freelancers', label: 'Freelancers & contractors' },
  { value: 'stock_assets', label: 'Stock footage & assets' },
  { value: 'music_licensing', label: 'Music & licensing' },
  { value: 'hardware', label: 'Hardware & gear' },
  { value: 'marketing', label: 'Marketing & ads' },
  { value: 'internet_phone', label: 'Internet & phone' },
  { value: 'office', label: 'Office & utilities' },
  { value: 'education', label: 'Courses & education' },
  { value: 'travel', label: 'Travel' },
  { value: 'payment_fees', label: 'Payment & bank fees' },
  { value: 'taxes_fees', label: 'Taxes & government fees' },
  { value: 'other', label: 'Other' },
] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORY_OPTIONS)[number]['value'];
export const EXPENSE_CATEGORIES = values(EXPENSE_CATEGORY_OPTIONS);
export const EXPENSE_CATEGORY_LABELS = labels(EXPENSE_CATEGORY_OPTIONS);

// ── Sales pipeline ───────────────────────────────────────────────────────────
export const LEAD_STAGE_OPTIONS = [
  { value: 'lead', label: 'Lead' },
  { value: 'contacted', label: 'Contacted' },
  { value: 'replied', label: 'Replied' },
  { value: 'discovery_call', label: 'Discovery call' },
  { value: 'proposal_sent', label: 'Proposal sent' },
  { value: 'negotiation', label: 'Negotiation' },
  { value: 'won', label: 'Won' },
  { value: 'lost', label: 'Lost' },
] as const;
export type LeadStage = (typeof LEAD_STAGE_OPTIONS)[number]['value'];
export const LEAD_STAGES = values(LEAD_STAGE_OPTIONS);
export const LEAD_STAGE_LABELS = labels(LEAD_STAGE_OPTIONS);
/** Stages still in play, in funnel order. */
export const OPEN_LEAD_STAGES: readonly LeadStage[] = [
  'lead',
  'contacted',
  'replied',
  'discovery_call',
  'proposal_sent',
  'negotiation',
];
/** Default close probability per stage, used only for the clearly-labelled weighted pipeline value. */
export const LEAD_STAGE_PROBABILITY: Record<LeadStage, number> = {
  lead: 0.05,
  contacted: 0.1,
  replied: 0.2,
  discovery_call: 0.35,
  proposal_sent: 0.5,
  negotiation: 0.7,
  won: 1,
  lost: 0,
};

export const LEAD_SOURCE_OPTIONS = [
  { value: 'referral', label: 'Referral' },
  { value: 'cold_email', label: 'Cold email' },
  { value: 'cold_dm', label: 'Cold DM' },
  { value: 'instagram', label: 'Instagram' },
  { value: 'linkedin', label: 'LinkedIn' },
  { value: 'x', label: 'X / Twitter' },
  { value: 'youtube', label: 'YouTube' },
  { value: 'upwork', label: 'Upwork' },
  { value: 'fiverr', label: 'Fiverr' },
  { value: 'website', label: 'Website / inbound' },
  { value: 'event', label: 'Event / community' },
  { value: 'other', label: 'Other' },
] as const;
export type LeadSource = (typeof LEAD_SOURCE_OPTIONS)[number]['value'];
export const LEAD_SOURCES = values(LEAD_SOURCE_OPTIONS);
export const LEAD_SOURCE_LABELS = labels(LEAD_SOURCE_OPTIONS);

export const DEAL_TYPE_OPTIONS = [
  { value: 'retainer', label: 'Monthly retainer' },
  { value: 'one_time', label: 'One-time project' },
] as const;
export type DealType = (typeof DEAL_TYPE_OPTIONS)[number]['value'];
export const DEAL_TYPES = values(DEAL_TYPE_OPTIONS);
export const DEAL_TYPE_LABELS = labels(DEAL_TYPE_OPTIONS);

// ── Tasks & recurrence ───────────────────────────────────────────────────────
export const TASK_STATUS_OPTIONS = [
  { value: 'todo', label: 'To do' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'done', label: 'Done' },
  { value: 'cancelled', label: 'Cancelled' },
] as const;
export type TaskStatus = (typeof TASK_STATUS_OPTIONS)[number]['value'];
export const TASK_STATUSES = values(TASK_STATUS_OPTIONS);
export const TASK_STATUS_LABELS = labels(TASK_STATUS_OPTIONS);

export const FREQUENCY_OPTIONS = [
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'quarterly', label: 'Quarterly' },
  { value: 'yearly', label: 'Yearly' },
] as const;
export type Frequency = (typeof FREQUENCY_OPTIONS)[number]['value'];
export const FREQUENCIES = values(FREQUENCY_OPTIONS);
export const FREQUENCY_LABELS = labels(FREQUENCY_OPTIONS);

export const RECURRING_KIND_OPTIONS = [
  { value: 'task', label: 'Task' },
  { value: 'project', label: 'Project' },
] as const;
export type RecurringKind = (typeof RECURRING_KIND_OPTIONS)[number]['value'];
export const RECURRING_KINDS = values(RECURRING_KIND_OPTIONS);

export const WEEKDAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

// ── Team ─────────────────────────────────────────────────────────────────────
export const COST_UNIT_OPTIONS = [
  { value: 'hour', label: 'per hour' },
  { value: 'video', label: 'per video' },
  { value: 'project', label: 'per project' },
  { value: 'month', label: 'per month' },
] as const;
export type CostUnit = (typeof COST_UNIT_OPTIONS)[number]['value'];
export const COST_UNITS = values(COST_UNIT_OPTIONS);
export const COST_UNIT_LABELS = labels(COST_UNIT_OPTIONS);

// ── Automations ──────────────────────────────────────────────────────────────
export const AUTOMATION_KEYS = [
  'deadline_reminders',
  'overdue_invoice_reminders',
  'renewal_reminders',
  'follow_up_reminders',
  'recurring_work',
  'monthly_revenue_summary',
  'weekly_report',
] as const;
export type AutomationKey = (typeof AUTOMATION_KEYS)[number];

export const OUTBOX_STATUS_OPTIONS = [
  { value: 'pending_approval', label: 'Waiting for approval' },
  { value: 'sent', label: 'Sent' },
  { value: 'sent_manually', label: 'Sent manually' },
  { value: 'failed', label: 'Failed' },
  { value: 'rejected', label: 'Discarded' },
] as const;
export type OutboxStatus = (typeof OUTBOX_STATUS_OPTIONS)[number]['value'];
export const OUTBOX_STATUSES = values(OUTBOX_STATUS_OPTIONS);
export const OUTBOX_STATUS_LABELS = labels(OUTBOX_STATUS_OPTIONS);

/** Currencies offered in pickers. Any ISO 4217 code that Intl knows is accepted by the API. */
export const COMMON_CURRENCIES = ['USD', 'INR', 'EUR', 'GBP', 'AED', 'CAD', 'AUD', 'SGD', 'CHF', 'NZD', 'SAR', 'JPY'] as const;
