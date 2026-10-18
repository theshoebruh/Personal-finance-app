import {
  makeAccount,
  makeBudget,
  makeCategory,
  makeContribution,
  makeGoal,
  makeRule,
  makeSettings,
  makeTransfer,
  makeTxn,
} from '@/test/factories';
import { type AvailableToSpendInput, calculateAvailableToSpend } from './availableToSpend';

const today = '2026-03-20';
const main = makeAccount({
  name: 'Capitec main',
  openingBalanceCents: 1_000_000,
  openingBalanceDate: '2026-03-01',
});
const savingsAcc = makeAccount({
  name: 'Savings',
  type: 'savings',
  includeInSpendable: false,
  openingBalanceDate: '2026-03-01',
});
const eatingOut = makeCategory({ id: 'cat-eat', group: 'discretionary' });

function input(overrides: Partial<AvailableToSpendInput> = {}): AvailableToSpendInput {
  return {
    today,
    view: 'personal',
    // Simple baseline: payday on the 25th, no savings reservation, no budget cap.
    settings: makeSettings({ paydayDayOfMonth: 25, reservePlannedSavings: false }),
    accounts: [main, savingsAcc],
    transactions: [],
    recurringRules: [],
    budgets: [],
    categories: [eatingOut],
    goals: [],
    goalContributions: [],
    ...overrides,
  };
}

