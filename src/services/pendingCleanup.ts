import type { Transaction } from '@/domain/models';
import { diffDays, formatDisplayDate } from '@/domain/dates';
import {
  PENDING_POST_WINDOW_DAYS,
  isPendingLike,
  similarDescriptions,
} from '@/domain/imports/staging';
import type { FinanceStore } from '@/data/repositories/types';
import { type Clock, systemClock } from './common';

/** Tag on a pending transaction archived because its posted version was found. */
export const SETTLED_PENDING_TAG = 'auto:settled-pending';
/** Tag on a transaction the user imported as separate from a similar pending one. */
export const KEEP_SEPARATE_TAG = 'user:separate';

export interface SettledPending {
  pending: Transaction;
  posted: Transaction;
}

/**
 * Pending transactions (or "(Pending) …" ones from before pending support) that also exist as a
 * posted transaction: same account and amount, a similar name, posted 0–10 days later. These are
 * the same purchase counted twice. Each posted transaction settles at most one pending one, the
 * closest in date.
 */
export function findSettledPendings(transactions: readonly Transaction[]): SettledPending[] {
  const live = transactions.filter((t) => !t.archived && t.type !== 'transfer');
  const pendings = live
    .filter(isPendingLike)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const used = new Set<string>();
  const out: SettledPending[] = [];
  for (const p of pendings) {
    const posted = live
      .filter(
        (t) =>
          !used.has(t.id) &&
          !isPendingLike(t) &&
          !t.tags.includes(KEEP_SEPARATE_TAG) &&
          t.accountId === p.accountId &&
          t.amountCents === p.amountCents &&
          diffDays(p.date, t.date) >= 0 &&
          diffDays(p.date, t.date) <= PENDING_POST_WINDOW_DAYS &&
          similarDescriptions(p.description, t.description),
      )
      .sort((a, b) => diffDays(p.date, a.date) - diffDays(p.date, b.date))[0];
    if (posted) {
      used.add(posted.id);
      out.push({ pending: p, posted });
    }
  }
  return out;
}

/**
 * Archive (never delete) pending transactions whose payment has gone through, so the purchase isn't
 * counted twice. The note says which transaction it posted as; Activity → "Show archived" brings
 * it back. The written values don't depend on the device, so two devices doing this agree.
 */
export async function archiveSettledPendings(
  store: FinanceStore,
  clock: Clock = systemClock,
): Promise<number> {
  const settled = findSettledPendings(await store.transactions.list());
  if (settled.length === 0) return 0;
  const now = clock.now();
  await store.transactions.bulkPut(
    settled.map(({ pending, posted }) => {
      const note = `Archived automatically: this payment went through on ${formatDisplayDate(posted.date)} as “${posted.description}”.`;
      return {
        ...pending,
        archived: true,
        notes: (pending.notes ? `${pending.notes}\n${note}` : note).slice(0, 1000),
        tags: [...pending.tags.filter((t) => t !== SETTLED_PENDING_TAG), SETTLED_PENDING_TAG].slice(
          -20,
        ),
        updatedAt: now,
      };
    }),
  );
  return settled.length;
}
