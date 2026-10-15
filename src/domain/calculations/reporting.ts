import type { Transaction, WorkspaceView } from '../models';
import { type IsoDate, isWithin } from '../dates';
import type { Cents } from '../money';
import { isActual } from './balances';

export function inView(workspace: Transaction['workspace'], view: WorkspaceView): boolean {
  return view === 'combined' || workspace === view;
}

export interface IncomeExpenseSummary {
  /** External income (type income). */
  incomeCents: Cents;
  /** Gross external spending as a positive number (type expense). */
  expenseCents: Cents;
  /** Refunds/reversals, which reduce net spending. */
  refundCents: Cents;
  /** expense − refunds, floored at zero only for display by callers. */
  netExpenseCents: Cents;
  netCents: Cents;
  /**
   * Money moved from personal into business (business view: owner contributions) and back out
   * (owner draws). Always excluded from income/expenses; zero in the combined view.
   */
  ownerContributionCents: Cents;
  ownerDrawCents: Cents;
  /** Count of transfer legs left out of income/expenses. */
  transferLegsExcluded: number;
  /** Balance adjustments are corrections, not income or spending. */
  adjustmentLegsExcluded: number;
}

/**
 * Income vs expenses for a period and workspace view, using actual (posted/needs-review)
 * transactions only. Transfers between owned accounts are never income or expenses, so moving
 * money to savings, or between personal and business, cannot inflate either figure.
 */
export function summariseIncomeExpenses(
  transactions: readonly Transaction[],
  view: WorkspaceView,
  start: IsoDate,
  end: IsoDate,
): IncomeExpenseSummary {
  const s: IncomeExpenseSummary = {
    incomeCents: 0,
    expenseCents: 0,
    refundCents: 0,
    netExpenseCents: 0,
    netCents: 0,
    ownerContributionCents: 0,
    ownerDrawCents: 0,
    transferLegsExcluded: 0,
    adjustmentLegsExcluded: 0,
  };
  for (const t of transactions) {
    if (!isActual(t) || !inView(t.workspace, view) || !isWithin(t.date, start, end)) continue;
    switch (t.type) {
      case 'income':
        s.incomeCents += t.amountCents;
        break;
      case 'expense':
        s.expenseCents += -t.amountCents;
        break;
      case 'refund':
        s.refundCents += t.amountCents;
        break;
      case 'adjustment':
        s.adjustmentLegsExcluded++;
        break;
      case 'transfer':
        s.transferLegsExcluded++;
        if (view !== 'combined' && t.workspace === 'business') {
          // Measured on the business leg so each movement is counted once.
          if (t.transferKind === 'owner_contribution' && t.amountCents > 0) {
            s.ownerContributionCents += t.amountCents;
          } else if (t.transferKind === 'owner_draw' && t.amountCents < 0) {
            s.ownerDrawCents += -t.amountCents;
          }
        }
        if (view === 'personal' && t.workspace === 'personal') {
          if (t.transferKind === 'owner_contribution' && t.amountCents < 0) {
            s.ownerContributionCents += -t.amountCents;
          } else if (t.transferKind === 'owner_draw' && t.amountCents > 0) {
            s.ownerDrawCents += t.amountCents;
          }
        }
        break;
    }
  }
  s.netExpenseCents = s.expenseCents - s.refundCents;
  s.netCents = s.incomeCents - s.netExpenseCents;
  return s;
}

/** Net spending per category (expenses minus refunds) within a period. Key null = uncategorised. */
export function spendingByCategory(
  transactions: readonly Transaction[],
  view: WorkspaceView,
  start: IsoDate,
  end: IsoDate,
): Map<string | null, Cents> {
  const out = new Map<string | null, Cents>();
  for (const t of transactions) {
    if (!isActual(t) || !inView(t.workspace, view) || !isWithin(t.date, start, end)) continue;
    if (t.type !== 'expense' && t.type !== 'refund') continue;
    out.set(t.categoryId, (out.get(t.categoryId) ?? 0) - t.amountCents);
  }
  return out;
}
