import {
  type Account,
  type AppSettings,
  type Bucket,
  BUCKETS,
  type Category,
  type SpendingBucket,
  type Transaction,
  bucketForGroup,
} from '../models';
import type { IsoDate } from '../dates';
import { type Cents, percentOf } from '../money';
import { savingsMadeInPeriod } from './goals';
import { spendingByCategory, summariseIncomeExpenses } from './reporting';
import { isActual } from './balances';

export const DEFAULT_TARGETS: Record<Bucket, number> = {
  needs: 50,
  wants: 20,
  savings: 20,
  rf: 5,
  buffer: 5,
};

type TargetSettings = Pick<
  AppSettings,
  'savingsRatePercent' | 'needsPercent' | 'wantsPercent' | 'sideBusinessPercent' | 'bufferPercent'
>;

/** Target % of income per group, with defaults for unset values. */
export function bucketTargets(settings: TargetSettings): Record<Bucket, number> {
  return {
    needs: settings.needsPercent ?? DEFAULT_TARGETS.needs,
    wants: settings.wantsPercent ?? DEFAULT_TARGETS.wants,
    savings: settings.savingsRatePercent,
    rf: settings.sideBusinessPercent ?? DEFAULT_TARGETS.rf,
    buffer: settings.bufferPercent ?? DEFAULT_TARGETS.buffer,
  };
}

export interface CategoryAmount {
  categoryId: string;
  name: string;
  cents: Cents;
}

export interface BucketLine {
  bucket: Bucket;
  /** Money in this group this period (Buffer: income − all spending; can be negative). */
  actualCents: Cents;
  targetPercent: number;
  /** targetPercent of income. */
  targetCents: Cents;
  /** Actual as % of income; null when there is no income yet. */
  actualPercent: number | null;
  /** Spending groups: target − actual (negative = over). Buffer: actual − target. */
  leftCents: Cents;
  /** Spending per category, largest first (empty for Buffer). */
  categories: CategoryAmount[];
}

export interface BucketSummary {
  start: IsoDate;
  end: IsoDate;
  incomeCents: Cents;
  incomeByCategory: CategoryAmount[];
  /** All spending: the four spending groups plus uncategorised. */
  expenseCents: Cents;
  /** income − expenses (= Buffer). */
  leftCents: Cents;
  lines: BucketLine[];
  /** Spending without a category (counted in expenses, not in any group). */
  uncategorisedCents: Cents;
  /** Savings moved by transfer from a spendable account into a savings account. */
  savingsTransfersCents: Cents;
  /** Sum of the five targets; should be 100. */
  targetTotalPercent: number;
}

/**
 * The five-group view of a period, like a monthly budget sheet:
 * - Income: income transactions (refunds reduce spending in their category instead).
 * - Needs / Wants / RF: net spending in categories of that group.
 * - Savings: spending in Savings categories plus transfers from a spendable account into a
 *   non-spendable one (e.g. into a 7-day account). Other transfers between your own accounts are
 *   neither income nor spending.
 * - Buffer: what's left (income − all spending, including uncategorised).
 * Targets are % of this period's income; "left" is target − actual.
 */
export function bucketSummary(input: {
  settings: TargetSettings;
  categories: readonly Category[];
  accounts: readonly Account[];
  transactions: readonly Transaction[];
  start: IsoDate;
  end: IsoDate;
}): BucketSummary {
  const { categories, transactions, start, end } = input;
  const targets = bucketTargets(input.settings);
  const byId = new Map(categories.map((c) => [c.id, c]));
  const summary = summariseIncomeExpenses(transactions, 'combined', start, end);
  const income = summary.incomeCents;

  const spent: Record<SpendingBucket, Map<string, Cents>> = {
    needs: new Map(),
    wants: new Map(),
    savings: new Map(),
    rf: new Map(),
  };
  let uncategorised = 0;
  for (const [catId, cents] of spendingByCategory(transactions, 'combined', start, end)) {
    const cat = catId ? byId.get(catId) : undefined;
    const bucket = cat ? bucketForGroup(cat.group) : null;
    if (!cat || !bucket) uncategorised += cents;
    else spent[bucket].set(cat.id, (spent[bucket].get(cat.id) ?? 0) + cents);
  }
  const savingsTransfers = savingsMadeInPeriod(
    [],
    [],
    input.accounts,
    transactions,
    'combined',
    start,
    end,
  );

  // Two decimals, like a spreadsheet's percentage format.
  const pct = (cents: Cents) => (income > 0 ? Math.round((cents * 10_000) / income) / 100 : null);
  const amounts = (m: Map<string, Cents>): CategoryAmount[] =>
    [...m]
      .map(([id, cents]) => ({ categoryId: id, name: byId.get(id)?.name ?? 'Unknown', cents }))
      .filter((c) => c.cents !== 0)
      .sort((a, b) => b.cents - a.cents);

  const lines: BucketLine[] = [];
  let expenses = uncategorised + savingsTransfers;
  for (const bucket of BUCKETS) {
    if (bucket === 'buffer') continue;
    const cats = amounts(spent[bucket]);
    const actual =
      cats.reduce((s, c) => s + c.cents, 0) + (bucket === 'savings' ? savingsTransfers : 0);
    if (bucket !== 'savings') expenses += actual;
    else expenses += actual - savingsTransfers;
    const target = percentOf(Math.max(0, income), targets[bucket]);
    lines.push({
      bucket,
      actualCents: actual,
      targetPercent: targets[bucket],
      targetCents: target,
      actualPercent: pct(actual),
      leftCents: target - actual,
      categories: cats,
    });
  }
  const left = income - expenses;
  const bufferTarget = percentOf(Math.max(0, income), targets.buffer);
  lines.push({
    bucket: 'buffer',
    actualCents: left,
    targetPercent: targets.buffer,
    targetCents: bufferTarget,
    actualPercent: pct(left),
    leftCents: left - bufferTarget,
    categories: [],
  });

  const incomeCats = new Map<string, Cents>();
  for (const t of transactions) {
    if (!isActual(t) || t.type !== 'income' || t.date < start || t.date > end) continue;
    const key = t.categoryId ?? '';
    incomeCats.set(key, (incomeCats.get(key) ?? 0) + t.amountCents);
  }
  return {
    start,
    end,
    incomeCents: income,
    incomeByCategory: [...incomeCats]
      .map(([id, cents]) => ({
        categoryId: id,
        name: id ? (byId.get(id)?.name ?? 'Unknown') : 'Uncategorised income',
        cents,
      }))
      .sort((a, b) => b.cents - a.cents),
    expenseCents: expenses,
    leftCents: left,
    lines,
    uncategorisedCents: uncategorised,
    savingsTransfersCents: savingsTransfers,
    targetTotalPercent: BUCKETS.reduce((s, b) => s + targets[b], 0),
  };
}
