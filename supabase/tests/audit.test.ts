/**
 * Audit tests against the local stack (2026-10-15). `it.fails` = confirmed problem still present;
 * flip to `it` once fixed. See docs/audit-2026-10-15.md.
 */
import { subscribeToChanges } from '@/data/sync/realtime';
import { accountRow, newUser, push, txnRow, upsert, type TestUser } from './helpers';

let user: TestUser;
let other: TestUser;

beforeAll(async () => {
  user = await newUser('audit');
  other = await newUser('audit-other');
  await push(user.client, [upsert('accounts', accountRow('acc-1'))]);
});

async function waitForEvent(subscribe: (onEvent: () => void) => Promise<void>) {
  let got = false;
  await subscribe(() => {
    got = true;
  });
  return {
    wait: async (ms = 6000) => {
      const t0 = Date.now();
      while (!got && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 200));
      return got;
    },
  };
}

async function subscribed(channel: ReturnType<TestUser['client']['channel']>) {
  await new Promise<void>((resolve, reject) => {
    channel.subscribe((status, err) => {
      if (status === 'SUBSCRIBED') resolve();
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') reject(err ?? new Error(status));
    });
  });
}

describe('Realtime notifications', () => {
  it('a table-specific, user-filtered subscription receives the user’s own changes only', async () => {
    const mine = await waitForEvent(async (on) => {
      const ch = user.client
        .channel(`audit-mine-${Date.now()}`)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'transactions', filter: `user_id=eq.${user.id}` },
          on,
        );
      await subscribed(ch);
    });
    const spy = await waitForEvent(async (on) => {
      const ch = other.client
        .channel(`audit-spy-${Date.now()}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'transactions' }, on);
      await subscribed(ch);
    });
    // Realtime reports SUBSCRIBED slightly before change delivery is live.
    await new Promise((r) => setTimeout(r, 1500));
    await push(user.client, [upsert('transactions', txnRow('rt-1', 'acc-1'))]);
    expect(await mine.wait()).toBe(true);
    expect(await spy.wait(2000)).toBe(false);
  });

  // F-01 (fixed): the app's own subscription helper receives the user's changes.
  it('F-01: the app’s subscription receives changes made on another session', async () => {
    let got = false;
    const stop = subscribeToChanges(user.client, user.id, () => {
      got = true;
    });
    await new Promise((r) => setTimeout(r, 1500)); // let the channel join
    await push(user.client, [upsert('transactions', txnRow('rt-2', 'acc-1'))]);
    const t0 = Date.now();
    while (!got && Date.now() - t0 < 6000) await new Promise((r) => setTimeout(r, 200));
    stop();
    expect(got).toBe(true);
  });
});

describe('deletion on the server', () => {
  // F-05: deletes are tombstones that keep every column. "Delete all data" therefore leaves the
  // financial content (descriptions, amounts, dates) stored in the account.
  it.fails('F-05: a deleted transaction’s content is removed from the server', async () => {
    await push(user.client, [
      upsert(
        'transactions',
        txnRow('del-1', 'acc-1', { description: 'Private purchase', amount_cents: -12_345 }),
      ),
    ]);
    await push(user.client, [{ table: 'transactions', id: 'del-1', op: 'delete', base_rev: 1 }]);
    const { data } = await user.client
      .from('transactions')
      .select('deleted, description, amount_cents')
      .eq('id', 'del-1')
      .single();
    expect(data?.deleted).toBe(true);
    expect(data?.description).not.toBe('Private purchase');
  });
});
