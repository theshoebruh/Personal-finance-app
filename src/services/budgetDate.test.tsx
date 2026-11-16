import Dexie from 'dexie';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '@/app/App';
import { FinanceDb } from '@/data/local-db/db';
import { createDexieStore } from '@/data/repositories/dexieStore';
import type { FinanceStore } from '@/data/repositories/types';
import { addDays, todayInAppZone } from '@/domain/dates';
import { createAccount } from './accountsService';
import { ensureInitialised, updateSettings } from './settingsService';
import { createTransaction, createTransfer, setBudgetDate } from './transactionsService';

let n = 0;
let db: FinanceDb;
let store: FinanceStore;
let main: string;

beforeEach(async () => {
  db = new FinanceDb(`budget-date-${++n}`);
  store = createDexieStore(db);
  await ensureInitialised(store);
  main = (
    await createAccount(store, {
      name: 'Main',
      type: 'current',
      workspace: 'personal',
      openingBalanceCents: 0,
      openingBalanceDate: '2026-01-01',
      includeInSpendable: true,
    })
  ).id;
});
afterEach(async () => {
  db.close();
  await Dexie.delete(db.name);
});

describe('setBudgetDate', () => {
  it('moves a transaction to an earlier period and back, keeping its bank date', async () => {
    const t = await createTransaction(store, {
      accountId: main,
      date: '2026-10-30',
      description: 'Transfer to 7day Saving',
      amountCents: 246_177,
      type: 'expense',
      categoryId: 'cat-savings',
    });
    await setBudgetDate(store, t.id, '2026-10-29');
    expect(await store.transactions.get(t.id)).toMatchObject({
      date: '2026-10-30',
      tags: ['bd:2026-10-29'],
    });
    await setBudgetDate(store, t.id, null);
    expect((await store.transactions.get(t.id))?.tags).toEqual([]);
    await expect(setBudgetDate(store, t.id, '2026-10-30')).rejects.toThrow(/earlier period/);
  });

  it('moves both legs of a transfer', async () => {
    const savings = await createAccount(store, {
      name: '7day',
      type: 'savings',
      workspace: 'personal',
      openingBalanceCents: 0,
      openingBalanceDate: '2026-01-01',
      includeInSpendable: false,
    });
    const [out, into] = await createTransfer(store, {
      fromAccountId: main,
      toAccountId: savings.id,
      date: '2026-10-30',
      amountCents: 100_000,
    });
    await setBudgetDate(store, out.id, '2026-10-29');
    expect((await store.transactions.get(into.id))?.tags).toEqual(['bd:2026-10-29']);
  });
});

it('marks a savings transfer as last period’s leftover from the Savings page', async () => {
  // Calendar months keep the period predictable: it starts on the 1st.
  await updateSettings(store, { budgetPeriodMode: 'calendar_month' });
  const today = todayInAppZone();
  const start = `${today.slice(0, 8)}01`;
  const add = (description: string, cents: number, type: 'income' | 'expense', cat: string) =>
    createTransaction(store, {
      accountId: main,
      date: start,
      description,
      amountCents: cents,
      type,
      categoryId: cat,
    });
  await add('Salary', 1_200_000, 'income', 'cat-salary');
  await add('Planned saving', 240_000, 'expense', 'cat-savings');
  const sweep = await add('Leftover sweep', 246_177, 'expense', 'cat-savings');

  const user = userEvent.setup({ delay: null });
  render(<App db={db} store={store} initialPath="/group/grp-savings" />);
  await user.click(
    await screen.findByRole('button', { name: 'Leftover sweep: from last period’s leftover' }),
  );
  expect(await screen.findByText(/now counts in last period/)).toBeInTheDocument();
  expect(await store.transactions.get(sweep.id)).toMatchObject({
    date: start,
    tags: [`bd:${addDays(start, -1)}`],
  });
  // Listed apart, and only the planned saving is counted.
  const undo = await screen.findByRole('button', { name: 'Count Leftover sweep in this period' });
  const facts = document.querySelector('.group-facts')!;
  expect(within(facts as HTMLElement).getByText(/2 400,00/)).toBeInTheDocument();

  await user.click(undo);
  expect(await screen.findByText(/counts in this period again/)).toBeInTheDocument();
  expect((await store.transactions.get(sweep.id))?.tags).toEqual([]);
});

it('lists transfers into a savings account on the Savings page, and can move them back', async () => {
  await updateSettings(store, { budgetPeriodMode: 'calendar_month' });
  const today = todayInAppZone();
  const start = `${today.slice(0, 8)}01`;
  const savings = await createAccount(store, {
    name: 'Emergency Savings',
    type: 'savings',
    workspace: 'personal',
    openingBalanceCents: 0,
    openingBalanceDate: '2026-01-01',
    includeInSpendable: false,
  });
  await createTransaction(store, {
    accountId: main,
    date: start,
    description: 'Salary',
    amountCents: 1_200_000,
    type: 'income',
    categoryId: 'cat-salary',
  });
  const move = (cents: number, description: string) =>
    createTransfer(store, {
      fromAccountId: main,
      toAccountId: savings.id,
      date: start,
      amountCents: cents,
      description,
    });
  await move(240_000, 'Planned saving');
  const [out, into] = await move(246_177, 'Leftover sweep');

  const user = userEvent.setup({ delay: null });
  render(<App db={db} store={store} initialPath="/group/grp-savings" />);
  const facts = (await screen.findByText('Status')).closest('dl') as HTMLElement;
  expect(await within(facts).findByText(/4 861,77/)).toBeInTheDocument();
  expect(screen.getAllByText('Moved to Emergency Savings')).toHaveLength(2);

  await user.click(
    await screen.findByRole('button', { name: 'Leftover sweep: from last period’s leftover' }),
  );
  expect(await screen.findByText(/now counts in last period/)).toBeInTheDocument();
  expect(await within(facts).findByText(/2 400,00/)).toBeInTheDocument();
  for (const leg of [out, into]) {
    expect((await store.transactions.get(leg.id))?.tags).toContain(`bd:${addDays(start, -1)}`);
  }
  expect(
    await screen.findByRole('button', { name: 'Count Leftover sweep in this period' }),
  ).toBeInTheDocument();
});
