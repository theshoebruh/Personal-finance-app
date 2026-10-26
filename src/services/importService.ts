import type { Account, ImportBatch, Transaction } from '@/domain/models';
import type { IsoDate } from '@/domain/dates';
import type { Cents } from '@/domain/money';
import {
  type ColumnMapping,
  type ParsedCsv,
  type Staging,
  type StagedRow,
  categoryFits,
  MAX_FILE_BYTES,
  buildStaging,
  guessMapping,
  headerSignature,
  parseCsv,
  parseXlsx,
  transactionTimeTag,
} from '@/domain/imports';
import type { FinanceStore } from '@/data/repositories/types';
import { type Clock, DomainError, newId, systemClock } from './common';
import { updateAccount } from './accountsService';
import { KEEP_SEPARATE_TAG } from './pendingCleanup';
import {
  asTransferLeg,
  convertedByTag,
  kindForLegs,
  otherSideLeg,
  revertTransferLeg,
} from './transactionsService';

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
  if (/\.(xls|ods|numbers)$/i.test(file.name)) {
    throw new DomainError(
      'That spreadsheet format can’t be read. Save it as an Excel workbook (.xlsx) or as “CSV UTF-8”, then import that file.',
    );
  }
  if (/\.pdf$/i.test(file.name)) {
    throw new DomainError(
      'PDF statements aren’t supported yet. Download your statement as CSV or Excel instead.',
    );
  }
}

/** Everything staging uses to suggest transfers and categories. */
async function stagingContext(store: FinanceStore) {
  return {
    accounts: await store.accounts.list(),
    transactions: await store.transactions.list(),
    categories: await store.categories.list(),
    rules: await store.categorisationRules.list(),
  };
}

/**
 * Parse a statement into a staging area. Nothing is written. Uses the account's saved column
 * mapping when the header row matches, otherwise a best-effort guess the user then confirms.
 */
export async function prepareImport(
  store: FinanceStore,
  input: { accountId: string; text?: string; workbook?: Uint8Array; fileName?: string },
): Promise<PreparedImport> {
  const account = await requireActiveAccount(store, input.accountId);
  // An Excel workbook is read into the same rows as a CSV; everything after this is shared.
  const parsed = input.workbook ? parseXlsx(input.workbook) : parseCsv(input.text ?? '');
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
    // Mappings saved before fee and bank-category columns were supported don't mention them; pick
    // them up from the header so nothing is silently left out. An explicit "not used" (null) is
    // respected.
    if (mapping.hasHeader) {
      const guess = guessMapping(parsed.rows);
      for (const key of [
        'feeColumn',
        'categoryColumn',
        'parentCategoryColumn',
        'transactionDateColumn',
      ] as const) {
        if (mapping[key] === undefined) mapping = { ...mapping, [key]: guess[key] ?? null };
      }
    }
  } else {
    headerChanged = !!profile;
    mapping = guessMapping(parsed.rows);
  }
  const existing = await store.transactions.byAccount(account.id);
  const context = await stagingContext(store);
  return {
    account,
    fileName: input.fileName,
    parsed,
    staging: buildStaging(parsed.rows, mapping, account, existing, context),
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
  const context = await stagingContext(store);
  return {
    ...prepared,
    staging: buildStaging(prepared.parsed.rows, mapping, prepared.account, existing, context),
  };
}

export interface CommitInput {
  prepared: PreparedImport;
  /** The staged rows with the user's final include decisions. */
  rows: readonly StagedRow[];
  saveMapping: boolean;
  /** Record the statement's closing balance as the account's reconciliation check. */
  closingBalance?: { date: IsoDate; balanceCents: Cents } | undefined;
  /**
   * For transfer rows with no matching entry in the other account yet, also create the other side
   * there (default true), so both balances are right even if that account's statement is never
   * imported. A later statement row for it is flagged as a possible duplicate.
   */
  recordOtherSide?: boolean;
}

