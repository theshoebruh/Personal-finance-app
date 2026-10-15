import type {
  Account,
  AppSettings,
  Budget,
  Category,
  GoalContribution,
  RecurringRule,
  SavingsGoal,
  Transaction,
} from '@/domain/models';
import { defaultSettings } from '@/domain/defaults';

const TS = '2026-01-01T00:00:00.000Z';
let seq = 0;
const nextId = (p: string) => `${p}-${++seq}`;

export function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: nextId('acc'),
    name: 'Main account',
    type: 'current',
    workspace: 'personal',
    currency: 'ZAR',
    openingBalanceCents: 0,
    openingBalanceDate: '2026-01-01',
    includeInSpendable: true,
    active: true,
    isDemo: false,
    createdAt: TS,
    updatedAt: TS,
    ...overrides,
  };
}

export function makeTxn(
  overrides: Partial<Transaction> & Pick<Transaction, 'accountId'>,
): Transaction {
  const amount = overrides.amountCents ?? -1000;
  return {
    id: nextId('txn'),
    date: '2026-03-10',
    description: 'Test transaction',
    amountCents: amount,
    type: amount > 0 ? 'income' : 'expense',
    categoryId: null,
    workspace: 'personal',
    status: 'posted',
    source: 'manual',
    tags: [],
    archived: false,
    isDemo: false,
    createdAt: TS,
    updatedAt: TS,
    ...overrides,
  };
}

export function makeTransfer(
  from: Account,
  to: Account,
  amountCents: number,
  date = '2026-03-10',
  kind: Transaction['transferKind'] = 'internal',
): [Transaction, Transaction] {
  const transferId = nextId('tr');
  return [
    makeTxn({
      accountId: from.id,
      workspace: from.workspace,
      amountCents: -amountCents,
      type: 'transfer',
      transferId,
      transferKind: kind,
      date,
      description: `Transfer to ${to.name}`,
    }),
    makeTxn({
      accountId: to.id,
      workspace: to.workspace,
      amountCents,
      type: 'transfer',
      transferId,
      transferKind: kind,
      date,
      description: `Transfer from ${from.name}`,
    }),
  ];
}

export function makeRule(overrides: Partial<RecurringRule> = {}): RecurringRule {
  return {
    id: nextId('rule'),
    name: 'Rent',
    direction: 'expense',
    amountCents: 500000,
    frequency: 'monthly',
    startDate: '2026-01-01',
    workspace: 'personal',
    active: true,
    settledDates: [],
    matchWindowDays: 5,
    alertLeadDays: 3,
    isDemo: false,
    createdAt: TS,
    updatedAt: TS,
    ...overrides,
  };
}

export function makeCategory(overrides: Partial<Category> = {}): Category {
  return {
    id: nextId('cat'),
    name: 'Eating out',
    kind: 'expense',
    group: 'discretionary',
    workspace: 'personal',
    archived: false,
    isDemo: false,
    createdAt: TS,
    updatedAt: TS,
    ...overrides,
  };
}

export function makeBudget(overrides: Partial<Budget> & Pick<Budget, 'categoryId'>): Budget {
  return {
    id: nextId('bud'),
    workspace: 'personal',
    period: 'monthly',
    limitCents: 100000,
    active: true,
    isDemo: false,
    createdAt: TS,
    updatedAt: TS,
    ...overrides,
  };
}

export function makeGoal(overrides: Partial<SavingsGoal> = {}): SavingsGoal {
  return {
    id: nextId('goal'),
    name: 'Emergency fund',
    goalType: 'emergency_fund',
    workspace: 'personal',
    targetMode: 'fixed',
    targetCents: 1000000,
    priority: 1,
    state: 'active',
    isDemo: false,
    createdAt: TS,
    updatedAt: TS,
    ...overrides,
  };
}

export function makeContribution(
  overrides: Partial<GoalContribution> & Pick<GoalContribution, 'goalId' | 'amountCents'>,
): GoalContribution {
  return {
    id: nextId('gc'),
    date: '2026-03-05',
    isDemo: false,
    createdAt: TS,
    updatedAt: TS,
    ...overrides,
  };
}

export function makeSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return { ...defaultSettings(TS), ...overrides };
}
