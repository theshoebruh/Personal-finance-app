import {
  type BudgetGroup,
  type Category,
  MAX_BUDGET_GROUPS,
  budgetGroupSchema,
  categorySchema,
} from '@/domain/models';
import { GROUP_IDS, SUGGESTED_CATEGORY_IDS, seedCategories } from '@/domain/defaults';
import type { FinanceStore } from '@/data/repositories/types';
import { type Clock, DomainError, newId, systemClock } from './common';

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * The built-in category kind that goes with a group (used by features that look at essentials):
 * Needs → essential, Wants → discretionary, Savings → savings, custom groups keep a business kind
 * if the category had one, otherwise discretionary.
 */
function categoryGroupFor(groupId: string, current?: Category['group']): Category['group'] {
  if (groupId === GROUP_IDS.needs) return 'essential';
  if (groupId === GROUP_IDS.wants) return 'discretionary';
  if (groupId === GROUP_IDS.savings) return 'savings';
  return current === 'business_expense' ? 'business_expense' : 'discretionary';
}

async function requireSpendingGroup(store: FinanceStore, groupId: string): Promise<BudgetGroup> {
  const g = await store.budgetGroups.get(groupId);
  if (!g) throw new DomainError('Group not found');
  if (g.kind !== 'spending') {
    throw new DomainError(`${g.name} is what’s left over, so it has no categories.`);
  }
  return g;
}

async function assertUniqueName(
  store: FinanceStore,
  name: string,
  where: { budgetGroupId: string | null; kind: Category['kind'] },
  exceptId?: string,
) {
  const clash = (await store.categories.list()).find(
    (c) =>
      !c.archived &&
      c.id !== exceptId &&
      c.kind === where.kind &&
      (c.budgetGroupId ?? null) === where.budgetGroupId &&
      sameName(c.name, name),
  );
  if (clash) {
    throw new DomainError(`There is already a category called “${clash.name}” in this group.`);
  }
}

// ---------------------------------------------------------------- Categories

