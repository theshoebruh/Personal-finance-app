import { type AppSettings, SETTINGS_ID } from '@/domain/models';
import { defaultSettings, seedCategories } from '@/domain/defaults';
import type { FinanceStore } from '@/data/repositories/types';
import { type Clock, systemClock } from './common';

/**
 * First-launch initialisation. Idempotent: seeds settings and the default category set only when
 * missing, and never overwrites user edits.
 */
export async function ensureInitialised(
  store: FinanceStore,
  clock: Clock = systemClock,
): Promise<AppSettings> {
  return store.atomic(async () => {
    const now = clock.now();
    const existingCats = new Set((await store.categories.list()).map((c) => c.id));
    const missing = seedCategories(now).filter((c) => !existingCats.has(c.id));
    if (missing.length > 0 && existingCats.size === 0) await store.categories.bulkPut(missing);
    const settings = await store.settings.get(SETTINGS_ID);
    if (settings) return settings;
    return store.settings.put(defaultSettings(now));
  });
}

export async function getSettings(store: FinanceStore): Promise<AppSettings> {
  const s = await store.settings.get(SETTINGS_ID);
  return s ?? ensureInitialised(store);
}

export async function updateSettings(
  store: FinanceStore,
  patch: Partial<Omit<AppSettings, 'id' | 'createdAt' | 'updatedAt'>>,
  clock: Clock = systemClock,
): Promise<AppSettings> {
  const current = await getSettings(store);
  return store.settings.put({ ...current, ...patch, updatedAt: clock.now() });
}
