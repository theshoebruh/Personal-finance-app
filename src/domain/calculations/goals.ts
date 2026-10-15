import type {
  Account,
  AppSettings,
  Budget,
  Category,
  GoalContribution,
  SavingsGoal,
  Transaction,
  WorkspaceView,
} from '../models';
import {
  type IsoDate,
  addMonths,
  diffDays,
  endOfMonth,
  isWithin,
  parts,
  startOfMonth,
} from '../dates';
import { type Cents, divideRounded } from '../money';
import { isActual } from './balances';
import { inView, spendingByCategory } from './reporting';

export function goalBalance(goalId: string, contributions: readonly GoalContribution[]): Cents {
  let total = 0;
  for (const c of contributions) if (c.goalId === goalId) total += c.amountCents;
  return total;
}

export function emergencyFundTarget(
  essentialMonthlyCents: Cents,
  months: number,
  fixedTargetCents: Cents | null = null,
): Cents {
  if (fixedTargetCents !== null) return fixedTargetCents;
  return essentialMonthlyCents * months;
}

export interface EssentialEstimate {
  monthlyCents: Cents | null;
  source: 'override' | 'budgets' | 'history' | 'insufficient_data';
  /** Number of complete months used when source is history. */
  monthsOfHistory: number;
}

/**
 * Essential monthly expenses, used for the emergency-fund target. Never assumes the whole
 * budgetable income is essential. Order: user override → essential category budgets →
 * average of up to three complete prior months of essential spending → insufficient data.
 */
export function estimateEssentialMonthly(
  today: IsoDate,
  settings: Pick<AppSettings, 'essentialMonthlyOverrideCents'>,
  budgets: readonly Budget[],
  categories: readonly Category[],
  transactions: readonly Transaction[],
): EssentialEstimate {
  if (settings.essentialMonthlyOverrideCents !== null) {
    return {
      monthlyCents: settings.essentialMonthlyOverrideCents,
      source: 'override',
      monthsOfHistory: 0,
    };
  }
  const essentialIds = new Set(categories.filter((c) => c.group === 'essential').map((c) => c.id));
  const essentialBudgets = budgets.filter(
    (b) => b.active && b.workspace === 'personal' && essentialIds.has(b.categoryId),
  );
  const budgetTotal = essentialBudgets.reduce((s, b) => s + b.limitCents, 0);
  if (budgetTotal > 0) {
    return { monthlyCents: budgetTotal, source: 'budgets', monthsOfHistory: 0 };
  }
  const totals: Cents[] = [];
  for (let i = 1; i <= 3; i++) {
    const monthStart = addMonths(startOfMonth(today), -i);
    const spent = spendingByCategory(transactions, 'personal', monthStart, endOfMonth(monthStart));
    let total = 0;
    for (const [catId, amount] of spent) if (catId && essentialIds.has(catId)) total += amount;
    if (total > 0) totals.push(total);
  }
  if (totals.length === 0) {
    return { monthlyCents: null, source: 'insufficient_data', monthsOfHistory: 0 };
  }
  return {
    monthlyCents: divideRounded(
      totals.reduce((s, v) => s + v, 0),
      totals.length,
    ),
    source: 'history',
    monthsOfHistory: totals.length,
  };
}

export interface GoalReserveLine {
  goalId: string;
  name: string;
  balanceCents: Cents;
  /** True when the money already sits in an account excluded from spendable cash. */
  heldOutsideEligibleCash: boolean;
}

export interface GoalReserves {
  /** Allocations that must be subtracted from eligible cash. */
  reservedCents: Cents;
  /** Allocations already outside eligible cash (not subtracted again). */
  heldOutsideCents: Cents;
  lines: GoalReserveLine[];
}

/**
 * Virtual goal allocations reserved against real balances. An allocation is deducted from eligible
 * cash only when its money is in eligible cash: goals linked to an account that is excluded from
 * spendable cash are already outside it, so subtracting them would double count.
 */
