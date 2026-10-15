import type {
  Account,
  Transaction,
  TransactionStatus,
  TransactionType,
  TransferKind,
} from '@/domain/models';
import type { FinanceStore } from '@/data/repositories/types';
import { type Clock, DomainError, newId, systemClock } from './common';

/** Non-transfer transaction types the user can create directly. */
export type SimpleTransactionType = Exclude<TransactionType, 'transfer'>;

export interface TransactionInput {
  accountId: string;
  date: string;
  description: string;
  /** Always a positive magnitude; the sign is derived from the type. */
  amountCents: number;
  type: SimpleTransactionType;
  /** Only used for balance adjustments, which can go either way. */
  adjustmentDirection?: 'in' | 'out';
  categoryId: string | null;
  status?: TransactionStatus;
  notes?: string | undefined;
  tags?: string[];
}

export function signedAmount(
  type: SimpleTransactionType,
  magnitude: number,
  adjustmentDirection: 'in' | 'out' = 'in',
): number {
  if (!Number.isSafeInteger(magnitude) || magnitude <= 0) {
    throw new DomainError('Amount must be more than zero');
  }
  switch (type) {
    case 'income':
    case 'refund':
      return magnitude;
    case 'expense':
      return -magnitude;
    case 'adjustment':
      return adjustmentDirection === 'in' ? magnitude : -magnitude;
  }
}

async function requireAccount(store: FinanceStore, id: string): Promise<Account> {
  const account = await store.accounts.get(id);
  if (!account) throw new DomainError('Account not found');
  return account;
}

/** Money in uses income categories; expenses and refunds use expense categories. */
export function categoryKindFor(type: TransactionType): 'income' | 'expense' | null {
  if (type === 'income') return 'income';
  if (type === 'expense' || type === 'refund') return 'expense';
  return null; // adjustments and transfers take no category
}

async function checkCategory(
  store: FinanceStore,
  categoryId: string | null,
  account: Account,
  type: TransactionType,
) {
  if (categoryId === null) return;
  const cat = await store.categories.get(categoryId);
  if (!cat) throw new DomainError('Category not found');
  if (cat.workspace !== 'both' && cat.workspace !== account.workspace) {
    throw new DomainError(`"${cat.name}" is not a ${account.workspace} category`);
  }
  const kind = categoryKindFor(type);
  if (kind === null) {
    throw new DomainError('Balance adjustments and transfers don’t take a category');
  }
  if (cat.kind !== kind) {
    throw new DomainError(
      kind === 'income'
        ? `"${cat.name}" is a spending category; choose an income category for income`
        : `"${cat.name}" is an income category; choose a spending category`,
    );
  }
}

export async function createTransaction(
  store: FinanceStore,
  input: TransactionInput,
  opts: { isDemo?: boolean; clock?: Clock; id?: string } = {},
): Promise<Transaction> {
  const account = await requireAccount(store, input.accountId);
  await checkCategory(store, input.categoryId, account, input.type);
  const now = (opts.clock ?? systemClock).now();
  return store.transactions.put({
    id: opts.id ?? newId(),
    accountId: account.id,
    date: input.date,
    description: input.description,
    amountCents: signedAmount(input.type, input.amountCents, input.adjustmentDirection),
    type: input.type,
    categoryId: input.categoryId,
    // The workspace always follows the account, so personal and business never mix silently.
    workspace: account.workspace,
    status: input.status ?? 'posted',
    source: 'manual',
    ...(input.notes ? { notes: input.notes } : {}),
    tags: input.tags ?? [],
    archived: false,
    isDemo: opts.isDemo ?? false,
    createdAt: now,
    updatedAt: now,
  });
}

