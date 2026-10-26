import Dexie from 'dexie';
import { FinanceDb } from '@/data/local-db/db';
import { createDexieStore } from '@/data/repositories/dexieStore';
import type { FinanceStore } from '@/data/repositories/types';
import { groupSummary } from '@/domain/calculations/buckets';
import { summariseStaging } from '@/domain/imports';
import { createAccount } from './accountsService';
import { ensureInitialised } from './settingsService';
import { createTransaction } from './transactionsService';
import { commitImport, prepareImport, undoImport } from './importService';

let n = 0;
let db: FinanceDb;
let store: FinanceStore;
let accountId: string;

// Made-up statements in Capitec's layout. The first ends with a pending card purchase (no
// balance, "(Pending)"); by the second it has posted two days later with slightly different text,
// and a new purchase is pending.
const HEADER =
  'Nr,Account,Posting Date,Transaction Date,Description,Original Description,Parent Category,Category,Money In,Money Out,Fee,Balance';
const SALARY =
  '1,0000000000,2026-03-01,2026-03-01 08:00,Salary,SALARY,Salary,Salary,5000.00,,,5000.00';
const SHOP =
  '2,0000000000,2026-03-02,2026-03-02 12:00,Corner shop (Card 1111),CORNER SHOP  TOWN ZA,Food,Groceries,,-100.00,,4900.00';
const GAME_PENDING =
  '3,0000000000,2026-03-03,2026-03-03 16:34,(Pending) Game Store Mall Waterfr (Card 1111),GAME STORE   MALL WATERFR  ZA,Entertainment,Games,,-165.00,,';
const GAME_POSTED =
  '3,0000000000,2026-03-05,2026-03-03 16:34,Game Store Mall Waterf (Card 1111),GAME STORE   MALL WATERF WCZA,Entertainment,Games,,-165.00,,4735.00';
const CHAT_PENDING =
  '4,0000000000,2026-03-05,2026-03-05 15:06,(Pending) Chat Service Subscription (Card 1111),CHAT SERVICE SUBSCR US,Entertainment,Digital Subscriptions,,-149.00,,';
const FIRST = [HEADER, SALARY, SHOP, GAME_PENDING].join('\n');
const SECOND = [HEADER, SALARY, SHOP, GAME_POSTED, CHAT_PENDING].join('\n');

beforeEach(async () => {
  db = new FinanceDb(`pending-test-${++n}`);
  store = createDexieStore(db);
  await ensureInitialised(store);
  accountId = (
    await createAccount(store, {
      name: 'Main',
      type: 'current',
      workspace: 'personal',
      openingBalanceCents: 0,
      openingBalanceDate: '2026-03-01',
      includeInSpendable: true,
    })
  ).id;
});
afterEach(async () => {
  db.close();
  await Dexie.delete(db.name);
});

async function importCsv(text: string, fileName: string) {
  const prepared = await prepareImport(store, { accountId, text, fileName });
  const result = await commitImport(store, {
    prepared,
    rows: prepared.staging.rows,
    saveMapping: true,
  });
  return { prepared, result };
}
const live = async () => (await store.transactions.list()).filter((t) => !t.archived);

