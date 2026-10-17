import Dexie from 'dexie';
import { FinanceDb, SCHEMA_VERSIONS } from '@/data/local-db/db';
import { createDexieStore } from '@/data/repositories/dexieStore';
import type { FinanceStore } from '@/data/repositories/types';
import { summariseIncomeExpenses } from '@/domain/calculations/reporting';
import { accountBalance } from '@/domain/calculations/balances';
import { createAccount } from './accountsService';
import { createTransaction } from './transactionsService';
import { exportBackup, parseBackup, restoreBackup } from './backupService';
import { ensureInitialised } from './settingsService';
import {
  checkImportFile,
  commitImport,
  editedSinceImport,
  prepareImport,
  restage,
  undoImport,
} from './importService';
import { bulkSetCategory } from './transactionsService';

let n = 0;
let db: FinanceDb;
let store: FinanceStore;
let accountId: string;

const MARCH = `Date,Description,Amount,Balance
01/03/2026,SALARY ACME,12000.00,13000.00
02/03/2026,CHURCH TITHE,-1200.00,11800.00
05/03/2026,CHECKERS ROSEBANK,-450.10,11349.90
05/03/2026,CHECKERS ROSEBANK,-450.10,10899.80
32/03/2026,BAD DATE ROW,-10,
`;

// Overlaps MARCH on 5 March and adds two new rows.
const MARCH_LATE = `Date,Description,Amount,Balance
05/03/2026,CHECKERS ROSEBANK,-450.10,11349.90
05/03/2026,CHECKERS ROSEBANK,-450.10,10899.80
10/03/2026,UBER TRIP,-95.00,10804.80
12/03/2026,REFUND CHECKERS,40.00,10844.80
`;

beforeEach(async () => {
  db = new FinanceDb(`import-test-${++n}`);
  store = createDexieStore(db);
  await ensureInitialised(store);
  const acc = await createAccount(store, {
    name: 'Capitec main',
    type: 'current',
    workspace: 'personal',
    openingBalanceCents: 100_000,
    openingBalanceDate: '2026-03-01',
    includeInSpendable: true,
  });
  accountId = acc.id;
});

afterEach(async () => {
  db.close();
  await Dexie.delete(db.name);
});

async function importText(text: string, opts: { saveMapping?: boolean; closing?: boolean } = {}) {
  const prepared = await prepareImport(store, { accountId, text, fileName: 'statement.csv' });
  return {
    prepared,
    result: await commitImport(store, {
      prepared,
      rows: prepared.staging.rows,
      saveMapping: opts.saveMapping ?? true,
      closingBalance: opts.closing
        ? (prepared.staging.balanceCheck?.closing ?? undefined)
        : undefined,
    }),
  };
}

