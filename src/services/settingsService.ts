import { type AppSettings, type Category, SETTINGS_ID } from '@/domain/models';
import {
  GROUP_IDS,
  SUGGESTED_CATEGORY_IDS,
  defaultBudgetGroups,
  defaultGroupIdFor,
  defaultSettings,
  seedCategories,
} from '@/domain/defaults';
import type { FinanceStore } from '@/data/repositories/types';
import { type Clock, systemClock } from './common';

/**
 * Start-up initialisation. Idempotent and never overwrites user edits:
 * - first launch: settings, the default budget groups (Needs, Wants, Savings, Buffer) and the
 *   default categories;
 * - setups from before custom groups: groups created from their current goals, plus an "RF" group
 *   if they have RF categories; suggested categories this setup doesn't have yet;
 * - every start: categories without a group are linked to their default group (this also repairs
 *   links cleared by an older app version on another device).
 * Ids are fixed, so devices doing this independently converge without sync conflicts.
 */
export async function ensureInitialised(
  store: FinanceStore,
  clock: Clock = systemClock,
): Promise<AppSettings> {
  return store.atomic(async () => {
    const now = clock.now();
    const settings =
      (await store.settings.get(SETTINGS_ID)) ?? (await store.settings.put(defaultSettings(now)));
    const cats = await store.categories.list();
    let groups = await store.budgetGroups.list();

    if (cats.length === 0) {
      if (groups.length === 0) {
        groups = defaultBudgetGroups(now);
        await store.budgetGroups.bulkPut(groups);
      }
      const ids = new Set(groups.map((g) => g.id));
      await store.categories.bulkPut(
        seedCategories(now).map((c) =>
          c.budgetGroupId && !ids.has(c.budgetGroupId) ? { ...c, budgetGroupId: null } : c,
        ),
      );
      return settings;
    }

    if (groups.length === 0) {
      // Goals as they were (five fixed groups); RF only if this setup uses RF categories.
      const t = {
        needs: settings.needsPercent ?? 50,
        wants: settings.wantsPercent ?? 20,
        savings: settings.savingsRatePercent,
        rf: settings.sideBusinessPercent ?? 5,
        buffer: settings.bufferPercent ?? 5,
      };
      const hasRf = cats.some(
        (c) => !c.archived && c.group === 'business_expense' && c.workspace !== 'business',
      );
      groups = defaultBudgetGroups(now, {
        needs: t.needs,
        wants: t.wants,
        savings: t.savings,
        buffer: hasRf ? t.buffer : t.buffer + t.rf,
      });
      if (hasRf) {
        groups.push({
          id: GROUP_IDS.rf,
          name: 'RF',
          kind: 'spending',
          colour: 6,
          targetPercent: t.rf,
          sortOrder: 3,
          isDemo: false,
          createdAt: now,
          updatedAt: now,
        });
      }
      await store.budgetGroups.bulkPut(groups);
    }

    const groupIds = new Set(groups.map((g) => g.id));
    const linked = (c: Category): Category => {
      if (c.budgetGroupId && groupIds.has(c.budgetGroupId)) return c;
      const g = defaultGroupIdFor(c.group);
      const budgetGroupId = g && groupIds.has(g) ? g : null;
      return (c.budgetGroupId ?? null) === budgetGroupId
        ? c
        : { ...c, budgetGroupId, updatedAt: now };
    };
    const have = new Set(cats.map((c) => c.id));
    const suggested = new Set<string>(SUGGESTED_CATEGORY_IDS);
    const writes = [
      ...seedCategories(now)
        .filter((c) => suggested.has(c.id) && !have.has(c.id))
        .map(linked),
      ...cats.filter((c) => linked(c) !== c).map(linked),
    ];
    if (writes.length > 0) await store.categories.bulkPut(writes);
    return settings;
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
