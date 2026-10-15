import type {
  Account,
  AppSettings,
  Budget,
  Category,
  GoalContribution,
  RecurringRule,
  SavingsGoal,
  Transaction,
  WorkspaceView,
} from '../models';
import { type IsoDate, addDays } from '../dates';
import type { Cents } from '../money';
import { accountBalance, pendingTotal } from './balances';
import { type DiscretionaryBudgetStatus, discretionaryBudgetStatus } from './budgets';
import { type GoalReserves, goalReserves, savingsMadeInPeriod } from './goals';
import { budgetableIncome, savingsTarget } from './income';
import { type BudgetPeriod, type SpendingWindow, budgetPeriod, spendingWindow } from './period';
import { type Occurrence, reconcileOccurrences } from './recurring';
import { inView } from './reporting';

export interface AvailableToSpendInput {
  today: IsoDate;
  view: WorkspaceView;
  settings: AppSettings;
  accounts: readonly Account[];
  transactions: readonly Transaction[];
  recurringRules: readonly RecurringRule[];
  budgets: readonly Budget[];
  categories: readonly Category[];
  goals: readonly SavingsGoal[];
  goalContributions: readonly GoalContribution[];
}

export interface AccountCashLine {
  accountId: string;
  name: string;
  balanceCents: Cents;
  pendingCents: Cents;
}

export interface PlannedSavings {
  /** Whether the remaining planned savings is reserved in this calculation. */
  applied: boolean;
  budgetableIncomeCents: Cents;
  targetCents: Cents;
  madeThisPeriodCents: Cents;
  remainingCents: Cents;
}

export type AvailableWarning =
  | 'no_eligible_accounts'
  | 'cash_shortfall'
  | 'savings_target_unaffordable'
  | 'discretionary_overspent'
  | 'overdue_commitments'
  | 'expected_income_late'
  | 'uncategorised_spending'
  | 'items_need_review';

export interface AvailableToSpendResult {
  today: IsoDate;
  view: WorkspaceView;
  window: SpendingWindow;
  period: BudgetPeriod;
  eligibleCash: {
    totalCents: Cents;
    pendingCents: Cents;
    included: AccountCashLine[];
    excluded: AccountCashLine[];
  };
  commitments: {
    /** Unresolved expense occurrences due from the period start to the window end. */
    totalCents: Cents;
    items: Occurrence[];
    /** Occurrences already matched to a posted transaction or marked settled (not deducted). */
    resolved: Occurrence[];
  };
  goalReserves: GoalReserves;
  plannedSavings: PlannedSavings;
  discretionary: DiscretionaryBudgetStatus;
  expectedIncome: {
    /** Forecast only — never added to available-to-spend. */
    totalCents: Cents;
    items: Occurrence[];
  };
  /** eligible − commitments − goal reserves − remaining planned savings (may be negative). */
  cashBasedCents: Cents;
  basis: 'cash_and_budget' | 'cash_only';
  bindingConstraint: 'cash' | 'budget';
  /** Final figure, never negative. */
  availableCents: Cents;
  /** Amount by which commitments and reserves exceed eligible cash (0 if none). */
  shortfallCents: Cents;
  dailyAllowanceCents: Cents;
  needsReviewCount: number;
  warnings: AvailableWarning[];
}

/**
 * Daily allowance = available ÷ days remaining (today counts as one day), rounded down to the cent
 * so the guidance is never more generous than the available amount.
 */
export function dailyAllowance(availableCents: Cents, daysRemaining: number): Cents {
  if (daysRemaining <= 0 || availableCents <= 0) return 0;
  return Math.floor(availableCents / daysRemaining);
}

/**
 * Available-to-spend:
 *   max(0, min(eligible_cash − unpaid_commitments − virtual_reserves − remaining_planned_savings,
 *              discretionary_budget_remaining  [only when strict budgets are on and set]))
 *
 * Double-counting safeguards:
 * - Only posted balances are eligible cash; forecasts and unpaid invoices never are.
 * - A planned bill is deducted only while it has no matching posted transaction or settlement.
 * - Goal allocations held in a non-spendable account are not subtracted again.
 * - Planned savings already made this period (allocations or transfers to savings) reduce the
 *   remaining planned savings, so they are not reserved twice.
 * - Expected income is shown as forecast but never added.
 */
