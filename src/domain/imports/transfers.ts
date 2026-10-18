import type { Account, Transaction } from '../models';
import { diffDays, type IsoDate } from '../dates';
import type { Cents } from '../money';
import { normaliseText } from '../calculations/recurring';

/** How far apart (in days) the two sides of a transfer can be dated by different banks/accounts. */
export const TRANSFER_WINDOW_DAYS = 3;

export type TransferStrength = 'paired' | 'half_recorded' | 'wording';

export interface TransferSuggestion {
  strength: TransferStrength;
  /** The other account involved (null when only the wording suggests a transfer). */
  otherAccountId: string | null;
  /**
   * paired: an ordinary income/expense in the other account that would become the other leg.
   * half_recorded: an existing transfer leg that has no partner yet.
   */
  counterpart?: {
    transactionId: string;
    transferId?: string;
    description: string;
    date: IsoDate;
    amountCents: Cents;
  };
}

export interface TransferCandidateRow {
  date: IsoDate;
  amountCents: Cents;
  description: string;
}

const TRANSFER_WORDS =
  /\b(transfer|trf|xfer|tfr|own account|savings?|save|pocket|inter ?account|sweep)\b/;

/** Transfer legs that don't have a partner yet, keyed by transferId. */
function loneLegs(transactions: readonly Transaction[]): Map<string, Transaction> {
  const legs = new Map<string, Transaction[]>();
  for (const t of transactions) {
    if (t.archived || t.type !== 'transfer' || !t.transferId) continue;
    const list = legs.get(t.transferId) ?? [];
    list.push(t);
    legs.set(t.transferId, list);
  }
  const out = new Map<string, Transaction>();
  for (const [id, list] of legs) if (list.length === 1) out.set(id, list[0]!);
  return out;
}

function accountNamedIn(text: string, accounts: readonly Account[]): Account | null {
  const hay = ` ${normaliseText(text)} `;
  let best: Account | null = null;
  for (const a of accounts) {
    // Ignore the "Demo · " prefix and very short names that would match by accident.
    const name = normaliseText(a.name.replace(/^demo\s*·\s*/i, ''));
    if (
      name.length >= 4 &&
      hay.includes(` ${name} `) &&
      (!best || name.length > best.name.length)
    ) {
      best = a;
    }
  }
  return best;
}

/**
 * Suggests which rows of a statement for `account` are transfers between your own accounts.
 *
 * - paired: another of your accounts has the exact opposite amount within ±3 days as an ordinary
 *   income/expense (not yet a transfer). Strong — selected by default.
 * - half_recorded: another account has a transfer leg with the opposite amount within ±3 days and
 *   no partner yet (its statement was imported first). Strong — selected by default.
 * - wording: the description says "transfer", "savings", names one of your accounts, etc. Weak —
 *   shown, but not selected by default.
 *
 * Each existing transaction is offered to at most one row (closest date wins).
 */
export function suggestTransfers(
  rows: readonly (TransferCandidateRow | null)[],
  account: Account,
  accounts: readonly Account[],
  transactions: readonly Transaction[],
): (TransferSuggestion | null)[] {
  const others = accounts.filter((a) => a.id !== account.id && a.active);
  const otherIds = new Set(others.map((a) => a.id));
  const lone = [...loneLegs(transactions).values()].filter((t) => otherIds.has(t.accountId));
  const plain = transactions.filter(
    (t) =>
      !t.archived &&
      otherIds.has(t.accountId) &&
      t.status !== 'excluded' &&
      (t.type === 'income' || t.type === 'expense' || t.type === 'refund'),
  );
  const used = new Set<string>();

  return rows.map((row) => {
    if (!row) return null;
    const near = (t: Transaction) =>
      t.amountCents === -row.amountCents &&
      Math.abs(diffDays(t.date, row.date)) <= TRANSFER_WINDOW_DAYS &&
      !used.has(t.id);
    const byCloseness = (a: Transaction, b: Transaction) =>
      Math.abs(diffDays(a.date, row.date)) - Math.abs(diffDays(b.date, row.date));

    const half = lone.filter(near).sort(byCloseness)[0];
    if (half) {
      used.add(half.id);
      return {
        strength: 'half_recorded',
        otherAccountId: half.accountId,
        counterpart: {
          transactionId: half.id,
          ...(half.transferId ? { transferId: half.transferId } : {}),
          description: half.description,
          date: half.date,
          amountCents: half.amountCents,
        },
      };
    }
    const pair = plain.filter(near).sort(byCloseness)[0];
    if (pair) {
      used.add(pair.id);
      return {
        strength: 'paired',
        otherAccountId: pair.accountId,
        counterpart: {
          transactionId: pair.id,
          description: pair.description,
          date: pair.date,
          amountCents: pair.amountCents,
        },
      };
    }
    const named = accountNamedIn(row.description, others);
    if (named || TRANSFER_WORDS.test(normaliseText(row.description))) {
      // Without a named account, a single savings account is the likely destination.
      const savings = others.filter(
        (a) => a.type === 'savings' && a.workspace === account.workspace,
      );
      const guess = named ?? (savings.length === 1 ? savings[0]! : null);
      return { strength: 'wording', otherAccountId: guess?.id ?? null };
    }
    return null;
  });
}

/** Strong suggestions are applied by default; wording-only ones need the user to confirm. */
export function isStrongTransfer(s: TransferSuggestion | null | undefined): boolean {
  return s?.strength === 'paired' || s?.strength === 'half_recorded';
}
