import type { Account, BudgetGroup, Category, Transaction } from '../models';
import { GROUP_IDS, defaultGroupIdFor } from '../defaults';
import type { IsoDate } from '../dates';
import { type Cents, percentOf } from '../money';
import { savingsMadeInPeriod } from './goals';
import { spendingByCategory } from './reporting';
import { isActual, isPending } from './balances';

/**
 * The group a category counts towards: the one it was put in, or (for data from before custom
 * groups, or a link cleared by an older app version) its default group, if that group exists.
 */
export function groupIdForCategory(
  category: Category,
  groupIds: ReadonlySet<string>,
): string | null {
  if (category.budgetGroupId && groupIds.has(category.budgetGroupId)) return category.budgetGroupId;
  const fallback = defaultGroupIdFor(category.group);
  return fallback && groupIds.has(fallback) ? fallback : null;
}

/** Groups you want to reach (Savings, Buffer) rather than stay under. */
export function isGoalToReach(group: Pick<BudgetGroup, 'id' | 'kind'>): boolean {
  return group.kind === 'leftover' || group.id === GROUP_IDS.savings;
}

export interface CategoryAmount {
  categoryId: string;
  name: string;
  cents: Cents;
}

export interface GroupLine {
  group: BudgetGroup;
  /** Money in this group this period (net of money coming back). Leftover: income − spending. */
  actualCents: Cents;
  targetPercent: number;
  /** targetPercent of income. */
  targetCents: Cents;
  /** Actual as % of income; null when there is no income yet. */
  actualPercent: number | null;
  /** Spending groups: target − actual (negative = over). Leftover: actual − target. */
  leftCents: Cents;
  /** Per category, largest first (empty for the leftover group). */
  categories: CategoryAmount[];
}

export interface GroupSummary {
  start: IsoDate;
  end: IsoDate;
  incomeCents: Cents;
  incomeByCategory: CategoryAmount[];
  /** All spending: every spending group plus uncategorised. */
  expenseCents: Cents;
  /** income − expenses (= the leftover group). */
  leftCents: Cents;
  /** In the groups' order (the leftover group last). */
  lines: GroupLine[];
  /** Spending without a category (counted in expenses, not in any group). */
  uncategorisedCents: Cents;
  /** Savings moved by transfer from a spendable account into a savings account. */
  savingsTransfersCents: Cents;
  /** Money taken back out of savings (transfers, or income marked "Transfer from savings"). */
  savingsWithdrawalsCents: Cents;
  /** Sum of all goals; should be 100. */
  targetTotalPercent: number;
  /** Spending still pending at the bank (included in the figures above), positive. */
  pendingOutCents: Cents;
}

/**
 * The groups view of a period, like a monthly budget sheet:
 * - Income: income transactions. Income categorised under a spending group (e.g. "Transfer from
 *   savings") is money coming back into that group, so it reduces that group instead.
 * - Spending groups: net spending in their categories (refunds reduce it). The Savings group also
 *   counts transfers from a spendable account into a savings account, minus transfers back.
 * - Leftover (Buffer): income − all spending, including uncategorised.
 * Goals are % of this period's income; "left" is goal − actual.
 */
