import { todayInAppZone } from '../dates';
import { budgetPeriod, nextPayday, previousPayday, spendingWindow } from './period';
import { dailyAllowance } from './availableToSpend';

const noPayday = { paydayDayOfMonth: null, nextPaydayOverride: null };

describe('payday and periods', () => {
  it('uses Africa/Johannesburg for today', () => {
    // 23:30 UTC on 31 Jan is already 1 Feb in Johannesburg (UTC+2).
    expect(todayInAppZone(new Date('2026-01-31T23:30:00Z'))).toBe('2026-02-01');
  });

  it('finds the next payday strictly after today', () => {
    const s = { paydayDayOfMonth: 25, nextPaydayOverride: null };
    expect(nextPayday('2026-03-10', s)).toBe('2026-03-25');
    expect(nextPayday('2026-03-25', s)).toBe('2026-04-25'); // payday itself starts a new period
    expect(nextPayday('2026-12-26', s)).toBe('2027-01-25');
  });

  it('clamps payday 31 to the end of shorter months, including leap years', () => {
    const s = { paydayDayOfMonth: 31, nextPaydayOverride: null };
    expect(nextPayday('2026-02-10', s)).toBe('2026-02-28');
    expect(nextPayday('2028-02-10', s)).toBe('2028-02-29');
    expect(nextPayday('2026-04-30', s)).toBe('2026-05-31');
    expect(previousPayday('2026-03-15', s)).toBe('2026-02-28');
  });

  it('honours a future payday override and ignores a stale one', () => {
    expect(
      nextPayday('2026-03-10', { paydayDayOfMonth: 25, nextPaydayOverride: '2026-03-23' }),
    ).toBe('2026-03-23');
    expect(
      nextPayday('2026-03-24', { paydayDayOfMonth: 25, nextPaydayOverride: '2026-03-23' }),
    ).toBe('2026-03-25');
  });

  it('counts today as one day up to the day before payday', () => {
    const w = spendingWindow('2026-03-20', { paydayDayOfMonth: 25, nextPaydayOverride: null });
    expect(w.end).toBe('2026-03-24');
    expect(w.daysRemaining).toBe(5);
    expect(w.basis).toBe('next_payday');
  });

  it('has one day remaining on the day before payday', () => {
    const w = spendingWindow('2026-03-24', { paydayDayOfMonth: 25, nextPaydayOverride: null });
    expect(w.daysRemaining).toBe(1);
  });

  it('falls back to month-end without a payday', () => {
    const w = spendingWindow('2026-03-31', noPayday);
    expect(w.end).toBe('2026-03-31');
    expect(w.daysRemaining).toBe(1);
    expect(w.basis).toBe('month_end');
    expect(spendingWindow('2026-02-01', noPayday).daysRemaining).toBe(28);
  });

  it('builds calendar and pay-period budget periods', () => {
    expect(budgetPeriod('2026-03-10', { ...noPayday, budgetPeriodMode: 'calendar_month' })).toEqual(
      {
        start: '2026-03-01',
        end: '2026-03-31',
        mode: 'calendar_month',
      },
    );
    expect(
      budgetPeriod('2026-03-10', {
        paydayDayOfMonth: 25,
        nextPaydayOverride: null,
        budgetPeriodMode: 'pay_period',
      }),
    ).toEqual({ start: '2026-02-25', end: '2026-03-24', mode: 'pay_period' });
    // Pay-period mode without a payday falls back to the calendar month.
    expect(budgetPeriod('2026-03-10', { ...noPayday, budgetPeriodMode: 'pay_period' }).mode).toBe(
      'calendar_month',
    );
  });

  it('computes the daily allowance safely', () => {
    expect(dailyAllowance(100_000, 5)).toBe(20_000);
    expect(dailyAllowance(100_001, 3)).toBe(33_333); // rounds down
    expect(dailyAllowance(100_000, 0)).toBe(0);
    expect(dailyAllowance(-500, 3)).toBe(0);
  });
});
