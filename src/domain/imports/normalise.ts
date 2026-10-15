import { z } from 'zod';
import { type IsoDate, isIsoDate } from '../dates';
import { type Cents, parseAmountToCents } from '../money';

export const DATE_FORMATS = [
  'auto',
  'YYYY-MM-DD',
  'DD/MM/YYYY',
  'MM/DD/YYYY',
  'D MMM YYYY',
] as const;
export type DateFormat = (typeof DATE_FORMATS)[number];
export const DATE_FORMAT_LABELS: Record<DateFormat, string> = {
  auto: 'Detect automatically',
  'YYYY-MM-DD': 'Year-month-day (2026-03-15, 2026/03/15)',
  'DD/MM/YYYY': 'Day/month/year (15/03/2026)',
  'MM/DD/YYYY': 'Month/day/year (03/15/2026)',
  'D MMM YYYY': 'Day month-name year (15 Mar 2026)',
};

/** How the columns of a statement map onto transaction fields. Column values are 0-based indexes. */
export const columnMappingSchema = z
  .object({
    hasHeader: z.boolean(),
    dateColumn: z.number().int().min(0),
    descriptionColumn: z.number().int().min(0),
    /** Optional second description column (e.g. "Reference" or "Details"), appended. */
    extraDescriptionColumn: z.number().int().min(0).nullable(),
    amountMode: z.enum(['signed', 'debit_credit']),
    amountColumn: z.number().int().min(0).nullable(),
    debitColumn: z.number().int().min(0).nullable(),
    creditColumn: z.number().int().min(0).nullable(),
    /** Bank transaction ID / reference, used to tell identical same-day transactions apart. */
    referenceColumn: z.number().int().min(0).nullable(),
    balanceColumn: z.number().int().min(0).nullable(),
    dateFormat: z.enum(DATE_FORMATS),
    /** Flip signs for statements that show money out as positive (e.g. some credit cards). */
    invertSign: z.boolean(),
  })
  .refine(
    (m) =>
      m.amountMode === 'signed'
        ? m.amountColumn !== null
        : m.debitColumn !== null || m.creditColumn !== null,
    {
      message: 'Choose the amount column(s)',
    },
  );
export type ColumnMapping = z.infer<typeof columnMappingSchema>;

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  sept: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

function iso(y: number, m: number, d: number): IsoDate | null {
  if (y < 100) y += 2000;
  const s = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return isIsoDate(s) ? s : null;
}

/** Parse one date cell in a given format. Any time-of-day part is ignored. */
export function parseDate(raw: string, format: Exclude<DateFormat, 'auto'>): IsoDate | null {
  const s = raw.trim().replace(/[T\s]+\d{1,2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/i, '');
  if (format === 'YYYY-MM-DD') {
    const m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s);
    return m ? iso(+m[1]!, +m[2]!, +m[3]!) : null;
  }
  if (format === 'D MMM YYYY') {
    const m = /^(\d{1,2})[\s-]+([A-Za-z]{3,9})\.?[\s-]+(\d{2,4})$/.exec(s);
    if (!m) return null;
    const month =
      MONTHS[m[2]!.toLowerCase().slice(0, m[2]!.toLowerCase().startsWith('sept') ? 4 : 3)];
    return month ? iso(+m[3]!, month, +m[1]!) : null;
  }
  const m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/.exec(s);
  if (!m) return null;
  const [a, b, y] = [+m[1]!, +m[2]!, +m[3]!];
  return format === 'DD/MM/YYYY' ? iso(y, b, a) : iso(y, a, b);
}

/**
 * Pick the date format that reads the most samples, so one malformed cell doesn't break the whole
 * file (that row is reported as invalid instead). Day/month order is decided by values above 12;
 * when D/M/Y and M/D/Y read the samples equally well, South African day/month/year is assumed and
 * flagged as ambiguous.
 */
