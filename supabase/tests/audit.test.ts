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

async function subscribed(channel: ReturnType<TestUser['client']['channel']>) {
  await new Promise<void>((resolve, reject) => {
    channel.subscribe((status, err) => {
      if (status === 'SUBSCRIBED') resolve();
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') reject(err ?? new Error(status));
    });
  });
}

/**
 * Realtime can report SUBSCRIBED a little before change delivery is live (longer right after the
 * local stack restarts), so keep writing a fresh change every 2 s until one is delivered.
 */
async function writeUntil(received: () => boolean, prefix: string, ms = 12_000) {
  const t0 = Date.now();
  let i = 0;
  while (!received() && Date.now() - t0 < ms) {
    await push(user.client, [upsert('transactions', txnRow(`${prefix}-${i++}`, 'acc-1'))]);
    const tick = Date.now();
    while (!received() && Date.now() - tick < 2000) await new Promise((r) => setTimeout(r, 100));
  }
  return received();
}

describe('Realtime notifications', () => {
  it('a table-specific, user-filtered subscription receives the user’s own changes only', async () => {
    let mine = false;
    let spied = false;
    await subscribed(
      user.client
        .channel(`audit-mine-${Date.now()}`)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'transactions', filter: `user_id=eq.${user.id}` },
          () => {
            mine = true;
          },
        ),
    );
    await subscribed(
      other.client
        .channel(`audit-spy-${Date.now()}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'transactions' }, () => {
          spied = true;
        }),
    );
    expect(await writeUntil(() => mine, 'rt-a')).toBe(true);
    await new Promise((r) => setTimeout(r, 1500));
    expect(spied).toBe(false);
  });

  // F-01 (fixed): the app's own subscription helper receives the user's changes.
  it('F-01: the app’s subscription receives changes made on another session', async () => {
    let got = false;
    const stop = subscribeToChanges(user.client, user.id, () => {
      got = true;
    });
    const ok = await writeUntil(() => got, 'rt-b');
    stop();
    expect(ok).toBe(true);
  });

  it('a deletion reaches the app’s subscription through the deletions log', async () => {
    await push(user.client, [upsert('transactions', txnRow('rt-del', 'acc-1'))]);
    let deletionSeen = false;
    const ch = user.client
      .channel(`audit-del-${Date.now()}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'deletions', filter: `user_id=eq.${user.id}` },
        () => {
          deletionSeen = true;
        },
      );
    await subscribed(ch);
    await new Promise((r) => setTimeout(r, 2000));
    await push(user.client, [{ table: 'transactions', id: 'rt-del', op: 'delete', base_rev: 1 }]);
    const t0 = Date.now();
    while (!deletionSeen && Date.now() - t0 < 8000) await new Promise((r) => setTimeout(r, 100));
    void user.client.removeChannel(ch);
    expect(deletionSeen).toBe(true);
  });
});

describe('deletion on the server', () => {
  // F-05 (fixed): a delete removes the row; only a content-free entry in `deletions` remains.
  it('F-05: a deleted transaction’s content is removed from the server', async () => {
    await push(user.client, [
      upsert(
        'transactions',
        txnRow('del-1', 'acc-1', { description: 'Private purchase', amount_cents: -12_345 }),
      ),
    ]);
    const res = await push(user.client, [
      { table: 'transactions', id: 'del-1', op: 'delete', base_rev: 1 },
    ]);
    expect(res[0]).toMatchObject({ status: 'applied', revision: 2 });
    expect(res[0]!.record).toEqual({
      id: 'del-1',
      revision: 2,
      deleted: true,
      server_updated_at: expect.any(String),
    });
    const { data: rows } = await user.client.from('transactions').select('*').eq('id', 'del-1');
    expect(rows).toEqual([]);
    const { data: log } = await user.client.from('deletions').select('*').eq('id', 'del-1');
    expect(log).toHaveLength(1);
    expect(Object.keys(log![0]!).sort()).toEqual(
      ['deleted_at', 'id', 'revision', 'server_updated_at', 'table_name', 'user_id'].sort(),
    );
    expect(JSON.stringify(log)).not.toContain('Private purchase');
  });
});
