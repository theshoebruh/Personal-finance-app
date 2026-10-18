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

type User = ReturnType<typeof userEvent.setup>;

/** Steps 1–2: choose the account and pick a file. */
async function chooseAccountAndFile(user: User, file: File, account = 'Capitec main') {
  await user.click(await screen.findByRole('radio', { name: new RegExp(account) }));
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  await user.upload(await screen.findByLabelText('Statement file (.csv)'), file);
}

/** Steps 1–3: through to the review step. */
async function goToReview(user: User, file: File, account?: string) {
  await chooseAccountAndFile(user, file, account);
  await user.click(await screen.findByRole('button', { name: 'Looks right' }));
  return screen.findByRole('region', { name: /review and import/i });
}

it('imports a CSV after review and can undo it', async () => {
  const user = userEvent.setup({ delay: null });
  render(<App db={db} store={store} initialPath="/import" />);
  const review = await goToReview(user, new File([CSV], 'march.csv', { type: 'text/csv' }));
  expect(within(review).getByText(/Identical to line 3/)).toBeInTheDocument();
  expect(within(review).getByText(/Unreadable date "bad"/)).toBeInTheDocument();
  expect(within(review).getByRole('checkbox', { name: /Import line 5/ })).toBeDisabled();

  // Untick one of the identical coffees.
  await user.click(within(review).getByRole('checkbox', { name: /Import line 4/ }));
  await user.click(within(review).getByRole('button', { name: 'Import 2 transactions' }));
  expect(
    await screen.findByRole('heading', { name: 'Imported 2 transactions' }),
  ).toBeInTheDocument();
  await waitFor(async () => expect(await store.transactions.list()).toHaveLength(2));

  const history = screen.getByRole('region', { name: 'Import history' });
  expect(await within(history).findByText('march.csv')).toBeInTheDocument();
  expect(within(history).getByText('1 skipped')).toBeInTheDocument();

  await user.click(within(history).getByRole('button', { name: 'Undo import' }));
  const dialog = await screen.findByRole('alertdialog', { name: /Undo import of march\.csv/ });
  await user.click(within(dialog).getByRole('button', { name: 'Undo import' }));
  await waitFor(async () => expect(await store.transactions.list()).toHaveLength(0));
  expect(await within(history).findByText('Undone')).toBeInTheDocument();
});

it('explains that Excel workbooks must be saved as CSV', async () => {
  const user = userEvent.setup({ delay: null });
  render(<App db={db} store={store} initialPath="/import" />);
  await chooseAccountAndFile(user, new File(['x'], 'statement.xlsx', { type: 'text/csv' }));
  expect(await screen.findByText(/Save As → “CSV UTF-8”/)).toBeInTheDocument();
});

it('suggests a transfer in review and imports it as one when chosen', async () => {
  const user = userEvent.setup({ delay: null });
  await createAccount(store, {
    name: 'Savings',
    type: 'savings',
    workspace: 'personal',
    openingBalanceCents: 0,
    openingBalanceDate: '2026-03-01',
    includeInSpendable: false,
  });
  render(<App db={db} store={store} initialPath="/import" />);
  const review = await goToReview(
    user,
    new File(['Date,Description,Amount\n2026-03-05,TRANSFER TO SAVINGS,-2160.00\n'], 'm.csv', {
      type: 'text/csv',
    }),
  );
  const list = within(review).getByRole('list', { name: 'Rows to import' });
  expect(within(list).getByText('Possible transfer')).toBeInTheDocument();
  await user.selectOptions(
    await within(review).findByLabelText('Import as'),
    'Transfer to Savings',
  );
  await user.click(within(review).getByRole('button', { name: 'Import 1 transaction' }));
  expect(await screen.findByText(/1 as transfer between your accounts/)).toBeInTheDocument();
  await waitFor(async () => {
    const txns = await store.transactions.list();
    expect(txns.map((t) => t.type)).toEqual(['transfer', 'transfer']);
  });
});

