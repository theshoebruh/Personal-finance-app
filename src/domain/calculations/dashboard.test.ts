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
});
