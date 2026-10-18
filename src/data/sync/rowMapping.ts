import { ZodDefault, ZodEffects, ZodNullable, ZodObject, ZodOptional, type ZodTypeAny } from 'zod';
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
import type { StoreTableName } from '../repositories/types';

/** Local store name → Supabase table name. Order matters only for readability. */
export const REMOTE_TABLES = {
  accounts: 'accounts',
  categories: 'categories',
  importBatches: 'import_batches',
  transactions: 'transactions',
  budgets: 'budgets',
  goals: 'goals',
  goalContributions: 'goal_contributions',
  recurringRules: 'recurring_rules',
  importProfiles: 'import_profiles',
  categorisationRules: 'categorisation_rules',
  projects: 'projects',
  invoices: 'invoices',
  settings: 'settings',
} as const satisfies Record<StoreTableName, string>;

export type SyncedTable = keyof typeof REMOTE_TABLES;
export type RemoteTable = (typeof REMOTE_TABLES)[SyncedTable];
export const SYNCED_TABLES = Object.keys(REMOTE_TABLES) as SyncedTable[];

const LOCAL_BY_REMOTE = Object.fromEntries(
  Object.entries(REMOTE_TABLES).map(([local, remote]) => [remote, local]),
) as Record<RemoteTable, SyncedTable>;

export function localTableFor(remote: string): SyncedTable | null {
  return (LOCAL_BY_REMOTE as Record<string, SyncedTable | undefined>)[remote] ?? null;
}

export const SCHEMAS: Record<SyncedTable, ZodTypeAny> = {
  accounts: accountSchema,
  categories: categorySchema,
  importBatches: importBatchSchema,
  transactions: transactionSchema,
  budgets: budgetSchema,
  goals: savingsGoalSchema,
  goalContributions: goalContributionSchema,
  recurringRules: recurringRuleSchema,
  importProfiles: importProfileSchema,
  categorisationRules: categorisationRuleSchema,
  projects: projectSchema,
  invoices: invoiceSchema,
  settings: appSettingsSchema,
};

/** Server-managed columns that never belong in the app's records. */
const SERVER_COLUMNS = ['user_id', 'revision', 'server_updated_at', 'deleted'];
const TIMESTAMP_FIELDS = new Set(['createdAt', 'updatedAt', 'importedAt', 'undoneAt']);

export function toSnake(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

export function toCamel(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

function objectShape(schema: ZodTypeAny): Record<string, ZodTypeAny> {
  let s: ZodTypeAny = schema;
  while (s instanceof ZodEffects) s = s._def.schema as ZodTypeAny;
  if (!(s instanceof ZodObject)) throw new Error('Expected an object schema');
  return s.shape as Record<string, ZodTypeAny>;
}

function isNullable(field: ZodTypeAny): boolean {
  let f: ZodTypeAny = field;
  for (;;) {
    if (f instanceof ZodNullable) return true;
    if (f instanceof ZodOptional || f instanceof ZodDefault) f = f._def.innerType as ZodTypeAny;
    else if (f instanceof ZodEffects) f = f._def.schema as ZodTypeAny;
    else return false;
  }
}

const NULLABLE_FIELDS: Record<SyncedTable, Set<string>> = Object.fromEntries(
  SYNCED_TABLES.map((t) => [
    t,
    new Set(
      Object.entries(objectShape(SCHEMAS[t]))
        .filter(([, f]) => isNullable(f))
        .map(([k]) => k),
    ),
  ]),
) as Record<SyncedTable, Set<string>>;

/** App record → row for Supabase (snake_case keys; optional fields that are absent become null). */
export function toRow(table: SyncedTable, record: object): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const key of Object.keys(objectShape(SCHEMAS[table]))) {
    const value = (record as Record<string, unknown>)[key];
    row[toSnake(key)] = value === undefined ? null : value;
  }
  return row;
}

export class RemoteRecordError extends Error {}

/**
 * Supabase row → validated app record. Server columns are dropped; null becomes "absent" for
 * optional fields and stays null for nullable ones; timestamps are normalised to ISO-8601 UTC.
 */
export function fromRow<T = unknown>(table: SyncedTable, row: Record<string, unknown>): T {
  const nullable = NULLABLE_FIELDS[table];
  const out: Record<string, unknown> = {};
  for (const [col, value] of Object.entries(row)) {
    if (SERVER_COLUMNS.includes(col)) continue;
    const key = toCamel(col);
    if (value === null) {
      if (nullable.has(key)) out[key] = null;
      continue;
    }
    out[key] =
      TIMESTAMP_FIELDS.has(key) && typeof value === 'string'
        ? new Date(value).toISOString()
        : value;
  }
  const parsed = SCHEMAS[table].safeParse(out);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new RemoteRecordError(
      `Synced ${table} record ${String(row.id)} is invalid: ${issue?.path.join('.')} ${issue?.message}`,
    );
  }
  return parsed.data as T;
}

/** Content equality ignoring bookkeeping timestamps, used to auto-resolve identical edits. */
export function sameContent(table: SyncedTable, a: object | null, b: object | null): boolean {
  if (a === null || b === null) return a === b;
  const strip = (r: object) => {
    const row = toRow(table, r);
    delete row.created_at;
    delete row.updated_at;
    return row;
  };
  return stableStringify(strip(a)) === stableStringify(strip(b));
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
