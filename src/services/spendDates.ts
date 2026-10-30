import type { Transaction } from '@/domain/models';
import { diffDays } from '@/domain/dates';
import type { FinanceStore } from '@/data/repositories/types';
import { type Clock, systemClock } from './common';

/**
 * Imported transactions used to be dated by the bank's posting date, so a purchase made before
 * payday but posted on payday counted in the new pay period. Transactions imported since the bank's
 * transaction time was recorded (a `pt:` tag, e.g. "pt:2026-10-28 13:47") can be re-dated to the day
 * you spent, keeping the posting date as `postedDate`. Returns the corrected copies.
 */
export function transactionsToRedate(transactions: readonly Transaction[]): Transaction[] {
  const out: Transaction[] = [];
  for (const t of transactions) {
    if (t.source !== 'csv' || t.postedDate) continue;
    const tag = t.tags.find((g) => g.startsWith('pt:'));
    const spent = tag ? /^pt:(\d{4}-\d{2}-\d{2})/.exec(tag)?.[1] : undefined;
    // Only a plausible earlier date (a few days before posting) is used.
    if (!spent || spent >= t.date || diffDays(spent, t.date) > 10) continue;
    out.push({ ...t, date: spent, postedDate: t.date });
  }
  return out;
}

export async function redateToSpendDates(
  store: FinanceStore,
  clock: Clock = systemClock,
): Promise<number> {
  const fixes = transactionsToRedate(await store.transactions.list());
  if (fixes.length === 0) return 0;
  const now = clock.now();
  await store.transactions.bulkPut(fixes.map((t) => ({ ...t, updatedAt: now })));
  return fixes.length;
}
