import { useSync } from '@/app/SyncContext';
import { statusText } from '@/features/settings/SyncCard';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useApp, useFinanceData } from '@/app/AppContext';
import { buildDashboard } from '@/domain/calculations/dashboard';
import { categoryBreakdown } from '@/domain/calculations/breakdown';
import { spendingByCategory } from '@/domain/calculations/reporting';
import { WORKSPACE_LABELS } from '@/domain/models';
import { formatDisplayDate } from '@/domain/dates';
import { formatZAR } from '@/domain/money';
import { linkPaymentToOccurrence, setOccurrenceSettled } from '@/services/planningService';
import type { Occurrence } from '@/domain/calculations/recurring';
import { loadDemoData } from '@/services/demoService';
import {
  Alert,
  Badge,
  Card,
  DateText,
  Empty,
  Loading,
  Money,
  WorkspaceSwitcher,
  useStatus,
} from '@/components/ui';
import { PageHeader } from '@/components/PageHeader';
import {
  BudgetBars,
  Donut,
  Ring,
  StatRing,
  fraction,
  percentLabel,
  type ChartColour,
} from '@/components/charts';
import { lookup } from '../shared';

const ESSENTIAL_SOURCE_TEXT = {
  override: 'your own essential-expenses figure from Settings',
  budgets: 'the total of your essential category budgets',
  history: 'average essential spending over recent complete months',
  insufficient_data: '',
} as const;

const shortDate = new Intl.DateTimeFormat('en-ZA', {
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
});

const dayFormat = new Intl.DateTimeFormat('en-ZA', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  timeZone: 'UTC',
});

