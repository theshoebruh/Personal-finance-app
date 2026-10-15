import type { FinanceDb, OutboxEntry } from '../local-db/db';
import { createDexieStore } from '../repositories/dexieStore';
import type { EntityRepository, FinanceStore } from '../repositories/types';
import { SYNCED_TABLES, type SyncedTable } from './rowMapping';

export function outboxKey(table: string, id: string): string {
  return `${table}:${id}`;
}

/**
 * Wraps the local store so every write is also recorded in the outbox, in the same IndexedDB
 * transaction: a change is either saved and queued for sync, or neither. Services and UI keep using
 * the normal FinanceStore interface and need no changes.
 */
export function createTrackedStore(
  db: FinanceDb,
  onLocalChange: () => void = () => undefined,
  now: () => string = () => new Date().toISOString(),
): FinanceStore {
  const base = createDexieStore(db);

  function track<T extends { id: string }>(
    table: SyncedTable,
    repo: EntityRepository<T>,
  ): EntityRepository<T> {
    const tx = <R>(fn: () => Promise<R>) => db.transaction('rw', [db.table(table), db.outbox], fn);
    const queue = async (ids: readonly string[], op: OutboxEntry['op']) => {
      if (ids.length === 0) return;
      const queuedAt = now();
      await db.outbox.bulkPut(
        ids.map((id) => ({ key: outboxKey(table, id), table, id, op, queuedAt, attempts: 0 })),
      );
    };
    const changed = <R>(p: Promise<R>) =>
      p.then((r) => {
        onLocalChange();
        return r;
      });
    return {
      ...repo,
      put: (entity) =>
        changed(
          tx(async () => {
            const saved = await repo.put(entity);
            await queue([saved.id], 'upsert');
            return saved;
          }),
        ),
      bulkPut: (entities) =>
        changed(
          tx(async () => {
            await repo.bulkPut(entities);
            await queue(
              entities.map((e) => e.id),
              'upsert',
            );
          }),
        ),
      delete: (id) =>
        changed(
          tx(async () => {
            await repo.delete(id);
            await queue([id], 'delete');
          }),
        ),
      bulkDelete: (ids) =>
        changed(
          tx(async () => {
            await repo.bulkDelete(ids);
            await queue(ids, 'delete');
          }),
        ),
      clear: () =>
        changed(
          tx(async () => {
            const ids = (await repo.list()).map((r) => r.id);
            await repo.clear();
            await queue(ids, 'delete');
          }),
        ),
    };
  }

  const tracked = { ...base } as FinanceStore;
  for (const table of SYNCED_TABLES) {
    // Each repository keeps its own extra query methods (e.g. transactions.byAccount).
    (tracked as unknown as Record<string, unknown>)[table] = {
      ...(base[table] as object),
      ...track(table, base[table] as unknown as EntityRepository<{ id: string }>),
    };
  }
  return tracked;
}
