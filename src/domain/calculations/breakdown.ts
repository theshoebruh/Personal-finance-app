import type { Cents } from '../money';

export interface BreakdownSlice {
  /** Category id, `null` for uncategorised, or `'other'` for the folded remainder. */
  key: string;
  categoryId: string | null;
  label: string;
  cents: Cents;
  /** How many categories the slice covers (more than one only for "Other"). */
  count: number;
}

export interface Breakdown {
  slices: BreakdownSlice[];
  /** Sum of all positive amounts (the slices add up to this). */
  totalCents: Cents;
}

/**
 * Shapes a per-category spending map (e.g. from `spendingByCategory`) for a donut chart: positive
 * amounts only, largest first, with everything past `maxSlices − 1` folded into one "Other" slice
 * so a chart never needs more colours than it has.
 */
export function categoryBreakdown(
  spending: Iterable<readonly [string | null, Cents]>,
  nameOf: (categoryId: string | null) => string,
  maxSlices = 6,
): Breakdown {
  const positive = [...spending]
    .filter(([, cents]) => cents > 0)
    .sort((a, b) => b[1] - a[1] || nameOf(a[0]).localeCompare(nameOf(b[0])));
  const totalCents = positive.reduce((sum, [, cents]) => sum + cents, 0);
  const keep = positive.length <= maxSlices ? positive : positive.slice(0, maxSlices - 1);
  const rest = positive.slice(keep.length);
  const slices: BreakdownSlice[] = keep.map(([id, cents]) => ({
    key: id ?? 'uncategorised',
    categoryId: id,
    label: nameOf(id),
    cents,
    count: 1,
  }));
  if (rest.length > 0) {
    slices.push({
      key: 'other',
      categoryId: null,
      label: `Other (${rest.length})`,
      cents: rest.reduce((sum, [, cents]) => sum + cents, 0),
      count: rest.length,
    });
  }
  return { slices, totalCents };
}
