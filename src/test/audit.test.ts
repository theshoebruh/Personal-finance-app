/**
 * Audit tests (2026-10-15). Two kinds:
 *  - normal tests: critical behaviour verified to be correct;
 *  - `it.fails`: CONFIRMED BUGS / GAPS. These pass while the problem exists. When a fix lands they
 *    start failing — then change `it.fails` to `it` so the fix stays protected.
 * See docs/audit-2026-10-15.md for the findings these refer to (IDs like F-03).
 */
import Dexie from 'dexie';
import {
  makeAccount,
  makeBudget,
  makeCategory,
  makeRule,
  makeSettings,
  makeTransfer,
  makeTxn,
} from './factories';
import {
  calculateAvailableToSpend,
  type AvailableToSpendInput,
} from '@/domain/calculations/availableToSpend';
import { summariseIncomeExpenses } from '@/domain/calculations/reporting';
import { accountBalance } from '@/domain/calculations/balances';
import { budgetableIncome, savingsTarget } from '@/domain/calculations/income';
import { FinanceDb } from '@/data/local-db/db';
import { createDexieStore } from '@/data/repositories/dexieStore';
import { FakeRemote } from '@/data/sync/fakeRemote';
import { SyncEngine } from '@/data/sync/syncEngine';
import { createTrackedStore } from '@/data/sync/trackedStore';
import { prepareDevice } from '@/data/sync/bootstrap';
import { REMOTE_TABLES, toRow } from '@/data/sync/rowMapping';
import { createAccount } from '@/services/accountsService';
import {
  bulkSetCategory,
  createTransaction,
  createTransfer,
  updateTransaction,
} from '@/services/transactionsService';
import { commitImport, prepareImport } from '@/services/importService';
import { loadDemoData } from '@/services/demoService';
import { ensureInitialised } from '@/services/settingsService';

const opened: FinanceDb[] = [];
let n = 0;
function newDb() {
  const db = new FinanceDb(`audit-${++n}`);
  opened.push(db);
  return db;
}
afterEach(async () => {
  for (const db of opened.splice(0)) {
    db.close();
    await Dexie.delete(db.name);
  }
});

const today = '2026-03-20';
const main = makeAccount({
  id: 'main',
  name: 'Capitec main',
  openingBalanceCents: 1_000_000,
  openingBalanceDate: '2026-03-01',
});
const biz = makeAccount({
  id: 'biz',
  name: 'Business',
  workspace: 'business',
  openingBalanceCents: 300_000,
  openingBalanceDate: '2026-03-01',
});
const savings = makeAccount({
  id: 'sav',
  name: 'Savings',
  type: 'savings',
  includeInSpendable: false,
  openingBalanceDate: '2026-03-01',
});
const fun = makeCategory({ id: 'cat-fun', group: 'discretionary', name: 'Fun' });

function ats(over: Partial<AvailableToSpendInput> = {}) {
  return calculateAvailableToSpend({
    today,
    view: 'personal',
    settings: makeSettings({
      paydayDayOfMonth: 25,
      reservePlannedSavings: false,
      strictBudgetCap: true,
    }),
    accounts: [main, biz, savings],
    transactions: [],
    recurringRules: [],
    budgets: [],
    categories: [fun],
    goals: [],
    goalContributions: [],
    ...over,
  });
}

// ------------------------------------------------------------------ verified behaviour

