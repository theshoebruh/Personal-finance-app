import Dexie from 'dexie';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '@/app/App';
import { FinanceDb } from '@/data/local-db/db';
import { createDexieStore } from '@/data/repositories/dexieStore';
import type { FinanceStore } from '@/data/repositories/types';
import { ensureInitialised } from '@/services/settingsService';

let n = 0;
let db: FinanceDb;
let store: FinanceStore;

beforeEach(async () => {
  db = new FinanceDb(`categories-ui-${++n}`);
  store = createDexieStore(db);
  await ensureInitialised(store);
});
afterEach(async () => {
  db.close();
  await Dexie.delete(db.name);
});

it('adds a custom group with a goal and categories, then deletes it once empty', async () => {
  const user = userEvent.setup({ delay: null });
  render(<App db={db} store={store} initialPath="/categories" />);

  await user.type(await screen.findByLabelText('New group name'), 'Business');
  await user.click(screen.getByRole('button', { name: 'Add group' }));
  const goal = await screen.findByLabelText('Business goal (% of income)');
  expect(goal).toHaveValue('0');

  // Give Business 5% by taking it from Wants (30 → 25).
  await user.clear(goal);
  await user.type(goal, '5');
  const wants = screen.getByLabelText('Wants goal (% of income)');
  await user.clear(wants);
  await user.type(wants, '25');
  await user.click(screen.getByRole('button', { name: 'Save goals' }));
  expect(await screen.findByText('Goals saved')).toBeInTheDocument();

  await user.type(screen.getByLabelText('New Business category'), 'Prints');
  const card = screen.getByLabelText('New Business category').closest('section')!;
  await user.click(within(card).getByRole('button', { name: 'Add' }));
  expect(await within(card).findByRole('button', { name: 'Rename Prints' })).toBeInTheDocument();

  // Can't delete while it has a category; move it to Wants first.
  await user.click(within(card).getByRole('button', { name: 'Delete group Business' }));
  await user.click(await screen.findByRole('button', { name: 'Delete group' }));
  expect(await screen.findByText(/Move or hide Business’s 1 category first/)).toBeInTheDocument();
  await user.selectOptions(within(card).getByLabelText('Group for Prints'), 'grp-wants');

  await user.click(screen.getByRole('button', { name: 'Delete group Business' }));
  await user.click(await screen.findByRole('button', { name: 'Delete group' }));
  await waitFor(() =>
    expect(screen.queryByLabelText('Business goal (% of income)')).not.toBeInTheDocument(),
  );
  // Its 5% went to Buffer, so goals still add up to 100%.
  expect(screen.getByLabelText('Buffer goal (% of income)')).toHaveValue('10');
});

it('switches goals to Rand amounts and shows them on Home', async () => {
  const user = userEvent.setup({ delay: null });
  render(<App db={db} store={store} initialPath="/categories" />);
  await user.click(await screen.findByRole('button', { name: 'Rand amounts' }));
  expect(await screen.findByText('Goals are now Rand amounts')).toBeInTheDocument();

  // Filled in from the % goals and the R12 000 default salary.
  const needs = await screen.findByLabelText('Needs goal (Rand)');
  expect(needs).toHaveValue('6000.00');
  expect(screen.getByText(/matches your salary/)).toBeInTheDocument();
  await user.clear(needs);
  await user.type(needs, '4000');
  const wants = screen.getByLabelText('Wants goal (Rand)');
  await user.clear(wants);
  await user.type(wants, '2 000');
  await user.clear(screen.getByLabelText('Savings goal (Rand)'));
  expect(screen.getByText(/of your salary not planned/)).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Save goals' }));
  expect(await screen.findByText('Goals saved')).toBeInTheDocument();
  const g = new Map((await store.budgetGroups.list()).map((x) => [x.name, x.targetCents]));
  expect(g.get('Needs')).toBe(400_000);
  expect(g.get('Wants')).toBe(200_000);
  expect(g.get('Savings')).toBe(0);

  // A typo can't be saved.
  await user.clear(screen.getByLabelText('Savings goal (Rand)'));
  await user.type(screen.getByLabelText('Savings goal (Rand)'), 'abc');
  expect(screen.getByText('Check the amount for Savings')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Save goals' })).toBeDisabled();

  // Back to %: the percentages are as they were.
  await user.click(screen.getByRole('button', { name: '% of income' }));
  expect(await screen.findByLabelText('Needs goal (% of income)')).toHaveValue('50');
});
