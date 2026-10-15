import { Link } from 'react-router';
import { useConfirm } from '@/components/ConfirmDialog';
import { useState, type FormEvent } from 'react';
import { useApp, useFinanceData } from '@/app/AppContext';
import {
  ACCOUNT_TYPES,
  ACCOUNT_TYPE_LABELS,
  WORKSPACE_LABELS,
  type Account,
  type AccountType,
  type Workspace,
} from '@/domain/models';
import { accountBalance, pendingTotal, reconciliationStatus } from '@/domain/calculations/balances';
import { centsToDecimalString, parseAmountToCents } from '@/domain/money';
import {
  createAccount,
  defaultIncludeInSpendable,
  deleteAccount,
  setAccountActive,
  updateAccount,
} from '@/services/accountsService';
import {
  Alert,
  Badge,
  Card,
  DateText,
  Empty,
  Field,
  Loading,
  Money,
  useStatus,
} from '@/components/ui';

interface FormState {
  name: string;
  type: AccountType;
  workspace: Workspace;
  institution: string;
  openingBalance: string;
  openingBalanceDate: string;
  includeInSpendable: boolean;
  reconciledBalance: string;
  reconciledDate: string;
}

function emptyForm(today: string): FormState {
  return {
    name: '',
    type: 'current',
    workspace: 'personal',
    institution: '',
    openingBalance: '',
    openingBalanceDate: today,
    includeInSpendable: true,
    reconciledBalance: '',
    reconciledDate: '',
  };
}

function formFromAccount(a: Account): FormState {
  return {
    name: a.name,
    type: a.type,
    workspace: a.workspace,
    institution: a.institution ?? '',
    openingBalance: centsToDecimalString(a.openingBalanceCents),
    openingBalanceDate: a.openingBalanceDate,
    includeInSpendable: a.includeInSpendable,
    reconciledBalance:
      a.reconciledBalanceCents === undefined ? '' : centsToDecimalString(a.reconciledBalanceCents),
    reconciledDate: a.reconciledDate ?? '',
  };
}

