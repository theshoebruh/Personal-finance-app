import { accountRow, anonClient, newUser, push, txnRow, upsert, type TestUser } from './helpers';

const TABLES = [
  'accounts',
  'categories',
  'import_batches',
  'transactions',
  'budgets',
  'goals',
  'goal_contributions',
  'recurring_rules',
  'import_profiles',
  'categorisation_rules',
  'projects',
  'invoices',
  'settings',
  'deletions',
];

let alice: TestUser;
let bob: TestUser;

beforeAll(async () => {
  alice = await newUser('alice');
  bob = await newUser('bob');
  const res = await push(alice.client, [
    upsert('accounts', accountRow('acc-a')),
    upsert('transactions', txnRow('txn-a', 'acc-a')),
  ]);
  expect(res.map((r) => r.status)).toEqual(['applied', 'applied']);
});

describe('anonymous visitors', () => {
  it.each(TABLES)('cannot read %s', async (table) => {
    const { data, error } = await anonClient().from(table).select('*').limit(1);
    expect(data ?? []).toEqual([]);
    expect(error?.code).toBe('42501'); // permission denied
  });

  it('cannot write or call the sync functions', async () => {
    const anon = anonClient();
    const ins = await anon.from('accounts').insert(accountRow('anon-acc'));
    expect(ins.error?.code).toBe('42501');
    const rpc = await anon.rpc('sync_push', { p_changes: [] });
    expect(rpc.error).not.toBeNull();
    const pull = await anon.rpc('sync_pull', {});
    expect(pull.error).not.toBeNull();
  });
});

describe('row-level security between two users', () => {
  it('lets the owner read their rows', async () => {
    const { data } = await alice.client.from('transactions').select('id, user_id');
    expect(data).toEqual([{ id: 'txn-a', user_id: alice.id }]);
  });

  it.each(TABLES)('hides other users’ %s rows', async (table) => {
    const { data, error } = await bob.client.from(table).select('id');
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it('does not let another user update or delete the owner’s rows', async () => {
    const upd = await bob.client
      .from('accounts')
      .update({ name: 'Hacked' })
      .eq('user_id', alice.id)
      .eq('id', 'acc-a')
      .select();
    expect(upd.data ?? []).toEqual([]);
    const del = await bob.client.from('transactions').delete().eq('id', 'txn-a').select();
    expect(del.data ?? []).toEqual([]);
    const { data } = await alice.client.from('accounts').select('name').eq('id', 'acc-a').single();
    expect(data?.name).toBe('Account acc-a');
    expect((await alice.client.from('transactions').select('id')).data).toHaveLength(1);
  });

  it('rejects inserting rows on someone else’s behalf', async () => {
    const res = await bob.client
      .from('accounts')
      .insert({ ...accountRow('forged'), user_id: alice.id });
    expect(res.error?.code).toBe('42501'); // new row violates row-level security policy
  });

  it('ignores a forged user_id in sync_push and stores the row under the caller', async () => {
    const res = await push(bob.client, [
      upsert('accounts', { ...accountRow('acc-a'), user_id: alice.id, name: 'Bob’s' }),
    ]);
    expect(res[0]).toMatchObject({ status: 'applied', revision: 1 });
    expect(res[0]!.record).toMatchObject({ user_id: bob.id, name: 'Bob’s' });
    const { data } = await alice.client
      .from('accounts')
      .select('name, revision')
      .eq('id', 'acc-a')
      .single();
    expect(data).toEqual({ name: 'Account acc-a', revision: 1 });
  });

  it('cannot link to another user’s account (scoped foreign keys)', async () => {
    const res = await bob.client.rpc('sync_push', {
      p_changes: [upsert('transactions', txnRow('bob-txn', 'acc-only-alice-has'))],
    });
    expect(res.error?.code).toBe('23503'); // foreign key violation at commit
  });

  it('only returns the caller’s rows from sync_pull', async () => {
    const { data, error } = await bob.client.rpc('sync_pull', { p_limit: 1000 });
    expect(error).toBeNull();
    const rows = data as { table: string; record: { user_id: string } }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.record.user_id === bob.id)).toBe(true);
  });

  it('cannot move a row to another owner', async () => {
    const res = await alice.client.from('accounts').update({ user_id: bob.id }).eq('id', 'acc-a');
    expect(res.error).not.toBeNull();
  });
});
