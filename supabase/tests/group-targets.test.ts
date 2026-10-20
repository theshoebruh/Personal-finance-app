/** Migration 20261020090000_group_targets: optional goal columns on settings. */
import { toRow } from '@/data/sync/rowMapping';
import { defaultSettings } from '@/domain/defaults';
import { newUser, push, upsert, type TestUser } from './helpers';

let user: TestUser;
const NEW_COLUMNS = ['needs_percent', 'wants_percent', 'side_business_percent', 'buffer_percent'];

beforeAll(async () => {
  user = await newUser('targets');
});

function settingsRow(
  extra: Record<string, unknown> = {},
): Record<string, unknown> & { id: string } {
  return { ...toRow('settings', defaultSettings('2026-10-20T00:00:00.000Z')), ...extra, id: 'app' };
}

describe('group goal columns', () => {
  it('an older app version that doesn’t send them can still save settings', async () => {
    const row = settingsRow();
    for (const c of NEW_COLUMNS) delete row[c];
    const [res] = await push(user.client, [upsert('settings', row)]);
    expect(res).toMatchObject({ status: 'applied', revision: 1 });
    for (const c of NEW_COLUMNS) expect(res!.record![c]).toBeNull();
  });

  it('stores goals and returns them as numbers', async () => {
    const [res] = await push(user.client, [
      upsert(
        'settings',
        settingsRow({ needs_percent: 45, wants_percent: 22.5, buffer_percent: 7.5 }),
        1,
      ),
    ]);
    expect(res).toMatchObject({ status: 'applied', revision: 2 });
    expect(res!.record).toMatchObject({
      needs_percent: 45,
      wants_percent: 22.5,
      buffer_percent: 7.5,
    });
  });

  it('rejects a goal outside 0–100%', async () => {
    await expect(
      push(user.client, [upsert('settings', settingsRow({ needs_percent: 150 }), 2)]),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
