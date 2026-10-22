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
