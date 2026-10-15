import type { ConflictEntry, FinanceDb, OutboxEntry } from '../local-db/db';
import type { FinanceStore } from '../repositories/types';
import {
  REMOTE_TABLES,
  RemoteRecordError,
  type SyncedTable,
  fromRow,
  localTableFor,
  sameContent,
  toRow,
} from './rowMapping';
import {
  type PullCursor,
  type PushChange,
  type PushResult,
  START_CURSOR,
  SyncAuthError,
  SyncNetworkError,
  SyncRejectedError,
  type SyncRemote,
} from './remote';
import { outboxKey } from './trackedStore';

export type SyncState = 'idle' | 'syncing' | 'offline' | 'error' | 'signed_out';

export interface SyncStatus {
  state: SyncState;
  lastSyncedAt: string | null;
  /** Local changes not yet on the server. */
  pending: number;
  /** Changes the server rejected; they need the record to be edited or removed. */
  failed: number;
  conflicts: number;
  error: string | null;
}

export interface SyncReport {
  pushed: number;
  pulled: number;
  conflicts: number;
  failed: number;
}

const BATCH_LIMIT = 400;
const PULL_PAGE = 500;
const BACKOFF_MS = [5_000, 15_000, 60_000, 300_000];

/**
 * Two-way sync between this device's IndexedDB and the server.
 *
 * Push: sends queued local changes with the server revision this device last saw. Applied changes
 * leave the queue; conflicts keep the server version locally and store this device's version in
 * the conflicts list for the user to decide. If the server rejects a batch, changes are retried
 * in small groups so one bad record can't block the rest.
 *
 * Pull: reads the server's change feed after a saved cursor and applies rows idempotently
 * (skipping revisions already seen). Records with unsent local edits are never overwritten.
 */
export class SyncEngine {
  private status: SyncStatus = {
    state: 'idle',
    lastSyncedAt: null,
    pending: 0,
    failed: 0,
    conflicts: 0,
    error: null,
  };
  private listeners = new Set<(s: SyncStatus) => void>();
  private running: Promise<SyncReport> | null = null;
  private again = false;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private backoffStep = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(
    private readonly db: FinanceDb,
    private readonly remote: SyncRemote,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  // ------------------------------------------------------------------ status

  getStatus(): SyncStatus {
    return this.status;
  }

  subscribe(listener: (s: SyncStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.status);
    return () => this.listeners.delete(listener);
  }

  private async setStatus(patch: Partial<SyncStatus>): Promise<void> {
    const [outbox, conflicts] = await Promise.all([
      this.db.outbox.toArray(),
      this.db.conflicts.count(),
    ]);
    this.status = {
      ...this.status,
      ...patch,
      pending: outbox.filter((e) => !e.failedReason).length,
      failed: outbox.filter((e) => e.failedReason).length,
      conflicts,
    };
    for (const l of this.listeners) l(this.status);
  }

  async refreshStatus(): Promise<void> {
    const last = (await this.db.syncState.get('lastSyncedAt'))?.value as string | undefined;
    await this.setStatus({ lastSyncedAt: last ?? this.status.lastSyncedAt });
  }

  // ------------------------------------------------------------------ scheduling

  /** Debounced sync after local edits. */
  notifyLocalChange(delayMs = 1500): void {
    if (this.stopped) return;
    void this.setStatus({});
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => void this.syncNow().catch(() => undefined), delayMs);
  }

