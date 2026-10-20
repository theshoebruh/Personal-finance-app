import { makeAccount, makeCategory, makeSettings, makeTransfer, makeTxn } from '@/test/factories';
import type { CategoryGroup } from '@/domain/models';
import { bucketSummary, bucketTargets } from './buckets';

const main = makeAccount({ id: 'main' });
const sevenDay = makeAccount({ id: 'seven', type: 'savings', includeInSpendable: false });
const cat = (id: string, group: CategoryGroup, kind = 'expense') =>
  makeCategory({ id, name: id, group, kind: kind as 'income' | 'expense', workspace: 'both' });
const categories = [
  cat('salary', 'income', 'income'),
  cat('side', 'income', 'income'),
  cat('electricity', 'essential'),
  cat('petrol', 'essential'),
  cat('snacks', 'discretionary'),
  cat('subs', 'discretionary'),
  cat('savings', 'savings'),
  cat('prints', 'business_expense'),
];
const income = (cents: number, categoryId: string) =>
  makeTxn({
    accountId: main.id,
    type: 'income',
    amountCents: cents,
    date: '2026-03-02',
    categoryId,
  });
const spend = (cents: number, categoryId: string | null, date = '2026-03-05') =>
  makeTxn({ accountId: main.id, amountCents: -cents, date, categoryId });

describe('five-group summary', () => {
  const settings = makeSettings({ savingsRatePercent: 20 });

  it('totals each group, its share of income, target and what is left', () => {
    const s = bucketSummary({
      settings,
      categories,
      accounts: [main, sevenDay],
      start: '2026-03-01',
      end: '2026-03-31',
      transactions: [
        income(900_000, 'salary'),
        income(100_000, 'side'),
        spend(300_000, 'electricity'),
        spend(150_000, 'petrol'),
        spend(200_000, 'snacks'),
        spend(50_000, 'subs'),
        spend(150_000, 'savings'),
        spend(40_000, 'prints'),
        spend(10_000, null),
        makeTxn({
          accountId: main.id,
          type: 'refund',
          amountCents: 20_000,
          date: '2026-03-06',
          categoryId: 'snacks',
        }),
        ...makeTransfer(main, sevenDay, 50_000, '2026-03-07'),
        spend(99_999, 'snacks', '2026-04-01'), // next period
      ],
    });
    expect(s.incomeCents).toBe(1_000_000);
    expect(s.incomeByCategory.map((c) => [c.name, c.cents])).toEqual([
      ['salary', 900_000],
      ['side', 100_000],
    ]);
    const line = (b: string) => s.lines.find((l) => l.bucket === b)!;
    expect(line('needs')).toMatchObject({
      actualCents: 450_000,
      targetPercent: 50,
      targetCents: 500_000,
      actualPercent: 45,
      leftCents: 50_000,
    });
    expect(line('needs').categories.map((c) => c.name)).toEqual(['electricity', 'petrol']);
    // Refund reduces Wants: 200k + 50k − 20k.
    expect(line('wants')).toMatchObject({
      actualCents: 230_000,
      targetCents: 200_000,
      leftCents: -30_000,
    });
    // Savings category + transfer into the 7-day account.
    expect(line('savings')).toMatchObject({ actualCents: 200_000, leftCents: 0 });
    expect(s.savingsTransfersCents).toBe(50_000);
    expect(line('rf')).toMatchObject({
      actualCents: 40_000,
      targetCents: 50_000,
      leftCents: 10_000,
    });
    expect(s.uncategorisedCents).toBe(10_000);
    // 450 + 230 + 200 + 40 + 10 = 930k spent; 70k left = Buffer.
    expect(s.expenseCents).toBe(930_000);
    expect(s.leftCents).toBe(70_000);
    expect(line('buffer')).toMatchObject({
      actualCents: 70_000,
      targetCents: 50_000,
      actualPercent: 7,
      leftCents: 20_000,
    });
    expect(s.targetTotalPercent).toBe(100);
  });

  it('handles a period with no income yet and overspending', () => {
    const s = bucketSummary({
      settings,
      categories,
      accounts: [main],
      start: '2026-03-01',
      end: '2026-03-31',
      transactions: [spend(5_000, 'snacks')],
    });
    expect(s.lines.find((l) => l.bucket === 'wants')).toMatchObject({
      actualCents: 5_000,
      actualPercent: null,
      targetCents: 0,
      leftCents: -5_000,
    });
    expect(s.leftCents).toBe(-5_000);
  });

  it('uses saved targets and defaults for unset ones', () => {
    expect(bucketTargets(makeSettings({ savingsRatePercent: 15, needsPercent: 55 }))).toEqual({
      needs: 55,
      wants: 20,
      savings: 15,
      rf: 5,
      buffer: 5,
    });
  });
});
