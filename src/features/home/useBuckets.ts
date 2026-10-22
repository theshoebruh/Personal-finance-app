import { useMemo } from 'react';
import { useApp, useFinanceData } from '@/app/AppContext';
import { groupSummary } from '@/domain/calculations/buckets';
import { budgetPeriod, withReceivedPaydays } from '@/domain/calculations/period';
import { GROUP_IDS } from '@/domain/defaults';
import type { BudgetGroup } from '@/domain/models';
import type { ChartColour } from '@/components/charts';
import { daysInclusive } from '@/domain/dates';

/** Colour used for spending that has no category (and so no group). */
export const UNCATEGORISED_COLOUR: ChartColour = 0;

/** A group's chart colour (each group keeps the same colour everywhere). */
export function groupColour(group: Pick<BudgetGroup, 'colour'>): ChartColour {
  return group.colour as ChartColour;
}

const BUILT_IN_HINTS: Record<string, string> = {
  [GROUP_IDS.needs]: 'Bills and essentials',
  [GROUP_IDS.wants]: 'Lifestyle and treats',
  [GROUP_IDS.savings]: 'Money put away',
  [GROUP_IDS.buffer]: 'What’s left over',
  [GROUP_IDS.rf]: 'Side business costs',
};

/** One-line description under a group's name (custom groups have none unless it's leftover). */
export function groupHint(group: Pick<BudgetGroup, 'id' | 'kind'>): string | null {
  return BUILT_IN_HINTS[group.id] ?? (group.kind === 'leftover' ? 'What’s left over' : null);
}

/** The current pay period (or month) and its groups summary. */
export function useBuckets() {
  const { today } = useApp();
  const data = useFinanceData();
  return useMemo(() => {
    if (!data) return null;
    const pay = withReceivedPaydays(today, data.settings, data.recurringRules, data.transactions);
    const period = budgetPeriod(today, pay);
    const summary = groupSummary({
      groups: data.budgetGroups,
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
