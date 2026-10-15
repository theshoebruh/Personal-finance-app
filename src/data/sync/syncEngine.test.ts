import Dexie from 'dexie';
import { FinanceDb } from '../local-db/db';
import type { FinanceStore } from '../repositories/types';
import { accountBalance } from '@/domain/calculations/balances';
import { summariseIncomeExpenses } from '@/domain/calculations/reporting';
import { createAccount } from '@/services/accountsService';
import {
  createTransaction,
  createTransfer,
  updateTransaction,
} from '@/services/transactionsService';
import { deleteAllData, exportBackup, restoreBackup } from '@/services/backupService';
import { getSettings, updateSettings } from '@/services/settingsService';
import { FakeRemote } from './fakeRemote';
import { SyncEngine } from './syncEngine';
import { createTrackedStore } from './trackedStore';
import { prepareDevice } from './bootstrap';

let n = 0;
interface Device {
  db: FinanceDb;
  store: FinanceStore;
  engine: SyncEngine;
}

const opened: FinanceDb[] = [];

async function device(remote: FakeRemote, bootstrap = true): Promise<Device> {
  const db = new FinanceDb(`sync-device-${++n}`);
  opened.push(db);
  const store = createTrackedStore(db);
  const engine = new SyncEngine(db, remote);
  if (bootstrap) await prepareDevice(engine, store);
  return { db, store, engine };
}

afterEach(async () => {
  for (const db of opened.splice(0)) {
    db.close();
    await Dexie.delete(db.name);
  }
});

const ACC = {
  name: 'Capitec main',
  type: 'current' as const,
  workspace: 'personal' as const,
  openingBalanceCents: 100_000,
  openingBalanceDate: '2026-03-01',
  includeInSpendable: true,
};

describe('change tracking', () => {
  it('queues every write in the outbox and collapses repeated edits', async () => {
    const pc = await device(new FakeRemote(), false);
    const acc = await createAccount(pc.store, ACC);
    const t = await createTransaction(pc.store, {
      accountId: acc.id,
      date: '2026-03-02',
      description: 'Coffee',
      amountCents: 3_500,
      type: 'expense',
      categoryId: null,
    });
    await updateTransaction(pc.store, t.id, { amountCents: 4_000 });
    const keys = (await pc.db.outbox.toArray()).map((e) => `${e.key}:${e.op}`).sort();
    expect(keys).toEqual([`accounts:${acc.id}:upsert`, `transactions:${t.id}:upsert`]);
  });
});

