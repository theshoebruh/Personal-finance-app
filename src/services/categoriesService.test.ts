import Dexie from 'dexie';
import { FinanceDb } from '@/data/local-db/db';
import { createDexieStore } from '@/data/repositories/dexieStore';
import type { FinanceStore } from '@/data/repositories/types';
import { SETTINGS_ID } from '@/domain/models';
import { GROUP_IDS, SUGGESTED_CATEGORY_IDS } from '@/domain/defaults';
import {
  addCategory,
  addGroup,
  addSuggestedCategories,
  deleteGroup,
  missingSuggestions,
  moveCategory,
  renameCategory,
  renameGroup,
  setCategoryArchived,
  setGroupTargets,
} from './categoriesService';
import { ensureInitialised, updateSettings } from './settingsService';

let n = 0;
let db: FinanceDb;
let store: FinanceStore;

beforeEach(async () => {
  db = new FinanceDb(`cats-${++n}`);
  store = createDexieStore(db);
  await ensureInitialised(store);
});
afterEach(async () => {
  db.close();
  await Dexie.delete(db.name);
});

const groupsById = async () => new Map((await store.budgetGroups.list()).map((g) => [g.id, g]));

describe('a new setup', () => {
  it('starts with Needs 50, Wants 30, Savings 15 and Buffer 5, and no RF', async () => {
    const groups = await store.budgetGroups.list();
    expect(groups.map((g) => [g.name, g.targetPercent]).sort()).toEqual(
      [
        ['Buffer', 5],
        ['Needs', 50],
        ['Savings', 15],
        ['Wants', 30],
      ].sort(),
    );
    const cats = await store.categories.list();
    expect(cats.some((c) => c.id.startsWith('cat-rf-'))).toBe(false);
    expect(cats.find((c) => c.id === 'cat-gym')?.budgetGroupId).toBe(GROUP_IDS.needs);
    expect(cats.find((c) => c.id === 'cat-from-savings')).toMatchObject({
      kind: 'income',
      budgetGroupId: GROUP_IDS.savings,
    });
    expect(missingSuggestions(cats)).toEqual([]);
  });
});

describe('a setup from before custom groups', () => {
  async function makeOld(withRf: boolean) {
    // As the five-group version left it: categories without a group link, no groups, and goals
    // in settings; RF categories only if this person used RF.
    await store.budgetGroups.bulkDelete((await store.budgetGroups.list()).map((g) => g.id));
    for (const id of SUGGESTED_CATEGORY_IDS) await store.categories.delete(id);
    const cats = await store.categories.list();
    await store.categories.bulkPut(cats.map(({ budgetGroupId: _drop, ...c }) => c));
    if (withRf) {
      await store.categories.put({
        id: 'cat-rf-stock',
        name: 'Stock & printing',
        kind: 'expense',
        group: 'business_expense',
        workspace: 'both',
        archived: false,
        isDemo: false,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      });
    }
    await updateSettings(store, { needsPercent: 50, wantsPercent: 20, savingsRatePercent: 20 });
  }

  it('keeps its goals and gets an RF group holding its RF categories', async () => {
    await makeOld(true);
    await ensureInitialised(store);
    const groups = await groupsById();
    expect([...groups.values()].map((g) => [g.name, g.targetPercent]).sort()).toEqual(
      [
        ['Buffer', 5],
        ['Needs', 50],
        ['RF', 5],
        ['Savings', 20],
        ['Wants', 20],
      ].sort(),
    );
    const cats = await store.categories.list();
    expect(cats.find((c) => c.id === 'cat-rf-stock')?.budgetGroupId).toBe(GROUP_IDS.rf);
    expect(cats.find((c) => c.id === 'cat-groceries')?.budgetGroupId).toBe(GROUP_IDS.needs);
    expect(cats.find((c) => c.id === 'cat-from-savings')?.budgetGroupId).toBe(GROUP_IDS.savings);
  });

  it('without RF categories, adds the RF share to Buffer so goals still add up', async () => {
    await makeOld(false);
    await ensureInitialised(store);
    const groups = await groupsById();
    expect(groups.has(GROUP_IDS.rf)).toBe(false);
    expect(groups.get(GROUP_IDS.buffer)?.targetPercent).toBe(10);
  });

  it('re-links a category whose link an older app version cleared', async () => {
    const gym = (await store.categories.get('cat-gym'))!;
    const { budgetGroupId: _drop, ...cleared } = gym;
    await store.categories.put(cleared);
    await ensureInitialised(store);
    expect((await store.categories.get('cat-gym'))?.budgetGroupId).toBe(GROUP_IDS.needs);
  });
});

