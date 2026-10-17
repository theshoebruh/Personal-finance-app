import type { TransferSuggestion } from './transfers';
import type { Account, Transaction } from '../models';
import { type IsoDate, diffDays } from '../dates';
import type { Cents } from '../money';
import { normaliseText } from '../calculations/recurring';
import type { NormalisedRow } from './normalise';

export type StagedStatus = 'new' | 'duplicate' | 'possible_duplicate' | 'invalid';

export interface DuplicateMatch {
  transactionId: string;
  description: string;
  date: IsoDate;
  amountCents: Cents;
  reason: 'same_fingerprint' | 'manual_entry_match';
}

export interface StagedRow extends NormalisedRow {
  index: number;
  status: StagedStatus;
  fingerprint: string | null;
  /** Default decision; the user can change it for any valid row. */
  include: boolean;
  duplicateOf?: DuplicateMatch;
  /** Other lines in this file that look identical (e.g. two same-day coffees). Kept, but flagged. */
  identicalLines: number[];
  /** Why this row may be a transfer between your own accounts (see transfers.ts). */
  transferSuggestion?: TransferSuggestion | null;
  /** The user's choice: import as a transfer with this account, or null for income/expense. */
  transferAccountId?: string | null;
}

/** Days either side within which a manually entered transaction is treated as a possible match. */
export const MANUAL_MATCH_WINDOW_DAYS = 3;

/**
 * Duplicate fingerprint: account, date, amount, normalised description and — when the bank supplies
 * one — its transaction reference. Identical same-day purchases without a reference share a
 * fingerprint, so duplicates are counted per fingerprint rather than collapsed.
 */
export function transactionFingerprint(
  accountId: string,
  date: IsoDate,
  amountCents: Cents,
  description: string,
  reference: string | null = null,
): string {
  const ref = reference ? `|${normaliseText(reference)}` : '';
  return `v1|${accountId}|${date}|${amountCents}|${normaliseText(description).slice(0, 120)}${ref}`;
}

function existingFingerprint(t: Transaction): string {
  return (
    t.fingerprint ??
    transactionFingerprint(
      t.accountId,
      t.date,
      t.amountCents,
      t.originalDescription ?? t.description,
    )
  );
}

/**
 * Classify normalised rows for review:
 * - invalid: unreadable date/amount/description — never imported.
 * - duplicate: same fingerprint as an existing transaction in this account (re-imported or
 *   overlapping statements). Each existing transaction absorbs at most one row, so a file with two
 *   identical purchases against one already recorded leaves one of them as new. Unticked by default.
 * - possible_duplicate: same amount within a few days of a manually entered transaction that has no
 *   import fingerprint. Unticked by default so a manual entry and its statement line are not both
 *   counted; the user can include it.
 * - new: ticked by default. Identical rows within the file stay included but are flagged.
 */
