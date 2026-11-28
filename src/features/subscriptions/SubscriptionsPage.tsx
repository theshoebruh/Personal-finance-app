import { useState, type FormEvent } from 'react';
import { useApp } from '@/app/AppContext';
import type { FinanceData } from '@/app/AppContext';
import { groupIdForCategory } from '@/domain/calculations/buckets';
import {
  type SubscriptionRow,
  type SubscriptionState,
  subscriptionRows,
  subscriptionTotals,
  suggestSubscriptions,
} from '@/domain/calculations/subscriptions';
import { centsToDecimalString, parseAmountToCents } from '@/domain/money';
import type { BudgetGroup, RecurringRule } from '@/domain/models';
import { deleteRecurringRule, setOccurrenceSettled } from '@/services/planningService';
import {
  type SubscriptionInput,
  addSuggestedSubscriptions,
  saveSubscription,
  setSubscriptionActive,
} from '@/services/subscriptionsService';
import { Badge, Card, DateText, Empty, Field, Loading, Money, useStatus } from '@/components/ui';
import { useConfirm } from '@/components/ConfirmDialog';
import { PageHeader } from '@/components/PageHeader';
import { CategoryOptions } from '../shared';
import { groupColour, useBuckets } from '../home/useBuckets';

type Run = ReturnType<typeof useStatus>['run'];

const FREQUENCY_WORDS: Record<SubscriptionInput['frequency'], string> = {
  weekly: 'weekly',
  monthly: 'monthly',
  yearly: 'yearly',
};

/** The group an item's category counts in, for the label and colour. */
function useGroupOf(data: FinanceData) {
  const spending = data.budgetGroups.filter((g) => g.kind === 'spending');
  const ids = new Set(spending.map((g) => g.id));
  const byId = new Map(spending.map((g) => [g.id, g]));
  const cats = new Map(data.categories.map((c) => [c.id, c]));
  return (categoryId: string | undefined): BudgetGroup | null => {
    const cat = categoryId ? cats.get(categoryId) : undefined;
    const gid = cat ? groupIdForCategory(cat, ids) : null;
    return gid ? (byId.get(gid) ?? null) : null;
  };
}

function StatusBadge({ row }: { row: SubscriptionRow }) {
  const labels: Record<SubscriptionState, React.ReactNode> = {
    paid: (
      <Badge kind="actual">
        Paid{row.transaction && <> {formatShort(row.transaction.date)}</>}
      </Badge>
    ),
    pending: <Badge kind="forecast">Pending</Badge>,
    marked_paid: <Badge kind="actual">Marked paid</Badge>,
    due: <Badge>Due {row.dueDate && formatShort(row.dueDate)}</Badge>,
    late: <Badge kind="warning">Not seen yet</Badge>,
    not_due: <Badge>Not due this period</Badge>,
    paused: <Badge>Paused</Badge>,
  };
  return <>{labels[row.state]}</>;
}

const formatShort = (iso: string) =>
  new Date(`${iso}T12:00:00`).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' });

