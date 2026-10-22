import { makeAccount, makeCategory, makeTransfer, makeTxn } from '@/test/factories';
import type { BudgetGroup, CategoryGroup } from '@/domain/models';
import { GROUP_IDS, defaultBudgetGroups } from '@/domain/defaults';
import { groupIdForCategory, groupSummary } from './buckets';

const TS = '2026-01-01T00:00:00.000Z';
const main = makeAccount({ id: 'main' });
const sevenDay = makeAccount({ id: 'seven', type: 'savings', includeInSpendable: false });
const cat = (
  id: string,
  group: CategoryGroup,
  kind: 'income' | 'expense' = 'expense',
  budgetGroupId?: string | null,
) =>
  makeCategory({
    id,
    name: id,
    group,
    kind,
    workspace: 'both',
    ...(budgetGroupId !== undefined ? { budgetGroupId } : {}),
  });
const business: BudgetGroup = {
  id: 'grp-biz',
  name: 'Business',
  kind: 'spending',
  colour: 6,
  targetPercent: 5,
  sortOrder: 3,
  isDemo: false,
  createdAt: TS,
  updatedAt: TS,
};
// Needs 50 / Wants 20 / Savings 20 / Business 5 / Buffer 5.
const groups = [
  ...defaultBudgetGroups(TS, { needs: 50, wants: 20, savings: 20, buffer: 5 }),
  business,
];
const categories = [
  cat('salary', 'income', 'income'),
  cat('side', 'income', 'income'),
  cat('from-savings', 'savings', 'income'),
  cat('electricity', 'essential'),
  cat('petrol', 'essential'),
  cat('snacks', 'discretionary'),
  cat('subs', 'discretionary'),
  cat('savings', 'savings'),
  cat('prints', 'discretionary', 'expense', 'grp-biz'), // moved into a custom group
];
const income = (cents: number, categoryId: string, date = '2026-03-02') =>
  makeTxn({ accountId: main.id, type: 'income', amountCents: cents, date, categoryId });
const spend = (cents: number, categoryId: string | null, date = '2026-03-05') =>
  makeTxn({ accountId: main.id, amountCents: -cents, date, categoryId });
const summary = (transactions: ReturnType<typeof makeTxn>[], accounts = [main, sevenDay]) =>
  groupSummary({
    groups,
    categories,
    accounts,
    transactions,
    start: '2026-03-01',
    end: '2026-03-31',
  });
const line = (s: ReturnType<typeof summary>, id: string) => s.lines.find((l) => l.group.id === id)!;

describe('groups summary', () => {
  it('totals each group (built-in and custom), its share of income, goal and what is left', () => {
    const s = summary([
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
    ]);
    expect(s.incomeCents).toBe(1_000_000);
    expect(s.lines.map((l) => l.group.name)).toEqual([
      'Needs',
      'Wants',
      'Savings',
      'Business',
      'Buffer',
    ]);
    expect(line(s, GROUP_IDS.needs)).toMatchObject({
      actualCents: 450_000,
      targetCents: 500_000,
      actualPercent: 45,
      leftCents: 50_000,
    });
    expect(line(s, GROUP_IDS.wants)).toMatchObject({ actualCents: 230_000, leftCents: -30_000 });
    expect(line(s, GROUP_IDS.savings)).toMatchObject({ actualCents: 200_000, leftCents: 0 });
    expect(line(s, 'grp-biz')).toMatchObject({ actualCents: 40_000, targetCents: 50_000 });
    expect(s.uncategorisedCents).toBe(10_000);
    expect(s.expenseCents).toBe(930_000);
    expect(line(s, GROUP_IDS.buffer)).toMatchObject({ actualCents: 70_000, actualPercent: 7 });
    expect(s.targetTotalPercent).toBe(100);
  });

  it('treats a transfer back from savings as savings coming back, not income', () => {
    const s = summary([
      income(1_200_000, 'salary', '2026-03-01'),
      spend(240_000, 'savings'),
      income(100_000, 'from-savings', '2026-03-20'),
    ]);
    expect(s.incomeCents).toBe(1_200_000);
    expect(line(s, GROUP_IDS.savings).actualCents).toBe(140_000);
    expect(s.savingsWithdrawalsCents).toBe(100_000);
    // Left = income − (net) spending: the R1,000 back is in the account again.
    expect(s.leftCents).toBe(1_060_000);
    expect(line(s, GROUP_IDS.savings).categories).toEqual([
      { categoryId: 'savings', name: 'savings', cents: 240_000 },
      { categoryId: 'from-savings', name: 'from-savings', cents: -100_000 },
    ]);
  });

  it('counts a transfer from a savings account back into a spendable one the same way', () => {
    const s = summary([
      income(1_200_000, 'salary', '2026-03-01'),
      ...makeTransfer(main, sevenDay, 240_000, '2026-03-02'),
      ...makeTransfer(sevenDay, main, 100_000, '2026-03-20'),
    ]);
    expect(s.incomeCents).toBe(1_200_000);
    expect(line(s, GROUP_IDS.savings).actualCents).toBe(140_000);
    expect(s.savingsTransfersCents).toBe(240_000);
    expect(s.savingsWithdrawalsCents).toBe(100_000);
  });

  it('handles a period with no income yet and overspending', () => {
    const s = summary([spend(5_000, 'snacks')]);
    expect(line(s, GROUP_IDS.wants)).toMatchObject({
      actualCents: 5_000,
      actualPercent: null,
      targetCents: 0,
      leftCents: -5_000,
    });
    expect(s.leftCents).toBe(-5_000);
  });

  it('links older categories by their kind, and uses the chosen group when there is one', () => {
    const ids = new Set(groups.map((g) => g.id));
    expect(groupIdForCategory(cat('a', 'essential'), ids)).toBe(GROUP_IDS.needs);
    expect(groupIdForCategory(cat('b', 'essential', 'expense', 'grp-biz'), ids)).toBe('grp-biz');
    // A link to a group that no longer exists falls back; RF only if that group exists.
    expect(groupIdForCategory(cat('c', 'discretionary', 'expense', 'gone'), ids)).toBe(
      GROUP_IDS.wants,
    );
    expect(groupIdForCategory(cat('d', 'business_expense'), ids)).toBeNull();
  });
});
