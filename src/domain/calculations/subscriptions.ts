import type { Category, RecurringRule, Transaction } from '../models';
import { type IsoDate, addDays } from '../dates';
import type { Cents } from '../money';
import { payeeName } from '../text';
import { isActual, isPending } from './balances';
import {
  type Occurrence,
  monthlyEquivalent,
  nextDueDate,
  normaliseText,
  reconcileOccurrences,
} from './recurring';

/**
 * Subscriptions and monthly bills are recurring expense items (`RecurringRule` with direction
 * "expense"). This module says, for the current period, whether each one has been paid.
 */
export type SubscriptionState =
  /** A posted transaction matches this period's payment. */
  | 'paid'
  /** A card purchase that matches is still pending at the bank. */
  | 'pending'
  /** Marked as paid by hand (paid some other way, or skipped). */
  | 'marked_paid'
  /** Due later this period. */
  | 'due'
  /** Was due earlier this period but no payment has turned up yet. */
  | 'late'
  /** Nothing due this period (e.g. a yearly item). */
  | 'not_due'
  /** Switched off. */
  | 'paused';

export interface SubscriptionRow {
  rule: RecurringRule;
  state: SubscriptionState;
  /** This period's due date, when one falls in it. */
  dueDate: IsoDate | null;
  /** The next due date from today (for items not due this period, or after this one). */
  nextDue: IsoDate | null;
  /** The matching transaction, when paid or pending. */
  transaction?: Transaction;
  monthlyCents: Cents;
}

export const isSubscription = (r: RecurringRule) => r.direction === 'expense';

/** One occurrence per item for the period: the first still open, otherwise the last one. */
function pickOccurrence(occs: Occurrence[]): Occurrence | undefined {
  return occs.find((o) => o.status === 'unmatched') ?? occs.at(-1);
}

export function subscriptionRows(
  rules: readonly RecurringRule[],
  transactions: readonly Transaction[],
  period: { start: IsoDate; end: IsoDate },
  today: IsoDate,
): SubscriptionRow[] {
  const items = rules.filter(isSubscription);
  const active = items.filter((r) => r.active);
  const posted = reconcileOccurrences(active, transactions, period.start, period.end);
  // A second pass that lets pending card purchases match too, to tell "pending" from "not seen".
  const withPending = reconcileOccurrences(
    active,
    transactions.map((t) => (isPending(t) ? { ...t, status: 'posted' as const } : t)),
    period.start,
    period.end,
  );
  const byId = new Map(transactions.map((t) => [t.id, t]));

  return items.map((rule): SubscriptionRow => {
    const base = { rule, monthlyCents: monthlyEquivalent(rule), nextDue: nextDueDate(rule, today) };
    if (!rule.active) return { ...base, state: 'paused', dueDate: null };
    const occ = pickOccurrence(posted.filter((o) => o.ruleId === rule.id));
    if (!occ) return { ...base, state: 'not_due', dueDate: null };
    const txn = occ.matchedTransactionId ? byId.get(occ.matchedTransactionId) : undefined;
    if (occ.status === 'matched' && txn) {
      return { ...base, state: 'paid', dueDate: occ.date, transaction: txn };
    }
    if (occ.status === 'settled') return { ...base, state: 'marked_paid', dueDate: occ.date };
    const maybe = withPending.find((o) => o.ruleId === rule.id && o.date === occ.date);
    const pendingTxn = maybe?.matchedTransactionId
      ? byId.get(maybe.matchedTransactionId)
      : undefined;
    if (pendingTxn && isPending(pendingTxn)) {
      return { ...base, state: 'pending', dueDate: occ.date, transaction: pendingTxn };
    }
    return { ...base, state: occ.date < today ? 'late' : 'due', dueDate: occ.date };
  });
}

/** Totals for the summary: monthly cost of active items, and this period paid vs still to come. */
export function subscriptionTotals(rows: readonly SubscriptionRow[]) {
  let monthlyCents = 0;
  let paidCents = 0;
  let toComeCents = 0;
  for (const r of rows) {
    if (r.state === 'paused') continue;
    monthlyCents += r.monthlyCents;
    if (r.state === 'paid' || r.state === 'pending') {
      paidCents += Math.abs(r.transaction?.amountCents ?? r.rule.amountCents);
    } else if (r.state === 'marked_paid') {
      paidCents += r.rule.amountCents;
    } else if (r.state === 'due' || r.state === 'late') {
      toComeCents += r.rule.amountCents;
    }
  }
  return { monthlyCents, paidCents, toComeCents };
}

export interface SubscriptionSuggestion {
  /** Stable key for the payee (normalised name). */
  key: string;
  name: string;
  amountCents: Cents;
  categoryId: string;
  /** The latest charge, used as the item's first due date so it shows as paid when it is. */
  lastDate: IsoDate;
  count: number;
}

/** Categories that hold subscriptions ("Subscriptions", "Digital Subscriptions", …). */
export function subscriptionCategoryIds(categories: readonly Category[]): Set<string> {
  return new Set(
    categories.filter((c) => c.kind === 'expense' && /subscri/i.test(c.name)).map((c) => c.id),
  );
}

const LOOKBACK_DAYS = 100;

/**
 * Payees in a subscription category over the last ~3 months that aren't on the list yet, newest
 * charge first. Covered means an item already matched one of the payee's charges, or an item's name
 * and the payee's name contain one another.
 */
export function suggestSubscriptions(
  rules: readonly RecurringRule[],
  transactions: readonly Transaction[],
  categories: readonly Category[],
  today: IsoDate,
): SubscriptionSuggestion[] {
  const subCats = subscriptionCategoryIds(categories);
  if (subCats.size === 0) return [];
  const from = addDays(today, -LOOKBACK_DAYS);
  const charges = transactions.filter(
    (t) =>
      (isActual(t) || isPending(t)) &&
      t.type === 'expense' &&
      t.amountCents < 0 &&
      t.categoryId !== null &&
      subCats.has(t.categoryId) &&
      t.date >= from &&
      t.date <= today,
  );
  const items = rules.filter(isSubscription);
  const matched = new Set(
    reconcileOccurrences(items, transactions, from, today)
      .map((o) => o.matchedTransactionId)
      .filter((id): id is string => !!id),
  );
  for (const t of transactions) if (t.recurringRuleId) matched.add(t.id);
  const itemNames = items.map((r) => normaliseText(r.name)).filter(Boolean);

  const byPayee = new Map<string, Transaction[]>();
  for (const t of charges) {
    const key = normaliseText(payeeName(t.description));
    if (!key) continue;
    byPayee.set(key, [...(byPayee.get(key) ?? []), t]);
  }
  const out: SubscriptionSuggestion[] = [];
  for (const [key, txns] of byPayee) {
    if (txns.some((t) => matched.has(t.id))) continue;
    if (itemNames.some((n) => n.includes(key) || key.includes(n))) continue;
    const latest = [...txns].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))[0]!;
    out.push({
      key,
      name: payeeName(latest.description),
      amountCents: Math.abs(latest.amountCents),
      categoryId: latest.categoryId!,
      lastDate: latest.date,
      count: txns.length,
    });
  }
  return out.sort((a, b) => (a.lastDate < b.lastDate ? 1 : a.lastDate > b.lastDate ? -1 : 0));
}
