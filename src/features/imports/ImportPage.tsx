import { useSync } from '@/app/SyncContext';
import { useMemo, useRef, useState } from 'react';
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
} from '@/domain/imports';
import { formatDisplayDate } from '@/domain/dates';
import { WORKSPACE_LABELS } from '@/domain/models';
import {
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
  readFileText,
  useStatus,
} from '@/components/ui';
import { AccountOptions } from '../shared';

type RowFilter = 'all' | 'selected' | 'skipped' | 'problems';
const PAGE = 200;

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
    default:
      return <Badge kind="actual">New</Badge>;
  }
}

function MappingCard({
  prepared,
  onChange,
}: {
  prepared: PreparedImport;
  onChange: (m: ColumnMapping) => void;
}) {
  const m = prepared.staging.mapping;
  const set = (patch: Partial<ColumnMapping>) => onChange({ ...m, ...patch });
  const preview = prepared.parsed.rows.slice(0, 6);
  const bc = prepared.staging.balanceCheck;
  return (
    <Card title="2. Check the columns">
      {prepared.mappingSource === 'saved' && (
        <Alert tone="success">Using the column mapping saved for this account.</Alert>
      )}
      {prepared.headerChanged && (
        <Alert tone="warning">
          This file’s columns differ from the last import into this account, so the mapping was
          guessed again. Please check it.
        </Alert>
      )}
      {prepared.mappingSource === 'guessed' && !prepared.headerChanged && (
        <Alert tone="info">
          The columns were guessed from the file. Check them against the preview before continuing.
        </Alert>
      )}
      {prepared.parsed.warnings.length > 0 && (
        <Alert tone="warning">
          The file had formatting problems: {prepared.parsed.warnings.join('; ')}. Affected rows may
          show as errors below.
        </Alert>
      )}
      <div className="table-wrap section">
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
      {prepared.staging.mappingErrors.map((e) => (
        <Alert key={e} tone="negative">
          {e}
        </Alert>
      ))}
      {prepared.staging.dateFormatAmbiguous && (
        <Alert tone="warning">
          Every date in this file could be read as day/month or month/day. Day/month/year (South
          African) is assumed — choose a different date format above if that’s wrong.
        </Alert>
      )}
      {bc?.suggestInvertSign && (
        <Alert tone="warning">
          The running balance only adds up if the amount signs are flipped. Tick “Flip signs” above
          if money in and out look reversed below.
        </Alert>
      )}
      {bc && !bc.suggestInvertSign && bc.pairsChecked > 0 && (
        <p className="xs faint">
          Running-balance check: {bc.consistentPairs} of {bc.pairsChecked} consecutive rows add up
          exactly.
        </p>
      )}
    </Card>
  );
}

