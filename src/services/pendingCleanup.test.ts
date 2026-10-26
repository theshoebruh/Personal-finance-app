import Dexie from 'dexie';
import { FinanceDb } from '@/data/local-db/db';
import { createDexieStore } from '@/data/repositories/dexieStore';
import type { FinanceStore } from '@/data/repositories/types';
import { makeTxn } from '@/test/factories';
import {
  KEEP_SEPARATE_TAG,
  SETTLED_PENDING_TAG,
  archiveSettledPendings,
  findSettledPendings,
} from './pendingCleanup';

// Made-up purchases shaped like a pending card charge and its posted version two days later.
const pendingOld = makeTxn({
  accountId: 'main',
  amountCents: -14_900,
  date: '2026-03-21',
  description: '(Pending) Chat Service Subscription Somewhere (Card 1111)',
});
const posted = makeTxn({
  accountId: 'main',
  amountCents: -14_900,
  date: '2026-03-23',
  description: 'Recurring Card Purchase: Chat Service Subscription Somewhere (Card 1111)',
});

describe('finding pending purchases that have gone through', () => {
  it('pairs a pending transaction with its posted version', () => {
    expect(findSettledPendings([pendingOld, posted])).toEqual([{ pending: pendingOld, posted }]);
    const statusPending = {
      ...pendingOld,
      description: 'Chat Service',
      status: 'pending' as const,
    };
    expect(
      findSettledPendings([statusPending, { ...posted, description: 'Chat Service Subscr' }]),
    ).toHaveLength(1);
  });

  it('leaves different purchases alone', () => {
    const cases = [
      { ...posted, amountCents: -15_000 }, // different amount
      { ...posted, accountId: 'other' }, // different account
      { ...posted, date: '2026-04-15' }, // too long after
      { ...posted, date: '2026-03-19' }, // before the pending one
      { ...posted, description: 'Petrol station (Card 1111)' }, // different merchant
      { ...posted, tags: [KEEP_SEPARATE_TAG] }, // you said it's a different transaction
      { ...posted, archived: true },
    ];
    for (const c of cases) expect(findSettledPendings([pendingOld, c])).toEqual([]);
  });

  it('settles each pending transaction with at most one posted one', () => {
    const second = { ...pendingOld, id: 'second' };
    expect(findSettledPendings([pendingOld, second, posted])).toHaveLength(1);
  });
});

describe('archiving them', () => {
  let db: FinanceDb;
  let store: FinanceStore;
  beforeEach(() => {
    db = new FinanceDb(`pending-cleanup-${Math.random()}`);
    store = createDexieStore(db);
  });
  afterEach(async () => {
    db.close();
    await Dexie.delete(db.name);
  });

  it('archives the pending one (never deletes) with a note, once', async () => {
    await store.transactions.bulkPut([pendingOld, posted]);
    expect(await archiveSettledPendings(store)).toBe(1);
    const p = (await store.transactions.get(pendingOld.id))!;
    expect(p).toMatchObject({ archived: true, tags: [SETTLED_PENDING_TAG] });
    expect(p.notes).toMatch(
      /went through on 23 Mar 2026 as “Recurring Card Purchase: Chat Service/,
    );
    expect((await store.transactions.get(posted.id))?.archived).toBe(false);
    expect(await archiveSettledPendings(store)).toBe(0);
  });
});
