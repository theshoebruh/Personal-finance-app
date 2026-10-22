import {
  makeAccount,
  makeBudget,
  makeCategory,
  makeContribution,
  makeGoal,
  makeRule,
  makeSettings,
  makeTxn,
} from '@/test/factories';
import {
  SYNCED_TABLES,
  type SyncedTable,
  fromRow,
  sameContent,
  toCamel,
  toRow,
  toSnake,
} from './rowMapping';

const TS = '2026-01-01T00:00:00.000Z';
const meta = { isDemo: false, createdAt: TS, updatedAt: TS };

const SAMPLES: Record<SyncedTable, object> = {
  accounts: makeAccount({
    id: 'a1',
    institution: 'Capitec',
    reconciledBalanceCents: 1200,
    reconciledDate: '2026-03-31',
  }),
  categories: makeCategory({ id: 'c1', budgetGroupId: 'grp-wants' }),
  budgetGroups: {
    id: 'grp-wants',
    name: 'Wants',
    kind: 'spending',
    colour: 2,
    targetPercent: 22.5,
    sortOrder: 1,
    ...meta,
  },
  importBatches: {
    id: 'b1',
    accountId: 'a1',
    source: 'csv',
    fileName: 'march.csv',
    importedAt: TS,
    transactionCount: 3,
    errorCount: 1,
    status: 'committed',
    skippedCount: 0,
    dateFrom: '2026-03-01',
    dateTo: '2026-03-31',
    ...meta,
  },
  transactions: makeTxn({
    id: 't1',
    accountId: 'a1',
    categoryId: null,
    tags: ['work'],
    notes: 'n',
    fingerprint: 'fp',
  }),
  budgets: makeBudget({ id: 'bu1', categoryId: 'c1' }),
  goals: makeGoal({
    id: 'g1',
    targetCents: null,
    targetMode: 'emergency_auto',
    linkedAccountId: 'a1',
  }),
  goalContributions: makeContribution({ id: 'gc1', goalId: 'g1', amountCents: 500 }),
  recurringRules: makeRule({ id: 'r1', settledDates: ['2026-03-25'], categoryId: 'c1' }),
  importProfiles: {
    id: 'a1',
    accountId: 'a1',
    mapping: {
      hasHeader: true,
      dateColumn: 0,
      descriptionColumn: 1,
      extraDescriptionColumn: null,
      amountMode: 'signed',
      amountColumn: 2,
      debitColumn: null,
      creditColumn: null,
      referenceColumn: null,
      balanceColumn: 3,
      dateFormat: 'auto',
      invertSign: false,
    },
    headerSignature: 'date|description|amount',
    ...meta,
  },
  categorisationRules: {
    id: 'cr1',
    name: 'Uber',
    matchText: 'uber',
    direction: 'out',
    categoryId: 'c1',
    origin: 'user_rule',
    priority: 1,
    enabled: true,
    ...meta,
  },
  projects: { id: 'p1', name: 'Logo work', workspace: 'business', status: 'active', ...meta },
  invoices: {
    id: 'i1',
    invoiceNumber: 'INV-1',
    client: 'Acme',
    issueDate: '2026-03-01',
    dueDate: '2026-03-31',
    amountCents: 250_000,
    status: 'sent',
    paidTransactionIds: [],
    ...meta,
  },
  settings: makeSettings({ paydayDayOfMonth: null, savingsRatePercent: 12.5 }),
};

describe('row mapping', () => {
  it('converts key case both ways', () => {
    expect(toSnake('openingBalanceCents')).toBe('opening_balance_cents');
    expect(toSnake('group')).toBe('group');
    expect(toCamel('payday_day_of_month')).toBe('paydayDayOfMonth');
  });

  it.each(SYNCED_TABLES)('round-trips %s records through a server row', (table) => {
    const record = SAMPLES[table];
    const row = toRow(table, record);
    expect(Object.keys(row).every((k) => k === k.toLowerCase())).toBe(true);
    // Simulate what the server returns: sync columns plus Postgres-style timestamps.
    const serverRow = {
      ...row,
      user_id: '00000000-0000-0000-0000-000000000001',
      revision: 3,
      deleted: false,
      server_updated_at: '2026-01-01T00:00:01.123456+00:00',
      created_at: '2026-01-01T00:00:00+00:00',
      updated_at: '2026-01-01T00:00:00+00:00',
    };
    expect(fromRow(table, serverRow)).toEqual(record);
  });

  it('keeps nullable fields as null and drops absent optional ones', () => {
    const t = fromRow<Record<string, unknown>>(
      'transactions',
      toRow('transactions', makeTxn({ accountId: 'a1', categoryId: null })),
    );
    expect(t.categoryId).toBeNull();
    expect('notes' in t).toBe(false);
    const s = fromRow<Record<string, unknown>>('settings', toRow('settings', makeSettings()));
    expect(s.paydayDayOfMonth).toBeNull();
  });

  it('rejects invalid server rows instead of storing them', () => {
    const row = { ...toRow('transactions', makeTxn({ accountId: 'a1' })), amount_cents: 0 };
    expect(() => fromRow('transactions', row)).toThrow(/invalid/);
  });

  it('compares content ignoring bookkeeping timestamps', () => {
    const a = makeAccount({ id: 'x', updatedAt: '2026-01-01T00:00:00.000Z' });
    expect(sameContent('accounts', a, { ...a, updatedAt: '2026-02-01T00:00:00.000Z' })).toBe(true);
    expect(sameContent('accounts', a, { ...a, name: 'Other' })).toBe(false);
    expect(sameContent('accounts', null, null)).toBe(true);
    expect(sameContent('accounts', a, null)).toBe(false);
  });
});