function SubscriptionForm({
  data,
  rule,
  today,
  onDone,
  onCancel,
}: {
  data: FinanceData;
  rule: RecurringRule | null;
  today: string;
  onDone: (msg: string) => void;
  onCancel: () => void;
}) {
  const { store } = useApp();
  const [name, setName] = useState(rule?.name ?? '');
  const [amount, setAmount] = useState(rule ? centsToDecimalString(rule.amountCents) : '');
  const [frequency, setFrequency] = useState<SubscriptionInput['frequency']>(
    rule && (rule.frequency === 'weekly' || rule.frequency === 'yearly')
      ? rule.frequency
      : 'monthly',
  );
  const [dueDate, setDueDate] = useState(rule?.startDate ?? today);
  const [categoryId, setCategoryId] = useState(rule?.categoryId ?? '');
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const cents = parseAmountToCents(amount);
    if (!name.trim()) return setError('Give it a name');
    if (cents === null || cents <= 0) return setError('Enter an amount greater than zero');
    if (!dueDate) return setError('Choose a due date');
    try {
      await saveSubscription(store, {
        ...(rule ? { id: rule.id } : {}),
        name,
        amountCents: cents,
        frequency,
        dueDate,
        categoryId: categoryId || null,
      });
      onDone(rule ? `${name.trim()} updated` : `${name.trim()} added`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const id = rule?.id ?? 'new';
  return (
    <form
      className="card stack"
      aria-label={rule ? `Edit ${rule.name}` : 'Add a subscription'}
      onSubmit={(e) => void submit(e)}
    >
      <h2>{rule ? `Edit ${rule.name}` : 'Add a subscription or bill'}</h2>
      <div className="form-grid">
        <Field label="Name" htmlFor={`sub-name-${id}`}>
          <input
            id={`sub-name-${id}`}
            value={name}
            placeholder="e.g. ChatGPT, Netflix, Rent"
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="Amount (R)" htmlFor={`sub-amount-${id}`}>
          <input
            id={`sub-amount-${id}`}
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </Field>
        <Field label="How often" htmlFor={`sub-freq-${id}`}>
          <select
            id={`sub-freq-${id}`}
            value={frequency}
            onChange={(e) => setFrequency(e.target.value as SubscriptionInput['frequency'])}
          >
            <option value="monthly">Monthly</option>
            <option value="yearly">Yearly</option>
            <option value="weekly">Weekly</option>
          </select>
        </Field>
        <Field
          label="Date it goes off"
          htmlFor={`sub-date-${id}`}
          hint="When it last went off (or the first date, if it hasn’t started yet)."
        >
          <input
            id={`sub-date-${id}`}
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
          />
        </Field>
        <Field
          label="Category"
          htmlFor={`sub-cat-${id}`}
          hint="Decides whether it counts as a Need, Want, …"
        >
          <select
            id={`sub-cat-${id}`}
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
          >
            <option value="">No category</option>
            <CategoryOptions categories={data.categories} workspace="personal" kind="expense" />
          </select>
        </Field>
      </div>
      {error && (
        <p className="small negative" role="alert">
          {error}
        </p>
      )}
      <div className="btn-row">
        <button type="submit" className="btn btn-primary">
          {rule ? 'Save changes' : 'Add to list'}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function ItemRow({
  row,
  group,
  run,
  onEdit,
}: {
  row: SubscriptionRow;
  group: BudgetGroup | null;
  run: Run;
  onEdit: () => void;
}) {
  const { store } = useApp();
  const confirm = useConfirm();
  const r = row.rule;
  const freq =
    r.frequency === 'weekly' || r.frequency === 'monthly' || r.frequency === 'yearly'
      ? FREQUENCY_WORDS[r.frequency]
      : r.frequency;
  return (
    <li className="sub-row" data-state={row.state}>
      <div className="primary">
        <div className="title">
          {r.name} <StatusBadge row={row} />
        </div>
        <div className="meta">
          {freq}
          {row.state === 'late' && row.dueDate && (
            <>
              {' '}
              · was due <DateText date={row.dueDate} />
            </>
          )}
          {row.state === 'not_due' && row.nextDue && (
            <>
              {' '}
              · next <DateText date={row.nextDue} />
            </>
          )}
          {' · '}
          {group ? (
            <span className="sub-group">
              <span className={`swatch chart-${groupColour(group)}`} aria-hidden="true" />{' '}
              {group.name}
            </span>
          ) : (
            <span className="faint">no group</span>
          )}
        </div>
        <div className="btn-row sub-actions">
          {(row.state === 'due' || row.state === 'late') && row.dueDate && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() =>
                void run(
                  () => setOccurrenceSettled(store, r.id, row.dueDate!, true),
                  `${r.name} marked as paid`,
                )
              }
            >
              Mark paid
            </button>
          )}
          {row.state === 'marked_paid' && row.dueDate && (
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() =>
                void run(
                  () => setOccurrenceSettled(store, r.id, row.dueDate!, false),
                  `${r.name} no longer marked paid`,
                )
              }
            >
              Undo paid
            </button>
          )}
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            aria-label={`Edit ${r.name}`}
            onClick={onEdit}
          >
            Edit
          </button>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() =>
              void run(
                () => setSubscriptionActive(store, r.id, !r.active),
                r.active ? `${r.name} paused` : `${r.name} resumed`,
              )
            }
          >
            {r.active ? 'Pause' : 'Resume'}
          </button>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            aria-label={`Delete ${r.name}`}
            onClick={() =>
              void (async () => {
                const ok = await confirm({
                  title: `Delete ${r.name}?`,
                  message: 'It comes off the list. Your transactions aren’t touched.',
                  confirmLabel: 'Delete',
                  danger: true,
                });
                if (ok) await run(() => deleteRecurringRule(store, r.id), `${r.name} deleted`);
              })()
            }
          >
            Delete
          </button>
        </div>
      </div>
      <Money cents={r.amountCents} />
    </li>
  );
}

