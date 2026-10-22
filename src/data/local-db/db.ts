import Dexie, { type Table } from 'dexie';
import type {
  Account,
  AppSettings,
  Budget,
  BudgetGroup,
  CategorisationRule,
  Category,
  GoalContribution,
  ImportBatch,
  ImportProfile,
  Invoice,
  Project,
  RecurringRule,
  SavingsGoal,
  Transaction,
} from '@/domain/models';

export const DB_NAME = 'personal-finance-hub';

/**
 * Schema history. Never edit a published version: add a new entry with the changed stores and an
 * `upgrade` that migrates existing records, so user data survives app updates.
 * Note: IndexedDB cannot index booleans, so flags like `isDemo`/`active` are filtered in memory.
 */
export const SCHEMA_VERSIONS: ReadonlyArray<{
  version: number;
  stores: Record<string, string | null>;
  upgrade?: (tx: import('dexie').Transaction) => Promise<void> | void;
}> = [
  {
    version: 1,
    stores: {
      accounts: 'id, workspace',
      transactions:
        'id, accountId, date, workspace, status, categoryId, transferId, importBatchId, fingerprint, [accountId+date]',
      categories: 'id, group',
      budgets: 'id, categoryId, workspace',
      goals: 'id, workspace',
      goalContributions: 'id, goalId, date, transactionId',
      recurringRules: 'id, workspace',
      importBatches: 'id, accountId',
      categorisationRules: 'id, categoryId',
      projects: 'id, workspace',
      invoices: 'id, status, projectId',
      settings: 'id',
    },
  },
  {
    // v2: saved CSV column mappings per account. Existing data is untouched.
    version: 2,
    stores: { importProfiles: 'id, accountId' },
  },
  {
    // v3: sync bookkeeping (only used when signed in). Existing data is untouched.
    version: 3,
    stores: {
      outbox: 'key, table, queuedAt',
      syncMeta: 'key',
      syncState: 'key',
      conflicts: 'key, detectedAt',
    },
  },
  {
    // v4: custom budget groups (Needs, Wants, Savings, Buffer and the user's own). Existing data is
    // untouched; groups are added by ensureInitialised.
    version: 4,
    stores: { budgetGroups: 'id' },
  },
];

/** A local change waiting to be sent to the server (one per record; the latest operation wins). */
export interface OutboxEntry {
  key: string;
  table: string;
  id: string;
  op: 'upsert' | 'delete';
  queuedAt: string;
  attempts: number;
  /** Set when the server rejected this change; it is not retried until the record changes again. */
  failedReason?: string;
}

/** The last server revision this device has seen for a record. */
export interface SyncMeta {
  key: string;
  rev: number;
  deleted: boolean;
}

export interface SyncStateEntry {
  key: string;
  value: unknown;
}

/** A local version that lost to a newer synced version; kept until the user decides. */
export interface ConflictEntry {
  key: string;
  table: string;
  id: string;
  /** This device's version (null if this device deleted it). */
  local: Record<string, unknown> | null;
  /** The synced version now applied locally (null if it was deleted elsewhere). */
  remote: Record<string, unknown> | null;
  remoteRev: number;
  detectedAt: string;
}

export class FinanceDb extends Dexie {
  accounts!: Table<Account, string>;
  transactions!: Table<Transaction, string>;
  categories!: Table<Category, string>;
  budgetGroups!: Table<BudgetGroup, string>;
  budgets!: Table<Budget, string>;
  goals!: Table<SavingsGoal, string>;
  goalContributions!: Table<GoalContribution, string>;
  recurringRules!: Table<RecurringRule, string>;
  importBatches!: Table<ImportBatch, string>;
  importProfiles!: Table<ImportProfile, string>;
  categorisationRules!: Table<CategorisationRule, string>;
  projects!: Table<Project, string>;
  invoices!: Table<Invoice, string>;
  settings!: Table<AppSettings, string>;
  outbox!: Table<OutboxEntry, string>;
  syncMeta!: Table<SyncMeta, string>;
  syncState!: Table<SyncStateEntry, string>;
  conflicts!: Table<ConflictEntry, string>;

  constructor(name: string = DB_NAME) {
    super(name);
    for (const v of SCHEMA_VERSIONS) {
      const def = this.version(v.version).stores(v.stores);
      if (v.upgrade) def.upgrade(v.upgrade);
    }
  }
}

/** Tables that hold user records (everything except settings), in backup order. */
export const DATA_TABLES = [
  'accounts',
  'budgetGroups',
  'categories',
  'transactions',
  'budgets',
  'goals',
  'goalContributions',
  'recurringRules',
  'importBatches',
  'importProfiles',
  'categorisationRules',
  'projects',
  'invoices',
] as const;
export type DataTableName = (typeof DATA_TABLES)[number];

let instance: FinanceDb | null = null;

/**
 * Each signed-in user gets their own local database, so two people using one browser never see
 * each other's cached records. The unsuffixed database is the local-only (not signed in) copy.
 */
export function userDbName(userId: string): string {
  return `${DB_NAME}-${userId}`;
}

/** The app-wide local-only database. Tests create their own `new FinanceDb(uniqueName)` instead. */
export function getDb(): FinanceDb {
  instance ??= new FinanceDb();
  return instance;
}
