/** Migration 20261115090000_amount_goals: goal mode on settings, goal amounts on groups. */
import { fromRow, toRow } from '@/data/sync/rowMapping';
import { defaultBudgetGroups, defaultSettings } from '@/domain/defaults';
import { newUser, push, upsert, type TestUser } from './helpers';

let user: TestUser;
const TS = '2026-11-15T00:00:00.000Z';

beforeAll(async () => {
  user = await newUser('amount-goals');
});

const settingsRow = (
  extra: Record<string, unknown> = {},
): Record<string, unknown> & { id: string } => ({
  ...toRow('settings', defaultSettings(TS)),
  ...extra,
  id: 'app',
});
const needsRow = (
  extra: Record<string, unknown> = {},
): Record<string, unknown> & { id: string } => ({
  ...toRow('budgetGroups', defaultBudgetGroups(TS)[0]!),
  ...extra,
  id: 'grp-needs',
});

describe('amount goal columns', () => {
  it('an older app version that doesn’t send them can still save', async () => {
    const s = settingsRow();
    delete s.goal_mode;
    const g = needsRow();
    delete g.target_cents;
    const [rs, rg] = await push(user.client, [upsert('settings', s), upsert('budget_groups', g)]);
    expect(rs).toMatchObject({ status: 'applied', revision: 1 });
    expect(rs!.record!.goal_mode).toBeNull();
    expect(rg).toMatchObject({ status: 'applied', revision: 1 });
    expect(rg!.record!.target_cents).toBeNull();
  });

  it('stores the mode and amounts, and they read back into the app', async () => {
    const [rs, rg] = await push(user.client, [
      upsert('settings', settingsRow({ goal_mode: 'amount' }), 1),
      upsert('budget_groups', needsRow({ target_cents: 400_000 }), 1),
    ]);
    expect(rs!.record).toMatchObject({ goal_mode: 'amount' });
    expect(rg!.record).toMatchObject({ target_cents: 400_000 });
    expect(fromRow('settings', rs!.record!)).toMatchObject({ goalMode: 'amount' });
    expect(fromRow('budgetGroups', rg!.record!)).toMatchObject({ targetCents: 400_000 });
  });

  it('rejects an unknown mode or a negative amount', async () => {
    await expect(
      push(user.client, [upsert('settings', settingsRow({ goal_mode: 'weekly' }), 2)]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      push(user.client, [upsert('budget_groups', needsRow({ target_cents: -1 }), 2)]),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
