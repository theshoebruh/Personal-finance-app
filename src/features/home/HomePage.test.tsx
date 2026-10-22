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
