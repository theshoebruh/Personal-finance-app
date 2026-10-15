import Dexie from 'dexie';
import { FinanceDb, SCHEMA_VERSIONS } from '@/data/local-db/db';
import { ValidationError, createDexieStore } from '@/data/repositories/dexieStore';
import type { FinanceStore } from '@/data/repositories/types';
import { calculateAvailableToSpend } from '@/domain/calculations/availableToSpend';
import { summariseIncomeExpenses } from '@/domain/calculations/reporting';
import { createAccount, deleteAccount, setAccountActive, updateAccount } from './accountsService';
import { exportBackup, parseBackup, restoreBackup, deleteAllData } from './backupService';
import { clearDemoData, hasDemoData, loadDemoData } from './demoService';
import { addGoalContribution, saveGoal, saveRecurringRule } from './planningService';
import { ensureInitialised, getSettings, updateSettings } from './settingsService';
import {
  bulkSetCategory,
  createTransaction,
  createTransfer,
  deleteTransactionPermanently,
  setTransactionArchived,
  updateTransaction,
  updateTransfer,
} from './transactionsService';

let dbCounter = 0;
let db: FinanceDb;
let store: FinanceStore;

beforeEach(async () => {
  db = new FinanceDb(`test-db-${++dbCounter}`);
  store = createDexieStore(db);
  await ensureInitialised(store);
});

afterEach(async () => {
  db.close();
  await Dexie.delete(db.name);
});

const personalAccount = {
  name: 'Capitec main',
  type: 'current' as const,
  workspace: 'personal' as const,
  openingBalanceCents: 500_000,
  openingBalanceDate: '2026-03-01',
  includeInSpendable: true,
};

describe('initialisation and settings', () => {
  it('seeds defaults once and keeps user edits', async () => {
    const s = await getSettings(store);
    expect(s.monthlySalaryCents).toBe(1_200_000);
    expect(s.monthlyTitheCents).toBe(120_000);
    expect(s.savingsRatePercent).toBe(20);
    await updateSettings(store, { savingsRatePercent: 15 });
    await ensureInitialised(store);
    expect((await getSettings(store)).savingsRatePercent).toBe(15);
    expect((await store.categories.list()).length).toBeGreaterThan(20);
  });
});

