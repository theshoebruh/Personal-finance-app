import { todayInAppZone } from '../dates';
import {
  budgetPeriod,
  nextPayday,
  previousBudgetPeriod,
  previousPayday,
  salaryReceiptDates,
  spendingWindow,
} from './period';
import { makeAccount, makeRule, makeSettings, makeTxn } from '@/test/factories';
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

  it('honours a payday override before and after it passes', () => {
    const early = { paydayDayOfMonth: 25, nextPaydayOverride: '2026-03-23' };
    expect(nextPayday('2026-03-10', early)).toBe('2026-03-23');
    // Once paid early, the replaced 25 March is not a payday any more: the next is 25 April.
    expect(nextPayday('2026-03-24', early)).toBe('2026-04-25');
    expect(previousPayday('2026-03-24', early)).toBe('2026-03-23');
    expect(spendingWindow('2026-03-24', early).daysRemaining).toBe(32);
    // A stale override from an earlier month no longer affects anything.
    expect(nextPayday('2026-05-10', early)).toBe('2026-05-25');
    expect(previousPayday('2026-05-10', early)).toBe('2026-04-25');
  });

  it('starts the period on the day salary actually arrived, early or late', () => {
    const base = { paydayDayOfMonth: 25, nextPaydayOverride: null };
    const earlyPay = { ...base, receivedPaydays: ['2026-04-23'] };
    expect(budgetPeriod('2026-04-23', { ...earlyPay, budgetPeriodMode: 'pay_period' })).toEqual({
      start: '2026-04-23',
      end: '2026-05-24',
      mode: 'pay_period',
    });
    // Before the money arrives, the old period still ends the day before it.
    expect(budgetPeriod('2026-04-20', { ...earlyPay, budgetPeriodMode: 'pay_period' })).toEqual({
      start: '2026-03-25',
      end: '2026-04-22',
      mode: 'pay_period',
    });
    const latePay = { ...base, receivedPaydays: ['2026-04-27'] };
    expect(previousPayday('2026-04-28', latePay)).toBe('2026-04-27');
    expect(budgetPeriod('2026-04-26', { ...latePay, budgetPeriodMode: 'pay_period' }).end).toBe(
      '2026-04-26',
    );
  });

  it('ignores salary receipts too far from the scheduled payday', () => {
    // Salary on the 1st with payday set to the 25th: 6 days late is not taken as that payday.
    const s = { paydayDayOfMonth: 25, nextPaydayOverride: null, receivedPaydays: ['2026-10-01'] };
    expect(previousPayday('2026-10-16', s)).toBe('2026-09-25');
    // 10 days early (e.g. December) still counts.
    expect(previousPayday('2026-12-16', { ...s, receivedPaydays: ['2026-12-15'] })).toBe(
      '2026-12-15',
    );
  });

  it('builds pay periods across short months and the month-end payday', () => {
    const last = {
      paydayDayOfMonth: 31,
      nextPaydayOverride: null,
      budgetPeriodMode: 'pay_period' as const,
    };
    expect(budgetPeriod('2026-02-10', last)).toEqual({
      start: '2026-01-31',
      end: '2026-02-27',
      mode: 'pay_period',
    });
    expect(budgetPeriod('2026-03-05', last)).toEqual({
      start: '2026-02-28',
      end: '2026-03-30',
      mode: 'pay_period',
    });
    expect(budgetPeriod('2028-03-01', last).start).toBe('2028-02-29');
    const p = budgetPeriod('2026-03-05', last);
    expect(previousBudgetPeriod(p, last)).toEqual({
      start: '2026-01-31',
      end: '2026-02-27',
      mode: 'pay_period',
    });
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

  it('finds salary receipts by category or by matching the Salary recurring item', () => {
    const acc = makeAccount({ id: 'main' });
    const settings = makeSettings({ monthlySalaryCents: 1_200_000 });
    const rule = makeRule({
      name: 'Salary',
      direction: 'income',
      amountCents: 1_200_000,
      startDate: '2026-01-25',
      categoryId: 'cat-salary',
      accountId: acc.id,
    });
    const txns = [
      // Arrived early and uncategorised: matched to the Salary recurring item by name.
      makeTxn({
        accountId: acc.id,
        type: 'income',
        amountCents: 1_200_000,
        date: '2026-03-23',
        description: 'ACME SALARY MAR',
        categoryId: null,
      }),
      makeTxn({
        accountId: acc.id,
        type: 'income',
        amountCents: 1_190_000,
        date: '2026-02-25',
        categoryId: 'cat-salary',
      }),
      // A small amount filed as salary can't move the period.
      makeTxn({
        accountId: acc.id,
        type: 'income',
        amountCents: 5_000,
        date: '2026-03-10',
        categoryId: 'cat-salary',
      }),
    ];
    expect(salaryReceiptDates('2026-03-26', settings, [rule], txns)).toEqual([
      '2026-02-25',
      '2026-03-23',
    ]);
  });
});
