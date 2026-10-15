import type { AppSettings } from '../models';
import {
  type IsoDate,
  addDays,
  addMonths,
  daysInclusive,
  daysInMonth,
  endOfMonth,
  makeDate,
  parts,
  startOfMonth,
} from '../dates';

type PaydaySettings = Pick<AppSettings, 'paydayDayOfMonth' | 'nextPaydayOverride'>;

function paydayInMonth(year: number, month: number, day: number): IsoDate {
  return makeDate(year, month, Math.min(day, daysInMonth(year, month)));
}

/**
 * The next expected payday strictly after today. A payday of "31" falls on the last day of shorter
 * months. A one-off override wins when it is after today. On payday itself the new period has
 * already started, so the next payday is the following one.
 */
export function nextPayday(today: IsoDate, settings: PaydaySettings): IsoDate | null {
  if (settings.nextPaydayOverride && settings.nextPaydayOverride > today) {
    return settings.nextPaydayOverride;
  }
  const day = settings.paydayDayOfMonth;
  if (day === null) return null;
  const { year, month } = parts(today);
  const thisMonth = paydayInMonth(year, month, day);
  if (thisMonth > today) return thisMonth;
  const next = addMonths(startOfMonth(today), 1);
  const n = parts(next);
  return paydayInMonth(n.year, n.month, day);
}

/** The most recent payday on or before today (by day-of-month; overrides are not remembered). */
export function previousPayday(today: IsoDate, settings: PaydaySettings): IsoDate | null {
  const day = settings.paydayDayOfMonth;
  if (day === null) return null;
  const { year, month } = parts(today);
  const thisMonth = paydayInMonth(year, month, day);
  if (thisMonth <= today) return thisMonth;
  const prev = parts(addMonths(startOfMonth(today), -1));
  return paydayInMonth(prev.year, prev.month, day);
}

export interface SpendingWindow {
  start: IsoDate;
  /** Last day the money has to last (inclusive). */
  end: IsoDate;
  /** Inclusive day count, counting today as one day. Always ≥ 1. */
  daysRemaining: number;
  basis: 'next_payday' | 'month_end';
  nextPayday: IsoDate | null;
}

/**
 * The daily-allowance window runs from today (inclusive) to the day before the next payday, or to
 * month-end when no payday is configured. Money received on payday starts a new window.
 */
export function spendingWindow(today: IsoDate, settings: PaydaySettings): SpendingWindow {
  const payday = nextPayday(today, settings);
  const end = payday ? addDays(payday, -1) : endOfMonth(today);
  return {
    start: today,
    end,
    daysRemaining: Math.max(1, daysInclusive(today, end)),
    basis: payday ? 'next_payday' : 'month_end',
    nextPayday: payday,
  };
}

export interface BudgetPeriod {
  start: IsoDate;
  end: IsoDate;
  mode: 'calendar_month' | 'pay_period';
}

/**
 * Budget period for category limits and savings targets. Defaults to the calendar month.
 * In pay-period mode it runs from the last payday to the day before the next one; without a
 * configured payday it falls back to the calendar month.
 */
export function budgetPeriod(
  today: IsoDate,
  settings: Pick<AppSettings, 'paydayDayOfMonth' | 'nextPaydayOverride' | 'budgetPeriodMode'>,
): BudgetPeriod {
  if (settings.budgetPeriodMode === 'pay_period') {
    const prev = previousPayday(today, settings);
    const next = nextPayday(today, settings);
    if (prev && next) return { start: prev, end: addDays(next, -1), mode: 'pay_period' };
  }
  return { start: startOfMonth(today), end: endOfMonth(today), mode: 'calendar_month' };
}
