import type { Budget, Category, Transaction, WorkspaceView } from '../models';
import type { IsoDate } from '../dates';
import type { Cents } from '../money';
import { inView, spendingByCategory } from './reporting';

export interface BudgetLine {
  budgetId: string;
  categoryId: string;
  categoryName: string;
  group: Category['group'];
  limitCents: Cents;
  spentCents: Cents;
  /** limit − spent; negative means over budget. */
  remainingCents: Cents;
}

export function budgetLines(
  budgets: readonly Budget[],
  categories: readonly Category[],
  transactions: readonly Transaction[],
  view: WorkspaceView,
  start: IsoDate,
  end: IsoDate,
): BudgetLine[] {
  const spent = spendingByCategory(transactions, view, start, end);
  const byId = new Map(categories.map((c) => [c.id, c]));
  const lines: BudgetLine[] = [];
  for (const b of budgets) {
    if (!b.active || !inView(b.workspace, view)) continue;
    const cat = byId.get(b.categoryId);
    if (!cat) continue;
    const s = spent.get(b.categoryId) ?? 0;
    lines.push({
      budgetId: b.id,
      categoryId: b.categoryId,
      categoryName: cat.name,
      group: cat.group,
      limitCents: b.limitCents,
      spentCents: s,
      remainingCents: b.limitCents - s,
    });
  }
  return lines;
}

export interface DiscretionaryBudgetStatus {
  /** False when no active discretionary budgets exist for this view; no cap is then applied. */
  enabled: boolean;
  limitCents: Cents;
  /** Net spending in all discretionary categories this period (budgeted or not). */
  spentCents: Cents;
  /** limit − spent; negative means overspent. */
  remainingCents: Cents;
  /** Uncategorised spending is not attributed to any budget; surfaced so the user can review. */
  uncategorisedSpentCents: Cents;
}

/**
 * Remaining discretionary ("wants") budget for the period: the total of discretionary category
 * limits minus all spending in discretionary categories. Overspending in one category reduces the
 * total remaining, so the cap is never more generous than the overall plan.
 */
export function discretionaryBudgetStatus(
  budgets: readonly Budget[],
  categories: readonly Category[],
  transactions: readonly Transaction[],
  view: WorkspaceView,
  start: IsoDate,
  end: IsoDate,
): DiscretionaryBudgetStatus {
  const discretionaryIds = new Set(
    categories.filter((c) => c.group === 'discretionary').map((c) => c.id),
  );
  const active = budgets.filter(
    (b) => b.active && inView(b.workspace, view) && discretionaryIds.has(b.categoryId),
  );
  const spentMap = spendingByCategory(transactions, view, start, end);
  let spent = 0;
  for (const [catId, amount] of spentMap) {
    if (catId !== null && discretionaryIds.has(catId)) spent += amount;
  }
  const limit = active.reduce((sum, b) => sum + b.limitCents, 0);
  return {
    enabled: active.length > 0,
    limitCents: limit,
    spentCents: spent,
    remainingCents: limit - spent,
    uncategorisedSpentCents: Math.max(0, spentMap.get(null) ?? 0),
  };
}
