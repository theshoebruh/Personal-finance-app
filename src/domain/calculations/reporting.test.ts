import { makeAccount, makeTransfer, makeTxn } from '@/test/factories';
import { accountBalance, pendingTotal, reconciliationStatus } from './balances';
import { spendingByCategory, summariseIncomeExpenses } from './reporting';

const personal = makeAccount({ name: 'Capitec main', openingBalanceCents: 500_000 });
const savings = makeAccount({ name: 'Savings', type: 'savings', includeInSpendable: false });
const business = makeAccount({ name: 'Business', workspace: 'business' });

describe('balances', () => {
  it('adds actual transactions on/after the opening date to the opening balance', () => {
    const txns = [
      makeTxn({ accountId: personal.id, amountCents: -10_000, date: '2026-03-01' }),
      makeTxn({ accountId: personal.id, amountCents: -99_999, date: '2025-12-31' }), // before opening
      makeTxn({ accountId: personal.id, amountCents: -20_000, status: 'pending' }),
      makeTxn({ accountId: personal.id, amountCents: -30_000, status: 'excluded' }),
      makeTxn({ accountId: personal.id, amountCents: -40_000, archived: true }),
      makeTxn({ accountId: personal.id, amountCents: -5_000, status: 'needs_review' }),
    ];
    expect(accountBalance(personal, txns)).toBe(500_000 - 10_000 - 5_000);
    expect(pendingTotal(personal, txns)).toBe(-20_000);
  });

  it('reports a reconciliation discrepancy', () => {
    const acc = { ...personal, reconciledBalanceCents: 480_000, reconciledDate: '2026-03-31' };
    const txns = [makeTxn({ accountId: acc.id, amountCents: -10_000, date: '2026-03-15' })];
    expect(reconciliationStatus(acc, txns)).toMatchObject({
      calculatedBalanceCents: 490_000,
      discrepancyCents: 10_000,
    });
    expect(reconciliationStatus(personal, txns)).toBeNull();
  });
});

describe('income vs expenses', () => {
  const salary = makeTxn({ accountId: personal.id, amountCents: 1_200_000, type: 'income' });
  const groceries = makeTxn({
    accountId: personal.id,
    amountCents: -150_000,
    categoryId: 'cat-groceries',
  });
  const refund = makeTxn({
    accountId: personal.id,
    amountCents: 20_000,
    type: 'refund',
    categoryId: 'cat-groceries',
  });
  const toSavings = makeTransfer(personal, savings, 216_000);
  const ownerContribution = makeTransfer(
    personal,
    business,
    50_000,
    '2026-03-10',
    'owner_contribution',
  );
  const bizSale = makeTxn({
    accountId: business.id,
    workspace: 'business',
    amountCents: 80_000,
    type: 'income',
  });
  const all = [salary, groceries, refund, ...toSavings, ...ownerContribution, bizSale];

  it('excludes transfers (incl. savings and personal↔business) from consolidated totals', () => {
    const s = summariseIncomeExpenses(all, 'combined', '2026-03-01', '2026-03-31');
    expect(s.incomeCents).toBe(1_280_000);
    expect(s.expenseCents).toBe(150_000);
    expect(s.refundCents).toBe(20_000);
    expect(s.netExpenseCents).toBe(130_000);
    expect(s.transferLegsExcluded).toBe(4);
    expect(s.ownerContributionCents).toBe(0);
  });

  it('shows owner contributions separately in workspace views', () => {
    const biz = summariseIncomeExpenses(all, 'business', '2026-03-01', '2026-03-31');
    expect(biz.incomeCents).toBe(80_000);
    expect(biz.expenseCents).toBe(0);
    expect(biz.ownerContributionCents).toBe(50_000);
    const pers = summariseIncomeExpenses(all, 'personal', '2026-03-01', '2026-03-31');
    expect(pers.incomeCents).toBe(1_200_000);
    expect(pers.expenseCents).toBe(150_000);
    expect(pers.ownerContributionCents).toBe(50_000);
  });

  it('nets refunds against category spending', () => {
    expect(
      spendingByCategory(all, 'personal', '2026-03-01', '2026-03-31').get('cat-groceries'),
    ).toBe(130_000);
  });
});