describe('guided stepper', () => {
  it('shows where you are, explains how to get a CSV, and goes back a step', async () => {
    const user = userEvent.setup({ delay: null });
    render(<App db={db} store={store} initialPath="/import" />);
    const progress = await screen.findByRole('navigation', { name: 'Import progress' });
    expect(within(progress).getByText('Step 1 of 5')).toBeInTheDocument();
    // With one account it is already chosen.
    expect(await screen.findByRole('radio', { name: /Capitec main/ })).toBeChecked();

    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(within(progress).getByText('Step 2 of 5')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Choose the statement file' })).toHaveFocus();
    expect(screen.getByText(/How do I get a CSV from my bank/)).toBeInTheDocument();
    expect(screen.getByText('Save to Files')).toBeInTheDocument();
    expect(screen.getByText('Capitec main')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(within(progress).getByText('Step 1 of 5')).toBeInTheDocument();
    expect(progress.querySelector('[aria-current="step"]')?.textContent?.replace(/\s+/g, ' ')).toBe(
      'Choose the account',
    );
  });

  it('shows the first row in plain words before review, and lets you change columns', async () => {
    const user = userEvent.setup({ delay: null });
    render(<App db={db} store={store} initialPath="/import" />);
    await chooseAccountAndFile(user, new File([CSV], 'march.csv', { type: 'text/csv' }));
    expect(
      await screen.findByRole('heading', { name: 'Does this look right?' }),
    ).toBeInTheDocument();
    const sample = screen.getByRole('region', { name: 'First row, as we read it' });
    expect(within(sample).getByText('SALARY')).toBeInTheDocument();
    expect(within(sample).getByText(/\+R\s?12\s?000,00/)).toBeInTheDocument();
    expect(screen.getByText(/4 rows from/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Change columns…' }));
    expect(screen.getByLabelText('Description')).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'File preview' })).toBeInTheDocument();
  });

  it('ends on a results screen that leads to the transactions to review or Home', async () => {
    const user = userEvent.setup({ delay: null });
    render(<App db={db} store={store} initialPath="/import" />);
    const review = await goToReview(user, new File([CSV], 'march.csv', { type: 'text/csv' }));
    await user.click(within(review).getByRole('button', { name: 'Import 3 transactions' }));

    const done = await screen.findByRole('region', { name: 'Imported 3 transactions' });
    expect(within(done).getByText(/Into/)).toHaveTextContent('Capitec main');
    expect(within(done).getByText(/1 couldn’t be read/)).toBeInTheDocument();
    expect(within(done).getByRole('link', { name: 'Review 3 transactions' })).toHaveAttribute(
      'href',
      '/transactions?status=needs_review',
    );
    expect(within(done).getByRole('link', { name: 'Go to Home' })).toHaveAttribute('href', '/');
    expect(screen.getByText('Step 5 of 5')).toBeInTheDocument();

    await user.click(within(done).getByRole('button', { name: 'Import another statement' }));
    expect(screen.getByText('Step 1 of 5')).toBeInTheDocument();
  });
});

it('explains where fees come from and marks fees split off a purchase', async () => {
  const user = userEvent.setup({ delay: null });
  const csv = `Posting Date,Description,Money In,Money Out,Fee,Balance
2026-03-02,SMS Notification Fee,,,-0.70,-0.70
2026-03-03,Card purchase,,-100.00,-2.00,-102.70
`;
  render(<App db={db} store={store} initialPath="/import" />);
  await chooseAccountAndFile(user, new File([csv], 'fees.csv', { type: 'text/csv' }));
  expect(
    await screen.findByText(/imported as their own transactions \(2 fees in this file\)/),
  ).toHaveTextContent('Bank fees come from the “Fee” column');
  expect(screen.getByText(/1 of 1 consecutive rows add up exactly/)).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'Looks right' }));
  const review = await screen.findByRole('region', { name: /review and import/i });
  const list = within(review).getByRole('list', { name: 'Rows to import' });
  const feeRow = within(list).getByText('Fee: Card purchase').closest('li')!;
  expect(within(feeRow).getByText('Bank fee')).toBeInTheDocument();
  // Fees are categorised automatically, and the source is explained.
  expect(within(feeRow).getByRole('combobox', { name: /Category for line 3/ })).toHaveDisplayValue(
    'Bank fees',
  );
  expect(within(feeRow).getByText('Charged on this purchase')).toBeInTheDocument();
  await user.click(within(review).getByRole('button', { name: 'Import 3 transactions' }));
  expect(
    await screen.findByRole('heading', { name: 'Imported 3 transactions' }),
  ).toBeInTheDocument();
});