describe('critical calculations (verified)', () => {
  it('derives R10,800 and R2,160 from the default plan exactly once', () => {
    const base = budgetableIncome(1_200_000, 120_000);
    expect(base).toBe(1_080_000);
    expect(savingsTarget(base, 20)).toBe(216_000);
    // A recorded tithe payment reduces cash once; the plan base is unchanged by it.
    const tithe = makeTxn({
      accountId: main.id,
      amountCents: -120_000,
      categoryId: 'cat-tithe',
      date: '2026-03-02',
    });
    expect(accountBalance(main, [tithe])).toBe(880_000);
  });

  it('pay-period mode budgets from the last payday to the day before the next', () => {
    const settings = makeSettings({
      paydayDayOfMonth: 25,
      budgetPeriodMode: 'pay_period',
      reservePlannedSavings: false,
    });
    const r = ats({
      settings,
      budgets: [makeBudget({ categoryId: fun.id, limitCents: 100_000 })],
      // 24 Feb is before the pay period (25 Feb – 24 Mar); 26 Feb is inside it.
      transactions: [
        makeTxn({
          accountId: main.id,
          amountCents: -40_000,
          categoryId: fun.id,
          date: '2026-02-24',
        }),
        makeTxn({
          accountId: main.id,
          amountCents: -10_000,
          categoryId: fun.id,
          date: '2026-02-26',
        }),
      ],
    });
    expect(r.period).toEqual({ start: '2026-02-25', end: '2026-03-24', mode: 'pay_period' });
    expect(r.discretionary.spentCents).toBe(10_000);
    expect(r.availableCents).toBe(90_000);
  });

  it('a refund in a wants category gives budget back', () => {
    const r = ats({
      budgets: [makeBudget({ categoryId: fun.id, limitCents: 100_000 })],
      transactions: [
        makeTxn({
          accountId: main.id,
          amountCents: -60_000,
          categoryId: fun.id,
          date: '2026-03-05',
        }),
        makeTxn({
          accountId: main.id,
          amountCents: 20_000,
          type: 'refund',
          categoryId: fun.id,
          date: '2026-03-06',
        }),
      ],
    });
    expect(r.discretionary.spentCents).toBe(40_000);
    expect(r.availableCents).toBe(60_000);
  });

  it('keeps personal and business separate, and combined adds cash without double counting', () => {
    const [out, into] = makeTransfer(main, biz, 50_000, '2026-03-10', 'owner_contribution');
    const txns = [out, into];
    expect(ats({ transactions: txns }).eligibleCash.totalCents).toBe(950_000);
    expect(ats({ transactions: txns, view: 'business' }).eligibleCash.totalCents).toBe(350_000);
    expect(ats({ transactions: txns, view: 'combined' }).eligibleCash.totalCents).toBe(1_300_000);
    const pers = summariseIncomeExpenses(txns, 'personal', '2026-03-01', '2026-03-31');
    const bus = summariseIncomeExpenses(txns, 'business', '2026-03-01', '2026-03-31');
    const all = summariseIncomeExpenses(txns, 'combined', '2026-03-01', '2026-03-31');
    expect([pers.expenseCents, bus.incomeCents, all.incomeCents, all.expenseCents]).toEqual([
      0, 0, 0, 0,
    ]);
    expect(bus.ownerContributionCents).toBe(50_000);
  });

  it('ignores archived and excluded transactions everywhere', () => {
    const hidden = [
      makeTxn({ accountId: main.id, amountCents: -500_000, categoryId: fun.id, archived: true }),
      makeTxn({
        accountId: main.id,
        amountCents: -500_000,
        categoryId: fun.id,
        status: 'excluded',
      }),
    ];
    const r = ats({
      transactions: hidden,
      budgets: [makeBudget({ categoryId: fun.id, limitCents: 100_000 })],
    });
    expect(r.eligibleCash.totalCents).toBe(1_000_000);
    expect(r.discretionary.spentCents).toBe(0);
  });

  it('a payday override earlier than the usual day shortens the window', () => {
    const r = ats({
      settings: makeSettings({
        paydayDayOfMonth: 25,
        nextPaydayOverride: '2026-03-23',
        reservePlannedSavings: false,
      }),
    });
    expect(r.window).toMatchObject({ end: '2026-03-22', daysRemaining: 3 });
  });

  it('matches an imported tithe whose description contains "tithe"', () => {
    const rule = makeRule({
      name: 'Tithe',
      amountCents: 120_000,
      startDate: '2026-01-25',
      categoryId: 'cat-tithe',
    });
    const paid = makeTxn({
      accountId: main.id,
      amountCents: -120_000,
      date: '2026-03-25',
      description: 'DEBIT ORDER TITHE GRACE CHURCH',
    });
    const r = ats({
      today: '2026-03-26',
      recurringRules: [rule],
      transactions: [paid],
      settings: makeSettings({ paydayDayOfMonth: null, reservePlannedSavings: false }),
    });
    expect(r.commitments.totalCents).toBe(0);
  });
});

