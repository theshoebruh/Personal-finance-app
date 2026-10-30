import Dexie from 'dexie';
import { FinanceDb } from '@/data/local-db/db';
import { createDexieStore } from '@/data/repositories/dexieStore';
import type { FinanceStore } from '@/data/repositories/types';
import { makeTxn } from '@/test/factories';
import { groupSummary } from '@/domain/calculations/buckets';
import { budgetPeriod, withReceivedPaydays } from '@/domain/calculations/period';
import { SETTINGS_ID } from '@/domain/models';
import { createAccount } from './accountsService';
import { commitImport, prepareImport } from './importService';
import { ensureInitialised, updateSettings } from './settingsService';
import { redateToSpendDates, transactionsToRedate } from './spendDates';

const imported = (date: string, tag: string | null, extra = {}) =>
  makeTxn({ accountId: 'main', date, source: 'csv', tags: tag ? [tag] : [], ...extra });

describe('dating imported purchases by when you spent', () => {
  it('re-dates an earlier import from its recorded transaction time', () => {
    const t = imported('2026-03-30', 'pt:2026-03-28 13:47');
    expect(transactionsToRedate([t])).toEqual([
      { ...t, date: '2026-03-28', postedDate: '2026-03-30' },
    ]);
  });

  it('leaves alone what it can’t or needn’t correct', () => {
    const cases = [
      imported('2026-03-30', 'pt:2026-03-30 09:00'), // same day
      imported('2026-03-30', null), // no transaction time recorded
      imported('2026-03-30', 'pt:28/03/2026 13:47'), // not an ISO date
      imported('2026-03-30', 'pt:2026-03-01 08:00'), // implausibly far before posting
      imported('2026-03-30', 'pt:2026-03-28 13:47', {
        postedDate: '2026-03-30',
        date: '2026-03-28',
      }),
      makeTxn({ accountId: 'main', date: '2026-03-30', source: 'manual', tags: ['pt:2026-03-28'] }),
    ];
    expect(transactionsToRedate(cases)).toEqual([]);
  });
});

describe('a purchase made before payday but posted on payday', () => {
  let db: FinanceDb;
  let store: FinanceStore;
  beforeEach(async () => {
    db = new FinanceDb(`spend-dates-${Math.random()}`);
    store = createDexieStore(db);
    await ensureInitialised(store);
    await updateSettings(store, { paydayDayOfMonth: 29, budgetPeriodMode: 'pay_period' });
  });
  afterEach(async () => {
    db.close();
    await Dexie.delete(db.name);
  });

  it('counts in the period before the salary, not the new one', async () => {
    const acc = await createAccount(store, {
      name: 'Main',
      type: 'current',
      workspace: 'personal',
      openingBalanceCents: 0,
      openingBalanceDate: '2026-02-20',
      includeInSpendable: true,
    });
    // Made-up statement in Capitec's layout: last month's salary, a purchase on 28 Mar that the
    // bank posted on 30 Mar, and this month's salary on 30 Mar.
    const csv = [
      'Posting Date,Transaction Date,Description,Category,Money In,Money Out,Fee,Balance',
      '2026-02-28,2026-02-28 08:00,Salary,Salary,12000.00,,,12000.00',
      '2026-03-30,2026-03-28 13:47,Corner shop,Groceries,,-94.37,,11905.63',
      '2026-03-30,2026-03-30 08:00,Salary,Salary,12000.00,,,23905.63',
    ].join('\n');
    const prepared = await prepareImport(store, {
      accountId: acc.id,
      text: csv,
      fileName: 's.csv',
    });
    await commitImport(store, { prepared, rows: prepared.staging.rows, saveMapping: false });

    const txns = await store.transactions.list();
    expect(txns.find((t) => t.description === 'Corner shop')).toMatchObject({
      date: '2026-03-28',
      postedDate: '2026-03-30',
    });
    const [settings, rules, groups, categories, accounts] = await Promise.all([
      store.settings.get(SETTINGS_ID),
      store.recurringRules.list(),
      store.budgetGroups.list(),
      store.categories.list(),
      store.accounts.list(),
    ]);
    const today = '2026-03-30';
    const period = budgetPeriod(today, withReceivedPaydays(today, settings!, rules, txns));
    expect(period.start).toBe('2026-03-30');
    const s = groupSummary({ groups, categories, accounts, transactions: txns, ...period });
    expect(s.incomeCents).toBe(1_200_000);
    expect(s.expenseCents).toBe(0); // the shop purchase belongs to the previous period
  });

  it('fixes transactions imported before this change on start-up', async () => {
    await store.transactions.put(imported('2026-03-30', 'pt:2026-03-28 13:47', { id: 'old' }));
    expect(await redateToSpendDates(store)).toBe(1);
    expect(await store.transactions.get('old')).toMatchObject({
      date: '2026-03-28',
      postedDate: '2026-03-30',
    });
    expect(await redateToSpendDates(store)).toBe(0);
  });
});