export function detectDateFormat(samples: readonly string[]): {
  format: Exclude<DateFormat, 'auto'> | null;
  ambiguous: boolean;
} {
  const values = samples.map((s) => s.trim()).filter(Boolean);
  const count = (f: Exclude<DateFormat, 'auto'>) =>
    values.filter((v) => parseDate(v, f) !== null).length;
  const scores = {
    'YYYY-MM-DD': count('YYYY-MM-DD'),
    'D MMM YYYY': count('D MMM YYYY'),
    'DD/MM/YYYY': count('DD/MM/YYYY'),
    'MM/DD/YYYY': count('MM/DD/YYYY'),
  };
  const best = Math.max(...Object.values(scores));
  if (best === 0) return { format: null, ambiguous: false };
  if (scores['YYYY-MM-DD'] === best) return { format: 'YYYY-MM-DD', ambiguous: false };
  if (scores['D MMM YYYY'] === best) return { format: 'D MMM YYYY', ambiguous: false };
  const dmy = scores['DD/MM/YYYY'];
  const mdy = scores['MM/DD/YYYY'];
  if (dmy === mdy) return { format: 'DD/MM/YYYY', ambiguous: true };
  return { format: dmy > mdy ? 'DD/MM/YYYY' : 'MM/DD/YYYY', ambiguous: false };
}

/** Parse an amount cell; blank means "no value", which is different from invalid. */
function amountCell(raw: string | undefined): { cents: Cents | null; blank: boolean } {
  const s = (raw ?? '').trim();
  if (s === '' || s === '-') return { cents: null, blank: true };
  // Trailing CR/DR markers used by some banks.
  const marker = /\s*(CR|DR)$/i.exec(s);
  const body = marker ? s.slice(0, marker.index) : s;
  const cents = parseAmountToCents(body);
  if (cents === null) return { cents: null, blank: false };
  if (marker?.[1]?.toUpperCase() === 'DR') return { cents: -Math.abs(cents), blank: false };
  if (marker?.[1]?.toUpperCase() === 'CR') return { cents: Math.abs(cents), blank: false };
  return { cents, blank: false };
}

export interface NormalisedRow {
  /** 1-based line number in the file, for messages. */
  line: number;
  raw: string[];
  date: IsoDate | null;
  description: string;
  amountCents: Cents | null;
  reference: string | null;
  balanceCents: Cents | null;
  errors: string[];
}

/**
 * Turn raw rows into normalised candidates. Never guesses: a row with an unreadable date or amount
 * is kept with an error so the user can see it, and is never imported.
 */
export function normaliseRows(
  rows: readonly string[][],
  mapping: ColumnMapping,
): {
  rows: NormalisedRow[];
  dateFormatUsed: Exclude<DateFormat, 'auto'> | null;
  dateFormatAmbiguous: boolean;
} {
  const body = mapping.hasHeader ? rows.slice(1) : rows;
  const offset = mapping.hasHeader ? 2 : 1;
  let format: Exclude<DateFormat, 'auto'> | null;
  let ambiguous = false;
  if (mapping.dateFormat === 'auto') {
    const detected = detectDateFormat(body.map((r) => r[mapping.dateColumn] ?? '').slice(0, 200));
    format = detected.format;
    ambiguous = detected.ambiguous;
  } else {
    format = mapping.dateFormat;
  }

  const out = body.map((raw, i): NormalisedRow => {
    const errors: string[] = [];
    const dateRaw = raw[mapping.dateColumn] ?? '';
    const date = format ? parseDate(dateRaw, format) : null;
    if (!date) errors.push(dateRaw ? `Unreadable date "${dateRaw}"` : 'Missing date');

    const parts = [raw[mapping.descriptionColumn] ?? ''];
    if (mapping.extraDescriptionColumn !== null)
      parts.push(raw[mapping.extraDescriptionColumn] ?? '');
    const description = parts
      .map((p) => p.trim())
      .filter(Boolean)
      .join(' · ');
    if (!description) errors.push('Missing description');

    let amount: Cents | null = null;
    if (mapping.amountMode === 'signed' && mapping.amountColumn !== null) {
      const a = amountCell(raw[mapping.amountColumn]);
      if (a.blank) errors.push('Missing amount');
      else if (a.cents === null) errors.push(`Unreadable amount "${raw[mapping.amountColumn]}"`);
      else amount = a.cents;
    } else {
      const debit =
        mapping.debitColumn !== null
          ? amountCell(raw[mapping.debitColumn])
          : { cents: null, blank: true };
      const credit =
        mapping.creditColumn !== null
          ? amountCell(raw[mapping.creditColumn])
          : { cents: null, blank: true };
      if ((!debit.blank && debit.cents === null) || (!credit.blank && credit.cents === null)) {
        errors.push('Unreadable debit/credit amount');
      } else if (debit.blank && credit.blank) {
        errors.push('Missing amount');
      } else if (!debit.blank && !credit.blank && debit.cents !== 0 && credit.cents !== 0) {
        errors.push('Both debit and credit have a value');
      } else {
        // Debits are money out regardless of how the bank signs them.
        amount =
          !debit.blank && debit.cents !== 0 ? -Math.abs(debit.cents!) : Math.abs(credit.cents ?? 0);
      }
    }
    if (amount !== null && mapping.invertSign) amount = -amount;
    if (amount === 0) {
      errors.push('Amount is zero');
      amount = null;
    }

    const reference =
      mapping.referenceColumn !== null ? (raw[mapping.referenceColumn] ?? '').trim() || null : null;
    let balance: Cents | null = null;
    if (mapping.balanceColumn !== null) {
      const b = amountCell(raw[mapping.balanceColumn]);
      balance = b.cents;
    }
    return {
      line: i + offset,
      raw,
      date,
      description,
      amountCents: amount,
      reference,
      balanceCents: balance,
      errors,
    };
  });
  return { rows: out, dateFormatUsed: format, dateFormatAmbiguous: ambiguous };
}

