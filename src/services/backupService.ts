import { z } from 'zod';
import {
  accountSchema,
  appSettingsSchema,
  budgetSchema,
  categorisationRuleSchema,
  categorySchema,
  goalContributionSchema,
  importBatchSchema,
  invoiceSchema,
  projectSchema,
  recurringRuleSchema,
  savingsGoalSchema,
  transactionSchema,
} from '@/domain/models';
import type { FinanceStore, StoreTableName } from '@/data/repositories/types';
import { type Clock, DomainError, systemClock } from './common';
import { ensureInitialised } from './settingsService';

export const BACKUP_FORMAT = 'personal-finance-hub-backup';
export const BACKUP_VERSION = 1;

const tables = {
  accounts: z.array(accountSchema),
  categories: z.array(categorySchema),
  transactions: z.array(transactionSchema),
  budgets: z.array(budgetSchema),
  goals: z.array(savingsGoalSchema),
  goalContributions: z.array(goalContributionSchema),
  recurringRules: z.array(recurringRuleSchema),
  importBatches: z.array(importBatchSchema),
  categorisationRules: z.array(categorisationRuleSchema),
  projects: z.array(projectSchema),
  invoices: z.array(invoiceSchema),
  settings: z.array(appSettingsSchema).max(1),
} satisfies Record<StoreTableName, z.ZodTypeAny>;

const TABLE_NAMES = Object.keys(tables) as StoreTableName[];

export const backupSchema = z.object({
  format: z.literal(BACKUP_FORMAT),
  version: z.literal(BACKUP_VERSION),
  exportedAt: z.string(),
  app: z.string(),
  data: z.object(tables),
});
export type Backup = z.infer<typeof backupSchema>;

/**
 * Full export of local data as plain JSON. This file is NOT encrypted: it contains the user's
 * financial records and should be stored somewhere private.
 */
export async function exportBackup(
  store: FinanceStore,
  clock: Clock = systemClock,
): Promise<Backup> {
  const data = {} as Record<StoreTableName, unknown[]>;
  await store.atomic(async () => {
    for (const name of TABLE_NAMES) data[name] = await store[name].list();
  });
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: clock.now(),
    app: 'Personal Finance Hub',
    data: data as Backup['data'],
  };
}

export interface RestoreSummary {
  mode: 'replace' | 'merge';
  counts: Record<StoreTableName, number>;
}

/** Parse and validate a backup file's text. Throws a readable error and changes nothing if invalid. */
export function parseBackup(text: string): Backup {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new DomainError('This file is not valid JSON, so it cannot be a backup.');
  }
  const result = backupSchema.safeParse(json);
  if (!result.success) {
    const first = result.error.issues[0];
    throw new DomainError(
      `This backup could not be validated (${first ? `${first.path.join('.')}: ${first.message}` : 'unknown error'}). Nothing was changed.`,
    );
  }
  const ids = new Set(result.data.data.accounts.map((a) => a.id));
  const orphan = result.data.data.transactions.find((t) => !ids.has(t.accountId));
  if (orphan) {
    throw new DomainError(
      'The backup contains a transaction for an account that is missing. Nothing was changed.',
    );
  }
  return result.data;
}

/**
 * Restore a validated backup atomically.
 * - replace: wipe local data, then load the backup (use after data loss or on a new device).
 * - merge: upsert by ID, so restoring the same backup twice never creates duplicates.
 */
export async function restoreBackup(
  store: FinanceStore,
  backup: Backup,
  mode: 'replace' | 'merge',
): Promise<RestoreSummary> {
  const counts = {} as Record<StoreTableName, number>;
  await store.atomic(async () => {
    if (mode === 'replace') {
      for (const name of TABLE_NAMES) await store[name].clear();
    }
    for (const name of TABLE_NAMES) {
      const rows = backup.data[name] as never[];
      await (store[name].bulkPut as (r: readonly never[]) => Promise<void>)(rows);
      counts[name] = rows.length;
    }
  });
  await ensureInitialised(store);
  return { mode, counts };
}

/** Delete every local record, then re-create default settings and categories. */
export async function deleteAllData(store: FinanceStore): Promise<void> {
  await store.atomic(async () => {
    for (const name of TABLE_NAMES) await store[name].clear();
  });
  await ensureInitialised(store);
}

export function backupFileName(exportedAt: string): string {
  return `finance-hub-backup-${exportedAt.slice(0, 10)}.json`;
}
