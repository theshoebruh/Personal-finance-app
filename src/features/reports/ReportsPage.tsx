import { useMemo } from 'react';
import { Link } from 'react-router';
import { useApp, useFinanceData } from '@/app/AppContext';
import { spendingByCategory, summariseIncomeExpenses } from '@/domain/calculations/reporting';
import { buildDashboard } from '@/domain/calculations/dashboard';
import { categoryBreakdown } from '@/domain/calculations/breakdown';
import { addMonths, endOfMonth, formatDisplayDate, startOfMonth } from '@/domain/dates';
import { Card, Empty, Loading, WorkspaceSwitcher } from '@/components/ui';
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
  const { today, view, setView } = useApp();
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

  if (!data || !model) return <Loading />;
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
  const lines = model.budgetOverview.lines;

  return (
    <>
      <PageHeader
        title="Reports"
        subtitle="Actual posted transactions only"
        actions={<WorkspaceSwitcher value={view} onChange={setView} />}
      />
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
          title="Budget vs actual"
          action={
            <Link className="card-link" to="/budgets">
              Budgets ›
            </Link>
          }
        >
          <p className="small muted">
            This period: {formatDisplayDate(model.period.start)} –{' '}
            {formatDisplayDate(model.period.end)}
          </p>
          {lines.length === 0 ? (
            <Empty title="No spending limits yet" icon="budgets">
              <p className="small">
                <Link to="/budgets">Set limits</Link> to compare them with what you spend.
              </p>
            </Empty>
          ) : (
            <BudgetBars
              label="Budget vs actual by category"
              lines={lines.map((l) => ({
                key: l.budgetId,
                label: l.categoryName,
                limitCents: l.limitCents,
                spentCents: l.spentCents,
                remainingCents: l.remainingCents,
              }))}
            />
          )}
        </Card>
      </div>
    </>
  );
}