export function SubscriptionsPage() {
  const { store, today } = useApp();
  const buckets = useBuckets();
  const { run, statusNode } = useStatus();
  const [editing, setEditing] = useState<RecurringRule | 'new' | null>(null);
  const data = buckets?.data;
  const groupOf = useGroupOf(
    data ?? ({ budgetGroups: [], categories: [] } as unknown as FinanceData),
  );
  if (!buckets || !data) return <Loading />;
  const { period } = buckets;

  const rows = subscriptionRows(data.recurringRules, data.transactions, period, today);
  const order: SubscriptionState[] = [
    'late',
    'due',
    'pending',
    'paid',
    'marked_paid',
    'not_due',
    'paused',
  ];
  const sorted = [...rows].sort(
    (a, b) =>
      order.indexOf(a.state) - order.indexOf(b.state) ||
      (a.dueDate ?? a.nextDue ?? '').localeCompare(b.dueDate ?? b.nextDue ?? '') ||
      a.rule.name.localeCompare(b.rule.name),
  );
  const totals = subscriptionTotals(rows);
  const suggestions = suggestSubscriptions(
    data.recurringRules,
    data.transactions,
    data.categories,
    today,
  );

  // Monthly cost per group.
  const perGroup = new Map<string, { group: BudgetGroup | null; cents: number }>();
  for (const r of rows) {
    if (r.state === 'paused') continue;
    const g = groupOf(r.rule.categoryId);
    const key = g?.id ?? '';
    const e = perGroup.get(key) ?? { group: g, cents: 0 };
    e.cents += r.monthlyCents;
    perGroup.set(key, e);
  }

  const form = editing && (
    <SubscriptionForm
      key={editing === 'new' ? 'new' : editing.id}
      data={data}
      rule={editing === 'new' ? null : editing}
      today={today}
      onDone={(msg) =>
        void run(async () => {
          setEditing(null);
        }, msg)
      }
      onCancel={() => setEditing(null)}
    />
  );

  return (
    <>
      <PageHeader
        title="Subscriptions"
        subtitle={
          <>
            Subscriptions and bills this period · <DateText date={period.start} /> –{' '}
            <DateText date={period.end} />
          </>
        }
      />

      {rows.length > 0 && (
        <Card className="sub-summary">
          <div className="totals-row">
            <div>
              <span className="totals-label">A month</span>
              <Money cents={totals.monthlyCents} />
            </div>
            <div>
              <span className="totals-label">Paid this period</span>
              <Money cents={totals.paidCents} />
            </div>
            <div>
              <span className="totals-label">Still to come</span>
              <Money cents={totals.toComeCents} />
            </div>
          </div>
          {perGroup.size > 0 && (
            <ul className="sub-groups">
              {[...perGroup.values()]
                .sort((a, b) => b.cents - a.cents)
                .map(({ group, cents }) => (
                  <li key={group?.id ?? 'none'}>
                    {group ? (
                      <span className={`swatch chart-${groupColour(group)}`} aria-hidden="true" />
                    ) : null}{' '}
                    {group?.name ?? 'No group'} <Money cents={cents} />
                  </li>
                ))}
            </ul>
          )}
        </Card>
      )}

      {suggestions.length > 0 && (
        <Card
          title="Found in your transactions"
          action={
            suggestions.length > 1 ? (
              <button
                type="button"
                className="btn btn-sm btn-primary"
                onClick={() =>
                  void run(
                    () => addSuggestedSubscriptions(store, suggestions),
                    `${suggestions.length} subscriptions added`,
                  )
                }
              >
                Add all
              </button>
            ) : undefined
          }
        >
          <p className="small muted">
            Payments in a subscription category that aren’t on your list yet. They’re added as
            monthly; edit any that aren’t.
          </p>
          <ul className="list">
            {suggestions.map((s) => (
              <li key={s.key}>
                <div className="primary">
                  <div className="title">{s.name}</div>
                  <div className="meta">
                    Last paid <DateText date={s.lastDate} />
                    {s.count > 1 && <> · {s.count} times recently</>}
                  </div>
                </div>
                <Money cents={s.amountCents} />
                <button
                  type="button"
                  className="btn btn-sm"
                  aria-label={`Add ${s.name}`}
                  onClick={() =>
                    void run(() => addSuggestedSubscriptions(store, [s]), `${s.name} added`)
                  }
                >
                  Add
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card
        title="Your list"
        action={
          !editing ? (
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={() => setEditing('new')}
            >
              Add
            </button>
          ) : undefined
        }
      >
        {editing === 'new' && form}
        {rows.length === 0 ? (
          editing ? null : (
            <Empty title="Nothing on your list yet.">
              <p className="small muted">
                Add the subscriptions and bills you want to keep an eye on, like ChatGPT, Netflix or
                rent. Each one shows whether this period’s payment has gone through.
              </p>
            </Empty>
          )
        ) : (
          <ul className="list sub-list">
            {sorted.map((row) =>
              editing !== 'new' && editing?.id === row.rule.id ? (
                <li key={row.rule.id}>{form}</li>
              ) : (
                <ItemRow
                  key={row.rule.id}
                  row={row}
                  group={groupOf(row.rule.categoryId)}
                  run={run}
                  onEdit={() => setEditing(row.rule)}
                />
              ),
            )}
          </ul>
        )}
      </Card>
      <p className="xs faint">
        A payment counts as this period’s when a transaction in the same category (or with the same
        name) is within 10% of the amount and 5 days of the due date. Use “Mark paid” for anything
        paid another way.
      </p>
      {statusNode}
    </>
  );
}
