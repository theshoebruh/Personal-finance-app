import { useEffect, useState } from 'react';
import { useApp } from '@/app/AppContext';
import { useSync, type SyncContextValue } from '@/app/SyncContext';
import type { ConflictEntry, OutboxEntry } from '@/data/local-db/db';
import type { SyncStatus } from '@/data/sync/syncEngine';
import { formatZAR } from '@/domain/money';
import { Alert, Badge, Card, useStatus } from '@/components/ui';
import { useConfirm } from '@/components/ConfirmDialog';

const TABLE_LABELS: Record<string, string> = {
  accounts: 'Account',
  transactions: 'Transaction',
  categories: 'Category',
  budgets: 'Budget',
  goals: 'Goal',
  goalContributions: 'Goal allocation',
  recurringRules: 'Recurring item',
  importBatches: 'Import',
  importProfiles: 'Import column mapping',
  categorisationRules: 'Categorisation rule',
  projects: 'Project',
  invoices: 'Invoice',
  settings: 'Settings',
};

const IGNORED_FIELDS = new Set(['createdAt', 'updatedAt']);

export function statusText(s: SyncStatus): string {
  switch (s.state) {
    case 'syncing':
      return 'Syncing…';
    case 'offline':
      return s.pending > 0
        ? `Offline — ${s.pending} change${s.pending === 1 ? '' : 's'} waiting`
        : 'Offline';
    case 'error':
      return 'Sync problem';
    case 'signed_out':
      return 'Signed out — sign in to sync';
    default:
      if (s.conflicts > 0)
        return `${s.conflicts} conflict${s.conflicts === 1 ? '' : 's'} to review`;
      if (s.failed > 0) return `${s.failed} change${s.failed === 1 ? '' : 's'} couldn’t sync`;
      if (s.pending > 0) return `${s.pending} change${s.pending === 1 ? '' : 's'} waiting`;
      return 'Synced';
  }
}

export function dotState(s: SyncStatus): string {
  if (s.state === 'idle' && (s.conflicts > 0 || s.failed > 0)) return 'attention';
  return s.state;
}

/** Small status indicator for the navigation. */
export function SyncPill() {
  const sync = useSync();
  if (!sync) return null;
  return (
    <span className="sync-pill" role="status" aria-live="polite">
      <span className="sync-dot" data-state={dotState(sync.status)} aria-hidden="true" />
      {statusText(sync.status)}
    </span>
  );
}

function summary(record: Record<string, unknown> | null): string {
  if (!record) return 'Deleted';
  const name = (record.description ?? record.name ?? record.invoiceNumber ?? record.id) as string;
  const amount =
    typeof record.amountCents === 'number' ? ` · ${formatZAR(record.amountCents)}` : '';
  const date = typeof record.date === 'string' ? ` · ${record.date}` : '';
  return `${name}${amount}${date}`;
}

function changedFields(c: ConflictEntry): { field: string; mine: string; theirs: string }[] {
  if (!c.local || !c.remote) return [];
  const keys = new Set([...Object.keys(c.local), ...Object.keys(c.remote)]);
  const out: { field: string; mine: string; theirs: string }[] = [];
  for (const k of keys) {
    if (IGNORED_FIELDS.has(k)) continue;
    const a = JSON.stringify(c.local[k] ?? null);
    const b = JSON.stringify(c.remote[k] ?? null);
    if (a !== b) out.push({ field: k, mine: a, theirs: b });
  }
  return out;
}

