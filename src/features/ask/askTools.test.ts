import type { FinanceData } from '@/app/AppContext';
import { makeAccount, makeCategory, makeSettings, makeTransfer, makeTxn } from '@/test/factories';
import { defaultBudgetGroups } from '@/domain/defaults';
import { groupSummary } from '@/domain/calculations/buckets';
import { ASK_TOOLS, ASK_TOOL_NAMES } from '../../../supabase/functions/ask/tools';
import { AskToolError, cleanDescription, runAskTool } from './askTools';

const TS = '2026-01-01T00:00:00.000Z';
const main = makeAccount({ id: 'main' });
const saver = makeAccount({
  id: 'saver',
  name: 'Emergency Savings',
  type: 'savings',
  includeInSpendable: false,
});
const cat = (
  id: string,
  name: string,
  group: 'essential' | 'discretionary' | 'income',
  kind: 'income' | 'expense' = 'expense',
) => makeCategory({ id, name, group, kind, workspace: 'both' });
const categories = [
  cat('salary', 'Salary', 'income', 'income'),
  cat('groceries', 'Groceries', 'essential'),
  cat('eating', 'Eating out & takeaways', 'discretionary'),
];
const spend = (
  cents: number,
  categoryId: string,
  description: string,
  date = '2026-11-05',
  extra = {},
) => makeTxn({ accountId: main.id, amountCents: -cents, categoryId, description, date, ...extra });
const transactions = [
  makeTxn({
    accountId: main.id,
    type: 'income',
    amountCents: 1_200_000,
    categoryId: 'salary',
    date: '2026-11-01',
    description: 'Salary',
  }),
  spend(48_000, 'groceries', 'Pick n Pay Claremont (Card 1111)'),
  spend(12_050, 'groceries', 'PICK N PAY CLAREMONT (Card 1111)', '2026-11-08'),
  spend(9_000, 'eating', 'Uber Eats 123456789', '2026-11-09'),
  spend(5_000, 'eating', '(Pending) Steers', '2026-11-10', { status: 'pending' }),
  spend(99_999, 'eating', 'Last month', '2026-10-20'),
  ...makeTransfer(main, saver, 240_000, '2026-11-01'),
];
const data = {
  settings: makeSettings({ budgetPeriodMode: 'calendar_month' }),
  accounts: [main, saver],
  transactions,
  categories,
  budgetGroups: defaultBudgetGroups(TS),
  budgets: [],
  goals: [],
  goalContributions: [],
  recurringRules: [],
} as FinanceData;
const NOV = { start: '2026-11-01', end: '2026-11-30' };
const run = (name: string, input: unknown) =>
  JSON.parse(runAskTool(name, input, data, '2026-11-24'));

describe('Ask tools', () => {
  it('has a runner for every tool Claude is offered', () => {
    expect(ASK_TOOLS.map((t) => t.name)).toEqual(ASK_TOOL_NAMES);
    for (const name of ASK_TOOL_NAMES) {
      const input =
        name === 'monthly_totals' ? { months: 2 } : { ...NOV, limit: 5, contains: '', kind: 'all' };
      expect(() => runAskTool(name, input, data, '2026-11-24')).not.toThrow();
    }
  });

  it('removes card numbers and long digit runs from descriptions', () => {
    expect(cleanDescription('(Pending) Game Store (Card 1111)')).toBe('Game Store');
    expect(cleanDescription('Uber Eats 123456789')).toBe('Uber Eats …');
  });

  it('period summary matches the app’s own figures', () => {
    const s = groupSummary({ ...data, groups: data.budgetGroups, ...NOV });
    const r = run('period_summary', NOV);
    expect(r).toMatchObject({
      income: 12_000,
      spent: s.expenseCents / 100,
      left: s.leftCents / 100,
    });
    expect(r.pending_spending_included).toBe(50);
    expect(r.groups.find((g: { group: string }) => g.group === 'Needs')).toMatchObject({
      amount: 600.5,
      goal: 6000,
    });
  });

  it('spending by category includes money moved into savings, largest first', () => {
    const r = run('spending_by_category', NOV);
    expect(r.categories[0]).toEqual({
      category: 'Moved into savings accounts',
      group: 'Savings',
      amount: 2400,
    });
    expect(r.categories).toContainEqual({
      category: 'Groceries',
      group: 'Needs',
      amount: 600.5,
      transactions: 2,
    });
    expect(r.categories).toContainEqual({
      category: 'Eating out & takeaways',
      group: 'Wants',
      amount: 140,
      transactions: 2,
    });
    const sum = r.categories.reduce((s: number, c: { amount: number }) => s + c.amount, 0);
    expect(sum).toBeCloseTo(r.total_spent);
  });

  it('groups payees across spelling and card variants', () => {
    const r = run('top_payees', { ...NOV, limit: 1 });
    expect(r.payees).toEqual([{ payee: 'Pick n Pay Claremont', amount: 600.5, transactions: 2 }]);
    expect(r.payees_in_total).toBe(3);
    expect(JSON.stringify(run('top_payees', { ...NOV, limit: 25 }))).not.toMatch(/1111|123456789/);
  });

  it('lists matching transactions, largest first, within the period only', () => {
    const r = run('list_transactions', { ...NOV, contains: 'eating', kind: 'spending', limit: 10 });
    expect(r.matching).toBe(2);
    expect(r.transactions).toEqual([
      {
        date: '2026-11-09',
        description: 'Uber Eats …',
        category: 'Eating out & takeaways',
        amount: -90,
      },
      {
        date: '2026-11-10',
        description: 'Steers',
        category: 'Eating out & takeaways',
        amount: -50,
        pending: true,
      },
    ]);
    expect(
      run('list_transactions', { ...NOV, contains: '', kind: 'income', limit: 5 }).transactions,
    ).toHaveLength(1);
  });

  it('gives monthly totals oldest first', () => {
    const r = run('monthly_totals', { months: 2 });
    expect(r.months.map((m: { month: string }) => m.month)).toEqual(['2026-10', '2026-11']);
    expect(r.months[0]).toMatchObject({ income: 0, spent: 999.99 });
  });

  it('rejects bad dates and unknown tools', () => {
    expect(() =>
      runAskTool('period_summary', { start: 'Nov', end: '2026-11-30' }, data, '2026-11-24'),
    ).toThrow(AskToolError);
    expect(() =>
      runAskTool('period_summary', { start: '2026-12-01', end: '2026-11-30' }, data, '2026-11-24'),
    ).toThrow(AskToolError);
    expect(() => runAskTool('delete_everything', {}, data, '2026-11-24')).toThrow(AskToolError);
  });
});