describe('available to spend', () => {
  it('uses eligible cash only and divides by days to payday', () => {
    const r = calculateAvailableToSpend(input());
    expect(r.eligibleCash.totalCents).toBe(1_000_000);
    expect(r.eligibleCash.excluded.map((l) => l.name)).toEqual(['Savings']);
    expect(r.availableCents).toBe(1_000_000);
    expect(r.window.end).toBe('2026-03-24');
    expect(r.window.daysRemaining).toBe(5);
    expect(r.dailyAllowanceCents).toBe(200_000);
    expect(r.basis).toBe('cash_only');
  });

  it('deducts an upcoming commitment before it is paid', () => {
    const rent = makeRule({ name: 'Rent', amountCents: 300_000, startDate: '2026-01-22' });
    const r = calculateAvailableToSpend(input({ recurringRules: [rent] }));
    expect(r.commitments.totalCents).toBe(300_000);
    expect(r.availableCents).toBe(700_000);
  });

  it('does not double-count a planned bill once the actual payment posts', () => {
    const rent = makeRule({ name: 'Rent', amountCents: 300_000, startDate: '2026-01-22' });
    const paid = makeTxn({
      accountId: main.id,
      amountCents: -300_000,
      date: '2026-03-22',
      description: 'Rent March',
    });
    const r = calculateAvailableToSpend(
      input({ today: '2026-03-23', recurringRules: [rent], transactions: [paid] }),
    );
    expect(r.eligibleCash.totalCents).toBe(700_000);
    expect(r.commitments.totalCents).toBe(0);
    expect(r.commitments.resolved).toHaveLength(1);
    expect(r.availableCents).toBe(700_000);
  });

  it('keeps overdue unpaid commitments from earlier in the period and warns', () => {
    const insurance = makeRule({ name: 'Insurance', amountCents: 50_000, startDate: '2026-01-05' });
    const r = calculateAvailableToSpend(input({ recurringRules: [insurance] }));
    expect(r.commitments.totalCents).toBe(50_000);
    expect(r.warnings).toContain('overdue_commitments');
  });

  it('never adds expected income, and flags late income', () => {
    const salary = makeRule({
      name: 'Salary',
      direction: 'income',
      amountCents: 1_200_000,
      startDate: '2026-01-25',
    });
    const r = calculateAvailableToSpend(input({ recurringRules: [salary] }));
    expect(r.expectedIncome.totalCents).toBe(1_200_000); // 25 March, shown as forecast
    expect(r.availableCents).toBe(1_000_000);
    const late = calculateAvailableToSpend(
      input({
        today: '2026-03-27',
        recurringRules: [salary],
        settings: makeSettings({ paydayDayOfMonth: null, reservePlannedSavings: false }),
      }),
    );
    expect(late.warnings).toContain('expected_income_late');
  });

  it('subtracts virtual goal reserves but not money already in an excluded savings account', () => {
    const buffer = makeGoal({ name: 'Buffer' });
    const emergency = makeGoal({ name: 'Emergency', linkedAccountId: savingsAcc.id });
    const r = calculateAvailableToSpend(
      input({
        goals: [buffer, emergency],
        goalContributions: [
          makeContribution({ goalId: buffer.id, amountCents: 100_000 }),
          makeContribution({ goalId: emergency.id, amountCents: 400_000 }),
        ],
      }),
    );
    expect(r.goalReserves.reservedCents).toBe(100_000);
    expect(r.goalReserves.heldOutsideCents).toBe(400_000);
    expect(r.availableCents).toBe(900_000);
  });

  it('reserves the remaining 20% planned savings (R2,160) and reduces it after a savings transfer', () => {
    const settings = makeSettings({ paydayDayOfMonth: 25, reservePlannedSavings: true });
    const r = calculateAvailableToSpend(input({ settings }));
    expect(r.plannedSavings.budgetableIncomeCents).toBe(1_080_000);
    expect(r.plannedSavings.targetCents).toBe(216_000);
    expect(r.availableCents).toBe(1_000_000 - 216_000);

    // Moving R1,000 to savings: cash drops by R1,000 and the remaining target drops by R1,000.
    const transfer = makeTransfer(main, savingsAcc, 100_000, '2026-03-18');
    const after = calculateAvailableToSpend(input({ settings, transactions: transfer }));
    expect(after.eligibleCash.totalCents).toBe(900_000);
    expect(after.plannedSavings.remainingCents).toBe(116_000);
    expect(after.availableCents).toBe(1_000_000 - 216_000);
  });

  it('warns when the savings target is unaffordable after commitments, instead of assuming money exists', () => {
    const settings = makeSettings({ paydayDayOfMonth: 25, reservePlannedSavings: true });
    const big = makeRule({
      name: 'Car repair',
      amountCents: 900_000,
      startDate: '2026-03-22',
      frequency: 'yearly',
    });
    const r = calculateAvailableToSpend(input({ settings, recurringRules: [big] }));
    expect(r.warnings).toContain('savings_target_unaffordable');
    expect(r.availableCents).toBe(0);
    expect(r.shortfallCents).toBe(116_000);
    expect(r.warnings).toContain('cash_shortfall');
  });

  it('caps at the remaining discretionary budget when strict budgets are on', () => {
    const settings = makeSettings({
      paydayDayOfMonth: 25,
      reservePlannedSavings: false,
      strictBudgetCap: true,
    });
    const budgets = [makeBudget({ categoryId: eatingOut.id, limitCents: 200_000 })];
    const spent = makeTxn({
      accountId: main.id,
      amountCents: -50_000,
      categoryId: eatingOut.id,
      date: '2026-03-10',
    });
    const r = calculateAvailableToSpend(input({ settings, budgets, transactions: [spent] }));
    expect(r.discretionary.remainingCents).toBe(150_000);
    expect(r.basis).toBe('cash_and_budget');
    expect(r.bindingConstraint).toBe('budget');
    expect(r.availableCents).toBe(150_000);
    expect(r.dailyAllowanceCents).toBe(30_000);

    const relaxed = calculateAvailableToSpend(
      input({ settings: { ...settings, strictBudgetCap: false }, budgets, transactions: [spent] }),
    );
    expect(relaxed.basis).toBe('cash_only');
    expect(relaxed.availableCents).toBe(950_000);
  });

  it('shows R0 with a shortfall instead of a negative amount', () => {
    const overdrawn = makeAccount({
      openingBalanceCents: -20_000,
      openingBalanceDate: '2026-03-01',
    });
    const r = calculateAvailableToSpend(input({ accounts: [overdrawn] }));
    expect(r.availableCents).toBe(0);
    expect(r.shortfallCents).toBe(20_000);
    expect(r.dailyAllowanceCents).toBe(0);
  });

  it('separates workspaces and ignores unavailable accounts', () => {
    const biz = makeAccount({
      workspace: 'business',
      openingBalanceCents: 300_000,
      openingBalanceDate: '2026-03-01',
    });
    const closed = makeAccount({ active: false, openingBalanceCents: 999_999 });
    const accounts = [main, savingsAcc, biz, closed];
    expect(calculateAvailableToSpend(input({ accounts, view: 'business' })).availableCents).toBe(
      300_000,
    );
    expect(
      calculateAvailableToSpend(input({ accounts, view: 'combined' })).eligibleCash.totalCents,
    ).toBe(1_300_000);
    expect(calculateAvailableToSpend(input({ accounts: [], view: 'personal' })).warnings).toContain(
      'no_eligible_accounts',
    );
  });

  it('does not treat pending transactions as posted cash', () => {
    const pending = makeTxn({ accountId: main.id, amountCents: -100_000, status: 'pending' });
    const r = calculateAvailableToSpend(input({ transactions: [pending] }));
    expect(r.eligibleCash.totalCents).toBe(1_000_000);
    expect(r.eligibleCash.pendingCents).toBe(-100_000);
  });

  it('starts a new window and period when salary arrives before the scheduled payday', () => {
    const salary = makeTxn({
      accountId: main.id,
      type: 'income',
      amountCents: 1_200_000,
      date: '2026-03-23',
      categoryId: 'cat-salary',
    });
    const r = calculateAvailableToSpend(
      input({
        today: '2026-03-23',
        transactions: [salary],
        settings: makeSettings({
          paydayDayOfMonth: 25,
          reservePlannedSavings: false,
          budgetPeriodMode: 'pay_period',
        }),
      }),
    );
    expect(r.period).toEqual({ start: '2026-03-23', end: '2026-04-24', mode: 'pay_period' });
    expect(r.window.nextPayday).toBe('2026-04-25');
    expect(r.window.daysRemaining).toBe(33);
    expect(r.dailyAllowanceCents).toBe(Math.floor(2_200_000 / 33));
  });
});
