import {
  BUCKET_GROUP,
  type Bucket,
  type Category,
  type SpendingBucket,
  categorySchema,
} from '@/domain/models';
import { SUGGESTED_CATEGORY_IDS, seedCategories } from '@/domain/defaults';
import type { FinanceStore } from '@/data/repositories/types';
import { type Clock, DomainError, newId, systemClock } from './common';
import { updateSettings } from './settingsService';

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

async function assertUniqueName(
  store: FinanceStore,
  name: string,
  group: Category['group'],
  exceptId?: string,
) {
  const clash = (await store.categories.list()).find(
    (c) => !c.archived && c.id !== exceptId && c.group === group && sameName(c.name, name),
  );
  if (clash)
    throw new DomainError(`There is already a category called “${clash.name}” in this group.`);
}

/** Add a spending category to a group (Needs, Wants, Savings or RF), or income category. */
export async function addCategory(
  store: FinanceStore,
  input: { name: string; bucket: SpendingBucket | 'income' },
  clock: Clock = systemClock,
): Promise<Category> {
  const group = input.bucket === 'income' ? 'income' : BUCKET_GROUP[input.bucket];
  const name = input.name.trim();
  if (!name) throw new DomainError('Enter a name.');
  await assertUniqueName(store, name, group);
  const now = clock.now();
  return store.categories.put(
    categorySchema.parse({
      id: newId(),
      name,
      kind: input.bucket === 'income' ? 'income' : 'expense',
      group,
      workspace: 'both',
      archived: false,
      isDemo: false,
      createdAt: now,
      updatedAt: now,
    }),
  );
}

export async function renameCategory(
  store: FinanceStore,
  id: string,
  name: string,
  clock: Clock = systemClock,
): Promise<Category> {
  const cat = await store.categories.get(id);
  if (!cat) throw new DomainError('Category not found');
  const trimmed = name.trim();
  if (!trimmed) throw new DomainError('Enter a name.');
  await assertUniqueName(store, trimmed, cat.group, id);
  return store.categories.put({ ...cat, name: trimmed, updatedAt: clock.now() });
}

/** Move a spending category to another group. Its transactions move with it. */
export async function moveCategory(
  store: FinanceStore,
  id: string,
  bucket: SpendingBucket,
  clock: Clock = systemClock,
): Promise<Category> {
  const cat = await store.categories.get(id);
  if (!cat) throw new DomainError('Category not found');
  if (cat.kind !== 'expense')
    throw new DomainError('Only spending categories can move between groups.');
  const group = BUCKET_GROUP[bucket];
  await assertUniqueName(store, cat.name, group, id);
  // Spending groups are personal-and-business usable once moved, so they fit any account.
  return store.categories.put({
    ...cat,
    group,
    workspace: cat.workspace === 'business' ? 'both' : cat.workspace,
    updatedAt: clock.now(),
  });
}

/** Hide (or show again) a category. Transactions keep it; it just isn't offered any more. */
export async function setCategoryArchived(
  store: FinanceStore,
  id: string,
  archived: boolean,
  clock: Clock = systemClock,
): Promise<void> {
  const cat = await store.categories.get(id);
  if (!cat) throw new DomainError('Category not found');
  await store.categories.put({ ...cat, archived, updatedAt: clock.now() });
}

/** Suggested categories (Gym, Snacks, Sports, RF…) that this device doesn't have yet. */
export function missingSuggestions(categories: readonly Category[]): string[] {
  const have = new Set(categories.map((c) => c.id));
  return SUGGESTED_CATEGORY_IDS.filter((id) => !have.has(id));
}

export async function addSuggestedCategories(
  store: FinanceStore,
  clock: Clock = systemClock,
): Promise<number> {
  const missing = new Set(missingSuggestions(await store.categories.list()));
  const toAdd = seedCategories(clock.now()).filter((c) => missing.has(c.id));
  if (toAdd.length > 0) await store.categories.bulkPut(toAdd);
  return toAdd.length;
}

/** Save the five group goals (% of income). They must add up to 100%. */
export async function setGroupTargets(
  store: FinanceStore,
  targets: Record<Bucket, number>,
  clock: Clock = systemClock,
): Promise<void> {
  for (const [bucket, value] of Object.entries(targets)) {
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      throw new DomainError(`The ${bucket} goal must be between 0% and 100%.`);
    }
  }
  const total = Math.round(Object.values(targets).reduce((s, v) => s + v, 0) * 100) / 100;
  if (total !== 100)
    throw new DomainError(`Goals add up to ${total}%; they need to add up to 100%.`);
  await updateSettings(
    store,
    {
      needsPercent: targets.needs,
      wantsPercent: targets.wants,
      savingsRatePercent: targets.savings,
      sideBusinessPercent: targets.rf,
      bufferPercent: targets.buffer,
    },
    clock,
  );
}
