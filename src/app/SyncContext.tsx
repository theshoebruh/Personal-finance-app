import { createContext, useContext } from 'react';
import type { SyncEngine, SyncStatus } from '@/data/sync/syncEngine';

export interface SyncContextValue {
  engine: SyncEngine;
  status: SyncStatus;
  email: string;
  /** Pushes pending changes (best effort), signs out and optionally removes this device's copy. */
  signOut(options: { removeLocalData: boolean }): Promise<void>;
  /** Records saved on this device before signing in (the local-only database), if any. */
  localOnlyRecordCount: number;
  copyLocalOnlyData(): Promise<void>;
  discardLocalOnlyData(): Promise<void>;
  /** Calls a Supabase Edge Function as the signed-in user; throws FunctionCallError on failure. */
  callFunction(name: string, body: unknown): Promise<unknown>;
}

/** A failed Edge Function call: `status` is the HTTP status, or 0 when it never got an answer. */
export class FunctionCallError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
  ) {
    super(`Function call failed (${status}${code ? `, ${code}` : ''})`);
  }
}

export const SyncContext = createContext<SyncContextValue | null>(null);

/** Sync controls when signed in; null in local-only mode (no Supabase configured). */
export function useSync(): SyncContextValue | null {
  return useContext(SyncContext);
}
