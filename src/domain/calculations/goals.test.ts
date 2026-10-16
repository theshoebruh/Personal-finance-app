import {
  makeAccount,
  makeBudget,
  makeCategory,
  makeContribution,
  makeGoal,
  makeTransfer,
  makeTxn,
} from '@/test/factories';
import {
  emergencyFundTarget,
  estimateEssentialMonthly,
  goalBalance,
  goalProgress,
  goalReserves,
  savingsMadeInPeriod,
  unpairedOutgoingTransfers,
} from './goals';

describe('emergency fund', () => {
  it('defaults to three times essential monthly expenses, with overrides', () => {
    expect(emergencyFundTarget(500_000, 3)).toBe(1_500_000);
    expect(emergencyFundTarget(500_000, 6)).toBe(3_000_000);
    expect(emergencyFundTarget(500_000, 3, 2_000_000)).toBe(2_000_000);
  });

  it('estimates essential expenses from override, budgets, then history', () => {
    const essential = makeCategory({ group: 'essential', name: 'Rent' });
    const acc = makeAccount();
    const noOverride = { essentialMonthlyOverrideCents: null };
    expect(
      estimateEssentialMonthly(
        '2026-04-10',
        { essentialMonthlyOverrideCents: 400_000 },
        [],
        [essential],
        [],
      ),
    ).toEqual({
      monthlyCents: 400_000,
      source: 'override',
      monthsOfHistory: 0,
    });
    expect(
      estimateEssentialMonthly(
        '2026-04-10',
        noOverride,
        [makeBudget({ categoryId: essential.id, limitCents: 450_000 })],
        [essential],
        [],
      ).monthlyCents,
    ).toBe(450_000);
    const history = [
      makeTxn({
        accountId: acc.id,
        amountCents: -300_000,
        date: '2026-03-05',
        categoryId: essential.id,
      }),
      makeTxn({
        accountId: acc.id,
        amountCents: -500_000,
        date: '2026-02-05',
        categoryId: essential.id,
      }),
      makeTxn({
        accountId: acc.id,
        amountCents: -999_999,
        date: '2026-04-05',
        categoryId: essential.id,
      }), // current month ignored
    ];
    expect(estimateEssentialMonthly('2026-04-10', noOverride, [], [essential], history)).toEqual({
      monthlyCents: 400_000,
      source: 'history',
      monthsOfHistory: 2,
    });
    expect(estimateEssentialMonthly('2026-04-10', noOverride, [], [essential], []).source).toBe(
      'insufficient_data',
    );
  });
});

describe('goal allocations', () => {
  const current = makeAccount();
  const savingsAcc = makeAccount({ type: 'savings', includeInSpendable: false });

  it('sums contributions and withdrawals', () => {
    const g = makeGoal();
    const c = [
      makeContribution({ goalId: g.id, amountCents: 100_000 }),
      makeContribution({ goalId: g.id, amountCents: -30_000 }),
      makeContribution({ goalId: 'other', amountCents: 5_000 }),
    ];
    expect(goalBalance(g.id, c)).toBe(70_000);
  });

  it('reserves virtual allocations in eligible cash but not money already in a savings account', () => {
    const virtualGoal = makeGoal({ name: 'Buffer' });
    const savedGoal = makeGoal({ name: 'Emergency', linkedAccountId: savingsAcc.id });
    const archived = makeGoal({ state: 'archived' });
    const contributions = [
      makeContribution({ goalId: virtualGoal.id, amountCents: 50_000 }),
      makeContribution({ goalId: savedGoal.id, amountCents: 200_000 }),
      makeContribution({ goalId: archived.id, amountCents: 1_000 }),
    ];
    const r = goalReserves(
      [virtualGoal, savedGoal, archived],
      contributions,
      [current, savingsAcc],
      'personal',
    );
    expect(r.reservedCents).toBe(50_000);
    expect(r.heldOutsideCents).toBe(200_000);
  });

  it('counts savings made via allocations and via transfers to non-spendable accounts once', () => {
    const g = makeGoal({ linkedAccountId: savingsAcc.id });
    const [out, into] = makeTransfer(current, savingsAcc, 100_000, '2026-03-05');
    const [out2, into2] = makeTransfer(current, savingsAcc, 60_000, '2026-03-06');
    const contributions = [
      makeContribution({ goalId: g.id, amountCents: 100_000, transactionId: into.id }), // linked to transfer 1
      makeContribution({ goalId: g.id, amountCents: 25_000, date: '2026-02-20' }), // previous month
    ];
    const made = savingsMadeInPeriod(
      [g],
      contributions,
      [current, savingsAcc],
      [out, into, out2, into2],
      'personal',
      '2026-03-01',
      '2026-03-31',
    );
    expect(made).toBe(160_000);
  });

  it('reports progress, required monthly contribution and projection', () => {
    const g = makeGoal({
      targetCents: 1_000_000,
      targetDate: '2026-12-31',
      plannedMonthlyCents: 100_000,
    });
    const p = goalProgress(g, 250_000, 1_000_000, '2026-03-15');
    expect(p.percent).toBe(25);
    expect(p.remainingCents).toBe(750_000);
    expect(p.requiredMonthlyCents).toBe(83_334); // 750,000 / 9 months, rounded up
    expect(p.projectedCompletion).toBe('2026-11-15');
    expect(goalProgress(g, 1_200_000, 1_000_000, '2026-03-15').percent).toBe(100);
    expect(goalProgress(g, 0, null, '2026-03-15').percent).toBeNull();
  });
});

describe('one-sided transfers', () => {
  it('flags transfers out of a spendable account whose receiving side is missing', () => {
    const spend = makeAccount({ id: 'spend' });
    const sav = makeAccount({ id: 'sav2', type: 'savings', includeInSpendable: false });
    const [loneOut] = makeTransfer(spend, sav, 50_000, '2026-03-05');
    const [, loneIn] = makeTransfer(spend, sav, 20_000, '2026-03-06');
    const paired = makeTransfer(spend, sav, 30_000, '2026-03-07');
    const [outsidePeriod] = makeTransfer(spend, sav, 10_000, '2026-02-05');
    const found = unpairedOutgoingTransfers(
      [spend, sav],
      [loneOut!, loneIn!, ...paired, outsidePeriod!],
      'personal',
      '2026-03-01',
      '2026-03-31',
    );
    expect(found.map((t) => t.id)).toEqual([loneOut!.id]);
  });
});
