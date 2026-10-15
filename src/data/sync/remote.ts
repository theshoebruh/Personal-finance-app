import type { SupabaseClient } from '@supabase/supabase-js';
import type { RemoteTable } from './rowMapping';

export interface PushChange {
  table: RemoteTable;
  id: string;
  op: 'upsert' | 'delete';
  base_rev: number | null;
  record?: Record<string, unknown>;
}

export interface PushResult {
  table: RemoteTable;
  id: string;
  status: 'applied' | 'conflict';
  revision: number | null;
  /** The server's row after the change (applied) or as it stands (conflict); includes `deleted`. */
  record: Record<string, unknown> | null;
}

export interface PulledRow {
  table: RemoteTable;
  record: Record<string, unknown> & {
    id: string;
    revision: number;
    deleted: boolean;
    server_updated_at: string;
  };
}

/** Keyset position in the server's change feed. Timestamps are kept as the server's exact string. */
export interface PullCursor {
  ts: string;
  table: string;
  id: string;
}

export const START_CURSOR: PullCursor = { ts: '-infinity', table: '', id: '' };

/** The network couldn't be reached (offline, DNS, timeout): retry later, nothing was decided. */
export class SyncNetworkError extends Error {
  name = 'SyncNetworkError';
}

/** The session is missing or expired: the user must sign in again. */
export class SyncAuthError extends Error {
  name = 'SyncAuthError';
}

/** The server rejected the request (e.g. a constraint). Retrying the same data will fail again. */
export class SyncRejectedError extends Error {
  name = 'SyncRejectedError';
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

export interface SyncRemote {
  push(changes: PushChange[]): Promise<PushResult[]>;
  pull(cursor: PullCursor, limit: number, rewind: boolean): Promise<PulledRow[]>;
}

function classify(error: { message: string; code?: string; status?: number } | Error): Error {
  const e = error as { message: string; code?: string; status?: number; name?: string };
  const msg = e.message ?? String(error);
  if (
    /Failed to fetch|NetworkError|network|fetch failed|ECONNREFUSED|timed? ?out|Load failed/i.test(
      msg,
    ) &&
    !e.code
  ) {
    return new SyncNetworkError(msg);
  }
  if (
    e.code === 'PGRST301' ||
    e.code === '28000' ||
    // Signed out: the request runs as the anonymous role, which may not call the sync functions.
    (e.code === '42501' && /sync_(push|pull)/.test(msg)) ||
    e.status === 401 ||
    /JWT|not signed in|Sign in to sync/i.test(msg)
  ) {
    return new SyncAuthError(msg);
  }
  return new SyncRejectedError(msg, e.code);
}

/** Talks to the Supabase sync functions as the signed-in user. */
export function createSupabaseRemote(client: SupabaseClient): SyncRemote {
  return {
    async push(changes) {
      let res;
      try {
        res = await client.rpc('sync_push', { p_changes: changes });
      } catch (e) {
        throw classify(e as Error);
      }
      if (res.error) throw classify(res.error);
      return res.data as PushResult[];
    },
    async pull(cursor, limit, rewind) {
      let res;
      try {
        res = await client.rpc('sync_pull', {
          p_since: cursor.ts,
          p_since_table: cursor.table,
          p_since_id: cursor.id,
          p_limit: limit,
          p_rewind: rewind,
        });
      } catch (e) {
        throw classify(e as Error);
      }
      if (res.error) throw classify(res.error);
      return res.data as PulledRow[];
    },
  };
}