function ReviewCard({
  prepared,
  rows,
  setRows,
  onImported,
}: {
  prepared: PreparedImport;
  rows: StagedRow[];
  setRows: (r: StagedRow[]) => void;
  onImported: (msg: string) => void;
}) {
  const { store } = useApp();
  const [filter, setFilter] = useState<RowFilter>('all');
  const [limit, setLimit] = useState(PAGE);
  const [saveMapping, setSaveMapping] = useState(true);
  const [useClosing, setUseClosing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const summary = summariseStaging(rows, prepared.account);
  const closing = prepared.staging.balanceCheck?.closing ?? null;

  const shown = rows.filter((r) =>
    filter === 'all'
      ? true
      : filter === 'selected'
        ? r.include
        : filter === 'skipped'
          ? !r.include
          : r.status !== 'new' || r.identicalLines.length > 0,
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
      });
      onImported(`Imported ${res.created} transaction${res.created === 1 ? '' : 's'}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <Card title="3. Review and import">
      <ul className="list small" aria-label="Import summary">
        <li>
          <span>Rows in file</span>
          <span>{summary.totalRows}</span>
        </li>
        {summary.dateRange && (
          <li>
            <span>Dates</span>
            <span>
              <DateText date={summary.dateRange.from} /> – <DateText date={summary.dateRange.to} />
            </span>
          </li>
        )}
        <li>
          <span>New</span>
          <span>{summary.newRows}</span>
        </li>
        {summary.duplicates > 0 && (
          <li>
            <span>Already imported (skipped unless you tick them)</span>
            <span>{summary.duplicates}</span>
          </li>
        )}
        {summary.possibleDuplicates > 0 && (
          <li>
            <span>Possible duplicates of entries you added manually</span>
            <span>{summary.possibleDuplicates}</span>
          </li>
        )}
        {summary.invalid > 0 && (
          <li>
            <span>Rows that can’t be read (never imported)</span>
            <span className="negative">{summary.invalid}</span>
          </li>
        )}
        <li>
          <span>
            Selected: <strong>{summary.selected}</strong>
          </span>
          <span>
            In <Money cents={summary.selectedInCents} /> · Out{' '}
            <Money cents={-summary.selectedOutCents} />
          </span>
        </li>
      </ul>
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

      <div className="toolbar">
        <div className="segmented" role="group" aria-label="Show rows">
          {(
            [
              ['all', 'All'],
              ['selected', 'Importing'],
              ['skipped', 'Skipped'],
              ['problems', 'Needs a look'],
            ] as const
          ).map(([k, label]) => (
            <button key={k} type="button" aria-pressed={filter === k} onClick={() => setFilter(k)}>
              {label}
            </button>
          ))}
        </div>
        <div className="btn-row">
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setRows(rows.map((r) => ({ ...r, include: r.status === 'new' })))}
          >
            Reset selection
          </button>
        </div>
      </div>

      {shown.length === 0 ? (
        <Empty title="No rows in this view" />
      ) : (
        <ul className="list" aria-label="Rows to import">
          {shown.slice(0, limit).map((r) => (
            <li key={r.index}>
              <input
                type="checkbox"
                aria-label={`Import line ${r.line}: ${r.description || 'no description'}`}
                checked={r.include}
                disabled={r.status === 'invalid'}
                onChange={() => toggle(r.index)}
              />
              <div className="primary">
                <div className="title">
                  {r.description || <span className="faint">No description</span>}
                </div>
                <div className="meta">
                  <span>Line {r.line}</span>
                  {r.date && <DateText date={r.date} />}
                  {statusBadge(r)}
                  {r.reference && <span>Ref {r.reference}</span>}
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
                </div>
              </div>
              {r.amountCents !== null && <Money cents={r.amountCents} signed tone />}
            </li>
          ))}
        </ul>
      )}
      {shown.length > limit && (
        <button type="button" className="btn" onClick={() => setLimit((l) => l + PAGE)}>
          Show more ({shown.length - limit} remaining)
        </button>
      )}

      <div className="form section">
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
        <p className="small muted">
          Imported transactions are marked <strong>Needs review</strong> and start uncategorised.
          The original row text is kept with each one, and the whole import can be undone from the
          history below.
        </p>
        {error && <Alert tone="negative">{error}</Alert>}
        <div className="btn-row">
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || summary.selected === 0 || prepared.staging.mappingErrors.length > 0}
            onClick={() => void commit()}
          >
            {busy
              ? 'Importing…'
              : `Import ${summary.selected} transaction${summary.selected === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </Card>
  );
}

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

export function ImportPage() {
  const { store } = useApp();
  const data = useFinanceData();
  const { statusNode, setStatus } = useStatus();
  const fileRef = useRef<HTMLInputElement>(null);
  const [accountId, setAccountId] = useState('');
  const [prepared, setPrepared] = useState<PreparedImport | null>(null);
  const [rows, setRows] = useState<StagedRow[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [syncNote, setSyncNote] = useState<string | null>(null);
  const sync = useSync();

  const activeAccounts = useMemo(() => (data ? data.accounts.filter((a) => a.active) : []), [data]);
  if (!data) return <Loading />;
  const account = activeAccounts.find((a) => a.id === accountId);

  async function onFile(file: File) {
    setFileError(null);
    setDone(null);
    setSyncNote(null);
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
        text: await readFileText(file),
        fileName: file.name,
      });
      setPrepared(p);
      setRows(p.staging.rows);
    } catch (e) {
      setPrepared(null);
      setFileError(e instanceof Error ? e.message : String(e));
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function onMapping(m: ColumnMapping) {
    if (!prepared) return;
    const p = await restage(store, prepared, m);
    setPrepared(p);
    setRows(p.staging.rows);
  }

  return (
    <>
      <div className="topbar">
        <h1>Import statement</h1>
      </div>
      <Alert tone="info">
        Import transactions from a <strong>CSV file</strong> — for example a transaction history
        downloaded from your bank’s internet banking (where offered), or an Excel sheet saved as
        “CSV UTF-8”. The file is read on this device only and never uploaded. PDF statements and
        direct bank connections aren’t supported.
      </Alert>
      {done && (
        <Alert
          tone="success"
          action={
            <Link className="btn btn-sm" to="/transactions?status=needs_review">
              Review imported transactions
            </Link>
          }
        >
          {done}. They’re marked “Needs review” so you can categorise them.
        </Alert>
      )}
      <div className="grid">
        <Card title="1. Choose the account and file">
          {activeAccounts.length === 0 ? (
            <Empty title="Add an account first">
              <p>
                <Link to="/accounts">Add the account</Link> this statement belongs to.
              </p>
            </Empty>
          ) : (
            <div className="form">
              <div className="form-row">
                <Field label="Account" htmlFor="imp-account">
                  <select
                    id="imp-account"
                    value={accountId}
                    onChange={(e) => {
                      setAccountId(e.target.value);
                      setPrepared(null);
                      setFileError(null);
                    }}
                  >
                    <option value="">Choose…</option>
                    <AccountOptions accounts={activeAccounts} />
                  </select>
                </Field>
                <Field
                  label="Statement file (.csv)"
                  htmlFor="imp-file"
                  error={fileError ?? undefined}
                >
                  <input
                    id="imp-file"
                    ref={fileRef}
                    type="file"
                    accept=".csv,.txt,text/csv,text/plain"
                    disabled={!accountId}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void onFile(f);
                    }}
                  />
                </Field>
              </div>
              {account && (
                <p className="small muted">
                  Importing into <strong>{account.name}</strong> (
                  {WORKSPACE_LABELS[account.workspace]}). Opening balance date:{' '}
                  <DateText date={account.openingBalanceDate} />.
                </p>
              )}
              {prepared && (
                <p className="small">
                  Read <strong>{prepared.fileName}</strong>: {prepared.parsed.rows.length} lines.{' '}
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={() => setPrepared(null)}
                  >
                    Cancel this import
                  </button>
                </p>
              )}
            </div>
          )}
        </Card>

        {syncNote && prepared && <Alert tone="warning">{syncNote}</Alert>}
        {prepared && <MappingCard prepared={prepared} onChange={(m) => void onMapping(m)} />}
        {prepared && prepared.staging.mappingErrors.length === 0 && (
          <ReviewCard
            key={`${prepared.fileName}-${JSON.stringify(prepared.staging.mapping)}`}
            prepared={prepared}
            rows={rows}
            setRows={setRows}
            onImported={(msg) => {
              setPrepared(null);
              setRows([]);
              setDone(msg);
              setStatus({ tone: 'success', text: msg });
            }}
          />
        )}
        <HistoryCard />
      </div>
      {statusNode}
    </>
  );
}
