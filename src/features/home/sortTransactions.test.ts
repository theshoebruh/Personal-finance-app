import { makeTxn } from '@/test/factories';
import { isTransactionSort, sortTransactions } from './sortTransactions';

const t = (description: string, cents: number, date: string, categoryId: string) =>
  makeTxn({ accountId: 'a', description, amountCents: -cents, date, categoryId });
const txns = [
  t('Uber Eats', 77_770, '2026-10-12', 'eat'),
  t('YouTube', 8_199, '2026-10-16', 'subs'),
  t('Coffee', 5_000, '2026-10-13', 'eat'),
  t('ChatGPT', 14_900, '2026-10-23', 'subs'),
];
const names: Record<string, string> = { eat: 'Eating out', subs: 'Subscriptions' };
const order = (sort: Parameters<typeof sortTransactions>[1]) =>
  sortTransactions(txns, sort, (id) => (id ? names[id]! : '')).map((x) => x.description);

describe('sorting a group’s transactions', () => {
  it('sorts by date, amount, category and name', () => {
    expect(order('newest')).toEqual(['ChatGPT', 'YouTube', 'Coffee', 'Uber Eats']);
    expect(order('oldest')).toEqual(['Uber Eats', 'Coffee', 'YouTube', 'ChatGPT']);
    expect(order('largest')).toEqual(['Uber Eats', 'ChatGPT', 'YouTube', 'Coffee']);
    expect(order('smallest')).toEqual(['Coffee', 'YouTube', 'ChatGPT', 'Uber Eats']);
    // Within a category, newest first.
    expect(order('category')).toEqual(['Coffee', 'Uber Eats', 'ChatGPT', 'YouTube']);
    expect(order('name')).toEqual(['ChatGPT', 'Coffee', 'Uber Eats', 'YouTube']);
  });

  it('does not change the original list, and recognises valid choices', () => {
    order('largest');
    expect(txns[0]!.description).toBe('Uber Eats');
    expect(isTransactionSort('largest')).toBe(true);
    expect(isTransactionSort('nonsense')).toBe(false);
  });
});
