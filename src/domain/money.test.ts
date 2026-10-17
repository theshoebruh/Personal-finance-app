import {
  centsToDecimalString,
  divideRounded,
  formatZAR,
  formatZARWhole,
  parseAmountToCents,
  percentOf,
  sumCents,
} from './money';

describe('money', () => {
  it('computes percentages exactly in cents', () => {
    expect(percentOf(1_080_000, 20)).toBe(216_000);
    expect(percentOf(1_080_000, 12.5)).toBe(135_000);
    expect(percentOf(333, 50)).toBe(167); // half away from zero
    expect(percentOf(-333, 50)).toBe(-167);
  });

  it('rounds division half away from zero', () => {
    expect(divideRounded(5, 2)).toBe(3);
    expect(divideRounded(-5, 2)).toBe(-3);
    expect(divideRounded(4, 3)).toBe(1);
    expect(divideRounded(0, 7)).toBe(0);
    expect(() => divideRounded(1, 0)).toThrow();
  });

  it('rejects non-integer cents when summing', () => {
    expect(sumCents([100, 250, -50])).toBe(300);
    expect(() => sumCents([0.1])).toThrow();
  });

  it.each([
    ['1234.56', 123456],
    ['R1,234.56', 123456],
    ['R 1 234,56', 123456],
    ['-R50', -5000],
    ['R-50', -5000],
    ['(50.00)', -5000],
    ['12', 1200],
    ['0.5', 50],
    ['1.234.567,89', 123456789],
    ['1,234', 123400],
  ])('parses %s', (input, expected) => {
    expect(parseAmountToCents(input)).toBe(expected);
  });

  it.each(['', 'abc', '1.2.3', '12,34,5', 'R', '1e5'])('rejects %s', (input) => {
    expect(parseAmountToCents(input)).toBeNull();
  });

  it('formats ZAR and decimal strings', () => {
    expect(formatZAR(123456)).toMatch(/R\s?1\s?234[,.]56/);
    expect(centsToDecimalString(-5)).toBe('-0.05');
    expect(centsToDecimalString(123456)).toBe('1234.56');
    expect(formatZARWhole(123456)).toMatch(/^R\s?1\s?235$/);
    expect(formatZARWhole(-14193)).toMatch(/^-R\s?142$/);
  });
});