describe('custom groups', () => {
  it('adds, renames and deletes a group, keeping goals adding up', async () => {
    const biz = await addGroup(store, { name: 'Business' });
    expect(biz).toMatchObject({ kind: 'spending', targetPercent: 0 });
    await expect(addGroup(store, { name: ' business ' })).rejects.toThrow(/already a group/);
    await renameGroup(store, biz.id, 'RF');
    await setGroupTargets(store, {
      [GROUP_IDS.needs]: 50,
      [GROUP_IDS.wants]: 25,
      [GROUP_IDS.savings]: 15,
      [biz.id]: 5,
      [GROUP_IDS.buffer]: 5,
    });
    const prints = await addCategory(store, { name: 'Prints', groupId: biz.id });
    await expect(deleteGroup(store, biz.id)).rejects.toThrow(/Move or hide RF’s 1 category/);
    await moveCategory(store, prints.id, GROUP_IDS.wants);
    await deleteGroup(store, biz.id);
    const groups = await groupsById();
    expect(groups.has(biz.id)).toBe(false);
    expect(groups.get(GROUP_IDS.buffer)?.targetPercent).toBe(10);
    await expect(deleteGroup(store, GROUP_IDS.buffer)).rejects.toThrow(/can’t be deleted/);
  });

  it('adds, renames, moves and hides categories; names unique within a group', async () => {
    const c = await addCategory(store, { name: 'Padel', groupId: GROUP_IDS.wants });
    expect(c).toMatchObject({ group: 'discretionary', budgetGroupId: GROUP_IDS.wants });
    await expect(addCategory(store, { name: ' padel ', groupId: GROUP_IDS.wants })).rejects.toThrow(
      /already a category/,
    );
    await renameCategory(store, c.id, 'Padel & tennis');
    expect(await moveCategory(store, c.id, GROUP_IDS.needs)).toMatchObject({
      group: 'essential',
      budgetGroupId: GROUP_IDS.needs,
    });
    await expect(moveCategory(store, 'cat-salary', GROUP_IDS.needs)).rejects.toThrow(
      /Only spending/,
    );
    await expect(moveCategory(store, c.id, GROUP_IDS.buffer)).rejects.toThrow(/left over/);
    await setCategoryArchived(store, c.id, true);
    expect((await store.categories.get(c.id))?.archived).toBe(true);
    const inc = await addCategory(store, { name: 'Tutoring', groupId: 'income' });
    expect(inc).toMatchObject({ kind: 'income', budgetGroupId: null });
  });

  it('saves goals only when they add up to 100%', async () => {
    const ids = [GROUP_IDS.needs, GROUP_IDS.wants, GROUP_IDS.savings, GROUP_IDS.buffer];
    await expect(
      setGroupTargets(store, Object.fromEntries(ids.map((id, i) => [id, [50, 40, 15, 5][i]!]))),
    ).rejects.toThrow(/add up to 110%/);
    await setGroupTargets(store, Object.fromEntries(ids.map((id, i) => [id, [45, 30, 20, 5][i]!])));
    expect((await groupsById()).get(GROUP_IDS.needs)?.targetPercent).toBe(45);
  });

  it('adds back a suggested category that this setup is missing', async () => {
    await store.categories.delete('cat-snacks');
    expect(await addSuggestedCategories(store)).toBe(1);
    expect((await store.categories.get('cat-snacks'))?.budgetGroupId).toBe(GROUP_IDS.wants);
  });

  it('settings goals are only used to set up groups for older setups', async () => {
    expect((await store.settings.get(SETTINGS_ID))?.needsPercent).toBeNull();
  });
});
