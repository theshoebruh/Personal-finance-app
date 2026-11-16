import type { Transaction } from '../models';
import type { IsoDate } from '../dates';

/**
 * Tag that makes a transaction count in an earlier budget period than its own date, e.g.
 * "bd:2026-10-29" on last period's leftover moved to savings on payday (30 Oct). The bank date is
 * unchanged; only period totals use the tag's date.
 */
export const BUDGET_DATE_PREFIX = 'bd:';

const BUDGET_DATE_RE = /^bd:(\d{4}-\d{2}-\d{2})$/;

/** The date a transaction counts on for period totals. */
export function budgetDateOf(t: Pick<Transaction, 'date' | 'tags'>): IsoDate {
  for (const tag of t.tags) {
    const m = BUDGET_DATE_RE.exec(tag);
    if (m) return m[1]!;
  }
  return t.date;
}

/** The transaction as period totals see it (dated by its budget date). */
export function asBudgeted<T extends Transaction>(t: T): T {
  const date = budgetDateOf(t);
  return date === t.date ? t : { ...t, date };
}

/** Whether the transaction has been moved to an earlier period. */
export function countsInEarlierPeriod(t: Pick<Transaction, 'date' | 'tags'>): boolean {
  return budgetDateOf(t) < t.date;
}

/** Tags with any budget date replaced (or removed when `date` is null). */
export function withBudgetDate(tags: readonly string[], date: IsoDate | null): string[] {
  const rest = tags.filter((g) => !g.startsWith(BUDGET_DATE_PREFIX));
  return date ? [...rest, `${BUDGET_DATE_PREFIX}${date}`] : rest;
}
