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
}

export const SyncContext = createContext<SyncContextValue | null>(null);

/** Sync controls when signed in; null in local-only mode (no Supabase configured). */
export function useSync(): SyncContextValue | null {
  return useContext(SyncContext);
}
