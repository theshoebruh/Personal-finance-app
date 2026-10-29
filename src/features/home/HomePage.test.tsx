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
import type { GroupLine } from '@/domain/calculations/buckets';
import { GROUP_IDS } from '@/domain/defaults';
import { LeftText, isOver, ringTone } from './HomePage';

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
  await add('Spar snacks', 400_000, 'expense', 'cat-snacks');
});
afterEach(async () => {
  db.close();
  await Dexie.delete(db.name);
});

it('shows income, spending, what is left and the groups', async () => {
  render(<App db={db} store={store} initialPath="/" />);
  const hero = (await screen.findByText('Left this period')).closest('section')!;
  await waitFor(() => expect(hero.querySelector('.hero-amount')).toHaveTextContent('4 000,00'));
  const wants = await screen.findByRole('link', { name: /Wants/ });
  // R4,000 of a R3,000 goal (30% of R10,000 by default).
  expect(within(wants).getByText(/over/)).toHaveTextContent('1 000,00');
  expect(within(wants).getByText('40%')).toBeInTheDocument();
  const needs = screen.getByRole('link', { name: /Needs/ });
  expect(within(needs).getByText(/left/)).toHaveTextContent('3 000,00');
  expect(screen.getByRole('link', { name: /Buffer/ })).toBeInTheDocument();
});

