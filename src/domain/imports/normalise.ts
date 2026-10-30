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
    /**
     * Optional bank-fee column (e.g. Capitec's "Fee"). Fees are always money out. Missing in
     * mappings saved before fees were supported, which means "not used".
     */
    feeColumn: z.number().int().min(0).nullable().optional(),
    /**
     * Optional bank category columns (e.g. Capitec's "Category" and "Parent Category"), used to
     * suggest one of your categories. Missing in older saved mappings, which means "not used".
     */
    categoryColumn: z.number().int().min(0).nullable().optional(),
    parentCategoryColumn: z.number().int().min(0).nullable().optional(),
    /**
     * Optional "Transaction Date" column when the main date is the posting date (e.g. Capitec). Its
     * text (often with a time) stays the same when a pending card purchase later posts, so it is
     * used to recognise the posted version. Missing in older saved mappings, meaning "not used".
     */
    transactionDateColumn: z.number().int().min(0).nullable().optional(),
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
  /**
   * Bank fee charged on the same line as another amount (negative), or null. A line with only a
   * fee has the fee as its `amountCents` instead.
   */
  feeCents?: Cents | null;
  /** True for the separate fee transaction split off a line that had both an amount and a fee. */
  splitFee?: boolean;
  /** The bank's own category names for this line, most specific first (may be empty). */
  bankCategories?: string[];
  /**
   * Not final yet at the bank: marked "(Pending)" in the description, or without a running balance
   * when the other lines have one. Imported as pending (not in the posted balance).
   */
  pending?: boolean;
  /** The bank's transaction date/time text (see `transactionDateColumn`), or null. */
  transactionAt?: string | null;
  /**
   * The day you actually spent (from `transactionAt`), when the main date is the posting date. A
   * purchase on the 28th that the bank posts on the 30th belongs to the 28th.
   */
  transactionDate?: IsoDate | null;
  errors: string[];
}

/** "(Pending) " at the start of a description, as some banks show card purchases not yet final. */
const PENDING_PREFIX = /^\s*\(\s*pending\s*\)\s*[:-]?\s*/i;

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
    const joined = parts
      .map((p) => p.trim())
      .filter(Boolean)
      .join(' · ');
    const markedPending = PENDING_PREFIX.test(joined);
    const description = joined.replace(PENDING_PREFIX, '');
    if (!description) errors.push('Missing description');

    // Fees are always money out, whatever sign the bank uses; a zero fee means no fee.
    const feeColumn = mapping.feeColumn ?? null;
    const feeCell = feeColumn !== null ? amountCell(raw[feeColumn]) : { cents: null, blank: true };
    let fee: Cents | null = null;
    if (!feeCell.blank && feeCell.cents === null)
      errors.push(`Unreadable fee "${raw[feeColumn!]}"`);
    else if (feeCell.cents) fee = -Math.abs(feeCell.cents);

    let amount: Cents | null = null;
    /** True when the line has no amount of its own (only a fee is allowed then). */
    let amountBlank = false;
    if (mapping.amountMode === 'signed' && mapping.amountColumn !== null) {
      const a = amountCell(raw[mapping.amountColumn]);
      if (a.blank) amountBlank = true;
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
        amountBlank = true;
      } else if (!debit.blank && !credit.blank && debit.cents !== 0 && credit.cents !== 0) {
        errors.push('Both debit and credit have a value');
      } else {
        // Debits are money out regardless of how the bank signs them.
        amount =
          !debit.blank && debit.cents !== 0 ? -Math.abs(debit.cents!) : Math.abs(credit.cents ?? 0);
      }
    }
    if (amount !== null && mapping.invertSign) amount = -amount;
    let feeCents: Cents | null = null;
    if ((amountBlank || amount === 0) && fee !== null) {
      // A line that is only a bank fee (e.g. an SMS notification fee) imports as that fee.
      amount = fee;
    } else if (amountBlank) {
      errors.push('Missing amount');
    } else if (amount === 0) {
      errors.push('Amount is zero');
      amount = null;
    } else {
      feeCents = fee;
    }

    const reference =
      mapping.referenceColumn !== null ? (raw[mapping.referenceColumn] ?? '').trim() || null : null;
    let balance: Cents | null = null;
    if (mapping.balanceColumn !== null) {
      const b = amountCell(raw[mapping.balanceColumn]);
      balance = b.cents;
    }
    const tdColumn = mapping.transactionDateColumn ?? null;
    const transactionAt = tdColumn !== null ? (raw[tdColumn] ?? '').trim() || null : null;
    const transactionDate = transactionAt && format ? parseDate(transactionAt, format) : null;
    const bankCategories = [mapping.categoryColumn, mapping.parentCategoryColumn]
      .map((c) => (c != null ? (raw[c] ?? '').trim() : ''))
      .filter(Boolean);
    return {
      line: i + offset,
      raw,
      bankCategories,
      date,
      description,
      amountCents: amount,
      reference,
      balanceCents: balance,
      feeCents,
      pending: markedPending,
      transactionAt,
      transactionDate,
      errors,
    };
  });
  // A line without a running balance when (nearly) all the others have one hasn't settled yet.
  if (mapping.balanceColumn !== null) {
    const valid = out.filter((r) => r.errors.length === 0);
    const withBalance = valid.filter((r) => r.balanceCents !== null).length;
    if (valid.length >= 3 && withBalance >= (valid.length - 1) * 0.8) {
      for (const r of valid) if (r.balanceCents === null) r.pending = true;
    }
  }
  return { rows: out, dateFormatUsed: format, dateFormatAmbiguous: ambiguous };
}

