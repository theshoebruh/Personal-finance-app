import type { Account, Transaction } from '../models';
import { normaliseText } from '../calculations/recurring';
import { type ColumnMapping, type DateFormat, normaliseRows } from './normalise';
import { type BalanceCheck, type StagedRow, checkRunningBalance, stageRows } from './staging';

export interface Staging {
  mapping: ColumnMapping;
  columnCount: number;
  rows: StagedRow[];
  dateFormatUsed: Exclude<DateFormat, 'auto'> | null;
  dateFormatAmbiguous: boolean;
  balanceCheck: BalanceCheck | null;
  /** Problems with the mapping itself (e.g. a column that doesn't exist in this file). */
  mappingErrors: string[];
}

export function headerSignature(rows: readonly string[][]): string {
  return (rows[0] ?? [])
    .map((h) => normaliseText(h))
    .join('|')
    .slice(0, 2000);
}

function mappedColumns(m: ColumnMapping): number[] {
  return [
    m.dateColumn,
    m.descriptionColumn,
    m.extraDescriptionColumn,
    m.amountMode === 'signed' ? m.amountColumn : null,
    m.amountMode === 'debit_credit' ? m.debitColumn : null,
    m.amountMode === 'debit_credit' ? m.creditColumn : null,
    m.referenceColumn,
    m.balanceColumn,
  ].filter((c): c is number => c !== null);
}

/** Pure staging pipeline: normalise with a mapping, then classify against existing transactions. */
export function buildStaging(
  rows: readonly string[][],
  mapping: ColumnMapping,
  account: Account,
  existing: readonly Transaction[],
): Staging {
  const columnCount = Math.max(0, ...rows.map((r) => r.length));
  const mappingErrors: string[] = [];
  if (mappedColumns(mapping).some((c) => c >= columnCount)) {
    mappingErrors.push('A mapped column does not exist in this file. Check the column choices.');
  }
  if (mapping.amountMode === 'signed' && mapping.amountColumn === null) {
    mappingErrors.push('Choose the amount column.');
  }
  if (
    mapping.amountMode === 'debit_credit' &&
    mapping.debitColumn === null &&
    mapping.creditColumn === null
  ) {
    mappingErrors.push('Choose the debit and/or credit columns.');
  }
  if (mapping.hasHeader && rows.length < 2)
    mappingErrors.push('The file has a header row but no transactions.');
  if (mappingErrors.length > 0) {
    return {
      mapping,
      columnCount,
      rows: [],
      dateFormatUsed: null,
      dateFormatAmbiguous: false,
      balanceCheck: null,
      mappingErrors,
    };
  }
  const n = normaliseRows(rows, mapping);
  return {
    mapping,
    columnCount,
    rows: stageRows(n.rows, account.id, existing),
    dateFormatUsed: n.dateFormatUsed,
    dateFormatAmbiguous: n.dateFormatAmbiguous,
    balanceCheck: checkRunningBalance(n.rows),
    mappingErrors,
  };
}
