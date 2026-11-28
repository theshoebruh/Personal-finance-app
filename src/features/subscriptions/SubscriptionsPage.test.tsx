import Dexie from 'dexie';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '@/app/App';
import { FinanceDb } from '@/data/local-db/db';
import { createDexieStore } from '@/data/repositories/dexieStore';
import type { FinanceStore } from '@/data/repositories/types';
import { addDays, todayInAppZone } from '@/domain/dates';
import { createAccount } from '@/services/accountsService';
import { ensureInitialised, updateSettings } from '@/services/settingsService';
import { createTransaction } from '@/services/transactionsService';

let n = 0;
let db: FinanceDb;
let store: FinanceStore;
const today = todayInAppZone();
// Calendar months keep the period predictable: the 1st to the end of the month.
const start = `${today.slice(0, 8)}01`;

beforeEach(async () => {
  db = new FinanceDb(`subs-ui-${++n}`);
  store = createDexieStore(db);
  await ensureInitialised(store);
  await updateSettings(store, { budgetPeriodMode: 'calendar_month' });
  const acc = await createAccount(store, {
    name: 'Main',
    type: 'current',
    workspace: 'personal',
    openingBalanceCents: 0,
    openingBalanceDate: addDays(start, -40),
    includeInSpendable: true,
  });
  const charge = (description: string, cents: number, date: string) =>
    createTransaction(store, {
      accountId: acc.id,
      date,
      description,
      amountCents: cents,
      type: 'expense',
      categoryId: 'cat-subscriptions',
    });
  await charge('Recurring Card Purchase: Openai Chatgpt (Card 1111)', 38_000, start);
  await charge('Recurring Card Purchase: Openai Chatgpt (Card 1111)', 38_000, addDays(start, -31));
});
afterEach(async () => {
  db.close();
  await Dexie.delete(db.name);
});

it('adds subscriptions found in transactions and shows whether they’re paid', async () => {
  const user = userEvent.setup({ delay: null });
  render(<App db={db} store={store} initialPath="/subscriptions" />);

  const found = (await screen.findByText('Found in your transactions')).closest('section')!;
  expect(within(found).getByText('Openai Chatgpt')).toBeInTheDocument();
  await user.click(within(found).getByRole('button', { name: 'Add Openai Chatgpt' }));
  expect(await screen.findByText('Openai Chatgpt added')).toBeInTheDocument();

  // Paid this period, counted as a Want (Subscriptions is in Wants).
  const list = screen.getByText('Your list').closest('section')!;
  const row = (await within(list).findByText('Openai Chatgpt')).closest('li')!;
  expect(within(row).getByText(/^Paid/)).toBeInTheDocument();
  expect(within(row).getByText('Wants')).toBeInTheDocument();
  expect(screen.queryByText('Found in your transactions')).not.toBeInTheDocument();
  const rules = await store.recurringRules.list();
  expect(rules).toHaveLength(1);
  expect(rules[0]).toMatchObject({
    frequency: 'monthly',
    amountCents: 38_000,
    categoryId: 'cat-subscriptions',
  });
});

it('adds a bill by hand, marks it paid and undoes that', async () => {
  const user = userEvent.setup({ delay: null });
  render(<App db={db} store={store} initialPath="/subscriptions" />);
  const list = (await screen.findByText('Your list')).closest('section')!;
  await user.click(within(list).getByRole('button', { name: 'Add' }));
  await user.type(screen.getByLabelText('Name'), 'Rent');
  await user.type(screen.getByLabelText('Amount (R)'), '4500');
  const due = screen.getByLabelText('Date it goes off');
  await user.clear(due);
  await user.type(due, addDays(start, 1));
  await user.selectOptions(screen.getByLabelText('Category'), 'cat-housing');
  await user.click(screen.getByRole('button', { name: 'Add to list' }));
  expect(await screen.findByText('Rent added')).toBeInTheDocument();

  const row = (await within(list).findByText('Rent')).closest('li')!;
  expect(within(row).getByText(/Not seen yet|^Due/)).toBeInTheDocument();
  expect(within(row).getByText('Needs')).toBeInTheDocument();
  await user.click(within(row).getByRole('button', { name: 'Mark paid' }));
  expect(await within(row).findByText('Marked paid')).toBeInTheDocument();
  await user.click(within(row).getByRole('button', { name: 'Undo paid' }));
  await waitFor(() => expect(within(row).queryByText('Marked paid')).not.toBeInTheDocument());
});

it('shows a summary on Home once there are items', async () => {
  const user = userEvent.setup({ delay: null });
  render(<App db={db} store={store} initialPath="/subscriptions" />);
  await user.click(await screen.findByRole('button', { name: 'Add Openai Chatgpt' }));
  await screen.findByText('Openai Chatgpt added');
  await user.click(screen.getAllByRole('link', { name: /Home/ })[0]!);
  expect(
    await screen.findByRole('link', { name: /Subscriptions & bills.*1 of 1 paid/ }),
  ).toBeInTheDocument();
});
