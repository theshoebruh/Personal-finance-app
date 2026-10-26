import type { Transaction } from '@/domain/models';

export const TRANSACTION_SORTS = {
  newest: 'Newest first',
  oldest: 'Oldest first',
  largest: 'Largest amount',
  smallest: 'Smallest amount',
  category: 'Category (A–Z)',
  name: 'Name (A–Z)',
} as const;
export type TransactionSort = keyof typeof TRANSACTION_SORTS;

export function isTransactionSort(v: unknown): v is TransactionSort {
  return typeof v === 'string' && v in TRANSACTION_SORTS;
}

const byDateDesc = (a: Transaction, b: Transaction) =>
  a.date === b.date ? (a.createdAt < b.createdAt ? 1 : -1) : a.date < b.date ? 1 : -1;

/**
 * Orders a list of transactions for display. Amounts compare by size (money in or out alike);
 * ties fall back to newest first so the order is stable.
 */
export function sortTransactions(
  txns: readonly Transaction[],
  sort: TransactionSort,
  categoryName: (id: string | null) => string,
): Transaction[] {
  const size = (t: Transaction) => Math.abs(t.amountCents);
  const text = (a: string, b: string) => a.localeCompare(b, 'en-ZA', { sensitivity: 'base' });
  const compare: Record<TransactionSort, (a: Transaction, b: Transaction) => number> = {
    newest: byDateDesc,
    oldest: (a, b) => -byDateDesc(a, b),
    largest: (a, b) => size(b) - size(a) || byDateDesc(a, b),
    smallest: (a, b) => size(a) - size(b) || byDateDesc(a, b),
    category: (a, b) =>
      text(categoryName(a.categoryId), categoryName(b.categoryId)) || byDateDesc(a, b),
    name: (a, b) => text(a.description, b.description) || byDateDesc(a, b),
  };
  return [...txns].sort(compare[sort]);
}
