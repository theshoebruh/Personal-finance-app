import { useSync } from '@/app/SyncContext';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { useConfirm } from '@/components/ConfirmDialog';
import { useApp, useFinanceData } from '@/app/AppContext';
import {
  type ColumnMapping,
  DATE_FORMATS,
  DATE_FORMAT_LABELS,
  type DateFormat,
  type StagedRow,
  summariseStaging,
  isWorkbookFileName,
} from '@/domain/imports';
import { formatDisplayDate } from '@/domain/dates';
import {
  ACCOUNT_TYPE_LABELS,
  WORKSPACE_LABELS,
  type Account,
  type Category,
} from '@/domain/models';
import type { ImportBatch } from '@/domain/models';
import {
  type CommitResult,
  type PreparedImport,
  checkImportFile,
  commitImport,
  editedSinceImport,
  prepareImport,
  restage,
  undoImport,
} from '@/services/importService';
import {
  Alert,
  Badge,
  Card,
  DateText,
  Empty,
  Field,
  Loading,
  Money,
  readFileBytes,
  readFileText,
  useStatus,
} from '@/components/ui';
import { PageHeader } from '@/components/PageHeader';
import { Icon } from '@/components/icons';
import { Ring } from '@/components/charts';
import { CategoryOptions } from '../shared';
import type { CategorySource } from '@/domain/imports';

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const CATEGORY_SOURCE_TEXT: Record<Exclude<CategorySource, 'you'>, string> = {
  rule: 'Your rule',
  learned: 'Like last time',
  fee: 'Charged on this purchase',
  bank: 'From your bank',
};

type RowFilter = 'all' | 'selected' | 'skipped' | 'problems';
const PAGE = 200;

type Step = 'account' | 'file' | 'columns' | 'review' | 'done';
const STEPS: { id: Step; label: string }[] = [
  { id: 'account', label: 'Choose the account' },
  { id: 'file', label: 'Choose the file' },
  { id: 'columns', label: 'Check the columns' },
  { id: 'review', label: 'Review the rows' },
  { id: 'done', label: 'Done' },
];

function columnLabel(prepared: PreparedImport, index: number): string {
  const header = prepared.staging.mapping.hasHeader ? prepared.parsed.rows[0]?.[index] : undefined;
  const sample = prepared.parsed.rows[prepared.staging.mapping.hasHeader ? 1 : 0]?.[index];
  const name = header?.trim() || `Column ${index + 1}`;
  return sample && !header ? `${name} (e.g. ${sample.slice(0, 24)})` : name;
}

function ColumnSelect({
  id,
  label,
  value,
  optional,
  prepared,
  onChange,
}: {
  id: string;
  label: string;
  value: number | null;
  optional?: boolean;
  prepared: PreparedImport;
  onChange: (v: number | null) => void;
}) {
  const count = Math.max(...prepared.parsed.rows.map((r) => r.length));
  return (
    <Field label={label} htmlFor={id}>
      <select
        id={id}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
      >
        {optional ? (
          <option value="">Not used</option>
        ) : (
          value === null && <option value="">Choose…</option>
        )}
        {Array.from({ length: count }, (_, i) => (
          <option key={i} value={i}>
            {columnLabel(prepared, i)}
          </option>
        ))}
      </select>
    </Field>
  );
}

function statusBadge(r: StagedRow) {
  switch (r.status) {
    case 'invalid':
      return <Badge kind="negative">Can’t import</Badge>;
    case 'duplicate':
      return <Badge kind="warning">Already imported</Badge>;
    case 'possible_duplicate':
      return <Badge kind="warning">Possible duplicate</Badge>;
    case 'posts_pending':
      return <Badge kind="actual">Now posted</Badge>;
    default:
      return <Badge kind="actual">New</Badge>;
  }
}

/* ------------------------------------------------------------------ Frame */

function StepIndicator({ step }: { step: Step }) {
  const current = STEPS.findIndex((s) => s.id === step);
  return (
    <nav className="stepper" aria-label="Import progress">
      <ol>
        {STEPS.map((s, i) => (
          <li
            key={s.id}
            data-state={
              i < current || step === 'done' ? 'done' : i === current ? 'current' : 'todo'
            }
            aria-current={i === current ? 'step' : undefined}
          >
            <span className="visually-hidden">
              {s.label}
              {i < current ? ' (done)' : ''}
            </span>
          </li>
        ))}
      </ol>
      <p className="stepper-label" aria-hidden="true">
        <span>
          Step {current + 1} of {STEPS.length}
        </span>
        <strong>{STEPS[current]?.label}</strong>
      </p>
    </nav>
  );
}

/** The step's heading; takes focus when the step changes so screen readers announce it. */
function StepHeading({ children, focus }: { children: ReactNode; focus: boolean }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focus) ref.current?.focus();
  }, [focus]);
  return (
    <h2 ref={ref} tabIndex={-1} className="step-heading">
      {children}
    </h2>
  );
}

