import { categoryBreakdown } from './breakdown';

const names: Record<string, string> = { a: 'Rent', b: 'Groceries', c: 'Fuel', d: 'Phone' };
const nameOf = (id: string | null) => (id ? (names[id] ?? 'Unknown') : 'Uncategorised');

describe('categoryBreakdown', () => {
  it('sorts largest first, drops zero and negative amounts, and totals the rest', () => {
    const b = categoryBreakdown(
      new Map<string | null, number>([
        ['b', 81_000],
        ['a', 450_000],
        ['c', 0],
        ['d', -500],
        [null, 12_000],
      ]),
      nameOf,
    );
    expect(b.slices.map((s) => [s.label, s.cents])).toEqual([
      ['Rent', 450_000],
      ['Groceries', 81_000],
      ['Uncategorised', 12_000],
    ]);
    expect(b.totalCents).toBe(543_000);
  });

  it('folds everything past the limit into one Other slice that keeps the total', () => {
    const b = categoryBreakdown(
      [
        ['a', 400],
        ['b', 300],
        ['c', 200],
        ['d', 100],
      ],
      nameOf,
      3,
    );
    expect(b.slices.map((s) => [s.key, s.label, s.cents])).toEqual([
      ['a', 'Rent', 400],
      ['b', 'Groceries', 300],
      ['other', 'Other (2)', 300],
    ]);
    expect(b.slices.reduce((s, x) => s + x.cents, 0)).toBe(b.totalCents);
  });

  it('returns no slices for no spending', () => {
    expect(categoryBreakdown([], nameOf)).toEqual({ slices: [], totalCents: 0 });
  });
});
