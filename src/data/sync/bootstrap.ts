import type { FinanceStore } from '../repositories/types';
import { ensureInitialised } from '@/services/settingsService';
import type { SyncEngine } from './syncEngine';

/**
 * Prepares this device's copy of a signed-in user's data. On a device that has never synced, the
 * account's data is downloaded *before* defaults are created, so a new phone never overwrites your
 * settings or categories with the starter defaults. Throws (and creates nothing) if the first
 * download fails; the caller asks the user to retry when online.
 */
export async function prepareDevice(engine: SyncEngine, store: FinanceStore): Promise<void> {
  if (!(await engine.hasCompletedInitialPull())) {
    await engine.pull();
  }
  await ensureInitialised(store);
  await engine.refreshStatus();
}
