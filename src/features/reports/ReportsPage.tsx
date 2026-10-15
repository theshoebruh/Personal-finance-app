import { useApp, useFinanceData } from '@/app/AppContext';
import { spendingByCategory, summariseIncomeExpenses } from '@/domain/calculations/reporting';
import { addMonths, endOfMonth, startOfMonth } from '@/domain/dates';
import { Alert, Card, Empty, Loading, Money, WorkspaceSwitcher } from '@/components/ui';
import { lookup } from '../shared';

const monthLabel = new Intl.DateTimeFormat('en-ZA', {
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

export function ReportsPage() {
  const { today, view, setView } = useApp();
  const data = useFinanceData();
  if (!data) return <Loading />;
  const thisMonth = startOfMonth(today);
  const months = Array.from({ length: 6 }, (_, i) => addMonths(thisMonth, -i));
  const rows = months.map((m) => ({
    month: m,
    s: summariseIncomeExpenses(data.transactions, view, m, endOfMonth(m)),
  }));
  const cats = lookup(data.categories);
  const byCat = [
    ...spendingByCategory(data.transactions, view, thisMonth, endOfMonth(thisMonth)).entries(),
  ]
    .filter(([, v]) => v !== 0)
    .sort((a, b) => b[1] - a[1]);
  const totalSpend = byCat.reduce((s, [, v]) => s + v, 0);

  return (
    <>
      <div className="topbar">
        <h1>Reports</h1>
        <WorkspaceSwitcher value={view} onChange={setView} />
      </div>
      <Alert tone="info">
        Basic tables for now. Charts, budget-vs-actual history, cash-flow forecasts and CSV/Excel
        export are planned for a later phase.
      </Alert>
      <div className="grid grid-2">
        <Card title="Income vs spending by month">
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Month</th>
                  <th scope="col" className="amount">
                    Income
                  </th>
                  <th scope="col" className="amount">
                    Spending
                  </th>
                  <th scope="col" className="amount">
                    Net
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ month, s }) => (
                  <tr key={month}>
                    <th scope="row">{monthLabel.format(new Date(`${month}T00:00:00Z`))}</th>
                    <td className="amount">
                      <Money cents={s.incomeCents} />
                    </td>
                    <td className="amount">
                      <Money cents={s.netExpenseCents} />
                    </td>
                    <td className="amount">
                      <Money cents={s.netCents} signed tone />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="xs faint">
            Actual posted transactions only. Transfers between your own accounts (including to
            savings and between personal and business) are excluded.
          </p>
        </Card>
        <Card title="Spending by category this month">
          {byCat.length === 0 ? (
            <Empty title="No spending recorded this month" />
          ) : (
            <ul className="list">
              {byCat.map(([id, v]) => (
                <li key={id ?? 'none'}>
                  <span className="primary title">
                    {id ? (cats.get(id)?.name ?? 'Unknown') : 'Uncategorised'}
                  </span>
                  <span className="small muted">
                    {totalSpend > 0 ? Math.round((v / totalSpend) * 100) : 0}%
                  </span>
                  <Money cents={v} />
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