export function stageRows(
  rows: readonly NormalisedRow[],
  accountId: string,
  existing: readonly Transaction[],
): StagedRow[] {
  const inAccount = existing.filter((t) => t.accountId === accountId && !t.archived);
  const byFingerprint = new Map<string, Transaction[]>();
  for (const t of inAccount) {
    const fp = existingFingerprint(t);
    const list = byFingerprint.get(fp) ?? [];
    list.push(t);
    byFingerprint.set(fp, list);
  }
  const manual = inAccount.filter((t) => t.source === 'manual' && !t.fingerprint);
  const consumed = new Set<string>();

  const staged: StagedRow[] = rows.map((r, index) => {
    const valid = r.errors.length === 0 && r.date !== null && r.amountCents !== null;
    if (!valid) {
      return {
        ...r,
        index,
        status: 'invalid',
        fingerprint: null,
        include: false,
        identicalLines: [],
      };
    }
    const fp = transactionFingerprint(
      accountId,
      r.date!,
      r.amountCents!,
      r.description,
      r.reference,
    );
    const exact = byFingerprint.get(fp)?.find((t) => !consumed.has(t.id));
    if (exact) {
      consumed.add(exact.id);
      return {
        ...r,
        index,
        status: 'duplicate',
        fingerprint: fp,
        include: false,
        duplicateOf: {
          transactionId: exact.id,
          description: exact.description,
          date: exact.date,
          amountCents: exact.amountCents,
          reason: 'same_fingerprint',
        },
        identicalLines: [],
      };
    }
    const candidates = manual
      .filter(
        (t) =>
          !consumed.has(t.id) &&
          t.amountCents === r.amountCents &&
          Math.abs(diffDays(t.date, r.date!)) <= MANUAL_MATCH_WINDOW_DAYS,
      )
      .sort((a, b) => Math.abs(diffDays(a.date, r.date!)) - Math.abs(diffDays(b.date, r.date!)));
    const near = candidates[0];
    if (near) {
      consumed.add(near.id);
      return {
        ...r,
        index,
        status: 'possible_duplicate',
        fingerprint: fp,
        include: false,
        duplicateOf: {
          transactionId: near.id,
          description: near.description,
          date: near.date,
          amountCents: near.amountCents,
          reason: 'manual_entry_match',
        },
        identicalLines: [],
      };
    }
    return { ...r, index, status: 'new', fingerprint: fp, include: true, identicalLines: [] };
  });

  // Flag identical rows within the file (same fingerprint) without dropping any.
  const groups = new Map<string, StagedRow[]>();
  for (const s of staged) {
    if (!s.fingerprint) continue;
    const g = groups.get(s.fingerprint) ?? [];
    g.push(s);
    groups.set(s.fingerprint, g);
  }
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    for (const s of g) s.identicalLines = g.filter((o) => o !== s).map((o) => o.line);
  }
  return staged;
}

export interface BalanceCheck {
  /** Consecutive row pairs with both an amount and a balance. */
  pairsChecked: number;
  /** Pairs where balance changes by exactly the amount. */
  consistentPairs: number;
  /** Pairs that only agree if the amount signs are flipped. */
  invertedPairs: number;
  order: 'oldest_first' | 'newest_first' | 'unknown';
  /** Statement closing balance (latest row), when it can be identified. */
  closing: { date: IsoDate; balanceCents: Cents } | null;
  suggestInvertSign: boolean;
}

/**
 * Uses the statement's running-balance column (if mapped) to sanity-check signs and find the
 * closing balance. Purely advisory — it never changes amounts by itself.
 */
export function checkRunningBalance(rows: readonly NormalisedRow[]): BalanceCheck | null {
  const usable = rows.filter(
    (r) => r.errors.length === 0 && r.balanceCents !== null && r.amountCents !== null && r.date,
  );
  if (usable.length < 2) return null;
  const score = (sign: 1 | -1) => {
    let asc = 0;
    let desc = 0;
    for (let i = 0; i + 1 < usable.length; i++) {
      const a = usable[i]!;
      const b = usable[i + 1]!;
      if (b.balanceCents! - a.balanceCents! === sign * b.amountCents! + (b.feeCents ?? 0)) asc++;
      if (a.balanceCents! - b.balanceCents! === sign * a.amountCents! + (a.feeCents ?? 0)) desc++;
    }
    return { asc, desc };
  };
  const normal = score(1);
  const flipped = score(-1);
  const pairs = usable.length - 1;
  const bestNormal = Math.max(normal.asc, normal.desc);
  const bestFlipped = Math.max(flipped.asc, flipped.desc);
  const useFlipped = bestFlipped > bestNormal;
  const s = useFlipped ? flipped : normal;
  const best = Math.max(s.asc, s.desc);
  let order: BalanceCheck['order'] = 'unknown';
  if (best > 0 && best >= pairs * 0.6) order = s.asc >= s.desc ? 'oldest_first' : 'newest_first';
  if (order === 'unknown') {
    const first = usable[0]!.date!;
    const last = usable[usable.length - 1]!.date!;
    if (first < last) order = 'oldest_first';
    else if (first > last) order = 'newest_first';
  }
  const closingRow =
    order === 'oldest_first'
      ? usable[usable.length - 1]!
      : order === 'newest_first'
        ? usable[0]!
        : null;
  return {
    pairsChecked: pairs,
    consistentPairs: bestNormal,
    invertedPairs: bestFlipped,
    order,
    closing: closingRow ? { date: closingRow.date!, balanceCents: closingRow.balanceCents! } : null,
    suggestInvertSign: useFlipped && bestFlipped >= pairs * 0.6,
  };
}

