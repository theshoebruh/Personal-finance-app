import type { FinanceData } from '@/app/AppContext';
import { groupSummary } from '@/domain/calculations/buckets';
import { asBudgeted } from '@/domain/calculations/budgetDate';
import { isActual, isPending } from '@/domain/calculations/balances';
import { normaliseText } from '@/domain/calculations/recurring';
import { addMonths, endOfMonth, startOfMonth, type IsoDate } from '@/domain/dates';
import type { Transaction } from '@/domain/models';
import { cleanDescription } from '@/domain/text';
import type { AskToolName } from '../../../supabase/functions/ask/tools';

/** What Claude sees as a rand amount: 1234.56 (spending positive unless signed). */
const rand = (cents: number) => Math.round(cents) / 100;

export { cleanDescription };

export class AskToolError extends Error {}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
function range(input: Record<string, unknown>): { start: IsoDate; end: IsoDate } {
  const { start, end } = input;
  if (typeof start !== 'string' || typeof end !== 'string' || !ISO.test(start) || !ISO.test(end)) {
    throw new AskToolError('start and end must be dates as YYYY-MM-DD');
  }
  if (start > end) throw new AskToolError('start must not be after end');
  return { start, end };
}
function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(max, Math.max(min, n));
}

/** Transactions the totals count in a period: posted or pending, dated by their budget date. */
function inPeriod(data: FinanceData, start: IsoDate, end: IsoDate): Transaction[] {
  return data.transactions
    .map(asBudgeted)
    .filter((t) => (isActual(t) || isPending(t)) && t.date >= start && t.date <= end);
}

function summaryFor(data: FinanceData, start: IsoDate, end: IsoDate) {
  return groupSummary({
    groups: data.budgetGroups,
    categories: data.categories,
    accounts: data.accounts,
    transactions: data.transactions,
    start,
    end,
    goalMode: data.settings.goalMode,
  });
}

function periodSummary(data: FinanceData, input: Record<string, unknown>) {
  const { start, end } = range(input);
  const s = summaryFor(data, start, end);
  return {
    start,
    end,
    income: rand(s.incomeCents),
    spent: rand(s.expenseCents),
    left: rand(s.leftCents),
    pending_spending_included: rand(s.pendingOutCents),
    spending_without_category: rand(s.uncategorisedCents),
    goals_are: s.goalMode === 'amount' ? 'fixed rand amounts' : 'percent of income',
    groups: s.lines.map((l) => ({
      group: l.group.name,
      kind: l.group.kind === 'leftover' ? 'left over (income minus all spending)' : 'spending',
      amount: rand(l.actualCents),
      goal: rand(l.targetCents),
      ...(s.goalMode === 'percent' ? { goal_percent_of_income: l.targetPercent } : {}),
      remaining_to_goal: rand(l.leftCents),
    })),
  };
}

function spendingByCategory(data: FinanceData, input: Record<string, unknown>) {
  const { start, end } = range(input);
  const s = summaryFor(data, start, end);
  const counts = new Map<string, number>();
  for (const t of inPeriod(data, start, end)) {
    if (t.categoryId && (t.type === 'expense' || t.type === 'refund')) {
      counts.set(t.categoryId, (counts.get(t.categoryId) ?? 0) + 1);
    }
  }
  const rows: { category: string; group: string; amount: number; transactions?: number }[] = [];
  for (const l of s.lines) {
    if (l.group.kind !== 'spending') continue;
    let inCategories = 0;
    for (const c of l.categories) {
      inCategories += c.cents;
      rows.push({
        category: c.name,
        group: l.group.name,
        amount: rand(c.cents),
        transactions: counts.get(c.categoryId) ?? 0,
      });
    }
    // The Savings group also counts transfers into savings accounts.
    if (l.actualCents !== inCategories) {
      rows.push({
        category: 'Moved into savings accounts',
        group: l.group.name,
        amount: rand(l.actualCents - inCategories),
      });
    }
  }
  if (s.uncategorisedCents !== 0) {
    rows.push({ category: 'No category yet', group: '(none)', amount: rand(s.uncategorisedCents) });
  }
  rows.sort((a, b) => b.amount - a.amount);
  return { start, end, total_spent: rand(s.expenseCents), categories: rows };
}

