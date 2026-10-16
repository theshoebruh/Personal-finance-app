import type { AppSettings, RecurringRule, Transaction } from '../models';
import {
  type IsoDate,
  addDays,
  addMonths,
  daysInclusive,
  daysInMonth,
  diffDays,
  endOfMonth,
  makeDate,
  parts,
  startOfMonth,
} from '../dates';
import { isActual } from './balances';
import { reconcileOccurrences } from './recurring';

export type PaydaySettings = Pick<AppSettings, 'paydayDayOfMonth' | 'nextPaydayOverride'> & {
  /**
   * Dates salary actually arrived (see `salaryReceiptDates`). A receipt near a scheduled payday
   * replaces it, so salary paid early or late starts the new period on the day it arrived.
   */
  receivedPaydays?: readonly IsoDate[];
};

/**
 * How far from the scheduled payday an override or an actual salary receipt may fall to replace it:
 * up to 10 days early (weekends, public holidays, early December pay) or 5 days late.
 */
const PAYDAY_EARLY_DAYS = 10;
const PAYDAY_LATE_DAYS = 5;

function paydayInMonth(year: number, month: number, day: number): IsoDate {
  return makeDate(year, month, Math.min(day, daysInMonth(year, month)));
}

/**
 * Effective paydays for the months around `today`: the scheduled day-of-month (clamped to the
 * month's length), replaced by the earliest override or salary receipt from 10 days before to 5 days after it.
 */
function effectivePaydays(today: IsoDate, settings: PaydaySettings): IsoDate[] {
  const day = settings.paydayDayOfMonth;
  if (day === null) return [];
  const actual = [
    ...(settings.receivedPaydays ?? []),
    ...(settings.nextPaydayOverride ? [settings.nextPaydayOverride] : []),
  ];
  const out: IsoDate[] = [];
  for (let offset = -2; offset <= 2; offset++) {
    const m = parts(addMonths(startOfMonth(today), offset));
    const scheduled = paydayInMonth(m.year, m.month, day);
    const near = actual
      .filter((d) => {
        const late = diffDays(scheduled, d);
        return late >= -PAYDAY_EARLY_DAYS && late <= PAYDAY_LATE_DAYS;
      })
      .sort();
    out.push(near[0] ?? scheduled);
  }
  return out;
}

/**
 * The next expected payday strictly after today. A payday of "31" falls on the last day of shorter
 * months. A one-off override (salary paid early, e.g. before a weekend) replaces the scheduled
 * payday nearest to it, before and after it has passed; so does an actual salary receipt. On payday
 * itself the new period has already started, so the next payday is the following one.
 */
export function nextPayday(today: IsoDate, settings: PaydaySettings): IsoDate | null {
  if (settings.paydayDayOfMonth === null) {
    return settings.nextPaydayOverride && settings.nextPaydayOverride > today
      ? settings.nextPaydayOverride
      : null;
  }
  return effectivePaydays(today, settings).find((d) => d > today) ?? null;
}

/** The most recent payday on or before today, including early/late paydays (see `nextPayday`). */
export function previousPayday(today: IsoDate, settings: PaydaySettings): IsoDate | null {
  if (settings.paydayDayOfMonth === null) return null;
  const past = effectivePaydays(today, settings).filter((d) => d <= today);
  return past[past.length - 1] ?? null;
}

function isSalaryRule(r: RecurringRule): boolean {
  return (
    r.active &&
    r.direction === 'income' &&
    (r.categoryId === 'cat-salary' || /salary/i.test(r.name))
  );
}

/**
 * Dates salary actually arrived in the last ~2 months: personal income categorised as Salary, or
 * matched to a Salary recurring item. When a monthly salary is set, receipts under half of it
 * (e.g. a small refund filed as salary) are ignored so they can't move the period.
 */
export function salaryReceiptDates(
  today: IsoDate,
  settings: Pick<AppSettings, 'monthlySalaryCents'>,
  rules: readonly RecurringRule[],
  transactions: readonly Transaction[],
): IsoDate[] {
  const from = addDays(today, -70);
  const minCents = Math.floor(settings.monthlySalaryCents / 2);
  const recent = transactions.filter(
    (t) =>
      isActual(t) &&
      t.type === 'income' &&
      t.workspace === 'personal' &&
      t.amountCents > 0 &&
      t.amountCents >= minCents &&
      t.date >= from &&
      t.date <= today,
  );
  const dates = new Set(recent.filter((t) => t.categoryId === 'cat-salary').map((t) => t.date));
  const byId = new Map(recent.map((t) => [t.id, t]));
  for (const o of reconcileOccurrences(
    rules.filter(isSalaryRule),
    transactions,
    from,
    addDays(today, 15),
  )) {
    const t = o.matchedTransactionId ? byId.get(o.matchedTransactionId) : undefined;
    if (t) dates.add(t.date);
  }
  return [...dates].sort();
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
  settings: PaydaySettings & Pick<AppSettings, 'budgetPeriodMode'>,
): BudgetPeriod {
  if (settings.budgetPeriodMode === 'pay_period') {
    const prev = previousPayday(today, settings);
    const next = nextPayday(today, settings);
    if (prev && next) return { start: prev, end: addDays(next, -1), mode: 'pay_period' };
  }
  return { start: startOfMonth(today), end: endOfMonth(today), mode: 'calendar_month' };
}

/** The budget period just before `period` (for "how last period went"). */
export function previousBudgetPeriod(
  period: BudgetPeriod,
  settings: PaydaySettings & Pick<AppSettings, 'budgetPeriodMode'>,
): BudgetPeriod {
  return budgetPeriod(addDays(period.start, -1), settings);
}

/** Settings plus the actual salary receipt dates, ready for `spendingWindow` / `budgetPeriod`. */
export function withReceivedPaydays<S extends AppSettings>(
  today: IsoDate,
  settings: S,
  rules: readonly RecurringRule[],
  transactions: readonly Transaction[],
): S & { receivedPaydays: IsoDate[] } {
  return {
    ...settings,
    receivedPaydays: salaryReceiptDates(today, settings, rules, transactions),
  };
}
