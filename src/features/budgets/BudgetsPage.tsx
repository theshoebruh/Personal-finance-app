import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { useConfirm } from '@/components/ConfirmDialog';
import { useApp, useFinanceData, type FinanceData } from '@/app/AppContext';
import {
  CATEGORY_GROUP_LABELS,
  FREQUENCIES,
  FREQUENCY_LABELS,
  WORKSPACE_LABELS,
  type Category,
  type RecurringRule,
  type Workspace,
} from '@/domain/models';
import { benchmark503020, budgetableIncome, savingsTarget } from '@/domain/calculations/income';
import { budgetPeriod, withReceivedPaydays } from '@/domain/calculations/period';
import { spendingByCategory, inView } from '@/domain/calculations/reporting';
import { estimateEssentialMonthly } from '@/domain/calculations/goals';
import { monthlyEquivalent, nextDueDate } from '@/domain/calculations/recurring';
import { formatDisplayDate } from '@/domain/dates';
import { centsToDecimalString, parseAmountToCents } from '@/domain/money';
import {
  createSalaryAndTitheRules,
  deleteRecurringRule,
  saveRecurringRule,
  setCategoryBudget,
} from '@/services/planningService';
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
import { AccountOptions, CategoryOptions, lookup } from '../shared';

function IncomePlanCard({ data }: { data: FinanceData }) {
  const { today } = useApp();
  const s = data.settings;
  const base = budgetableIncome(s.monthlySalaryCents, s.monthlyTitheCents);
  const target = savingsTarget(base, s.savingsRatePercent);
  const bench = benchmark503020(base);
  const essential = estimateEssentialMonthly(
    today,
    s,
    data.budgets,
    data.categories,
    data.transactions,
  );
  const essentialOver =
    essential.monthlyCents !== null && essential.monthlyCents > bench.needsCents;
  const leftAfterEssentials =
    essential.monthlyCents === null ? null : base - essential.monthlyCents;
  const savingsTooHigh = leftAfterEssentials !== null && target > leftAfterEssentials;

  return (
    <Card title="Monthly income plan" action={<Link to="/settings">Edit</Link>}>
      <table className="breakdown">
        <tbody>
          <tr>
            <th scope="row">Recorded salary</th>
            <td>
              <Money cents={s.monthlySalaryCents} />
            </td>
          </tr>
          <tr>
            <th scope="row">
              − Tithe (committed)
              <span className="explain">
                Taken off once here; a recorded tithe payment is matched, not deducted again.
              </span>
            </th>
            <td>
              <Money cents={-s.monthlyTitheCents} />
            </td>
          </tr>
          <tr className="total">
            <th scope="row">Budgetable salary</th>
            <td>
              <Money cents={base} />
            </td>
          </tr>
          <tr>
            <th scope="row">Savings target ({s.savingsRatePercent}%)</th>
            <td>
              <Money cents={target} />
            </td>
          </tr>
        </tbody>
      </table>
      <details className="explainer">
        <summary>Compare with the 50/30/20 guideline</summary>
        <p className="small muted">
          A flexible starting benchmark applied to your salary after tithe — not a rule, and no
          limits are forced.
        </p>
        <table className="breakdown">
          <tbody>
            <tr>
              <th scope="row">Essential needs (50%)</th>
              <td>
                <Money cents={bench.needsCents} />
              </td>
            </tr>
            <tr>
              <th scope="row">Wants / lifestyle (30%)</th>
              <td>
                <Money cents={bench.wantsCents} />
              </td>
            </tr>
            <tr>
              <th scope="row">Savings and goals (20%)</th>
              <td>
                <Money cents={bench.savingsCents} />
              </td>
            </tr>
            <tr>
              <th scope="row">
                Your essential costs
                <span className="explain">
                  {essential.source === 'override' && 'From Settings.'}
                  {essential.source === 'budgets' && 'Total of your essential category budgets.'}
                  {essential.source === 'history' &&
                    `Average of ${essential.monthsOfHistory} recent month(s).`}
                  {essential.source === 'insufficient_data' &&
                    'Not known yet — add essential budgets below.'}
                </span>
              </th>
              <td>
                {essential.monthlyCents === null ? '—' : <Money cents={essential.monthlyCents} />}
              </td>
            </tr>
          </tbody>
        </table>
        {essentialOver && (
          <Alert tone="info">
            Your essential costs are above the 50% guideline. That's common — the guideline may not
            fit this month, and the wants and savings shares may need to be smaller.
          </Alert>
        )}
        {savingsTooHigh && leftAfterEssentials !== null && (
          <Alert tone="warning">
            Your {s.savingsRatePercent}% savings target (<Money cents={target} />) is more than
            what's left after essential costs (<Money cents={Math.max(0, leftAfterEssentials)} />
            ). You could lower the target for now or revisit essential costs and goals.
          </Alert>
        )}
      </details>
    </Card>
  );
}

