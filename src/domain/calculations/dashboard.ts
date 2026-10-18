import { findRepeatedImports } from '../imports/staging';
import type { Transaction } from '../models';
import { type IsoDate, addDays, daysInclusive, diffDays } from '../dates';
import { type Cents, formatZAR } from '../money';
import {
  type AvailableToSpendInput,
  type AvailableToSpendResult,
  calculateAvailableToSpend,
} from './availableToSpend';
import { type BudgetLine, budgetLines } from './budgets';
import { type BudgetPeriod, previousBudgetPeriod, withReceivedPaydays } from './period';
import {
  type EssentialEstimate,
  type GoalProgress,
  emergencyFundTarget,
  estimateEssentialMonthly,
  goalBalance,
  goalProgress,
  savingsMadeInPeriod,
  unpairedOutgoingTransfers,
} from './goals';
import {
  type IncomeExpenseSummary,
  inView,
  spendingByCategory,
  summariseIncomeExpenses,
} from './reporting';
import { type Occurrence, possiblePayments, reconcileOccurrences } from './recurring';

export interface DashboardAlert {
  id: string;
  tone: 'info' | 'warning' | 'negative';
  title: string;
  detail?: string;
  link?: { to: string; label: string };
}

export interface GoalSummary {
  goalId: string;
  name: string;
  priority: number;
  state: string;
  heldIn: 'virtual' | 'linked_account';
  progress: GoalProgress;
  behindSchedule: boolean;
}

export interface BudgetOverview {
  lines: BudgetLine[];
  /** Totals over the budgeted categories only. */
  limitCents: Cents;
  spentCents: Cents;
  /** limit − spent; negative means over budget overall. */
  remainingCents: Cents;
  /** Spending in categories that have no active budget. */
  unbudgetedSpentCents: Cents;
  uncategorisedSpentCents: Cents;
}

export interface PeriodSummary extends BudgetPeriod {
  summary: IncomeExpenseSummary;
}

export interface LastPeriod extends PeriodSummary {
  budgetLimitCents: Cents;
  budgetSpentCents: Cents;
  savingsMadeCents: Cents;
}

export interface DashboardModel {
  ats: AvailableToSpendResult;
  /** The current budget period (pay period or calendar month, per Settings). */
  period: PeriodSummary & { dayNumber: number; totalDays: number };
  budgetOverview: BudgetOverview;
  lastPeriod: LastPeriod;
  essential: EssentialEstimate;
  emergency: {
    goalId: string | null;
    targetCents: Cents | null;
    balanceCents: Cents;
    percent: number | null;
    months: number;
    targetSource: 'fixed_override' | 'goal_fixed' | 'essential_estimate' | 'unknown';
  };
  goals: GoalSummary[];
  upcomingBills: Occurrence[];
  /** One-sided transfers out of spendable accounts this period (not counted as savings). */
  unpairedTransfers: Transaction[];
  /** Expected income that is due but not recorded (or not recognised) yet. */
  lateIncome: Occurrence[];
  /** Possible payments for unmatched occurrences, keyed `${ruleId}|${date}`; never auto-linked. */
  paymentSuggestions: Record<string, Transaction[]>;
  recent: Transaction[];
  uncategorisedCount: number;
  alerts: DashboardAlert[];
}