function topPayees(data: FinanceData, input: Record<string, unknown>) {
  const { start, end } = range(input);
  const limit = clampInt(input.limit, 1, 25, 10);
  const byKey = new Map<string, { names: Map<string, number>; cents: number; count: number }>();
  for (const t of inPeriod(data, start, end)) {
    if (t.type !== 'expense' && t.type !== 'refund') continue;
    const name = cleanDescription(t.description);
    const key = normaliseText(name) || name;
    const entry = byKey.get(key) ?? { names: new Map(), cents: 0, count: 0 };
    entry.cents -= t.amountCents;
    entry.count += 1;
    entry.names.set(name, (entry.names.get(name) ?? 0) + 1);
    byKey.set(key, entry);
  }
  const payees = [...byKey.values()]
    .map((e) => ({
      payee: [...e.names].sort((a, b) => b[1] - a[1])[0]![0],
      amount: rand(e.cents),
      transactions: e.count,
    }))
    .sort((a, b) => b.amount - a.amount);
  return { start, end, payees: payees.slice(0, limit), payees_in_total: payees.length };
}

function listTransactions(data: FinanceData, input: Record<string, unknown>) {
  const { start, end } = range(input);
  const limit = clampInt(input.limit, 1, 50, 20);
  const kind = input.kind === 'income' || input.kind === 'all' ? input.kind : 'spending';
  const contains = typeof input.contains === 'string' ? input.contains.trim().toLowerCase() : '';
  const catName = new Map(data.categories.map((c) => [c.id, c.name]));
  const matches = inPeriod(data, start, end).filter((t) => {
    const spending = t.type === 'expense' || t.type === 'refund';
    if (kind === 'spending' && !spending) return false;
    if (kind === 'income' && t.type !== 'income') return false;
    if (kind === 'all' && !spending && t.type !== 'income') return false;
    if (!contains) return true;
    const category = (t.categoryId && catName.get(t.categoryId)) || '';
    return `${t.description} ${category}`.toLowerCase().includes(contains);
  });
  matches.sort((a, b) => Math.abs(b.amountCents) - Math.abs(a.amountCents));
  return {
    start,
    end,
    matching: matches.length,
    transactions: matches.slice(0, limit).map((t) => ({
      date: t.date,
      description: cleanDescription(t.description),
      category: (t.categoryId && catName.get(t.categoryId)) || 'No category',
      // Money in is positive, money out negative.
      amount: rand(t.amountCents),
      ...(t.status === 'pending' ? { pending: true } : {}),
    })),
  };
}

function monthlyTotals(data: FinanceData, input: Record<string, unknown>, today: IsoDate) {
  const months = clampInt(input.months, 1, 12, 6);
  const out = [];
  for (let i = months - 1; i >= 0; i--) {
    const start = startOfMonth(addMonths(today, -i));
    const end = endOfMonth(start);
    const s = summaryFor(data, start, end);
    out.push({
      month: start.slice(0, 7),
      income: rand(s.incomeCents),
      spent: rand(s.expenseCents),
      left: rand(s.leftCents),
    });
  }
  return { months: out };
}

/** Runs one tool on local data and returns its result as JSON text for Claude. */
export function runAskTool(
  name: string,
  input: unknown,
  data: FinanceData,
  today: IsoDate,
): string {
  const args = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const tools: Record<AskToolName, () => unknown> = {
    period_summary: () => periodSummary(data, args),
    spending_by_category: () => spendingByCategory(data, args),
    top_payees: () => topPayees(data, args),
    list_transactions: () => listTransactions(data, args),
    monthly_totals: () => monthlyTotals(data, args, today),
  };
  const run = tools[name as AskToolName];
  if (!run) throw new AskToolError(`Unknown tool ${name}`);
  return JSON.stringify(run());
}