export function groupSummary(input: {
  groups: readonly BudgetGroup[];
  categories: readonly Category[];
  accounts: readonly Account[];
  transactions: readonly Transaction[];
  start: IsoDate;
  end: IsoDate;
}): GroupSummary {
  const { categories, transactions, start, end } = input;
  const groups = [...input.groups].sort((a, b) => a.sortOrder - b.sortOrder);
  const spendingGroups = groups.filter((g) => g.kind === 'spending');
  const spendingIds = new Set(spendingGroups.map((g) => g.id));
  const byId = new Map(categories.map((c) => [c.id, c]));
  const groupOf = (catId: string | null) => {
    const cat = catId ? byId.get(catId) : undefined;
    const g = cat ? groupIdForCategory(cat, spendingIds) : null;
    return { cat, g };
  };
  // Pending purchases count too (the money is committed); they're labelled where listed.
  const inPeriod = (t: Transaction) =>
    (isActual(t) || isPending(t)) && t.date >= start && t.date <= end;

  // Spending (expenses and refunds) per group and category.
  const perGroup = new Map<string, Map<string, Cents>>(
    spendingGroups.map((g) => [g.id, new Map()]),
  );
  const add = (groupId: string, catId: string, cents: Cents) => {
    const m = perGroup.get(groupId)!;
    m.set(catId, (m.get(catId) ?? 0) + cents);
  };
  let uncategorised = 0;
  for (const [catId, cents] of spendingByCategory(transactions, 'combined', start, end, {
    includePending: true,
  })) {
    const { cat, g } = groupOf(catId);
    if (cat && g) add(g, cat.id, cents);
    else uncategorised += cents;
  }

  // Income, or money coming back into a spending group.
  let income = 0;
  let withdrawalsByCategory = 0;
  const incomeCats = new Map<string, Cents>();
  for (const t of transactions) {
    if (!inPeriod(t) || t.type !== 'income') continue;
    const { cat, g } = groupOf(t.categoryId);
    if (cat && g) {
      add(g, cat.id, -t.amountCents);
      if (g === GROUP_IDS.savings) withdrawalsByCategory += t.amountCents;
      continue;
    }
    income += t.amountCents;
    const key = t.categoryId ?? '';
    incomeCats.set(key, (incomeCats.get(key) ?? 0) + t.amountCents);
  }

  // Transfers between a spendable and a savings account.
  const savingsGroup = spendingIds.has(GROUP_IDS.savings) ? GROUP_IDS.savings : null;
  const savingsIn = savingsMadeInPeriod(
    [],
    [],
    input.accounts,
    transactions,
    'combined',
    start,
    end,
  );
  const savingsOut = savingsWithdrawnInPeriod(input.accounts, transactions, start, end);
  if (!savingsGroup) uncategorised += savingsIn - savingsOut;

  const pct = (cents: Cents) => (income > 0 ? Math.round((cents * 10_000) / income) / 100 : null);
  const target = (g: BudgetGroup) => percentOf(Math.max(0, income), g.targetPercent);

  const spendingLines: GroupLine[] = spendingGroups.map((g) => {
    const cats = [...perGroup.get(g.id)!]
      .map(([id, cents]) => ({ categoryId: id, name: byId.get(id)?.name ?? 'Unknown', cents }))
      .filter((c) => c.cents !== 0)
      .sort((a, b) => b.cents - a.cents);
    const transfers = g.id === savingsGroup ? savingsIn - savingsOut : 0;
    const actual = cats.reduce((s, c) => s + c.cents, 0) + transfers;
    return {
      group: g,
      actualCents: actual,
      targetPercent: g.targetPercent,
      targetCents: target(g),
      actualPercent: pct(actual),
      leftCents: target(g) - actual,
      categories: cats,
    };
  });
  const expenses = spendingLines.reduce((s, l) => s + l.actualCents, 0) + uncategorised;
  const left = income - expenses;

  const lines: GroupLine[] = groups.map((g) => {
    if (g.kind === 'spending') return spendingLines.find((l) => l.group.id === g.id)!;
    return {
      group: g,
      actualCents: left,
      targetPercent: g.targetPercent,
      targetCents: target(g),
      actualPercent: pct(left),
      leftCents: left - target(g),
      categories: [],
    };
  });

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
    savingsTransfersCents: savingsIn,
    savingsWithdrawalsCents: savingsOut + withdrawalsByCategory,
    targetTotalPercent: groups.reduce((s, g) => s + g.targetPercent, 0),
    pendingOutCents: transactions
      .filter(
        (t) =>
          t.status === 'pending' &&
          !t.archived &&
          t.amountCents < 0 &&
          t.type !== 'transfer' &&
          t.date >= start &&
          t.date <= end,
      )
      .reduce((sum, t) => sum - t.amountCents, 0),
  };
}

/**
 * Transfers from a savings (non-spendable) account into a spendable one in the period: savings
 * taken back out. Both legs must be recorded, as for savings put away.
 */
export function savingsWithdrawnInPeriod(
  accounts: readonly Account[],
  transactions: readonly Transaction[],
  start: IsoDate,
  end: IsoDate,
): Cents {
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const legs = new Map<string, Transaction[]>();
  for (const t of transactions) {
    if (t.type !== 'transfer' || !t.transferId || !isActual(t)) continue;
    legs.set(t.transferId, [...(legs.get(t.transferId) ?? []), t]);
  }
  let total = 0;
  for (const pair of legs.values()) {
    const into = pair.find((l) => l.amountCents > 0);
    const outOf = pair.find((l) => l.amountCents < 0);
    if (!into || !outOf || into.date < start || into.date > end) continue;
    const dest = accountById.get(into.accountId);
    const src = accountById.get(outOf.accountId);
    if (dest && src && !src.includeInSpendable && dest.includeInSpendable)
      total += into.amountCents;
  }
  return total;
}
