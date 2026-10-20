import Dexie from 'dexie';
import { FinanceDb } from '@/data/local-db/db';
import { createDexieStore } from '@/data/repositories/dexieStore';
import type { FinanceStore } from '@/data/repositories/types';
import { SETTINGS_ID } from '@/domain/models';
import { bucketTargets } from '@/domain/calculations/buckets';
import {
  addCategory,
  addSuggestedCategories,
  missingSuggestions,
  moveCategory,
  renameCategory,
  setCategoryArchived,
  setGroupTargets,
} from './categoriesService';
import { ensureInitialised } from './settingsService';

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

describe('categories', () => {
  it('adds, renames, moves and hides categories, keeping names unique within a group', async () => {
    const c = await addCategory(store, { name: 'Padel', bucket: 'wants' });
    expect(c).toMatchObject({ group: 'discretionary', kind: 'expense', workspace: 'both' });
    await expect(addCategory(store, { name: ' padel ', bucket: 'wants' })).rejects.toThrow(
      /already a category/,
    );
    await renameCategory(store, c.id, 'Padel & tennis');
    const moved = await moveCategory(store, c.id, 'needs');
    expect(moved).toMatchObject({ name: 'Padel & tennis', group: 'essential' });
    await expect(moveCategory(store, 'cat-salary', 'needs')).rejects.toThrow(/Only spending/);
    await setCategoryArchived(store, c.id, true);
    expect((await store.categories.get(c.id))?.archived).toBe(true);
  });

  it('new setups get the five-group categories; older ones can add them', async () => {
    expect(missingSuggestions(await store.categories.list())).toEqual([]);
    await store.categories.delete('cat-snacks');
    await store.categories.delete('cat-rf-stock');
    expect(missingSuggestions(await store.categories.list())).toEqual([
      'cat-snacks',
      'cat-rf-stock',
    ]);
    expect(await addSuggestedCategories(store)).toBe(2);
    expect(await store.categories.get('cat-rf-stock')).toMatchObject({
      group: 'business_expense',
      workspace: 'both',
    });
  });

  it('saves group goals only when they add up to 100%', async () => {
    await expect(
      setGroupTargets(store, { needs: 50, wants: 30, savings: 20, rf: 5, buffer: 5 }),
    ).rejects.toThrow(/add up to 110%/);
    await setGroupTargets(store, { needs: 45, wants: 25, savings: 20, rf: 5, buffer: 5 });
    const s = await store.settings.get(SETTINGS_ID);
    expect(bucketTargets(s!)).toEqual({ needs: 45, wants: 25, savings: 20, rf: 5, buffer: 5 });
  });
});
