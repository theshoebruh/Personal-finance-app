import { useMemo } from 'react';
import { useApp, useFinanceData } from '@/app/AppContext';
import { bucketSummary } from '@/domain/calculations/buckets';
import { budgetPeriod, withReceivedPaydays } from '@/domain/calculations/period';
import type { Bucket } from '@/domain/models';
import type { ChartColour } from '@/components/charts';
import { daysInclusive } from '@/domain/dates';

/** Fixed chart colour per group, so a group looks the same everywhere. */
export const BUCKET_COLOUR: Record<Bucket | 'uncategorised', ChartColour> = {
  needs: 1, // blue
  wants: 2, // orange
  savings: 3, // green
  rf: 6, // purple (amber reads as a warning)
  buffer: 5, // pink
  uncategorised: 0,
};

/** One-line description of each group, shown under its name. */
export const BUCKET_HINT: Record<Bucket, string> = {
  needs: 'Bills and essentials',
  wants: 'Lifestyle and treats',
  savings: 'Money put away',
  rf: 'Side business costs',
  buffer: 'What’s left over',
};

/** The current pay period (or month) and its five-group summary. */
export function useBuckets() {
  const { today } = useApp();
  const data = useFinanceData();
  return useMemo(() => {
    if (!data) return null;
    const pay = withReceivedPaydays(today, data.settings, data.recurringRules, data.transactions);
    const period = budgetPeriod(today, pay);
    const summary = bucketSummary({
      settings: data.settings,
      categories: data.categories,
      accounts: data.accounts,
      transactions: data.transactions,
      start: period.start,
      end: period.end,
    });
    return {
      data,
      period,
      summary,
      dayNumber: daysInclusive(period.start, today),
      totalDays: daysInclusive(period.start, period.end),
    };
  }, [data, today]);
}
