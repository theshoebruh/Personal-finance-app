import Dexie, { type Table } from 'dexie';
import type {
  Account,
  AppSettings,
  Budget,
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
];

export class FinanceDb extends Dexie {
  accounts!: Table<Account, string>;
  transactions!: Table<Transaction, string>;
  categories!: Table<Category, string>;
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

/** The app-wide database. Tests create their own `new FinanceDb(uniqueName)` instead. */
export function getDb(): FinanceDb {
  instance ??= new FinanceDb();
  return instance;
}