export function calculateAvailableToSpend(input: AvailableToSpendInput): AvailableToSpendResult {
  const { today, view, settings } = input;
  const window = spendingWindow(today, settings);
  const period = budgetPeriod(today, settings);
  const warnings: AvailableWarning[] = [];

  // 1. Eligible cash
  const included: AccountCashLine[] = [];
  const excluded: AccountCashLine[] = [];
  for (const a of input.accounts) {
    if (!inView(a.workspace, view)) continue;
    const line: AccountCashLine = {
      accountId: a.id,
      name: a.name,
      balanceCents: accountBalance(a, input.transactions),
      pendingCents: pendingTotal(a, input.transactions),
    };
    if (a.active && a.includeInSpendable) included.push(line);
    else if (a.active) excluded.push(line);
  }
  const eligibleTotal = included.reduce((s, l) => s + l.balanceCents, 0);
  const pendingTotalCents = included.reduce((s, l) => s + l.pendingCents, 0);
  if (included.length === 0) warnings.push('no_eligible_accounts');

  // 2. Commitments and expected income (forecasts reconciled against actuals)
  const rules = input.recurringRules.filter((r) => inView(r.workspace, view));
  const commitmentsFrom = period.start < today ? period.start : today;
  // Look one day past the window so income expected on the next payday is shown as forecast.
  const occurrences = reconcileOccurrences(
    rules,
    input.transactions,
    commitmentsFrom,
    addDays(window.end, 1),
  );
  const expenseOcc = occurrences.filter((o) => o.direction === 'expense' && o.date <= window.end);
  const unpaid = expenseOcc.filter((o) => o.status === 'unmatched');
  const commitmentsTotal = unpaid.reduce((s, o) => s + o.expectedCents, 0);
  if (unpaid.some((o) => o.date < today)) warnings.push('overdue_commitments');

  const incomeOcc = occurrences.filter((o) => o.direction === 'income' && o.status === 'unmatched');
  if (incomeOcc.some((o) => o.date < today)) warnings.push('expected_income_late');

  // 3. Goal reserves (virtual allocations)
  const reserves = goalReserves(input.goals, input.goalContributions, input.accounts, view);

  // 4. Planned savings for this period (salary plan applies to the personal workspace)
  const base = budgetableIncome(settings.monthlySalaryCents, settings.monthlyTitheCents);
  const target = view === 'business' ? 0 : savingsTarget(base, settings.savingsRatePercent);
  const made = savingsMadeInPeriod(
    input.goals,
    input.goalContributions,
    input.accounts,
    input.transactions,
    view === 'business' ? 'business' : 'personal',
    period.start,
    period.end,
  );
  const plannedRemaining = Math.max(0, target - made);
  const applySavings = settings.reservePlannedSavings && view !== 'business';
  const plannedSavings: PlannedSavings = {
    applied: applySavings,
    budgetableIncomeCents: base,
    targetCents: target,
    madeThisPeriodCents: made,
    remainingCents: plannedRemaining,
  };

  // 5. Discretionary budget
  const discretionary = discretionaryBudgetStatus(
    input.budgets,
    input.categories,
    input.transactions,
    view,
    period.start,
    period.end,
  );
  if (discretionary.enabled && discretionary.remainingCents < 0) {
    warnings.push('discretionary_overspent');
  }
  if (discretionary.uncategorisedSpentCents > 0) warnings.push('uncategorised_spending');

  // 6. Combine
  const beforeSavings = eligibleTotal - commitmentsTotal - reserves.reservedCents;
  const cashBased = beforeSavings - (applySavings ? plannedRemaining : 0);
  if (plannedRemaining > 0 && beforeSavings < plannedRemaining && view !== 'business') {
    warnings.push('savings_target_unaffordable');
  }
  const useBudgetCap = settings.strictBudgetCap && discretionary.enabled;
  let available = cashBased;
  let binding: 'cash' | 'budget' = 'cash';
  if (useBudgetCap && discretionary.remainingCents < cashBased) {
    available = discretionary.remainingCents;
    binding = 'budget';
  }
  available = Math.max(0, available);
  const shortfall = cashBased < 0 ? -cashBased : 0;
  if (shortfall > 0) warnings.push('cash_shortfall');

  const needsReviewCount = input.transactions.filter(
    (t) => !t.archived && t.status === 'needs_review' && inView(t.workspace, view),
  ).length;
  if (needsReviewCount > 0) warnings.push('items_need_review');

  return {
    today,
    view,
    window,
    period,
    eligibleCash: {
      totalCents: eligibleTotal,
      pendingCents: pendingTotalCents,
      included,
      excluded,
    },
    commitments: {
      totalCents: commitmentsTotal,
      items: unpaid,
      resolved: expenseOcc.filter((o) => o.status !== 'unmatched'),
    },
    goalReserves: reserves,
    plannedSavings,
    discretionary,
    expectedIncome: {
      totalCents: incomeOcc.reduce((s, o) => s + o.expectedCents, 0),
      items: incomeOcc,
    },
    cashBasedCents: cashBased,
    basis: useBudgetCap ? 'cash_and_budget' : 'cash_only',
    bindingConstraint: binding,
    availableCents: available,
    shortfallCents: shortfall,
    dailyAllowanceCents: dailyAllowance(available, window.daysRemaining),
    needsReviewCount,
    warnings,
  };
}
