import type { Account, Transaction } from '../models';
import type { IsoDate } from '../dates';
import type { Cents } from '../money';

/**
 * Whether a transaction is part of the account's actual (posted) balance.
 * - posted and needs_review: real transactions (needs_review only flags categorisation/import review)
 * - pending: shown separately, not in the posted balance
 * - excluded / archived: never counted
 */
export function isActual(t: Transaction): boolean {
  return !t.archived && (t.status === 'posted' || t.status === 'needs_review');
}

export function isPending(t: Transaction): boolean {
  return !t.archived && t.status === 'pending';
}

/**
 * The opening balance is the balance at the start of `openingBalanceDate`. Transactions dated
 * before that are assumed to be already reflected in the opening balance and are ignored.
 */
function inBalanceRange(account: Account, t: Transaction, asOf?: IsoDate): boolean {
  return (
    t.accountId === account.id &&
    t.date >= account.openingBalanceDate &&
    (asOf === undefined || t.date <= asOf)
  );
}

/** Posted balance calculated from the opening balance and actual transactions. */
export function accountBalance(
  account: Account,
  transactions: readonly Transaction[],
  asOf?: IsoDate,
): Cents {
  let balance = account.openingBalanceCents;
  for (const t of transactions) {
    if (isActual(t) && inBalanceRange(account, t, asOf)) balance += t.amountCents;
  }
  return balance;
}

/** Sum of pending transactions for the account (not included in the posted balance). */
export function pendingTotal(account: Account, transactions: readonly Transaction[]): Cents {
  let total = 0;
  for (const t of transactions) {
    if (isPending(t) && inBalanceRange(account, t)) total += t.amountCents;
  }
  return total;
}

export interface CurrentBalance {
  /** Posted balance across active spendable accounts, like a bank's "Balance". */
  postedCents: Cents;
  /** Pending transactions in those accounts (negative when money is on its way out). */
  pendingCents: Cents;
  /** Posted + pending, like a bank's "Available" (before any holds the app can't see). */
  afterPendingCents: Cents;
  accountCount: number;
}

/** What is in your spendable accounts right now (savings and archived accounts excluded). */
export function currentBalance(
  accounts: readonly Account[],
  transactions: readonly Transaction[],
): CurrentBalance {
  const spendable = accounts.filter((a) => a.active && a.includeInSpendable);
  const posted = spendable.reduce((s, a) => s + accountBalance(a, transactions), 0);
  const pending = spendable.reduce((s, a) => s + pendingTotal(a, transactions), 0);
  return {
    postedCents: posted,
    pendingCents: pending,
    afterPendingCents: posted + pending,
    accountCount: spendable.length,
  };
}

export interface ReconciliationStatus {
  reconciledDate: IsoDate;
  statementBalanceCents: Cents;
  calculatedBalanceCents: Cents;
  /** calculated − statement. Zero means the records agree with the statement. */
  discrepancyCents: Cents;
}

export function reconciliationStatus(
  account: Account,
  transactions: readonly Transaction[],
): ReconciliationStatus | null {
  if (account.reconciledBalanceCents === undefined || account.reconciledDate === undefined) {
    return null;
  }
  const calculated = accountBalance(account, transactions, account.reconciledDate);
  return {
    reconciledDate: account.reconciledDate,
    statementBalanceCents: account.reconciledBalanceCents,
    calculatedBalanceCents: calculated,
    discrepancyCents: calculated - account.reconciledBalanceCents,
  };
}
