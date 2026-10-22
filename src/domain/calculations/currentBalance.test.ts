import { makeAccount, makeTxn } from '@/test/factories';
import { currentBalance } from './balances';

describe('current balance', () => {
  // Made-up figures: R100 carried over, R1,000 in, R900 out, R149 still pending.
  const main = makeAccount({
    id: 'main',
    openingBalanceCents: 10_000,
    openingBalanceDate: '2026-03-01',
  });
  const savings = makeAccount({
    id: 'sav',
    type: 'savings',
    includeInSpendable: false,
    openingBalanceCents: 500_000,
    openingBalanceDate: '2026-03-01',
  });
  const old = makeAccount({ id: 'old', active: false, openingBalanceCents: 99_999 });
  const txns = [
    makeTxn({ accountId: 'main', type: 'income', amountCents: 100_000, date: '2026-03-01' }),
    makeTxn({ accountId: 'main', amountCents: -90_000, date: '2026-03-02' }),
    makeTxn({ accountId: 'main', amountCents: -14_900, date: '2026-03-03', status: 'pending' }),
    makeTxn({ accountId: 'sav', type: 'income', amountCents: 1_000, date: '2026-03-02' }),
  ];

  it('shows the posted balance like a bank, and what is left after pending payments', () => {
    expect(currentBalance([main, savings, old], txns)).toEqual({
      postedCents: 20_000,
      pendingCents: -14_900,
      afterPendingCents: 5_100,
      accountCount: 1,
    });
  });
});
