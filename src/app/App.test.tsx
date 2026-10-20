import Dexie from 'dexie';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FinanceDb } from '@/data/local-db/db';
import { createDexieStore } from '@/data/repositories/dexieStore';
import type { FinanceStore } from '@/data/repositories/types';
import { todayInAppZone } from '@/domain/dates';
import { ensureInitialised, updateSettings } from '@/services/settingsService';
import { saveRecurringRule } from '@/services/planningService';
import { App } from './App';

let n = 0;
let db: FinanceDb;
let store: FinanceStore;

beforeEach(async () => {
  db = new FinanceDb(`ui-test-${++n}`);
  store = createDexieStore(db);
  await ensureInitialised(store);
  // Keep the maths simple for assertions: no savings reservation.
  await updateSettings(store, { reservePlannedSavings: false });
});

afterEach(async () => {
  db.close();
  await Dexie.delete(db.name);
});

/** Waits until the headline available-to-spend figure shows the expected text. */
async function expectAvailable(text: string) {
  const region = await screen.findByRole('region', { name: /available to spend/i });
  await waitFor(() => expect(region.querySelector('.hero-amount')).toHaveTextContent(text));
}

describe('core flow', () => {
  it('shows onboarding on first launch', async () => {
    render(<App db={db} store={store} initialPath="/" />);
    expect(await screen.findByText(/your money in five groups/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /explore with demo data/i })).toBeInTheDocument();
  });

  it('adds an account, then a transaction, and the dashboard recalculates', async () => {
    const user = userEvent.setup({ delay: null });
    const { unmount } = render(<App db={db} store={store} initialPath="/accounts" />);
    await user.click(await screen.findByRole('button', { name: 'Add account' }));
    const form = screen.getByRole('form', { name: 'Add account' });
    await user.type(within(form).getByLabelText('Account name'), 'Capitec main');
    await user.type(within(form).getByLabelText('Opening balance (R)'), '5000');
    await user.click(within(form).getByRole('button', { name: 'Add account' }));
    expect(await screen.findByText('Capitec main')).toBeInTheDocument();
    unmount();

    const tx = render(<App db={db} store={store} initialPath="/transactions?new=1" />);
    const txForm = await screen.findByRole('form', { name: 'Add transaction' });
    await user.type(within(txForm).getByLabelText('Amount (R)'), '1250.50');
    await user.type(within(txForm).getByLabelText('Description'), 'Weekly shop at Checkers');
    await user.selectOptions(within(txForm).getByLabelText('Account'), 'Capitec main');
    await user.click(within(txForm).getByRole('button', { name: 'Add transaction' }));
    expect(await screen.findByText('Weekly shop at Checkers')).toBeInTheDocument();
    tx.unmount();

    render(<App db={db} store={store} initialPath="/" />);
    // Home: no income yet, R1,250.50 spent without a category.
    const hero = await screen.findByText('Left this period');
    const card = hero.closest('section')!;
    await waitFor(() => expect(card.querySelector('.hero-amount')).toHaveTextContent('1 250,50'));
    expect(await screen.findByText(/of spending has no category yet/)).toBeInTheDocument();
  });

  it('validates the transaction form before saving', async () => {
    const user = userEvent.setup({ delay: null });
    await store.accounts.put({
      id: 'a1',
      name: 'Main',
      type: 'current',
      workspace: 'personal',
      currency: 'ZAR',
      openingBalanceCents: 0,
      openingBalanceDate: todayInAppZone(),
      includeInSpendable: true,
      active: true,
      isDemo: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    render(<App db={db} store={store} initialPath="/transactions?new=1" />);
    const form = await screen.findByRole('form', { name: 'Add transaction' });
    await user.type(within(form).getByLabelText('Amount (R)'), 'abc');
    await user.click(within(form).getByRole('button', { name: 'Add transaction' }));
    expect(await within(form).findByText(/greater than zero/i)).toBeInTheDocument();
    expect(within(form).getByText(/short description/i)).toBeInTheDocument();
    expect(await store.transactions.list()).toHaveLength(0);
  });

  it('deducts an upcoming commitment until it is marked paid', async () => {
    const user = userEvent.setup({ delay: null });
    const today = todayInAppZone();
    await store.accounts.put({
      id: 'a1',
      name: 'Main',
      type: 'current',
      workspace: 'personal',
      currency: 'ZAR',
      openingBalanceCents: 1_000_000,
      openingBalanceDate: today,
      includeInSpendable: true,
      active: true,
      isDemo: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    // The detailed overview is hidden from the menus but still reachable.
    render(<App db={db} store={store} initialPath="/overview" />);
    await expectAvailable('R 10 000,00');

    // Due today so it always falls inside the current window, whatever today is.
    await saveRecurringRule(store, {
      name: 'Rent',
      direction: 'expense',
      amountCents: 400_000,
      frequency: 'monthly',
      startDate: today,
      workspace: 'personal',
      active: true,
      matchWindowDays: 0,
      alertLeadDays: 3,
    });
    await expectAvailable('R 6 000,00');

    await user.click(await screen.findByRole('button', { name: /mark rent .* as paid/i }));
    await expectAvailable('R 10 000,00');
  });
});

describe('navigation', () => {
  it('opens the Add sheet from the tab bar, with importing a statement first', async () => {
    const user = userEvent.setup({ delay: null });
    render(<App db={db} store={store} initialPath="/" />);
    const tabs = (await screen.findAllByRole('navigation', { name: 'Main' })).find((n) =>
      n.classList.contains('tab-bar'),
    )!;
    const add = within(tabs).getByRole('button', { name: 'Add' });
    await user.click(add);
    const sheet = screen.getByRole('dialog', { name: 'Add' });
    const actions = within(sheet).getAllByRole('link');
    expect(actions[0]).toHaveAccessibleName(/Import bank statement/);
    expect(actions[0]).toHaveAttribute('href', '/import');
    expect(actions[0]).toHaveFocus();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(add).toHaveFocus();

    await user.click(add);
    await user.click(within(screen.getByRole('dialog')).getByRole('link', { name: /Import/ }));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Import statement' }),
    ).toBeVisible();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('lists the other pages under More, and they lead back to More', async () => {
    const user = userEvent.setup({ delay: null });
    render(<App db={db} store={store} initialPath="/more" />);
    expect(await screen.findByRole('heading', { level: 1, name: 'More' })).toBeVisible();
    const tabs = screen
      .getAllByRole('navigation', { name: 'Main' })
      .find((n) => n.classList.contains('tab-bar'))!;
    expect(within(tabs).getByRole('link', { name: 'More' })).toHaveAttribute(
      'aria-current',
      'page',
    );

    await user.click(within(screen.getByRole('main')).getByRole('link', { name: /Reports/ }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Reports' })).toBeVisible();
    // More stays highlighted on pages reached from it.
    expect(within(tabs).getByRole('link', { name: 'More' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    const back = screen
      .getAllByRole('link', { name: 'More' })
      .find((a) => a.classList.contains('back-link'))!;
    await user.click(back);
    expect(await screen.findByRole('heading', { level: 1, name: 'More' })).toBeVisible();
  });
});