describe('transaction behaviour (verified)', () => {
  it('editing an expense into income flips the sign and updates the balance', async () => {
    const db = newDb();
    const store = createDexieStore(db);
    await ensureInitialised(store);
    const acc = await createAccount(store, {
      name: 'A',
      type: 'current',
      workspace: 'personal',
      openingBalanceCents: 0,
      openingBalanceDate: '2026-03-01',
      includeInSpendable: true,
    });
    const t = await createTransaction(store, {
      accountId: acc.id,
      date: '2026-03-02',
      description: 'X',
      amountCents: 10_000,
      type: 'expense',
      categoryId: null,
    });
    await updateTransaction(store, t.id, { type: 'income' });
    expect((await store.transactions.get(t.id))?.amountCents).toBe(10_000);
    expect(
      accountBalance((await store.accounts.get(acc.id))!, await store.transactions.list()),
    ).toBe(10_000);
  });

  it('moving a transaction to a business account moves it to the business workspace', async () => {
    const db = newDb();
    const store = createDexieStore(db);
    await ensureInitialised(store);
    const p = await createAccount(store, {
      name: 'P',
      type: 'current',
      workspace: 'personal',
      openingBalanceCents: 0,
      openingBalanceDate: '2026-03-01',
      includeInSpendable: true,
    });
    const b = await createAccount(store, {
      name: 'B',
      type: 'current',
      workspace: 'business',
      openingBalanceCents: 0,
      openingBalanceDate: '2026-03-01',
      includeInSpendable: true,
    });
    const t = await createTransaction(store, {
      accountId: p.id,
      date: '2026-03-02',
      description: 'X',
      amountCents: 10_000,
      type: 'expense',
      categoryId: null,
    });
    await updateTransaction(store, t.id, { accountId: b.id });
    expect((await store.transactions.get(t.id))?.workspace).toBe('business');
  });

  it('a transfer to savings is not spending and leaves total money unchanged', async () => {
    const db = newDb();
    const store = createDexieStore(db);
    await ensureInitialised(store);
    const m = await createAccount(store, {
      name: 'M',
      type: 'current',
      workspace: 'personal',
      openingBalanceCents: 100_000,
      openingBalanceDate: '2026-03-01',
      includeInSpendable: true,
    });
    const s = await createAccount(store, {
      name: 'S',
      type: 'savings',
      workspace: 'personal',
      openingBalanceCents: 0,
      openingBalanceDate: '2026-03-01',
      includeInSpendable: false,
    });
    await createTransfer(store, {
      fromAccountId: m.id,
      toAccountId: s.id,
      date: '2026-03-05',
      amountCents: 40_000,
    });
    const txns = await store.transactions.list();
    const accs = await store.accounts.list();
    expect(accs.reduce((sum, a) => sum + accountBalance(a, txns), 0)).toBe(100_000);
    expect(summariseIncomeExpenses(txns, 'personal', '2026-03-01', '2026-03-31').expenseCents).toBe(
      0,
    );
  });
});

// ------------------------------------------------------------------ confirmed bugs / gaps

