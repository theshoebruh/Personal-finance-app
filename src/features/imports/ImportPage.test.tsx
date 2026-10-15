import Dexie from 'dexie';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '@/app/App';
import { FinanceDb } from '@/data/local-db/db';
import { createDexieStore } from '@/data/repositories/dexieStore';
import type { FinanceStore } from '@/data/repositories/types';
import { createAccount } from '@/services/accountsService';
import { ensureInitialised } from '@/services/settingsService';

let n = 0;
let db: FinanceDb;
let store: FinanceStore;

const CSV = `Date,Description,Amount
2026-03-01,SALARY,12000.00
2026-03-02,COFFEE,-35.00
2026-03-02,COFFEE,-35.00
bad,BROKEN,1
`;

beforeEach(async () => {
  db = new FinanceDb(`import-ui-${++n}`);
  store = createDexieStore(db);
  await ensureInitialised(store);
  await createAccount(store, {
    name: 'Capitec main',
    type: 'current',
    workspace: 'personal',
    openingBalanceCents: 0,
    openingBalanceDate: '2026-03-01',
    includeInSpendable: true,
  });
});

afterEach(async () => {
  db.close();
  await Dexie.delete(db.name);
});

it('imports a CSV after review and can undo it', async () => {
  const user = userEvent.setup({ delay: null });
  render(<App db={db} store={store} initialPath="/import" />);
  await user.selectOptions(await screen.findByLabelText('Account'), 'Capitec main');
  await user.upload(
    screen.getByLabelText('Statement file (.csv)'),
    new File([CSV], 'march.csv', { type: 'text/csv' }),
  );

  const review = await screen.findByRole('region', { name: /review and import/i });
  expect(within(review).getByText(/Identical to line 3/)).toBeInTheDocument();
  expect(within(review).getByText(/Unreadable date "bad"/)).toBeInTheDocument();
  expect(within(review).getByRole('checkbox', { name: /Import line 5/ })).toBeDisabled();

  // Untick one of the identical coffees.
  await user.click(within(review).getByRole('checkbox', { name: /Import line 4/ }));
  await user.click(within(review).getByRole('button', { name: 'Import 2 transactions' }));
  expect(await screen.findByText(/Imported 2 transactions\. They’re marked/)).toBeInTheDocument();
  await waitFor(async () => expect(await store.transactions.list()).toHaveLength(2));

  const history = screen.getByRole('region', { name: 'Import history' });
  expect(await within(history).findByText('march.csv')).toBeInTheDocument();
  expect(within(history).getByText('1 skipped')).toBeInTheDocument();

  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
  await user.click(within(history).getByRole('button', { name: 'Undo import' }));
  await waitFor(async () => expect(await store.transactions.list()).toHaveLength(0));
  expect(await within(history).findByText('Undone')).toBeInTheDocument();
  confirm.mockRestore();
});

it('explains that Excel workbooks must be saved as CSV', async () => {
  const user = userEvent.setup({ delay: null });
  render(<App db={db} store={store} initialPath="/import" />);
  await user.selectOptions(await screen.findByLabelText('Account'), 'Capitec main');
  await user.upload(
    screen.getByLabelText('Statement file (.csv)'),
    new File(['x'], 'statement.xlsx', { type: 'text/csv' }),
  );
  expect(await screen.findByText(/Save As → “CSV UTF-8”/)).toBeInTheDocument();
});
