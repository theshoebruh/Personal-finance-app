import { Link } from 'react-router';
import type { FinanceData } from '@/app/AppContext';
import { subscriptionRows, subscriptionTotals } from '@/domain/calculations/subscriptions';
import type { IsoDate } from '@/domain/dates';
import { Icon } from '@/components/icons';
import { Money } from '@/components/ui';

/** Home: how many of this period's subscriptions and bills are paid, and what's still to come. */
export function SubscriptionsCard({
  data,
  period,
  today,
}: {
  data: FinanceData;
  period: { start: IsoDate; end: IsoDate };
  today: IsoDate;
}) {
  const rows = subscriptionRows(data.recurringRules, data.transactions, period, today).filter(
    (r) => r.state !== 'paused' && r.state !== 'not_due',
  );
  if (rows.length === 0) return null;
  const paid = rows.filter(
    (r) => r.state === 'paid' || r.state === 'pending' || r.state === 'marked_paid',
  ).length;
  const late = rows.filter((r) => r.state === 'late').length;
  const { toComeCents } = subscriptionTotals(rows);
  return (
    <Link to="/subscriptions" className="card sub-home-card">
      <Icon name="repeat" size={20} />
      <span className="sub-home-body">
        <span className="sub-home-title">Subscriptions & bills</span>
        <span className="small muted">
          {paid} of {rows.length} paid
          {toComeCents > 0 && (
            <>
              {' '}
              · <Money cents={toComeCents} /> still to come
            </>
          )}
          {late > 0 && <span className="warning-text"> · {late} not seen yet</span>}
        </span>
      </span>
      <Icon name="chevron-right" size={18} />
    </Link>
  );
}