describe('two devices', () => {
  it('shows changes made on one device on the other', async () => {
    const remote = new FakeRemote();
    const pc = await device(remote);
    const phone = await device(remote);

    const acc = await createAccount(pc.store, ACC);
    await createTransaction(pc.store, {
      accountId: acc.id,
      date: '2026-03-02',
      description: 'Groceries',
      amountCents: 45_000,
      type: 'expense',
      categoryId: 'cat-groceries',
    });
    await pc.engine.syncNow();
    await phone.engine.syncNow();

    const phoneAcc = await phone.db.accounts.get(acc.id);
    expect(phoneAcc?.name).toBe('Capitec main');
    expect(accountBalance(phoneAcc!, await phone.db.transactions.toArray())).toBe(55_000);
    expect(await phone.db.outbox.count()).toBe(0);
  });

  it('syncs edits and deletions back the other way', async () => {
    const remote = new FakeRemote();
    const pc = await device(remote);
    const phone = await device(remote);
    const acc = await createAccount(pc.store, ACC);
    const t = await createTransaction(pc.store, {
      accountId: acc.id,
      date: '2026-03-02',
      description: 'Lunch',
      amountCents: 12_000,
      type: 'expense',
      categoryId: null,
    });
    await pc.engine.syncNow();
    await phone.engine.syncNow();

    await updateTransaction(phone.store, t.id, { description: 'Lunch with client' });
    await phone.engine.syncNow();
    await pc.engine.syncNow();
    expect((await pc.db.transactions.get(t.id))?.description).toBe('Lunch with client');

    await pc.store.transactions.delete(t.id);
    await pc.engine.syncNow();
    await phone.engine.syncNow();
    expect(await phone.db.transactions.get(t.id)).toBeUndefined();
  });

  it('keeps both versions when the same record is edited on both devices', async () => {
    const remote = new FakeRemote();
    const pc = await device(remote);
    const phone = await device(remote);
    const acc = await createAccount(pc.store, ACC);
    const t = await createTransaction(pc.store, {
      accountId: acc.id,
      date: '2026-03-02',
      description: 'Fuel',
      amountCents: 60_000,
      type: 'expense',
      categoryId: null,
    });
    await pc.engine.syncNow();
    await phone.engine.syncNow();

    // Both edit offline.
    await updateTransaction(pc.store, t.id, { amountCents: 65_000 });
    await updateTransaction(phone.store, t.id, { amountCents: 62_000 });
    await pc.engine.syncNow();
    const report = await phone.engine.syncNow();

    expect(report.conflicts).toBe(1);
    // The synced (PC) version is applied, never silently replaced by the phone's.
    expect((await phone.db.transactions.get(t.id))?.amountCents).toBe(-65_000);
    const [conflict] = await phone.engine.listConflicts();
    expect(conflict?.local).toMatchObject({ amountCents: -62_000 });
    expect(conflict?.remote).toMatchObject({ amountCents: -65_000 });
    expect(phone.engine.getStatus().conflicts).toBe(1);

    // The user keeps the phone's version; it becomes the synced version everywhere.
    await phone.engine.resolveConflict(conflict!.key, 'keep_local', phone.store);
    await phone.engine.syncNow();
    await pc.engine.syncNow();
    expect((await pc.db.transactions.get(t.id))?.amountCents).toBe(-62_000);
    expect(await phone.engine.listConflicts()).toEqual([]);
  });

  it('resolves identical concurrent edits without bothering the user', async () => {
    const remote = new FakeRemote();
    const pc = await device(remote);
    const phone = await device(remote);
    await pc.engine.syncNow();
    await phone.engine.syncNow();
    await updateSettings(pc.store, { savingsRatePercent: 15 });
    await updateSettings(phone.store, { savingsRatePercent: 15 });
    await pc.engine.syncNow();
    const report = await phone.engine.syncNow();
    expect(report.conflicts).toBe(0);
    expect(await phone.engine.listConflicts()).toEqual([]);
  });

  it('never overwrites an unsent local edit during a pull', async () => {
    const remote = new FakeRemote();
    const pc = await device(remote);
    const phone = await device(remote);
    const acc = await createAccount(pc.store, ACC);
    await pc.engine.syncNow();
    await phone.engine.syncNow();
    await pc.store.accounts.put({ ...(await pc.db.accounts.get(acc.id))!, name: 'From PC' });
    await pc.engine.syncNow();
    await phone.store.accounts.put({
      ...(await phone.db.accounts.get(acc.id))!,
      name: 'From phone (unsent)',
    });
    await phone.engine.pull();
    expect((await phone.db.accounts.get(acc.id))?.name).toBe('From phone (unsent)');
  });
});

