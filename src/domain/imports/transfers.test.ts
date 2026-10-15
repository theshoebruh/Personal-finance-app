import { makeAccount, makeTransfer, makeTxn } from '@/test/factories';
import { isStrongTransfer, suggestTransfers } from './transfers';

const main = makeAccount({ id: 'main', name: 'Capitec main' });
const savings = makeAccount({
  id: 'sav',
  name: 'Savings',
  type: 'savings',
  includeInSpendable: false,
});
const biz = makeAccount({ id: 'biz', name: 'Business account', workspace: 'business' });
const row = (date: string, amountCents: number, description = 'Card purchase') => ({
  date,
  amountCents,
  description,
});

describe('transfer suggestions', () => {
  it('pairs with the opposite amount in another account within 3 days', () => {
    const income = makeTxn({
      accountId: savings.id,
      amountCents: 216_000,
      date: '2026-03-06',
      description: 'Deposit',
    });
    const [s] = suggestTransfers([row('2026-03-05', -216_000)], main, [main, savings], [income]);
    expect(s).toMatchObject({
      strength: 'paired',
      otherAccountId: 'sav',
      counterpart: { transactionId: income.id },
    });
    expect(isStrongTransfer(s)).toBe(true);
  });

  it('completes a transfer leg that has no partner yet, before pairing ordinary rows', () => {
    const [legOut] = makeTransfer(savings, main, 50_000, '2026-03-04');
    const lone = { ...legOut!, accountId: savings.id }; // only the savings side exists
    const plain = makeTxn({ accountId: savings.id, amountCents: -50_000, date: '2026-03-05' });
    const [s] = suggestTransfers([row('2026-03-05', 50_000)], main, [main, savings], [lone, plain]);
    expect(s).toMatchObject({
      strength: 'half_recorded',
      counterpart: { transferId: lone.transferId },
    });
  });

  it('ignores amounts that differ, dates more than 3 days apart, the same account and complete transfers', () => {
    const accounts = [main, savings];
    const off = [
      makeTxn({ accountId: savings.id, amountCents: 216_001, date: '2026-03-05' }),
      makeTxn({ accountId: savings.id, amountCents: 216_000, date: '2026-03-09' }),
      makeTxn({ accountId: main.id, amountCents: 216_000, date: '2026-03-05' }),
      makeTxn({ accountId: savings.id, amountCents: 216_000, date: '2026-03-05', archived: true }),
      ...makeTransfer(main, savings, 216_000, '2026-03-05'),
    ];
    expect(suggestTransfers([row('2026-03-05', -216_000)], main, accounts, off)).toEqual([null]);
  });

  it('offers each counterpart to one row only (the first matching row)', () => {
    const income = makeTxn({ accountId: savings.id, amountCents: 10_000, date: '2026-03-05' });
    const r = suggestTransfers(
      [row('2026-03-03', -10_000), row('2026-03-05', -10_000)],
      main,
      [main, savings],
      [income],
    );
    expect(r[0]).toMatchObject({ strength: 'paired' });
    expect(r[1]).toBeNull();
  });

  it('flags transfer wording or an account name as a weak suggestion', () => {
    const [a, b, c] = suggestTransfers(
      [
        row('2026-03-05', -5_000, 'TRANSFER TO POCKET'),
        row('2026-03-05', -5_000, 'PAYMENT TO BUSINESS ACCOUNT'),
        row('2026-03-05', -5_000, 'WOOLWORTHS'),
      ],
      main,
      [main, savings, biz],
      [],
    );
    expect(a).toEqual({ strength: 'wording', otherAccountId: 'sav' }); // the one savings account
    expect(b).toEqual({ strength: 'wording', otherAccountId: 'biz' }); // named account
    expect(c).toBeNull();
    expect(isStrongTransfer(a)).toBe(false);
  });

  it('skips rows that are not candidates', () => {
    expect(suggestTransfers([null], main, [main, savings], [])).toEqual([null]);
  });
});
