import { useState, type FormEvent } from 'react';
import { useApp } from '@/app/AppContext';
import {
  TRANSACTION_STATUSES,
  TRANSACTION_STATUS_LABELS,
  TRANSACTION_TYPE_LABELS,
  type Account,
  type Category,
  type Transaction,
  type TransactionStatus,
} from '@/domain/models';
import { centsToDecimalString, parseAmountToCents } from '@/domain/money';
import {
  type SimpleTransactionType,
  createTransaction,
  createTransfer,
  transferKindFor,
  updateTransaction,
  updateTransfer,
  convertToTransfer,
} from '@/services/transactionsService';
import { Alert, Field } from '@/components/ui';
import { AccountOptions, CategoryOptions } from '../shared';
import { TRANSFER_KIND_LABELS } from '@/domain/models';

const SIMPLE_TYPES: SimpleTransactionType[] = ['expense', 'income', 'refund', 'adjustment'];

export function TransactionForm({
  accounts,
  categories,
  editing,
  defaultAccountId,
  today,
  onDone,
  onCancel,
}: {
  accounts: Account[];
  categories: Category[];
  editing: Transaction | null;
  defaultAccountId?: string | undefined;
  today: string;
  onDone: (msg: string) => void;
  onCancel: () => void;
}) {
  const { store } = useApp();
  const [accountId, setAccountId] = useState(
    editing?.accountId ?? defaultAccountId ?? accounts.find((a) => a.active)?.id ?? '',
  );
  const [type, setType] = useState<SimpleTransactionType>(
    (editing?.type as SimpleTransactionType | undefined) ?? 'expense',
  );
  const [direction, setDirection] = useState<'in' | 'out'>(
    editing && editing.amountCents < 0 ? 'out' : 'in',
  );
  const [amount, setAmount] = useState(
    editing ? centsToDecimalString(Math.abs(editing.amountCents)) : '',
  );
  const [date, setDate] = useState(editing?.date ?? today);
  const [description, setDescription] = useState(editing?.description ?? '');
  const [categoryId, setCategoryId] = useState(editing?.categoryId ?? '');
  const [status, setStatus] = useState<TransactionStatus>(editing?.status ?? 'posted');
  const [notes, setNotes] = useState(editing?.notes ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);

  const account = accounts.find((a) => a.id === accountId);
  const categoryKind = type === 'income' ? 'income' : type === 'adjustment' ? undefined : 'expense';

  async function submit(e: FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = {};
    const cents = parseAmountToCents(amount);
    if (!accountId) errs.account = 'Choose an account';
    if (cents === null || cents <= 0)
      errs.amount = 'Enter an amount greater than zero, e.g. 149.99';
    if (!date) errs.date = 'Choose a date';
    if (!description.trim()) errs.description = 'Add a short description';
    setErrors(errs);
    if (Object.keys(errs).length > 0 || cents === null) return;
    const input = {
      accountId,
      date,
      description: description.trim(),
      amountCents: cents,
      type,
      adjustmentDirection: direction,
      categoryId: type === 'adjustment' ? null : categoryId || null,
      status,
      notes: notes.trim(),
    };
    try {
      if (editing) {
        await updateTransaction(store, editing.id, input);
        onDone('Transaction updated');
      } else {
        await createTransaction(store, { ...input, notes: input.notes || undefined });
        onDone('Transaction added');
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
      aria-label={editing ? 'Edit transaction' : 'Add transaction'}
    >
      <h2>{editing ? 'Edit transaction' : 'Add a transaction'}</h2>
      {editing && editing.source !== 'manual' && (
        <Alert tone="info">
          Imported from {editing.source.toUpperCase()}. The original description is kept:{' '}
          <q>{editing.originalDescription ?? editing.description}</q>
        </Alert>
      )}
      {submitError && <Alert tone="negative">{submitError}</Alert>}
      <div className="form-row">
        <Field label="Type" htmlFor="tx-type">
          <select
            id="tx-type"
            value={type}
            onChange={(e) => {
              setType(e.target.value as SimpleTransactionType);
              setCategoryId('');
            }}
          >
            {SIMPLE_TYPES.map((t) => (
              <option key={t} value={t}>
                {TRANSACTION_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </Field>
        {type === 'adjustment' && (
          <Field label="Direction" htmlFor="tx-dir">
            <select
              id="tx-dir"
              value={direction}
              onChange={(e) => setDirection(e.target.value as 'in' | 'out')}
            >
              <option value="in">Increase balance</option>
              <option value="out">Decrease balance</option>
            </select>
          </Field>
        )}
        <Field label="Amount (R)" htmlFor="tx-amount" error={errors.amount}>
          <input
            id="tx-amount"
            inputMode="decimal"
            autoComplete="off"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            aria-invalid={!!errors.amount}
            placeholder="0.00"
          />
        </Field>
        <Field label="Date" htmlFor="tx-date" error={errors.date}>
          <input id="tx-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
      </div>
      <div className="form-row">
        <Field label="Description" htmlFor="tx-desc" error={errors.description}>
          <input
            id="tx-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            aria-invalid={!!errors.description}
            autoComplete="off"
            placeholder="e.g. Checkers groceries"
          />
        </Field>
        <Field label="Account" htmlFor="tx-account" error={errors.account}>
          <select id="tx-account" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <option value="">Choose…</option>
            <AccountOptions accounts={accounts} includeArchived={!!editing} />
          </select>
        </Field>
      </div>
      <div className="form-row">
        {type !== 'adjustment' && (
          <Field
            label="Category"
            htmlFor="tx-cat"
            hint={account ? `Showing ${account.workspace} categories` : undefined}
          >
            <select id="tx-cat" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              <option value="">Uncategorised</option>
              <CategoryOptions
                categories={categories}
                workspace={account?.workspace}
                kind={categoryKind}
              />
            </select>
          </Field>
        )}
        <Field
          label="Status"
          htmlFor="tx-status"
          hint="Pending items are not in the posted balance."
        >
          <select
            id="tx-status"
            value={status}
            onChange={(e) => setStatus(e.target.value as TransactionStatus)}
          >
            {TRANSACTION_STATUSES.map((s) => (
              <option key={s} value={s}>
                {TRANSACTION_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="Notes (optional)" htmlFor="tx-notes">
        <textarea id="tx-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
      <div className="btn-row">
        <button type="submit" className="btn btn-primary">
          {editing ? 'Save changes' : 'Add transaction'}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export function TransferForm({
  accounts,
  editingTransferId,
  initial,
  today,
  onDone,
  onCancel,
}: {
  accounts: Account[];
  /** When editing, only date/amount/notes/status can change (both legs together). */
  editingTransferId?: string | undefined;
  initial?: {
    fromAccountId: string;
    toAccountId: string;
    amountCents: number;
    date: string;
    notes?: string | undefined;
  };
  today: string;
  onDone: (msg: string) => void;
  onCancel: () => void;
}) {
  const { store } = useApp();
  const active = accounts.filter((a) => a.active);
  const [fromId, setFromId] = useState(initial?.fromAccountId ?? active[0]?.id ?? '');
  const [toId, setToId] = useState(initial?.toAccountId ?? active[1]?.id ?? '');
  const [amount, setAmount] = useState(initial ? centsToDecimalString(initial.amountCents) : '');
  const [date, setDate] = useState(initial?.date ?? today);
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const from = accounts.find((a) => a.id === fromId);
  const to = accounts.find((a) => a.id === toId);
  const editing = !!editingTransferId;

  async function submit(e: FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = {};
    const cents = parseAmountToCents(amount);
    if (!fromId) errs.from = 'Choose an account';
    if (!toId) errs.to = 'Choose an account';
    if (fromId && fromId === toId) errs.to = 'Choose a different account';
    if (cents === null || cents <= 0) errs.amount = 'Enter an amount greater than zero';
    setErrors(errs);
    if (Object.keys(errs).length > 0 || cents === null) return;
    try {
      if (editingTransferId) {
        await updateTransfer(store, editingTransferId, {
          amountCents: cents,
          date,
          notes: notes.trim(),
        });
        onDone('Transfer updated');
      } else {
        await createTransfer(store, {
          fromAccountId: fromId,
          toAccountId: toId,
          amountCents: cents,
          date,
          ...(notes.trim() ? { notes: notes.trim() } : {}),
        });
        onDone('Transfer recorded');
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
      aria-label={editing ? 'Edit transfer' : 'Add transfer'}
    >
      <h2>{editing ? 'Edit transfer' : 'Transfer between your accounts'}</h2>
      <p className="small muted">
        Transfers move money between accounts you own. They are never counted as income or spending
        — moving money to savings is saving, not an expense.
      </p>
      {submitError && <Alert tone="negative">{submitError}</Alert>}
      <div className="form-row">
        <Field label="From" htmlFor="tr-from" error={errors.from}>
          <select
            id="tr-from"
            value={fromId}
            disabled={editing}
            onChange={(e) => setFromId(e.target.value)}
          >
            <option value="">Choose…</option>
            <AccountOptions accounts={accounts} includeArchived={editing} />
          </select>
        </Field>
        <Field label="To" htmlFor="tr-to" error={errors.to}>
          <select
            id="tr-to"
            value={toId}
            disabled={editing}
            onChange={(e) => setToId(e.target.value)}
          >
            <option value="">Choose…</option>
            <AccountOptions accounts={accounts} includeArchived={editing} />
          </select>
        </Field>
      </div>
      {from && to && from.id !== to.id && (
        <p className="small">
          Recorded as: <strong>{TRANSFER_KIND_LABELS[transferKindFor(from, to)]}</strong>
          {from.workspace !== to.workspace &&
            ' — shown separately in business reports and excluded from combined income/expenses.'}
        </p>
      )}
      <div className="form-row">
        <Field label="Amount (R)" htmlFor="tr-amount" error={errors.amount}>
          <input
            id="tr-amount"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            aria-invalid={!!errors.amount}
            placeholder="0.00"
          />
        </Field>
        <Field label="Date" htmlFor="tr-date">
          <input id="tr-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
      </div>
      <Field label="Notes (optional)" htmlFor="tr-notes">
        <input id="tr-notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
      <div className="btn-row">
        <button type="submit" className="btn btn-primary">
          {editing ? 'Save transfer' : 'Record transfer'}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/**
 * Turns an existing income/expense into a transfer between your own accounts (e.g. a statement
 * row "TRANSFER TO SAVINGS" that was imported as spending). Links to the matching entry in the
 * other account when there is one.
 */
export function ConvertToTransferPanel({
  txn,
  accounts,
  onDone,
}: {
  txn: Transaction;
  accounts: Account[];
  onDone: (msg: string) => void;
}) {
  const { store } = useApp();
  const others = accounts.filter((a) => a.active && a.id !== txn.accountId);
  const [otherId, setOtherId] = useState('');
  const [recordOtherSide, setRecordOtherSide] = useState(true);
  const [error, setError] = useState<string | null>(null);
  if (others.length === 0 || txn.type === 'adjustment') return null;
  const outgoing = txn.amountCents < 0;

  async function convert() {
    setError(null);
    try {
      const outcome = await convertToTransfer(store, txn.id, otherId, { recordOtherSide });
      const name = others.find((a) => a.id === otherId)?.name ?? 'the other account';
      onDone(
        outcome === 'paired' || outcome === 'joined'
          ? `Converted to a transfer and linked to the matching entry in ${name}`
          : outcome === 'both_sides'
            ? `Converted to a transfer; the other side was recorded in ${name}`
            : 'Converted to a transfer',
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <section className="panel form" aria-label="Convert to transfer">
      <h3 className="small">Is this a transfer between your own accounts?</h3>
      <p className="small muted">
        Transfers aren’t income or spending. If the other account already has the matching amount
        within 3 days, the two are linked; otherwise this becomes one side of a transfer.
      </p>
      {error && <Alert tone="negative">{error}</Alert>}
      <div className="form-row">
        <Field label={outgoing ? 'Transfer to' : 'Transfer from'} htmlFor="conv-account">
          <select id="conv-account" value={otherId} onChange={(e) => setOtherId(e.target.value)}>
            <option value="">Choose…</option>
            <AccountOptions accounts={others} />
          </select>
        </Field>
      </div>
      <label className="check small">
        <input
          type="checkbox"
          checked={recordOtherSide}
          onChange={(e) => setRecordOtherSide(e.target.checked)}
        />
        If there’s no matching entry, record the other side in that account too
      </label>
      <div className="btn-row">
        <button type="button" className="btn" disabled={!otherId} onClick={() => void convert()}>
          Convert to transfer
        </button>
      </div>
    </section>
  );
}
