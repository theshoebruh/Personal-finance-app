import { benchmark503020, budgetableIncome, savingsRateWarning, savingsTarget } from './income';

describe('income plan', () => {
  it('R12,000 salary less R1,200 tithe gives a R10,800 budget base', () => {
    expect(budgetableIncome(1_200_000, 120_000)).toBe(1_080_000);
  });

  it('20% of the after-tithe base is R2,160', () => {
    expect(savingsTarget(budgetableIncome(1_200_000, 120_000), 20)).toBe(216_000);
  });

  it('applies 50/30/20 to R10,800, not to R12,000', () => {
    expect(benchmark503020(1_080_000)).toEqual({
      needsCents: 540_000,
      wantsCents: 324_000,
      savingsCents: 216_000,
      totalCents: 1_080_000,
    });
  });

  it('keeps 50/30/20 parts summing to the base when rounding', () => {
    const b = benchmark503020(1_001);
    expect(b.needsCents + b.wantsCents + b.savingsCents).toBe(1_001);
  });

  it('never returns a negative base and validates the savings rate', () => {
    expect(budgetableIncome(100_000, 150_000)).toBe(0);
    expect(() => savingsTarget(100, 101)).toThrow();
    expect(() => savingsTarget(100, -1)).toThrow();
    expect(savingsTarget(1_080_000, 0)).toBe(0);
    expect(savingsTarget(1_080_000, 100)).toBe(1_080_000);
    expect(savingsRateWarning(0)).toBe('zero');
    expect(savingsRateWarning(60)).toBe('high');
    expect(savingsRateWarning(20)).toBeNull();
  });
});
