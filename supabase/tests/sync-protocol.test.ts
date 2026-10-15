import { accountRow, newUser, push, txnRow, upsert, type TestUser } from './helpers';

let user: TestUser;

beforeAll(async () => {
  user = await newUser('protocol');
  await push(user.client, [
    upsert('accounts', accountRow('acc-1')),
    upsert('accounts', accountRow('acc-2')),
  ]);
});

describe('sync_push concurrency rules', () => {
  it('applies an update only against the current revision, otherwise reports a conflict', async () => {
    const created = await push(user.client, [upsert('transactions', txnRow('t1', 'acc-1'))]);
    expect(created[0]).toMatchObject({ status: 'applied', revision: 1 });

    const edited = await push(user.client, [
      upsert('transactions', txnRow('t1', 'acc-1', { description: 'Edited on PC' }), 1),
    ]);
    expect(edited[0]).toMatchObject({ status: 'applied', revision: 2 });

    // A device that still thinks the revision is 1 must not overwrite the newer edit.
    const stale = await push(user.client, [
      upsert('transactions', txnRow('t1', 'acc-1', { description: 'Edited on phone' }), 1),
    ]);
    expect(stale[0]).toMatchObject({ status: 'conflict', revision: 2 });
    expect(stale[0]!.record).toMatchObject({ description: 'Edited on PC' });

    // Creating a record that already exists without having seen it is also a conflict.
    const blind = await push(user.client, [upsert('transactions', txnRow('t1', 'acc-1'), null)]);
    expect(blind[0]!.status).toBe('conflict');
  });

  it('turns deletes into tombstones that sync_pull returns', async () => {
    await push(user.client, [upsert('transactions', txnRow('t-del', 'acc-1'))]);
    const conflict = await push(user.client, [
      { table: 'transactions', id: 't-del', op: 'delete', base_rev: 99 },
    ]);
    expect(conflict[0]!.status).toBe('conflict');
    const del = await push(user.client, [
      { table: 'transactions', id: 't-del', op: 'delete', base_rev: 1 },
    ]);
    expect(del[0]).toMatchObject({ status: 'applied', revision: 2 });
    expect(del[0]!.record).toMatchObject({ deleted: true });
    const again = await push(user.client, [
      { table: 'transactions', id: 't-del', op: 'delete', base_rev: 1 },
    ]);
    expect(again[0]!.status).toBe('applied'); // deleting twice is harmless
    const missing = await push(user.client, [
      { table: 'transactions', id: 'never-existed', op: 'delete', base_rev: null },
    ]);
    expect(missing[0]!.status).toBe('applied');

    const { data } = await user.client.rpc('sync_pull', { p_limit: 1000 });
    const tomb = (data as { table: string; record: { id: string; deleted: boolean } }[]).find(
      (r) => r.record.id === 't-del',
    );
    expect(tomb?.record.deleted).toBe(true);
  });

  it('enforces the same money rules as the app', async () => {
    const wrongSign = await user.client.rpc('sync_push', {
      p_changes: [
        upsert('transactions', txnRow('bad-sign', 'acc-1', { type: 'expense', amount_cents: 500 })),
      ],
    });
    expect(wrongSign.error?.code).toBe('23514');
    const zero = await user.client.rpc('sync_push', {
      p_changes: [upsert('transactions', txnRow('zero', 'acc-1', { amount_cents: 0 }))],
    });
    expect(zero.error?.code).toBe('23514');
    const wrongType = await user.client.rpc('sync_push', {
      p_changes: [upsert('transactions', txnRow('bad-type', 'acc-1', { amount_cents: '12.5' }))],
    });
    expect(wrongType.error).not.toBeNull();
  });

  it('keeps transfers to one balanced pair', async () => {
    const leg = (id: string, account: string, amount: number) =>
      upsert(
        'transactions',
        txnRow(id, account, {
          type: 'transfer',
          transfer_id: 'tr-1',
          transfer_kind: 'internal',
          amount_cents: amount,
        }),
      );
    const ok = await push(user.client, [
      leg('tr-1-out', 'acc-1', -50_000),
      leg('tr-1-in', 'acc-2', 50_000),
    ]);
    expect(ok.map((r) => r.status)).toEqual(['applied', 'applied']);

    const third = await user.client.rpc('sync_push', {
      p_changes: [leg('tr-1-dup', 'acc-2', 50_000)],
    });
    expect(third.error?.code).toBe('23514');

    const unbalanced = await user.client.rpc('sync_push', {
      p_changes: [
        upsert(
          'transactions',
          txnRow('tr-2-out', 'acc-1', {
            type: 'transfer',
            transfer_id: 'tr-2',
            transfer_kind: 'internal',
            amount_cents: -100,
          }),
        ),
        upsert(
          'transactions',
          txnRow('tr-2-in', 'acc-2', {
            type: 'transfer',
            transfer_id: 'tr-2',
            transfer_kind: 'internal',
            amount_cents: 90,
          }),
        ),
      ],
    });
    expect(unbalanced.error?.code).toBe('23514');
    // The failed batch left nothing behind.
    const { data } = await user.client.from('transactions').select('id').eq('transfer_id', 'tr-2');
    expect(data).toEqual([]);
  });

  it('accepts a batch in any order thanks to deferred foreign keys', async () => {
    const res = await push(user.client, [
      upsert('transactions', txnRow('t-before-acc', 'acc-late')),
      upsert('accounts', accountRow('acc-late')),
    ]);
    expect(res.map((r) => r.status)).toEqual(['applied', 'applied']);
  });

  it('rejects unknown tables and oversized batches', async () => {
    const bad = await user.client.rpc('sync_push', {
      p_changes: [{ table: 'auth.users', id: 'x', op: 'upsert', base_rev: null, record: {} }],
    });
    expect(bad.error?.message).toMatch(/Unknown table/);
    const many = Array.from({ length: 501 }, (_, i) => upsert('accounts', accountRow(`bulk-${i}`)));
    const big = await user.client.rpc('sync_push', { p_changes: many });
    expect(big.error?.message).toMatch(/500/);
  });
});