export function DashboardPage() {
  const { store, view, setView, today } = useApp();
  const data = useFinanceData();
  const { run, statusNode } = useStatus();
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const sync = useSync();

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

  const breakdown = useMemo(() => {
    if (!data || !model) return null;
    const cats = lookup(data.categories);
    return categoryBreakdown(
      spendingByCategory(data.transactions, view, model.period.start, model.period.end),
      (id) => (id ? (cats.get(id)?.name ?? 'Unknown') : 'Uncategorised'),
    );
  }, [data, model, view]);

  if (!data || !model || !breakdown) return <Loading />;
  const { ats } = model;

  if (data.accounts.length === 0) {
    return (
      <>
        <PageHeader title="Welcome" />
        <Card className="hero onboarding">
          <h2>Let's work out what is safe to spend</h2>
          <p className="muted">
            {sync
              ? 'Your data syncs to your own account so it appears on your other devices.'
              : 'Everything is stored privately on this device.'}{' '}
            No bank login is needed — you add accounts and import CSV statements or add transactions
            yourself.
          </p>
          <ol className="steps-list">
            <li>
              <span className="steps-num" aria-hidden="true">
                1
              </span>
              <span>
                <Link to="/settings">Check your income plan and set your payday</Link> (defaults:
                R12,000 salary, R1,200 tithe, 20% savings).
              </span>
            </li>
            <li>
              <span className="steps-num" aria-hidden="true">
                2
              </span>
              <span>
                <Link to="/accounts">Add your accounts</Link> with their current balances.
              </span>
            </li>
            <li>
              <span className="steps-num" aria-hidden="true">
                3
              </span>
              <span>
                <Link to="/budgets">Add salary, tithe and bills</Link> as recurring items, and
                optional spending limits.
              </span>
            </li>
          </ol>
          <div className="btn-row">
            <Link className="btn btn-primary btn-lg" to="/accounts">
              Add your first account
            </Link>
            <button
              type="button"
              className="btn btn-lg"
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
  const budget = model.budgetOverview;
  const hasBudget = budget.limitCents > 0;

  const paymentSuggestions = model.paymentSuggestions;
  function suggestionsFor(o: Occurrence) {
    const found = paymentSuggestions[`${o.ruleId}|${o.date}`];
    if (!found) return null;
    return (
      <div className="suggestions">
        {found.map((t) => (
          <div key={t.id} className="row-between xs">
            <span>
              Could this be it? {t.description} · <DateText date={t.date} /> ·{' '}
              <Money cents={Math.abs(t.amountCents)} />
            </span>
            <button
              type="button"
              className="btn btn-sm"
              aria-label={`Link ${t.description} on ${formatDisplayDate(t.date)} to ${o.ruleName} due ${formatDisplayDate(o.date)}`}
              onClick={() =>
                void run(
                  () => linkPaymentToOccurrence(store, t.id, o.ruleId, o.date),
                  `${t.description} linked to ${o.ruleName} — not counted twice`,
                )
              }
            >
              Link
            </button>
          </div>
        ))}
      </div>
    );
  }

  return (
    <>
      <PageHeader
        title="Home"
        subtitle={`${dayFormat.format(new Date(`${today}T00:00:00Z`))} · day ${model.period.dayNumber} of ${model.period.totalDays}`}
        actions={<WorkspaceSwitcher value={view} onChange={setView} />}
      />

      {sync &&
        (sync.status.conflicts > 0 ||
          sync.status.failed > 0 ||
          sync.status.state === 'signed_out' ||
          sync.status.state === 'error') && (
          <Alert
            tone="warning"
            action={
              <Link className="btn btn-sm" to="/settings">
                Review sync
              </Link>
            }
          >
            <p>
              <strong>Sync needs attention:</strong> {statusText(sync.status)}.
            </p>
          </Alert>
        )}
      {hasDemo && (
        <Alert tone="info">
          Demo data is loaded (marked <Badge kind="demo">Demo</Badge>).{' '}
          <Link to="/settings">Clear it in Settings</Link> when you're ready to use your own
          figures.
        </Alert>
      )}

      <div className="home-grid">
        <Card className="hero home-hero" title={`Available to spend · ${WORKSPACE_LABELS[view]}`}>
          <div className="hero-body">
            {hasBudget ? (
              <Ring
                value={fraction(budget.remainingCents, budget.limitCents)}
                size={132}
                thickness={13}
                tone={budget.remainingCents < 0 ? 'negative' : 'positive'}
                label={
                  budget.remainingCents < 0
                    ? `Over this period's budget by ${formatZAR(-budget.remainingCents)}`
                    : `${percentLabel(budget.remainingCents, budget.limitCents)} of this period's budget left: ${formatZAR(budget.remainingCents)} of ${formatZAR(budget.limitCents)}`
                }
              >
                <span className="ring-big">
                  {budget.remainingCents < 0
                    ? 'Over'
                    : percentLabel(budget.remainingCents, budget.limitCents)}
                </span>
                <span className="ring-caption">budget left</span>
              </Ring>
            ) : (
              <Ring
                value={fraction(ats.window.daysRemaining, model.period.totalDays)}
                size={132}
                thickness={13}
                tone="chart-1"
                label={`${ats.window.daysRemaining} days left until ${formatDisplayDate(ats.window.end)}`}
              >
                <span className="ring-big">{ats.window.daysRemaining}</span>
                <span className="ring-caption">days left</span>
              </Ring>
            )}
            <div className="hero-figures">
              <p className="hero-amount" aria-describedby="ats-basis">
                <Money cents={ats.availableCents} split />
              </p>
              <p className="hero-line">
                <strong>
                  <Money cents={ats.dailyAllowanceCents} />
                </strong>{' '}
                a day until <DateText date={ats.window.end} />
              </p>
              {hasBudget && (
                <p className="hero-line">
                  <strong>
                    <Money cents={Math.max(0, budget.remainingCents)} />
                  </strong>{' '}
                  of <Money cents={budget.limitCents} /> budget left
                </p>
              )}
              <p className="hero-line">
                {ats.window.nextPayday ? (
                  <>
                    Next payday <DateText date={ats.window.nextPayday} />
                  </>
                ) : (
                  'No payday set — using month-end'
                )}{' '}
                · <Link to="/settings">Edit</Link>
              </p>
            </div>
          </div>
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
            <p id="ats-basis" className="xs faint">
              {ats.basis === 'cash_and_budget'
                ? 'Based on spendable cash, unpaid commitments and reserves, capped by your remaining wants budget.'
                : 'Based on spendable cash minus unpaid commitments and reserves (no category-budget cap applied).'}{' '}
              The daily figure is guidance, not a target to spend.
            </p>
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

        <div className="stat-rings home-rings" aria-label="Period at a glance" role="group">
          <StatRing
            value={fraction(ats.window.daysRemaining, model.period.totalDays)}
            tone="chart-1"
            label={`${ats.window.daysRemaining} day${ats.window.daysRemaining === 1 ? '' : 's'} left until ${formatDisplayDate(ats.window.end)}, today included`}
            centre={ats.window.daysRemaining}
            caption="Days left"
            detail={<>to {shortDate.format(new Date(`${ats.window.end}T00:00:00Z`))}</>}
          />
          {view !== 'business' ? (
            <StatRing
              value={fraction(
                ats.plannedSavings.madeThisPeriodCents,
                ats.plannedSavings.targetCents,
              )}
              tone="chart-6"
              label={`Saved ${formatZAR(ats.plannedSavings.madeThisPeriodCents)} of a ${formatZAR(ats.plannedSavings.targetCents)} target this period`}
              centre={percentLabel(
                ats.plannedSavings.madeThisPeriodCents,
                ats.plannedSavings.targetCents,
              )}
              caption="Saved"
              detail={<Money cents={ats.plannedSavings.madeThisPeriodCents} whole />}
            />
          ) : (
            <StatRing
              value={fraction(
                model.period.summary.netExpenseCents,
                model.period.summary.incomeCents,
              )}
              tone="chart-2"
              label={`Spent ${formatZAR(model.period.summary.netExpenseCents)} against income of ${formatZAR(model.period.summary.incomeCents)} this period`}
              centre={percentLabel(
                model.period.summary.netExpenseCents,
                model.period.summary.incomeCents,
              )}
              caption="Spent of income"
              detail={<Money cents={model.period.summary.netExpenseCents} whole />}
            />
          )}
          {view !== 'business' && model.emergency.targetCents !== null ? (
            <StatRing
              value={(model.emergency.percent ?? 0) / 100}
              tone="chart-4"
              label={`Emergency fund ${model.emergency.percent ?? 0}% complete: ${formatZAR(model.emergency.balanceCents)} of ${formatZAR(model.emergency.targetCents)}`}
              centre={`${model.emergency.percent ?? 0}%`}
              caption="Emergency fund"
              detail={<Money cents={model.emergency.balanceCents} whole />}
            />
          ) : (
            <Link className="stat-ring" to={view === 'business' ? '/reports' : '/goals'}>
              <Ring
                value={0}
                size={72}
                thickness={8}
                label={view === 'business' ? 'Reports' : 'Emergency fund target not set'}
              >
                <span className="stat-ring-centre">—</span>
              </Ring>
              <span className="stat-ring-caption">
                {view === 'business' ? 'Reports' : 'Emergency fund'}
              </span>
              <span className="stat-ring-detail link-text">
                {view === 'business' ? 'Open' : 'Set a target'}
              </span>
            </Link>
          )}
        </div>

        {alerts.length > 0 && (
          <Card title="Needs your attention" className="span-all">
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

        <Card
          title="Spent this period"
          action={
            <Link className="card-link" to="/reports">
              Reports ›
            </Link>
          }
        >
          {breakdown.slices.length === 0 ? (
            <Empty title="No spending yet this period" icon="reports">
              <p className="small">Import a statement or add a transaction to see where it goes.</p>
            </Empty>
          ) : (
            <Donut
              label={`Spending by category, ${formatDisplayDate(model.period.start)} to ${formatDisplayDate(model.period.end)}`}
              centreLabel="spent"
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
          title="Budget this period"
          action={
            <Link className="card-link" to="/budgets">
              Edit limits ›
            </Link>
          }
        >
          <p className="small muted">
            <DateText date={model.period.start} /> – <DateText date={model.period.end} />
            {model.period.mode === 'calendar_month' && data.settings.paydayDayOfMonth !== null && (
              <span className="faint"> (calendar month — switch to pay periods in Settings)</span>
            )}
          </p>
          {budget.lines.length === 0 ? (
            <Empty title="No spending limits yet" icon="budgets">
              <p className="small">
                <Link to="/budgets">Set monthly limits</Link> to track spending by category.
              </p>
            </Empty>
          ) : (
            <>
              <div className="budget-summary">
                <div>
                  <span className="label">Budgeted</span>
                  <Money cents={budget.limitCents} />
                </div>
                <div>
                  <span className="label">Spent</span>
                  <Money cents={budget.spentCents} />
                </div>
                <div>
                  <span className="label">{budget.remainingCents < 0 ? 'Over by' : 'Left'}</span>
                  <Money
                    cents={Math.abs(budget.remainingCents)}
                    className={budget.remainingCents < 0 ? 'negative' : 'positive'}
                  />
                </div>
              </div>
              <BudgetBars
                label="Spending against each limit"
                lines={budget.lines.map((l) => ({
                  key: l.budgetId,
                  label: l.categoryName,
                  limitCents: l.limitCents,
                  spentCents: l.spentCents,
                  remainingCents: l.remainingCents,
                }))}
              />
            </>
          )}
          {(budget.unbudgetedSpentCents > 0 || budget.uncategorisedSpentCents > 0) && (
            <p className="xs faint">
              Also spent: <Money cents={budget.unbudgetedSpentCents} /> in categories without a
              limit
              {budget.uncategorisedSpentCents > 0 && (
                <>
                  {' '}
                  and <Money cents={budget.uncategorisedSpentCents} />{' '}
                  <Link to="/transactions?status=needs_review">uncategorised</Link>
                </>
              )}
              .
            </p>
          )}
          <p className="xs faint">
            Limits start fresh each period; unspent or overspent money stays in your account balance
            and is reflected in what's available next period.
          </p>
          <details className="explainer">
            <summary>
              Last period (<DateText date={model.lastPeriod.start} /> –{' '}
              <DateText date={model.lastPeriod.end} />)
            </summary>
            <table className="breakdown">
              <tbody>
                <tr>
                  <th scope="row">Income</th>
                  <td>
                    <Money cents={model.lastPeriod.summary.incomeCents} />
                  </td>
                </tr>
                <tr>
                  <th scope="row">Spending</th>
                  <td>
                    <Money cents={-model.lastPeriod.summary.netExpenseCents} />
                  </td>
                </tr>
                {model.lastPeriod.budgetLimitCents > 0 && (
                  <tr>
                    <th scope="row">
                      Budgeted categories
                      <span className="explain">
                        <Money cents={model.lastPeriod.budgetSpentCents} /> spent of{' '}
                        <Money cents={model.lastPeriod.budgetLimitCents} /> (today's limits)
                      </span>
                    </th>
                    <td>
                      <Money
                        cents={
                          model.lastPeriod.budgetLimitCents - model.lastPeriod.budgetSpentCents
                        }
                        signed
                        tone
                      />
                    </td>
                  </tr>
                )}
                {view !== 'business' && (
                  <tr>
                    <th scope="row">Saved</th>
                    <td>
                      <Money cents={model.lastPeriod.savingsMadeCents} />
                    </td>
                  </tr>
                )}
                <tr className="total">
                  <th scope="row">Net</th>
                  <td>
                    <Money cents={model.lastPeriod.summary.netCents} signed tone />
                  </td>
                </tr>
              </tbody>
            </table>
          </details>
        </Card>

        <Card title="Coming up" action={<Badge kind="forecast">Forecast</Badge>}>
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
                  {suggestionsFor(o)}
                </li>
              ))}
            </ul>
          )}
          {model.lateIncome.some((o) => model.paymentSuggestions[`${o.ruleId}|${o.date}`]) && (
            <>
              <h3 className="small">Expected income not recognised yet</h3>
              <ul className="list">
                {model.lateIncome
                  .filter((o) => model.paymentSuggestions[`${o.ruleId}|${o.date}`])
                  .map((o) => (
                    <li key={`${o.ruleId}-${o.date}`}>
                      <div className="primary">
                        <div className="title">{o.ruleName}</div>
                        <div className="meta">
                          <DateText date={o.date} />
                        </div>
                      </div>
                      <div className="end">
                        <Money cents={o.expectedCents} />
                      </div>
                      {suggestionsFor(o)}
                    </li>
                  ))}
              </ul>
            </>
          )}
          <p className="xs faint">
            Bills are deducted until a matching posted payment is recorded (same amount ±10%, within
            a few days of the due date) or you mark them as paid.
          </p>
        </Card>

        <Card title="This period" action={<Badge kind="actual">Actual</Badge>}>
          <table className="breakdown">
            <tbody>
              <tr>
                <th scope="row">Income</th>
                <td>
                  <Money cents={model.period.summary.incomeCents} />
                </td>
              </tr>
              <tr>
                <th scope="row">
                  Spending
                  {model.period.summary.refundCents > 0 && (
                    <span className="explain">
                      After <Money cents={model.period.summary.refundCents} /> of refunds
                    </span>
                  )}
                </th>
                <td>
                  <Money cents={-model.period.summary.netExpenseCents} />
                </td>
              </tr>
              {view !== 'combined' &&
                (model.period.summary.ownerContributionCents > 0 ||
                  model.period.summary.ownerDrawCents > 0) && (
                  <tr>
                    <th scope="row">
                      Owner contributions / draws
                      <span className="explain">
                        Moves between personal and business — not income or spending.
                      </span>
                    </th>
                    <td>
                      <Money cents={model.period.summary.ownerContributionCents} /> /{' '}
                      <Money cents={model.period.summary.ownerDrawCents} />
                    </td>
                  </tr>
                )}
              <tr className="total">
                <th scope="row">Net</th>
                <td>
                  <Money cents={model.period.summary.netCents} signed tone />
                </td>
              </tr>
            </tbody>
          </table>
          {model.period.summary.transferLegsExcluded > 0 && (
            <p className="xs faint">
              {model.period.summary.transferLegsExcluded} transfer entr
              {model.period.summary.transferLegsExcluded === 1 ? 'y' : 'ies'} between your own
              accounts excluded.
            </p>
          )}
        </Card>

        <Card
          title="Spendable cash"
          action={
            <Link className="card-link" to="/accounts">
              Accounts ›
            </Link>
          }
        >
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
        </Card>

        {view !== 'business' && (
          <Card title="Savings and emergency fund">
            <div className="stack">
              <div>
                <div className="row-between small">
                  <span>Saved this period</span>
                  <span>
                    <Money cents={ats.plannedSavings.madeThisPeriodCents} /> of{' '}
                    <Money cents={ats.plannedSavings.targetCents} />
                  </span>
                </div>
                <p className="xs faint">
                  Target: {data.settings.savingsRatePercent}% of{' '}
                  <Money cents={ats.plannedSavings.budgetableIncomeCents} /> (salary after tithe).
                  Counts goal allocations and transfers into non-spendable accounts.
                </p>
                {model.unpairedTransfers.length > 0 && (
                  <p className="xs">
                    <Badge kind="warning">Not counted</Badge>{' '}
                    <Money
                      cents={-model.unpairedTransfers.reduce((sum, t) => sum + t.amountCents, 0)}
                    />{' '}
                    in {model.unpairedTransfers.length} transfer
                    {model.unpairedTransfers.length === 1 ? '' : 's'} out of a spendable account
                    with no receiving side recorded. If it went to savings, import that account's
                    statement or record the other side, and it will count.
                  </p>
                )}
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
            <Link className="card-link" to="/transactions">
              All ›
            </Link>
          }
        >
          {model.recent.length === 0 ? (
            <Empty title="Nothing recorded yet" icon="activity">
              <p className="small">
                <Link to="/import">Import a statement</Link> or{' '}
                <Link to="/transactions?new=1">add a transaction</Link>.
              </p>
            </Empty>
          ) : (
            <ul className="list">
              {model.recent.map((t) => (
                <li key={t.id}>
                  <span className="tx-avatar" aria-hidden="true">
                    {t.description.trim().slice(0, 1).toUpperCase() || '·'}
                  </span>
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
          {model.uncategorisedCount > 0 && (
            <Link className="btn btn-sm" to="/transactions?status=needs_review">
              <Badge kind="warning">{model.uncategorisedCount}</Badge> to categorise
            </Link>
          )}
        </Card>
      </div>
      {statusNode}
    </>
  );
}
