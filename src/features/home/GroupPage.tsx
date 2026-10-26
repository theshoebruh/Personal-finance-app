import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useApp } from '@/app/AppContext';
import { GROUP_IDS } from '@/domain/defaults';
import { groupIdForCategory } from '@/domain/calculations/buckets';
import { formatZAR } from '@/domain/money';
import { isActual, isPending } from '@/domain/calculations/balances';
import { updateTransaction } from '@/services/transactionsService';
import {
  Badge,
  Card,
  CountUpMoney,
  DateText,
  Empty,
  Loading,
  Money,
  useStatus,
} from '@/components/ui';
import { backToHome, shouldAnimateClick } from '@/app/viewTransition';
import { PageHeader } from '@/components/PageHeader';
import { Donut, Ring, fraction, shadeOf } from '@/components/charts';
import { CategoryOptions, lookup } from '../shared';
import { groupColour, groupHint, useBuckets } from './useBuckets';
import { LeftText, percentText, ringTone } from './HomePage';
import {
  TRANSACTION_SORTS,
  type TransactionSort,
  isTransactionSort,
  sortTransactions,
} from './sortTransactions';

const SORT_KEY = 'groupTransactionsSort';

function readSort(): TransactionSort {
  try {
    const v = localStorage.getItem(SORT_KEY);
    return isTransactionSort(v) ? v : 'newest';
  } catch {
    return 'newest';
  }
}

export function GroupPage() {
  const { bucket: param } = useParams();
  const { store } = useApp();
  const buckets = useBuckets();
  const { run, statusNode } = useStatus();
  const navigate = useNavigate();
  const [sort, setSortState] = useState<TransactionSort>(readSort);
  const [categoryFilter, setCategoryFilter] = useState('');
  const setSort = (v: TransactionSort) => {
    setSortState(v);
    try {
      localStorage.setItem(SORT_KEY, v);
    } catch {
      // Storage unavailable (private mode): the choice just isn't remembered.
    }
  };
  if (!buckets) return <Loading />;
  const line = buckets.summary.lines.find((l) => l.group.id === param);
  if (!line) {
    return (
      <>
        <PageHeader title="Group not found" back={{ to: '/', label: 'Home' }} />
        <Empty title="There's no such group." />
      </>
    );
  }
  const { data, period, summary } = buckets;
  const g = line.group;
  const bucket = g.id;
  const name = g.name;
  const isLeftover = g.kind === 'leftover';
  // Money coming back into the group (e.g. "Transfer from savings") is negative: listed, not drawn.
  const positive = line.categories.filter((c) => c.cents > 0);
  const moneyBack = line.categories.filter((c) => c.cents < 0);
  const colour = groupColour(g);
  const hint = groupHint(g);
  const categoriesById = lookup(data.categories);
  const accountsById = lookup(data.accounts);

  const spendingIds = new Set(
    data.budgetGroups.filter((o) => o.kind === 'spending').map((o) => o.id),
  );
  const inThisGroup = (categoryId: string | null) => {
    const cat = categoryId ? categoriesById.get(categoryId) : undefined;
    return !!cat && groupIdForCategory(cat, spendingIds) === g.id;
  };
  const txns = isLeftover
    ? []
    : data.transactions.filter(
        (t) =>
          (isActual(t) || isPending(t)) &&
          (t.type === 'expense' || t.type === 'refund' || t.type === 'income') &&
          t.date >= period.start &&
          t.date <= period.end &&
          inThisGroup(t.categoryId),
      );
  const catName = (id: string | null) => (id ? (categoriesById.get(id)?.name ?? '') : '');
  const groupCategories = [...new Set(txns.map((t) => t.categoryId))]
    .filter((id): id is string => !!id)
    .sort((a, b) => catName(a).localeCompare(catName(b)));
  const filter = groupCategories.includes(categoryFilter) ? categoryFilter : '';
  const shown = sortTransactions(
    filter ? txns.filter((t) => t.categoryId === filter) : txns,
    sort,
    catName,
  );

  return (
    <>
      <PageHeader
        title={name}
        subtitle={
          <>
            {hint && <>{hint} · </>}
            <DateText date={period.start} /> – <DateText date={period.end} />
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

      <Card className={`hero group-hero group-tone-${colour}`}>
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
            <dt>{isLeftover ? 'Left over' : 'Spent'}</dt>
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

      {isLeftover ? (
        <Card title={`How ${name} works`}>
          <p className="small">
            {name} is what’s left after all spending: income <Money cents={summary.incomeCents} /> −
            spent <Money cents={summary.expenseCents} /> = <Money cents={summary.leftCents} />. Your
            goal is to keep {line.targetPercent}% of income unspent.
          </p>
        </Card>
      ) : (
        <>
          {positive.length > 0 && (
            <Card title="By category">
              <Donut
                // Shades of the group's own colour, so the chart reads as this group.
                segments={positive.map((c, i) => ({
                  key: c.categoryId,
                  label: c.name,
                  cents: c.cents,
                  colour,
                  tint: shadeOf(colour, i),
                }))}
                totalCents={positive.reduce((s, c) => s + c.cents, 0)}
                label={`${name} by category`}
                centreLabel="spent"
                showPercent
              />
              {bucket === GROUP_IDS.savings && summary.savingsTransfersCents > 0 && (
                <p className="xs faint">
                  Plus <Money cents={summary.savingsTransfersCents} /> moved into savings accounts.
                </p>
              )}
              {moneyBack.map((c) => (
                <p key={c.categoryId} className="xs faint">
                  Minus <Money cents={-c.cents} /> back out ({c.name}).
                </p>
              ))}
            </Card>
          )}
          {bucket === GROUP_IDS.savings &&
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
            {txns.length > 1 && (
              <div className="list-controls">
                <label className="field-inline">
                  <span>Sort</span>
                  <select
                    className="select-sm"
                    value={sort}
                    onChange={(e) => setSort(e.target.value as TransactionSort)}
                  >
                    {Object.entries(TRANSACTION_SORTS).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                {groupCategories.length > 1 && (
                  <label className="field-inline">
                    <span>Category</span>
                    <select
                      className="select-sm"
                      value={filter}
                      onChange={(e) => setCategoryFilter(e.target.value)}
                    >
                      <option value="">All categories</option>
                      {groupCategories.map((id) => (
                        <option key={id} value={id}>
                          {catName(id)}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
            )}
            {txns.length === 0 ? (
              <Empty title={`Nothing in ${name} yet this period.`} />
            ) : (
              <ul className="list txn-cat-list">
                {shown.map((t) => (
                  <li key={t.id}>
                    <div className="primary">
                      <div className="title">{t.description}</div>
                      <div className="meta">
                        <DateText date={t.date} /> · {accountsById.get(t.accountId)?.name ?? ''}
                        {t.status === 'pending' && (
                          <>
                            {' '}
                            <Badge kind="forecast">Pending</Badge>
                          </>
                        )}
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
                          kind={t.type === 'income' ? 'income' : 'expense'}
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
