import type { Account, ImportBatch, Transaction } from '@/domain/models';
import type { IsoDate } from '@/domain/dates';
import type { Cents } from '@/domain/money';
import {
  type ColumnMapping,
  type ParsedCsv,
  type Staging,
  type StagedRow,
  MAX_FILE_BYTES,
  buildStaging,
  guessMapping,
  headerSignature,
  parseCsv,
} from '@/domain/imports';
import type { FinanceStore } from '@/data/repositories/types';
import { type Clock, DomainError, newId, systemClock } from './common';
import { updateAccount } from './accountsService';

export interface PreparedImport {
  account: Account;
  fileName: string | undefined;
  parsed: ParsedCsv;
  staging: Staging;
  /** Where the initial mapping came from. */
  mappingSource: 'saved' | 'guessed';
  /** A saved mapping exists but this file's header row differs, so it was re-guessed. */
  headerChanged: boolean;
}

async function requireActiveAccount(store: FinanceStore, accountId: string): Promise<Account> {
  const account = await store.accounts.get(accountId);
  if (!account) throw new DomainError('Choose an account to import into.');
  if (!account.active)
    throw new DomainError('That account is archived. Restore it before importing.');
  return account;
}

/** Validate a picked file before reading it. */
export function checkImportFile(file: { name: string; size: number }): void {
  if (file.size > MAX_FILE_BYTES) {
    throw new DomainError('That file is larger than 5 MB. Export a shorter date range.');
  }
  if (/\.(xlsx|xls|xlsm|ods)$/i.test(file.name)) {
    throw new DomainError(
      'Excel workbooks can’t be read directly yet. In Excel, use File → Save As → “CSV UTF-8”, then import that file.',
    );
  }
  if (/\.pdf$/i.test(file.name)) {
    throw new DomainError(
      'PDF statements aren’t supported yet. Download your statement as CSV instead.',
    );
  }
}

/**
 * Parse a statement into a staging area. Nothing is written. Uses the account's saved column
 * mapping when the header row matches, otherwise a best-effort guess the user then confirms.
 */
export async function prepareImport(
  store: FinanceStore,
  input: { accountId: string; text: string; fileName?: string },
): Promise<PreparedImport> {
  const account = await requireActiveAccount(store, input.accountId);
  const parsed = parseCsv(input.text);
  const profile = await store.importProfiles.get(account.id);
  const signature = headerSignature(parsed.rows);
  let mapping: ColumnMapping;
  let source: PreparedImport['mappingSource'] = 'guessed';
  let headerChanged = false;
  if (
    profile &&
    (!profile.mapping.hasHeader ||
      !profile.headerSignature ||
      profile.headerSignature === signature)
  ) {
    mapping = profile.mapping;
    source = 'saved';
  } else {
    headerChanged = !!profile;
    mapping = guessMapping(parsed.rows);
  }
  const existing = await store.transactions.byAccount(account.id);
  return {
    account,
    fileName: input.fileName,
    parsed,
    staging: buildStaging(parsed.rows, mapping, account, existing),
    mappingSource: source,
    headerChanged,
  };
}

/** Re-run staging after the user changes the column mapping. */
export async function restage(
  store: FinanceStore,
  prepared: PreparedImport,
  mapping: ColumnMapping,
): Promise<PreparedImport> {
  const existing = await store.transactions.byAccount(prepared.account.id);
  return {
    ...prepared,
    staging: buildStaging(prepared.parsed.rows, mapping, prepared.account, existing),
  };
}

export interface CommitInput {
  prepared: PreparedImport;
  /** The staged rows with the user's final include decisions. */
  rows: readonly StagedRow[];
  saveMapping: boolean;
  /** Record the statement's closing balance as the account's reconciliation check. */
  closingBalance?: { date: IsoDate; balanceCents: Cents } | undefined;
}

export interface CommitResult {
  batch: ImportBatch;
  created: number;
}

/**
 * Write the selected rows as transactions in one atomic step, with an import batch for history and
 * undo. Imported rows start as "needs review" and uncategorised; the original text, source,
 * fingerprint and batch are stored with each one.
 */