  /** Starts background syncing: periodic, on focus and when the network returns. */
  start(intervalMs = 60_000): void {
    this.stopped = false;
    const run = () => void this.syncNow().catch(() => undefined);
    const interval = setInterval(run, intervalMs);
    this.timers.push(interval as unknown as ReturnType<typeof setTimeout>);
    if (typeof window !== 'undefined') {
      window.addEventListener('online', run);
      window.addEventListener('offline', this.onOffline);
      document.addEventListener('visibilitychange', this.onVisible);
    }
    run();
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t as unknown as number);
    this.timers = [];
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (typeof window !== 'undefined') {
      window.removeEventListener('offline', this.onOffline);
      document.removeEventListener('visibilitychange', this.onVisible);
    }
  }

  private onOffline = () => void this.setStatus({ state: 'offline', error: null });
  private onVisible = () => {
    if (document.visibilityState === 'visible') void this.syncNow().catch(() => undefined);
  };

  private scheduleRetry(): void {
    if (this.stopped) return;
    const delay = BACKOFF_MS[Math.min(this.backoffStep, BACKOFF_MS.length - 1)]!;
    this.backoffStep++;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => void this.syncNow().catch(() => undefined), delay);
  }

  // ------------------------------------------------------------------ sync

  /** Push then pull. Concurrent calls share one run (and trigger one follow-up run). */
  syncNow(): Promise<SyncReport> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.runOnce().finally(() => {
      this.running = null;
      if (this.again && !this.stopped) {
        this.again = false;
        void this.syncNow().catch(() => undefined);
      }
    });
    return this.running;
  }

  private async runOnce(): Promise<SyncReport> {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      await this.setStatus({ state: 'offline', error: null });
      throw new SyncNetworkError(
        'You are offline. Changes are saved on this device and will sync later.',
      );
    }
    await this.setStatus({ state: 'syncing', error: null });
    try {
      const pushed = await this.push();
      const pulled = await this.pull();
      const at = this.now();
      await this.db.syncState.put({ key: 'lastSyncedAt', value: at });
      this.backoffStep = 0;
      await this.setStatus({ state: 'idle', lastSyncedAt: at, error: null });
      return { pushed: pushed.applied, pulled, conflicts: pushed.conflicts, failed: pushed.failed };
    } catch (e) {
      if (e instanceof SyncAuthError) {
        await this.setStatus({
          state: 'signed_out',
          error: 'Your session has expired. Sign in again to sync.',
        });
      } else if (e instanceof SyncNetworkError) {
        await this.setStatus({
          state: 'offline',
          error: 'Can’t reach the sync server. Changes are saved on this device.',
        });
        this.scheduleRetry();
      } else {
        await this.setStatus({ state: 'error', error: e instanceof Error ? e.message : String(e) });
        this.scheduleRetry();
      }
      throw e;
    }
  }

  // ------------------------------------------------------------------ push

  private async buildChange(entry: OutboxEntry): Promise<PushChange> {
    const table = entry.table as SyncedTable;
    const meta = await this.db.syncMeta.get(entry.key);
    const base = meta?.rev ?? null;
    if (entry.op === 'upsert') {
      const record = await this.db.table(table).get(entry.id);
      if (record) {
        return {
          table: REMOTE_TABLES[table],
          id: entry.id,
          op: 'upsert',
          base_rev: base,
          record: toRow(table, record),
        };
      }
    }
    return { table: REMOTE_TABLES[table], id: entry.id, op: 'delete', base_rev: base };
  }

  /** Groups entries so both legs of a transfer always travel together. */
  private async groupEntries(entries: OutboxEntry[]): Promise<OutboxEntry[][]> {
    const groups = new Map<string, OutboxEntry[]>();
    for (const e of entries) {
      let groupKey = e.key;
      if (e.table === 'transactions') {
        const t = (await this.db.transactions.get(e.id)) as { transferId?: string } | undefined;
        if (t?.transferId) groupKey = `transfer:${t.transferId}`;
      }
      const g = groups.get(groupKey) ?? [];
      g.push(e);
      groups.set(groupKey, g);
    }
    return [...groups.values()];
  }

  private async push(): Promise<{ applied: number; conflicts: number; failed: number }> {
    const totals = { applied: 0, conflicts: 0, failed: 0 };
    const entries = (await this.db.outbox.orderBy('queuedAt').toArray()).filter(
      (e) => !e.failedReason,
    );
    if (entries.length === 0) return totals;
    const groups = await this.groupEntries(entries);
    // Pack whole groups into batches.
    const batches: OutboxEntry[][] = [];
    let current: OutboxEntry[] = [];
    for (const g of groups) {
      if (current.length > 0 && current.length + g.length > BATCH_LIMIT) {
        batches.push(current);
        current = [];
      }
      current.push(...g);
    }
    if (current.length) batches.push(current);

    for (const batch of batches) {
      await this.pushBatch(batch, totals, true);
    }
    return totals;
  }

  private async pushBatch(
    batch: OutboxEntry[],
    totals: { applied: number; conflicts: number; failed: number },
    canSplit: boolean,
  ): Promise<void> {
    const changes = await Promise.all(batch.map((e) => this.buildChange(e)));
    let results: PushResult[];
    try {
      results = await this.remote.push(changes);
    } catch (e) {
      if (!(e instanceof SyncRejectedError)) throw e;
      if (canSplit && batch.length > 1) {
        // Isolate the record(s) the server rejected; the rest still sync.
        for (const g of await this.groupEntries(batch)) await this.pushBatch(g, totals, false);
        return;
      }
      const reason = e.message.slice(0, 300);
      await this.db.outbox.bulkPut(
        batch.map((b) => ({ ...b, attempts: b.attempts + 1, failedReason: reason })),
      );
      totals.failed += batch.length;
      return;
    }
    for (const [i, result] of results.entries()) {
      const entry = batch[i]!;
      if (result.status === 'applied') {
        await this.markApplied(entry, result);
        totals.applied++;
      } else {
        const conflicted = await this.handleConflict(entry, result);
        if (conflicted) totals.conflicts++;
        else totals.applied++;
      }
    }
  }

  /** Records the new server revision and removes the queue entry, unless it changed meanwhile. */
  private async markApplied(entry: OutboxEntry, result: PushResult): Promise<void> {
    await this.db.transaction('rw', [this.db.outbox, this.db.syncMeta], async () => {
      if (result.revision !== null) {
        await this.db.syncMeta.put({
          key: entry.key,
          rev: result.revision,
          deleted: Boolean(result.record?.deleted),
        });
      }
      const latest = await this.db.outbox.get(entry.key);
      if (latest && latest.queuedAt === entry.queuedAt) await this.db.outbox.delete(entry.key);
    });
  }

  /**
   * The server copy changed since this device last saw it. Identical content is resolved silently;
   * otherwise the server version is applied and this device's version is kept as a conflict.
   * Returns true when a real conflict was recorded.
   */
  private async handleConflict(entry: OutboxEntry, result: PushResult): Promise<boolean> {
    const table = entry.table as SyncedTable;
    const remoteRow = result.record;
    const remoteDeleted = !remoteRow || Boolean(remoteRow.deleted);
    let remote: Record<string, unknown> | null = null;
    if (!remoteDeleted) {
      try {
        remote = fromRow<Record<string, unknown>>(table, remoteRow!);
      } catch (e) {
        if (!(e instanceof RemoteRecordError)) throw e;
        remote = null;
      }
    }
    let real = false;
    await this.db.transaction(
      'rw',
      [this.db.table(table), this.db.outbox, this.db.syncMeta, this.db.conflicts],
      async () => {
        const latest = await this.db.outbox.get(entry.key);
        if (!latest || latest.queuedAt !== entry.queuedAt) {
          // Edited again during the push: just learn the server revision and retry next time.
          await this.db.syncMeta.put({
            key: entry.key,
            rev: result.revision ?? 0,
            deleted: remoteDeleted,
          });
          return;
        }
        const local =
          ((await this.db.table(table).get(entry.id)) as Record<string, unknown> | undefined) ??
          null;
        const localValue = entry.op === 'delete' ? null : local;
        const same = remoteDeleted ? localValue === null : sameContent(table, localValue, remote);
        if (!same) {
          real = true;
          const conflict: ConflictEntry = {
            key: entry.key,
            table,
            id: entry.id,
            local: localValue,
            remote,
            remoteRev: result.revision ?? 0,
            detectedAt: this.now(),
          };
          await this.db.conflicts.put(conflict);
        }
        if (remote) await this.db.table(table).put(remote);
        else await this.db.table(table).delete(entry.id);
        await this.db.syncMeta.put({
          key: entry.key,
          rev: result.revision ?? 0,
          deleted: remoteDeleted,
        });
        await this.db.outbox.delete(entry.key);
      },
    );
    return real;
  }

  // ------------------------------------------------------------------ pull

  /** Applies server changes since the saved cursor. Returns how many rows changed locally. */
  async pull(): Promise<number> {
    let cursor =
      ((await this.db.syncState.get('cursor'))?.value as PullCursor | undefined) ?? START_CURSOR;
    let rewind = cursor.ts !== START_CURSOR.ts;
    let changed = 0;
    for (;;) {
      const rows = await this.remote.pull(cursor, PULL_PAGE, rewind);
      rewind = false;
      if (rows.length === 0) break;
      changed += await this.applyPulled(rows);
      const last = rows[rows.length - 1]!;
      cursor = { ts: last.record.server_updated_at, table: last.table, id: last.record.id };
      await this.db.syncState.put({ key: 'cursor', value: cursor });
      if (rows.length < PULL_PAGE) break;
    }
    await this.db.syncState.put({ key: 'initialPullDone', value: true });
    return changed;
  }

  private async applyPulled(rows: Awaited<ReturnType<SyncRemote['pull']>>): Promise<number> {
    let changed = 0;
    const tables = [
      ...new Set(rows.map((r) => localTableFor(r.table)).filter((t): t is SyncedTable => !!t)),
    ];
    await this.db.transaction(
      'rw',
      [...tables.map((t) => this.db.table(t)), this.db.outbox, this.db.syncMeta],
      async () => {
        for (const row of rows) {
          const table = localTableFor(row.table);
          if (!table) continue;
          const key = outboxKey(table, row.record.id);
          // Never overwrite a local change that hasn't been sent yet; its push will resolve it.
          if (await this.db.outbox.get(key)) continue;
          const meta = await this.db.syncMeta.get(key);
          if (meta && meta.rev >= row.record.revision) continue;
          if (row.record.deleted) {
            await this.db.table(table).delete(row.record.id);
          } else {
            try {
              await this.db.table(table).put(fromRow(table, row.record));
            } catch (e) {
              if (e instanceof RemoteRecordError) {
                console.warn(e.message);
                continue;
              }
              throw e;
            }
          }
          await this.db.syncMeta.put({
            key,
            rev: row.record.revision,
            deleted: row.record.deleted,
          });
          changed++;
        }
      },
    );
    return changed;
  }

  async hasCompletedInitialPull(): Promise<boolean> {
    return Boolean((await this.db.syncState.get('initialPullDone'))?.value);
  }

  // ------------------------------------------------------------------ conflicts

  async listConflicts(): Promise<ConflictEntry[]> {
    return this.db.conflicts.orderBy('detectedAt').toArray();
  }

  /**
   * keep_remote: accept the synced version (already applied). keep_local: write this device's
   * version again through the tracked store, so it syncs as a normal edit on top of the server's.
   */
  async resolveConflict(
    key: string,
    choice: 'keep_local' | 'keep_remote',
    store: FinanceStore,
  ): Promise<void> {
    const conflict = await this.db.conflicts.get(key);
    if (!conflict) return;
    if (choice === 'keep_local') {
      const table = conflict.table as SyncedTable;
      const repo = store[table] as unknown as {
        put(e: unknown): Promise<unknown>;
        delete(id: string): Promise<void>;
      };
      if (conflict.local) await repo.put({ ...conflict.local, updatedAt: this.now() });
      else await repo.delete(conflict.id);
    }
    await this.db.conflicts.delete(key);
    await this.setStatus({});
    if (choice === 'keep_local') this.notifyLocalChange(0);
  }

  /** Clears a rejected change so the record can sync again after it is fixed. */
  async retryFailed(): Promise<void> {
    const failed = (await this.db.outbox.toArray()).filter((e) => e.failedReason);
    await this.db.outbox.bulkPut(failed.map(({ failedReason: _r, ...e }) => e));
    await this.setStatus({});
    this.notifyLocalChange(0);
  }

  async failedChanges(): Promise<OutboxEntry[]> {
    return (await this.db.outbox.toArray()).filter((e) => e.failedReason);
  }
}
