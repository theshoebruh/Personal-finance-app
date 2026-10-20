import Dexie from 'dexie';
import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';
import { FinanceDb } from '@/data/local-db/db';
import { SyncNetworkError, createSupabaseRemote } from '@/data/sync/remote';
import { SyncEngine } from '@/data/sync/syncEngine';
import { createTrackedStore } from '@/data/sync/trackedStore';
import { prepareDevice } from '@/data/sync/bootstrap';
import { accountBalance } from '@/domain/calculations/balances';
import { summariseIncomeExpenses } from '@/domain/calculations/reporting';
import { createAccount } from '@/services/accountsService';
import {
  createTransaction,
  createTransfer,
  updateTransaction,
} from '@/services/transactionsService';
import { exportBackup, parseBackup, restoreBackup } from '@/services/backupService';
import { commitImport, prepareImport } from '@/services/importService';
import { getSettings, updateSettings } from '@/services/settingsService';
import { setGroupTargets } from '@/services/categoriesService';
import { bucketTargets } from '@/domain/calculations/buckets';
import { key, newUser, url, type TestUser } from './helpers';

const opened: FinanceDb[] = [];
let n = 0;

async function signIn(user: TestUser) {
  const client = createClient(url(), key(), {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { transport: WebSocket as never },
  });
  const { error } = await client.auth.signInWithPassword({
    email: user.email,
    password: user.password,
  });
  if (error) throw error;
  return client;
}

/** A "device": its own IndexedDB and its own signed-in Supabase session. */
async function device(user: TestUser) {
  const client = await signIn(user);
  const db = new FinanceDb(`real-device-${Date.now()}-${++n}`);
  opened.push(db);
  const store = createTrackedStore(db);
  const engine = new SyncEngine(db, createSupabaseRemote(client));
  await prepareDevice(engine, store);
  return { client, db, store, engine };
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
  openingBalanceCents: 500_000,
  openingBalanceDate: '2026-03-01',
  includeInSpendable: true,
};