it('opens a group and moves a transaction to another category', async () => {
  const user = userEvent.setup({ delay: null });
  render(<App db={db} store={store} initialPath="/group/grp-wants" />);
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

it('sorts and filters a group’s transactions', async () => {
  const user = userEvent.setup({ delay: null });
  const acc = (await store.accounts.list())[0]!;
  const today = todayInAppZone();
  await createTransaction(store, {
    accountId: acc.id,
    date: today,
    description: 'Arcade',
    amountCents: 50_000,
    type: 'expense',
    categoryId: 'cat-entertainment',
  });
  render(<App db={db} store={store} initialPath="/group/grp-wants" />);
  const titles = () =>
    [...document.querySelectorAll('.txn-cat-list .title')].map((e) => e.textContent);
  // Spar snacks R4,000, Arcade R500.
  await user.selectOptions(await screen.findByLabelText('Sort'), 'largest');
  expect(titles()).toEqual(['Spar snacks', 'Arcade']);
  await user.selectOptions(screen.getByLabelText('Sort'), 'name');
  expect(titles()).toEqual(['Arcade', 'Spar snacks']);
  await user.selectOptions(screen.getByLabelText('Sort'), 'smallest');
  expect(titles()).toEqual(['Arcade', 'Spar snacks']);
  await user.selectOptions(screen.getByLabelText('Category'), 'cat-snacks');
  expect(titles()).toEqual(['Spar snacks']);
});

it('counts a pending purchase everywhere and labels it Pending', async () => {
  const acc = (await store.accounts.list())[0]!;
  await createTransaction(store, {
    accountId: acc.id,
    date: todayInAppZone(),
    description: 'Coffee (pending)',
    amountCents: 50_000,
    type: 'expense',
    categoryId: 'cat-coffee',
    status: 'pending',
  });
  const { unmount } = render(<App db={db} store={store} initialPath="/" />);
  const hero = (await screen.findByText('Current balance')).closest('section')!;
  // R4,000 posted − R500 pending.
  await waitFor(() => expect(hero.querySelector('.hero-amount')).toHaveTextContent('3 500,00'));
  expect(hero).toHaveTextContent(/Includes R\s?500,00 still pending/);
  expect(hero.querySelector('.period-explainer')).toHaveTextContent(
    /Spent includes R\s?500,00 still pending/,
  );
  // Wants: R4,000 + R500 pending = R4,500.
  expect(within(screen.getByRole('link', { name: /Wants/ })).getByText('45%')).toBeInTheDocument();
  unmount();

  render(<App db={db} store={store} initialPath="/group/grp-wants" />);
  const row = (await screen.findByText('Coffee (pending)')).closest('li')!;
  expect(within(row).getByText('Pending')).toBeInTheDocument();
});

it('keeps the period going on payday until the salary arrives', async () => {
  const today = todayInAppZone();
  const day = Number(today.slice(8, 10));
  // Payday is today; last month's salary arrived about a month ago, this month's isn't in yet.
  await updateSettings(store, { paydayDayOfMonth: day, budgetPeriodMode: 'pay_period' });
  const acc = (await store.accounts.list())[0]!;
  await createTransaction(store, {
    accountId: acc.id,
    date: addDays(today, -30),
    description: 'Last month’s salary',
    amountCents: 1_200_000,
    type: 'income',
    categoryId: 'cat-salary',
  });
  // The salary added in beforeEach (dated today) stands for this month's: remove it.
  const todays = (await store.transactions.list()).find((t) => t.description === 'Salary')!;
  await store.transactions.delete(todays.id);

  render(<App db={db} store={store} initialPath="/" />);
  expect(await screen.findByText(/waiting for salary/)).toBeInTheDocument();
  expect(
    screen.getByText(/your salary isn’t in yet, so this period continues/),
  ).toBeInTheDocument();
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
  await user.type(wants, '20');
  await user.click(screen.getByRole('button', { name: 'Save goals' }));
  expect(await screen.findByText('Goals saved')).toBeInTheDocument();
});

describe('group status and colours', () => {
  const GROUPS = {
    needs: { id: GROUP_IDS.needs, name: 'Needs', kind: 'spending', colour: 1 },
    wants: { id: GROUP_IDS.wants, name: 'Wants', kind: 'spending', colour: 2 },
    savings: { id: GROUP_IDS.savings, name: 'Savings', kind: 'spending', colour: 3 },
    rf: { id: 'grp-custom', name: 'RF', kind: 'spending', colour: 6 },
    buffer: { id: GROUP_IDS.buffer, name: 'Buffer', kind: 'leftover', colour: 5 },
  } as const;
  const line = (key: keyof typeof GROUPS, actualCents: number, targetCents: number): GroupLine => ({
    group: {
      ...GROUPS[key],
      targetPercent: 20,
      sortOrder: 0,
      isDemo: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    actualCents,
    targetCents,
    targetPercent: 20,
    actualPercent: null,
    leftCents: key === 'buffer' ? actualCents - targetCents : targetCents - actualCents,
    categories: [],
  });
  const status = (l: GroupLine) => render(<LeftText line={l} />).container.textContent;

  it('always colours a ring with its group colour, whatever its status', () => {
    expect(ringTone(line('needs', 9_000, 10_000))).toBe('chart-1');
    expect(ringTone(line('wants', 20_000, 10_000))).toBe('chart-2');
    expect(ringTone(line('savings', 9_700, 10_000))).toBe('chart-3');
    expect(ringTone(line('rf', 100, 10_000))).toBe('chart-6');
    expect(ringTone(line('buffer', -500, 10_000))).toBe('chart-5');
  });

  it('says over, almost or left for spending groups', () => {
    expect(status(line('wants', 12_000, 10_000))).toMatch(/over/);
    expect(status(line('needs', 9_000, 10_000))).toMatch(/Almost at goal · R\s?10,00 left/);
    expect(status(line('rf', 1_000, 10_000))).toMatch(/^R\s?90,00 left$/);
    expect(isOver(line('wants', 12_000, 10_000))).toBe(true);
  });

  it('counts Savings and Buffer up to their goal, never as over', () => {
    expect(status(line('savings', 9_700, 10_000))).toMatch(/R\s?3,00 to go/);
    expect(status(line('savings', 12_000, 10_000))).toBe('Goal reached ✓');
    expect(isOver(line('savings', 12_000, 10_000))).toBe(false);
    expect(status(line('buffer', 10_000, 10_000))).toBe('Goal reached ✓');
    expect(status(line('buffer', -500, 10_000))).toMatch(/Spent R\s?5,00 more than income/);
    expect(isOver(line('buffer', -500, 10_000))).toBe(true);
  });
});