/** One primary action per step, pinned above the tab bar on phones. */
function StepActions({ children, note }: { children: ReactNode; note?: ReactNode }) {
  return (
    <div className="step-actions">
      {note && <div className="step-actions-note">{note}</div>}
      <div className="step-actions-buttons">{children}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ Step 1 */

function AccountStep({
  accounts,
  accountId,
  onChoose,
  onNext,
  focus,
}: {
  accounts: Account[];
  accountId: string;
  onChoose: (id: string) => void;
  onNext: () => void;
  focus: boolean;
}) {
  if (accounts.length === 0) {
    return (
      <Card>
        <Empty title="Add an account first" icon="accounts">
          <p>A statement is imported into one of your accounts.</p>
          <Link className="btn btn-primary btn-lg" to="/accounts">
            Add an account
          </Link>
        </Empty>
      </Card>
    );
  }
  return (
    <section className="step" aria-labelledby="step-account">
      <fieldset className="choice-list">
        <legend id="step-account">
          <StepHeading focus={focus}>Which account is this statement from?</StepHeading>
        </legend>
        {accounts.map((a) => (
          <label key={a.id} className="choice">
            <input
              type="radio"
              name="imp-account"
              value={a.id}
              checked={accountId === a.id}
              onChange={() => onChoose(a.id)}
            />
            <span className="choice-text">
              <strong>{a.name}</strong>
              <small>
                {ACCOUNT_TYPE_LABELS[a.type]} · {WORKSPACE_LABELS[a.workspace]}
              </small>
            </span>
          </label>
        ))}
      </fieldset>
      <p className="small muted">
        Not listed? <Link to="/accounts">Add the account</Link> first, then come back.
      </p>
      <StepActions>
        <button
          type="button"
          className="btn btn-primary btn-lg btn-block"
          disabled={!accountId}
          onClick={onNext}
        >
          Continue
        </button>
      </StepActions>
    </section>
  );
}

/* ------------------------------------------------------------------ Step 2 */

function CsvHelp({ defaultOpen }: { defaultOpen: boolean }) {
  return (
    <details className="help-box" open={defaultOpen}>
      <summary>How do I get a CSV from my bank?</summary>
      <ol>
        <li>
          In your banking app or internet banking, open this account’s{' '}
          <strong>transaction history</strong>.
        </li>
        <li>
          Choose <strong>Export</strong> or <strong>Download</strong>, and pick <strong>CSV</strong>{' '}
          (not PDF). Choose the dates you want.
        </li>
        <li>
          On iPhone, when the share sheet appears, tap <strong>Save to Files</strong> and pick a
          folder such as <strong>Downloads</strong>.
        </li>
        <li>
          Come back here and tap <strong>Choose your CSV or Excel file</strong>. In the Files app,
          look under <strong>Recents</strong> or <strong>Browse → Downloads</strong>.
        </li>
      </ol>
      <p className="small muted">
        Some banks only offer CSV or Excel on their website, not in the app. Excel workbooks (.xlsx)
        can be imported directly; only the first sheet is read. PDF statements can’t be read.
      </p>
    </details>
  );
}

function FileStep({
  account,
  busy,
  error,
  firstTime,
  onFile,
  onChangeAccount,
  focus,
}: {
  account: Account;
  busy: boolean;
  error: string | null;
  firstTime: boolean;
  onFile: (f: File) => void;
  onChangeAccount: () => void;
  focus: boolean;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <section className="step" aria-labelledby="step-file">
      <div id="step-file">
        <StepHeading focus={focus}>Choose the statement file</StepHeading>
      </div>
      <div className="picked">
        <span className="picked-text">
          <small>Importing into</small>
          <strong>{account.name}</strong>
        </span>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onChangeAccount}>
          Change
        </button>
      </div>
      <input
        id="imp-file"
        ref={fileRef}
        className="file-input"
        type="file"
        accept={`.csv,.txt,.xlsx,.xlsm,text/csv,text/plain,${XLSX_TYPE}`}
        aria-label="Statement file (CSV or Excel)"
        aria-describedby={error ? 'imp-file-error' : 'imp-file-hint'}
        disabled={busy}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          if (fileRef.current) fileRef.current.value = '';
        }}
      />
      <label htmlFor="imp-file" className="drop" data-busy={busy}>
        <span className="drop-icon">
          <Icon name="file" size={28} />
        </span>
        <strong>{busy ? 'Reading your file…' : 'Choose your CSV or Excel file'}</strong>
        <span id="imp-file-hint" className="small muted">
          Opens the Files app. The file is read on this device and never uploaded.
        </span>
      </label>
      {error && (
        <p id="imp-file-error" className="field-error" role="alert">
          {error}
        </p>
      )}
      <CsvHelp defaultOpen={firstTime} />
    </section>
  );
}

/* ------------------------------------------------------------------ Step 3 */