function AccountForm({
  initial,
  editing,
  hasTransactions,
  onCancel,
  onSaved,
}: {
  initial: FormState;
  editing: Account | null;
  hasTransactions: boolean;
  onCancel: () => void;
  onSaved: (msg: string) => void;
}) {
  const { store } = useApp();
  const [form, setForm] = useState(initial);
  const [errors, setErrors] = useState<Partial<Record<keyof FormState, string>>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    const errs: typeof errors = {};
    if (!form.name.trim()) errs.name = 'Enter an account name';
    const opening = form.openingBalance.trim() === '' ? 0 : parseAmountToCents(form.openingBalance);
    if (opening === null)
      errs.openingBalance = 'Enter an amount like 1234.56 (use - for overdrawn)';
    if (!form.openingBalanceDate) errs.openingBalanceDate = 'Choose a date';
    let reconciled: number | undefined;
    if (form.reconciledBalance.trim() !== '') {
      const r = parseAmountToCents(form.reconciledBalance);
      if (r === null) errs.reconciledBalance = 'Enter a valid amount';
      else reconciled = r;
      if (!form.reconciledDate) errs.reconciledDate = 'Choose the statement date';
    }
    setErrors(errs);
    if (Object.keys(errs).length > 0 || opening === null) return;
    try {
      const common = {
        name: form.name.trim(),
        type: form.type,
        workspace: form.workspace,
        institution: form.institution.trim() || undefined,
        openingBalanceCents: opening,
        openingBalanceDate: form.openingBalanceDate,
        includeInSpendable: form.includeInSpendable,
      };
      if (editing) {
        await updateAccount(store, editing.id, {
          ...common,
          reconciledBalanceCents: reconciled,
          reconciledDate: reconciled === undefined ? undefined : form.reconciledDate,
        });
        onSaved('Account updated');
      } else {
        await createAccount(store, common);
        onSaved('Account added');
      }
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <form
      className="panel form"
      onSubmit={submit}
      noValidate
      aria-label={editing ? 'Edit account' : 'Add account'}
    >
      <h2>{editing ? `Edit ${editing.name}` : 'Add an account'}</h2>
      {submitError && <Alert tone="negative">{submitError}</Alert>}
      <div className="form-row">
        <Field label="Account name" htmlFor="acc-name" error={errors.name}>
          <input
            id="acc-name"
            value={form.name}
            onChange={(e) => set('name', e.target.value)}
            aria-invalid={!!errors.name}
            autoComplete="off"
            placeholder="e.g. Capitec main"
          />
        </Field>
        <Field label="Institution (optional)" htmlFor="acc-inst">
          <input
            id="acc-inst"
            value={form.institution}
            onChange={(e) => set('institution', e.target.value)}
            autoComplete="off"
            placeholder="e.g. Capitec"
          />
        </Field>
      </div>
      <div className="form-row">
        <Field label="Type" htmlFor="acc-type">
          <select
            id="acc-type"
            value={form.type}
            onChange={(e) => {
              const type = e.target.value as AccountType;
              setForm((f) => ({ ...f, type, includeInSpendable: defaultIncludeInSpendable(type) }));
            }}
          >
            {ACCOUNT_TYPES.map((t) => (
              <option key={t} value={t}>
                {ACCOUNT_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Workspace"
          htmlFor="acc-ws"
          hint={
            editing && hasTransactions ? 'Locked because this account has transactions.' : undefined
          }
        >
          <select
            id="acc-ws"
            value={form.workspace}
            disabled={!!editing && hasTransactions}
            onChange={(e) => set('workspace', e.target.value as Workspace)}
          >
            <option value="personal">{WORKSPACE_LABELS.personal}</option>
            <option value="business">{WORKSPACE_LABELS.business}</option>
          </select>
        </Field>
      </div>
      <div className="form-row">
        <Field
          label="Opening balance (R)"
          htmlFor="acc-open"
          error={errors.openingBalance}
          hint="The balance at the start of the opening date. Transactions before this date are treated as already included."
        >
          <input
            id="acc-open"
            inputMode="decimal"
            value={form.openingBalance}
            onChange={(e) => set('openingBalance', e.target.value)}
            aria-invalid={!!errors.openingBalance}
            placeholder="0.00"
          />
        </Field>
        <Field
          label="Opening balance date"
          htmlFor="acc-open-date"
          error={errors.openingBalanceDate}
        >
          <input
            id="acc-open-date"
            type="date"
            value={form.openingBalanceDate}
            onChange={(e) => set('openingBalanceDate', e.target.value)}
          />
        </Field>
      </div>
      <label className="check">
        <input
          type="checkbox"
          checked={form.includeInSpendable}
          onChange={(e) => set('includeInSpendable', e.target.checked)}
        />
        <span>
          Count this balance as money available for day-to-day spending
          <span className="faint small"> — turn off for savings you don't want to spend.</span>
        </span>
      </label>
      {editing && (
        <fieldset>
          <legend>Reconciliation (optional)</legend>
          <p className="small muted">
            Enter a closing balance from a bank statement to check that your records agree with the
            bank.
          </p>
          <div className="form-row">
            <Field label="Statement balance (R)" htmlFor="acc-rec" error={errors.reconciledBalance}>
              <input
                id="acc-rec"
                inputMode="decimal"
                value={form.reconciledBalance}
                onChange={(e) => set('reconciledBalance', e.target.value)}
              />
            </Field>
            <Field label="Statement date" htmlFor="acc-rec-date" error={errors.reconciledDate}>
              <input
                id="acc-rec-date"
                type="date"
                value={form.reconciledDate}
                onChange={(e) => set('reconciledDate', e.target.value)}
              />
            </Field>
          </div>
        </fieldset>
      )}
      <div className="btn-row">
        <button type="submit" className="btn btn-primary">
          {editing ? 'Save changes' : 'Add account'}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export function AccountsPage() {
  const { store, today } = useApp();
  const data = useFinanceData();
  const { run, statusNode, setStatus } = useStatus();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<Account | 'new' | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  if (!data) return <Loading />;
  const { accounts, transactions } = data;
  const visible = accounts
    .filter((a) => showArchived || a.active)
    .sort((a, b) => a.workspace.localeCompare(b.workspace) || a.name.localeCompare(b.name));
  const txnCount = (id: string) => transactions.filter((t) => t.accountId === id).length;

  return (
    <>
      <div className="topbar">
        <h1>Accounts</h1>
        <button type="button" className="btn btn-primary" onClick={() => setEditing('new')}>
          Add account
        </button>
      </div>

      <Alert tone="info">
        Balances are <strong>calculated</strong> from the opening balance plus transactions recorded
        in this app. No bank connection is used — add transactions manually or{' '}
        <Link to="/import">import a CSV statement</Link>. Check them against your bank with the
        reconciliation fields.
      </Alert>

      {editing && (
        <AccountForm
          key={editing === 'new' ? 'new' : editing.id}
          initial={editing === 'new' ? emptyForm(today) : formFromAccount(editing)}
          editing={editing === 'new' ? null : editing}
          hasTransactions={editing !== 'new' && txnCount(editing.id) > 0}
          onCancel={() => setEditing(null)}
          onSaved={(msg) => {
            setEditing(null);
            setStatus({ tone: 'success', text: msg });
          }}
        />
      )}

      {accounts.length === 0 ? (
        <Card>
          <Empty title="No accounts yet">
            <p>Add your Capitec current account, any savings accounts and your business account.</p>
          </Empty>
        </Card>
      ) : (
        <Card
          title="Your accounts"
          action={
            <label className="check small">
              <input
                type="checkbox"
                checked={showArchived}
                onChange={(e) => setShowArchived(e.target.checked)}
              />
              Show archived
            </label>
          }
        >
          <ul className="list">
            {visible.map((a) => {
              const balance = accountBalance(a, transactions);
              const pending = pendingTotal(a, transactions);
              const rec = reconciliationStatus(a, transactions);
              const count = txnCount(a.id);
              return (
                <li key={a.id} className="with-actions">
                  <div className="primary">
                    <div className="title">{a.name}</div>
                    <div className="meta">
                      <span>{ACCOUNT_TYPE_LABELS[a.type]}</span>
                      <Badge>{WORKSPACE_LABELS[a.workspace]}</Badge>
                      {a.includeInSpendable ? (
                        <Badge kind="actual">Spendable</Badge>
                      ) : (
                        <Badge>Not spendable</Badge>
                      )}
                      {!a.active && <Badge kind="warning">Archived</Badge>}
                      {a.isDemo && <Badge kind="demo">Demo</Badge>}
                      <span>{count} transactions</span>
                      {pending !== 0 && (
                        <span>
                          Pending <Money cents={pending} />
                        </span>
                      )}
                      {rec &&
                        (rec.discrepancyCents === 0 ? (
                          <span>
                            Reconciled to <DateText date={rec.reconciledDate} />
                          </span>
                        ) : (
                          <Badge kind="warning">
                            Differs from statement (<DateText date={rec.reconciledDate} />) by{' '}
                            <Money cents={rec.discrepancyCents} signed />
                          </Badge>
                        ))}
                    </div>
                  </div>
                  <div className="end">
                    <Money cents={balance} tone className="stat-value" />
                  </div>
                  <div className="btn-row">
                    <button type="button" className="btn btn-sm" onClick={() => setEditing(a)}>
                      Edit
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() =>
                        void run(
                          () => setAccountActive(store, a.id, !a.active),
                          a.active ? 'Account archived' : 'Account restored',
                        )
                      }
                    >
                      {a.active ? 'Archive' : 'Restore'}
                    </button>
                    {count === 0 && (
                      <button
                        type="button"
                        className="btn btn-sm btn-danger"
                        onClick={async () => {
                          const ok = await confirm({
                            title: `Delete ${a.name}?`,
                            message: 'The account has no transactions. This cannot be undone.',
                            confirmLabel: 'Delete account',
                            danger: true,
                          });
                          if (ok) void run(() => deleteAccount(store, a.id), 'Account deleted');
                        }}
                      >
                        Delete
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
      {statusNode}
    </>
  );
}
