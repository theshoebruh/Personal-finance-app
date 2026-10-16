import Dexie from 'dexie';
import { FinanceDb } from '@/data/local-db/db';
import { createDexieStore } from '@/data/repositories/dexieStore';
import type { FinanceStore } from '@/data/repositories/types';
import { type Account, type RecurringRule, SETTINGS_ID } from '@/domain/models';
import { calculateAvailableToSpend } from '@/domain/calculations/availableToSpend';
import { buildDashboard } from '@/domain/calculations/dashboard';
import { salaryReceiptDates } from '@/domain/calculations/period';
import { createAccount } from './accountsService';
import { linkPaymentToOccurrence, saveRecurringRule, unlinkPayment } from './planningService';
import { ensureInitialised, updateSettings } from './settingsService';
import { createTransaction } from './transactionsService';

let n = 0;
let db: FinanceDb;
let store: FinanceStore;
let main: Account;
let tithe: RecurringRule;

const today = '2026-03-26';

beforeEach(async () => {
  db = new FinanceDb(`links-${++n}`);
  store = createDexieStore(db);
  await ensureInitialised(store);
  await updateSettings(store, { paydayDayOfMonth: null, reservePlannedSavings: false });
  main = await createAccount(store, {
    name: 'Capitec main',
    type: 'current',
    workspace: 'personal',
    openingBalanceCents: 1_000_000,
    openingBalanceDate: '2026-03-01',
    includeInSpendable: true,
  });
  tithe = await saveRecurringRule(store, {
    name: 'Tithe',
    direction: 'expense',
    amountCents: 120_000,
    frequency: 'monthly',
    startDate: '2026-01-25',
    categoryId: 'cat-tithe',
    workspace: 'personal',
    active: true,
    matchWindowDays: 5,
    alertLeadDays: 3,
  });
});

afterEach(async () => {
  db.close();
  await Dexie.delete(db.name);
});

async function input() {
  const [settings, accounts, transactions, recurringRules, categories] = await Promise.all([
    store.settings.get(SETTINGS_ID),
    store.accounts.list(),
    store.transactions.list(),
    store.recurringRules.list(),
    store.categories.list(),
  ]);
  return {
    today,
    view: 'personal' as const,
    settings: settings!,
    accounts,
    transactions,
    recurringRules,
    budgets: [],
    categories,
    goals: [],
    goalContributions: [],
  };
}

const churchPayment = () =>
  createTransaction(store, {
    accountId: main.id,
    date: '2026-03-25',
    description: 'GRACE COMMUNITY CHURCH',
    amountCents: 120_000,
    type: 'expense',
    categoryId: null,
  });

describe('linking payments to recurring items (F-04)', () => {
  it('suggests an unrecognised tithe payment; linking stops the double deduction', async () => {
    const paid = await churchPayment();
    let model = buildDashboard(await input());
    expect(model.ats.commitments.totalCents).toBe(120_000); // counted twice before linking
    expect(model.paymentSuggestions[`${tithe.id}|2026-03-25`]?.map((t) => t.id)).toEqual([paid.id]);

    await linkPaymentToOccurrence(store, paid.id, tithe.id, '2026-03-25');
    model = buildDashboard(await input());
    expect(model.ats.commitments.totalCents).toBe(0);
    expect(model.ats.commitments.resolved[0]).toMatchObject({
      status: 'matched',
      matchReason: 'explicit_link',
      matchedTransactionId: paid.id,
    });
    expect(model.paymentSuggestions).toEqual({});

    await unlinkPayment(store, paid.id);
    expect(calculateAvailableToSpend(await input()).commitments.totalCents).toBe(120_000);
    const t = await store.transactions.get(paid.id);
    expect(t).not.toHaveProperty('recurringRuleId');
  });

  it('does not suggest payments of a different amount, date or direction', async () => {
    for (const [date, amount, type] of [
      ['2026-03-25', 90_000, 'expense'],
      ['2026-03-12', 120_000, 'expense'],
      ['2026-03-25', 120_000, 'income'],
    ] as const) {
      await createTransaction(store, {
        accountId: main.id,
        date,
        description: 'OTHER',
        amountCents: amount,
        type,
        categoryId: null,
      });
    }
    expect(buildDashboard(await input()).paymentSuggestions).toEqual({});
  });

  it('rejects links that don’t make sense', async () => {
    const paid = await churchPayment();
    const income = await createTransaction(store, {
      accountId: main.id,
      date: '2026-03-25',
      description: 'REFUND',
      amountCents: 120_000,
      type: 'income',
      categoryId: null,
    });
    await expect(linkPaymentToOccurrence(store, income.id, tithe.id, '2026-03-25')).rejects.toThrow(
      /Only an expense/,
    );
    await expect(linkPaymentToOccurrence(store, paid.id, tithe.id, '2026-03-24')).rejects.toThrow(
      /isn't due on that date/,
    );
    await linkPaymentToOccurrence(store, paid.id, tithe.id, '2026-03-25');
    const second = await churchPayment();
    await expect(linkPaymentToOccurrence(store, second.id, tithe.id, '2026-03-25')).rejects.toThrow(
      /already linked/,
    );
  });

  it('a salary linked to the Salary item sets the payday even when uncategorised', async () => {
    const salary = await saveRecurringRule(store, {
      name: 'Salary',
      direction: 'income',
      amountCents: 1_200_000,
      frequency: 'monthly',
      startDate: '2026-01-25',
      categoryId: 'cat-salary',
      workspace: 'personal',
      active: true,
      matchWindowDays: 5,
      alertLeadDays: 3,
    });
    const pay = await createTransaction(store, {
      accountId: main.id,
      date: '2026-03-23',
      description: 'ACME PAYROLL',
      amountCents: 1_200_000,
      type: 'income',
      categoryId: null,
    });
    const data = await input();
    expect(
      salaryReceiptDates(today, data.settings, data.recurringRules, data.transactions),
    ).toEqual([]);
    expect(buildDashboard(data).lateIncome.map((o) => o.date)).toEqual(['2026-03-25']);
    await linkPaymentToOccurrence(store, pay.id, salary.id, '2026-03-25');
    const after = await input();
    expect(
      salaryReceiptDates(today, after.settings, after.recurringRules, after.transactions),
    ).toEqual(['2026-03-23']);
  });
});