export interface RepeatedImport {
  accountId: string;
  fingerprint: string;
  description: string;
  date: IsoDate;
  amountCents: Cents;
  /** Copies across all import batches. */
  copies: number;
  /** Most copies inside any single file (identical same-day rows that are genuinely separate). */
  maxInOneFile: number;
}

/**
 * Finds imported rows that appear in two or more import batches more often than in any single
 * file — typically the same statement imported on two devices while offline, which the per-device
 * duplicate check could not see. Advisory: the user decides what to archive.
 */
export function findRepeatedImports(transactions: readonly Transaction[]): RepeatedImport[] {
  const groups = new Map<string, Transaction[]>();
  for (const t of transactions) {
    if (t.archived || !t.fingerprint || !t.importBatchId || t.source === 'manual') continue;
    const key = `${t.accountId}|${t.fingerprint}`;
    const g = groups.get(key) ?? [];
    g.push(t);
    groups.set(key, g);
  }
  const out: RepeatedImport[] = [];
  for (const g of groups.values()) {
    const perBatch = new Map<string, number>();
    for (const t of g) perBatch.set(t.importBatchId!, (perBatch.get(t.importBatchId!) ?? 0) + 1);
    const maxInOneFile = Math.max(...perBatch.values());
    if (perBatch.size >= 2 && g.length > maxInOneFile) {
      const first = g[0]!;
      out.push({
        accountId: first.accountId,
        fingerprint: first.fingerprint!,
        description: first.description,
        date: first.date,
        amountCents: first.amountCents,
        copies: g.length,
        maxInOneFile,
      });
    }
  }
  return out;
}

export interface StagingSummary {
  totalRows: number;
  invalid: number;
  duplicates: number;
  possibleDuplicates: number;
  newRows: number;
  identicalInFile: number;
  selected: number;
  selectedInCents: Cents;
  selectedOutCents: Cents;
  dateRange: { from: IsoDate; to: IsoDate } | null;
  /** Selected rows dated before the account's opening-balance date (they won't change its balance). */
  beforeOpeningDate: number;
  /** Selected rows that will be imported as transfers between your own accounts. */
  transfers: number;
  /** Rows with a transfer suggestion the user hasn't accepted. */
  possibleTransfers: number;
}

export function summariseStaging(rows: readonly StagedRow[], account: Account): StagingSummary {
  const valid = rows.filter((r) => r.status !== 'invalid');
  const dates = valid.map((r) => r.date!).sort();
  const selected = rows.filter((r) => r.include && r.status !== 'invalid');
  return {
    totalRows: rows.length,
    invalid: rows.length - valid.length,
    duplicates: rows.filter((r) => r.status === 'duplicate').length,
    possibleDuplicates: rows.filter((r) => r.status === 'possible_duplicate').length,
    newRows: rows.filter((r) => r.status === 'new').length,
    // Only new rows: identical rows that are already-imported duplicates are skipped anyway.
    identicalInFile: rows.filter((r) => r.status === 'new' && r.identicalLines.length > 0).length,
    selected: selected.length,
    selectedInCents: selected.reduce((s, r) => s + Math.max(0, r.amountCents!), 0),
    selectedOutCents: selected.reduce((s, r) => s + Math.max(0, -r.amountCents!), 0),
    dateRange: dates.length ? { from: dates[0]!, to: dates[dates.length - 1]! } : null,
    beforeOpeningDate: selected.filter((r) => r.date! < account.openingBalanceDate).length,
    transfers: selected.filter((r) => r.transferAccountId).length,
    possibleTransfers: selected.filter((r) => r.transferSuggestion && !r.transferAccountId).length,
  };
}
