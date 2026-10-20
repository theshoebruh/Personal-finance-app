import { Link, useNavigate, useParams } from 'react-router';
import { useApp } from '@/app/AppContext';
import {
  BUCKET_GROUP,
  BUCKET_LABELS,
  BUCKETS,
  type Bucket,
  type SpendingBucket,
} from '@/domain/models';
import { formatZAR } from '@/domain/money';
import { isActual } from '@/domain/calculations/balances';
import { updateTransaction } from '@/services/transactionsService';
import { Card, CountUpMoney, DateText, Empty, Loading, Money, useStatus } from '@/components/ui';
import { backToHome, shouldAnimateClick } from '@/app/viewTransition';
import { PageHeader } from '@/components/PageHeader';
import { Donut, Ring, fraction, shadeOf } from '@/components/charts';
import { CategoryOptions, lookup } from '../shared';
import { BUCKET_COLOUR, BUCKET_HINT, useBuckets } from './useBuckets';
import { LeftText, percentText, ringTone } from './HomePage';

export function GroupPage() {
  const { bucket: param } = useParams();
  const { store } = useApp();
  const buckets = useBuckets();
  const { run, statusNode } = useStatus();
  const navigate = useNavigate();
  if (!buckets) return <Loading />;
  const bucket = (BUCKETS as readonly string[]).includes(param ?? '') ? (param as Bucket) : null;
  if (!bucket) {
    return (
      <>
        <PageHeader title="Group not found" back={{ to: '/', label: 'Home' }} />
        <Empty title="There's no such group." />
      </>
    );
  }
  const { data, period, summary } = buckets;
  const line = summary.lines.find((l) => l.bucket === bucket)!;
  const name = BUCKET_LABELS[bucket];
  const categoriesById = lookup(data.categories);
  const accountsById = lookup(data.accounts);

  const group = bucket === 'buffer' ? null : BUCKET_GROUP[bucket as SpendingBucket];
  const txns =
    group === null
      ? []
      : data.transactions
          .filter(
            (t) =>
              isActual(t) &&
              (t.type === 'expense' || t.type === 'refund') &&
              t.date >= period.start &&
              t.date <= period.end &&
              t.categoryId !== null &&
              categoriesById.get(t.categoryId)?.group === group,
          )
          .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  return (
    <>
      <PageHeader
        title={name}
        subtitle={
          <>
            {BUCKET_HINT[bucket]} · <DateText date={period.start} /> –{' '}
            <DateText date={period.end} />
          </>
        }
        back={{
          to: '/',
          label: 'Home',
          onLinkClick: (e) => {
            if (!shouldAnimateClick(e)) return;
            e.preventDefault();
            backToHome(navigate, bucket);
          },
        }}
      />

      <Card className={`hero group-hero group-tone-${BUCKET_COLOUR[bucket]}`}>
        <Ring
          value={fraction(Math.max(0, line.actualCents), Math.max(1, line.targetCents))}
          label={`${name}: ${formatZAR(line.actualCents)} of ${formatZAR(line.targetCents)} target`}
          size={132}
          thickness={14}
          tone={ringTone(line)}
        >
          <span className="ring-big">{percentText(line.actualPercent)}</span>
          <span className="ring-small">of income</span>
        </Ring>
        <dl className="group-facts">
          <div>
            <dt>{bucket === 'buffer' ? 'Left over' : 'Spent'}</dt>
            <dd>
              <CountUpMoney cents={line.actualCents} countKey={`group-${bucket}`} />
            </dd>
          </div>
          <div>
            <dt>Goal ({line.targetPercent}% of income)</dt>
            <dd>
              <Money cents={line.targetCents} />
            </dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd>
              <LeftText line={line} />
            </dd>
          </div>
        </dl>
      </Card>

      {bucket === 'buffer' ? (
        <Card title="How Buffer works">
          <p className="small">
            Buffer is what’s left after all spending: income <Money cents={summary.incomeCents} /> −
            spent <Money cents={summary.expenseCents} /> = <Money cents={summary.leftCents} />. Your
            goal is to keep {line.targetPercent}% of income unspent.
          </p>
        </Card>
      ) : (
        <>
          {line.categories.length > 0 && (
            <Card title="By category">
              <Donut
                // Shades of the group's own colour, so the chart reads as this group.
                segments={line.categories.map((c, i) => ({
                  key: c.categoryId,
                  label: c.name,
                  cents: c.cents,
                  colour: BUCKET_COLOUR[bucket],
                  tint: shadeOf(BUCKET_COLOUR[bucket], i),
                }))}
                totalCents={line.categories.reduce((s, c) => s + c.cents, 0)}
                label={`${name} by category`}
                centreLabel="spent"
                showPercent
              />
              {bucket === 'savings' && summary.savingsTransfersCents > 0 && (
                <p className="xs faint">
                  Plus <Money cents={summary.savingsTransfersCents} /> moved into savings accounts.
                </p>
              )}
            </Card>
          )}
          {bucket === 'savings' &&
            line.categories.length === 0 &&
            summary.savingsTransfersCents > 0 && (
              <p className="small">
                <Money cents={summary.savingsTransfersCents} /> moved into savings accounts this
                period.
              </p>
            )}

          <Card
            title="Transactions"
            action={
              <Link className="btn btn-sm" to="/categories">
                Edit categories
              </Link>
            }
          >
            {txns.length === 0 ? (
              <Empty title={`Nothing in ${name} yet this period.`} />
            ) : (
              <ul className="list txn-cat-list">
                {txns.map((t) => (
                  <li key={t.id}>
                    <div className="primary">
                      <div className="title">{t.description}</div>
                      <div className="meta">
                        <DateText date={t.date} /> · {accountsById.get(t.accountId)?.name ?? ''}
                      </div>
                      <label className="visually-hidden" htmlFor={`cat-${t.id}`}>
                        Category for {t.description}
                      </label>
                      <select
                        id={`cat-${t.id}`}
                        className="select-sm"
                        value={t.categoryId ?? ''}
                        onChange={(e) =>
                          void run(
                            () =>
                              updateTransaction(store, t.id, {
                                categoryId: e.target.value || null,
                                ...(t.status === 'needs_review'
                                  ? { status: 'posted' as const }
                                  : {}),
                              }),
                            `${t.description} moved to ${categoriesById.get(e.target.value)?.name ?? 'no category'}`,
                          )
                        }
                      >
                        <option value="">No category</option>
                        <CategoryOptions
                          categories={data.categories}
                          workspace={t.workspace}
                          kind="expense"
                        />
                      </select>
                    </div>
                    <Money cents={-t.amountCents} />
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}
      {statusNode}
    </>
  );
}
