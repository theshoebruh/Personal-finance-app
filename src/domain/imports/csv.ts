import Papa from 'papaparse';

/** Hard limits so a wrong or hostile file cannot freeze the app. */
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_ROWS = 10_000;
export const MAX_CELL_LENGTH = 500;

export interface ParsedCsv {
  /** Every row as raw strings (header row included when present). */
  rows: string[][];
  delimiter: string;
  /** Parser-level problems, e.g. unmatched quotes. */
  warnings: string[];
  /** Neutral information about how the file was read, e.g. which Excel sheet. */
  note?: string;
}

export class CsvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CsvError';
  }
}

// Control characters (except tab) have no place in statement text.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

/** Imported text is untrusted: strip control characters, collapse whitespace and cap the length. */
export function sanitiseCell(value: string): string {
  return value.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_CELL_LENGTH);
}

/**
 * Parse CSV text, including CSV saved from Excel (UTF-8 BOM, comma or semicolon delimiters,
 * quoted fields). Blank lines are dropped. Throws a readable CsvError when nothing usable is found.
 */
export function parseCsv(text: string): ParsedCsv {
  // Excel's "CSV UTF-8" starts with a byte-order mark (U+FEFF).
  const cleaned = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (cleaned.trim() === '') throw new CsvError('The file is empty.');
  const result = Papa.parse<string[]>(cleaned, {
    skipEmptyLines: 'greedy',
    delimitersToGuess: [',', ';', '\t', '|'],
  });
  const warnings = result.errors
    .filter((e) => e.type !== 'Delimiter')
    .slice(0, 5)
    .map((e) => `Row ${(e.row ?? 0) + 1}: ${e.message}`);
  return finaliseRows(result.data, result.meta.delimiter, warnings, 'CSV');
}

/**
 * Shared by CSV and Excel: sanitise every cell, drop blank rows and enforce the row/column limits,
 * so both formats feed the same review steps with the same safety checks.
 */
export function finaliseRows(
  raw: readonly (readonly unknown[])[],
  delimiter: string,
  warnings: string[],
  kind: 'CSV' | 'spreadsheet',
): ParsedCsv {
  const rows = raw
    .map((r) => r.map((c) => sanitiseCell(String(c ?? ''))))
    .filter((r) => r.some((c) => c !== ''));
  if (rows.length === 0) throw new CsvError('No rows could be read from this file.');
  if (rows.length > MAX_ROWS + 1) {
    throw new CsvError(
      `This file has more than ${MAX_ROWS.toLocaleString('en-ZA')} rows. Split it into smaller files.`,
    );
  }
  const maxCols = Math.max(...rows.map((r) => r.length));
  if (maxCols < 2) {
    throw new CsvError(`Only one column was found. This does not look like a transaction ${kind}.`);
  }
  return { rows, delimiter, warnings };
}
