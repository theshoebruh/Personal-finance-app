import { parseCsv } from './csv';
import { guessMapping, normaliseRows } from './normalise';
import { similarDescriptions } from './staging';

const rows = (csv: string) => {
  const parsed = parseCsv(csv).rows;
  return normaliseRows(parsed, guessMapping(parsed)).rows;
};

describe('recognising pending rows', () => {
  it('treats a line without a balance as pending when the other lines have one', () => {
    const r = rows(`Date,Description,Amount,Balance
2026-03-01,Salary,5000.00,5000.00
2026-03-02,Shop,-100.00,4900.00
2026-03-03,Cafe,-20.00,4880.00
2026-03-04,Card purchase,-50.00,`);
    expect(r.map((x) => x.pending)).toEqual([false, false, false, true]);
    expect(r[3]!.description).toBe('Card purchase');
  });

  it('does not guess when the bank gives no balances at all', () => {
    const r = rows(`Date,Description,Amount,Balance
2026-03-01,Salary,5000.00,
2026-03-02,Shop,-100.00,
2026-03-03,Cafe,-20.00,`);
    expect(r.every((x) => !x.pending)).toBe(true);
  });

  it('strips "(Pending)" from the description', () => {
    const r = rows(`Date,Description,Amount
2026-03-01,(Pending) Game Store,-165.00
2026-03-02,(pending): Cafe,-20.00`);
    expect(r.map((x) => [x.pending, x.description])).toEqual([
      [true, 'Game Store'],
      [true, 'Cafe'],
    ]);
  });

  it('matches shortened or tweaked merchant names, not different merchants', () => {
    expect(
      similarDescriptions(
        '(Pending) Game Store Mall Waterfr (Card 1111)',
        'Game Store Mall Waterf (Card 1111)',
      ),
    ).toBe(true);
    expect(similarDescriptions('Corner shop (Card 1111)', 'Petrol station (Card 1111)')).toBe(
      false,
    );
  });
});
