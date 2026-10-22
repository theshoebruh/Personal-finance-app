import type {
  BudgetGroup,
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

/**
 * Storage-agnostic repository interfaces. Application services depend on these, not on Dexie,
 * so the persistence layer can be migrated (e.g. to a sync-capable store) later.
 * Implementations must validate every record before persisting it.
 */
export interface EntityRepository<T extends { id: string }> {
  list(): Promise<T[]>;
  get(id: string): Promise<T | undefined>;
  put(entity: T): Promise<T>;
  bulkPut(entities: readonly T[]): Promise<void>;
  delete(id: string): Promise<void>;
  bulkDelete(ids: readonly string[]): Promise<void>;
  clear(): Promise<void>;
}

export interface FinanceStore {
  accounts: EntityRepository<Account>;
  transactions: EntityRepository<Transaction> & {
    byAccount(accountId: string): Promise<Transaction[]>;
    byTransferId(transferId: string): Promise<Transaction[]>;
    byImportBatch(importBatchId: string): Promise<Transaction[]>;
  };
  categories: EntityRepository<Category>;
  budgetGroups: EntityRepository<BudgetGroup>;
  budgets: EntityRepository<Budget>;
  goals: EntityRepository<SavingsGoal>;
  goalContributions: EntityRepository<GoalContribution>;
  recurringRules: EntityRepository<RecurringRule>;
  importBatches: EntityRepository<ImportBatch>;
  importProfiles: EntityRepository<ImportProfile>;
  categorisationRules: EntityRepository<CategorisationRule>;
  projects: EntityRepository<Project>;
  invoices: EntityRepository<Invoice>;
  settings: EntityRepository<AppSettings>;
  /** Run several writes atomically: all succeed or none are applied. */
  atomic<R>(fn: () => Promise<R>): Promise<R>;
}

export type StoreTableName = Exclude<keyof FinanceStore, 'atomic'>;
