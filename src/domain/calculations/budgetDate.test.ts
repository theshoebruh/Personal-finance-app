import { makeTxn } from '@/test/factories';
import { asBudgeted, budgetDateOf, countsInEarlierPeriod, withBudgetDate } from './budgetDate';

describe('budget dates', () => {
  it('reads the date a transaction counts on, defaulting to its own', () => {
    const plain = makeTxn({ accountId: 'main', date: '2026-10-30', tags: ['pt:2026-10-30 08:58'] });
    expect(budgetDateOf(plain)).toBe('2026-10-30');
    expect(asBudgeted(plain)).toBe(plain);
    expect(countsInEarlierPeriod(plain)).toBe(false);

    const moved = { ...plain, tags: withBudgetDate(plain.tags, '2026-10-29') };
    expect(moved.tags).toEqual(['pt:2026-10-30 08:58', 'bd:2026-10-29']);
    expect(budgetDateOf(moved)).toBe('2026-10-29');
    expect(asBudgeted(moved)).toMatchObject({ date: '2026-10-29', tags: moved.tags });
    expect(countsInEarlierPeriod(moved)).toBe(true);
    expect(withBudgetDate(moved.tags, null)).toEqual(['pt:2026-10-30 08:58']);
  });

  it('ignores a malformed tag', () => {
    expect(
      budgetDateOf(makeTxn({ accountId: 'main', date: '2026-10-30', tags: ['bd:29/10/2026'] })),
    ).toBe('2026-10-30');
  });
});