function MappingEditor({
  prepared,
  onChange,
}: {
  prepared: PreparedImport;
  onChange: (m: ColumnMapping) => void;
}) {
  const m = prepared.staging.mapping;
  const set = (patch: Partial<ColumnMapping>) => onChange({ ...m, ...patch });
  const preview = prepared.parsed.rows.slice(0, 6);
  return (
    <div className="mapping-editor">
      <div className="table-wrap">
        <table className="data-table" aria-label="File preview">
          <tbody>
            {preview.map((row, i) => (
              <tr key={i}>
                <th scope="row" className="faint">
                  {i + 1}
                </th>
                {row.map((c, j) => (
                  <td key={j} className={i === 0 && m.hasHeader ? 'muted' : undefined}>
                    {c}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="form">
        <label className="check">
          <input
            type="checkbox"
            checked={m.hasHeader}
            onChange={(e) => set({ hasHeader: e.target.checked })}
          />
          The first row contains column names
        </label>
        <div className="form-row">
          <ColumnSelect
            id="map-date"
            label="Date"
            value={m.dateColumn}
            prepared={prepared}
            onChange={(v) => v !== null && set({ dateColumn: v })}
          />
          <Field label="Date format" htmlFor="map-datefmt">
            <select
              id="map-datefmt"
              value={m.dateFormat}
              onChange={(e) => set({ dateFormat: e.target.value as DateFormat })}
            >
              {DATE_FORMATS.map((f) => (
                <option key={f} value={f}>
                  {DATE_FORMAT_LABELS[f]}
                </option>
              ))}
            </select>
          </Field>
          <ColumnSelect
            id="map-desc"
            label="Description"
            value={m.descriptionColumn}
            prepared={prepared}
            onChange={(v) => v !== null && set({ descriptionColumn: v })}
          />
          <ColumnSelect
            id="map-desc2"
            label="Extra description (optional)"
            value={m.extraDescriptionColumn}
            optional
            prepared={prepared}
            onChange={(v) => set({ extraDescriptionColumn: v })}
          />
        </div>
        <div className="form-row">
          <Field label="Amounts are in" htmlFor="map-amode">
            <select
              id="map-amode"
              value={m.amountMode}
              onChange={(e) => {
                const amountMode = e.target.value as ColumnMapping['amountMode'];
                set(
                  amountMode === 'signed'
                    ? {
                        amountMode,
                        amountColumn: m.amountColumn ?? m.debitColumn ?? m.creditColumn,
                      }
                    : { amountMode, debitColumn: m.debitColumn ?? m.amountColumn },
                );
              }}
            >
              <option value="signed">One column (negative = money out)</option>
              <option value="debit_credit">Separate debit and credit columns</option>
            </select>
          </Field>
          {m.amountMode === 'signed' ? (
            <ColumnSelect
              id="map-amount"
              label="Amount"
              value={m.amountColumn}
              prepared={prepared}
              onChange={(v) => set({ amountColumn: v })}
            />
          ) : (
            <>
              <ColumnSelect
                id="map-debit"
                label="Debit / money out"
                value={m.debitColumn}
                optional
                prepared={prepared}
                onChange={(v) => set({ debitColumn: v })}
              />
              <ColumnSelect
                id="map-credit"
                label="Credit / money in"
                value={m.creditColumn}
                optional
                prepared={prepared}
                onChange={(v) => set({ creditColumn: v })}
              />
            </>
          )}
        </div>
        <div className="form-row">
          <ColumnSelect
            id="map-fee"
            label="Bank fees (optional)"
            value={m.feeColumn ?? null}
            optional
            prepared={prepared}
            onChange={(v) => set({ feeColumn: v })}
          />
        </div>
        <div className="form-row">
          <ColumnSelect
            id="map-ref"
            label="Bank reference / ID (optional)"
            value={m.referenceColumn}
            optional
            prepared={prepared}
            onChange={(v) => set({ referenceColumn: v })}
          />
          <ColumnSelect
            id="map-bal"
            label="Running balance (optional)"
            value={m.balanceColumn}
            optional
            prepared={prepared}
            onChange={(v) => set({ balanceColumn: v })}
          />
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={m.invertSign}
            onChange={(e) => set({ invertSign: e.target.checked })}
          />
          Flip signs (use if money out shows as positive, e.g. some credit-card exports)
        </label>
      </div>
    </div>
  );
}

function ColumnsStep({
  prepared,
  rows,
  syncNote,
  onMapping,
  onNext,
  focus,
}: {
  prepared: PreparedImport;
  rows: StagedRow[];
  syncNote: string | null;
  onMapping: (m: ColumnMapping) => void;
  onNext: () => void;
  focus: boolean;
}) {
  const hasErrors = prepared.staging.mappingErrors.length > 0;
  const [editing, setEditing] = useState(hasErrors);
  const sample = rows.find((r) => r.status !== 'invalid') ?? rows[0];
  const summary = summariseStaging(rows, prepared.account);
  const bc = prepared.staging.balanceCheck;
  const feeColumn = prepared.staging.mapping.feeColumn ?? null;
  const feeCount =
    feeColumn === null
      ? 0
      : rows.filter(
          (r) =>
            // Count each statement line once (a split line has two rows with the same raw cells).
            !r.splitFee && !/^-?0*([.,]0*)?$/.test((r.raw[feeColumn] ?? '').trim()),
        ).length;
  return (
    <section className="step" aria-labelledby="step-columns">
      <div id="step-columns">
        <StepHeading focus={focus}>Does this look right?</StepHeading>
      </div>
      <p className="muted small">
        Read <strong>{prepared.fileName ?? 'your file'}</strong>: {summary.totalRows} row
        {summary.totalRows === 1 ? '' : 's'}
        {summary.dateRange && (
          <>
            {' '}
            from <DateText date={summary.dateRange.from} /> to{' '}
            <DateText date={summary.dateRange.to} />
          </>
        )}
        .
      </p>
      {syncNote && <Alert tone="warning">{syncNote}</Alert>}
      {prepared.mappingSource === 'saved' && !prepared.headerChanged && (
        <Alert tone="success">Using the columns saved for this account.</Alert>
      )}
      {prepared.headerChanged && (
        <Alert tone="warning">
          This file’s columns differ from the last import into this account, so the columns were
          guessed again. Please check them.
        </Alert>
      )}
      {prepared.parsed.note && <p className="small muted">{prepared.parsed.note}</p>}
      {prepared.parsed.warnings.length > 0 && (
        <Alert tone="warning">
          The file had formatting problems: {prepared.parsed.warnings.join('; ')}. Affected rows may
          show as errors in the next step.
        </Alert>
      )}

      {sample && !hasErrors && (
        <Card title="First row, as we read it">
          <dl className="sample-row">
            <div>
              <dt>Date</dt>
              <dd>{sample.date ? <DateText date={sample.date} /> : '—'}</dd>
            </div>
            <div>
              <dt>Description</dt>
              <dd>{sample.description || <span className="faint">No description</span>}</dd>
            </div>
            <div>
              <dt>Amount</dt>
              <dd>
                {sample.amountCents !== null ? (
                  <Money cents={sample.amountCents} signed tone />
                ) : (
                  '—'
                )}
              </dd>
            </div>
            {sample.reference && (
              <div>
                <dt>Reference</dt>
                <dd>{sample.reference}</dd>
              </div>
            )}
            {sample.balanceCents !== null && (
              <div>
                <dt>Balance</dt>
                <dd>
                  <Money cents={sample.balanceCents} />
                </dd>
              </div>
            )}
          </dl>
          <p className="small muted">
            Money out should show with a −, money in with a +. If the date, description or amount is
            wrong, change the columns.
          </p>
          {prepared.staging.mapping.feeColumn != null && (
            <p className="small muted">
              Bank fees come from the{' '}
              <strong>“{columnLabel(prepared, prepared.staging.mapping.feeColumn)}”</strong> column
              and are imported as their own transactions
              {feeCount > 0 && (
                <>
                  {' '}
                  ({feeCount} fee{feeCount === 1 ? '' : 's'} in this file)
                </>
              )}
              .
            </p>
          )}
        </Card>
      )}

      {prepared.staging.mappingErrors.map((e) => (
        <Alert key={e} tone="negative">
          {e}
        </Alert>
      ))}
      {prepared.staging.dateFormatAmbiguous && (
        <Alert tone="warning">
          Every date in this file could be read as day/month or month/day. Day/month/year (South
          African) is assumed — change the date format if that’s wrong.
        </Alert>
      )}
      {bc?.suggestInvertSign && (
        <Alert tone="warning">
          The running balance only adds up if the amount signs are flipped. Tick “Flip signs” under
          Change columns if money in and out look reversed.
        </Alert>
      )}
      {bc && !bc.suggestInvertSign && bc.pairsChecked > 0 && (
        <p className="xs faint">
          Running-balance check: {bc.consistentPairs} of {bc.pairsChecked} consecutive rows add up
          exactly.
        </p>
      )}

      <Card
        title="Columns"
        action={
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            aria-expanded={editing}
            onClick={() => setEditing((e) => !e)}
          >
            {editing ? 'Hide' : 'Change columns…'}
          </button>
        }
      >
        {editing ? (
          <MappingEditor prepared={prepared} onChange={onMapping} />
        ) : (
          <p className="small muted">
            {prepared.mappingSource === 'saved'
              ? 'Saved from your last import into this account.'
              : 'Guessed from the file.'}{' '}
            Change them if the first row above looks wrong.
          </p>
        )}
      </Card>

      <StepActions>
        <button
          type="button"
          className="btn btn-primary btn-lg btn-block"
          disabled={hasErrors}
          onClick={onNext}
        >
          Looks right
        </button>
      </StepActions>
    </section>
  );
}

/* ------------------------------------------------------------------ Step 4 */

function ReviewStep({
  prepared,
  accounts,
  categories,
  rows,
  setRows,
  onImported,
  focus,
}: {
  prepared: PreparedImport;
  accounts: readonly Account[];
  categories: readonly Category[];
  rows: StagedRow[];
  setRows: (r: StagedRow[]) => void;
  onImported: (res: CommitResult) => void;
  focus: boolean;
}) {
  const { store } = useApp();
  const [filter, setFilter] = useState<RowFilter>('all');
  const [limit, setLimit] = useState(PAGE);
  const [saveMapping, setSaveMapping] = useState(true);
  const [useClosing, setUseClosing] = useState(false);
  const [recordOtherSide, setRecordOtherSide] = useState(true);
  /** Rows where the user opened the transfer choice without a suggestion. */
  const [transferOpen, setTransferOpen] = useState<Set<number>>(new Set());
  const otherAccounts = accounts.filter((a) => a.active && a.id !== prepared.account.id);
  const accountName = (id: string | null | undefined) =>
    otherAccounts.find((a) => a.id === id)?.name ?? 'another account';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const summary = summariseStaging(rows, prepared.account);
  const closing = prepared.staging.balanceCheck?.closing ?? null;

  const isProblem = (r: StagedRow) =>
    r.status !== 'new' || r.identicalLines.length > 0 || Boolean(r.transferSuggestion);
  const counts = {
    all: rows.length,
    selected: rows.filter((r) => r.include).length,
    skipped: rows.filter((r) => !r.include).length,
    problems: rows.filter(isProblem).length,
  };
  const shown = rows.filter((r) =>
    filter === 'all'
      ? true
      : filter === 'selected'
        ? r.include
        : filter === 'skipped'
          ? !r.include
          : isProblem(r),
  );
  const setTransfer = (index: number, accountId: string | null) =>
    setRows(rows.map((r) => (r.index === index ? { ...r, transferAccountId: accountId } : r)));
  const setCategory = (index: number, categoryId: string | null) =>
    setRows(
      rows.map((r) =>
        r.index === index ? { ...r, categoryId, categorySource: categoryId ? 'you' : null } : r,
      ),
    );
  const categorised = rows.filter(
    (r) => r.include && r.status !== 'invalid' && !r.transferAccountId && r.categoryId,
  ).length;
  /** The user says a "now posted" row isn't the earlier pending one: import it as new. */
  const importAsNew = (index: number) =>
    setRows(
      rows.map((r) => {
        if (r.index !== index) return r;
        const { pendingMatch: _drop, ...rest } = r;
        return { ...rest, status: 'new', include: true };
      }),
    );
  const toggle = (index: number) =>
    setRows(
      rows.map((r) =>
        r.index === index && r.status !== 'invalid' ? { ...r, include: !r.include } : r,
      ),
    );

  async function commit() {
    setBusy(true);
    setError(null);
    try {
      const res = await commitImport(store, {
        prepared,
        rows,
        saveMapping,
        closingBalance: useClosing && closing ? closing : undefined,
        recordOtherSide,
      });
      onImported(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <section className="step" aria-labelledby="step-review">
      <div id="step-review">
        <StepHeading focus={focus}>Review and import</StepHeading>
      </div>
      <p className="small muted">
        Untick anything you don’t want. Rows already imported are unticked for you.
      </p>
      <ul className="summary-chips" aria-label="Import summary">
        <li>
          <strong>{summary.newRows}</strong> new
        </li>
        {categorised > 0 && (
          <li>
            <strong>{categorised}</strong> categorised
          </li>
        )}
        {summary.duplicates > 0 && (
          <li>
            <strong>{summary.duplicates}</strong> already imported
          </li>
        )}
        {summary.possibleDuplicates > 0 && (
          <li>
            <strong>{summary.possibleDuplicates}</strong> possible duplicate
            {summary.possibleDuplicates === 1 ? '' : 's'}
          </li>
        )}
        {summary.invalid > 0 && (
          <li className="negative">
            <strong>{summary.invalid}</strong> can’t be read
          </li>
        )}
        {(summary.transfers > 0 || summary.possibleTransfers > 0) && (
          <li>
            <strong>{summary.transfers}</strong> transfer{summary.transfers === 1 ? '' : 's'}
            {summary.possibleTransfers > 0 && ` · ${summary.possibleTransfers} possible`}
          </li>
        )}
      </ul>
      {summary.possibleTransfers > 0 && (
        <Alert tone="info">
          {summary.possibleTransfers} row{summary.possibleTransfers === 1 ? ' looks' : 's look'}{' '}
          like a transfer between your own accounts (marked <strong>Possible transfer</strong>).
          Choose the account under “Import as” so it isn’t counted as income or spending.
        </Alert>
      )}
      {summary.identicalInFile > 0 && (
        <Alert tone="info">
          {summary.identicalInFile} rows look identical to another row in this file (same date,
          amount and description). They are kept, because two identical purchases on one day are
          possible — untick any that are real duplicates.
        </Alert>
      )}
      {summary.beforeOpeningDate > 0 && (
        <Alert tone="warning">
          {summary.beforeOpeningDate} selected row
          {summary.beforeOpeningDate === 1 ? ' is' : 's are'} dated before this account’s opening
          balance date ({formatDisplayDate(prepared.account.openingBalanceDate)}). They will be
          recorded but won’t change the balance, because the opening balance already includes them.{' '}
          <Link to="/accounts">Adjust the opening balance</Link> if that’s not right.
        </Alert>
      )}

      <div className="filter-chips" role="group" aria-label="Show rows">
        {(
          [
            ['all', 'All'],
            ['selected', 'Importing'],
            ['problems', 'Needs a look'],
            ['skipped', 'Skipped'],
          ] as const
        ).map(([k, label]) => (
          <button key={k} type="button" aria-pressed={filter === k} onClick={() => setFilter(k)}>
            {label} <span className="chip-count">{counts[k]}</span>
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <Card>
          <Empty title="No rows in this view" icon="check" />
        </Card>
      ) : (
        <ul className="review-list" aria-label="Rows to import">
          {shown.slice(0, limit).map((r) => (
            <li key={r.index} data-included={r.include} data-invalid={r.status === 'invalid'}>
              <label className="review-check">
                <input
                  type="checkbox"
                  aria-label={`Import line ${r.line}: ${r.description || 'no description'}`}
                  checked={r.include}
                  disabled={r.status === 'invalid'}
                  onChange={() => toggle(r.index)}
                />
              </label>
              <div className="review-main">
                <div className="review-top">
                  <span className="review-title">
                    {r.description || <span className="faint">No description</span>}
                  </span>
                  {r.amountCents !== null && <Money cents={r.amountCents} signed tone />}
                </div>
                <div className="meta">
                  {r.date && <DateText date={r.date} />}
                  {statusBadge(r)}
                  {r.splitFee && <Badge>Bank fee</Badge>}
                  {r.pending && r.status !== 'invalid' && <Badge kind="forecast">Pending</Badge>}
                  {r.transferSuggestion?.strength === 'wording' && !r.transferAccountId && (
                    <Badge kind="warning">Possible transfer</Badge>
                  )}
                  <span>Line {r.line}</span>
                  {r.reference && <span>Ref {r.reference}</span>}
                </div>
                {r.status !== 'invalid' && r.include && !r.transferAccountId && (
                  <div className="review-category">
                    <label className="visually-hidden" htmlFor={`cat-${r.index}`}>
                      Category for line {r.line}
                    </label>
                    <select
                      id={`cat-${r.index}`}
                      value={r.categoryId ?? ''}
                      data-empty={!r.categoryId}
                      onChange={(e) => setCategory(r.index, e.target.value || null)}
                    >
                      <option value="">Uncategorised</option>
                      <CategoryOptions
                        categories={categories}
                        workspace={prepared.account.workspace}
                        kind={(r.amountCents ?? 0) > 0 ? 'income' : 'expense'}
                      />
                    </select>
                    {r.categoryId && r.categorySource && r.categorySource !== 'you' && (
                      <span className="review-category-source">
                        {CATEGORY_SOURCE_TEXT[r.categorySource]}
                        {r.categorySource === 'bank' && r.bankCategories?.[0] && (
                          <> (“{r.bankCategories[0]}”)</>
                        )}
                      </span>
                    )}
                  </div>
                )}
                {r.status === 'posts_pending' && r.pendingMatch && (
                  <div className="review-notes">
                    <span>
                      Posted version of “{r.pendingMatch.description}” (pending since{' '}
                      <DateText date={r.pendingMatch.date} />
                      ): updates it instead of adding it twice.
                    </span>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm link-button"
                      onClick={() => importAsNew(r.index)}
                    >
                      It’s a different transaction
                    </button>
                  </div>
                )}
                {(r.errors.length > 0 ||
                  r.duplicateOf ||
                  r.identicalLines.length > 0 ||
                  r.transferSuggestion?.counterpart) && (
                  <div className="review-notes">
                    {r.errors.map((e) => (
                      <span key={e} className="negative">
                        {e}
                      </span>
                    ))}
                    {r.duplicateOf && (
                      <span>
                        {r.duplicateOf.reason === 'manual_entry_match'
                          ? 'Similar to your entry'
                          : 'Matches'}{' '}
                        “{r.duplicateOf.description}” on <DateText date={r.duplicateOf.date} />
                      </span>
                    )}
                    {r.identicalLines.length > 0 && (
                      <span>Identical to line {r.identicalLines.join(', ')}</span>
                    )}
                    {r.transferSuggestion?.counterpart && (
                      <span>
                        {r.transferSuggestion.strength === 'half_recorded'
                          ? 'Completes the transfer'
                          : 'Matches'}{' '}
                        “{r.transferSuggestion.counterpart.description}” in{' '}
                        {accountName(r.transferSuggestion.otherAccountId)} on{' '}
                        <DateText date={r.transferSuggestion.counterpart.date} />
                      </span>
                    )}
                  </div>
                )}
                {r.status !== 'invalid' &&
                  r.include &&
                  otherAccounts.length > 0 &&
                  !r.splitFee &&
                  !r.transferSuggestion &&
                  !r.transferAccountId &&
                  !transferOpen.has(r.index) && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm link-button"
                      onClick={() => setTransferOpen((o) => new Set(o).add(r.index))}
                    >
                      This is a transfer…
                    </button>
                  )}
                {r.status !== 'invalid' &&
                  r.include &&
                  otherAccounts.length > 0 &&
                  (r.transferSuggestion || r.transferAccountId || transferOpen.has(r.index)) && (
                    <div className="field import-as">
                      <label className="xs" htmlFor={`as-${r.index}`}>
                        Import as
                      </label>
                      <select
                        id={`as-${r.index}`}
                        value={r.transferAccountId ?? ''}
                        onChange={(e) => setTransfer(r.index, e.target.value || null)}
                      >
                        <option value="">{(r.amountCents ?? 0) > 0 ? 'Income' : 'Spending'}</option>
                        {otherAccounts.map((a) => (
                          <option key={a.id} value={a.id}>
                            Transfer {(r.amountCents ?? 0) < 0 ? 'to' : 'from'} {a.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {shown.length > limit && (
        <button type="button" className="btn btn-block" onClick={() => setLimit((l) => l + PAGE)}>
          Show more ({shown.length - limit} remaining)
        </button>
      )}

      <Card title="Options">
        <div className="form">
          <label className="check">
            <input
              type="checkbox"
              checked={saveMapping}
              onChange={(e) => setSaveMapping(e.target.checked)}
            />
            Remember these columns for {prepared.account.name}
          </label>
          {closing && (
            <label className="check">
              <input
                type="checkbox"
                checked={useClosing}
                onChange={(e) => setUseClosing(e.target.checked)}
              />
              <span>
                Use the statement’s closing balance (<Money cents={closing.balanceCents} /> on{' '}
                <DateText date={closing.date} />) as this account’s reconciliation check
              </span>
            </label>
          )}
          {summary.transfers > 0 && (
            <label className="check">
              <input
                type="checkbox"
                checked={recordOtherSide}
                onChange={(e) => setRecordOtherSide(e.target.checked)}
              />
              <span>
                For transfers not yet recorded in the other account, record that side too (keeps
                both balances right; if you import that account’s statement later, the matching row
                is flagged as a possible duplicate)
              </span>
            </label>
          )}
          <p className="small muted">
            Imported transactions are marked <strong>Needs review</strong> and start uncategorised.
            The original row text is kept with each one, and the whole import can be undone from
            Import history.
          </p>
        </div>
      </Card>
      {error && <Alert tone="negative">{error}</Alert>}

      <StepActions
        note={
          <>
            In <Money cents={summary.selectedInCents} className="positive" /> · Out{' '}
            <Money cents={-summary.selectedOutCents} className="negative" />
          </>
        }
      >
        <button
          type="button"
          className="btn btn-primary btn-lg btn-block"
          disabled={busy || summary.selected === 0 || prepared.staging.mappingErrors.length > 0}
          onClick={() => void commit()}
        >
          {busy
            ? 'Importing…'
            : `Import ${summary.selected} transaction${summary.selected === 1 ? '' : 's'}`}
        </button>
      </StepActions>
    </section>
  );
}

/* ------------------------------------------------------------------ Step 5 */

function DoneStep({
  result,
  accountName,
  onAnother,
  focus,
}: {
  result: CommitResult;
  accountName: string;
  onAnother: () => void;
  focus: boolean;
}) {
  const b: ImportBatch = result.batch;
  const plural = result.created === 1 ? '' : 's';
  const toReview = result.needsReview;
  return (
    <section className="step step-done" aria-labelledby="step-done">
      <Ring value={1} size={112} thickness={9} label="Import complete">
        <Icon name="check" size={44} />
      </Ring>
      <div id="step-done">
        <StepHeading focus={focus}>
          Imported {result.created} transaction{plural}
        </StepHeading>
      </div>
      <p className="muted">
        Into <strong>{accountName}</strong>
        {b.dateFrom && b.dateTo && (
          <>
            , <DateText date={b.dateFrom} /> – <DateText date={b.dateTo} />
          </>
        )}
        .
        {result.transfers > 0 &&
          ` ${result.transfers} as transfer${result.transfers === 1 ? '' : 's'} between your accounts.`}
        {result.postedPending > 0 &&
          ` ${result.postedPending} pending transaction${result.postedPending === 1 ? '' : 's'} from earlier now posted (updated, not added twice).`}
        {result.pending > 0 &&
          ` ${result.pending} still pending at your bank: not counted until ${result.pending === 1 ? 'it clears' : 'they clear'}.`}
        {b.skippedCount ? ` ${b.skippedCount} skipped.` : ''}
        {b.errorCount ? ` ${b.errorCount} couldn’t be read.` : ''}
      </p>
      <p className="small muted">
        {result.categorised > 0 && (
          <>
            <strong>{result.categorised}</strong> categorised automatically.{' '}
          </>
        )}
        {toReview > 0 ? (
          <>
            {toReview === 1 ? 'One is' : `${toReview} are`} marked <strong>Needs review</strong> so
            you can choose a category.
          </>
        ) : (
          'Nothing needs a category.'
        )}
      </p>
      <div className="done-actions">
        {toReview > 0 ? (
          <Link className="btn btn-primary btn-lg btn-block" to="/transactions?status=needs_review">
            Review {toReview} transaction{toReview === 1 ? '' : 's'}
          </Link>
        ) : (
          <Link className="btn btn-primary btn-lg btn-block" to="/transactions">
            See transactions
          </Link>
        )}
        <Link className="btn btn-lg btn-block" to="/">
          Go to Home
        </Link>
        <button type="button" className="btn btn-ghost btn-block" onClick={onAnother}>
          Import another statement
        </button>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ History */

function HistoryCard() {
  const { db, store } = useApp();
  const { run, statusNode } = useStatus();
  const confirm = useConfirm();
  const batches = useLiveQuery(() => db.importBatches.orderBy('id').toArray(), [db]);
  const accounts = useLiveQuery(() => db.accounts.toArray(), [db]);
  if (!batches || !accounts) return null;
  const names = new Map(accounts.map((a) => [a.id, a.name]));
  const sorted = [...batches].sort((a, b) => (a.importedAt < b.importedAt ? 1 : -1));
  return (
    <Card title="Import history">
      {sorted.length === 0 ? (
        <p className="small muted">No imports yet.</p>
      ) : (
        <ul className="list">
          {sorted.map((b) => (
            <li key={b.id} className="with-actions">
              <div className="primary">
                <div className="title">{b.fileName ?? 'Statement'}</div>
                <div className="meta">
                  <span>{names.get(b.accountId) ?? 'Unknown account'}</span>
                  <span>Imported {formatDisplayDate(b.importedAt.slice(0, 10))}</span>
                  {b.dateFrom && b.dateTo && (
                    <span>
                      <DateText date={b.dateFrom} /> – <DateText date={b.dateTo} />
                    </span>
                  )}
                  <span>{b.transactionCount} added</span>
                  {b.skippedCount ? <span>{b.skippedCount} skipped</span> : null}
                  {b.errorCount ? <span>{b.errorCount} unreadable</span> : null}
                  {b.status === 'undone' && <Badge kind="warning">Undone</Badge>}
                </div>
              </div>
              {b.status === 'committed' && (
                <div className="btn-row">
                  <button
                    type="button"
                    className="btn btn-sm btn-danger"
                    onClick={() =>
                      void run(async () => {
                        const edited = await editedSinceImport(store, b.id);
                        const ok = await confirm({
                          title: `Undo import of ${b.fileName ?? 'this statement'}?`,
                          message: (
                            <>
                              <p>This removes the {b.transactionCount} transactions it added.</p>
                              {edited > 0 && (
                                <p>
                                  {edited} of them were edited after import; those changes will be
                                  lost.
                                </p>
                              )}
                            </>
                          ),
                          confirmLabel: 'Undo import',
                          danger: true,
                        });
                        if (ok) await undoImport(store, b.id);
                      })
                    }
                  >
                    Undo import
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {statusNode}
    </Card>
  );
}

/* ------------------------------------------------------------------ Page */

export function ImportPage() {
  const { store, db } = useApp();
  const data = useFinanceData();
  const [step, setStepState] = useState<Step>('account');
  /** False until the user moves between steps, so the page doesn't steal focus on load. */
  const [moved, setMoved] = useState(false);
  const [accountId, setAccountId] = useState('');
  const [prepared, setPrepared] = useState<PreparedImport | null>(null);
  const [rows, setRows] = useState<StagedRow[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CommitResult | null>(null);
  const [syncNote, setSyncNote] = useState<string | null>(null);
  const sync = useSync();
  const importCount = useLiveQuery(() => db.importBatches.count(), [db]);

  const activeAccounts = useMemo(
    () =>
      data
        ? data.accounts.filter((a) => a.active).sort((a, b) => a.name.localeCompare(b.name))
        : [],
    [data],
  );
  // With a single account there is nothing to choose.
  const onlyAccount = activeAccounts.length === 1 ? activeAccounts[0]!.id : '';
  useEffect(() => {
    if (onlyAccount && !accountId) setAccountId(onlyAccount);
  }, [onlyAccount, accountId]);

  if (!data) return <Loading />;
  const account = activeAccounts.find((a) => a.id === accountId);

  function goTo(next: Step) {
    setMoved(true);
    setStepState(next);
    if (typeof window.scrollTo === 'function' && !navigator.userAgent.includes('jsdom')) {
      window.scrollTo(0, 0);
    }
  }

  function startOver() {
    setPrepared(null);
    setRows([]);
    setFileError(null);
    setResult(null);
    setSyncNote(null);
    goTo('account');
  }

  async function onFile(file: File) {
    setFileError(null);
    setSyncNote(null);
    setBusy(true);
    try {
      checkImportFile(file);
      if (sync) {
        // Fetch imports made on other devices first, so they count as duplicates here.
        await sync.engine
          .syncNow()
          .catch(() =>
            setSyncNote(
              'Couldn’t check for imports made on your other devices (offline). Duplicates are checked against this device only.',
            ),
          );
      }
      const p = await prepareImport(store, {
        accountId,
        ...(isWorkbookFileName(file.name) || file.type === XLSX_TYPE
          ? { workbook: await readFileBytes(file) }
          : { text: await readFileText(file) }),
        fileName: file.name,
      });
      setPrepared(p);
      setRows(p.staging.rows);
      goTo('columns');
    } catch (e) {
      setPrepared(null);
      setFileError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onMapping(m: ColumnMapping) {
    if (!prepared) return;
    const p = await restage(store, prepared, m);
    setPrepared(p);
    setRows(p.staging.rows);
  }

  const previous: Partial<Record<Step, Step>> = {
    file: 'account',
    columns: 'file',
    review: 'columns',
  };
  const back = previous[step];

  return (
    <>
      <PageHeader
        title="Import statement"
        subtitle={step === 'account' ? 'Bring in transactions from a CSV or Excel file' : undefined}
        back={back ? { onClick: () => goTo(back), label: 'Back' } : undefined}
        actions={
          step !== 'account' && step !== 'done' ? (
            <button type="button" className="btn btn-ghost btn-sm" onClick={startOver}>
              Cancel
            </button>
          ) : undefined
        }
      />
      <div className="import-flow">
        <StepIndicator step={step} />

        {step === 'account' && (
          <AccountStep
            accounts={activeAccounts}
            accountId={accountId}
            onChoose={(id) => {
              setAccountId(id);
              setPrepared(null);
              setFileError(null);
            }}
            onNext={() => goTo('file')}
            focus={moved}
          />
        )}
        {step === 'file' && account && (
          <FileStep
            account={account}
            busy={busy}
            error={fileError}
            firstTime={importCount === 0}
            onFile={(f) => void onFile(f)}
            onChangeAccount={() => goTo('account')}
            focus={moved}
          />
        )}
        {step === 'columns' && prepared && (
          <ColumnsStep
            prepared={prepared}
            rows={rows}
            syncNote={syncNote}
            onMapping={(m) => void onMapping(m)}
            onNext={() => goTo('review')}
            focus={moved}
          />
        )}
        {step === 'review' && prepared && (
          <ReviewStep
            key={`${prepared.fileName}-${JSON.stringify(prepared.staging.mapping)}`}
            prepared={prepared}
            accounts={data.accounts}
            categories={data.categories}
            rows={rows}
            setRows={setRows}
            onImported={(res) => {
              setResult(res);
              setPrepared(null);
              setRows([]);
              goTo('done');
            }}
            focus={moved}
          />
        )}
        {step === 'done' && result && (
          <DoneStep
            result={result}
            accountName={account?.name ?? 'your account'}
            onAnother={startOver}
            focus={moved}
          />
        )}

        {(step === 'account' || step === 'done') && <HistoryCard />}
      </div>
    </>
  );
}