export async function updateTransaction(
  store: FinanceStore,
  id: string,
  input: Partial<TransactionInput>,
  clock: Clock = systemClock,
): Promise<Transaction> {
  const existing = await store.transactions.get(id);
  if (!existing) throw new DomainError('Transaction not found');
  if (existing.type === 'transfer') {
    throw new DomainError('Edit transfers with the transfer form so both legs stay in step.');
  }
  const accountId = input.accountId ?? existing.accountId;
  const account = await requireAccount(store, accountId);
  const categoryId = input.categoryId !== undefined ? input.categoryId : existing.categoryId;
  const type = input.type ?? (existing.type as SimpleTransactionType);
  await checkCategory(store, categoryId, account, type);
  const magnitude = input.amountCents ?? Math.abs(existing.amountCents);
  const direction = input.adjustmentDirection ?? (existing.amountCents >= 0 ? 'in' : 'out');
  const next: Transaction = {
    ...existing,
    accountId,
    workspace: account.workspace,
    date: input.date ?? existing.date,
    description: input.description ?? existing.description,
    amountCents: signedAmount(type, magnitude, direction),
    type,
    categoryId,
    status: input.status ?? existing.status,
    tags: input.tags ?? existing.tags,
    updatedAt: clock.now(),
  };
  if (input.notes !== undefined) {
    if (input.notes) next.notes = input.notes;
    else delete next.notes;
  }
  // originalDescription and source are preserved verbatim for imported records.
  return store.transactions.put(next);
}

export function transferKindFor(from: Account, to: Account): TransferKind {
  if (from.workspace === to.workspace) return 'internal';
  return from.workspace === 'personal' ? 'owner_contribution' : 'owner_draw';
}

export interface TransferInput {
  fromAccountId: string;
  toAccountId: string;
  date: string;
  amountCents: number;
  description?: string;
  notes?: string;
  status?: TransactionStatus;
}

/**
 * Records a transfer between owned accounts as two linked legs sharing a transfer ID. Transfers are
 * never income or expenses; personal↔business movements are labelled owner contribution/draw.
 */
export async function createTransfer(
  store: FinanceStore,
  input: TransferInput,
  /** `ids` fixes the record ids (demo data uses it so every device writes the same records). */
  opts: {
    isDemo?: boolean;
    clock?: Clock;
    ids?: { transfer: string; out: string; into: string };
  } = {},
): Promise<[Transaction, Transaction]> {
  if (input.fromAccountId === input.toAccountId) {
    throw new DomainError('Choose two different accounts for a transfer');
  }
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) {
    throw new DomainError('Amount must be more than zero');
  }
  const from = await requireAccount(store, input.fromAccountId);
  const to = await requireAccount(store, input.toAccountId);
  const now = (opts.clock ?? systemClock).now();
  const transferId = opts.ids?.transfer ?? newId();
  const kind = transferKindFor(from, to);
  const base = {
    date: input.date,
    type: 'transfer' as const,
    categoryId: null,
    status: input.status ?? ('posted' as const),
    source: 'manual' as const,
    transferId,
    transferKind: kind,
    ...(input.notes ? { notes: input.notes } : {}),
    tags: [],
    archived: false,
    isDemo: opts.isDemo ?? false,
    createdAt: now,
    updatedAt: now,
  };
  const out: Transaction = {
    ...base,
    id: opts.ids?.out ?? newId(),
    accountId: from.id,
    workspace: from.workspace,
    amountCents: -input.amountCents,
    description: input.description || `Transfer to ${to.name}`,
  };
  const into: Transaction = {
    ...base,
    id: opts.ids?.into ?? newId(),
    accountId: to.id,
    workspace: to.workspace,
    amountCents: input.amountCents,
    description: input.description || `Transfer from ${from.name}`,
  };
  await store.atomic(async () => {
    await store.transactions.bulkPut([out, into]);
  });
  return [out, into];
}

