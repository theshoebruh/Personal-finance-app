/**
 * Money is always held as integer cents (ZAR). Never use floating point for persisted values.
 */
export type Cents = number;

export const ZAR_LOCALE = 'en-ZA';

export function assertCents(value: number): Cents {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`Money must be an integer number of cents, got ${value}`);
  }
  return value;
}

/** Sum integer cents safely. */
export function sumCents(values: readonly Cents[]): Cents {
  let total = 0;
  for (const v of values) total += assertCents(v);
  return assertCents(total);
}

/**
 * Integer percentage of an amount, rounded half away from zero to the nearest cent.
 * `percent` may have up to 2 decimal places (e.g. 12.5).
 */
export function percentOf(amount: Cents, percent: number): Cents {
  assertCents(amount);
  // Work in basis points so 12.5% stays exact.
  const bps = Math.round(percent * 100);
  return divideRounded(amount * bps, 10000);
}

/** Integer division rounded half away from zero. */
export function divideRounded(numerator: number, denominator: number): Cents {
  if (denominator === 0) throw new Error('Division by zero');
  const sign = Math.sign(numerator) * Math.sign(denominator);
  const q = Math.floor(
    (Math.abs(numerator) * 2 + Math.abs(denominator)) / (Math.abs(denominator) * 2),
  );
  return sign * q === 0 ? 0 : sign * q;
}

/**
 * Parse a user-entered or imported ZAR amount into cents.
 * Accepts "1234.56", "1 234,56", "R1,234.56", "-R 50", "(50.00)".
 * Returns null when the text is not an unambiguous amount.
 */
export function parseAmountToCents(input: string): Cents | null {
  let s = input.trim();
  if (s === '') return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1).trim();
  }
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1).trim();
  } else if (s.startsWith('+')) {
    s = s.slice(1).trim();
  }
  s = s.replace(/^R\s*/i, '');
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1).trim();
  }
  // Remove spaces (incl. NBSP) used as thousands separators.
  s = s.replace(/[\s\u00a0\u202f]/g, '');
  if (!/^[\d.,]+$/.test(s)) return null;

  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  let intPart: string;
  let fracPart = '';
  const decimalIndex = Math.max(lastDot, lastComma);
  if (decimalIndex >= 0 && s.length - decimalIndex - 1 <= 2 && s.length - decimalIndex - 1 > 0) {
    intPart = s.slice(0, decimalIndex);
    fracPart = s.slice(decimalIndex + 1);
  } else {
    intPart = s;
  }
  // Remaining separators in the integer part must be thousands groupings of 3.
  if (/[.,]/.test(intPart)) {
    if (!/^\d{1,3}([.,]\d{3})+$/.test(intPart)) return null;
    intPart = intPart.replace(/[.,]/g, '');
  }
  if (intPart === '') intPart = '0';
  if (!/^\d+$/.test(intPart) || !/^\d*$/.test(fracPart)) return null;
  const cents = Number(intPart) * 100 + Number(fracPart.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents)) return null;
  return negative && cents !== 0 ? -cents : cents;
}

const formatter = new Intl.NumberFormat(ZAR_LOCALE, {
  style: 'currency',
  currency: 'ZAR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Format cents as a ZAR currency string, e.g. "R 1 234,56" (en-ZA conventions). */
export function formatZAR(cents: Cents): string {
  return formatter.format(cents / 100);
}

const wholeFormatter = new Intl.NumberFormat(ZAR_LOCALE, {
  style: 'currency',
  currency: 'ZAR',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

/** Format cents rounded to whole rand, for compact chart labels, e.g. "R 1 235". */
export function formatZARWhole(cents: Cents): string {
  return wholeFormatter.format(Math.round(cents / 100));
}

/** Plain decimal string for inputs/exports, e.g. 123456 -> "1234.56". */
export function centsToDecimalString(cents: Cents): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}
