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
  /**
   * When salary can be recognised (a monthly salary is set), don't start a new period on the
   * scheduled payday until it actually arrives (see `awaitingSalary`). Off by default.
   */
  awaitSalary?: boolean;
};

/**
 * How far from the scheduled payday an override or an actual salary receipt may fall to replace it:
 * up to 10 days early (weekends, public holidays, early December pay) or 5 days late.
 */
const PAYDAY_EARLY_DAYS = 10;
const PAYDAY_LATE_DAYS = 5;

/**
 * A period waits for salary through the last day it can still count as late (5 days after the
 * scheduled payday), then starts anyway.
 */
export const AWAIT_SALARY_DAYS = PAYDAY_LATE_DAYS + 1;

function paydayInMonth(year: number, month: number, day: number): IsoDate {
  return makeDate(year, month, Math.min(day, daysInMonth(year, month)));
}

interface PaydaySlot {
  scheduled: IsoDate;
  /** The day it really happened: the earliest override or receipt near it, else the scheduled day. */
  effective: IsoDate;
  /** True when salary (or an override) was actually seen for this slot. */
  seen: boolean;
}

/**
 * Paydays for the months around `today`: the scheduled day-of-month (clamped to the month's
 * length), replaced by the earliest override or salary receipt from 10 days before to 5 days after.
 */
function paydaySlots(today: IsoDate, settings: PaydaySettings): PaydaySlot[] {
  const day = settings.paydayDayOfMonth;
  if (day === null) return [];
  const actual = [
    ...(settings.receivedPaydays ?? []),
    ...(settings.nextPaydayOverride ? [settings.nextPaydayOverride] : []),
  ];
  const out: PaydaySlot[] = [];
  for (let offset = -2; offset <= 2; offset++) {
    const m = parts(addMonths(startOfMonth(today), offset));
    const scheduled = paydayInMonth(m.year, m.month, day);
    const near = actual
      .filter((d) => {
        const late = diffDays(scheduled, d);
        return late >= -PAYDAY_EARLY_DAYS && late <= PAYDAY_LATE_DAYS;
      })
      .sort();
    out.push({ scheduled, effective: near[0] ?? scheduled, seen: near.length > 0 });
  }
  return out;
}

/**
 * The scheduled payday whose salary hasn't arrived yet, while still waiting for it (up to
 * `AWAIT_SALARY_DAYS` after it); null otherwise. Until it arrives the current period keeps
 * running, so a salary paid on the 2nd instead of the 29th doesn't start an empty period early.
 */
export function awaitingSalary(today: IsoDate, settings: PaydaySettings): IsoDate | null {
  if (!settings.awaitSalary) return null;
  const due = paydaySlots(today, settings).filter(
    (s) => s.effective <= today || s.scheduled <= today,
  );
  const latest = due[due.length - 1];
  if (!latest || latest.seen) return null;
  const waited = diffDays(latest.scheduled, today);
  return waited >= 0 && waited < AWAIT_SALARY_DAYS ? latest.scheduled : null;
}

function effectivePaydays(today: IsoDate, settings: PaydaySettings): IsoDate[] {
  const waiting = awaitingSalary(today, settings);
  return paydaySlots(today, settings)
    .filter((s) => s.scheduled !== waiting)
    .map((s) => s.effective);
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
  basis: 'next_payday' | 'month_end' | 'awaiting_salary';
  nextPayday: IsoDate | null;
}

/**
 * The daily-allowance window runs from today (inclusive) to the day before the next payday, or to
 * month-end when no payday is configured. Money received on payday starts a new window.
 */
export function spendingWindow(today: IsoDate, settings: PaydaySettings): SpendingWindow {
  if (awaitingSalary(today, settings)) {
    // Salary is due any day: today is the last day the current money has to cover for sure.
    return {
      start: today,
      end: today,
      daysRemaining: 1,
      basis: 'awaiting_salary',
      nextPayday: null,
    };
  }
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
  /** Scheduled payday whose salary hasn't arrived yet: the period stays open (ends today). */
  awaitingSalarySince?: IsoDate;
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
    const waiting = awaitingSalary(today, settings);
    if (prev && waiting) {
      return { start: prev, end: today, mode: 'pay_period', awaitingSalarySince: waiting };
    }
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
): S & { receivedPaydays: IsoDate[]; awaitSalary: boolean } {
  return {
    ...settings,
    receivedPaydays: salaryReceiptDates(today, settings, rules, transactions),
    awaitSalary: settings.monthlySalaryCents > 0,
  };
}
