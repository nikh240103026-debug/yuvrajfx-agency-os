import { AlertCircle, CalendarClock, Flag } from 'lucide-react';
import { Badge, type Tone } from '../components/ui.tsx';
import {
  CLIENT_STATUS_LABELS,
  INVOICE_STATUS_LABELS,
  LEAD_STAGE_LABELS,
  PRIORITY_LABELS,
  PROJECT_STATUS_LABELS,
  STAGES,
  STAGE_LABELS,
  TASK_STATUS_LABELS,
  type ClientStatus,
  type InvoiceStatus,
  type LeadStage,
  type Priority,
  type ProjectStatus,
  type Stage,
} from '../../shared/constants.ts';
import { diffDays, formatDate } from '../../shared/dates.ts';
import { cx } from './util.ts';

export const CYCLE_SHORT = { monthly: 'mo', quarterly: 'qtr', yearly: 'yr' } as const;

export function stageColor(stage: string): string {
  const i = STAGES.indexOf(stage as Stage);
  return i >= 0 ? `var(--color-stage-${i + 1})` : 'var(--color-ink-3)';
}

export function StageBadge({ stage }: { stage: string }) {
  if (stage === 'on_hold') return <Badge tone="warn">On hold</Badge>;
  if (stage === 'cancelled') return <Badge>Cancelled</Badge>;
  return (
    <Badge tone={stage === 'delivered' ? 'good' : stage === 'revisions' ? 'serious' : stage === 'client_review' ? 'accent' : 'neutral'} dot={stageColor(stage)}>
      {STAGE_LABELS[stage as Stage] ?? PROJECT_STATUS_LABELS[stage as ProjectStatus] ?? stage}
    </Badge>
  );
}

const INVOICE_TONES: Record<InvoiceStatus, Tone> = { draft: 'neutral', sent: 'info', partially_paid: 'warn', paid: 'good', overdue: 'bad', void: 'neutral' };
export function InvoiceStatusBadge({ status, daysOverdue }: { status: InvoiceStatus; daysOverdue?: number }) {
  return (
    <Badge tone={INVOICE_TONES[status]}>
      {status === 'overdue' && <AlertCircle className="size-3" aria-hidden />}
      {INVOICE_STATUS_LABELS[status]}
      {status === 'overdue' && daysOverdue ? ` · ${daysOverdue}d` : ''}
    </Badge>
  );
}

const CLIENT_TONES: Record<ClientStatus, Tone> = { onboarding: 'info', active: 'good', paused: 'warn', completed: 'neutral', churned: 'neutral' };
export function ClientStatusBadge({ status }: { status: ClientStatus }) {
  return <Badge tone={CLIENT_TONES[status]}>{CLIENT_STATUS_LABELS[status]}</Badge>;
}

export function LeadStageBadge({ stage }: { stage: LeadStage }) {
  return <Badge tone={stage === 'won' ? 'good' : stage === 'lost' ? 'neutral' : stage === 'negotiation' || stage === 'proposal_sent' ? 'accent' : 'neutral'}>{LEAD_STAGE_LABELS[stage]}</Badge>;
}

export function PriorityBadge({ priority, hideMedium }: { priority: Priority; hideMedium?: boolean }) {
  if (hideMedium && (priority === 'medium' || priority === 'low')) return null;
  const tone: Tone = priority === 'urgent' ? 'bad' : priority === 'high' ? 'serious' : 'neutral';
  return (
    <Badge tone={tone}>
      <Flag className="size-3" aria-hidden />
      {PRIORITY_LABELS[priority]}
    </Badge>
  );
}

export function TaskStatusBadge({ status }: { status: keyof typeof TASK_STATUS_LABELS }) {
  return <Badge tone={status === 'done' ? 'good' : status === 'in_progress' ? 'accent' : 'neutral'}>{TASK_STATUS_LABELS[status]}</Badge>;
}

/** Deadline with automatic overdue / due-soon highlighting. */
export function DueChip({ date, today, done, className, compact }: { date: string | null | undefined; today: string; done?: boolean; className?: string; compact?: boolean }) {
  if (!date) return <span className={cx('text-ink-3 text-[12px]', className)}>No date</span>;
  const n = diffDays(today, date);
  const label = formatDate(date, today);
  if (done) return <span className={cx('text-[12px] text-ink-3 tabular whitespace-nowrap', className)}>{label}</span>;
  if (n < 0)
    return (
      <span className={cx('inline-flex items-center gap-1 text-[12px] font-medium text-bad tabular whitespace-nowrap', className)} title={`Overdue by ${-n} day${n === -1 ? '' : 's'}`}>
        <AlertCircle className="size-3.5" aria-hidden />
        {compact ? `${-n}d late` : `Overdue · ${label}`}
      </span>
    );
  if (n <= 1)
    return (
      <span className={cx('inline-flex items-center gap-1 text-[12px] font-medium text-warn tabular whitespace-nowrap', className)}>
        <CalendarClock className="size-3.5" aria-hidden />
        {n === 0 ? 'Due today' : 'Tomorrow'}
      </span>
    );
  return <span className={cx('text-[12px] tabular whitespace-nowrap', n <= 7 ? 'text-ink-2' : 'text-ink-3', className)}>{n <= 7 ? `${label} · ${n}d` : label}</span>;
}