export function goalReserves(
  goals: readonly SavingsGoal[],
  contributions: readonly GoalContribution[],
  accounts: readonly Account[],
  view: WorkspaceView,
): GoalReserves {
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const result: GoalReserves = { reservedCents: 0, heldOutsideCents: 0, lines: [] };
  for (const g of goals) {
    if (g.state === 'archived' || !inView(g.workspace, view)) continue;
    const balance = goalBalance(g.id, contributions);
    if (balance <= 0) continue;
    const linked = g.linkedAccountId ? accountById.get(g.linkedAccountId) : undefined;
    const outside = linked !== undefined && (!linked.includeInSpendable || !linked.active);
    if (outside) result.heldOutsideCents += balance;
    else result.reservedCents += balance;
    result.lines.push({
      goalId: g.id,
      name: g.name,
      balanceCents: balance,
      heldOutsideEligibleCash: outside,
    });
  }
  return result;
}

/**
 * Actual savings made in a period: positive goal allocations dated in the period, plus transfers
 * out of spendable accounts into non-spendable accounts (e.g. a savings account) that are not
 * already linked to a recorded allocation.
 */
export function savingsMadeInPeriod(
  goals: readonly SavingsGoal[],
  contributions: readonly GoalContribution[],
  accounts: readonly Account[],
  transactions: readonly Transaction[],
  view: WorkspaceView,
  start: IsoDate,
  end: IsoDate,
): Cents {
  const goalById = new Map(goals.map((g) => [g.id, g]));
  const linkedTxnIds = new Set<string>();
  let total = 0;
  for (const c of contributions) {
    if (c.transactionId) linkedTxnIds.add(c.transactionId);
    const g = goalById.get(c.goalId);
    if (!g || !inView(g.workspace, view)) continue;
    if (c.amountCents > 0 && isWithin(c.date, start, end)) total += c.amountCents;
  }
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const legsByTransfer = new Map<string, Transaction[]>();
  for (const t of transactions) {
    if (t.type !== 'transfer' || !t.transferId || !isActual(t)) continue;
    const legs = legsByTransfer.get(t.transferId) ?? [];
    legs.push(t);
    legsByTransfer.set(t.transferId, legs);
  }
  for (const legs of legsByTransfer.values()) {
    const into = legs.find((l) => l.amountCents > 0);
    const outOf = legs.find((l) => l.amountCents < 0);
    if (!into || !outOf || !isWithin(into.date, start, end)) continue;
    if (!inView(into.workspace, view) || into.workspace !== outOf.workspace) continue;
    if (linkedTxnIds.has(into.id) || linkedTxnIds.has(outOf.id)) continue;
    const dest = accountById.get(into.accountId);
    const src = accountById.get(outOf.accountId);
    if (dest && src && src.includeInSpendable && !dest.includeInSpendable) {
      total += into.amountCents;
    }
  }
  return total;
}

export interface GoalProgress {
  balanceCents: Cents;
  targetCents: Cents | null;
  /** 0–100 (capped), null when no target. */
  percent: number | null;
  remainingCents: Cents | null;
  /** Monthly amount needed to reach the target by its date, if a date is set. */
  requiredMonthlyCents: Cents | null;
  /** Projected completion based on the planned monthly contribution, if set. */
  projectedCompletion: IsoDate | null;
}

export function goalProgress(
  goal: SavingsGoal,
  balanceCents: Cents,
  targetCents: Cents | null,
  today: IsoDate,
): GoalProgress {
  const remaining = targetCents === null ? null : Math.max(0, targetCents - balanceCents);
  const percent =
    targetCents === null || targetCents === 0
      ? null
      : Math.min(100, Math.floor((Math.max(0, balanceCents) * 100) / targetCents));
  let requiredMonthly: Cents | null = null;
  if (remaining !== null && goal.targetDate) {
    if (remaining === 0) requiredMonthly = 0;
    else {
      const t = parts(today);
      const d = parts(goal.targetDate);
      const months = (d.year - t.year) * 12 + (d.month - t.month);
      requiredMonthly =
        diffDays(today, goal.targetDate) <= 0
          ? remaining
          : Math.ceil(remaining / Math.max(1, months));
    }
  }
  let projected: IsoDate | null = null;
  if (remaining !== null) {
    if (remaining === 0) projected = today;
    else if (goal.plannedMonthlyCents && goal.plannedMonthlyCents > 0) {
      projected = addMonths(today, Math.ceil(remaining / goal.plannedMonthlyCents));
    }
  }
  return {
    balanceCents,
    targetCents,
    percent,
    remainingCents: remaining,
    requiredMonthlyCents: requiredMonthly,
    projectedCompletion: projected,
  };
}
