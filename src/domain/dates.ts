/**
 * Calendar dates are stored as ISO "YYYY-MM-DD" strings representing a local date in
 * Africa/Johannesburg (UTC+2, no DST). Timestamps are stored as ISO-8601 UTC strings.
 * Date arithmetic is done on UTC-midnight Date objects so it is timezone independent.
 */
export const APP_TIME_ZONE = 'Africa/Johannesburg';

export type IsoDate = string;

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isIsoDate(value: string): boolean {
  const m = ISO_DATE_RE.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === value;
}

function toUtc(date: IsoDate): Date {
  if (!isIsoDate(date)) throw new Error(`Invalid ISO date: ${date}`);
  return new Date(`${date}T00:00:00Z`);
}

function fromUtc(d: Date): IsoDate {
  return d.toISOString().slice(0, 10);
}

/** Today's date in Africa/Johannesburg. */
export function todayInAppZone(now: Date = new Date()): IsoDate {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: APP_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export function nowIso(now: Date = new Date()): string {
  return now.toISOString();
}

export function addDays(date: IsoDate, days: number): IsoDate {
  const d = toUtc(date);
  d.setUTCDate(d.getUTCDate() + days);
  return fromUtc(d);
}

export function daysInMonth(year: number, month1: number): number {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

export function parts(date: IsoDate): { year: number; month: number; day: number } {
  const d = toUtc(date);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

export function makeDate(year: number, month1: number, day: number): IsoDate {
  return fromUtc(new Date(Date.UTC(year, month1 - 1, day)));
}

/** Add calendar months, clamping the day to the target month's length (31 Jan + 1M = 28/29 Feb). */
export function addMonths(date: IsoDate, months: number, anchorDay?: number): IsoDate {
  const { year, month, day } = parts(date);
  const total = year * 12 + (month - 1) + months;
  const y = Math.floor(total / 12);
  const m = (total % 12) + 1;
  const want = anchorDay ?? day;
  return makeDate(y, m, Math.min(want, daysInMonth(y, m)));
}

export function startOfMonth(date: IsoDate): IsoDate {
  const { year, month } = parts(date);
  return makeDate(year, month, 1);
}

export function endOfMonth(date: IsoDate): IsoDate {
  const { year, month } = parts(date);
  return makeDate(year, month, daysInMonth(year, month));
}

/** Whole days from a to b (b - a). */
export function diffDays(a: IsoDate, b: IsoDate): number {
  return Math.round((toUtc(b).getTime() - toUtc(a).getTime()) / 86_400_000);
}

/** Inclusive count of days from start to end; 0 if end is before start. */
export function daysInclusive(start: IsoDate, end: IsoDate): number {
  return Math.max(0, diffDays(start, end) + 1);
}

export function isWithin(date: IsoDate, start: IsoDate, end: IsoDate): boolean {
  return date >= start && date <= end;
}

export function minDate(a: IsoDate, b: IsoDate): IsoDate {
  return a <= b ? a : b;
}

export function maxDate(a: IsoDate, b: IsoDate): IsoDate {
  return a >= b ? a : b;
}

const displayFormatter = new Intl.DateTimeFormat('en-ZA', {
  timeZone: 'UTC',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

export function formatDisplayDate(date: IsoDate): string {
  return displayFormatter.format(toUtc(date));
}