function CategoryLimits({ data, workspace }: { data: FinanceData; workspace: Workspace }) {
  const { store, today } = useApp();
  const { run, statusNode } = useStatus();
  const period = budgetPeriod(
    today,
    withReceivedPaydays(today, data.settings, data.recurringRules, data.transactions),
  );
  const spent = spendingByCategory(data.transactions, workspace, period.start, period.end);
  const budgetsByCat = new Map(
    data.budgets.filter((b) => b.workspace === workspace && b.active).map((b) => [b.categoryId, b]),
  );
  const cats = data.categories
    .filter(
      (c) =>
        !c.archived &&
        c.kind === 'expense' &&
        (c.workspace === 'both' || c.workspace === workspace),
    )
    .sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name));
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const save = (c: Category) => {
    const raw = drafts[c.id];
    if (raw === undefined) return;
    const trimmed = raw.trim();
    const cents = trimmed === '' ? null : parseAmountToCents(trimmed);
    if (trimmed !== '' && (cents === null || cents < 0)) {
      void run(async () => {
        throw new Error(`Enter a valid limit for ${c.name}, or leave it blank for no limit`);
      });
      return;
    }
    void run(
      async () => {
        await setCategoryBudget(store, c.id, workspace, cents);
        setDrafts((d) => {
          const { [c.id]: _drop, ...rest } = d;
          return rest;
        });
      },
      cents === null ? `Removed limit for ${c.name}` : `Saved limit for ${c.name}`,
    );
  };

  const groups = [...new Set(cats.map((c) => c.group))];
  return (
    <Card title={`${WORKSPACE_LABELS[workspace]} spending limits`}>
      <p className="small muted">
        Monthly limits for {formatDisplayDate(period.start)} – {formatDisplayDate(period.end)}.
        Leave blank for no limit. Limits on <strong>wants</strong> categories cap the
        available-to-spend figure when strict budgets are on.
      </p>
      {groups.map((g) => (
        <div key={g} className="section">
          <h3 className="small muted">{CATEGORY_GROUP_LABELS[g]}</h3>
          <ul className="list">
            {cats
              .filter((c) => c.group === g)
              .map((c) => {
                const budget = budgetsByCat.get(c.id);
                const s = Math.max(0, spent.get(c.id) ?? 0);
                const draft =
                  drafts[c.id] ?? (budget ? centsToDecimalString(budget.limitCents) : '');
                return (
                  <li key={c.id}>
                    <div className="primary">
                      <div className="title">{c.name}</div>
                      <div className="meta">
                        <span>
                          Spent <Money cents={s} />
                        </span>
                        {budget && (
                          <span>
                            {s > budget.limitCents ? (
                              <Badge kind="warning">
                                Over by <Money cents={s - budget.limitCents} />
                              </Badge>
                            ) : (
                              <>
                                <Money cents={budget.limitCents - s} /> left
                              </>
                            )}
                          </span>
                        )}
                      </div>
                      {budget && budget.limitCents > 0 && (
                        <ProgressBar
                          value={s}
                          max={budget.limitCents}
                          label={`${c.name} budget used`}
                        />
                      )}
                    </div>
                    <div className="end">
                      <label className="visually-hidden" htmlFor={`limit-${c.id}`}>
                        Monthly limit for {c.name} (R)
                      </label>
                      <input
                        id={`limit-${c.id}`}
                        className="num"
                        inputMode="decimal"
                        placeholder="No limit"
                        value={draft}
                        size={8}
                        onChange={(e) => setDrafts((d) => ({ ...d, [c.id]: e.target.value }))}
                        onBlur={() => save(c)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') save(c);
                        }}
                      />
                    </div>
                  </li>
                );
              })}
          </ul>
        </div>
      ))}
      {statusNode}
    </Card>
  );
}

type RuleDraft = {
  name: string;
  direction: 'income' | 'expense';
  amount: string;
  frequency: RecurringRule['frequency'];
  intervalDays: string;
  startDate: string;
  endDate: string;
  accountId: string;
  categoryId: string;
  workspace: Workspace;
  matchWindowDays: string;
  alertLeadDays: string;
};

