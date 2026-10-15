import { makeAccount, makeRule, makeTxn } from '@/test/factories';
import { monthlyEquivalent, nextDueDate, occurrenceDates, reconcileOccurrences } from './recurring';

describe('recurring schedules', () => {
  it('keeps the anchor day for monthly rules across short months', () => {
    const rule = makeRule({ startDate: '2026-01-31' });
    expect(occurrenceDates(rule, '2026-01-01', '2026-04-30')).toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
      '2026-04-30',
    ]);
  });

  it('generates weekly, fortnightly, custom and yearly dates within a window', () => {
    expect(
      occurrenceDates(
        makeRule({ frequency: 'weekly', startDate: '2026-03-02' }),
        '2026-03-10',
        '2026-03-31',
      ),
    ).toEqual(['2026-03-16', '2026-03-23', '2026-03-30']);
    expect(
      occurrenceDates(
        makeRule({ frequency: 'fortnightly', startDate: '2026-01-02' }),
        '2026-03-01',
        '2026-03-31',
      ),
    ).toEqual(['2026-03-13', '2026-03-27']);
    expect(
      occurrenceDates(
        makeRule({ frequency: 'custom_days', intervalDays: 10, startDate: '2026-03-01' }),
        '2026-03-01',
        '2026-03-25',
      ),
    ).toEqual(['2026-03-01', '2026-03-11', '2026-03-21']);
    expect(
      occurrenceDates(
        makeRule({ frequency: 'yearly', startDate: '2024-02-29' }),
        '2026-01-01',
        '2028-12-31',
      ),
    ).toEqual(['2026-02-28', '2027-02-28', '2028-02-29']);
  });

  it('respects start and end dates', () => {
    const rule = makeRule({ startDate: '2026-03-15', endDate: '2026-05-15' });
    expect(occurrenceDates(rule, '2026-01-01', '2026-12-31')).toEqual([
      '2026-03-15',
      '2026-04-15',
      '2026-05-15',
    ]);
    expect(nextDueDate(rule, '2026-05-16')).toBeNull();
    expect(nextDueDate(rule, '2026-04-01')).toBe('2026-04-15');
  });

  it('computes monthly equivalents', () => {
    expect(monthlyEquivalent(makeRule({ amountCents: 120_000 }))).toBe(120_000);
    expect(monthlyEquivalent(makeRule({ frequency: 'yearly', amountCents: 120_000 }))).toBe(10_000);
    expect(monthlyEquivalent(makeRule({ frequency: 'weekly', amountCents: 7_000 }))).toBe(30_417);
  });
});

describe('forecast vs actual matching', () => {
  const acc = makeAccount();
  const tithe = makeRule({
    name: 'Tithe',
    amountCents: 120_000,
    startDate: '2026-01-25',
    categoryId: 'cat-tithe',
  });

  it('leaves an occurrence unmatched when no actual transaction exists', () => {
    const occ = reconcileOccurrences([tithe], [], '2026-03-01', '2026-03-31');
    expect(occ).toHaveLength(1);
    expect(occ[0]!.status).toBe('unmatched');
  });

  it('auto-matches a posted transaction by category, amount and date window', () => {
    const t = makeTxn({
      accountId: acc.id,
      amountCents: -120_000,
      date: '2026-03-26',
      categoryId: 'cat-tithe',
    });
    const occ = reconcileOccurrences([tithe], [t], '2026-03-01', '2026-03-31');
    expect(occ[0]).toMatchObject({
      status: 'matched',
      matchedTransactionId: t.id,
      matchReason: 'auto_match',
    });
  });

  it('matches an uncategorised import by name so the tithe is not deducted twice', () => {
    const t = makeTxn({
      accountId: acc.id,
      amountCents: -120_000,
      date: '2026-03-25',
      description: 'DEBIT ORDER CHURCH TITHE 0325',
    });
    expect(reconcileOccurrences([tithe], [t], '2026-03-01', '2026-03-31')[0]!.status).toBe(
      'matched',
    );
  });

  it('does not match pending, wrong-direction, out-of-window or very different amounts', () => {
    const cases = [
      makeTxn({
        accountId: acc.id,
        amountCents: -120_000,
        date: '2026-03-25',
        categoryId: 'cat-tithe',
        status: 'pending',
      }),
      makeTxn({
        accountId: acc.id,
        amountCents: 120_000,
        date: '2026-03-25',
        categoryId: 'cat-tithe',
      }),
      makeTxn({
        accountId: acc.id,
        amountCents: -120_000,
        date: '2026-03-05',
        categoryId: 'cat-tithe',
      }),
      makeTxn({
        accountId: acc.id,
        amountCents: -200_000,
        date: '2026-03-25',
        categoryId: 'cat-tithe',
      }),
    ];
    for (const t of cases) {
      expect(reconcileOccurrences([tithe], [t], '2026-03-01', '2026-03-31')[0]!.status).toBe(
        'unmatched',
      );
    }
  });

  it('uses explicit links and settled dates', () => {
    const linked = makeTxn({
      accountId: acc.id,
      amountCents: -90_000, // amount differs, but the user linked it explicitly
      date: '2026-03-02',
      recurringRuleId: tithe.id,
      recurringOccurrenceDate: '2026-03-25',
    });
    expect(reconcileOccurrences([tithe], [linked], '2026-03-01', '2026-03-31')[0]).toMatchObject({
      status: 'matched',
      matchReason: 'explicit_link',
    });
    const settled = { ...tithe, settledDates: ['2026-03-25'] };
    expect(reconcileOccurrences([settled], [], '2026-03-01', '2026-03-31')[0]!.status).toBe(
      'settled',
    );
  });

  it('lets each transaction resolve only one occurrence', () => {
    const weekly = makeRule({
      name: 'Taxi',
      frequency: 'weekly',
      amountCents: 10_000,
      startDate: '2026-03-02',
      matchWindowDays: 7,
    });
    const t = makeTxn({
      accountId: acc.id,
      amountCents: -10_000,
      date: '2026-03-05',
      description: 'Taxi fare',
    });
    const occ = reconcileOccurrences([weekly], [t], '2026-03-01', '2026-03-10');
    expect(occ.map((o) => o.status)).toEqual(['matched', 'unmatched']);
  });

  it('ignores paused rules', () => {
    expect(
      reconcileOccurrences([{ ...tithe, active: false }], [], '2026-03-01', '2026-03-31'),
    ).toEqual([]);
  });
});
