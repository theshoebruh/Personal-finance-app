import { useMemo, useState, type FormEvent } from 'react';
import { useApp, useFinanceData, type FinanceData } from '@/app/AppContext';
import {
  GOAL_TYPES,
  GOAL_TYPE_LABELS,
  WORKSPACE_LABELS,
  type GoalType,
  type SavingsGoal,
  type Workspace,
} from '@/domain/models';
import { buildDashboard, type GoalSummary } from '@/domain/calculations/dashboard';
import { centsToDecimalString, parseAmountToCents } from '@/domain/money';
import { addGoalContribution, createDefaultGoals, saveGoal } from '@/services/planningService';
import {
  Alert,
  Badge,
  Card,
  DateText,
  Empty,
  Field,
  Loading,
  Money,
  ProgressBar,
  WorkspaceSwitcher,
  useStatus,
} from '@/components/ui';
import { PageHeader } from '@/components/PageHeader';
import { AccountOptions } from '../shared';

function GoalForm({
  data,
  goal,
  onDone,
  onCancel,
}: {
  data: FinanceData;
  goal: SavingsGoal | null;
  onDone: (m: string) => void;
  onCancel: () => void;
}) {
  const { store } = useApp();
  const [name, setName] = useState(goal?.name ?? '');
  const [goalType, setGoalType] = useState<GoalType>(goal?.goalType ?? 'personal_purchase');
  const [workspace, setWorkspace] = useState<Workspace>(goal?.workspace ?? 'personal');
  const [auto, setAuto] = useState(goal ? goal.targetMode === 'emergency_auto' : false);
  const [target, setTarget] = useState(
    goal?.targetCents != null ? centsToDecimalString(goal.targetCents) : '',
  );
  const [targetDate, setTargetDate] = useState(goal?.targetDate ?? '');
  const [priority, setPriority] = useState(String(goal?.priority ?? data.goals.length + 1));
  const [planned, setPlanned] = useState(
    goal?.plannedMonthlyCents != null ? centsToDecimalString(goal.plannedMonthlyCents) : '',
  );
  const [linked, setLinked] = useState(goal?.linkedAccountId ?? '');
  const [state, setState] = useState<SavingsGoal['state']>(goal?.state ?? 'active');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!name.trim()) errs.name = 'Give the goal a name';
    const t = target.trim() === '' ? null : parseAmountToCents(target);
    if (target.trim() !== '' && (t === null || t < 0)) errs.target = 'Enter a valid amount';
    const p = planned.trim() === '' ? undefined : parseAmountToCents(planned);
    if (planned.trim() !== '' && (p === null || (p ?? 0) < 0))
      errs.planned = 'Enter a valid amount';
    const prio = Number(priority);
    if (!Number.isInteger(prio) || prio < 1 || prio > 99)
      errs.priority = 'Use a number from 1 (highest)';
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;
    try {
      await saveGoal(store, {
        ...(goal ? { id: goal.id } : {}),
        name: name.trim(),
        goalType,
        workspace,
        targetMode: goalType === 'emergency_fund' && auto ? 'emergency_auto' : 'fixed',
        targetCents: goalType === 'emergency_fund' && auto ? null : t,
        ...(targetDate ? { targetDate } : {}),
        priority: prio,
        state,
        ...(linked ? { linkedAccountId: linked } : {}),
        ...(p != null ? { plannedMonthlyCents: p } : {}),
      });
      onDone(goal ? 'Goal updated' : 'Goal added');
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <form
      className="panel form"
      onSubmit={submit}
      noValidate
      aria-label={goal ? 'Edit goal' : 'Add goal'}
    >
      <h2>{goal ? `Edit ${goal.name}` : 'Add a savings goal'}</h2>
      {submitError && <Alert tone="negative">{submitError}</Alert>}
      <div className="form-row">
        <Field label="Name" htmlFor="g-name" error={errors.name}>
          <input id="g-name" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Goal type" htmlFor="g-type">
          <select
            id="g-type"
            value={goalType}
            onChange={(e) => setGoalType(e.target.value as GoalType)}
          >
            {GOAL_TYPES.map((t) => (
              <option key={t} value={t}>
                {GOAL_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Workspace" htmlFor="g-ws">
          <select
            id="g-ws"
            value={workspace}
            onChange={(e) => setWorkspace(e.target.value as Workspace)}
          >
            <option value="personal">Personal</option>
            <option value="business">Business</option>
          </select>
        </Field>
      </div>
      {goalType === 'emergency_fund' && (
        <label className="check">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
          Set the target automatically from essential expenses (months set in Settings)
        </label>
      )}
      <div className="form-row">
        {!(goalType === 'emergency_fund' && auto) && (
          <Field label="Target amount (R, optional)" htmlFor="g-target" error={errors.target}>
            <input
              id="g-target"
              inputMode="decimal"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
            />
          </Field>
        )}
        <Field label="Target date (optional)" htmlFor="g-date">
          <input
            id="g-date"
            type="date"
            value={targetDate}
            onChange={(e) => setTargetDate(e.target.value)}
          />
        </Field>
        <Field label="Planned monthly (R, optional)" htmlFor="g-planned" error={errors.planned}>
          <input
            id="g-planned"
            inputMode="decimal"
            value={planned}
            onChange={(e) => setPlanned(e.target.value)}
          />
        </Field>
      </div>
      <div className="form-row">
        <Field label="Priority (1 = first)" htmlFor="g-prio" error={errors.priority}>
          <input
            id="g-prio"
            inputMode="numeric"
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
          />
        </Field>
        <Field
          label="Money held in (optional)"
          htmlFor="g-linked"
          hint="If the money sits in a non-spendable savings account, it isn't subtracted from spendable cash again."
        >
          <select id="g-linked" value={linked} onChange={(e) => setLinked(e.target.value)}>
            <option value="">Spendable accounts (virtual allocation)</option>
            <AccountOptions accounts={data.accounts} />
          </select>
        </Field>
        <Field label="State" htmlFor="g-state">
          <select
            id="g-state"
            value={state}
            onChange={(e) => setState(e.target.value as SavingsGoal['state'])}
          >
            <option value="active">Active</option>
            <option value="paused">Paused</option>
            <option value="completed">Completed</option>
            <option value="archived">Archived</option>
          </select>
        </Field>
      </div>
      <div className="btn-row">
        <button type="submit" className="btn btn-primary">
          {goal ? 'Save goal' : 'Add goal'}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function ContributionForm({
  goal,
  summary,
  onDone,
  onCancel,
}: {
  goal: SavingsGoal;
  summary: GoalSummary;
  onDone: (m: string) => void;
  onCancel: () => void;
}) {
  const { store, today } = useApp();
  const [kind, setKind] = useState<'allocate' | 'withdraw'>('allocate');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(today);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const cents = parseAmountToCents(amount);
    if (cents === null || cents <= 0) {
      setError('Enter an amount greater than zero');
      return;
    }
    try {
      await addGoalContribution(store, {
        goalId: goal.id,
        date,
        amountCents: kind === 'allocate' ? cents : -cents,
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      onDone(kind === 'allocate' ? 'Allocation recorded' : 'Withdrawal recorded');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <form
      className="panel form"
      onSubmit={submit}
      noValidate
      aria-label={`Allocate to ${goal.name}`}
    >
      <p className="small muted">
        Allocations are <strong>virtual</strong>: they set money aside in this app and never change
        an account balance. To physically move money, record a transfer to your savings account too.
      </p>
      {error && <Alert tone="negative">{error}</Alert>}
      <div className="form-row">
        <Field label="Action" htmlFor={`c-kind-${goal.id}`}>
          <select
            id={`c-kind-${goal.id}`}
            value={kind}
            onChange={(e) => setKind(e.target.value as 'allocate' | 'withdraw')}
          >
            <option value="allocate">Allocate to goal</option>
            <option value="withdraw">Withdraw from goal</option>
          </select>
        </Field>
        <Field
          label="Amount (R)"
          htmlFor={`c-amt-${goal.id}`}
          hint={
            kind === 'withdraw' ? (
              <>
                Up to <Money cents={summary.progress.balanceCents} />
              </>
            ) : undefined
          }
        >
          <input
            id={`c-amt-${goal.id}`}
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </Field>
        <Field label="Date" htmlFor={`c-date-${goal.id}`}>
          <input
            id={`c-date-${goal.id}`}
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </Field>
      </div>
      <Field label="Note (optional)" htmlFor={`c-note-${goal.id}`}>
        <input id={`c-note-${goal.id}`} value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <div className="btn-row">
        <button type="submit" className="btn btn-primary">
          Save
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export function GoalsPage() {
  const { store, view, setView, today } = useApp();
  const data = useFinanceData();
  const { run, statusNode, setStatus } = useStatus();
  const [editing, setEditing] = useState<SavingsGoal | 'new' | null>(null);
  const [contributing, setContributing] = useState<string | null>(null);

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
  const goalsById = new Map(data.goals.map((g) => [g.id, g]));
  const accountsById = new Map(data.accounts.map((a) => [a.id, a]));
  const done = (m: string) => {
    setEditing(null);
    setContributing(null);
    setStatus({ tone: 'success', text: m });
  };

  return (
    <>
      <PageHeader title="Goals" actions={<WorkspaceSwitcher value={view} onChange={setView} />} />
      <Alert tone="info">
        Goal balances are <strong>virtual allocations</strong> of your real money — they never add
        to your cash. Allocations held in spendable accounts are reserved out of available-to-spend.
        Default priority: emergency fund → monthly buffer → personal purchases → business growth.
      </Alert>
      <div className="btn-row section">
        <button type="button" className="btn btn-primary" onClick={() => setEditing('new')}>
          Add goal
        </button>
        {data.goals.length === 0 && (
          <button
            type="button"
            className="btn"
            onClick={() => void run(() => createDefaultGoals(store), 'Default goals created')}
          >
            Create the four default goals
          </button>
        )}
      </div>
      {editing && (
        <GoalForm
          key={editing === 'new' ? 'new' : editing.id}
          data={data}
          goal={editing === 'new' ? null : editing}
          onDone={done}
          onCancel={() => setEditing(null)}
        />
      )}
      {model.goals.length === 0 ? (
        <Card>
          <Empty title="No goals in this workspace yet" />
        </Card>
      ) : (
        <div className="grid grid-2">
          {model.goals.map((s) => {
            const goal = goalsById.get(s.goalId)!;
            const p = s.progress;
            const linked = goal.linkedAccountId
              ? accountsById.get(goal.linkedAccountId)
              : undefined;
            const contributions = data.goalContributions
              .filter((c) => c.goalId === goal.id)
              .sort((a, b) => (a.date < b.date ? 1 : -1))
              .slice(0, 5);
            return (
              <Card
                key={goal.id}
                title={
                  <>
                    {s.priority}. {goal.name}
                  </>
                }
                action={
                  <div className="btn-row">
                    {goal.state !== 'active' && <Badge kind="warning">{goal.state}</Badge>}
                    {goal.isDemo && <Badge kind="demo">Demo</Badge>}
                    {view === 'combined' && <Badge>{WORKSPACE_LABELS[goal.workspace]}</Badge>}
                  </div>
                }
              >
                <p className="stat-value">
                  <Money cents={p.balanceCents} />
                  {p.targetCents !== null && (
                    <span className="small muted">
                      {' '}
                      of <Money cents={p.targetCents} />
                    </span>
                  )}
                </p>
                {p.targetCents !== null && p.targetCents > 0 && (
                  <ProgressBar
                    value={p.balanceCents}
                    max={p.targetCents}
                    label={`${goal.name} progress`}
                  />
                )}
                <ul className="list small">
                  <li>
                    <span>Held in</span>
                    <span>
                      {linked
                        ? `${linked.name}${linked.includeInSpendable ? '' : ' (not spendable)'}`
                        : 'Spendable accounts (virtual)'}
                    </span>
                  </li>
                  {p.percent !== null && (
                    <li>
                      <span>Progress</span>
                      <span>About {p.percent}% complete</span>
                    </li>
                  )}
                  {goal.targetMode === 'emergency_auto' && (
                    <li>
                      <span>Target</span>
                      <span>
                        {p.targetCents === null
                          ? 'Needs essential expenses (see Budgets/Settings)'
                          : `${data.settings.emergencyFundMonths} × essential monthly expenses (estimate)`}
                      </span>
                    </li>
                  )}
                  {goal.targetDate && (
                    <li>
                      <span>Target date</span>
                      <DateText date={goal.targetDate} />
                    </li>
                  )}
                  {p.requiredMonthlyCents !== null && (
                    <li>
                      <span>Needed per month to hit the date</span>
                      <Money cents={p.requiredMonthlyCents} />
                    </li>
                  )}
                  {goal.plannedMonthlyCents !== undefined && (
                    <li>
                      <span>Planned per month</span>
                      <Money cents={goal.plannedMonthlyCents} />
                    </li>
                  )}
                  {p.projectedCompletion && p.remainingCents !== 0 && (
                    <li>
                      <span>Projected completion (estimate)</span>
                      <DateText date={p.projectedCompletion} />
                    </li>
                  )}
                </ul>
                {s.behindSchedule && (
                  <Alert tone="info">
                    At the planned amount this goal may not reach its target by the date.
                  </Alert>
                )}
                {contributing === goal.id ? (
                  <ContributionForm
                    goal={goal}
                    summary={s}
                    onDone={done}
                    onCancel={() => setContributing(null)}
                  />
                ) : (
                  <div className="btn-row">
                    <button
                      type="button"
                      className="btn btn-sm btn-primary"
                      onClick={() => setContributing(goal.id)}
                    >
                      Allocate / withdraw
                    </button>
                    <button type="button" className="btn btn-sm" onClick={() => setEditing(goal)}>
                      Edit
                    </button>
                  </div>
                )}
                {contributions.length > 0 && (
                  <details className="explainer">
                    <summary>Recent allocations</summary>
                    <ul className="list small">
                      {contributions.map((c) => (
                        <li key={c.id}>
                          <span>
                            <DateText date={c.date} />
                            {c.note ? ` · ${c.note}` : ''}
                          </span>
                          <Money cents={c.amountCents} signed tone />
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </Card>
            );
          })}
        </div>
      )}
      {statusNode}
    </>
  );
}