function draftFrom(rule: RecurringRule | null, today: string, workspace: Workspace): RuleDraft {
  return {
    name: rule?.name ?? '',
    direction: rule?.direction ?? 'expense',
    amount: rule ? centsToDecimalString(rule.amountCents) : '',
    frequency: rule?.frequency ?? 'monthly',
    intervalDays: rule?.intervalDays?.toString() ?? '',
    startDate: rule?.startDate ?? today,
    endDate: rule?.endDate ?? '',
    accountId: rule?.accountId ?? '',
    categoryId: rule?.categoryId ?? '',
    workspace: rule?.workspace ?? workspace,
    matchWindowDays: String(rule?.matchWindowDays ?? 5),
    alertLeadDays: String(rule?.alertLeadDays ?? 3),
  };
}

function RecurringForm({
  data,
  rule,
  onDone,
  onCancel,
}: {
  data: FinanceData;
  rule: RecurringRule | null;
  onDone: (msg: string) => void;
  onCancel: () => void;
}) {
  const { store, today, view } = useApp();
  const [d, setD] = useState(() =>
    draftFrom(rule, today, view === 'business' ? 'business' : 'personal'),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const set = <K extends keyof RuleDraft>(k: K, v: RuleDraft[K]) => setD((x) => ({ ...x, [k]: v }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = {};
    const cents = parseAmountToCents(d.amount);
    if (!d.name.trim()) errs.name = 'Give it a name';
    if (cents === null || cents <= 0) errs.amount = 'Enter an amount greater than zero';
    if (!d.startDate) errs.startDate = 'Choose the next due date';
    const interval = Number(d.intervalDays);
    if (
      d.frequency === 'custom_days' &&
      (!Number.isInteger(interval) || interval < 1 || interval > 366)
    ) {
      errs.intervalDays = 'Enter a number of days between 1 and 366';
    }
    if (d.endDate && d.endDate < d.startDate) errs.endDate = 'End date must be after the start';
    setErrors(errs);
    if (Object.keys(errs).length > 0 || cents === null) return;
    const account = data.accounts.find((a) => a.id === d.accountId);
    try {
      await saveRecurringRule(store, {
        ...(rule ? { id: rule.id, settledDates: rule.settledDates } : {}),
        name: d.name.trim(),
        direction: d.direction,
        amountCents: cents,
        frequency: d.frequency,
        ...(d.frequency === 'custom_days' ? { intervalDays: interval } : {}),
        startDate: d.startDate,
        ...(d.endDate ? { endDate: d.endDate } : {}),
        ...(d.accountId ? { accountId: d.accountId } : {}),
        ...(d.categoryId ? { categoryId: d.categoryId } : {}),
        workspace: account?.workspace ?? d.workspace,
        active: rule?.active ?? true,
        matchWindowDays: Math.min(31, Math.max(0, Number(d.matchWindowDays) || 0)),
        alertLeadDays: Math.min(60, Math.max(0, Number(d.alertLeadDays) || 0)),
      });
      onDone(rule ? 'Recurring item updated' : 'Recurring item added');
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    }
  }

  const account = data.accounts.find((a) => a.id === d.accountId);
  const ws = account?.workspace ?? d.workspace;
  return (
    <form
      className="panel form"
      onSubmit={submit}
      noValidate
      aria-label={rule ? 'Edit recurring item' : 'Add recurring item'}
    >
      <h2>{rule ? `Edit ${rule.name}` : 'Add a recurring item'}</h2>
      <p className="small muted">
        A recurring item is a forecast, not a transaction. Expected bills are deducted from
        available-to-spend until a matching payment is recorded; expected income is never counted
        until it arrives.
      </p>
      {submitError && <Alert tone="negative">{submitError}</Alert>}
      <div className="form-row">
        <Field label="Name" htmlFor="rr-name" error={errors.name}>
          <input
            id="rr-name"
            value={d.name}
            onChange={(e) => set('name', e.target.value)}
            placeholder="e.g. Rent"
          />
        </Field>
        <Field label="Kind" htmlFor="rr-dir">
          <select
            id="rr-dir"
            value={d.direction}
            onChange={(e) => {
              set('direction', e.target.value as 'income' | 'expense');
              set('categoryId', '');
            }}
          >
            <option value="expense">Bill / committed outgoing</option>
            <option value="income">Expected income</option>
          </select>
        </Field>
        <Field label="Expected amount (R)" htmlFor="rr-amount" error={errors.amount}>
          <input
            id="rr-amount"
            inputMode="decimal"
            value={d.amount}
            onChange={(e) => set('amount', e.target.value)}
          />
        </Field>
      </div>
      <div className="form-row">
        <Field label="Frequency" htmlFor="rr-freq">
          <select
            id="rr-freq"
            value={d.frequency}
            onChange={(e) => set('frequency', e.target.value as RecurringRule['frequency'])}
          >
            {FREQUENCIES.map((f) => (
              <option key={f} value={f}>
                {FREQUENCY_LABELS[f]}
              </option>
            ))}
          </select>
        </Field>
        {d.frequency === 'custom_days' && (
          <Field label="Every how many days" htmlFor="rr-int" error={errors.intervalDays}>
            <input
              id="rr-int"
              inputMode="numeric"
              value={d.intervalDays}
              onChange={(e) => set('intervalDays', e.target.value)}
            />
          </Field>
        )}
        <Field label="Next / first due date" htmlFor="rr-start" error={errors.startDate}>
          <input
            id="rr-start"
            type="date"
            value={d.startDate}
            onChange={(e) => set('startDate', e.target.value)}
          />
        </Field>
        <Field label="End date (optional)" htmlFor="rr-end" error={errors.endDate}>
          <input
            id="rr-end"
            type="date"
            value={d.endDate}
            onChange={(e) => set('endDate', e.target.value)}
          />
        </Field>
      </div>
      <div className="form-row">
        <Field
          label="Account (optional)"
          htmlFor="rr-acc"
          hint="Matching only looks at this account when set."
        >
          <select
            id="rr-acc"
            value={d.accountId}
            onChange={(e) => set('accountId', e.target.value)}
          >
            <option value="">Any account</option>
            <AccountOptions accounts={data.accounts} />
          </select>
        </Field>
        {!account && (
          <Field label="Workspace" htmlFor="rr-ws">
            <select
              id="rr-ws"
              value={d.workspace}
              onChange={(e) => set('workspace', e.target.value as Workspace)}
            >
              <option value="personal">Personal</option>
              <option value="business">Business</option>
            </select>
          </Field>
        )}
        <Field label="Category (optional)" htmlFor="rr-cat">
          <select
            id="rr-cat"
            value={d.categoryId}
            onChange={(e) => set('categoryId', e.target.value)}
          >
            <option value="">None</option>
            <CategoryOptions categories={data.categories} workspace={ws} kind={d.direction} />
          </select>
        </Field>
      </div>
      <div className="form-row">
        <Field
          label="Match window (days ±)"
          htmlFor="rr-win"
          hint="How far from the due date a payment can be and still match."
        >
          <input
            id="rr-win"
            inputMode="numeric"
            value={d.matchWindowDays}
            onChange={(e) => set('matchWindowDays', e.target.value)}
          />
        </Field>
        <Field label="Alert days before" htmlFor="rr-lead">
          <input
            id="rr-lead"
            inputMode="numeric"
            value={d.alertLeadDays}
            onChange={(e) => set('alertLeadDays', e.target.value)}
          />
        </Field>
      </div>
      <div className="btn-row">
        <button type="submit" className="btn btn-primary">
          {rule ? 'Save changes' : 'Add recurring item'}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function RecurringItems({ data }: { data: FinanceData }) {
  const { store, today, view } = useApp();
  const { run, statusNode, setStatus } = useStatus();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<RecurringRule | 'new' | null>(null);
  const [salaryAccount, setSalaryAccount] = useState('');
  const categories = lookup(data.categories);
  const rules = data.recurringRules
    .filter((r) => inView(r.workspace, view))
    .sort((a, b) => a.direction.localeCompare(b.direction) || a.name.localeCompare(b.name));
  const hasTithe = data.recurringRules.some(
    (r) => r.categoryId === 'cat-tithe' || /tithe/i.test(r.name),
  );
  const personalAccounts = data.accounts.filter((a) => a.active && a.workspace === 'personal');

  return (
    <Card
      title="Recurring income and bills"
      action={
        <button type="button" className="btn btn-sm btn-primary" onClick={() => setEditing('new')}>
          Add
        </button>
      }
    >
      {editing && (
        <RecurringForm
          key={editing === 'new' ? 'new' : editing.id}
          data={data}
          rule={editing === 'new' ? null : editing}
          onCancel={() => setEditing(null)}
          onDone={(msg) => {
            setEditing(null);
            setStatus({ tone: 'success', text: msg });
          }}
        />
      )}

      {!hasTithe && view !== 'business' && (
        <div className="panel">
          <p className="small">
            Add your salary (<Money cents={data.settings.monthlySalaryCents} />) and tithe (
            <Money cents={data.settings.monthlyTitheCents} />) as monthly items on your payday, from
            the income plan.
          </p>
          {data.settings.paydayDayOfMonth === null ? (
            <p className="small muted">
              <Link to="/settings">Set your payday</Link> first.
            </p>
          ) : personalAccounts.length === 0 ? (
            <p className="small muted">
              <Link to="/accounts">Add a personal account</Link> first.
            </p>
          ) : (
            <div className="btn-row">
              <label className="visually-hidden" htmlFor="salary-acc">
                Account salary is paid into
              </label>
              <select
                id="salary-acc"
                value={salaryAccount}
                onChange={(e) => setSalaryAccount(e.target.value)}
              >
                <option value="">Salary paid into…</option>
                <AccountOptions accounts={personalAccounts} />
              </select>
              <button
                type="button"
                className="btn btn-sm"
                disabled={!salaryAccount}
                onClick={() =>
                  void run(
                    () => createSalaryAndTitheRules(store, data.settings, salaryAccount, today),
                    'Salary and tithe added as recurring items',
                  )
                }
              >
                Add salary and tithe
              </button>
            </div>
          )}
        </div>
      )}

      {rules.length === 0 ? (
        <Empty title="No recurring items yet">
          <p className="small">Add rent, debit orders, subscriptions and expected income.</p>
        </Empty>
      ) : (
        <ul className="list">
          {rules.map((r) => {
            const next = nextDueDate(r, today);
            return (
              <li key={r.id} className="with-actions">
                <div className="primary">
                  <div className="title">{r.name}</div>
                  <div className="meta">
                    <Badge kind={r.direction === 'income' ? 'actual' : 'forecast'}>
                      {r.direction === 'income' ? 'Expected income' : 'Bill'}
                    </Badge>
                    <span>
                      {FREQUENCY_LABELS[r.frequency]}
                      {r.frequency === 'custom_days' ? ` (${r.intervalDays} days)` : ''}
                    </span>
                    {next ? (
                      <span>
                        Next <DateText date={next} />
                      </span>
                    ) : (
                      <span>Ended</span>
                    )}
                    {r.categoryId && <span>{categories.get(r.categoryId)?.name}</span>}
                    {view === 'combined' && <Badge>{WORKSPACE_LABELS[r.workspace]}</Badge>}
                    {!r.active && <Badge kind="warning">Paused</Badge>}
                    {r.isDemo && <Badge kind="demo">Demo</Badge>}
                    {r.frequency !== 'monthly' && (
                      <span>
                        ≈ <Money cents={monthlyEquivalent(r)} />
                        /month
                      </span>
                    )}
                  </div>
                </div>
                <div className="end">
                  <Money
                    cents={r.direction === 'income' ? r.amountCents : -r.amountCents}
                    signed
                    tone
                  />
                </div>
                <div className="btn-row">
                  <button type="button" className="btn btn-sm" onClick={() => setEditing(r)}>
                    Edit
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() =>
                      void run(
                        () => saveRecurringRule(store, { ...r, active: !r.active }),
                        r.active ? 'Paused' : 'Resumed',
                      )
                    }
                  >
                    {r.active ? 'Pause' : 'Resume'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-danger"
                    onClick={async () => {
                      const ok = await confirm({
                        title: `Delete “${r.name}”?`,
                        message: 'Recorded transactions are not affected.',
                        confirmLabel: 'Delete',
                        danger: true,
                      });
                      if (ok) void run(() => deleteRecurringRule(store, r.id), 'Deleted');
                    }}
                  >
                    Delete
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {statusNode}
    </Card>
  );
}

export function BudgetsPage() {
  const { view, setView } = useApp();
  const data = useFinanceData();
  if (!data) return <Loading />;
  return (
    <>
      <PageHeader
        title="Budgets"
        actions={
          <>
            <WorkspaceSwitcher value={view} onChange={setView} />
          </>
        }
      />
      <div className="grid grid-2">
        {view !== 'business' && <IncomePlanCard data={data} />}
        <RecurringItems data={data} />
        {view !== 'business' && (
          <div className="span-all">
            <CategoryLimits data={data} workspace="personal" />
          </div>
        )}
        {view !== 'personal' && (
          <div className="span-all">
            <CategoryLimits data={data} workspace="business" />
          </div>
        )}
      </div>
    </>
  );
}