describe('two devices through the real Supabase API', () => {
  it('shows a change made on the PC on the phone, and back', async () => {
    const user = await newUser('devices');
    const pc = await device(user);
    await pc.engine.syncNow();
    const phone = await device(user);

    const acc = await createAccount(pc.store, ACC);
    const t = await createTransaction(pc.store, {
      accountId: acc.id,
      date: '2026-03-02',
      description: 'Groceries',
      amountCents: 45_010,
      type: 'expense',
      categoryId: 'cat-groceries',
    });
    await pc.engine.syncNow();
    await phone.engine.syncNow();
    const phoneAcc = await phone.db.accounts.get(acc.id);
    expect(accountBalance(phoneAcc!, await phone.db.transactions.toArray())).toBe(454_990);

    await updateTransaction(phone.store, t.id, { description: 'Groceries (Checkers)' });
    await phone.engine.syncNow();
    await pc.engine.syncNow();
    expect((await pc.db.transactions.get(t.id))?.description).toBe('Groceries (Checkers)');
  });

  it('records a conflict instead of overwriting when both devices edit the same record', async () => {
    const user = await newUser('conflict');
    const pc = await device(user);
    const acc = await createAccount(pc.store, ACC);
    await pc.engine.syncNow();
    const phone = await device(user);

    await pc.store.accounts.put({ ...(await pc.db.accounts.get(acc.id))!, name: 'Edited on PC' });
    await phone.store.accounts.put({
      ...(await phone.db.accounts.get(acc.id))!,
      name: 'Edited on phone',
    });
    await pc.engine.syncNow();
    const report = await phone.engine.syncNow();
    expect(report.conflicts).toBe(1);
    expect((await phone.db.accounts.get(acc.id))?.name).toBe('Edited on PC');
    const [c] = await phone.engine.listConflicts();
    expect(c?.local).toMatchObject({ name: 'Edited on phone' });
  });

  it('a fresh login on a new device gets the account’s data and settings, not defaults', async () => {
    const user = await newUser('fresh');
    const pc = await device(user);
    await updateSettings(pc.store, { savingsRatePercent: 15, paydayDayOfMonth: 25 });
    await createAccount(pc.store, ACC);
    await pc.engine.syncNow();

    const phone = await device(user);
    expect(await getSettings(phone.store)).toMatchObject({
      savingsRatePercent: 15,
      paydayDayOfMonth: 25,
    });
    expect(await phone.db.accounts.count()).toBe(1);
    expect(await phone.db.categories.count()).toBeGreaterThan(20);
    expect(await phone.engine.listConflicts()).toEqual([]);
  });

  it('group goals set on one device reach the other', async () => {
    const user = await newUser('goals');
    const pc = await device(user);
    await setGroupTargets(pc.store, { needs: 45, wants: 25, savings: 20, rf: 5, buffer: 5 });
    await pc.engine.syncNow();

    const phone = await device(user);
    expect(bucketTargets(await getSettings(phone.store))).toEqual({
      needs: 45,
      wants: 25,
      savings: 20,
      rf: 5,
      buffer: 5,
    });
    expect(await phone.engine.listConflicts()).toEqual([]);
  });

  it('keeps transfers and imports from being counted twice across devices', async () => {
    const user = await newUser('integrity');
    const pc = await device(user);
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
    const csv =
      'Date,Description,Amount\n2026-03-06,UBER TRIP,-95.00\n2026-03-07,SALARY,12000.00\n';
    const p1 = await prepareImport(pc.store, {
      accountId: main.id,
      text: csv,
      fileName: 'march.csv',
    });
    await commitImport(pc.store, { prepared: p1, rows: p1.staging.rows, saveMapping: true });
    await pc.engine.syncNow();

    const phone = await device(user);
    // The phone sees the PC's import, so importing the same statement finds only duplicates.
    const p2 = await prepareImport(phone.store, {
      accountId: main.id,
      text: csv,
      fileName: 'march.csv',
    });
    expect(p2.mappingSource).toBe('saved');
    expect(p2.staging.rows.map((r) => r.status)).toEqual(['duplicate', 'duplicate']);

    const all = await phone.db.transactions.toArray();
    expect(all.filter((t) => t.type === 'transfer')).toHaveLength(2);
    const s = summariseIncomeExpenses(all, 'combined', '2026-03-01', '2026-03-31');
    expect(s.incomeCents).toBe(1_200_000);
    expect(s.expenseCents).toBe(9_500);
  });

  it('restores a backup on one device and the other device follows', async () => {
    const user = await newUser('restore');
    const pc = await device(user);
    await createAccount(pc.store, ACC);
    await pc.engine.syncNow();
    const text = JSON.stringify(await exportBackup(pc.store));

    await createAccount(pc.store, { ...ACC, name: 'Added after backup' });
    await pc.engine.syncNow();
    const phone = await device(user);
    expect(await phone.db.accounts.count()).toBe(2);

    await restoreBackup(phone.store, parseBackup(text), 'replace');
    await phone.engine.syncNow();
    await pc.engine.syncNow();
    expect((await pc.db.accounts.toArray()).map((a) => a.name)).toEqual(['Capitec main']);
  });

  it('reports a failed network request, keeps the change, and recovers', async () => {
    const user = await newUser('network');
    const client = await signIn(user);
    const db = new FinanceDb(`real-device-net-${++n}`);
    opened.push(db);
    const store = createTrackedStore(db);
    const realRemote = createSupabaseRemote(client);
    let down = true;
    const unreachable = () => Promise.reject(new SyncNetworkError('Failed to fetch'));
    const engine = new SyncEngine(db, {
      push: (changes) => (down ? unreachable() : realRemote.push(changes)),
      pull: (...args) => (down ? unreachable() : realRemote.pull(...args)),
    });
    await expect(prepareDevice(engine, store)).rejects.toThrow(/Failed to fetch/);
    expect(await db.settings.count()).toBe(0); // nothing seeded until the account data is known
    down = false;
    await prepareDevice(engine, store);
    await createAccount(store, ACC);
    down = true;
    await expect(engine.syncNow()).rejects.toThrow();
    engine.stop();
    expect(engine.getStatus().state).toBe('offline');
    expect(engine.getStatus().pending).toBeGreaterThan(0);
    down = false;
    await engine.syncNow();
    expect(engine.getStatus()).toMatchObject({ state: 'idle', pending: 0 });
    const { data } = await client.from('accounts').select('name');
    expect(data).toEqual([{ name: 'Capitec main' }]);
  });

  it('cannot sync after signing out', async () => {
    const user = await newUser('signout');
    const pc = await device(user);
    await pc.client.auth.signOut();
    await createAccount(pc.store, ACC);
    await expect(pc.engine.syncNow()).rejects.toThrow();
    pc.engine.stop();
    expect(pc.engine.getStatus().state).toBe('signed_out');
  });
});

describe('imported transfers across devices (F-03)', () => {
  it('a transfer created by an import on the PC arrives on the phone as one balanced pair', async () => {
    const user = await newUser('xfer');
    const pc = await device(user);
    const main = await createAccount(pc.store, ACC);
    const sav = await createAccount(pc.store, {
      ...ACC,
      name: 'Savings',
      type: 'savings',
      includeInSpendable: false,
      openingBalanceCents: 0,
    });
    const csv = 'Date,Description,Amount\n2026-03-05,TRANSFER TO SAVINGS,-2160.00\n';
    const p = await prepareImport(pc.store, { accountId: main.id, text: csv });
    const rows = p.staging.rows.map((r) => ({ ...r, transferAccountId: sav.id }));
    await commitImport(pc.store, { prepared: p, rows, saveMapping: false });
    const report = await pc.engine.syncNow();
    expect(report.failed).toBe(0); // the server's transfer check accepted the pair

    const phone = await device(user);
    const legs = (await phone.db.transactions.toArray()).filter((t) => t.type === 'transfer');
    expect(legs).toHaveLength(2);
    expect(legs.reduce((s, l) => s + l.amountCents, 0)).toBe(0);
    const s = summariseIncomeExpenses(
      await phone.db.transactions.toArray(),
      'combined',
      '2026-03-01',
      '2026-03-31',
    );
    expect([s.incomeCents, s.expenseCents]).toEqual([0, 0]);
  });
});
