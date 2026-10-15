import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useApp, useFinanceData } from '@/app/AppContext';
import {
  TRANSACTION_SOURCES,
  TRANSACTION_SOURCE_LABELS,
  TRANSACTION_STATUSES,
  TRANSACTION_STATUS_LABELS,
  TRANSACTION_TYPES,
  TRANSACTION_TYPE_LABELS,
  TRANSFER_KIND_LABELS,
  WORKSPACE_LABELS,
  type Transaction,
} from '@/domain/models';
import { inView } from '@/domain/calculations/reporting';
import { normaliseText } from '@/domain/calculations/recurring';
import {
  bulkSetCategory,
  deleteTransactionPermanently,
  setTransactionArchived,
} from '@/services/transactionsService';
import {
  Badge,
  Card,
  DateText,
  Empty,
  Loading,
  Money,
  WorkspaceSwitcher,
  useStatus,
} from '@/components/ui';
import { AccountOptions, CategoryOptions, lookup } from '../shared';
import { TransactionForm, TransferForm } from './TransactionForms';

type Sort = 'date_desc' | 'date_asc' | 'amount_desc' | 'amount_asc';
type Panel = { kind: 'new' } | { kind: 'transfer' } | { kind: 'edit'; txn: Transaction } | null;

const PAGE_SIZE = 100;

