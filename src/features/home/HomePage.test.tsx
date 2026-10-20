import Dexie from 'dexie';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '@/app/App';
import { FinanceDb } from '@/data/local-db/db';
import { createDexieStore } from '@/data/repositories/dexieStore';
import type { FinanceStore } from '@/data/repositories/types';
import { todayInAppZone } from '@/domain/dates';
import { createAccount } from '@/services/accountsService';
import { ensureInitialised } from '@/services/settingsService';
import { createTransaction } from '@/services/transactionsService';

let n = 0;
let db: FinanceDb;
let store: FinanceStore;

beforeEach(async () => {
  db = new FinanceDb(`home-ui-${++n}`);
  store = createDexieStore(db);
  await ensureInitialised(store);
  const today = todayInAppZone();
  const acc = await createAccount(store, {
    name: 'Main',
    type: 'current',
    workspace: 'personal',
    openingBalanceCents: 0,
    openingBalanceDate: today,
    includeInSpendable: true,
  });
  const add = (
    description: string,
    cents: number,
    type: 'income' | 'expense',
    categoryId: string,
  ) =>
    createTransaction(store, {
      accountId: acc.id,
      date: today,
      description,
      amountCents: cents,
      type,
      categoryId,
    });
  await add('Salary', 1_000_000, 'income', 'cat-salary');
  await add('Prepaid electricity', 200_000, 'expense', 'cat-utilities');
  await add('Spar snacks', 300_000, 'expense', 'cat-snacks');
});
afterEach(async () => {
  db.close();
  await Dexie.delete(db.name);
});

it('shows income, spending, what is left and the five groups', async () => {
  render(<App db={db} store={store} initialPath="/" />);
  const hero = (await screen.findByText('Left this period')).closest('section')!;
  await waitFor(() => expect(hero.querySelector('.hero-amount')).toHaveTextContent('5 000,00'));
  const wants = await screen.findByRole('link', { name: /Wants/ });
  // R3,000 of a R2,000 goal (20% of R10,000).
  expect(within(wants).getByText(/over/)).toHaveTextContent('1 000,00');
  expect(within(wants).getByText('30%')).toBeInTheDocument();
  const needs = screen.getByRole('link', { name: /Needs/ });
  expect(within(needs).getByText(/left/)).toHaveTextContent('3 000,00');
  expect(screen.getByRole('link', { name: /Buffer/ })).toBeInTheDocument();
});

it('opens a group and moves a transaction to another category', async () => {
  const user = userEvent.setup({ delay: null });
  render(<App db={db} store={store} initialPath="/group/wants" />);
  expect(await screen.findByRole('heading', { level: 1, name: 'Wants' })).toBeInTheDocument();
  const select = await screen.findByLabelText('Category for Spar snacks');
  await user.selectOptions(select, 'cat-groceries');
  await waitFor(async () =>
    expect(
      (await store.transactions.list()).find((t) => t.description === 'Spar snacks')?.categoryId,
    ).toBe('cat-groceries'),
  );
  expect(await screen.findByText(/Nothing in Wants yet/)).toBeInTheDocument();
});

it('edits group goals on the Categories page', async () => {
  const user = userEvent.setup({ delay: null });
  render(<App db={db} store={store} initialPath="/categories" />);
  const needs = await screen.findByLabelText('Needs goal (% of income)');
  await user.clear(needs);
  await user.type(needs, '60');
  expect(screen.getByText(/Total 110%/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Save goals' })).toBeDisabled();
  const wants = screen.getByLabelText('Wants goal (% of income)');
  await user.clear(wants);
  await user.type(wants, '10');
  await user.click(screen.getByRole('button', { name: 'Save goals' }));
  expect(await screen.findByText('Goals saved')).toBeInTheDocument();
});