const HEADER_HINTS: Record<string, RegExp> = {
  date: /^(transaction |posting |value |trans\.? )?date$|^date/i,
  description: /desc|narrat|details|particular|merchant|transaction$|^memo$|payee/i,
  amount: /^(amount|value|amount \(zar\)|amount zar|transaction amount)$/i,
  debit: /debit|money out|withdraw|paid out/i,
  credit: /credit|money in|deposit|paid in/i,
  fee: /^(bank )?(fees?|charges?|service (fees?|charges?))$/i,
  category: /^(category|sub[- ]?category|transaction category|spending category)$/i,
  parentCategory: /^(parent category|main category|category group)$/i,
  reference: /^(ref|reference|transaction id|id|cheque|statement ref)/i,
  transactionDate: /^trans(action|\.)? ?date( ?(and|&) ?time)?$|^transaction time$/i,
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
      feeColumn: null,
      categoryColumn: null,
      parentCategoryColumn: null,
      transactionDateColumn: null,
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
  const fee = find('fee', [
    ...used,
    ...[amount, debit, credit].filter((x): x is number => x !== null),
  ]);
  const description = find('description', [
    ...used,
    ...[amount, debit, credit, fee].filter((x): x is number => x !== null),
  ]);
  const reference = find('reference', [date, description ?? -1]);
  const category = find('category', used);
  const parentCategory = find('parentCategory', used);
  const transactionDate = find('transactionDate', [date]);
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
    feeColumn: fee,
    categoryColumn: category,
    parentCategoryColumn: parentCategory,
    transactionDateColumn: transactionDate,
    referenceColumn: reference,
    balanceColumn: balance,
    dateFormat: 'auto',
    invertSign: false,
  };
}

/**
 * Splits each line that has both an amount and a fee into two rows: the amount, then a separate
 * "Fee: …" row for the fee, so fees can be categorised and counted on their own. Lines without a
 * fee are returned unchanged. Run this after the running-balance check, which needs whole lines.
 */
export function splitFees(rows: readonly NormalisedRow[]): NormalisedRow[] {
  return rows.flatMap((r) => {
    if (r.feeCents == null || r.errors.length > 0) return [r];
    return [
      { ...r, feeCents: null, balanceCents: null },
      {
        ...r,
        description: `Fee: ${r.description}`,
        amountCents: r.feeCents,
        feeCents: null,
        reference: r.reference ? `${r.reference} (fee)` : null,
        splitFee: true,
      },
    ];
  });
}