export async function commitImport(
  store: FinanceStore,
  input: CommitInput,
  clock: Clock = systemClock,
): Promise<CommitResult> {
  const { prepared } = input;
  if (prepared.staging.mappingErrors.length > 0)
    throw new DomainError(prepared.staging.mappingErrors[0]!);
  const account = await requireActiveAccount(store, prepared.account.id);
  const selected = input.rows.filter((r) => r.include && r.status !== 'invalid');
  if (selected.length === 0) throw new DomainError('No rows are selected for import.');
  const now = clock.now();
  const batchId = newId();
  const dates = selected.map((r) => r.date!).sort();

  const transactions: Transaction[] = selected.map((r) => ({
    id: newId(),
    accountId: account.id,
    date: r.date!,
    description: r.description.slice(0, 200),
    originalDescription: r.raw.join(' | ').slice(0, 500),
    amountCents: r.amountCents!,
    type: r.amountCents! > 0 ? 'income' : 'expense',
    categoryId: null,
    workspace: account.workspace,
    status: 'needs_review',
    source: 'csv',
    importBatchId: batchId,
    fingerprint: r.fingerprint!,
    ...(r.reference ? { notes: `Bank reference: ${r.reference}`.slice(0, 1000) } : {}),
    tags: [],
    archived: false,
    // Imports into a demo account are demo data too, so "Clear demo data" can remove them.
    isDemo: account.isDemo,
    createdAt: now,
    updatedAt: now,
  }));

  const batch: ImportBatch = {
    id: batchId,
    accountId: account.id,
    source: 'csv',
    ...(prepared.fileName ? { fileName: prepared.fileName.slice(0, 260) } : {}),
    importedAt: now,
    transactionCount: transactions.length,
    errorCount: input.rows.filter((r) => r.status === 'invalid').length,
    skippedCount: input.rows.filter((r) => r.status !== 'invalid' && !r.include).length,
    dateFrom: dates[0]!,
    dateTo: dates[dates.length - 1]!,
    status: 'committed',
    isDemo: account.isDemo,
    createdAt: now,
    updatedAt: now,
  };

  await store.atomic(async () => {
    await store.importBatches.put(batch);
    await store.transactions.bulkPut(transactions);
    if (input.saveMapping) {
      const existing = await store.importProfiles.get(account.id);
      await store.importProfiles.put({
        id: account.id,
        accountId: account.id,
        mapping: prepared.staging.mapping,
        headerSignature: headerSignature(prepared.parsed.rows),
        isDemo: account.isDemo,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
    }
    if (input.closingBalance) {
      await updateAccount(
        store,
        account.id,
        {
          reconciledBalanceCents: input.closingBalance.balanceCents,
          reconciledDate: input.closingBalance.date,
        },
        clock,
      );
    }
  });
  return { batch, created: transactions.length };
}

/**
 * Undo an import: removes the transactions it created (including any later edits to them) and keeps
 * the batch record, marked as undone, for the audit trail. Goal allocations that pointed at those
 * transactions keep their amounts but lose the link.
 */
export async function undoImport(
  store: FinanceStore,
  batchId: string,
  clock: Clock = systemClock,
): Promise<number> {
  const batch = await store.importBatches.get(batchId);
  if (!batch) throw new DomainError('Import not found.');
  if (batch.status === 'undone') throw new DomainError('This import has already been undone.');
  let removed = 0;
  await store.atomic(async () => {
    const txns = await store.transactions.byImportBatch(batchId);
    const ids = new Set(txns.map((t) => t.id));
    const contributions = (await store.goalContributions.list()).filter(
      (c) => c.transactionId && ids.has(c.transactionId),
    );
    if (contributions.length > 0) {
      await store.goalContributions.bulkPut(
        contributions.map(({ transactionId: _drop, ...rest }) => rest),
      );
    }
    await store.transactions.bulkDelete([...ids]);
    removed = ids.size;
    const now = clock.now();
    await store.importBatches.put({ ...batch, status: 'undone', undoneAt: now, updatedAt: now });
  });
  return removed;
}

/** How many of a batch's transactions were edited after import (shown before undoing). */
export async function editedSinceImport(store: FinanceStore, batchId: string): Promise<number> {
  const txns = await store.transactions.byImportBatch(batchId);
  return txns.filter((t) => t.updatedAt !== t.createdAt).length;
}