describe('sync_pull paging', () => {
  it('pages with a keyset cursor without skipping or repeating rows', async () => {
    const fresh = await newUser('paging');
    await push(
      fresh.client,
      Array.from({ length: 25 }, (_, i) =>
        upsert('accounts', accountRow(`p-${String(i).padStart(2, '0')}`)),
      ),
    );
    const seen: string[] = [];
    let cursor = { p_since: '-infinity', p_since_table: '', p_since_id: '' };
    for (;;) {
      const { data, error } = await fresh.client.rpc('sync_pull', { ...cursor, p_limit: 7 });
      expect(error).toBeNull();
      const rows = data as { table: string; record: { id: string; server_updated_at: string } }[];
      if (rows.length === 0) break;
      seen.push(...rows.map((r) => r.record.id));
      const last = rows[rows.length - 1]!;
      cursor = {
        p_since: last.record.server_updated_at,
        p_since_table: last.table,
        p_since_id: last.record.id,
      };
    }
    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);
  });
});

describe('hard deletes and the deletions log (F-05)', () => {
  it('re-creating a deleted id needs the deletion revision and continues from it', async () => {
    const u = await newUser('recreate');
    await push(u.client, [upsert('accounts', accountRow('acc-r'))]);
    await push(u.client, [upsert('transactions', txnRow('re-1', 'acc-r'))]);
    const del = await push(u.client, [
      { table: 'transactions', id: 're-1', op: 'delete', base_rev: 1 },
    ]);
    expect(del[0]).toMatchObject({ status: 'applied', revision: 2 });

    // A device that never saw the deletion can't silently bring the record back.
    const blind = await push(u.client, [upsert('transactions', txnRow('re-1', 'acc-r'), 1)]);
    expect(blind[0]).toMatchObject({ status: 'conflict', revision: 2 });
    expect(blind[0]!.record).toMatchObject({ id: 're-1', deleted: true });

    // A device that saw it (base_rev 2) can; the new row continues at revision 3.
    const back = await push(u.client, [
      upsert('transactions', txnRow('re-1', 'acc-r', { description: 'Back again' }), 2),
    ]);
    expect(back[0]).toMatchObject({ status: 'applied', revision: 3 });
    const { data: log } = await u.client.from('deletions').select('id').eq('id', 're-1');
    expect(log).toEqual([]); // the deletion entry is cleared once the record exists again

    const { data } = await u.client.rpc('sync_pull', { p_limit: 1000 });
    const rows = (
      data as { table: string; record: { id: string; revision: number; deleted: boolean } }[]
    ).filter((r) => r.record.id === 're-1');
    expect(rows).toEqual([
      { table: 'transactions', record: expect.objectContaining({ revision: 3, deleted: false }) },
    ]);
  });

  it('refuses to delete a record that live records still depend on', async () => {
    const u = await newUser('orphan');
    await push(u.client, [upsert('accounts', accountRow('acc-o'))]);
    await push(u.client, [upsert('transactions', txnRow('o-1', 'acc-o'))]);
    const res = await u.client.rpc('sync_push', {
      p_changes: [{ table: 'accounts', id: 'acc-o', op: 'delete', base_rev: 1 }],
    });
    expect(res.error?.code).toBe('23503');
    const { data } = await u.client.from('accounts').select('id').eq('id', 'acc-o');
    expect(data).toHaveLength(1); // nothing was deleted
    // Deleting the dependant and the account together works.
    const both = await push(u.client, [
      { table: 'transactions', id: 'o-1', op: 'delete', base_rev: 1 },
      { table: 'accounts', id: 'acc-o', op: 'delete', base_rev: 1 },
    ]);
    expect(both.map((r) => r.status)).toEqual(['applied', 'applied']);
  });
});
