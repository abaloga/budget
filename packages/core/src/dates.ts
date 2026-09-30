/**
 * Calendar-date helpers on `YYYY-MM-DD` strings.
 *
 * Financial dates are calendar days, not instants. Using strings (with UTC math
 * internally) avoids the classic "transaction shows on the wrong day" bug when
 * a Date is created in one time zone and read in another.
 */
import type { ISODate, MonthStart } from './types.ts';

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

export function isISODate(value: string): boolean {
  const m = ISO_RE.exec(value);
  if (!m) return false;
  const [, y, mo, d] = m;
  const t = Date.UTC(Number(y), Number(mo) - 1, Number(d));
  return fromUTC(t) === value;
}

function parts(date: ISODate): [number, number, number] {
  const m = ISO_RE.exec(date);
  if (!m) throw new RangeError(`Invalid ISO date: ${date}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function toUTC(date: ISODate): number {
  const [y, m, d] = parts(date);
  return Date.UTC(y, m - 1, d);
}

function fromUTC(ms: number): ISODate {
  const dt = new Date(ms);
  const y = dt.getUTCFullYear();
  const m = dt.getUTCMonth() + 1;
  const d = dt.getUTCDate();
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Today's calendar date in the device's local time zone. */
export function todayISO(now: Date = new Date()): ISODate {
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  const d = now.getDate();
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function addDays(date: ISODate, days: number): ISODate {
  return fromUTC(toUTC(date) + days * DAY_MS);
}

/** Whole days from a to b (positive when b is later). */
export function daysBetween(a: ISODate, b: ISODate): number {
  return Math.round((toUTC(b) - toUTC(a)) / DAY_MS);
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Add months, clamping to the end of shorter months. `anchorDay` keeps a
 * schedule on its intended day (Jan 31 -> Feb 28 -> Mar 31, not Mar 28).
 */
export function addMonths(date: ISODate, months: number, anchorDay?: number): ISODate {
  const [y, m, d] = parts(date);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const day = Math.min(anchorDay ?? d, daysInMonth(ny, nm));
  return `${String(ny).padStart(4, '0')}-${String(nm).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function dayOfMonth(date: ISODate): number {
  return parts(date)[2];
}

export function monthStart(date: ISODate): MonthStart {
  return `${date.slice(0, 7)}-01`;
}

export function monthEnd(date: ISODate): ISODate {
  const [y, m] = parts(date);
  return `${date.slice(0, 7)}-${String(daysInMonth(y, m)).padStart(2, '0')}`;
}

export function addMonthsToMonth(month: MonthStart, n: number): MonthStart {
  return addMonths(monthStart(month), n, 1);
}

/** Inclusive list of month starts covering [start, end]. */
export function monthsInRange(start: ISODate, end: ISODate): MonthStart[] {
  const out: MonthStart[] = [];
  let m = monthStart(start);
  const last = monthStart(end);
  while (m <= last) {
    out.push(m);
    m = addMonthsToMonth(m, 1);
  }
  return out;
}

/** Whole calendar months from a's month to b's month (Sep -> Nov = 2). */
export function monthDiff(a: ISODate, b: ISODate): number {
  const [ay, am] = parts(a);
  const [by, bm] = parts(b);
  return (by - ay) * 12 + (bm - am);
}

export function minDate(a: ISODate, b: ISODate): ISODate {
  return a <= b ? a : b;
}

export function maxDate(a: ISODate, b: ISODate): ISODate {
  return a >= b ? a : b;
}

export function compareDates(a: ISODate, b: ISODate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** e.g. "September 2026" */
export function formatMonth(month: ISODate, style: 'long' | 'short' = 'long'): string {
  const [y, m] = parts(month);
  return new Intl.DateTimeFormat('en-US', { month: style, year: 'numeric', timeZone: 'UTC' }).format(
    new Date(Date.UTC(y, m - 1, 1)),
  );
}

/** e.g. "Sep 12" or "Sep 12, 2025" when not in `currentYear`. */
export function formatShortDate(date: ISODate, currentYear?: number): string {
  const [y, m, d] = parts(date);
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', timeZone: 'UTC' };
  if (currentYear !== undefined && y !== currentYear) opts.year = 'numeric';
  return new Intl.DateTimeFormat('en-US', opts).format(new Date(Date.UTC(y, m - 1, d)));
}