function Conflicts({ sync }: { sync: SyncContextValue }) {
  const { store } = useApp();
  const { run, statusNode } = useStatus();
  const [items, setItems] = useState<ConflictEntry[]>([]);
  useEffect(() => {
    void sync.engine.listConflicts().then(setItems);
  }, [sync.engine, sync.status.conflicts]);
  if (items.length === 0) return null;
  return (
    <section className="stack" aria-label="Sync conflicts">
      <h3>Conflicts to review</h3>
      <p className="small muted">
        These records were changed on another device before this device’s changes reached the
        server. The synced version is showing now; your version from this device is kept here until
        you choose.
      </p>
      <ul className="list">
        {items.map((c) => {
          const fields = changedFields(c);
          return (
            <li key={c.key} className="with-actions">
              <div className="primary">
                <div className="title">
                  {TABLE_LABELS[c.table] ?? c.table}: {summary(c.remote ?? c.local)}
                </div>
                <div className="meta">
                  {!c.remote && <span>Deleted on another device</span>}
                  {!c.local && <span>Deleted on this device</span>}
                  {fields.slice(0, 4).map((f) => (
                    <span key={f.field}>
                      {f.field}: this device {f.mine} → synced {f.theirs}
                    </span>
                  ))}
                </div>
              </div>
              <div className="btn-row">
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() =>
                    void run(
                      () => sync.engine.resolveConflict(c.key, 'keep_local', store),
                      'Kept this device’s version',
                    )
                  }
                >
                  Keep this device’s version
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  onClick={() =>
                    void run(
                      () => sync.engine.resolveConflict(c.key, 'keep_remote', store),
                      'Kept the synced version',
                    )
                  }
                >
                  Keep synced version
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      {statusNode}
    </section>
  );
}

function FailedChanges({ sync }: { sync: SyncContextValue }) {
  const [items, setItems] = useState<OutboxEntry[]>([]);
  useEffect(() => {
    void sync.engine.failedChanges().then(setItems);
  }, [sync.engine, sync.status.failed]);
  if (items.length === 0) return null;
  return (
    <Alert
      tone="warning"
      action={
        <button type="button" className="btn btn-sm" onClick={() => void sync.engine.retryFailed()}>
          Try these again
        </button>
      }
    >
      <p>
        <strong>
          The server didn’t accept {items.length === 1 ? 'one change' : `${items.length} changes`}.
        </strong>{' '}
        They are still saved on this device. Edit the record or try again.
      </p>
      <ul className="small">
        {items.slice(0, 5).map((e) => (
          <li key={e.key}>
            {TABLE_LABELS[e.table] ?? e.table} {e.id}: {e.failedReason}
          </li>
        ))}
      </ul>
    </Alert>
  );
}

export function SyncCard() {
  const sync = useSync();
  const confirm = useConfirm();
  const { run, statusNode } = useStatus();
  const [removeLocal, setRemoveLocal] = useState(true);
  if (!sync) return null;
  const s = sync.status;

  return (
    <Card
      title="Sync and account"
      action={
        <Badge kind={s.state === 'idle' && !s.conflicts ? 'actual' : 'warning'}>
          {statusText(s)}
        </Badge>
      }
    >
      <div className="stack">
        <p className="small">
          Signed in as <strong>{sync.email}</strong>. Changes save on this device first and sync to
          your account, so they appear on your other devices. You can keep working offline.
        </p>
        <p className="small muted">
          {s.lastSyncedAt
            ? `Last synced ${new Date(s.lastSyncedAt).toLocaleString('en-ZA')}.`
            : 'Not synced yet.'}{' '}
          {s.pending > 0 && `${s.pending} change${s.pending === 1 ? '' : 's'} waiting to send.`}
        </p>
        {s.error && <Alert tone={s.state === 'offline' ? 'info' : 'negative'}>{s.error}</Alert>}
        <div className="btn-row">
          <button
            type="button"
            className="btn"
            disabled={s.state === 'syncing'}
            onClick={() => void run(() => sync.engine.syncNow(), 'Synced')}
          >
            Sync now
          </button>
        </div>

        {sync.localOnlyRecordCount > 0 && (
          <Alert
            tone="info"
            action={
              <div className="btn-row">
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  onClick={() =>
                    void run(() => sync.copyLocalOnlyData(), 'Copied into your account')
                  }
                >
                  Copy into my account
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={async () => {
                    const ok = await confirm({
                      title: 'Delete the data saved before you signed in?',
                      message: 'It is only on this device and has not been copied to your account.',
                      confirmLabel: 'Delete it',
                      danger: true,
                    });
                    if (ok) void run(() => sync.discardLocalOnlyData(), 'Deleted');
                  }}
                >
                  Delete it
                </button>
              </div>
            }
          >
            <p>
              This device has {sync.localOnlyRecordCount} records saved before you signed in. Copy
              them into your account to sync them, or delete them. Your account’s settings are kept
              either way.
            </p>
          </Alert>
        )}

        <FailedChanges sync={sync} />
        <Conflicts sync={sync} />

        <div className="stack">
          <label className="check small">
            <input
              type="checkbox"
              checked={removeLocal}
              onChange={(e) => setRemoveLocal(e.target.checked)}
            />
            Remove this device’s copy of my data when I sign out
          </label>
          <div className="btn-row">
            <button
              type="button"
              className="btn btn-danger"
              onClick={async () => {
                const pending = sync.status.pending + sync.status.failed;
                const ok = await confirm({
                  title: 'Sign out?',
                  message: (
                    <>
                      {pending > 0 && (
                        <p>
                          <strong>
                            {pending} change{pending === 1 ? ' hasn’t' : 's haven’t'} synced yet.
                          </strong>{' '}
                          The app will try to send {pending === 1 ? 'it' : 'them'} first.
                          {removeLocal && ' Anything that still can’t be sent will be lost.'}
                        </p>
                      )}
                      <p>
                        {removeLocal
                          ? 'Your data stays in your account but is removed from this device.'
                          : 'Your data stays on this device until someone signs in again.'}
                      </p>
                    </>
                  ),
                  confirmLabel: 'Sign out',
                  danger: pending > 0 && removeLocal,
                });
                if (ok) await run(() => sync.signOut({ removeLocalData: removeLocal }));
              }}
            >
              Sign out
            </button>
          </div>
        </div>
      </div>
      {statusNode}
    </Card>
  );
}
