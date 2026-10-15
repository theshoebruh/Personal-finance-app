import type { Table } from 'dexie';
import type { ZodType, ZodTypeDef } from 'zod';
import {
  accountSchema,
  appSettingsSchema,
  budgetSchema,
  categorisationRuleSchema,
  categorySchema,
  goalContributionSchema,
  importBatchSchema,
  importProfileSchema,
  invoiceSchema,
  projectSchema,
  recurringRuleSchema,
  savingsGoalSchema,
  transactionSchema,
} from '@/domain/models';
import { type FinanceDb, getDb } from '../local-db/db';
import type { EntityRepository, FinanceStore } from './types';

export class ValidationError extends Error {
  constructor(
    message: string,
    readonly issues: { path: string; message: string }[],
  ) {
    super(message);
    this.name = 'ValidationError';
  }
}

export function validate<T>(
  schema: ZodType<T, ZodTypeDef, unknown>,
  value: unknown,
  label: string,
): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    throw new ValidationError(
      `Invalid ${label}: ${issues.map((i) => `${i.path || 'record'} – ${i.message}`).join('; ')}`,
      issues,
    );
  }
  return result.data;
}

function repo<T extends { id: string }>(
  table: Table<T, string>,
  schema: ZodType<T, ZodTypeDef, unknown>,
  label: string,
): EntityRepository<T> {
  return {
    list: () => table.toArray(),
    get: (id) => table.get(id),
    async put(entity) {
      const valid = validate(schema, entity, label);
      await table.put(valid);
      return valid;
    },
    async bulkPut(entities) {
      const valid = entities.map((e) => validate(schema, e, label));
      await table.bulkPut(valid);
    },
    delete: (id) => table.delete(id),
    bulkDelete: (ids) => table.bulkDelete([...ids]),
    clear: () => table.clear(),
  };
}

export function createDexieStore(db: FinanceDb = getDb()): FinanceStore {
  const transactions = repo(db.transactions, transactionSchema, 'transaction');
  return {
    accounts: repo(db.accounts, accountSchema, 'account'),
    transactions: {
      ...transactions,
      byAccount: (accountId) => db.transactions.where('accountId').equals(accountId).toArray(),
      byTransferId: (transferId) =>
        db.transactions.where('transferId').equals(transferId).toArray(),
      byImportBatch: (importBatchId) =>
        db.transactions.where('importBatchId').equals(importBatchId).toArray(),
    },
    categories: repo(db.categories, categorySchema, 'category'),
    budgets: repo(db.budgets, budgetSchema, 'budget'),
    goals: repo(db.goals, savingsGoalSchema, 'goal'),
    goalContributions: repo(db.goalContributions, goalContributionSchema, 'goal contribution'),
    recurringRules: repo(db.recurringRules, recurringRuleSchema, 'recurring item'),
    importBatches: repo(db.importBatches, importBatchSchema, 'import batch'),
    importProfiles: repo(db.importProfiles, importProfileSchema, 'import profile'),
    categorisationRules: repo(
      db.categorisationRules,
      categorisationRuleSchema,
      'categorisation rule',
    ),
    projects: repo(db.projects, projectSchema, 'project'),
    invoices: repo(db.invoices, invoiceSchema, 'invoice'),
    settings: repo(db.settings, appSettingsSchema, 'settings'),
    atomic: (fn) => db.transaction('rw', db.tables, fn),
  };
}
