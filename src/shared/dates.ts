// Calendar dates are plain 'YYYY-MM-DD' strings in the business timezone. They compare correctly as
// strings and never drift across timezones. Internally a date is handled as UTC midnight.

export type ISODate = string;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isValidDate(s: unknown): s is ISODate {
  if (typeof s !== 'string') return false;
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

function toUtc(s: ISODate): Date {
  const m = DATE_RE.exec(s);
  if (!m) throw new Error(`Invalid date: ${s}`);
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
}

function fromUtc(d: Date): ISODate {
  return d.toISOString().slice(0, 10);
}

/** Today's calendar date in an IANA timezone (e.g. 'Asia/Kolkata'). */
export function todayIn(timeZone: string, now: Date = new Date()): ISODate {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  } catch {
    return fromUtc(now);
  }
}

export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function addDays(s: ISODate, n: number): ISODate {
  const d = toUtc(s);
  d.setUTCDate(d.getUTCDate() + n);
  return fromUtc(d);
}

/** Add months, clamping to the last day of the target month (Jan 31 + 1 month = Feb 28/29). */
export function addMonths(s: ISODate, n: number, preferredDay?: number): ISODate {
  const d = toUtc(s);
  const day = preferredDay ?? d.getUTCDate();
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
  const last = daysInMonth(target.getUTCFullYear(), target.getUTCMonth() + 1);
  target.setUTCDate(Math.min(day, last));
  return fromUtc(target);
}

export function daysInMonth(year: number, month1: number): number {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

/** Whole days from a to b (b - a). */
export function diffDays(a: ISODate, b: ISODate): number {
  return Math.round((toUtc(b).getTime() - toUtc(a).getTime()) / 86_400_000);
}

export function weekday(s: ISODate): number {
  return toUtc(s).getUTCDay();
}

export function startOfMonth(s: ISODate): ISODate {
  return s.slice(0, 8) + '01';
}
export function endOfMonth(s: ISODate): ISODate {
  const [y, m] = s.split('-').map(Number);
  return `${s.slice(0, 8)}${String(daysInMonth(y, m)).padStart(2, '0')}`;
}
export function startOfQuarter(s: ISODate): ISODate {
  const [y, m] = s.split('-').map(Number);
  const qm = Math.floor((m - 1) / 3) * 3 + 1;
  return `${y}-${String(qm).padStart(2, '0')}-01`;
}
export function endOfQuarter(s: ISODate): ISODate {
  return endOfMonth(addMonths(startOfQuarter(s), 2));
}
export function startOfYear(s: ISODate): ISODate {
  return `${s.slice(0, 4)}-01-01`;
}
export function endOfYear(s: ISODate): ISODate {
  return `${s.slice(0, 4)}-12-31`;
}
/** Monday-based week start. */
export function startOfWeek(s: ISODate): ISODate {
  const wd = weekday(s);
  return addDays(s, wd === 0 ? -6 : 1 - wd);
}

export function monthKey(s: ISODate): string {
  return s.slice(0, 7);
}

/** Month keys ('YYYY-MM') from the month of `from` to the month of `to`, inclusive. */
export function monthRange(from: ISODate, to: ISODate): string[] {
  const out: string[] = [];
  let cur = startOfMonth(from);
  const end = startOfMonth(to);
  while (cur <= end && out.length < 600) {
    out.push(monthKey(cur));
    cur = addMonths(cur, 1);
  }
  return out;
}

export type PeriodKind = 'month' | 'quarter' | 'year';
export type Period = { kind: PeriodKind; start: ISODate; end: ISODate; label: string };

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function periodFor(kind: PeriodKind, anchor: ISODate): Period {
  const y = anchor.slice(0, 4);
  if (kind === 'month') {
    const m = Number(anchor.slice(5, 7));
    return { kind, start: startOfMonth(anchor), end: endOfMonth(anchor), label: `${MONTHS_LONG[m - 1]} ${y}` };
  }
  if (kind === 'quarter') {
    const q = Math.floor((Number(anchor.slice(5, 7)) - 1) / 3) + 1;
    return { kind, start: startOfQuarter(anchor), end: endOfQuarter(anchor), label: `Q${q} ${y}` };
  }
  return { kind, start: startOfYear(anchor), end: endOfYear(anchor), label: y };
}

export function shiftPeriod(p: Period, steps: number): Period {
  const months = p.kind === 'month' ? 1 : p.kind === 'quarter' ? 3 : 12;
  return periodFor(p.kind, addMonths(p.start, months * steps, 1));
}

export function monthLabel(key: string, style: 'short' | 'long' = 'short'): string {
  const [y, m] = key.split('-').map(Number);
  return `${(style === 'short' ? MONTHS_SHORT : MONTHS_LONG)[m - 1]} ${style === 'short' ? String(y).slice(2) : y}`;
}

export function monthName(key: string): string {
  return MONTHS_LONG[Number(key.slice(5, 7)) - 1];
}

/** 'Oct 27' (current year) or 'Oct 27, 2025'. */
export function formatDate(s: ISODate | null | undefined, today?: ISODate): string {
  if (!s || !isValidDate(s.slice(0, 10))) return '—';
  const [y, m, d] = s.slice(0, 10).split('-').map(Number);
  const sameYear = today ? today.slice(0, 4) === String(y) : false;
  return `${MONTHS_SHORT[m - 1]} ${d}${sameYear ? '' : `, ${y}`}`;
}

export function formatDateLong(s: ISODate | null | undefined): string {
  if (!s || !isValidDate(s.slice(0, 10))) return '—';
  const [y, m, d] = s.slice(0, 10).split('-').map(Number);
  return `${d} ${MONTHS_LONG[m - 1]} ${y}`;
}

/** 'today', 'tomorrow', 'in 3 days', '2 days ago'. */
export function relativeDay(s: ISODate, today: ISODate): string {
  const n = diffDays(today, s);
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  if (n === -1) return 'yesterday';
  if (n > 1 && n < 14) return `in ${n} days`;
  if (n < -1 && n > -14) return `${-n} days ago`;
  if (n >= 14 && n < 60) return `in ${Math.round(n / 7)} weeks`;
  if (n <= -14 && n > -60) return `${Math.round(-n / 7)} weeks ago`;
  return formatDate(s, today);
}
