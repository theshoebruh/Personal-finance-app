import { type Cents, percentOf } from '../money';

/**
 * Salary budget base. The tithe is a non-negotiable commitment taken off the recorded salary
 * exactly once here; it must not also be subtracted as a forecast commitment from this base.
 */
export function budgetableIncome(monthlySalaryCents: Cents, monthlyTitheCents: Cents): Cents {
  return Math.max(0, monthlySalaryCents - monthlyTitheCents);
}

export function savingsTarget(budgetableCents: Cents, savingsRatePercent: number): Cents {
  if (savingsRatePercent < 0 || savingsRatePercent > 100) {
    throw new Error('Savings rate must be between 0% and 100%');
  }
  return percentOf(budgetableCents, savingsRatePercent);
}

export interface Benchmark503020 {
  needsCents: Cents;
  wantsCents: Cents;
  savingsCents: Cents;
  totalCents: Cents;
}

/**
 * Optional 50/30/20 starting template applied to the budgetable (after-tithe) income.
 * Needs absorbs any rounding cent so the three parts always sum to the base.
 */
export function benchmark503020(budgetableCents: Cents): Benchmark503020 {
  const savingsCents = percentOf(budgetableCents, 20);
  const wantsCents = percentOf(budgetableCents, 30);
  return {
    needsCents: budgetableCents - savingsCents - wantsCents,
    wantsCents,
    savingsCents,
    totalCents: budgetableCents,
  };
}

export type SavingsRateWarning = 'zero' | 'high' | null;

/** Gentle validation for the savings-rate input; values are allowed but flagged. */
export function savingsRateWarning(percent: number): SavingsRateWarning {
  if (percent === 0) return 'zero';
  if (percent > 50) return 'high';
  return null;
}
