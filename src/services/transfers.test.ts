import Dexie from 'dexie';
import { FinanceDb } from '@/data/local-db/db';
import { createDexieStore } from '@/data/repositories/dexieStore';
import type { FinanceStore } from '@/data/repositories/types';
import type { Account } from '@/domain/models';
import { accountBalance } from '@/domain/calculations/balances';
import { summariseIncomeExpenses } from '@/domain/calculations/reporting';
import { savingsMadeInPeriod } from '@/domain/calculations/goals';
import { createAccount } from './accountsService';
import { commitImport, prepareImport, undoImport } from './importService';
import { ensureInitialised } from './settingsService';
import { convertToTransfer, createTransaction } from './transactionsService';

let n = 0;
let db: FinanceDb;
let store: FinanceStore;
let main: Account;
let savings: Account;
let business: Account;

beforeEach(async () => {
  db = new FinanceDb(`transfers-${++n}`);
  store = createDexieStore(db);
  await ensureInitialised(store);
  const base = {
    openingBalanceCents: 0,
    openingBalanceDate: '2026-03-01',
    workspace: 'personal' as const,
  };
  main = await createAccount(store, {
    ...base,
    name: 'Capitec main',
    type: 'current',
    openingBalanceCents: 1_000_000,
    includeInSpendable: true,
  });
  savings = await createAccount(store, {
    ...base,
    name: 'Savings',
    type: 'savings',
    includeInSpendable: false,
  });
  business = await createAccount(store, {
    ...base,
    name: 'Business account',
    type: 'current',
    workspace: 'business',
    includeInSpendable: true,
  });
});

afterEach(async () => {
  db.close();
  await Dexie.delete(db.name);
});

const MAIN_CSV =
  'Date,Description,Amount\n2026-03-05,TRANSFER TO SAVINGS,-2160.00\n2026-03-06,WOOLWORTHS,-300.00\n';
const SAVINGS_CSV = 'Date,Description,Amount\n2026-03-06,TRANSFER FROM CAPITEC MAIN,2160.00\n';

async function importInto(
  account: Account,
  csv: string,
  opts: { recordOtherSide?: boolean; choose?: Record<number, string | null> } = {},
) {
  const p = await prepareImport(store, {
    accountId: account.id,
    text: csv,
    fileName: `${account.name}.csv`,
  });
  const rows = p.staging.rows.map((r, i) =>
    i in (opts.choose ?? {}) ? { ...r, transferAccountId: opts.choose![i] ?? null } : r,
  );
  const result = await commitImport(store, {
    prepared: p,
    rows,
    saveMapping: false,
    ...(opts.recordOtherSide !== undefined ? { recordOtherSide: opts.recordOtherSide } : {}),
  });
  return { prepared: p, result };
}

async function totals() {
  const txns = await store.transactions.list();
  const accounts = await store.accounts.list();
  const s = summariseIncomeExpenses(txns, 'combined', '2026-03-01', '2026-03-31');
  const bal = (a: Account) =>
    accountBalance(
      accounts.find((x) => x.id === a.id)!,
      txns,
    );
  return {
    txns,
    income: s.incomeCents,
    spending: s.expenseCents,
    main: bal(main),
    savings: bal(savings),
    saved: savingsMadeInPeriod([], [], accounts, txns, 'personal', '2026-03-01', '2026-03-31'),
  };
}

