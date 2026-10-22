/** Migration 20261022090000_budget_groups: custom groups and the category → group link. */
import { newUser, push, upsert, type TestUser } from './helpers';

const TS = '2026-01-01T00:00:00.000Z';
let user: TestUser;
let other: TestUser;

beforeAll(async () => {
  user = await newUser('groups');
  other = await newUser('groups-other');
});

const groupRow = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: `Group ${id}`,
  kind: 'spending',
  colour: 6,
  target_percent: 5,
  sort_order: 3,
  is_demo: false,
  created_at: TS,
  updated_at: TS,
  ...extra,
});
const categoryRow = (id: string, groupId: string | null) => ({
  id,
  name: `Category ${id}`,
  kind: 'expense',
  group: 'discretionary',
  workspace: 'both',
  archived: false,
  budget_group_id: groupId,
  is_demo: false,
  created_at: TS,
  updated_at: TS,
});

describe('budget groups', () => {
  it('stores a group and a category in it, synced with revisions', async () => {
    const res = await push(user.client, [
      upsert('budget_groups', groupRow('grp-biz')),
      upsert('categories', categoryRow('cat-prints', 'grp-biz')),
    ]);
    expect(res.map((r) => r.status)).toEqual(['applied', 'applied']);
    expect(res[0]!.record).toMatchObject({ name: 'Group grp-biz', target_percent: 5 });
    expect(res[1]!.record).toMatchObject({ budget_group_id: 'grp-biz' });
  });

  it('rejects a category that points at a group that does not exist (or is someone else’s)', async () => {
    await push(other.client, [upsert('budget_groups', groupRow('grp-theirs'))]);
    await expect(
      push(user.client, [upsert('categories', categoryRow('cat-bad', 'grp-theirs'))]),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('rejects invalid groups', async () => {
    await expect(
      push(user.client, [upsert('budget_groups', groupRow('grp-x', { target_percent: 150 }))]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      push(user.client, [upsert('budget_groups', groupRow('grp-y', { kind: 'savings' }))]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('deleting a group leaves only a content-free entry, so other devices learn of it', async () => {
    await push(user.client, [upsert('budget_groups', groupRow('grp-tmp'))]);
    const [res] = await push(user.client, [
      { table: 'budget_groups', id: 'grp-tmp', op: 'delete', base_rev: 1 },
    ]);
    expect(res).toMatchObject({ status: 'applied', record: { deleted: true } });
    const { data: rows } = await user.client.from('budget_groups').select('*').eq('id', 'grp-tmp');
    expect(rows).toEqual([]);
    const { data: log } = await user.client
      .from('deletions')
      .select('table_name')
      .eq('id', 'grp-tmp');
    expect(log).toEqual([{ table_name: 'budget_groups' }]);
  });

  it('other users can’t see your groups', async () => {
    const { data } = await other.client.from('budget_groups').select('id');
    expect((data ?? []).map((r) => r.id)).not.toContain('grp-biz');
  });
});