describe('CSV import', () => {
  it('stages rows with a guessed mapping, invalid rows shown but not imported', async () => {
    const p = await prepareImport(store, { accountId, text: MARCH });
    expect(p.mappingSource).toBe('guessed');
    expect(p.staging.mapping).toMatchObject({
      dateColumn: 0,
      descriptionColumn: 1,
      amountColumn: 2,
      balanceColumn: 3,
    });
    expect(p.staging.rows.map((r) => r.status)).toEqual(['new', 'new', 'new', 'new', 'invalid']);
    expect(p.staging.rows[3]!.identicalLines).toEqual([4]);
    expect(p.staging.balanceCheck).toMatchObject({
      order: 'oldest_first',
      closing: { date: '2026-03-05', balanceCents: 1_089_980 },
    });
    expect(await store.transactions.list()).toHaveLength(0); // staging writes nothing
  });

  it('commits selected rows with source, original text, fingerprint and batch', async () => {
    const { result } = await importText(MARCH);
    expect(result.created).toBe(4);
    expect(result.batch).toMatchObject({
      transactionCount: 4,
      errorCount: 1,
      skippedCount: 0,
      dateFrom: '2026-03-01',
      dateTo: '2026-03-05',
    });
    const txns = await store.transactions.list();
    expect(
      txns.every(
        (t) =>
          t.source === 'csv' &&
          t.status === 'needs_review' &&
          t.importBatchId === result.batch.id &&
          t.fingerprint,
      ),
    ).toBe(true);
    expect(txns.find((t) => t.amountCents === 1_200_000)).toMatchObject({
      type: 'income',
      originalDescription: '01/03/2026 | SALARY ACME | 12000.00 | 13000.00',
    });
    const acc = (await store.accounts.get(accountId))!;
    expect(accountBalance(acc, txns)).toBe(100_000 + 1_200_000 - 120_000 - 45_010 - 45_010);
  });

  it('does not silently duplicate anything when the same file is imported again', async () => {
    await importText(MARCH);
    const again = await prepareImport(store, { accountId, text: MARCH });
    expect(again.mappingSource).toBe('saved');
    expect(again.staging.rows.map((r) => r.status)).toEqual([
      'duplicate',
      'duplicate',
      'duplicate',
      'duplicate',
      'invalid',
    ]);
    expect(again.staging.rows.every((r) => !r.include)).toBe(true);
    await expect(
      commitImport(store, { prepared: again, rows: again.staging.rows, saveMapping: false }),
    ).rejects.toThrow(/No rows/);
  });

  it('imports only the new rows from an overlapping statement', async () => {
    await importText(MARCH);
    const { prepared, result } = await importText(MARCH_LATE);
    expect(prepared.staging.rows.map((r) => r.status)).toEqual([
      'duplicate',
      'duplicate',
      'new',
      'new',
    ]);
    expect(result.created).toBe(2);
    expect(await store.transactions.list()).toHaveLength(6);
  });

  it('lets the user explicitly include a flagged duplicate', async () => {
    await importText(MARCH);
    const again = await prepareImport(store, { accountId, text: MARCH });
    const rows = again.staging.rows.map((r, i) => (i === 2 ? { ...r, include: true } : r));
    expect((await commitImport(store, { prepared: again, rows, saveMapping: false })).created).toBe(
      1,
    );
  });

  it('flags a manual entry for the same purchase so it is not counted twice', async () => {
    await createTransaction(store, {
      accountId,
      date: '2026-03-04',
      description: 'Groceries',
      amountCents: 45_010,
      type: 'expense',
      categoryId: 'cat-groceries',
    });
    const p = await prepareImport(store, { accountId, text: MARCH });
    expect(p.staging.rows.map((r) => r.status)).toEqual([
      'new',
      'new',
      'possible_duplicate',
      'new',
      'invalid',
    ]);
  });

  it('undoes a batch, keeps the audit record, and allows re-importing', async () => {
    const { result } = await importText(MARCH);
    const salary = (await store.transactions.byImportBatch(result.batch.id)).find(
      (t) => t.amountCents > 0,
    );
    expect(await bulkSetCategory(store, [salary!.id], 'cat-salary')).toEqual({
      updated: 1,
      skipped: 0,
    });
    expect(await editedSinceImport(store, result.batch.id)).toBe(1);
    expect(await undoImport(store, result.batch.id)).toBe(4);
    expect(await store.transactions.list()).toHaveLength(0);
    expect(await store.importBatches.get(result.batch.id)).toMatchObject({ status: 'undone' });
    await expect(undoImport(store, result.batch.id)).rejects.toThrow(/already/);
    const again = await prepareImport(store, { accountId, text: MARCH });
    expect(again.staging.rows.filter((r) => r.status === 'new')).toHaveLength(4);
  });

  it('re-stages after a mapping change and saves the mapping per account', async () => {
    const p = await prepareImport(store, { accountId, text: MARCH });
    const inverted = await restage(store, p, { ...p.staging.mapping, invertSign: true });
    expect(inverted.staging.rows[0]!.amountCents).toBe(-1_200_000);
    expect(inverted.staging.balanceCheck?.suggestInvertSign).toBe(true);
    await commitImport(store, {
      prepared: inverted,
      rows: inverted.staging.rows,
      saveMapping: true,
    });
    expect((await store.importProfiles.get(accountId))?.mapping.invertSign).toBe(true);
    const changedHeader = await prepareImport(store, {
      accountId,
      text: MARCH.replace('Description', 'Narrative'),
    });
    expect(changedHeader).toMatchObject({ mappingSource: 'guessed', headerChanged: true });
  });

  it('records the statement closing balance as a reconciliation check', async () => {
    await importText(MARCH, { closing: true });
    const acc = await store.accounts.get(accountId);
    expect(acc).toMatchObject({ reconciledBalanceCents: 1_089_980, reconciledDate: '2026-03-05' });
  });

  it('keeps imported transfers-out as expenses but never mixes workspaces', async () => {
    await importText(MARCH);
    const s = summariseIncomeExpenses(
      await store.transactions.list(),
      'business',
      '2026-03-01',
      '2026-03-31',
    );
    expect(s.incomeCents).toBe(0);
  });

  it('rejects unsupported files and archived accounts with clear messages', async () => {
    expect(() => checkImportFile({ name: 'statement.xlsx', size: 10 })).toThrow(/CSV UTF-8/);
    expect(() => checkImportFile({ name: 'statement.pdf', size: 10 })).toThrow(/PDF/);
    expect(() => checkImportFile({ name: 'big.csv', size: 6 * 1024 * 1024 })).toThrow(/5 MB/);
    await expect(prepareImport(store, { accountId, text: '' })).rejects.toThrow(/empty/);
    await store.accounts.put({ ...(await store.accounts.get(accountId))!, active: false });
    await expect(prepareImport(store, { accountId, text: MARCH })).rejects.toThrow(/archived/);
  });

  it('round-trips import profiles and batches through backup, and accepts older backups', async () => {
    await importText(MARCH);
    const backup = await exportBackup(store);
    expect(backup.data.importProfiles).toHaveLength(1);
    const old = JSON.parse(JSON.stringify(backup));
    delete old.data.importProfiles;
    const parsed = parseBackup(JSON.stringify(old));
    expect(parsed.data.importProfiles).toEqual([]);
    await restoreBackup(store, parseBackup(JSON.stringify(backup)), 'replace');
    expect(await store.importBatches.list()).toHaveLength(1);
  });
});