export interface CommitResult {
  batch: ImportBatch;
  created: number;
  /** Transactions that got a category on import (the rest are left for review). */
  categorised: number;
  /** Rows imported as transfers between your own accounts. */
  transfers: number;
  /** Pending transactions from an earlier import that this statement's posted rows updated. */
  postedPending: number;
  /** Rows imported as pending (not final at the bank yet). */
  pending: number;
  /** Transactions left in "Needs review" for a category. */
  needsReview: number;
}

/** Tags on a pending transaction that an import posted, so undoing that import can revert it. */
function postedByTag(batchId: string): string {
  return `pp:${batchId}`.slice(0, 40);
}
const PREVIOUS_DATE_TAG = 'pd:';

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
  const included = input.rows.filter((r) => r.include && r.status !== 'invalid');
  // Posted versions of earlier pending transactions update those instead of adding new ones.
  const posting: { row: StagedRow; pending: Transaction }[] = [];
  const selected: StagedRow[] = [];
  for (const r of included) {
    const t =
      r.status === 'posts_pending' && r.pendingMatch
        ? await store.transactions.get(r.pendingMatch.transactionId)
        : undefined;
    // If the pending transaction was removed or changed since staging, import the row as new.
    if (t && !t.archived && t.amountCents === r.amountCents) posting.push({ row: r, pending: t });
    else selected.push(r);
  }
  if (included.length === 0) throw new DomainError('No rows are selected for import.');
  const now = clock.now();
  const batchId = newId();
  const dates = included.map((r) => r.date!).sort();
  const categories = new Map((await store.categories.list()).map((c) => [c.id, c]));
  /** The row's suggested or chosen category, if it (still) fits this account and amount. */
  const categoryFor = (r: StagedRow) =>
    r.categoryId && categoryFits(categories.get(r.categoryId), account, r.amountCents!)
      ? r.categoryId
      : null;

  const base: Transaction[] = selected.map((r) => ({
    id: newId(),
    accountId: account.id,
    date: r.date!,
    description: r.description.slice(0, 200),
    originalDescription: r.raw.join(' | ').slice(0, 500),
    amountCents: r.amountCents!,
    type: r.amountCents! > 0 ? 'income' : 'expense',
    categoryId: categoryFor(r),
    workspace: account.workspace,
    // Not final at the bank yet: pending (outside the posted balance). Otherwise categorised rows
    // are done and the rest wait in "Needs review" for a category.
    status: r.pending ? 'pending' : categoryFor(r) ? 'posted' : 'needs_review',
    source: 'csv',
    importBatchId: batchId,
    fingerprint: r.fingerprint!,
    ...(r.reference ? { notes: `Bank reference: ${r.reference}`.slice(0, 1000) } : {}),
    tags: [
      ...(r.transactionAt ? [transactionTimeTag(r.transactionAt)] : []),
      ...(r.keepSeparate ? [KEEP_SEPARATE_TAG] : []),
    ],
    archived: false,
    // Imports into a demo account are demo data too, so "Clear demo data" can remove them.
    isDemo: account.isDemo,
    createdAt: now,
    updatedAt: now,
  }));

  // Transfers between your own accounts: link to the other side instead of income/expense.
  const accounts = new Map((await store.accounts.list()).map((a) => [a.id, a]));
  const tag = convertedByTag(batchId);
  const transactions: Transaction[] = [];
  const extraWrites: Transaction[] = [];
  let transferCount = 0;
  for (const [i, r] of selected.entries()) {
    const txn = base[i]!;
    const other = r.transferAccountId ? accounts.get(r.transferAccountId) : undefined;
    if (!other || other.id === account.id) {
      transactions.push(txn);
      continue;
    }
    transferCount++;
    const kind = kindForLegs(
      { account, amountCents: txn.amountCents },
      { account: other, amountCents: -txn.amountCents },
    );
    const s = r.transferSuggestion;
    const counterpart =
      s?.counterpart && s.otherAccountId === other.id
        ? await store.transactions.get(s.counterpart.transactionId)
        : undefined;
    const stillValid =
      counterpart && !counterpart.archived && counterpart.amountCents === -txn.amountCents;
    if (stillValid && counterpart.type === 'transfer' && counterpart.transferId) {
      // The other side was imported first as a single leg: complete the pair.
      transactions.push(
        asTransferLeg(txn, counterpart.transferId, counterpart.transferKind ?? kind, now),
      );
    } else if (stillValid && counterpart.type !== 'transfer') {
      // An ordinary income/expense in the other account becomes the other leg (undo reverts it).
      const transferId = newId();
      transactions.push(asTransferLeg(txn, transferId, kind, now));
      extraWrites.push(asTransferLeg(counterpart, transferId, kind, now, tag));
    } else {
      const leg = asTransferLeg(txn, newId(), kind, now);
      transactions.push(leg);
      if (input.recordOtherSide ?? true) {
        extraWrites.push(
          otherSideLeg({
            leg,
            otherAccount: other,
            thisAccount: account,
            now,
            importBatchId: batchId,
            note: `Recorded from the import of ${prepared.fileName ?? 'a statement'} into ${account.name}`.slice(
              0,
              1000,
            ),
          }),
        );
      }
    }
  }

  // A pending transaction has posted: bring it up to date in place (undo reverts it to pending).
  const postedTag = postedByTag(batchId);
  const postedUpdates: Transaction[] = [];
  for (const { row: r, pending: t } of posting) {
    const categoryId = t.categoryId ?? categoryFor(r);
    const tags = t.tags.filter((g) => !g.startsWith(PREVIOUS_DATE_TAG) && !g.startsWith('pp:'));
    if (r.transactionAt && !tags.includes(transactionTimeTag(r.transactionAt))) {
      tags.push(transactionTimeTag(r.transactionAt));
    }
    tags.push(postedTag, `${PREVIOUS_DATE_TAG}${t.date}`);
    postedUpdates.push({
      ...t,
      date: r.date!,
      description: r.description.slice(0, 200),
      originalDescription: r.raw.join(' | ').slice(0, 500),
      categoryId,
      status: categoryId ? 'posted' : 'needs_review',
      fingerprint: r.fingerprint!,
      tags: tags.slice(-20),
      updatedAt: now,
    });
  }

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
    await store.transactions.bulkPut([...transactions, ...extraWrites, ...postedUpdates]);
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
  return {
    batch,
    created: transactions.length,
    categorised: transactions.filter((t) => t.type !== 'transfer' && t.categoryId).length,
    transfers: transferCount,
    postedPending: postedUpdates.length,
    pending: transactions.filter((t) => t.status === 'pending').length,
    needsReview: [...transactions, ...postedUpdates].filter((t) => t.status === 'needs_review')
      .length,
  };
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
    // Transactions this import turned into transfer legs go back to ordinary income/expense
    // (uncategorised, marked for review).
    const tag = convertedByTag(batchId);
    const all = await store.transactions.list();
    const converted = all.filter((t) => t.tags.includes(tag));
    if (converted.length > 0) {
      await store.transactions.bulkPut(converted.map((t) => revertTransferLeg(t, now, tag)));
    }
    // Pending transactions this import marked as posted go back to pending, on their old date.
    const posted = postedByTag(batchId);
    const reverted = all
      .filter((t) => t.tags.includes(posted))
      .map((t) => {
        const previous = t.tags.find((g) => g.startsWith(PREVIOUS_DATE_TAG))?.slice(3);
        return {
          ...t,
          status: 'pending' as const,
          ...(previous ? { date: previous } : {}),
          tags: t.tags.filter((g) => g !== posted && !g.startsWith(PREVIOUS_DATE_TAG)),
          updatedAt: now,
        };
      });
    if (reverted.length > 0) await store.transactions.bulkPut(reverted);
    await store.importBatches.put({ ...batch, status: 'undone', undoneAt: now, updatedAt: now });
  });
  return removed;
}

/** How many of a batch's transactions were edited after import (shown before undoing). */
export async function editedSinceImport(store: FinanceStore, batchId: string): Promise<number> {
  const txns = await store.transactions.byImportBatch(batchId);
  return txns.filter((t) => t.updatedAt !== t.createdAt).length;
}
