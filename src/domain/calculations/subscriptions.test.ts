import { makeCategory, makeTxn } from '@/test/factories';
import type { RecurringRule } from '@/domain/models';
import { payeeName } from '@/domain/text';
import { subscriptionRows, subscriptionTotals, suggestSubscriptions } from './subscriptions';

const TS = '2026-01-01T00:00:00.000Z';
const rule = (id: string, overrides: Partial<RecurringRule> = {}): RecurringRule => ({
  id,
  name: id,
  direction: 'expense',
  amountCents: 38_000,
  frequency: 'monthly',
  startDate: '2026-10-25',
  categoryId: 'cat-subs',
  workspace: 'personal',
  active: true,
  settledDates: [],
  matchWindowDays: 5,
  alertLeadDays: 3,
  isDemo: false,
  createdAt: TS,
  updatedAt: TS,
  ...overrides,
});
const charge = (cents: number, date: string, description: string, extra = {}) =>
  makeTxn({
    accountId: 'main',
    amountCents: -cents,
    date,
    description,
    categoryId: 'cat-subs',
    source: 'csv',
    ...extra,
  });
const PERIOD = { start: '2026-10-30', end: '2026-11-28' };
const TODAY = '2026-11-20';

describe('subscription status this period', () => {
  it('tells paid, pending, marked paid, due, not seen yet, not due and paused apart', () => {
    const rules = [
      rule('chatgpt', { startDate: '2026-10-05', amountCents: 38_000 }), // due 5 Nov, paid
      rule('netflix', { startDate: '2026-10-18', amountCents: 19_900 }), // due 18 Nov, pending
      rule('gym', {
        startDate: '2026-10-01',
        amountCents: 45_000,
        categoryId: 'cat-gym',
        settledDates: ['2026-11-01'],
      }),
      rule('spotify', { startDate: '2026-10-25', amountCents: 6_999 }), // due 25 Nov, later
      rule('icloud', { startDate: '2026-10-10', amountCents: 4_999 }), // due 10 Nov, nothing yet
      rule('domain', { startDate: '2026-03-01', frequency: 'yearly', amountCents: 25_000 }),
      rule('old', { active: false }),
    ];
    const txns = [
      charge(38_000, '2026-11-06', 'Recurring Card Purchase: Openai Chatgpt (Card 1111)'),
      charge(19_900, '2026-11-18', 'Netflix', { status: 'pending' }),
    ];
    const rows = subscriptionRows(rules, txns, PERIOD, TODAY);
    const state = (id: string) => rows.find((r) => r.rule.id === id)!;
    expect(state('chatgpt')).toMatchObject({ state: 'paid', dueDate: '2026-11-05' });
    expect(state('chatgpt').transaction?.date).toBe('2026-11-06');
    expect(state('netflix')).toMatchObject({ state: 'pending', dueDate: '2026-11-18' });
    expect(state('gym')).toMatchObject({ state: 'marked_paid', dueDate: '2026-11-01' });
    expect(state('spotify')).toMatchObject({ state: 'due', dueDate: '2026-11-25' });
    expect(state('icloud')).toMatchObject({ state: 'late', dueDate: '2026-11-10' });
    expect(state('domain')).toMatchObject({ state: 'not_due', nextDue: '2027-03-01' });
    expect(state('old').state).toBe('paused');

    expect(subscriptionTotals(rows)).toEqual({
      monthlyCents: 38_000 + 19_900 + 45_000 + 6_999 + 4_999 + Math.round(25_000 / 12),
      paidCents: 38_000 + 19_900 + 45_000,
      toComeCents: 6_999 + 4_999,
    });
  });

  it('ignores income items (salary) and payments too far off in amount', () => {
    const rows = subscriptionRows(
      [rule('chatgpt', { startDate: '2026-10-05' }), rule('salary', { direction: 'income' })],
      [charge(50_000, '2026-11-05', 'Openai')],
      PERIOD,
      TODAY,
    );
    expect(rows.map((r) => [r.rule.id, r.state])).toEqual([['chatgpt', 'late']]);
  });
});

describe('subscriptions found in transactions', () => {
  const categories = [
    makeCategory({ id: 'cat-subs', name: 'Subscriptions', kind: 'expense' }),
    makeCategory({ id: 'cat-food', name: 'Groceries', kind: 'expense' }),
  ];

  it('reads a payee name from a bank description', () => {
    expect(payeeName('Recurring Card Purchase: Openai Chatgpt Subscr (Card 1111)')).toBe(
      'Openai Chatgpt Subscr',
    );
    expect(payeeName('(Pending) Netflix.com 12345678')).toBe('Netflix.com');
  });

  it('suggests each subscription payee once, newest charge, skipping ones already listed', () => {
    const txns = [
      charge(38_000, '2026-10-06', 'Recurring Card Purchase: Openai Chatgpt (Card 1111)'),
      charge(38_500, '2026-11-06', 'Recurring Card Purchase: Openai Chatgpt (Card 1111)'),
      charge(19_900, '2026-11-18', 'Netflix', { status: 'pending' }),
      charge(6_999, '2026-11-02', 'Spotify'),
      charge(9_000, '2026-11-03', 'Pick n Pay', { categoryId: 'cat-food' }), // not a subscription
      charge(4_999, '2026-06-01', 'Old thing'), // too long ago
    ];
    const listed = [rule('Spotify Premium', { amountCents: 6_999, startDate: '2026-11-02' })];
    const s = suggestSubscriptions(listed, txns, categories, TODAY);
    expect(s).toEqual([
      {
        key: 'netflix',
        name: 'Netflix',
        amountCents: 19_900,
        categoryId: 'cat-subs',
        lastDate: '2026-11-18',
        count: 1,
      },
      {
        key: 'openai chatgpt',
        name: 'Openai Chatgpt',
        amountCents: 38_500,
        categoryId: 'cat-subs',
        lastDate: '2026-11-06',
        count: 2,
      },
    ]);
  });

  it('suggests nothing without a subscription category', () => {
    expect(
      suggestSubscriptions([], [charge(100, '2026-11-01', 'X')], [categories[1]!], TODAY),
    ).toEqual([]);
  });
});