/** Everything the dashboard shows, derived from local data with pure functions. */
export function buildDashboard(input: AvailableToSpendInput): DashboardModel {
  const { today, view, settings } = input;
  const ats = calculateAvailableToSpend(input);
  const { period } = ats;
  const summary = summariseIncomeExpenses(input.transactions, view, period.start, period.end);

  // Emergency fund
  const essential = estimateEssentialMonthly(
    today,
    settings,
    input.budgets,
    input.categories,
    input.transactions,
  );
  const efGoal = input.goals.find((g) => g.goalType === 'emergency_fund' && g.state !== 'archived');
  let efTarget: Cents | null = null;
  let targetSource: DashboardModel['emergency']['targetSource'] = 'unknown';
  if (settings.emergencyFundFixedTargetCents !== null) {
    efTarget = settings.emergencyFundFixedTargetCents;
    targetSource = 'fixed_override';
  } else if (efGoal && efGoal.targetMode === 'fixed' && efGoal.targetCents !== null) {
    efTarget = efGoal.targetCents;
    targetSource = 'goal_fixed';
  } else if (essential.monthlyCents !== null) {
    efTarget = emergencyFundTarget(essential.monthlyCents, settings.emergencyFundMonths);
    targetSource = 'essential_estimate';
  }
  const efBalance = efGoal ? goalBalance(efGoal.id, input.goalContributions) : 0;

  // Goals
  const goals: GoalSummary[] = input.goals
    .filter((g) => g.state !== 'archived' && inView(g.workspace, view))
    .sort((a, b) => a.priority - b.priority)
    .map((g) => {
      const balance = goalBalance(g.id, input.goalContributions);
      const target =
        g.goalType === 'emergency_fund' && g.targetMode === 'emergency_auto'
          ? efTarget
          : g.targetCents;
      const progress = goalProgress(g, balance, target, today);
      const behind =
        g.state === 'active' &&
        progress.requiredMonthlyCents !== null &&
        progress.requiredMonthlyCents > (g.plannedMonthlyCents ?? 0);
      return {
        goalId: g.id,
        name: g.name,
        priority: g.priority,
        state: g.state,
        heldIn: g.linkedAccountId ? 'linked_account' : 'virtual',
        progress,
        behindSchedule: behind,
      };
    });

  const lines = budgetLines(
    input.budgets,
    input.categories,
    input.transactions,
    view,
    period.start,
    period.end,
  );
  const budgetOverview = overview(input, lines, period.start, period.end);

  // How the previous period ended (derived from the same records; nothing is stored or reset).
  const pay = withReceivedPaydays(today, settings, input.recurringRules, input.transactions);
  const prev = previousBudgetPeriod(period, pay);
  const prevLines = budgetLines(
    input.budgets,
    input.categories,
    input.transactions,
    view,
    prev.start,
    prev.end,
  );
  const lastPeriod: LastPeriod = {
    ...prev,
    summary: summariseIncomeExpenses(input.transactions, view, prev.start, prev.end),
    budgetLimitCents: prevLines.reduce((sum, l) => sum + l.limitCents, 0),
    budgetSpentCents: prevLines.reduce((sum, l) => sum + l.spentCents, 0),
    savingsMadeCents:
      view === 'business'
        ? 0
        : savingsMadeInPeriod(
            input.goals,
            input.goalContributions,
            input.accounts,
            input.transactions,
            'personal',
            prev.start,
            prev.end,
          ),
  };

  // Upcoming bills within each rule's alert lead time
  const leadByRule = new Map(input.recurringRules.map((r) => [r.id, r.alertLeadDays]));
  const upcomingBills = ats.commitments.items.filter((o) => {
    const lead = leadByRule.get(o.ruleId) ?? 3;
    return o.date >= today && o.date <= addDays(today, lead);
  });

  // Transactions that could pay an unmatched bill (or be late income) but weren't recognised.
  const claimed = new Set(
    reconcileOccurrences(
      input.recurringRules,
      input.transactions,
      addDays(period.start, -40),
      addDays(ats.window.end, 1),
    )
      .map((o) => o.matchedTransactionId)
      .filter((id): id is string => id !== undefined),
  );
  const ruleById = new Map(input.recurringRules.map((r) => [r.id, r]));
  const lateIncome = ats.expectedIncome.items.filter((o) => o.date <= today);
  const paymentSuggestions: Record<string, Transaction[]> = {};
  for (const o of [...ats.commitments.items, ...lateIncome]) {
    const rule = ruleById.get(o.ruleId);
    const found = rule ? possiblePayments(rule, o, input.transactions, claimed) : [];
    if (found.length > 0) paymentSuggestions[`${o.ruleId}|${o.date}`] = found;
  }

  const inViewTxns = input.transactions.filter((t) => !t.archived && inView(t.workspace, view));
  const recent = [...inViewTxns]
    .sort((a, b) =>
      a.date === b.date ? (a.createdAt < b.createdAt ? 1 : -1) : a.date < b.date ? 1 : -1,
    )
    .slice(0, 6);
  const uncategorisedCount = inViewTxns.filter(
    (t) =>
      t.categoryId === null &&
      (t.type === 'expense' || t.type === 'income' || t.type === 'refund') &&
      t.status !== 'excluded',
  ).length;

  // Alerts — explainable, actionable, non-judgemental
  const alerts: DashboardAlert[] = [];
  const w = new Set(ats.warnings);
  if (w.has('no_eligible_accounts')) {
    alerts.push({
      id: 'no-accounts',
      tone: 'info',
      title: 'No spendable accounts yet',
      detail: 'Add an account and mark it as spendable to calculate what is safe to spend.',
      link: { to: '/accounts', label: 'Add an account' },
    });
  }
  if (w.has('cash_shortfall')) {
    alerts.push({
      id: 'shortfall',
      tone: 'negative',
      title: `Short by about ${formatZAR(ats.shortfallCents)} before ${ats.window.basis === 'next_payday' ? 'payday' : 'month-end'}`,
      detail:
        'Upcoming commitments and reserved savings are more than your spendable balance. Consider moving a bill, lowering the savings target this month, or checking for unrecorded income.',
    });
  }
  if (w.has('savings_target_unaffordable')) {
    alerts.push({
      id: 'savings-unaffordable',
      tone: 'warning',
      title: `Your ${settings.savingsRatePercent}% savings target is above what is left after commitments this period`,
      detail: `About ${formatZAR(ats.plannedSavings.remainingCents)} of planned savings is still to be set aside. You could lower the target for now, adjust spending limits or revise goals — nothing is moved automatically.`,
      link: { to: '/settings', label: 'Review savings target' },
    });
  }
  if (w.has('overdue_commitments')) {
    const overdue = ats.commitments.items.filter((o) => o.date < today);
    alerts.push({
      id: 'overdue',
      tone: 'warning',
      title: `${overdue.length} commitment${overdue.length === 1 ? '' : 's'} past due with no matching payment`,
      detail:
        'Still being deducted. If already paid, record the payment or mark it as paid so it is not counted twice.',
    });
  }
  for (const bill of upcomingBills) {
    const days = diffDays(today, bill.date);
    alerts.push({
      id: `bill-${bill.ruleId}-${bill.date}`,
      tone: 'info',
      title: `${bill.ruleName}: ${formatZAR(bill.expectedCents)} due ${days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`}`,
    });
  }
  if (w.has('expected_income_late')) {
    const late = ats.expectedIncome.items.filter((o) => o.date < today);
    for (const o of late) {
      alerts.push({
        id: `late-${o.ruleId}-${o.date}`,
        tone: 'warning',
        title: `Expected income "${o.ruleName}" (${formatZAR(o.expectedCents)}) hasn't been recorded yet`,
        detail:
          'It is not counted as available. Record it when it arrives, or mark it as received.',
      });
    }
  }
  for (const line of lines) {
    if (line.limitCents === 0) continue;
    const pct = (line.spentCents / line.limitCents) * 100;
    if (line.remainingCents < 0) {
      alerts.push({
        id: `budget-over-${line.categoryId}`,
        tone: 'warning',
        title: `${line.categoryName} is ${formatZAR(-line.remainingCents)} over its ${formatZAR(line.limitCents)} limit`,
      });
    } else if (pct >= 85) {
      alerts.push({
        id: `budget-near-${line.categoryId}`,
        tone: 'info',
        title: `${line.categoryName} has used ${Math.floor(pct)}% of its limit`,
        detail: `${formatZAR(line.remainingCents)} left this period.`,
      });
    }
  }
  for (const g of goals) {
    if (g.behindSchedule && g.progress.requiredMonthlyCents !== null) {
      alerts.push({
        id: `goal-behind-${g.goalId}`,
        tone: 'info',
        title: `${g.name} may fall behind its target date`,
        detail: `Reaching it on time needs about ${formatZAR(g.progress.requiredMonthlyCents)}/month.`,
        link: { to: '/goals', label: 'Review goal' },
      });
    }
  }
  const repeated = findRepeatedImports(input.transactions.filter((t) => inView(t.workspace, view)));
  if (repeated.length > 0) {
    const extra = repeated.reduce((s, r) => s + r.copies - r.maxInOneFile, 0);
    alerts.push({
      id: 'repeated-imports',
      tone: 'warning',
      title: `${extra} imported transaction${extra === 1 ? '' : 's'} may be counted twice`,
      detail: `The same statement rows appear in more than one import (for example imported on two devices while offline): ${repeated
        .slice(0, 3)
        .map((r) => `${r.description} on ${r.date}`)
        .join(
          '; ',
        )}${repeated.length > 3 ? '…' : ''}. Archive the extra copies or undo one of the imports.`,
      link: { to: '/import', label: 'Import history' },
    });
  }
  if (ats.needsReviewCount > 0) {
    alerts.push({
      id: 'needs-review',
      tone: 'info',
      title: `${ats.needsReviewCount} transaction${ats.needsReviewCount === 1 ? '' : 's'} need review`,
      link: { to: '/transactions?status=needs_review', label: 'Review' },
    });
  }

  return {
    ats,
    period: {
      ...period,
      summary,
      dayNumber: daysInclusive(period.start, today),
      totalDays: daysInclusive(period.start, period.end),
    },
    budgetOverview,
    lastPeriod,
    essential,
    emergency: {
      goalId: efGoal?.id ?? null,
      targetCents: efTarget,
      balanceCents: efBalance,
      percent: efTarget
        ? Math.min(100, Math.floor((Math.max(0, efBalance) * 100) / efTarget))
        : null,
      months: settings.emergencyFundMonths,
      targetSource,
    },
    goals,
    upcomingBills,
    lateIncome,
    paymentSuggestions,
    unpairedTransfers: unpairedOutgoingTransfers(
      input.accounts,
      input.transactions,
      view,
      period.start,
      period.end,
    ),
    recent,
    uncategorisedCount,
    alerts,
  };
}

function overview(
  input: AvailableToSpendInput,
  lines: BudgetLine[],
  start: IsoDate,
  end: IsoDate,
): BudgetOverview {
  const spent = spendingByCategory(input.transactions, input.view, start, end);
  const budgeted = new Set(lines.map((l) => l.categoryId));
  let unbudgeted = 0;
  for (const [catId, amount] of spent) {
    if (catId !== null && !budgeted.has(catId)) unbudgeted += amount;
  }
  const limit = lines.reduce((sum, l) => sum + l.limitCents, 0);
  const used = lines.reduce((sum, l) => sum + l.spentCents, 0);
  return {
    lines,
    limitCents: limit,
    spentCents: used,
    remainingCents: limit - used,
    unbudgetedSpentCents: Math.max(0, unbudgeted),
    uncategorisedSpentCents: Math.max(0, spent.get(null) ?? 0),
  };
}
