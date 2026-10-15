import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useApp, useFinanceData } from '@/app/AppContext';
import { buildDashboard } from '@/domain/calculations/dashboard';
import { WORKSPACE_LABELS } from '@/domain/models';
import { formatDisplayDate } from '@/domain/dates';
import { setOccurrenceSettled } from '@/services/planningService';
import { loadDemoData } from '@/services/demoService';
import {
  Alert,
  Badge,
  Card,
  DateText,
  Empty,
  Loading,
  Money,
  ProgressBar,
  WorkspaceSwitcher,
  useStatus,
} from '@/components/ui';
import { lookup } from '../shared';

const ESSENTIAL_SOURCE_TEXT = {
  override: 'your own essential-expenses figure from Settings',
  budgets: 'the total of your essential category budgets',
  history: 'average essential spending over recent complete months',
  insufficient_data: '',
} as const;

export function DashboardPage() {
  const { store, view, setView, today } = useApp();
  const data = useFinanceData();
  const { run, statusNode } = useStatus();
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

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
  const { ats } = model;

  if (data.accounts.length === 0) {
    return (
      <>
        <div className="topbar">
          <h1>Welcome</h1>
        </div>
        <Card className="hero">
          <h2>Let's work out what is safe to spend</h2>
          <p className="muted">
            Everything is stored privately on this device. No bank login is needed — you add
            accounts and import CSV statements or add transactions yourself.
          </p>
          <ol className="stack">
            <li>
              <Link to="/settings">Check your income plan and set your payday</Link> (defaults:
              R12,000 salary, R1,200 tithe, 20% savings).
            </li>
            <li>
              <Link to="/accounts">Add your accounts</Link> with their current balances.
            </li>
            <li>
              <Link to="/budgets">Add salary, tithe and bills</Link> as recurring items, and
              optional spending limits.
            </li>
          </ol>
          <div className="btn-row">
            <Link className="btn btn-primary" to="/accounts">
              Add your first account
            </Link>
            <button
              type="button"
              className="btn"
              onClick={() =>
                void run(
                  () => loadDemoData(store, today),
                  'Demo data loaded — clear it any time in Settings',
                )
              }
            >
              Explore with demo data
            </button>
          </div>
        </Card>
        {statusNode}
      </>
    );
  }

  const accountsById = lookup(data.accounts);
  const categoriesById = lookup(data.categories);
  const alerts = model.alerts.filter((a) => !dismissed.has(a.id));
  const periodWord = ats.window.basis === 'next_payday' ? 'payday' : 'month-end';
  const hasDemo = data.accounts.some((a) => a.isDemo);

  return (
    <>
      <div className="topbar">
        <h1>Dashboard</h1>
        <WorkspaceSwitcher value={view} onChange={setView} />
      </div>

      {hasDemo && (
        <Alert tone="info">
          Demo data is loaded (marked <Badge kind="demo">Demo</Badge>).{' '}
          <Link to="/settings">Clear it in Settings</Link> when you're ready to use your own
          figures.
        </Alert>
      )}

      <div className="grid grid-3">
        <Card className="hero span-all" title={`Available to spend · ${WORKSPACE_LABELS[view]}`}>
          <p className="hero-amount" aria-describedby="ats-basis">
            <Money cents={ats.availableCents} />
          </p>
          <div className="hero-sub">
            <span>
              <strong>
                <Money cents={ats.dailyAllowanceCents} />
              </strong>{' '}
              a day until <DateText date={ats.window.end} />
            </span>
            <span>
              {ats.window.daysRemaining} day{ats.window.daysRemaining === 1 ? '' : 's'} left (today
              counts)
            </span>
            <span>
              {ats.window.nextPayday ? (
                <>
                  Next payday <DateText date={ats.window.nextPayday} />
                </>
              ) : (
                'No payday set — using month-end'
              )}{' '}
              · <Link to="/settings">Edit</Link>
            </span>
          </div>
          <p id="ats-basis" className="small faint">
            {ats.basis === 'cash_and_budget'
              ? 'Based on spendable cash, unpaid commitments and reserves, capped by your remaining wants budget.'
              : 'Based on spendable cash minus unpaid commitments and reserves (no category-budget cap applied).'}{' '}
            The daily figure is guidance, not a target to spend.
          </p>
          {ats.shortfallCents > 0 && (
            <Alert tone="negative">
              Commitments and reserves exceed spendable cash by <Money cents={ats.shortfallCents} />
              . Available to spend is shown as R0.
            </Alert>
          )}
          {ats.discretionary.enabled && ats.discretionary.remainingCents < 0 && (
            <Alert tone="warning">
              Wants spending is <Money cents={-ats.discretionary.remainingCents} /> over this
              period's limits.
            </Alert>
          )}

          <details className="explainer">
            <summary>How this is calculated</summary>
            <table className="breakdown">
              <caption className="visually-hidden">Available to spend breakdown</caption>
              <tbody>
                <tr>
                  <th scope="row">
                    Spendable cash <Badge kind="actual">Actual</Badge>
                    <span className="explain">
                      Posted balances of {ats.eligibleCash.included.length} spendable account
                      {ats.eligibleCash.included.length === 1 ? '' : 's'}:{' '}
                      {ats.eligibleCash.included.map((l) => l.name).join(', ') || 'none'}.
                      {ats.eligibleCash.excluded.length > 0 &&
                        ` Not included: ${ats.eligibleCash.excluded.map((l) => l.name).join(', ')}.`}
                      {ats.eligibleCash.pendingCents !== 0 && (
                        <>
                          {' '}
                          Pending items (<Money cents={ats.eligibleCash.pendingCents} />) are not
                          yet included.
                        </>
                      )}
                    </span>
                  </th>
                  <td>
                    <Money cents={ats.eligibleCash.totalCents} />
                  </td>
                </tr>
                <tr>
                  <th scope="row">
                    − Unpaid commitments <Badge kind="forecast">Forecast</Badge>
                    <span className="explain">
                      {ats.commitments.items.length} bill
                      {ats.commitments.items.length === 1 ? '' : 's'} due by{' '}
                      {formatDisplayDate(ats.window.end)} with no matching payment yet.
                      {ats.commitments.resolved.length > 0 &&
                        ` ${ats.commitments.resolved.length} already paid/matched and not deducted again.`}
                    </span>
                  </th>
                  <td>
                    <Money cents={-ats.commitments.totalCents} />
                  </td>
                </tr>
                <tr>
                  <th scope="row">
                    − Goal reserves
                    <span className="explain">
                      Money allocated to goals that still sits in spendable accounts.
                      {ats.goalReserves.heldOutsideCents > 0 && (
                        <>
                          {' '}
                          <Money cents={ats.goalReserves.heldOutsideCents} /> is already in
                          non-spendable accounts, so it isn't subtracted again.
                        </>
                      )}
                    </span>
                  </th>
                  <td>
                    <Money cents={-ats.goalReserves.reservedCents} />
                  </td>
                </tr>
                {ats.plannedSavings.applied && (
                  <tr>
                    <th scope="row">
                      − Planned savings still to set aside <Badge kind="forecast">Plan</Badge>
                      <span className="explain">
                        Target <Money cents={ats.plannedSavings.targetCents} /> (
                        {data.settings.savingsRatePercent}% of{' '}
                        <Money cents={ats.plannedSavings.budgetableIncomeCents} /> after tithe)
                        minus <Money cents={ats.plannedSavings.madeThisPeriodCents} /> already saved
                        this period.
                      </span>
                    </th>
                    <td>
                      <Money cents={-ats.plannedSavings.remainingCents} />
                    </td>
                  </tr>
                )}
                <tr className="total">
                  <th scope="row">= Cash-based amount</th>
                  <td>
                    <Money cents={ats.cashBasedCents} />
                  </td>
                </tr>
                {ats.discretionary.enabled && (
                  <tr>
                    <th scope="row">
                      Remaining wants budget
                      <span className="explain">
                        <Money cents={ats.discretionary.limitCents} /> limit −{' '}
                        <Money cents={ats.discretionary.spentCents} /> spent (
                        {formatDisplayDate(ats.period.start)} – {formatDisplayDate(ats.period.end)}
                        ).{' '}
                        {data.settings.strictBudgetCap
                          ? 'Available to spend is capped at this.'
                          : 'Shown for information; the cap is switched off in Settings.'}
                        {ats.discretionary.uncategorisedSpentCents > 0 && (
                          <>
                            {' '}
                            <Money cents={ats.discretionary.uncategorisedSpentCents} /> of
                            uncategorised spending isn't counted against any budget.
                          </>
                        )}
                      </span>
                    </th>
                    <td>
                      <Money cents={ats.discretionary.remainingCents} />
                    </td>
                  </tr>
                )}
                <tr className="total">
                  <th scope="row">
                    Available to spend
                    <span className="explain">
                      {ats.basis === 'cash_and_budget'
                        ? `The lower of the two figures above (${ats.bindingConstraint === 'budget' ? 'your budget' : 'cash'} is the limit), never below R0.`
                        : 'The cash-based amount, never below R0.'}
                    </span>
                  </th>
                  <td>
                    <Money cents={ats.availableCents} />
                  </td>
                </tr>
              </tbody>
            </table>
            {ats.expectedIncome.items.length > 0 && (
              <p className="small muted">
                Expected income of <Money cents={ats.expectedIncome.totalCents} /> is shown as a
                forecast only and is <strong>not</strong> included until it is recorded.
              </p>
            )}
          </details>
        </Card>

        {alerts.length > 0 && (
          <Card title="Alerts" className="span-all">
            {alerts.map((a) => (
              <Alert
                key={a.id}
                tone={a.tone}
                action={
                  <div className="btn-row">
                    {a.link && (
                      <Link className="btn btn-sm" to={a.link.to}>
                        {a.link.label}
                      </Link>
                    )}
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={() => setDismissed((d) => new Set(d).add(a.id))}
                    >
                      Dismiss
                    </button>
                  </div>
                }
              >
                <p>
                  <strong>{a.title}</strong>
                </p>
                {a.detail && <p className="small">{a.detail}</p>}
              </Alert>
            ))}
          </Card>
        )}

        <Card title="Spendable cash" action={<Badge kind="actual">Actual</Badge>}>
          <p className="stat-value">
            <Money cents={ats.eligibleCash.totalCents} tone />
          </p>
          <ul className="list">
            {ats.eligibleCash.included.map((l) => (
              <li key={l.accountId}>
                <span className="primary title">{l.name}</span>
                <Money cents={l.balanceCents} />
              </li>
            ))}
            {ats.eligibleCash.excluded.map((l) => (
              <li key={l.accountId}>
                <span className="primary title muted">{l.name} (not spendable)</span>
                <Money cents={l.balanceCents} className="muted" />
              </li>
            ))}
          </ul>
          <Link to="/accounts" className="small">
            Manage accounts
          </Link>
        </Card>

        <Card title="Upcoming commitments" action={<Badge kind="forecast">Forecast</Badge>}>
          <p className="stat-value">
            <Money cents={ats.commitments.totalCents} />
          </p>
          {ats.commitments.items.length === 0 ? (
            <p className="small muted">
              No unpaid bills due before {periodWord}.{' '}
              <Link to="/budgets">Add recurring bills</Link>.
            </p>
          ) : (
            <ul className="list">
              {ats.commitments.items.map((o) => (
                <li key={`${o.ruleId}-${o.date}`}>
                  <div className="primary">
                    <div className="title">{o.ruleName}</div>
                    <div className="meta">
                      <DateText date={o.date} />
                      {o.date < today ? (
                        <Badge kind="warning">Past due</Badge>
                      ) : (
                        <Badge kind="forecast">Expected</Badge>
                      )}
                    </div>
                  </div>
                  <div className="end">
                    <Money cents={o.expectedCents} />
                    <button
                      type="button"
                      className="btn btn-sm"
                      aria-label={`Mark ${o.ruleName} on ${formatDisplayDate(o.date)} as paid`}
                      onClick={() =>
                        void run(
                          () => setOccurrenceSettled(store, o.ruleId, o.date, true),
                          `${o.ruleName} marked as paid — no longer deducted`,
                        )
                      }
                    >
                      Mark paid
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <p className="xs faint">
            Bills are deducted until a matching posted payment is recorded (same amount ±10%, within
            a few days of the due date) or you mark them as paid.
          </p>
        </Card>

        <Card title="This month" action={<Badge kind="actual">Actual</Badge>}>
          <table className="breakdown">
            <tbody>
              <tr>
                <th scope="row">Income</th>
                <td>
                  <Money cents={model.month.summary.incomeCents} />
                </td>
              </tr>
              <tr>
                <th scope="row">
                  Spending
                  {model.month.summary.refundCents > 0 && (
                    <span className="explain">
                      After <Money cents={model.month.summary.refundCents} /> of refunds
                    </span>
                  )}
                </th>
                <td>
                  <Money cents={-model.month.summary.netExpenseCents} />
                </td>
              </tr>
              {view !== 'combined' &&
                (model.month.summary.ownerContributionCents > 0 ||
                  model.month.summary.ownerDrawCents > 0) && (
                  <tr>
                    <th scope="row">
                      Owner contributions / draws
                      <span className="explain">
                        Moves between personal and business — not income or spending.
                      </span>
                    </th>
                    <td>
                      <Money cents={model.month.summary.ownerContributionCents} /> /{' '}
                      <Money cents={model.month.summary.ownerDrawCents} />
                    </td>
                  </tr>
                )}
              <tr className="total">
                <th scope="row">Net</th>
                <td>
                  <Money cents={model.month.summary.netCents} signed tone />
                </td>
              </tr>
            </tbody>
          </table>
          {model.month.summary.transferLegsExcluded > 0 && (
            <p className="xs faint">
              {model.month.summary.transferLegsExcluded} transfer entr
              {model.month.summary.transferLegsExcluded === 1 ? 'y' : 'ies'} between your own
              accounts excluded.
            </p>
          )}
        </Card>

        {view !== 'business' && (
          <Card title="Savings">
            <div className="stack">
              <div>
                <div className="row-between small">
                  <span>Saved this period</span>
                  <span>
                    <Money cents={ats.plannedSavings.madeThisPeriodCents} /> of{' '}
                    <Money cents={ats.plannedSavings.targetCents} />
                  </span>
                </div>
                <ProgressBar
                  value={ats.plannedSavings.madeThisPeriodCents}
                  max={ats.plannedSavings.targetCents}
                  label="Savings this period"
                />
                <p className="xs faint">
                  Target: {data.settings.savingsRatePercent}% of{' '}
                  <Money cents={ats.plannedSavings.budgetableIncomeCents} /> (salary after tithe).
                  Counts goal allocations and transfers into non-spendable accounts.
                </p>
              </div>
              <div>
                <div className="row-between small">
                  <span>Emergency fund</span>
                  <span>
                    {model.emergency.targetCents !== null ? (
                      <>
                        <Money cents={model.emergency.balanceCents} /> of{' '}
                        <Money cents={model.emergency.targetCents} />
                      </>
                    ) : (
                      'Target not set'
                    )}
                  </span>
                </div>
                {model.emergency.targetCents !== null && (
                  <ProgressBar
                    value={model.emergency.balanceCents}
                    max={model.emergency.targetCents}
                    label="Emergency fund progress"
                  />
                )}
                <p className="xs faint">
                  {model.emergency.targetSource === 'essential_estimate' &&
                    model.essential.monthlyCents !== null && (
                      <>
                        Estimated: {model.emergency.months} ×{' '}
                        <Money cents={model.essential.monthlyCents} /> essential expenses a month (
                        {ESSENTIAL_SOURCE_TEXT[model.essential.source]}
                        {model.essential.source === 'history' &&
                          `, ${model.essential.monthsOfHistory} month(s)`}
                        ).{' '}
                        {model.emergency.percent !== null &&
                          `About ${model.emergency.percent}% complete.`}
                      </>
                    )}
                  {model.emergency.targetSource === 'fixed_override' &&
                    'Using the fixed target from Settings.'}
                  {model.emergency.targetSource === 'goal_fixed' &&
                    'Using the fixed target on the goal.'}
                  {model.emergency.targetSource === 'unknown' &&
                    'Not enough information yet: set essential budgets, an essential-expenses figure in Settings, or record a month of essential spending.'}
                  {!model.emergency.goalId && (
                    <>
                      {' '}
                      <Link to="/goals">Create an emergency fund goal</Link> to track progress.
                    </>
                  )}
                </p>
              </div>
            </div>
          </Card>
        )}

        <Card
          title="Recent transactions"
          action={
            <Link className="btn btn-sm btn-primary" to="/transactions?new=1">
              Add
            </Link>
          }
        >
          {model.recent.length === 0 ? (
            <Empty title="Nothing recorded yet" />
          ) : (
            <ul className="list">
              {model.recent.map((t) => (
                <li key={t.id}>
                  <div className="primary">
                    <div className="title">{t.description}</div>
                    <div className="meta">
                      <DateText date={t.date} />
                      <span>{accountsById.get(t.accountId)?.name}</span>
                      {t.type === 'transfer' ? (
                        <Badge>Transfer</Badge>
                      ) : t.categoryId ? (
                        <span>{categoriesById.get(t.categoryId)?.name}</span>
                      ) : (
                        <Badge kind="warning">Uncategorised</Badge>
                      )}
                      {t.status === 'pending' && <Badge>Pending</Badge>}
                    </div>
                  </div>
                  <Money cents={t.amountCents} signed tone />
                </li>
              ))}
            </ul>
          )}
          <div className="btn-row">
            <Link to="/transactions" className="small">
              All transactions
            </Link>
            {model.uncategorisedCount > 0 && (
              <Badge kind="warning">{model.uncategorisedCount} uncategorised</Badge>
            )}
          </div>
        </Card>
      </div>
      {statusNode}
    </>
  );
}