describe('schema v1 → v2 migration', () => {
  it('opens a v1 database with data intact and adds the import-profile table', async () => {
    const name = `migration-${++n}`;
    const v1 = new Dexie(name);
    v1.version(1).stores(SCHEMA_VERSIONS[0]!.stores);
    await v1.table('accounts').put({ id: 'x', name: 'Old account' });
    v1.close();
    const upgraded = new FinanceDb(name);
    expect(await upgraded.accounts.get('x')).toMatchObject({ name: 'Old account' });
    expect(await upgraded.importProfiles.count()).toBe(0);
    upgraded.close();
    await Dexie.delete(name);
  });
});

describe('demo accounts', () => {
  it('treats imports into a demo account as demo data, so clearing demo removes them', async () => {
    const { loadDemoData, clearDemoData } = await import('./demoService');
    await loadDemoData(store, '2026-03-15');
    const demo = (await store.accounts.list()).find((a) => a.isDemo && a.name.includes('Capitec'))!;
    const prepared = await prepareImport(store, { accountId: demo.id, text: MARCH_LATE });
    await commitImport(store, { prepared, rows: prepared.staging.rows, saveMapping: true });
    await clearDemoData(store);
    expect((await store.accounts.list()).map((a) => a.name)).toEqual(['Capitec main']);
    expect(await store.importBatches.list()).toHaveLength(0);
    expect(await store.importProfiles.list()).toHaveLength(0);
    expect((await store.transactions.list()).filter((t) => t.accountId === demo.id)).toHaveLength(
      0,
    );
  });
});

describe('bank fees', () => {
  // Made-up rows in Capitec's layout: fees mostly on their own line, one line with both.
  const CAPITEC = `Nr,Account,Posting Date,Transaction Date,Description,Original Description,Parent Category,Category,Money In,Money Out,Fee,Balance
1,0000000000,2026-03-02,2026-03-01 13:40,Coffee shop,COFFEE SHOP,Food,Groceries,,-50.00,,950.00
2,0000000000,2026-03-02,2026-03-02 23:20,SMS Notification Fee,SMS NOTIFICATION FEE,Fees,Fees,,,-0.70,949.30
3,0000000000,2026-03-03,2026-03-02 10:00,Card purchase,SHOP 123,Shopping,Clothing,,-100.00,-2.00,847.30
`;

  it('imports every fee, so the account balance matches the statement', async () => {
    const p = await prepareImport(store, { accountId, text: CAPITEC, fileName: 'sept.csv' });
    expect(p.staging.rows.filter((r) => r.include)).toHaveLength(4);
    const res = await commitImport(store, { prepared: p, rows: p.staging.rows, saveMapping: true });
    expect(res.created).toBe(4);
    const txns = await store.transactions.byAccount(accountId);
    expect(txns.map((t) => [t.description, t.amountCents]).sort()).toEqual([
      ['Card purchase', -10_000],
      ['Coffee shop', -5_000],
      ['Fee: Card purchase', -200],
      ['SMS Notification Fee', -70],
    ]);
    const account = (await store.accounts.get(accountId))!;
    // Opening balance R1 000 minus everything on the statement = the bank's closing R847,30.
    expect(accountBalance(account, txns, '2026-03-31')).toBe(84_730);
    expect(p.staging.balanceCheck?.closing?.balanceCents).toBe(84_730);
  });

  it('treats fees as already imported when the same statement comes in again', async () => {
    const first = await prepareImport(store, { accountId, text: CAPITEC });
    await commitImport(store, { prepared: first, rows: first.staging.rows, saveMapping: true });
    const again = await prepareImport(store, { accountId, text: CAPITEC });
    expect(again.mappingSource).toBe('saved');
    expect(again.staging.rows.map((r) => r.status)).toEqual([
      'duplicate',
      'duplicate',
      'duplicate',
      'duplicate',
    ]);
  });

  it('picks up the fee column for column settings saved before fees were supported', async () => {
    const first = await prepareImport(store, { accountId, text: CAPITEC });
    await commitImport(store, { prepared: first, rows: first.staging.rows, saveMapping: true });
    // Simulate an older saved mapping that has no feeColumn at all.
    const profile = (await store.importProfiles.get(accountId))!;
    const { feeColumn: _drop, ...oldMapping } = profile.mapping;
    await store.importProfiles.put({ ...profile, mapping: oldMapping });

    const later = CAPITEC.replace(/2026-03-0(\d)/g, '2026-04-0$1');
    const p = await prepareImport(store, { accountId, text: later });
    expect(p.mappingSource).toBe('saved');
    expect(p.staging.mapping.feeColumn).toBe(10);
    expect(p.staging.rows.filter((r) => r.status === 'new')).toHaveLength(4);
  });
});
