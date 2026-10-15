import type { RecurringRule, Transaction } from '../models';
import { type IsoDate, addDays, addMonths, diffDays, parts } from '../dates';
import type { Cents } from '../money';
import { isActual } from './balances';

const DAY_STEPS: Partial<Record<RecurringRule['frequency'], number>> = {
  weekly: 7,
  fortnightly: 14,
};

function stepDays(rule: RecurringRule): number | null {
  if (rule.frequency === 'custom_days') return rule.intervalDays ?? null;
  return DAY_STEPS[rule.frequency] ?? null;
}

/** Due dates of a rule within [from, to] inclusive. Monthly rules keep the start date's day. */
export function occurrenceDates(rule: RecurringRule, from: IsoDate, to: IsoDate): IsoDate[] {
  const last = rule.endDate && rule.endDate < to ? rule.endDate : to;
  if (last < from || last < rule.startDate) return [];
  const out: IsoDate[] = [];
  const step = stepDays(rule);
  if (step !== null) {
    const skip = Math.max(0, Math.floor(diffDays(rule.startDate, from) / step));
    for (let n = skip; ; n++) {
      const d = addDays(rule.startDate, n * step);
      if (d > last) break;
      if (d >= from) out.push(d);
    }
    return out;
  }
  const monthsPerStep = rule.frequency === 'yearly' ? 12 : 1;
  const anchorDay = parts(rule.startDate).day;
  const s = parts(rule.startDate);
  const f = parts(from);
  const monthsBetween = (f.year - s.year) * 12 + (f.month - s.month);
  const skip = Math.max(0, Math.floor(monthsBetween / monthsPerStep) - 1);
  for (let n = skip; ; n++) {
    const d = addMonths(rule.startDate, n * monthsPerStep, anchorDay);
    if (d > last) break;
    if (d >= from) out.push(d);
  }
  return out;
}

/** Monthly-equivalent amount of a rule, for planning summaries (rounded to the cent). */
export function monthlyEquivalent(rule: RecurringRule): Cents {
  switch (rule.frequency) {
    case 'monthly':
      return rule.amountCents;
    case 'yearly':
      return Math.round(rule.amountCents / 12);
    default: {
      const step = stepDays(rule) ?? 30;
      return Math.round((rule.amountCents * 365) / 12 / step);
    }
  }
}

export type OccurrenceStatus = 'matched' | 'settled' | 'unmatched';

export interface Occurrence {
  ruleId: string;
  ruleName: string;
  direction: RecurringRule['direction'];
  date: IsoDate;
  /** Expected magnitude (positive). */
  expectedCents: Cents;
  status: OccurrenceStatus;
  matchedTransactionId?: string;
  /** How the match was made, for explanation in the UI. */
  matchReason?: 'explicit_link' | 'auto_match' | 'marked_settled';
  workspace: RecurringRule['workspace'];
  categoryId?: string;
  accountId?: string;
}

export function normaliseText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function amountTolerance(expected: Cents): Cents {
  return Math.max(100, Math.round(expected * 0.1));
}

function directionMatches(rule: RecurringRule, t: Transaction): boolean {
  return rule.direction === 'expense'
    ? t.type === 'expense' && t.amountCents < 0
    : t.type === 'income' && t.amountCents > 0;
}

function looksLike(rule: RecurringRule, t: Transaction): boolean {
  if (rule.categoryId && t.categoryId === rule.categoryId) return true;
  // Uncategorised imports can still match by name, so an imported tithe is not counted twice.
  if (t.categoryId === null || !rule.categoryId) {
    const name = normaliseText(rule.name);
    const text = normaliseText(`${t.description} ${t.originalDescription ?? ''}`);
    return name.length > 0 && text.includes(name);
  }
  return false;
}

/**
 * Expand rules into occurrences within [from, to] and reconcile each against actual transactions.
 * Forecast occurrences are never transactions. An occurrence is resolved (and must not be
 * deducted again) when it is explicitly linked to a transaction, marked settled by the user, or
 * auto-matched to a posted transaction of the same direction, workspace, account (if set),
 * category/name, an amount within 10% (min R1) and a date within the rule's match window.
 * Each transaction resolves at most one occurrence. Pending transactions never match, because they
 * are not yet in the posted balance.
 */
export function reconcileOccurrences(
  rules: readonly RecurringRule[],
  transactions: readonly Transaction[],
  from: IsoDate,
  to: IsoDate,
): Occurrence[] {
  const actual = transactions.filter(isActual);
  const used = new Set<string>();
  const explicit = new Map<string, Transaction>();
  for (const t of actual) {
    if (t.recurringRuleId && t.recurringOccurrenceDate) {
      explicit.set(`${t.recurringRuleId}|${t.recurringOccurrenceDate}`, t);
      used.add(t.id);
    }
  }

  const occurrences: Occurrence[] = [];
  for (const rule of rules) {
    if (!rule.active) continue;
    for (const date of occurrenceDates(rule, from, to)) {
      const base: Occurrence = {
        ruleId: rule.id,
        ruleName: rule.name,
        direction: rule.direction,
        date,
        expectedCents: rule.amountCents,
        status: 'unmatched',
        workspace: rule.workspace,
        ...(rule.categoryId ? { categoryId: rule.categoryId } : {}),
        ...(rule.accountId ? { accountId: rule.accountId } : {}),
      };
      const linked = explicit.get(`${rule.id}|${date}`);
      if (linked) {
        occurrences.push({
          ...base,
          status: 'matched',
          matchedTransactionId: linked.id,
          matchReason: 'explicit_link',
        });
      } else if (rule.settledDates.includes(date)) {
        occurrences.push({ ...base, status: 'settled', matchReason: 'marked_settled' });
      } else {
        occurrences.push(base);
      }
    }
  }

  // Auto-match in date order so earlier occurrences claim earlier transactions.
  const ruleById = new Map(rules.map((r) => [r.id, r]));
  const pending = occurrences
    .filter((o) => o.status === 'unmatched')
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  for (const occ of pending) {
    const rule = ruleById.get(occ.ruleId);
    if (!rule) continue;
    let best: { t: Transaction; score: number } | null = null;
    for (const t of actual) {
      if (used.has(t.id)) continue;
      if (t.workspace !== rule.workspace) continue;
      if (rule.accountId && t.accountId !== rule.accountId) continue;
      if (!directionMatches(rule, t)) continue;
      const dayGap = Math.abs(diffDays(occ.date, t.date));
      if (dayGap > rule.matchWindowDays) continue;
      const amountGap = Math.abs(Math.abs(t.amountCents) - rule.amountCents);
      if (amountGap > amountTolerance(rule.amountCents)) continue;
      if (!looksLike(rule, t)) continue;
      const score = dayGap * 1_000_000 + amountGap;
      if (!best || score < best.score) best = { t, score };
    }
    if (best) {
      used.add(best.t.id);
      occ.status = 'matched';
      occ.matchedTransactionId = best.t.id;
      occ.matchReason = 'auto_match';
    }
  }

  return occurrences.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** The next due date on or after `from`, if any. */
export function nextDueDate(rule: RecurringRule, from: IsoDate): IsoDate | null {
  return occurrenceDates(rule, from, addDays(from, 400))[0] ?? null;
}
