import { useApp, useFinanceData } from '@/app/AppContext';
import { summariseIncomeExpenses } from '@/domain/calculations/reporting';
import { accountBalance } from '@/domain/calculations/balances';
import { endOfMonth, formatDisplayDate, startOfMonth } from '@/domain/dates';
import { Alert, Card, Empty, Loading, Money } from '@/components/ui';
import { PageHeader } from '@/components/PageHeader';

export function BusinessPage() {
  const { today } = useApp();
  const data = useFinanceData();
  if (!data) return <Loading />;
  const start = startOfMonth(today);
  const end = endOfMonth(today);
  const s = summariseIncomeExpenses(data.transactions, 'business', start, end);
  const accounts = data.accounts.filter((a) => a.workspace === 'business' && a.active);

  return (
    <>
      <PageHeader title="Business" />
      {accounts.length === 0 ? (
        <Card>
          <Empty title="No business accounts yet">
            <p>Add an account with the Business workspace to track your side hustle separately.</p>
          </Empty>
        </Card>
      ) : (
        <div className="grid grid-2">
          <Card title={`This month (${formatDisplayDate(start)} – ${formatDisplayDate(end)})`}>
            <table className="breakdown">
              <tbody>
                <tr>
                  <th scope="row">Revenue</th>
                  <td>
                    <Money cents={s.incomeCents} />
                  </td>
                </tr>
                <tr>
                  <th scope="row">
                    Expenses
                    {s.refundCents > 0 && (
                      <span className="explain">
                        After <Money cents={s.refundCents} /> of refunds
                      </span>
                    )}
                  </th>
                  <td>
                    <Money cents={-s.netExpenseCents} />
                  </td>
                </tr>
                <tr className="total">
                  <th scope="row">
                    Estimated operating result
                    <span className="explain">
                      A simple management estimate — not formal accounting profit or tax advice.
                    </span>
                  </th>
                  <td>
                    <Money cents={s.netCents} signed tone />
                  </td>
                </tr>
                <tr>
                  <th scope="row">
                    Owner contributions (personal → business)
                    <span className="explain">Not revenue.</span>
                  </th>
                  <td>
                    <Money cents={s.ownerContributionCents} />
                  </td>
                </tr>
                <tr>
                  <th scope="row">
                    Owner draws (business → personal)
                    <span className="explain">Not an expense.</span>
                  </th>
                  <td>
                    <Money cents={s.ownerDrawCents} />
                  </td>
                </tr>
              </tbody>
            </table>
          </Card>
          <Card title="Business accounts">
            <ul className="list">
              {accounts.map((a) => (
                <li key={a.id}>
                  <span className="primary title">{a.name}</span>
                  <Money cents={accountBalance(a, data.transactions)} tone />
                </li>
              ))}
            </ul>
          </Card>
          <Card title="Invoices, receivables and projects" className="span-all">
            <Alert tone="info">
              Not built yet (planned for the next phases). When added, unpaid invoices will be shown
              as money owed to the business and will never be counted as available cash.
            </Alert>
          </Card>
        </div>
      )}
    </>
  );
}
