import type { Transaction } from '../models';
import { type IsoDate, addDays, diffDays, endOfMonth, startOfMonth } from '../dates';
import { type Cents, formatZAR } from '../money';
import {
  type AvailableToSpendInput,
  type AvailableToSpendResult,
  calculateAvailableToSpend,
} from './availableToSpend';
import { type BudgetLine, budgetLines } from './budgets';
import {
  type EssentialEstimate,
  type GoalProgress,
  emergencyFundTarget,
  estimateEssentialMonthly,
  goalBalance,
  goalProgress,
} from './goals';
import { type IncomeExpenseSummary, inView, summariseIncomeExpenses } from './reporting';
import type { Occurrence } from './recurring';

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

export interface DashboardModel {
  ats: AvailableToSpendResult;
  month: { start: IsoDate; end: IsoDate; summary: IncomeExpenseSummary };
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
  budgets: BudgetLine[];
  upcomingBills: Occurrence[];
  recent: Transaction[];
  uncategorisedCount: number;
  alerts: DashboardAlert[];
}

/** Everything the dashboard shows, derived from local data with pure functions. */
export function buildDashboard(input: AvailableToSpendInput): DashboardModel {
  const { today, view, settings } = input;
  const ats = calculateAvailableToSpend(input);
  const monthStart = startOfMonth(today);
  const monthEnd = endOfMonth(today);
  const summary = summariseIncomeExpenses(input.transactions, view, monthStart, monthEnd);

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
    ats.period.start,
    ats.period.end,
  );

  // Upcoming bills within each rule's alert lead time
  const leadByRule = new Map(input.recurringRules.map((r) => [r.id, r.alertLeadDays]));
  const upcomingBills = ats.commitments.items.filter((o) => {
    const lead = leadByRule.get(o.ruleId) ?? 3;
    return o.date >= today && o.date <= addDays(today, lead);
  });

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
    month: { start: monthStart, end: monthEnd, summary },
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
    budgets: lines,
    upcomingBills,
    recent,
    uncategorisedCount,
    alerts,
  };
}
