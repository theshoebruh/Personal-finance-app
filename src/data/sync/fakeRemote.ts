import type { PullCursor, PulledRow, PushChange, PushResult, SyncRemote } from './remote';
import { SyncNetworkError, SyncRejectedError } from './remote';

interface StoredRow {
  table: string;
  id: string;
  revision: number;
  deleted: boolean;
  ts: string;
  record: Record<string, unknown>;
}

/**
 * In-memory stand-in for the Supabase sync functions, following the same rules as
 * supabase/migrations/*_sync_functions.sql: optimistic concurrency on `revision`, tombstones,
 * all-or-nothing batches and a keyset change feed. Used to test the engine without a server.
 */
export class FakeRemote implements SyncRemote {
  rows = new Map<string, StoredRow>();
  private clock = 0;
  /** Simulate an unreachable server. */
  offline = false;
  /** Apply the next push, then fail as if the response was lost. */
  dropNextPushResponse = false;
  /** Reject any batch containing these record ids (like a database constraint). */
  rejectIds = new Set<string>();
  pushCalls = 0;

  private nextTs(): string {
    this.clock++;
    return `2026-01-01T00:00:00.${String(this.clock).padStart(6, '0')}+00:00`;
  }

  private row(r: StoredRow): Record<string, unknown> & {
    id: string;
    revision: number;
    deleted: boolean;
    server_updated_at: string;
  } {
    return {
      ...r.record,
      id: r.id,
      revision: r.revision,
      deleted: r.deleted,
      server_updated_at: r.ts,
    };
  }

  async push(changes: PushChange[]): Promise<PushResult[]> {
    this.pushCalls++;
    if (this.offline) throw new SyncNetworkError('Failed to fetch');
    if (changes.some((c) => this.rejectIds.has(c.id))) {
      throw new SyncRejectedError('violates check constraint', '23514');
    }
    const staged = new Map(this.rows);
    const results: PushResult[] = [];
    for (const c of changes) {
      const key = `${c.table}:${c.id}`;
      const existing = staged.get(key);
      if (c.op === 'delete') {
        if (!existing || existing.deleted) {
          results.push({
            table: c.table,
            id: c.id,
            status: 'applied',
            revision: existing?.revision ?? null,
            record: existing ? this.row(existing) : null,
          });
        } else if (existing.revision === c.base_rev) {
          const next = {
            ...existing,
            deleted: true,
            revision: existing.revision + 1,
            ts: this.nextTs(),
          };
          staged.set(key, next);
          results.push({
            table: c.table,
            id: c.id,
            status: 'applied',
            revision: next.revision,
            record: this.row(next),
          });
        } else {
          results.push({
            table: c.table,
            id: c.id,
            status: 'conflict',
            revision: existing.revision,
            record: this.row(existing),
          });
        }
        continue;
      }
      if (!existing || existing.revision === c.base_rev) {
        const next: StoredRow = {
          table: c.table,
          id: c.id,
          deleted: false,
          revision: existing ? existing.revision + 1 : 1,
          ts: this.nextTs(),
          record: structuredClone(c.record ?? {}),
        };
        staged.set(key, next);
        results.push({
          table: c.table,
          id: c.id,
          status: 'applied',
          revision: next.revision,
          record: this.row(next),
        });
      } else {
        results.push({
          table: c.table,
          id: c.id,
          status: 'conflict',
          revision: existing.revision,
          record: this.row(existing),
        });
      }
    }
    this.rows = staged; // commit
    if (this.dropNextPushResponse) {
      this.dropNextPushResponse = false;
      throw new SyncNetworkError('Network connection lost');
    }
    return structuredClone(results);
  }

  async pull(cursor: PullCursor, limit: number, rewind: boolean): Promise<PulledRow[]> {
    if (this.offline) throw new SyncNetworkError('Failed to fetch');
    // Rewind is a no-op here: the fake commits instantly, so nothing can arrive late.
    const from = rewind ? { ts: cursor.ts, table: '', id: '' } : cursor;
    const cmp = (r: StoredRow) =>
      r.ts > from.ts ||
      (r.ts === from.ts && (r.table > from.table || (r.table === from.table && r.id > from.id)));
    return [...this.rows.values()]
      .filter(cmp)
      .sort((a, b) =>
        a.ts < b.ts
          ? -1
          : a.ts > b.ts
            ? 1
            : a.table < b.table
              ? -1
              : a.table > b.table
                ? 1
                : a.id < b.id
                  ? -1
                  : 1,
      )
      .slice(0, limit)
      .map((r) => structuredClone({ table: r.table, record: this.row(r) }) as PulledRow);
  }
}