const HEADER_HINTS: Record<string, RegExp> = {
  date: /^(transaction |posting |value |trans\.? )?date$|^date/i,
  description: /desc|narrat|details|particular|merchant|transaction$|^memo$|payee/i,
  amount: /^(amount|value|amount \(zar\)|amount zar|transaction amount)$/i,
  debit: /debit|money out|withdraw|paid out/i,
  credit: /credit|money in|deposit|paid in/i,
  reference: /^(ref|reference|transaction id|id|cheque|statement ref)/i,
  balance: /balance/i,
};

/** Best-effort first guess at a mapping from a header row. The user always confirms it. */
export function guessMapping(rows: readonly string[][]): ColumnMapping {
  const header = rows[0] ?? [];
  const find = (key: keyof typeof HEADER_HINTS, exclude: number[] = []) => {
    const idx = header.findIndex(
      (h, i) => !exclude.includes(i) && HEADER_HINTS[key]!.test(h.trim()),
    );
    return idx >= 0 ? idx : null;
  };
  const looksLikeHeader =
    header.length > 0 &&
    header.every((h) => parseAmountToCents(h) === null) &&
    find('date') !== null;
  if (!looksLikeHeader) {
    return {
      hasHeader: false,
      dateColumn: 0,
      descriptionColumn: Math.min(1, header.length - 1),
      extraDescriptionColumn: null,
      amountMode: 'signed',
      amountColumn: Math.min(2, header.length - 1),
      debitColumn: null,
      creditColumn: null,
      referenceColumn: null,
      balanceColumn: header.length > 3 ? 3 : null,
      dateFormat: 'auto',
      invertSign: false,
    };
  }
  const date = find('date')!;
  const balance = find('balance');
  const used = [date, ...(balance !== null ? [balance] : [])];
  const amount = find('amount', used);
  const debit = find('debit', used);
  const credit = find('credit', used);
  const description = find('description', [
    ...used,
    ...[amount, debit, credit].filter((x): x is number => x !== null),
  ]);
  const reference = find('reference', [date, description ?? -1]);
  const signed = amount !== null || (debit === null && credit === null);
  return {
    hasHeader: true,
    dateColumn: date,
    descriptionColumn: description ?? (date === 0 ? 1 : 0),
    extraDescriptionColumn: null,
    amountMode: signed ? 'signed' : 'debit_credit',
    amountColumn: signed ? (amount ?? Math.min(2, header.length - 1)) : null,
    debitColumn: signed ? null : debit,
    creditColumn: signed ? null : credit,
    referenceColumn: reference,
    balanceColumn: balance,
    dateFormat: 'auto',
    invertSign: false,
  };
}
