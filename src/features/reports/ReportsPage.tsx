import { useMemo } from 'react';
import { Link } from 'react-router';
import { useApp, useFinanceData } from '@/app/AppContext';
import { spendingByCategory, summariseIncomeExpenses } from '@/domain/calculations/reporting';
import { buildDashboard } from '@/domain/calculations/dashboard';
import { categoryBreakdown } from '@/domain/calculations/breakdown';
import { addMonths, endOfMonth, formatDisplayDate, startOfMonth } from '@/domain/dates';
import { Card, Empty, Loading } from '@/components/ui';
import { BUCKET_LABELS } from '@/domain/models';
import { useBuckets } from '../home/useBuckets';
import { PageHeader } from '@/components/PageHeader';
import { BudgetBars, Donut, IncomeSpendingBars, type ChartColour } from '@/components/charts';
import { lookup } from '../shared';

const monthLabel = new Intl.DateTimeFormat('en-ZA', {
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});
const monthShort = new Intl.DateTimeFormat('en-ZA', { month: 'short', timeZone: 'UTC' });

export function ReportsPage() {
  const { today } = useApp();
  // The simple layout has no separate business workspace: reports cover all accounts.
  const view = 'combined' as const;
  const buckets = useBuckets();
  const data = useFinanceData();

  const model = useMemo(
    () =>
      data
        ? buildDashboard({
            today,
            view,
            settings: data.settings,
            accounts: data.accounts,
            transactions: data.transactions,
            recurringRules: data.recurringRules,
            budgets: data.budgets,
            categories: data.categories,
            goals: data.goals,
            goalContributions: data.goalContributions,
          })
        : null,
    [data, today, view],
  );

  if (!data || !model || !buckets) return <Loading />;
  const thisMonth = startOfMonth(today);
  // Oldest first, so the bars read left to right.
  const months = Array.from({ length: 6 }, (_, i) => addMonths(thisMonth, i - 5));
  const bars = months.map((m) => {
    const s = summariseIncomeExpenses(data.transactions, view, m, endOfMonth(m));
    const date = new Date(`${m}T00:00:00Z`);
    return {
      key: m,
      label: monthShort.format(date),
      longLabel: monthLabel.format(date),
      incomeCents: s.incomeCents,
      spendingCents: s.netExpenseCents,
      netCents: s.netCents,
    };
  });
  const cats = lookup(data.categories);
  const breakdown = categoryBreakdown(
    spendingByCategory(data.transactions, view, thisMonth, endOfMonth(thisMonth)),
    (id) => (id ? (cats.get(id)?.name ?? 'Unknown') : 'Uncategorised'),
  );
  const groupLines = buckets.summary.lines.filter((l) => l.bucket !== 'buffer');

  return (
    <>
      <PageHeader title="Reports" subtitle="Actual posted transactions only" />
      <div className="grid grid-2">
        <Card title="Income vs spending" className="span-all">
          <IncomeSpendingBars
            label={`Income and spending by month, ${bars[0]!.longLabel} to ${bars[bars.length - 1]!.longLabel}`}
            months={bars}
          />
          <p className="xs faint">
            Transfers between your own accounts (including to savings and between personal and
            business) are excluded.
          </p>
        </Card>
        <Card
          title={`Spending by category · ${monthLabel.format(new Date(`${thisMonth}T00:00:00Z`))}`}
        >
          {breakdown.slices.length === 0 ? (
            <Empty title="No spending recorded this month" icon="reports" />
          ) : (
            <Donut
              label={`Spending by category, ${monthLabel.format(new Date(`${thisMonth}T00:00:00Z`))}`}
              centreLabel="spent"
              showPercent
              totalCents={breakdown.totalCents}
              segments={breakdown.slices.map((s, i) => ({
                key: s.key,
                label: s.label,
                cents: s.cents,
                colour: (s.key === 'other' ? 0 : i + 1) as ChartColour,
              }))}
            />
          )}
        </Card>
        <Card
          title="Groups vs goals"
          action={
            <Link className="card-link" to="/categories">
              Goals ›
            </Link>
          }
        >
          <p className="small muted">
            This period: {formatDisplayDate(buckets.period.start)} –{' '}
            {formatDisplayDate(buckets.period.end)}
          </p>
          {buckets.summary.incomeCents === 0 && buckets.summary.expenseCents === 0 ? (
            <Empty title="Nothing recorded this period yet" icon="budgets" />
          ) : (
            <BudgetBars
              label="Spending per group against its goal"
              lines={groupLines.map((l) => ({
                key: l.bucket,
                label: `${BUCKET_LABELS[l.bucket]} (goal ${l.targetPercent}%)`,
                limitCents: l.targetCents,
                spentCents: l.actualCents,
                remainingCents: l.leftCents,
              }))}
            />
          )}
        </Card>
      </div>
    </>
  );
}
