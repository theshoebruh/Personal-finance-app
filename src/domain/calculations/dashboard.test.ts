import {
  makeAccount,
  makeBudget,
  makeCategory,
  makeContribution,
  makeGoal,
  makeRule,
  makeSettings,
  makeTxn,
} from '@/test/factories';
import { buildDashboard } from './dashboard';

const today = '2026-03-20';
const main = makeAccount({ openingBalanceCents: 1_000_000, openingBalanceDate: '2026-03-01' });
const essential = makeCategory({ id: 'cat-rent', group: 'essential', name: 'Rent' });
const fun = makeCategory({ id: 'cat-fun', group: 'discretionary', name: 'Fun' });

const base = {
  today,
  view: 'personal' as const,
  settings: makeSettings({ paydayDayOfMonth: 25, reservePlannedSavings: false }),
  accounts: [main],
  transactions: [],
  recurringRules: [],
  budgets: [],
  categories: [essential, fun],
  goals: [],
  goalContributions: [],
};

describe('dashboard model', () => {
  it('derives the emergency fund target from essential budgets × months', () => {
    const goal = makeGoal({ targetMode: 'emergency_auto', targetCents: null });
    const m = buildDashboard({
      ...base,
      budgets: [makeBudget({ categoryId: essential.id, limitCents: 400_000 })],
      goals: [goal],
      goalContributions: [makeContribution({ goalId: goal.id, amountCents: 300_000 })],
    });
    expect(m.emergency.targetCents).toBe(1_200_000);
    expect(m.emergency.targetSource).toBe('essential_estimate');
    expect(m.emergency.percent).toBe(25);
  });

  it('raises upcoming-bill, budget and shortfall alerts', () => {
    const m = buildDashboard({
      ...base,
      recurringRules: [makeRule({ name: 'Rent', amountCents: 1_200_000, startDate: '2026-01-22' })],
      budgets: [makeBudget({ categoryId: fun.id, limitCents: 10_000 })],
      transactions: [
        makeTxn({
          accountId: main.id,
          amountCents: -15_000,
          categoryId: fun.id,
          date: '2026-03-05',
        }),
      ],
    });
    const ids = m.alerts.map((a) => a.id);
    expect(ids).toContain('shortfall');
    expect(ids.some((id) => id.startsWith('bill-'))).toBe(true);
    expect(ids).toContain('budget-over-cat-fun');
    expect(m.ats.availableCents).toBe(0);
  });

  it('flags goals behind schedule', () => {
    const g = makeGoal({
      name: 'Laptop',
      goalType: 'personal_purchase',
      targetCents: 1_200_000,
      targetDate: '2026-06-30',
      plannedMonthlyCents: 100_000,
    });
    const m = buildDashboard({ ...base, goals: [g] });
    expect(m.goals[0]?.behindSchedule).toBe(true);
    expect(m.alerts.map((a) => a.id)).toContain(`goal-behind-${g.id}`);
  });

  it('summarises the pay period: budget overview, unbudgeted spending and last period', () => {
    const groceries = makeCategory({ id: 'cat-groc', group: 'essential', name: 'Groceries' });
    const spend = (date: string, amountCents: number, categoryId: string | null) =>
      makeTxn({ accountId: main.id, amountCents, date, categoryId });
    const m = buildDashboard({
      ...base,
      settings: makeSettings({
        paydayDayOfMonth: 25,
        reservePlannedSavings: false,
        budgetPeriodMode: 'pay_period',
      }),
      categories: [essential, fun, groceries],
      budgets: [
        makeBudget({ categoryId: fun.id, limitCents: 50_000 }),
        makeBudget({ categoryId: groceries.id, limitCents: 300_000 }),
      ],
      transactions: [
        spend('2026-03-10', -20_000, fun.id),
        spend('2026-03-11', -120_000, groceries.id),
        spend('2026-03-12', -400_000, essential.id), // rent: no budget
        spend('2026-03-13', -3_000, null),
        spend('2026-02-20', -60_000, fun.id), // previous period (25 Jan – 24 Feb)
        spend('2026-02-26', -10_000, fun.id), // this period, before March
      ],
    });
    expect(m.period).toMatchObject({
      start: '2026-02-25',
      end: '2026-03-24',
      mode: 'pay_period',
      dayNumber: 24,
      totalDays: 28,
    });
    expect(m.period.summary.netExpenseCents).toBe(553_000);
    expect(m.budgetOverview).toMatchObject({
      limitCents: 350_000,
      spentCents: 150_000,
      remainingCents: 200_000,
      unbudgetedSpentCents: 400_000,
      uncategorisedSpentCents: 3_000,
    });
    expect(m.budgetOverview.lines.map((l) => [l.categoryName, l.remainingCents])).toEqual([
      ['Fun', 20_000],
      ['Groceries', 180_000],
    ]);
    expect(m.lastPeriod).toMatchObject({
      start: '2026-01-25',
      end: '2026-02-24',
      budgetLimitCents: 350_000,
      budgetSpentCents: 60_000,
    });
  });
});