describe('pending card purchases', () => {
  it('imports a pending row as pending, without "(Pending)" in its name', async () => {
    const { prepared, result } = await importCsv(FIRST, 'first.csv');
    expect(prepared.staging.mapping.transactionDateColumn).toBe(3);
    expect(result).toMatchObject({ created: 3, pending: 1, postedPending: 0 });
    const pending = (await live()).find((t) => t.status === 'pending')!;
    expect(pending).toMatchObject({
      description: 'Game Store Mall Waterfr (Card 1111)',
      amountCents: -16_500,
      date: '2026-03-03',
    });
    expect(pending.tags).toContain('pt:2026-03-03 16:34');
  });

  it('updates the pending transaction when the next statement has it posted (no double count)', async () => {
    await importCsv(FIRST, 'first.csv');
    const prepared = await prepareImport(store, {
      accountId,
      text: SECOND,
      fileName: 'second.csv',
    });
    const byDesc = (d: string) => prepared.staging.rows.find((r) => r.description.startsWith(d))!;
    expect(byDesc('Salary').status).toBe('duplicate');
    expect(byDesc('Game Store')).toMatchObject({
      status: 'posts_pending',
      include: true,
      pendingMatch: { basis: 'time', date: '2026-03-03' },
    });
    expect(byDesc('Chat Service')).toMatchObject({ status: 'new', pending: true });
    expect(summariseStaging(prepared.staging.rows, prepared.account)).toMatchObject({
      postsPending: 1,
      pendingRows: 1,
    });

    const result = await commitImport(store, {
      prepared,
      rows: prepared.staging.rows,
      saveMapping: false,
    });
    expect(result).toMatchObject({ created: 1, postedPending: 1, pending: 1 });
    const txns = await live();
    const game = txns.filter((t) => t.amountCents === -16_500);
    expect(game).toHaveLength(1);
    expect(game[0]).toMatchObject({
      status: 'posted',
      date: '2026-03-05',
      description: 'Game Store Mall Waterf (Card 1111)',
    });
    expect(txns.find((t) => t.amountCents === -14_900)?.status).toBe('pending');
    expect(txns).toHaveLength(4);

    // Importing the same statement again adds nothing; nor does the older one.
    const again = await prepareImport(store, { accountId, text: SECOND, fileName: 'again.csv' });
    expect(again.staging.rows.filter((r) => r.include)).toEqual([]);
    const older = await prepareImport(store, { accountId, text: FIRST, fileName: 'older.csv' });
    expect(older.staging.rows.filter((r) => r.include)).toEqual([]);
    expect(older.staging.rows.find((r) => r.pending)?.duplicateOf?.reason).toBe('same_transaction');
  });

  it('undoing the later import puts the transaction back to pending on its old date', async () => {
    await importCsv(FIRST, 'first.csv');
    const { result } = await importCsv(SECOND, 'second.csv');
    await undoImport(store, result.batch.id);
    const txns = await live();
    expect(txns).toHaveLength(3);
    const game = txns.find((t) => t.amountCents === -16_500)!;
    expect(game).toMatchObject({ status: 'pending', date: '2026-03-03' });
    expect(game.tags.some((t) => t.startsWith('pp:') || t.startsWith('pd:'))).toBe(false);
  });

  it('recognises a "(Pending)" transaction imported before pending support', async () => {
    // As the older app stored it: an ordinary transaction with "(Pending)" in its description.
    await createTransaction(store, {
      accountId,
      date: '2026-03-03',
      description: '(Pending) Game Store Mall Waterfr (Card 1111)',
      amountCents: 16_500,
      type: 'expense',
      categoryId: null,
    });
    const prepared = await prepareImport(store, {
      accountId,
      text: [HEADER, GAME_POSTED].join('\n'),
      fileName: 'second.csv',
    });
    expect(prepared.staging.rows[0]).toMatchObject({
      status: 'posts_pending',
      pendingMatch: { basis: 'similar' },
    });
    await commitImport(store, { prepared, rows: prepared.staging.rows, saveMapping: false });
    const game = (await live()).filter((t) => t.amountCents === -16_500);
    expect(game).toHaveLength(1);
    expect(game[0]!.description).toBe('Game Store Mall Waterf (Card 1111)');
  });

  it('lets you import a "now posted" row as a separate transaction instead', async () => {
    await importCsv(FIRST, 'first.csv');
    const prepared = await prepareImport(store, {
      accountId,
      text: SECOND,
      fileName: 'second.csv',
    });
    const rows = prepared.staging.rows.map((r) => {
      if (r.status !== 'posts_pending') return r;
      const { pendingMatch: _drop, ...rest } = r;
      return { ...rest, status: 'new' as const };
    });
    await commitImport(store, { prepared, rows, saveMapping: false });
    expect((await live()).filter((t) => t.amountCents === -16_500)).toHaveLength(2);
  });

  it('counts pending spending in the totals, and says how much of it is pending', async () => {
    await importCsv(FIRST, 'first.csv');
    const [groups, categories, accounts, transactions] = await Promise.all([
      store.budgetGroups.list(),
      store.categories.list(),
      store.accounts.list(),
      store.transactions.list(),
    ]);
    const s = groupSummary({
      groups,
      categories,
      accounts,
      transactions,
      start: '2026-03-01',
      end: '2026-03-31',
    });
    // R100 posted + R165 still pending.
    expect(s.expenseCents).toBe(26_500);
    expect(s.pendingOutCents).toBe(16_500);
  });
});