describe('confirmed issues (it.fails = problem still present)', () => {
  // F-03 (fixed): the import review suggests the transfer; once the user chooses the savings
  // account under "Import as", it is imported as a transfer, not spending.
  it('F-03: an imported transfer to savings is not counted as spending', async () => {
    const db = newDb();
    const store = createDexieStore(db);
    await ensureInitialised(store);
    const acc = await createAccount(store, {
      name: 'Capitec main',
      type: 'current',
      workspace: 'personal',
      openingBalanceCents: 0,
      openingBalanceDate: '2026-03-01',
      includeInSpendable: true,
    });
    const sav = await createAccount(store, {
      name: 'Savings',
      type: 'savings',
      workspace: 'personal',
      openingBalanceCents: 0,
      openingBalanceDate: '2026-03-01',
      includeInSpendable: false,
    });
    const csv = 'Date,Description,Amount\n2026-03-05,TRANSFER TO SAVINGS POCKET,-2160.00\n';
    const p = await prepareImport(store, { accountId: acc.id, text: csv });
    expect(p.staging.rows[0]!.transferSuggestion?.otherAccountId).toBe(sav.id);
    const rows = p.staging.rows.map((r) => ({ ...r, transferAccountId: sav.id }));
    await commitImport(store, { prepared: p, rows, saveMapping: false });
    const s = summariseIncomeExpenses(
      await store.transactions.list(),
      'personal',
      '2026-03-01',
      '2026-03-31',
    );
    expect(s.expenseCents).toBe(0);
  });

  // F-04: a recorded tithe with a description that doesn't contain the rule's name, left
  // uncategorised (typical for imports), doesn't match the planned tithe: R1,200 is deducted twice.
  it.fails(
    'F-04: an imported tithe described only as the church name is not deducted twice',
    () => {
      const rule = makeRule({
        name: 'Tithe',
        amountCents: 120_000,
        startDate: '2026-01-25',
        categoryId: 'cat-tithe',
      });
      const paid = makeTxn({
        accountId: main.id,
        amountCents: -120_000,
        date: '2026-03-25',
        description: 'GRACE COMMUNITY CHURCH',
        categoryId: null,
      });
      const r = ats({
        today: '2026-03-26',
        recurringRules: [rule],
        transactions: [paid],
        settings: makeSettings({ paydayDayOfMonth: null, reservePlannedSavings: false }),
      });
      expect(r.commitments.totalCents).toBe(0);
    },
  );

  // F-06: a transaction can carry a category of the wrong kind (income with an expense category).
  it('F-06: an income transaction cannot be given an expense category', async () => {
    const db = newDb();
    const store = createDexieStore(db);
    await ensureInitialised(store);
    const acc = await createAccount(store, {
      name: 'A',
      type: 'current',
      workspace: 'personal',
      openingBalanceCents: 0,
      openingBalanceDate: '2026-03-01',
      includeInSpendable: true,
    });
    await expect(
      createTransaction(store, {
        accountId: acc.id,
        date: '2026-03-02',
        description: 'Salary',
        amountCents: 10_000,
        type: 'income',
        categoryId: 'cat-groceries',
      }),
    ).rejects.toThrow();
  });

  // F-07 (fixed): if the server copy of a conflicting record can't be read (e.g. a future schema
  // change), the local record is kept and the change is parked as failed with a clear reason.
  it('F-07: an unreadable server copy in a conflict never deletes the local record', async () => {
    const remote = new FakeRemote();
    const db = newDb();
    const store = createTrackedStore(db);
    const engine = new SyncEngine(db, remote);
    await prepareDevice(engine, store);
    const acc = await createAccount(store, {
      name: 'Mine',
      type: 'current',
      workspace: 'personal',
      openingBalanceCents: 0,
      openingBalanceDate: '2026-03-01',
      includeInSpendable: true,
    });
    // Another device already stored a row the app can't parse under the same id.
    const bad = { ...toRow('accounts', acc), name: '' };
    remote.rows.set(`${REMOTE_TABLES.accounts}:${acc.id}`, {
      table: 'accounts',
      id: acc.id,
      revision: 1,
      deleted: false,
      ts: '2026-01-01T00:00:00.000001+00:00',
      record: bad,
    });
    const report = await engine.syncNow();
    expect(await db.accounts.get(acc.id)).toMatchObject({ name: 'Mine' });
    expect(report.failed).toBe(1);
    const [failed] = await engine.failedChanges();
    expect(failed?.failedReason).toMatch(/could not be read/);
    expect(await engine.listConflicts()).toEqual([]);
  });

  // F-08 (fixed): demo records have fixed ids, so two devices loading demo data before syncing
  // converge on one set (identical content resolves without a conflict).
  it('F-08: demo data loaded on two devices before syncing is not duplicated', async () => {
    const remote = new FakeRemote();
    const devices = [newDb(), newDb()].map((db) => {
      const store = createTrackedStore(db);
      return { db, store, engine: new SyncEngine(db, remote) };
    });
    for (const d of devices) await prepareDevice(d.engine, d.store);
    for (const d of devices) await loadDemoData(d.store, today);
    for (const d of devices) await d.engine.syncNow();
    await devices[0]!.engine.syncNow();
    const demoAccounts = (await devices[0]!.db.accounts.toArray()).filter((a) => a.isDemo);
    expect(demoAccounts).toHaveLength(3);
  });
});

describe('F-06 category kind (fixed)', () => {
  it('rejects mismatches on edit and skips them in bulk', async () => {
    const db = newDb();
    const store = createDexieStore(db);
    await ensureInitialised(store);
    const acc = await createAccount(store, {
      name: 'A',
      type: 'current',
      workspace: 'personal',
      openingBalanceCents: 0,
      openingBalanceDate: '2026-03-01',
      includeInSpendable: true,
    });
    const income = await createTransaction(store, {
      accountId: acc.id,
      date: '2026-03-02',
      description: 'Salary',
      amountCents: 10_000,
      type: 'income',
      categoryId: 'cat-salary',
    });
    const spend = await createTransaction(store, {
      accountId: acc.id,
      date: '2026-03-02',
      description: 'Shop',
      amountCents: 5_000,
      type: 'expense',
      categoryId: null,
    });
    const refund = await createTransaction(store, {
      accountId: acc.id,
      date: '2026-03-03',
      description: 'Refund',
      amountCents: 1_000,
      type: 'refund',
      categoryId: 'cat-groceries',
    });
    expect(refund.categoryId).toBe('cat-groceries'); // refunds use spending categories
    await expect(updateTransaction(store, income.id, { type: 'expense' })).rejects.toThrow(
      /income category; choose a spending/,
    );
    await expect(
      createTransaction(store, {
        accountId: acc.id,
        date: '2026-03-02',
        description: 'Fix',
        amountCents: 1,
        type: 'adjustment',
        categoryId: 'cat-groceries',
      }),
    ).rejects.toThrow(/don’t take a category/);
    expect(await bulkSetCategory(store, [income.id, spend.id], 'cat-groceries')).toEqual({
      updated: 1,
      skipped: 1,
    });
    expect((await store.transactions.get(income.id))?.categoryId).toBe('cat-salary');
    expect((await store.transactions.get(spend.id))?.categoryId).toBe('cat-groceries');
  });
});