describe('failures and retries', () => {
  it('keeps changes queued while offline and sends them later', async () => {
    const remote = new FakeRemote();
    const pc = await device(remote);
    await pc.engine.syncNow(); // first sync sends the starter categories and settings
    await createAccount(pc.store, ACC);
    remote.offline = true;
    await expect(pc.engine.syncNow()).rejects.toThrow();
    expect(pc.engine.getStatus().state).toBe('offline');
    expect(await pc.db.outbox.count()).toBe(1);
    pc.engine.stop(); // cancel the scheduled retry
    remote.offline = false;
    await pc.engine.syncNow();
    expect(await pc.db.outbox.count()).toBe(0);
    expect(pc.engine.getStatus().state).toBe('idle');
  });

  it('does not duplicate anything when a response is lost after the server saved it', async () => {
    const remote = new FakeRemote();
    const pc = await device(remote);
    const acc = await createAccount(pc.store, ACC);
    await createTransaction(pc.store, {
      accountId: acc.id,
      date: '2026-03-02',
      description: 'Rent',
      amountCents: 450_000,
      type: 'expense',
      categoryId: null,
    });
    remote.dropNextPushResponse = true;
    await expect(pc.engine.syncNow()).rejects.toThrow();
    pc.engine.stop();
    const report = await pc.engine.syncNow(); // retry sends the same changes again
    expect(report.conflicts).toBe(0);
    expect(await pc.engine.listConflicts()).toEqual([]);
    expect([...remote.rows.values()].filter((r) => r.table === 'transactions')).toHaveLength(1);
  });

  it('isolates a change the server rejects so the rest still sync', async () => {
    const remote = new FakeRemote();
    const pc = await device(remote);
    const good = await createAccount(pc.store, ACC);
    const bad = await createAccount(pc.store, { ...ACC, name: 'Rejected' });
    remote.rejectIds.add(bad.id);
    const report = await pc.engine.syncNow();
    expect(report.failed).toBe(1);
    expect(remote.rows.has(`accounts:${good.id}`)).toBe(true);
    const failed = await pc.engine.failedChanges();
    expect(failed.map((f) => f.id)).toEqual([bad.id]);
    expect(pc.engine.getStatus().failed).toBe(1);

    remote.rejectIds.clear();
    await pc.engine.retryFailed();
    pc.engine.stop();
    await pc.engine.syncNow();
    expect(remote.rows.has(`accounts:${bad.id}`)).toBe(true);
  });
});

describe('financial integrity across devices', () => {
  it('sends both transfer legs together and never double-counts them', async () => {
    const remote = new FakeRemote();
    const pc = await device(remote);
    const phone = await device(remote);
    const main = await createAccount(pc.store, ACC);
    const savings = await createAccount(pc.store, {
      ...ACC,
      name: 'Savings',
      type: 'savings',
      includeInSpendable: false,
      openingBalanceCents: 0,
    });
    await createTransfer(pc.store, {
      fromAccountId: main.id,
      toAccountId: savings.id,
      date: '2026-03-05',
      amountCents: 216_000,
    });
    remote.dropNextPushResponse = true;
    await expect(pc.engine.syncNow()).rejects.toThrow();
    pc.engine.stop();
    await pc.engine.syncNow();
    await phone.engine.syncNow();
    const legs = (await phone.db.transactions.toArray()).filter((t) => t.type === 'transfer');
    expect(legs).toHaveLength(2);
    const s = summariseIncomeExpenses(
      await phone.db.transactions.toArray(),
      'combined',
      '2026-03-01',
      '2026-03-31',
    );
    expect(s.expenseCents).toBe(0);
    expect(s.incomeCents).toBe(0);
  });

  it('sets up a new device from the account before creating any defaults', async () => {
    const remote = new FakeRemote();
    const pc = await device(remote);
    await updateSettings(pc.store, { savingsRatePercent: 12.5, paydayDayOfMonth: 25 });
    await pc.engine.syncNow();
    const phone = await device(remote);
    const s = await getSettings(phone.store);
    expect(s).toMatchObject({ savingsRatePercent: 12.5, paydayDayOfMonth: 25 });
    expect(await phone.engine.listConflicts()).toEqual([]);
    expect(await phone.db.outbox.count()).toBe(0);
  });

  it('propagates delete-all and a backup restore to the other device', async () => {
    const remote = new FakeRemote();
    const pc = await device(remote);
    const phone = await device(remote);
    await createAccount(pc.store, ACC);
    await pc.engine.syncNow();
    const backup = await exportBackup(pc.store);

    await deleteAllData(pc.store);
    await pc.engine.syncNow();
    await phone.engine.syncNow();
    expect(await phone.db.accounts.count()).toBe(0);
    expect((await getSettings(phone.store)).monthlySalaryCents).toBe(1_200_000);

    await restoreBackup(phone.store, backup, 'replace');
    await phone.engine.syncNow();
    await pc.engine.syncNow();
    expect((await pc.db.accounts.toArray()).map((a) => a.name)).toEqual(['Capitec main']);
    expect(await pc.engine.listConflicts()).toEqual([]);
    expect(await phone.engine.listConflicts()).toEqual([]);
  });
});
