import type {
  AppSettings,
  Budget,
  GoalContribution,
  GoalType,
  RecurringRule,
  SavingsGoal,
  Workspace,
} from '@/domain/models';
import { GOAL_TYPE_LABELS } from '@/domain/models';
import {
  type IsoDate,
  addMonths,
  daysInMonth,
  makeDate,
  parts,
  startOfMonth,
} from '@/domain/dates';
import type { FinanceStore } from '@/data/repositories/types';
import { occurrenceDates } from '@/domain/calculations/recurring';
import { type Clock, DomainError, newId, systemClock } from './common';

// ---------------------------------------------------------------- Recurring items

export type RecurringRuleInput = Omit<
  RecurringRule,
  'id' | 'createdAt' | 'updatedAt' | 'isDemo' | 'settledDates'
> & { settledDates?: IsoDate[] };

export async function saveRecurringRule(
  store: FinanceStore,
  input: RecurringRuleInput & { id?: string },
  opts: { isDemo?: boolean; clock?: Clock } = {},
): Promise<RecurringRule> {
  const now = (opts.clock ?? systemClock).now();
  const existing = input.id ? await store.recurringRules.get(input.id) : undefined;
  const rule: RecurringRule = {
    ...input,
    id: existing?.id ?? input.id ?? newId(),
    settledDates: input.settledDates ?? existing?.settledDates ?? [],
    isDemo: existing?.isDemo ?? opts.isDemo ?? false,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  return store.recurringRules.put(rule);
}

/** Mark a forecast occurrence as paid/received outside the app (or skipped), or undo that. */
export async function setOccurrenceSettled(
  store: FinanceStore,
  ruleId: string,
  date: IsoDate,
  settled: boolean,
  clock: Clock = systemClock,
): Promise<void> {
  const rule = await store.recurringRules.get(ruleId);
  if (!rule) throw new DomainError('Recurring item not found');
  const dates = new Set(rule.settledDates);
  if (settled) dates.add(date);
  else dates.delete(date);
  await store.recurringRules.put({
    ...rule,
    settledDates: [...dates].sort(),
    updatedAt: clock.now(),
  });
}

/**
 * Record that a transaction is the payment (or receipt) for one occurrence of a recurring item,
 * e.g. an imported tithe described only as the church name. The occurrence then counts as paid and
 * is not deducted again. Stored on the transaction's existing recurring-item fields.
 */
export async function linkPaymentToOccurrence(
  store: FinanceStore,
  transactionId: string,
  ruleId: string,
  date: IsoDate,
  clock: Clock = systemClock,
): Promise<void> {
  const [t, rule] = await Promise.all([
    store.transactions.get(transactionId),
    store.recurringRules.get(ruleId),
  ]);
  if (!t) throw new DomainError('Transaction not found');
  if (!rule) throw new DomainError('Recurring item not found');
  const directionOk =
    rule.direction === 'expense'
      ? t.type === 'expense' && t.amountCents < 0
      : t.type === 'income' && t.amountCents > 0;
  if (!directionOk) {
    throw new DomainError(
      rule.direction === 'expense'
        ? 'Only an expense can pay a recurring bill.'
        : 'Only income can be recorded as expected income.',
    );
  }
  if (t.workspace !== rule.workspace) {
    throw new DomainError('The transaction and the recurring item are in different workspaces.');
  }
  if (!occurrenceDates(rule, date, date).includes(date)) {
    throw new DomainError(`${rule.name} isn't due on that date.`);
  }
  const taken = (await store.transactions.list()).find(
    (o) => o.id !== t.id && o.recurringRuleId === ruleId && o.recurringOccurrenceDate === date,
  );
  if (taken)
    throw new DomainError(`Another transaction is already linked to ${rule.name} on that date.`);
  await store.transactions.put({
    ...t,
    recurringRuleId: ruleId,
    recurringOccurrenceDate: date,
    updatedAt: clock.now(),
  });
}

/** Remove a transaction's link to a recurring item; the occurrence is matched normally again. */
export async function unlinkPayment(
  store: FinanceStore,
  transactionId: string,
  clock: Clock = systemClock,
): Promise<void> {
  const t = await store.transactions.get(transactionId);
  if (!t) throw new DomainError('Transaction not found');
  const next = { ...t, updatedAt: clock.now() };
  delete next.recurringRuleId;
  delete next.recurringOccurrenceDate;
  await store.transactions.put(next);
}

export async function deleteRecurringRule(store: FinanceStore, id: string): Promise<void> {
  await store.recurringRules.delete(id);
}

/** Next date with the given day-of-month on or after `today` (clamped to month length). */
function nextDayOfMonth(today: IsoDate, day: number): IsoDate {
  const { year, month } = parts(today);
  const candidate = makeDate(year, month, Math.min(day, daysInMonth(year, month)));
  if (candidate >= today) return candidate;
  const n = parts(addMonths(startOfMonth(today), 1));
  return makeDate(n.year, n.month, Math.min(day, daysInMonth(n.year, n.month)));
}

/**
 * Creates monthly Salary (income forecast) and Tithe (committed outgoing) items from the income
 * plan. The salary budget base is still derived from settings exactly once; these items only
 * drive forecasts and commitment matching, so the tithe is never deducted twice.
 */
export async function createSalaryAndTitheRules(
  store: FinanceStore,
  settings: AppSettings,
  accountId: string,
  today: IsoDate,
  clock: Clock = systemClock,
): Promise<RecurringRule[]> {
  const account = await store.accounts.get(accountId);
  if (!account) throw new DomainError('Account not found');
  if (settings.paydayDayOfMonth === null) throw new DomainError('Set your payday first');
  const startDate = nextDayOfMonth(today, settings.paydayDayOfMonth);
  const common = {
    frequency: 'monthly' as const,
    startDate,
    accountId,
    workspace: account.workspace,
    active: true,
    matchWindowDays: 5,
    alertLeadDays: 3,
  };
  const created: RecurringRule[] = [];
  if (settings.monthlySalaryCents > 0) {
    created.push(
      await saveRecurringRule(
        store,
        {
          ...common,
          name: 'Salary',
          direction: 'income',
          amountCents: settings.monthlySalaryCents,
          categoryId: 'cat-salary',
        },
        { clock },
      ),
    );
  }
  if (settings.monthlyTitheCents > 0) {
    created.push(
      await saveRecurringRule(
        store,
        {
          ...common,
          name: 'Tithe',
          direction: 'expense',
          amountCents: settings.monthlyTitheCents,
          categoryId: 'cat-tithe',
        },
        { clock },
      ),
    );
  }
  return created;
}

// ---------------------------------------------------------------- Budgets

/** Create or update the monthly limit for a category in a workspace. A limit of null removes it. */
export async function setCategoryBudget(
  store: FinanceStore,
  categoryId: string,
  workspace: Workspace,
  limitCents: number | null,
  clock: Clock = systemClock,
): Promise<Budget | null> {
  const existing = (await store.budgets.list()).find(
    (b) => b.categoryId === categoryId && b.workspace === workspace,
  );
  if (limitCents === null) {
    if (existing) await store.budgets.delete(existing.id);
    return null;
  }
  const now = clock.now();
  return store.budgets.put({
    id: existing?.id ?? newId(),
    categoryId,
    workspace,
    period: 'monthly',
    limitCents,
    active: true,
    isDemo: existing?.isDemo ?? false,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  });
}

// ---------------------------------------------------------------- Goals

const DEFAULT_GOAL_ORDER: { type: GoalType; workspace: Workspace }[] = [
  { type: 'emergency_fund', workspace: 'personal' },
  { type: 'monthly_buffer', workspace: 'personal' },
  { type: 'personal_purchase', workspace: 'personal' },
  { type: 'business_growth', workspace: 'business' },
];

/** Creates the four default goals in priority order, skipping types that already exist. */
export async function createDefaultGoals(
  store: FinanceStore,
  clock: Clock = systemClock,
): Promise<SavingsGoal[]> {
  const existing = new Set((await store.goals.list()).map((g) => g.goalType));
  const now = clock.now();
  const goals: SavingsGoal[] = DEFAULT_GOAL_ORDER.filter((d) => !existing.has(d.type)).map((d) => ({
    id: newId(),
    name: GOAL_TYPE_LABELS[d.type],
    goalType: d.type,
    workspace: d.workspace,
    targetMode: d.type === 'emergency_fund' ? 'emergency_auto' : 'fixed',
    targetCents: null,
    priority: DEFAULT_GOAL_ORDER.findIndex((o) => o.type === d.type) + 1,
    state: 'active',
    isDemo: false,
    createdAt: now,
    updatedAt: now,
  }));
  await store.goals.bulkPut(goals);
  return goals;
}

export async function saveGoal(
  store: FinanceStore,
  goal: Omit<SavingsGoal, 'id' | 'createdAt' | 'updatedAt' | 'isDemo'> & { id?: string },
  opts: { isDemo?: boolean; clock?: Clock } = {},
): Promise<SavingsGoal> {
  const now = (opts.clock ?? systemClock).now();
  const existing = goal.id ? await store.goals.get(goal.id) : undefined;
  return store.goals.put({
    ...goal,
    id: existing?.id ?? goal.id ?? newId(),
    isDemo: existing?.isDemo ?? opts.isDemo ?? false,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  });
}

/**
 * Record a virtual allocation (+) or withdrawal (−). Withdrawals cannot exceed the goal balance,
 * so a goal can never imply more money than was set aside.
 */
export async function addGoalContribution(
  store: FinanceStore,
  input: {
    goalId: string;
    date: IsoDate;
    amountCents: number;
    transactionId?: string;
    note?: string;
  },
  opts: { isDemo?: boolean; clock?: Clock; id?: string } = {},
): Promise<GoalContribution> {
  const goal = await store.goals.get(input.goalId);
  if (!goal) throw new DomainError('Goal not found');
  if (input.amountCents < 0) {
    const balance = (await store.goalContributions.list())
      .filter((c) => c.goalId === goal.id)
      .reduce((s, c) => s + c.amountCents, 0);
    if (balance + input.amountCents < 0) {
      throw new DomainError('Withdrawal is larger than the amount allocated to this goal');
    }
  }
  const now = (opts.clock ?? systemClock).now();
  return store.goalContributions.put({
    id: opts.id ?? newId(),
    goalId: goal.id,
    date: input.date,
    amountCents: input.amountCents,
    ...(input.transactionId ? { transactionId: input.transactionId } : {}),
    ...(input.note ? { note: input.note } : {}),
    isDemo: opts.isDemo ?? false,
    createdAt: now,
    updatedAt: now,
  });
}
