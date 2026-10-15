import type { Account, AccountType, Workspace } from '@/domain/models';
import type { FinanceStore } from '@/data/repositories/types';
import { type Clock, DomainError, newId, systemClock } from './common';

export interface AccountInput {
  name: string;
  type: AccountType;
  workspace: Workspace;
  institution?: string | undefined;
  openingBalanceCents: number;
  openingBalanceDate: string;
  includeInSpendable: boolean;
}

/** Savings accounts default to not spendable; everything else defaults to spendable. */
export function defaultIncludeInSpendable(type: AccountType): boolean {
  return type !== 'savings';
}

export async function createAccount(
  store: FinanceStore,
  input: AccountInput,
  opts: { isDemo?: boolean; clock?: Clock } = {},
): Promise<Account> {
  const now = (opts.clock ?? systemClock).now();
  return store.accounts.put({
    id: newId(),
    name: input.name,
    type: input.type,
    workspace: input.workspace,
    ...(input.institution ? { institution: input.institution } : {}),
    currency: 'ZAR',
    openingBalanceCents: input.openingBalanceCents,
    openingBalanceDate: input.openingBalanceDate,
    includeInSpendable: input.includeInSpendable,
    active: true,
    isDemo: opts.isDemo ?? false,
    createdAt: now,
    updatedAt: now,
  });
}

export async function updateAccount(
  store: FinanceStore,
  id: string,
  patch: Partial<Omit<Account, 'id' | 'createdAt' | 'updatedAt' | 'currency' | 'isDemo'>>,
  clock: Clock = systemClock,
): Promise<Account> {
  const existing = await store.accounts.get(id);
  if (!existing) throw new DomainError('Account not found');
  if (patch.workspace && patch.workspace !== existing.workspace) {
    const txns = await store.transactions.byAccount(id);
    if (txns.length > 0) {
      throw new DomainError(
        'This account already has transactions, so its workspace cannot be changed. Create a new account instead.',
      );
    }
  }
  return store.accounts.put({ ...existing, ...patch, updatedAt: clock.now() });
}

/** Archiving hides an account but keeps its transactions and history intact. */
export function setAccountActive(store: FinanceStore, id: string, active: boolean, clock?: Clock) {
  return updateAccount(store, id, { active }, clock);
}

/**
 * Permanent deletion is only allowed for accounts with no transactions or linked goals, so
 * transactions are never silently deleted. Otherwise archive the account.
 */
export async function deleteAccount(store: FinanceStore, id: string): Promise<void> {
  const txns = await store.transactions.byAccount(id);
  if (txns.length > 0) {
    throw new DomainError('This account has transactions. Archive it instead of deleting it.');
  }
  const goals = (await store.goals.list()).filter((g) => g.linkedAccountId === id);
  if (goals.length > 0) {
    throw new DomainError('A savings goal is linked to this account. Unlink it first.');
  }
  await store.accounts.delete(id);
}
