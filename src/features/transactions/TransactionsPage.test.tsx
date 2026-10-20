import Dexie from 'dexie';
import { render, screen, within } from '@testing-library/react';
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
  db = new FinanceDb(`activity-ui-${++n}`);
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
  const add = (description: string, type: 'income' | 'expense') =>
    createTransaction(store, {
      accountId: acc.id,
      date: today,
      description,
      amountCents: 18_000,
      type,
      categoryId: null,
      status: 'needs_review',
    });
  await add('Print shop', 'expense');
  await add('Payment from a friend', 'income');
});
afterEach(async () => {
  db.close();
  await Dexie.delete(db.name);
});

const optionLabels = (select: HTMLElement) =>
  [...select.querySelectorAll('option')].map((o) => o.textContent);
const groupLabels = (select: HTMLElement) =>
  [...select.querySelectorAll('optgroup')].map((g) => g.label);

it('offers only categories that fit the selected transactions', async () => {
  const user = userEvent.setup({ delay: null });
  render(<App db={db} store={store} initialPath="/transactions" />);
  await user.click(await screen.findByRole('checkbox', { name: /Print shop/ }));
  let bulk = screen.getByLabelText('Category for selected');
  // Personal spending: the personal RF categories, not the business-only ones.
  expect(optionLabels(bulk)).toContain('Stock & printing');
  expect(optionLabels(bulk)).not.toContain('Stock & materials');
  expect(groupLabels(bulk)).not.toContain('Income');

  await user.click(screen.getByRole('checkbox', { name: /Print shop/ }));
  await user.click(screen.getByRole('checkbox', { name: /Payment from a friend/ }));
  bulk = screen.getByLabelText('Category for selected');
  expect(groupLabels(bulk)).toEqual(['Income']);

  await user.selectOptions(bulk, 'cat-side-income');
  await user.click(screen.getByRole('button', { name: 'Apply' }));
  expect(await screen.findByText('Updated 1 transaction')).toBeInTheDocument();
});

it('explains the real reason when a mixed selection can’t take a category', async () => {
  const user = userEvent.setup({ delay: null });
  render(<App db={db} store={store} initialPath="/transactions" />);
  await user.click(await screen.findByRole('checkbox', { name: /Print shop/ }));
  await user.click(screen.getByRole('checkbox', { name: /Payment from a friend/ }));
  const panel = screen.getByRole('region', { name: 'Bulk actions' });
  expect(within(panel).getByText(/selected income and spending together/)).toBeInTheDocument();
  expect(groupLabels(within(panel).getByLabelText('Category for selected'))).toEqual([]);
});