/** Add a spending category to a group, or an income category (`groupId: 'income'`). */
export async function addCategory(
  store: FinanceStore,
  input: { name: string; groupId: string },
  clock: Clock = systemClock,
): Promise<Category> {
  const name = input.name.trim();
  if (!name) throw new DomainError('Enter a name.');
  const isIncome = input.groupId === 'income';
  if (!isIncome) await requireSpendingGroup(store, input.groupId);
  const budgetGroupId = isIncome ? null : input.groupId;
  await assertUniqueName(store, name, { budgetGroupId, kind: isIncome ? 'income' : 'expense' });
  const now = clock.now();
  return store.categories.put(
    categorySchema.parse({
      id: newId(),
      name,
      kind: isIncome ? 'income' : 'expense',
      group: isIncome ? 'income' : categoryGroupFor(input.groupId),
      workspace: 'both',
      budgetGroupId,
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
  await assertUniqueName(
    store,
    trimmed,
    { budgetGroupId: cat.budgetGroupId ?? null, kind: cat.kind },
    id,
  );
  return store.categories.put({ ...cat, name: trimmed, updatedAt: clock.now() });
}

/** Move a spending category to another group. Its transactions move with it. */
export async function moveCategory(
  store: FinanceStore,
  id: string,
  groupId: string,
  clock: Clock = systemClock,
): Promise<Category> {
  const cat = await store.categories.get(id);
  if (!cat) throw new DomainError('Category not found');
  if (cat.kind !== 'expense') {
    throw new DomainError('Only spending categories can move between groups.');
  }
  await requireSpendingGroup(store, groupId);
  await assertUniqueName(store, cat.name, { budgetGroupId: groupId, kind: 'expense' }, id);
  return store.categories.put({
    ...cat,
    budgetGroupId: groupId,
    group: categoryGroupFor(groupId, cat.group),
    // Usable on any account once it's in one of your groups.
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

/** Suggested categories (Gym, Snacks, Transfer from savings…) that this setup doesn't have yet. */
export function missingSuggestions(categories: readonly Category[]): string[] {
  const have = new Set(categories.map((c) => c.id));
  return SUGGESTED_CATEGORY_IDS.filter((id) => !have.has(id));
}

export async function addSuggestedCategories(
  store: FinanceStore,
  clock: Clock = systemClock,
): Promise<number> {
  const missing = new Set(missingSuggestions(await store.categories.list()));
  const groupIds = new Set((await store.budgetGroups.list()).map((g) => g.id));
  const toAdd = seedCategories(clock.now())
    .filter((c) => missing.has(c.id))
    .map((c) =>
      c.budgetGroupId && !groupIds.has(c.budgetGroupId) ? { ...c, budgetGroupId: null } : c,
    );
  if (toAdd.length > 0) await store.categories.bulkPut(toAdd);
  return toAdd.length;
}

// ---------------------------------------------------------------- Groups

/** Colours for new groups, in order; the built-in groups use 1, 2, 3 and 5. */
const NEW_GROUP_COLOURS = [6, 4, 1, 2, 3, 5] as const;

/** Add a spending group (e.g. "RF" or "Car"). It starts at 0%: adjust the goals to include it. */
export async function addGroup(
  store: FinanceStore,
  input: { name: string },
  clock: Clock = systemClock,
): Promise<BudgetGroup> {
  const name = input.name.trim();
  if (!name) throw new DomainError('Enter a name.');
  const groups = await store.budgetGroups.list();
  if (groups.length >= MAX_BUDGET_GROUPS) {
    throw new DomainError(`You can have up to ${MAX_BUDGET_GROUPS} groups.`);
  }
  const clash = groups.find((g) => sameName(g.name, name));
  if (clash) throw new DomainError(`There is already a group called “${clash.name}”.`);
  const used = new Set(groups.map((g) => g.colour));
  const colour = NEW_GROUP_COLOURS.find((c) => !used.has(c)) ?? NEW_GROUP_COLOURS[0];
  const spendingOrders = groups.filter((g) => g.kind === 'spending').map((g) => g.sortOrder);
  const now = clock.now();
  return store.budgetGroups.put(
    budgetGroupSchema.parse({
      id: newId(),
      name,
      kind: 'spending',
      colour,
      targetPercent: 0,
      sortOrder: Math.min(899, Math.max(-1, ...spendingOrders) + 1),
      isDemo: false,
      createdAt: now,
      updatedAt: now,
    }),
  );
}

export async function renameGroup(
  store: FinanceStore,
  id: string,
  name: string,
  clock: Clock = systemClock,
): Promise<BudgetGroup> {
  const g = await store.budgetGroups.get(id);
  if (!g) throw new DomainError('Group not found');
  const trimmed = name.trim();
  if (!trimmed) throw new DomainError('Enter a name.');
  const clash = (await store.budgetGroups.list()).find(
    (o) => o.id !== id && sameName(o.name, trimmed),
  );
  if (clash) throw new DomainError(`There is already a group called “${clash.name}”.`);
  return store.budgetGroups.put({ ...g, name: trimmed, updatedAt: clock.now() });
}

/**
 * Delete an empty spending group. Its goal % moves to the leftover group (Buffer) so the goals
 * still add up. Hidden categories that pointed at it are unlinked.
 */
export async function deleteGroup(
  store: FinanceStore,
  id: string,
  clock: Clock = systemClock,
): Promise<void> {
  const g = await store.budgetGroups.get(id);
  if (!g) throw new DomainError('Group not found');
  if (g.kind !== 'spending') throw new DomainError(`${g.name} can’t be deleted.`);
  const cats = (await store.categories.list()).filter((c) => c.budgetGroupId === id);
  const live = cats.filter((c) => !c.archived);
  if (live.length > 0) {
    throw new DomainError(
      `Move or hide ${g.name}’s ${live.length} categor${live.length === 1 ? 'y' : 'ies'} first.`,
    );
  }
  const now = clock.now();
  const leftover = (await store.budgetGroups.list()).find((o) => o.kind === 'leftover');
  await store.atomic(async () => {
    if (cats.length > 0) {
      await store.categories.bulkPut(
        cats.map((c) => ({ ...c, budgetGroupId: null, updatedAt: now })),
      );
    }
    if (leftover && g.targetPercent > 0) {
      await store.budgetGroups.put({
        ...leftover,
        targetPercent: Math.min(100, leftover.targetPercent + g.targetPercent),
        updatedAt: now,
      });
    }
    await store.budgetGroups.delete(id);
  });
}

/** Save every group's goal (% of income). They must add up to 100%. */
export async function setGroupTargets(
  store: FinanceStore,
  targets: Record<string, number>,
  clock: Clock = systemClock,
): Promise<void> {
  const groups = await store.budgetGroups.list();
  for (const g of groups) {
    const v = targets[g.id];
    if (v === undefined || !Number.isFinite(v) || v < 0 || v > 100) {
      throw new DomainError(`The ${g.name} goal must be between 0% and 100%.`);
    }
  }
  const total = Math.round(groups.reduce((s, g) => s + targets[g.id]!, 0) * 100) / 100;
  if (total !== 100)
    throw new DomainError(`Goals add up to ${total}%; they need to add up to 100%.`);
  const now = clock.now();
  await store.budgetGroups.bulkPut(
    groups
      .filter((g) => g.targetPercent !== targets[g.id])
      .map((g) => ({ ...g, targetPercent: targets[g.id]!, updatedAt: now })),
  );
}