export function TransactionsPage() {
  const { store, view, setView, today } = useApp();
  const data = useFinanceData();
  const { run, statusNode, setStatus } = useStatus();
  const [params] = useSearchParams();
  const [panel, setPanel] = useState<Panel>(params.get('new') === '1' ? { kind: 'new' } : null);
  const [search, setSearch] = useState('');
  const [accountId, setAccountId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [type, setType] = useState('');
  const [status, setStatusFilter] = useState(params.get('status') ?? '');
  const [source, setSource] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [sort, setSort] = useState<Sort>('date_desc');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkCategory, setBulkCategory] = useState('');
  const [limit, setLimit] = useState(PAGE_SIZE);

  const filtered = useMemo(() => {
    if (!data) return [];
    const q = normaliseText(search);
    const list = data.transactions.filter((t) => {
      if (!showArchived && t.archived) return false;
      if (!inView(t.workspace, view)) return false;
      if (accountId && t.accountId !== accountId) return false;
      if (categoryId === '__none' && (t.categoryId !== null || t.type === 'transfer')) return false;
      if (categoryId && categoryId !== '__none' && t.categoryId !== categoryId) return false;
      if (type && t.type !== type) return false;
      if (status && t.status !== status) return false;
      if (source && t.source !== source) return false;
      if (from && t.date < from) return false;
      if (to && t.date > to) return false;
      if (q) {
        const hay = normaliseText(
          `${t.description} ${t.originalDescription ?? ''} ${t.notes ?? ''}`,
        );
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    const dir = sort.endsWith('asc') ? 1 : -1;
    return list.sort((a, b) => {
      if (sort.startsWith('amount'))
        return dir * (Math.abs(a.amountCents) - Math.abs(b.amountCents));
      if (a.date !== b.date) return dir * (a.date < b.date ? -1 : 1);
      return dir * (a.createdAt < b.createdAt ? -1 : 1);
    });
  }, [
    data,
    search,
    view,
    accountId,
    categoryId,
    type,
    status,
    source,
    from,
    to,
    showArchived,
    sort,
  ]);

  if (!data) return <Loading />;
  const accountsById = lookup(data.accounts);
  const categoriesById = lookup(data.categories);
  const visible = filtered.slice(0, limit);
  const selectable = visible.filter((t) => t.type !== 'transfer');
  const allSelected = selectable.length > 0 && selectable.every((t) => selected.has(t.id));

  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const done = (msg: string) => {
    setPanel(null);
    setStatus({ tone: 'success', text: msg });
  };

  function editPanel(txn: Transaction) {
    if (txn.type !== 'transfer' || !txn.transferId) {
      return (
        <TransactionForm
          key={txn.id}
          accounts={data!.accounts}
          categories={data!.categories}
          editing={txn}
          today={today}
          onDone={done}
          onCancel={() => setPanel(null)}
        />
      );
    }
    const legs = data!.transactions.filter((t) => t.transferId === txn.transferId);
    const out = legs.find((l) => l.amountCents < 0);
    const into = legs.find((l) => l.amountCents > 0);
    return (
      <TransferForm
        key={txn.id}
        accounts={data!.accounts}
        editingTransferId={txn.transferId}
        initial={{
          fromAccountId: out?.accountId ?? '',
          toAccountId: into?.accountId ?? '',
          amountCents: Math.abs(txn.amountCents),
          date: txn.date,
          notes: txn.notes,
        }}
        today={today}
        onDone={done}
        onCancel={() => setPanel(null)}
      />
    );
  }

  const hasAccounts = data.accounts.some((a) => a.active);

  return (
    <>
      <div className="topbar">
        <h1>Transactions</h1>
        <WorkspaceSwitcher value={view} onChange={setView} />
      </div>

      <div className="toolbar">
        <div className="btn-row">
          <button
            type="button"
            className="btn btn-primary"
            disabled={!hasAccounts}
            onClick={() => setPanel({ kind: 'new' })}
          >
            Add transaction
          </button>
          <button
            type="button"
            className="btn"
            disabled={data.accounts.filter((a) => a.active).length < 2}
            onClick={() => setPanel({ kind: 'transfer' })}
          >
            Add transfer
          </button>
          <Link className="btn" to="/import">
            Import CSV
          </Link>
        </div>
        <span className="small muted" aria-live="polite">
          {filtered.length} transaction{filtered.length === 1 ? '' : 's'}
        </span>
      </div>

      {!hasAccounts && (
        <Card>
          <Empty title="Add an account first">
            <p>
              Transactions belong to an account. <Link to="/accounts">Add an account</Link> to get
              started.
            </p>
          </Empty>
        </Card>
      )}

      {panel?.kind === 'new' && (
        <TransactionForm
          accounts={data.accounts}
          categories={data.categories}
          editing={null}
          defaultAccountId={accountId || undefined}
          today={today}
          onDone={done}
          onCancel={() => setPanel(null)}
        />
      )}
      {panel?.kind === 'transfer' && (
        <TransferForm
          accounts={data.accounts}
          today={today}
          onDone={done}
          onCancel={() => setPanel(null)}
        />
      )}
      {panel?.kind === 'edit' && editPanel(panel.txn)}

      {hasAccounts && (
        <Card>
          <details className="explainer" open={false}>
            <summary>Search, filter and sort</summary>
            <div className="filters">
              <div className="field">
                <label htmlFor="f-search">Search</label>
                <input
                  id="f-search"
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="f-account">Account</label>
                <select
                  id="f-account"
                  value={accountId}
                  onChange={(e) => setAccountId(e.target.value)}
                >
                  <option value="">All accounts</option>
                  <AccountOptions accounts={data.accounts} includeArchived />
                </select>
              </div>
              <div className="field">
                <label htmlFor="f-cat">Category</label>
                <select
                  id="f-cat"
                  value={categoryId}
                  onChange={(e) => setCategoryId(e.target.value)}
                >
                  <option value="">All categories</option>
                  <option value="__none">Uncategorised</option>
                  <CategoryOptions categories={data.categories} />
                </select>
              </div>
              <div className="field">
                <label htmlFor="f-type">Type</label>
                <select id="f-type" value={type} onChange={(e) => setType(e.target.value)}>
                  <option value="">All types</option>
                  {TRANSACTION_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {TRANSACTION_TYPE_LABELS[t]}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="f-status">Status</label>
                <select
                  id="f-status"
                  value={status}
                  onChange={(e) => setStatusFilter(e.target.value)}
                >
                  <option value="">All statuses</option>
                  {TRANSACTION_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {TRANSACTION_STATUS_LABELS[s]}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="f-source">Source</label>
                <select id="f-source" value={source} onChange={(e) => setSource(e.target.value)}>
                  <option value="">All sources</option>
                  {TRANSACTION_SOURCES.map((s) => (
                    <option key={s} value={s}>
                      {TRANSACTION_SOURCE_LABELS[s]}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="f-from">From date</label>
                <input
                  id="f-from"
                  type="date"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="f-to">To date</label>
                <input id="f-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="f-sort">Sort by</label>
                <select id="f-sort" value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
                  <option value="date_desc">Newest first</option>
                  <option value="date_asc">Oldest first</option>
                  <option value="amount_desc">Largest amount</option>
                  <option value="amount_asc">Smallest amount</option>
                </select>
              </div>
              <label className="check">
                <input
                  type="checkbox"
                  checked={showArchived}
                  onChange={(e) => setShowArchived(e.target.checked)}
                />
                Show archived
              </label>
            </div>
          </details>

          {selected.size > 0 && (
            <div className="panel btn-row" role="region" aria-label="Bulk actions">
              <span className="small">{selected.size} selected</span>
              <label className="visually-hidden" htmlFor="bulk-cat">
                Category for selected
              </label>
              <select
                id="bulk-cat"
                value={bulkCategory}
                onChange={(e) => setBulkCategory(e.target.value)}
              >
                <option value="">Choose category…</option>
                <option value="__none">Uncategorised</option>
                <CategoryOptions
                  categories={data.categories}
                  workspace={view === 'combined' ? undefined : view}
                />
              </select>
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={!bulkCategory}
                onClick={() =>
                  void run(async () => {
                    const n = await bulkSetCategory(
                      store,
                      [...selected],
                      bulkCategory === '__none' ? null : bulkCategory,
                    );
                    setSelected(new Set());
                    setBulkCategory('');
                    setStatus({
                      tone: 'success',
                      text: `Updated ${n} transaction${n === 1 ? '' : 's'}`,
                    });
                  })
                }
              >
                Apply
              </button>
              <button type="button" className="btn btn-sm" onClick={() => setSelected(new Set())}>
                Clear selection
              </button>
            </div>
          )}

          {filtered.length === 0 ? (
            <Empty title="No transactions match">
              <p>Add a transaction, or adjust the filters.</p>
            </Empty>
          ) : (
            <>
              <label className="check small">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={() =>
                    setSelected(allSelected ? new Set() : new Set(selectable.map((t) => t.id)))
                  }
                />
                Select all shown
              </label>
              <ul className="list" aria-label="Transactions">
                {visible.map((t) => {
                  const account = accountsById.get(t.accountId);
                  const category = t.categoryId ? categoriesById.get(t.categoryId) : undefined;
                  return (
                    <li key={t.id} className="with-actions">
                      {t.type !== 'transfer' ? (
                        <input
                          type="checkbox"
                          aria-label={`Select ${t.description}`}
                          checked={selected.has(t.id)}
                          onChange={() => toggle(t.id)}
                        />
                      ) : (
                        <span aria-hidden="true" className="faint">
                          ⇄
                        </span>
                      )}
                      <div className="primary">
                        <div className="title">{t.description}</div>
                        <div className="meta">
                          <DateText date={t.date} />
                          <span>{account?.name ?? 'Unknown account'}</span>
                          {t.type === 'transfer' ? (
                            <Badge>{TRANSFER_KIND_LABELS[t.transferKind ?? 'internal']}</Badge>
                          ) : category ? (
                            <span>{category.name}</span>
                          ) : (
                            <Badge kind="warning">Uncategorised</Badge>
                          )}
                          {t.type === 'refund' && <Badge>Refund</Badge>}
                          {t.type === 'adjustment' && <Badge>Adjustment</Badge>}
                          {t.status !== 'posted' && (
                            <Badge kind={t.status === 'needs_review' ? 'warning' : 'default'}>
                              {TRANSACTION_STATUS_LABELS[t.status]}
                            </Badge>
                          )}
                          {view === 'combined' && <Badge>{WORKSPACE_LABELS[t.workspace]}</Badge>}
                          {t.source !== 'manual' && (
                            <span>{TRANSACTION_SOURCE_LABELS[t.source]}</span>
                          )}
                          {t.archived && <Badge kind="warning">Archived</Badge>}
                          {t.isDemo && <Badge kind="demo">Demo</Badge>}
                        </div>
                      </div>
                      <div className="end">
                        <Money cents={t.amountCents} signed tone />
                      </div>
                      <div className="btn-row">
                        <button
                          type="button"
                          className="btn btn-sm"
                          aria-label={`Edit ${t.description}`}
                          onClick={() => setPanel({ kind: 'edit', txn: t })}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm"
                          aria-label={`${t.archived ? 'Restore' : 'Archive'} ${t.description}`}
                          onClick={() =>
                            void run(
                              () => setTransactionArchived(store, t.id, !t.archived),
                              t.archived
                                ? 'Restored'
                                : 'Archived — it no longer counts in balances or reports',
                            )
                          }
                        >
                          {t.archived ? 'Restore' : 'Archive'}
                        </button>
                        {t.source === 'manual' && (
                          <button
                            type="button"
                            className="btn btn-sm btn-danger"
                            aria-label={`Delete ${t.description}`}
                            onClick={() => {
                              const msg =
                                t.type === 'transfer'
                                  ? 'Delete both sides of this transfer permanently?'
                                  : `Delete "${t.description}" permanently?`;
                              if (window.confirm(msg)) {
                                void run(
                                  () => deleteTransactionPermanently(store, t.id),
                                  'Deleted',
                                );
                              }
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
              {filtered.length > limit && (
                <button
                  type="button"
                  className="btn"
                  onClick={() => setLimit((l) => l + PAGE_SIZE)}
                >
                  Show more ({filtered.length - limit} remaining)
                </button>
              )}
            </>
          )}
        </Card>
      )}
      {statusNode}
    </>
  );
}