describe('accounts', () => {
  it('creates personal, savings and business accounts that persist across reopen', async () => {
    await createAccount(store, personalAccount);
    await createAccount(store, {
      ...personalAccount,
      name: 'Savings',
      type: 'savings',
      includeInSpendable: false,
    });
    await createAccount(store, { ...personalAccount, name: 'Business', workspace: 'business' });
    db.close();
    const reopened = new FinanceDb(db.name);
    const names = (await createDexieStore(reopened).accounts.list()).map((a) => a.name).sort();
    expect(names).toEqual(['Business', 'Capitec main', 'Savings']);
    reopened.close();
    db = new FinanceDb(db.name); // for afterEach cleanup
  });

  it('rejects invalid accounts', async () => {
    await expect(createAccount(store, { ...personalAccount, name: '  ' })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(
      createAccount(store, { ...personalAccount, openingBalanceCents: 1.5 }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('archives instead of deleting accounts with transactions, and locks their workspace', async () => {
    const acc = await createAccount(store, personalAccount);
    await createTransaction(store, {
      accountId: acc.id,
      date: '2026-03-02',
      description: 'Coffee',
      amountCents: 3_500,
      type: 'expense',
      categoryId: null,
    });
    await expect(deleteAccount(store, acc.id)).rejects.toThrow(/Archive/);
    await expect(updateAccount(store, acc.id, { workspace: 'business' })).rejects.toThrow(
      /workspace/,
    );
    await setAccountActive(store, acc.id, false);
    expect((await store.accounts.get(acc.id))?.active).toBe(false);
    expect(await store.transactions.byAccount(acc.id)).toHaveLength(1);
  });
});

describe('transactions', () => {
  it('derives sign and workspace, validates categories, and preserves source on edit', async () => {
    const acc = await createAccount(store, personalAccount);
    const t = await createTransaction(store, {
      accountId: acc.id,
      date: '2026-03-02',
      description: 'Groceries',
      amountCents: 45_000,
      type: 'expense',
      categoryId: 'cat-groceries',
    });
    expect(t.amountCents).toBe(-45_000);
    expect(t.workspace).toBe('personal');
    await expect(
      createTransaction(store, {
        accountId: acc.id,
        date: '2026-03-02',
        description: 'X',
        amountCents: 1,
        type: 'expense',
        categoryId: 'cat-biz-software',
      }),
    ).rejects.toThrow(/not a personal category/);
    const edited = await updateTransaction(store, t.id, {
      amountCents: 50_000,
      description: 'Groceries (Checkers)',
    });
    expect(edited.amountCents).toBe(-50_000);
    expect(edited.source).toBe('manual');
    expect(edited.createdAt).toBe(t.createdAt);
  });

  it('records transfers as linked legs that never inflate income or expenses', async () => {
    const acc = await createAccount(store, personalAccount);
    const sav = await createAccount(store, {
      ...personalAccount,
      name: 'Savings',
      type: 'savings',
      includeInSpendable: false,
      openingBalanceCents: 0,
    });
    const biz = await createAccount(store, {
      ...personalAccount,
      name: 'Biz',
      workspace: 'business',
      openingBalanceCents: 0,
    });
    const [out, into] = await createTransfer(store, {
      fromAccountId: acc.id,
      toAccountId: sav.id,
      date: '2026-03-05',
      amountCents: 216_000,
    });
    expect(out.transferId).toBe(into.transferId);
    expect(out.amountCents + into.amountCents).toBe(0);
    const [p] = await createTransfer(store, {
      fromAccountId: acc.id,
      toAccountId: biz.id,
      date: '2026-03-06',
      amountCents: 10_000,
    });
    expect(p.transferKind).toBe('owner_contribution');

    await updateTransfer(store, out.transferId!, { amountCents: 200_000 });
    const legs = await store.transactions.byTransferId(out.transferId!);
    expect(legs.map((l) => l.amountCents).sort((a, b) => a - b)).toEqual([-200_000, 200_000]);

    const all = await store.transactions.list();
    const summary = summariseIncomeExpenses(all, 'combined', '2026-03-01', '2026-03-31');
    expect(summary.incomeCents).toBe(0);
    expect(summary.expenseCents).toBe(0);
    await expect(updateTransaction(store, out.id, { amountCents: 1 })).rejects.toThrow(
      /transfer form/,
    );
  });

  it('archives and deletes both transfer legs together', async () => {
    const acc = await createAccount(store, personalAccount);
    const sav = await createAccount(store, {
      ...personalAccount,
      name: 'Savings',
      type: 'savings',
    });
    const [out] = await createTransfer(store, {
      fromAccountId: acc.id,
      toAccountId: sav.id,
      date: '2026-03-05',
      amountCents: 1_000,
    });
    await setTransactionArchived(store, out.id, true);
    expect((await store.transactions.list()).every((t) => t.archived)).toBe(true);
    await deleteTransactionPermanently(store, out.id);
    expect(await store.transactions.list()).toHaveLength(0);
  });

  it('bulk-assigns categories and clears needs-review', async () => {
    const acc = await createAccount(store, personalAccount);
    const a = await createTransaction(store, {
      accountId: acc.id,
      date: '2026-03-02',
      description: 'A',
      amountCents: 100,
      type: 'expense',
      categoryId: null,
      status: 'needs_review',
    });
    const b = await createTransaction(store, {
      accountId: acc.id,
      date: '2026-03-02',
      description: 'B',
      amountCents: 100,
      type: 'expense',
      categoryId: null,
    });
    expect(await bulkSetCategory(store, [a.id, b.id], 'cat-shopping')).toBe(2);
    const updated = await store.transactions.get(a.id);
    expect(updated?.categoryId).toBe('cat-shopping');
    expect(updated?.status).toBe('posted');
  });

  it('recalculates available-to-spend after a transaction is edited', async () => {
    const acc = await createAccount(store, personalAccount);
    const t = await createTransaction(store, {
      accountId: acc.id,
      date: '2026-03-02',
      description: 'Shoes',
      amountCents: 100_000,
      type: 'expense',
      categoryId: 'cat-shopping',
    });
    const settings = { ...(await getSettings(store)), reservePlannedSavings: false };
    const calc = async () =>
      calculateAvailableToSpend({
        today: '2026-03-10',
        view: 'personal',
        settings,
        accounts: await store.accounts.list(),
        transactions: await store.transactions.list(),
        recurringRules: [],
        budgets: [],
        categories: await store.categories.list(),
        goals: [],
        goalContributions: [],
      }).availableCents;
    expect(await calc()).toBe(400_000);
    await updateTransaction(store, t.id, { amountCents: 50_000 });
    expect(await calc()).toBe(450_000);
  });
});

describe('goals', () => {
  it('blocks withdrawals larger than the allocation', async () => {
    const g = await saveGoal(store, {
      name: 'Buffer',
      goalType: 'monthly_buffer',
      workspace: 'personal',
      targetMode: 'fixed',
      targetCents: 100_000,
      priority: 2,
      state: 'active',
    });
    await addGoalContribution(store, { goalId: g.id, date: '2026-03-01', amountCents: 30_000 });
    await addGoalContribution(store, { goalId: g.id, date: '2026-03-02', amountCents: -10_000 });
    await expect(
      addGoalContribution(store, { goalId: g.id, date: '2026-03-03', amountCents: -30_000 }),
    ).rejects.toThrow(/larger/);
  });
});

describe('backup and restore', () => {
  async function seed() {
    const acc = await createAccount(store, personalAccount);
    await createTransaction(store, {
      accountId: acc.id,
      date: '2026-03-02',
      description: 'Coffee',
      amountCents: 3_500,
      type: 'expense',
      categoryId: null,
    });
    await saveRecurringRule(store, {
      name: 'Rent',
      direction: 'expense',
      amountCents: 450_000,
      frequency: 'monthly',
      startDate: '2026-03-25',
      workspace: 'personal',
      active: true,
      matchWindowDays: 5,
      alertLeadDays: 3,
    });
    await updateSettings(store, { paydayDayOfMonth: 25 });
  }

  it('round-trips through JSON and restoring twice creates no duplicates', async () => {
    await seed();
    const text = JSON.stringify(await exportBackup(store));
    const backup = parseBackup(text);
    await restoreBackup(store, backup, 'merge');
    await restoreBackup(store, backup, 'merge');
    expect(await store.accounts.list()).toHaveLength(1);
    expect(await store.transactions.list()).toHaveLength(1);
    expect(await store.recurringRules.list()).toHaveLength(1);
  });

  it('restores after total data loss', async () => {
    await seed();
    const text = JSON.stringify(await exportBackup(store));
    await deleteAllData(store);
    expect(await store.accounts.list()).toHaveLength(0);
    expect((await getSettings(store)).paydayDayOfMonth).toBeNull();
    const summary = await restoreBackup(store, parseBackup(text), 'replace');
    expect(summary.counts.transactions).toBe(1);
    expect((await getSettings(store)).paydayDayOfMonth).toBe(25);
  });

  it('rejects invalid backups without changing anything', async () => {
    await seed();
    expect(() => parseBackup('not json')).toThrow(/not valid JSON/);
    const backup = await exportBackup(store);
    const tampered = JSON.parse(JSON.stringify(backup));
    tampered.data.transactions[0].amountCents = 12.5;
    expect(() => parseBackup(JSON.stringify(tampered))).toThrow(/could not be validated/);
    const orphan = JSON.parse(JSON.stringify(backup));
    orphan.data.accounts = [];
    expect(() => parseBackup(JSON.stringify(orphan))).toThrow(/missing/);
    expect(await store.transactions.list()).toHaveLength(1);
  });
});

describe('demo data', () => {
  it('loads labelled demo data and clears it without touching real data', async () => {
    const real = await createAccount(store, personalAccount);
    await createTransaction(store, {
      accountId: real.id,
      date: '2026-03-02',
      description: 'Real',
      amountCents: 100,
      type: 'expense',
      categoryId: null,
    });
    await loadDemoData(store, '2026-03-15');
    expect(await hasDemoData(store)).toBe(true);
    const accounts = await store.accounts.list();
    expect(accounts.filter((a) => a.isDemo).every((a) => a.name.startsWith('Demo ·'))).toBe(true);
    await expect(loadDemoData(store, '2026-03-15')).rejects.toThrow(/already/);
    expect(await clearDemoData(store)).toBeGreaterThan(10);
    expect((await store.accounts.list()).map((a) => a.name)).toEqual(['Capitec main']);
    expect((await store.transactions.list()).map((t) => t.description)).toEqual(['Real']);
  });

  it('refuses to clear demo data when real records depend on it', async () => {
    await loadDemoData(store, '2026-03-15');
    const demoAcc = (await store.accounts.list()).find((a) => a.isDemo)!;
    await createTransaction(store, {
      accountId: demoAcc.id,
      date: '2026-03-02',
      description: 'Mine',
      amountCents: 100,
      type: 'expense',
      categoryId: null,
    });
    await expect(clearDemoData(store)).rejects.toThrow(/Move or delete/);
  });
});

describe('schema migrations', () => {
  it('preserves existing data when the schema is upgraded', async () => {
    const acc = await createAccount(store, personalAccount);
    db.close();

    // Simulate a future release that adds an index and back-fills a field.
    class FutureDb extends Dexie {
      constructor(name: string) {
        super(name);
        for (const v of SCHEMA_VERSIONS) this.version(v.version).stores(v.stores);
        this.version(SCHEMA_VERSIONS.length + 1)
          .stores({ accounts: 'id, workspace, type' })
          .upgrade((tx) =>
            tx
              .table('accounts')
              .toCollection()
              .modify((a: Record<string, unknown>) => {
                a.migratedField = 'yes';
              }),
          );
      }
    }
    const future = new FutureDb(db.name);
    const migrated = await future.table('accounts').get(acc.id);
    expect(migrated).toMatchObject({
      name: 'Capitec main',
      openingBalanceCents: 500_000,
      migratedField: 'yes',
    });
    expect(await future.table('categories').count()).toBeGreaterThan(20);
    future.close();
    db = new FinanceDb(`cleanup-${db.name}`); // original name now has a newer version; clean separately
    await Dexie.delete(future.name);
  });
});
