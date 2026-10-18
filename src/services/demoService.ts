import { type IsoDate, addDays, makeDate, parts, startOfMonth } from '@/domain/dates';
import type { FinanceStore, StoreTableName } from '@/data/repositories/types';
import { type Clock, DomainError, systemClock } from './common';
import { createAccount } from './accountsService';
import { createTransaction, createTransfer } from './transactionsService';
import { addGoalContribution, saveGoal, saveRecurringRule } from './planningService';

const DEMO_TABLES: StoreTableName[] = [
  'transactions',
  'goalContributions',
  'goals',
  'budgets',
  'recurringRules',
  'accounts',
  'importBatches',
  'importProfiles',
  'categorisationRules',
  'projects',
  'invoices',
];

export async function hasDemoData(store: FinanceStore): Promise<boolean> {
  return (await store.accounts.list()).some((a) => a.isDemo);
}

/**
 * Loads sample data so the app can be explored. Every demo record has a fixed id, so devices that
 * load demo data before syncing write the same records instead of duplicates (audit F-08). Every demo record has `isDemo: true` and demo
 * account names start with "Demo ·". Settings are never changed by demo data.
 */
export async function loadDemoData(
  store: FinanceStore,
  today: IsoDate,
  clock: Clock = systemClock,
): Promise<void> {
  if (await hasDemoData(store)) throw new DomainError('Demo data is already loaded.');
  const opts = { isDemo: true, clock };
  const monthStart = startOfMonth(today);
  const { year, month } = parts(today);
  const day = (d: number): IsoDate => {
    const date = makeDate(year, month, d);
    return date > today ? today : date;
  };

  await store.atomic(async () => {
    const main = await createAccount(
      store,
      {
        name: 'Demo · Capitec main',
        type: 'current',
        workspace: 'personal',
        institution: 'Capitec',
        openingBalanceCents: 350_000,
        openingBalanceDate: monthStart,
        includeInSpendable: true,
      },
      { ...opts, id: 'demo-acc-main' },
    );
    const savings = await createAccount(
      store,
      {
        name: 'Demo · Savings',
        type: 'savings',
        workspace: 'personal',
        openingBalanceCents: 800_000,
        openingBalanceDate: monthStart,
        includeInSpendable: false,
      },
      { ...opts, id: 'demo-acc-savings' },
    );
    const business = await createAccount(
      store,
      {
        name: 'Demo · Business account',
        type: 'current',
        workspace: 'business',
        openingBalanceCents: 120_000,
        openingBalanceDate: monthStart,
        includeInSpendable: true,
      },
      { ...opts, id: 'demo-acc-business' },
    );

    const tx = (
      id: string,
      d: number,
      description: string,
      amountCents: number,
      type: 'income' | 'expense' | 'refund',
      categoryId: string | null,
      accountId = main.id,
    ) =>
      createTransaction(
        store,
        { accountId, date: day(d), description, amountCents, type, categoryId },
        { ...opts, id: `demo-txn-${id}` },
      );

    await tx('salary', 1, 'Salary – Demo Employer', 1_200_000, 'income', 'cat-salary');
    await tx('tithe', 1, 'Church tithe', 120_000, 'expense', 'cat-tithe');
    await tx('rent', 2, 'Rent', 450_000, 'expense', 'cat-housing');
    await tx('groceries', 3, 'Checkers groceries', 85_000, 'expense', 'cat-groceries');
    await tx('electricity', 4, 'Prepaid electricity', 60_000, 'expense', 'cat-utilities');
    await tx('nandos', 5, 'Nando’s', 18_500, 'expense', 'cat-eating-out');
    await tx('uber', 6, 'Uber', 9_500, 'expense', 'cat-transport');
    await tx('refund', 7, 'Checkers refund', 4_000, 'refund', 'cat-groceries');
    await tx('unknown', 8, 'Unknown card purchase', 12_000, 'expense', null);
    const [, savingsLeg] = await createTransfer(
      store,
      { fromAccountId: main.id, toAccountId: savings.id, date: day(2), amountCents: 100_000 },
      {
        ...opts,
        ids: {
          transfer: 'demo-tr-savings',
          out: 'demo-txn-to-savings',
          into: 'demo-txn-from-main',
        },
      },
    );
    await createTransfer(
      store,
      {
        fromAccountId: main.id,
        toAccountId: business.id,
        date: day(3),
        amountCents: 50_000,
        description: 'Owner contribution',
      },
      {
        ...opts,
        ids: { transfer: 'demo-tr-owner', out: 'demo-txn-owner-out', into: 'demo-txn-owner-in' },
      },
    );
    await tx(
      'client-payment',
      4,
      'Client payment – logo design',
      250_000,
      'income',
      'cat-biz-revenue',
      business.id,
    );
    await tx('canva', 5, 'Canva subscription', 22_000, 'expense', 'cat-biz-software', business.id);

    await saveRecurringRule(
      store,
      {
        id: 'demo-rule-phone',
        name: 'Phone contract',
        direction: 'expense',
        amountCents: 39_900,
        frequency: 'monthly',
        startDate: addDays(today, 3),
        accountId: main.id,
        categoryId: 'cat-phone',
        workspace: 'personal',
        active: true,
        matchWindowDays: 5,
        alertLeadDays: 3,
      },
      opts,
    );
    await saveRecurringRule(
      store,
      {
        id: 'demo-rule-insurance',
        name: 'Car insurance',
        direction: 'expense',
        amountCents: 75_000,
        frequency: 'monthly',
        startDate: addDays(today, 6),
        accountId: main.id,
        categoryId: 'cat-insurance',
        workspace: 'personal',
        active: true,
        matchWindowDays: 5,
        alertLeadDays: 3,
      },
      opts,
    );

    const emergency = await saveGoal(
      store,
      {
        id: 'demo-goal-emergency',
        name: 'Demo · Emergency fund',
        goalType: 'emergency_fund',
        workspace: 'personal',
        targetMode: 'emergency_auto',
        targetCents: null,
        priority: 1,
        state: 'active',
        linkedAccountId: savings.id,
        plannedMonthlyCents: 100_000,
      },
      opts,
    );
    await addGoalContribution(
      store,
      {
        goalId: emergency.id,
        // The savings account's opening balance was set aside before this month.
        date: addDays(monthStart, -1),
        amountCents: 800_000,
        note: 'Opening savings balance',
      },
      { ...opts, id: 'demo-gc-emergency-opening' },
    );
    await addGoalContribution(
      store,
      {
        goalId: emergency.id,
        date: day(2),
        amountCents: 100_000,
        transactionId: savingsLeg.id,
        note: 'Monthly transfer to savings',
      },
      { ...opts, id: 'demo-gc-emergency-transfer' },
    );
    const buffer = await saveGoal(
      store,
      {
        id: 'demo-goal-buffer',
        name: 'Demo · Monthly buffer',
        goalType: 'monthly_buffer',
        workspace: 'personal',
        targetMode: 'fixed',
        targetCents: 300_000,
        priority: 2,
        state: 'active',
        plannedMonthlyCents: 50_000,
      },
      opts,
    );
    await addGoalContribution(
      store,
      { goalId: buffer.id, date: day(2), amountCents: 50_000 },
      { ...opts, id: 'demo-gc-buffer' },
    );

    const now = clock.now();
    await store.budgets.bulkPut(
      (
        [
          ['cat-eating-out', 80_000],
          ['cat-entertainment', 50_000],
          ['cat-shopping', 100_000],
          ['cat-groceries', 300_000],
          ['cat-housing', 450_000],
          ['cat-utilities', 80_000],
          ['cat-transport', 100_000],
          ['cat-phone', 40_000],
        ] as const
      ).map(([categoryId, limitCents]) => ({
        id: `demo-budget-${categoryId}`,
        categoryId,
        workspace: 'personal' as const,
        period: 'monthly' as const,
        limitCents,
        active: true,
        isDemo: true,
        createdAt: now,
        updatedAt: now,
      })),
    );
  });
}