/** Update both legs of a transfer together (date, amount, description, status, notes). */
export async function updateTransfer(
  store: FinanceStore,
  transferId: string,
  patch: { date?: string; amountCents?: number; notes?: string; status?: TransactionStatus },
  clock: Clock = systemClock,
): Promise<void> {
  const legs = await store.transactions.byTransferId(transferId);
  if (legs.length === 0) throw new DomainError('Transfer not found');
  if (
    patch.amountCents !== undefined &&
    (!Number.isSafeInteger(patch.amountCents) || patch.amountCents <= 0)
  ) {
    throw new DomainError('Amount must be more than zero');
  }
  const now = clock.now();
  const updated = legs.map((leg) => {
    const next: Transaction = {
      ...leg,
      date: patch.date ?? leg.date,
      status: patch.status ?? leg.status,
      amountCents:
        patch.amountCents === undefined
          ? leg.amountCents
          : Math.sign(leg.amountCents) * patch.amountCents,
      updatedAt: now,
    };
    if (patch.notes !== undefined) {
      if (patch.notes) next.notes = patch.notes;
      else delete next.notes;
    }
    return next;
  });
  await store.atomic(() => store.transactions.bulkPut(updated));
}

async function withTransferLegs(store: FinanceStore, id: string): Promise<Transaction[]> {
  const t = await store.transactions.get(id);
  if (!t) throw new DomainError('Transaction not found');
  return t.transferId ? store.transactions.byTransferId(t.transferId) : [t];
}

/** Archive (soft-delete) a transaction; transfers archive both legs. Reversible. */
export async function setTransactionArchived(
  store: FinanceStore,
  id: string,
  archived: boolean,
  clock: Clock = systemClock,
): Promise<void> {
  const legs = await withTransferLegs(store, id);
  const now = clock.now();
  await store.atomic(() =>
    store.transactions.bulkPut(legs.map((l) => ({ ...l, archived, updatedAt: now }))),
  );
}

/**
 * Permanently delete a manually entered transaction (both legs for transfers). Imported records
 * must be archived instead so the import audit trail stays intact. Goal allocations that referenced
 * the transaction keep their amount but lose the link.
 */
export async function deleteTransactionPermanently(store: FinanceStore, id: string): Promise<void> {
  const legs = await withTransferLegs(store, id);
  if (legs.some((l) => l.source !== 'manual')) {
    throw new DomainError('Imported transactions can be archived, not permanently deleted.');
  }
  const ids = new Set(legs.map((l) => l.id));
  await store.atomic(async () => {
    const contributions = (await store.goalContributions.list()).filter(
      (c) => c.transactionId && ids.has(c.transactionId),
    );
    if (contributions.length > 0) {
      await store.goalContributions.bulkPut(
        contributions.map(({ transactionId: _drop, ...rest }) => rest),
      );
    }
    await store.transactions.bulkDelete([...ids]);
  });
}

/**
 * Sets one category on many transactions. Transactions the category can't apply to (transfers,
 * adjustments, or the wrong kind — e.g. income given a spending category) are left unchanged and
 * counted as skipped.
 */
export async function bulkSetCategory(
  store: FinanceStore,
  ids: readonly string[],
  categoryId: string | null,
  clock: Clock = systemClock,
): Promise<{ updated: number; skipped: number }> {
  const now = clock.now();
  const updated: Transaction[] = [];
  let skipped = 0;
  for (const id of ids) {
    const t = await store.transactions.get(id);
    if (!t) continue;
    const account = await requireAccount(store, t.accountId);
    try {
      await checkCategory(store, categoryId, account, t.type);
    } catch (e) {
      if (!(e instanceof DomainError) || categoryId === null) throw e;
      skipped++;
      continue;
    }
    if (t.type === 'transfer' || t.type === 'adjustment') {
      skipped++;
      continue;
    }
    updated.push({
      ...t,
      categoryId,
      status: t.status === 'needs_review' && categoryId ? 'posted' : t.status,
      updatedAt: now,
    });
  }
  await store.atomic(() => store.transactions.bulkPut(updated));
  return { updated: updated.length, skipped };
}