describe('importing transfers (F-03)', () => {
  it('suggests "transfer to savings" from wording and records both sides when chosen', async () => {
    const p = await prepareImport(store, { accountId: main.id, text: MAIN_CSV });
    expect(p.staging.rows[0]!.transferSuggestion).toEqual({
      strength: 'wording',
      otherAccountId: savings.id,
    });
    expect(p.staging.rows[0]!.transferAccountId).toBeNull(); // weak: user must confirm

    const { result } = await importInto(main, MAIN_CSV, { choose: { 0: savings.id } });
    expect(result.transfers).toBe(1);
    const t = await totals();
    expect(t.spending).toBe(30_000); // only Woolworths
    expect(t.income).toBe(0);
    expect(t.main).toBe(1_000_000 - 216_000 - 30_000);
    expect(t.savings).toBe(216_000);
    expect(t.saved).toBe(216_000); // counts once toward the savings target
  });

  it('then importing the savings statement does not add the transfer again', async () => {
    await importInto(main, MAIN_CSV, { choose: { 0: savings.id } });
    const p = await prepareImport(store, { accountId: savings.id, text: SAVINGS_CSV });
    expect(p.staging.rows[0]!.status).toBe('possible_duplicate'); // matches the recorded other side
    expect(p.staging.rows[0]!.include).toBe(false);
    const t = await totals();
    expect(t.savings).toBe(216_000);
  });

  it('completes a half-recorded transfer when the other statement arrives (either order)', async () => {
    // Savings statement first, without recording the other side.
    await importInto(savings, SAVINGS_CSV, { choose: { 0: main.id }, recordOtherSide: false });
    const p = await prepareImport(store, { accountId: main.id, text: MAIN_CSV });
    expect(p.staging.rows[0]!.transferSuggestion?.strength).toBe('half_recorded');
    expect(p.staging.rows[0]!.transferAccountId).toBe(savings.id); // strong: chosen by default
    await commitImport(store, { prepared: p, rows: p.staging.rows, saveMapping: false });
    const t = await totals();
    const legs = t.txns.filter((x) => x.type === 'transfer');
    expect(legs).toHaveLength(2);
    expect(new Set(legs.map((l) => l.transferId)).size).toBe(1);
    expect(legs.reduce((s, l) => s + l.amountCents, 0)).toBe(0);
    expect([t.spending, t.income, t.savings]).toEqual([30_000, 0, 216_000]);
  });

  it('converts an earlier income/expense into the other leg, and undo reverts it', async () => {
    // The savings statement was imported before transfer detection existed: a plain income.
    await importInto(savings, SAVINGS_CSV, { choose: { 0: null } });
    expect((await totals()).income).toBe(216_000);

    const { result } = await importInto(main, MAIN_CSV); // strong "paired" suggestion applies itself
    expect(result.transfers).toBe(1);
    let t = await totals();
    expect([t.income, t.spending]).toEqual([0, 30_000]);
    expect(t.txns.filter((x) => x.type === 'transfer')).toHaveLength(2);

    await undoImport(store, result.batch.id);
    t = await totals();
    const reverted = t.txns.find((x) => x.accountId === savings.id)!;
    expect(reverted).toMatchObject({ type: 'income', status: 'needs_review', categoryId: null });
    expect(reverted.transferId).toBeUndefined();
    expect(reverted.tags).toEqual([]);
    expect([t.income, t.spending, t.txns.length]).toEqual([216_000, 0, 1]);
  });

  it('undo also removes the other side it recorded', async () => {
    const { result } = await importInto(main, MAIN_CSV, { choose: { 0: savings.id } });
    await undoImport(store, result.batch.id);
    expect(await store.transactions.list()).toEqual([]);
  });

  it('labels personal ↔ business transfers as owner contributions', async () => {
    await importInto(
      main,
      'Date,Description,Amount\n2026-03-05,PAYMENT TO BUSINESS ACCOUNT,-500.00\n',
      { choose: { 0: business.id } },
    );
    const legs = (await store.transactions.list()).filter((x) => x.type === 'transfer');
    expect(legs.map((l) => l.transferKind)).toEqual(['owner_contribution', 'owner_contribution']);
    expect(legs.find((l) => l.accountId === business.id)?.workspace).toBe('business');
  });
});

describe('convert an existing transaction to a transfer', () => {
  it('links to a matching entry in the other account', async () => {
    const out = await createTransaction(store, {
      accountId: main.id,
      date: '2026-03-05',
      description: 'TRF',
      amountCents: 100_000,
      type: 'expense',
      categoryId: null,
    });
    const inn = await createTransaction(store, {
      accountId: savings.id,
      date: '2026-03-07',
      description: 'Deposit',
      amountCents: 100_000,
      type: 'income',
      categoryId: null,
    });
    expect(await convertToTransfer(store, out.id, savings.id, { recordOtherSide: true })).toBe(
      'paired',
    );
    const [a, b] = [await store.transactions.get(out.id), await store.transactions.get(inn.id)];
    expect(a?.transferId).toBeDefined();
    expect(b?.transferId).toBe(a?.transferId);
    expect((await totals()).spending).toBe(0);
  });

  it('records the other side when there is no match, or just one side if asked', async () => {
    const t1 = await createTransaction(store, {
      accountId: main.id,
      date: '2026-03-05',
      description: 'TRF',
      amountCents: 40_000,
      type: 'expense',
      categoryId: null,
    });
    expect(await convertToTransfer(store, t1.id, savings.id, { recordOtherSide: true })).toBe(
      'both_sides',
    );
    expect((await totals()).savings).toBe(40_000);
    const t2 = await createTransaction(store, {
      accountId: main.id,
      date: '2026-03-20',
      description: 'TRF',
      amountCents: 10_000,
      type: 'expense',
      categoryId: null,
    });
    expect(await convertToTransfer(store, t2.id, savings.id, { recordOtherSide: false })).toBe(
      'one_side',
    );
    expect((await totals()).savings).toBe(40_000);
  });

  it('refuses transfers, adjustments and the same account', async () => {
    const t = await createTransaction(store, {
      accountId: main.id,
      date: '2026-03-05',
      description: 'X',
      amountCents: 1_000,
      type: 'expense',
      categoryId: null,
    });
    await expect(
      convertToTransfer(store, t.id, main.id, { recordOtherSide: true }),
    ).rejects.toThrow(/different account/);
    await convertToTransfer(store, t.id, savings.id, { recordOtherSide: false });
    await expect(
      convertToTransfer(store, t.id, savings.id, { recordOtherSide: false }),
    ).rejects.toThrow(/already a transfer/);
    const adj = await createTransaction(store, {
      accountId: main.id,
      date: '2026-03-05',
      description: 'Fix',
      amountCents: 1_000,
      type: 'adjustment',
      adjustmentDirection: 'in',
      categoryId: null,
    });
    await expect(
      convertToTransfer(store, adj.id, savings.id, { recordOtherSide: false }),
    ).rejects.toThrow(/adjustments/);
  });
});