/**
 * Removes only records flagged as demo. Refuses if real (non-demo) records depend on a demo
 * account or goal, so real data is never deleted by accident.
 */
export async function clearDemoData(store: FinanceStore): Promise<number> {
  const demoAccounts = new Set(
    (await store.accounts.list()).filter((a) => a.isDemo).map((a) => a.id),
  );
  const demoGoals = new Set((await store.goals.list()).filter((g) => g.isDemo).map((g) => g.id));
  const realTxnInDemoAccount = (await store.transactions.list()).some(
    (t) => !t.isDemo && demoAccounts.has(t.accountId),
  );
  const realContributionToDemoGoal = (await store.goalContributions.list()).some(
    (c) => !c.isDemo && demoGoals.has(c.goalId),
  );
  if (realTxnInDemoAccount || realContributionToDemoGoal) {
    throw new DomainError(
      'Some of your own records are attached to demo accounts or goals. Move or delete them first, then clear demo data.',
    );
  }
  let removed = 0;
  await store.atomic(async () => {
    for (const name of DEMO_TABLES) {
      const rows = (await store[name].list()) as {
        id: string;
        isDemo: boolean;
        accountId?: string;
      }[];
      // Import history and saved mappings for demo accounts go too (they hold no transactions).
      const ids = rows
        .filter(
          (r) =>
            r.isDemo ||
            ((name === 'importBatches' || name === 'importProfiles') &&
              r.accountId !== undefined &&
              demoAccounts.has(r.accountId)),
        )
        .map((r) => r.id);
      await store[name].bulkDelete(ids);
      removed += ids.length;
    }
  });
  return removed;
}
