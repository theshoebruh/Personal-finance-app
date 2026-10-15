import { z } from 'zod';
import { isIsoDate } from '../dates';

/*
 * Domain entities and their runtime validation schemas.
 * Money fields are integer cents. Calendar dates are ISO "YYYY-MM-DD" (Africa/Johannesburg).
 * Timestamps are ISO-8601 UTC strings.
 */

export const cents = z.number().int().refine(Number.isSafeInteger, 'Amount out of range');
export const nonNegativeCents = cents.refine((v) => v >= 0, 'Amount cannot be negative');
export const isoDate = z.string().refine(isIsoDate, 'Invalid date (expected YYYY-MM-DD)');
export const timestamp = z.string().datetime({ offset: true });
export const id = z.string().min(1).max(64);

export const WORKSPACES = ['personal', 'business'] as const;
export const workspaceSchema = z.enum(WORKSPACES);
export type Workspace = z.infer<typeof workspaceSchema>;
/** A dashboard/report view; "combined" consolidates both workspaces. */
export type WorkspaceView = Workspace | 'combined';

export const WORKSPACE_LABELS: Record<WorkspaceView, string> = {
  personal: 'Personal',
  business: 'Business',
  combined: 'Combined',
};

const recordMeta = {
  isDemo: z.boolean().default(false),
  createdAt: timestamp,
  updatedAt: timestamp,
};

// ---------------------------------------------------------------- Accounts

export const ACCOUNT_TYPES = ['current', 'savings', 'credit_card', 'cash', 'other'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];
export const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  current: 'Current / cheque',
  savings: 'Savings',
  credit_card: 'Credit card',
  cash: 'Cash',
  other: 'Other',
};

export const accountSchema = z.object({
  id,
  name: z.string().trim().min(1, 'Name is required').max(80),
  type: z.enum(ACCOUNT_TYPES),
  workspace: workspaceSchema,
  institution: z.string().trim().max(80).optional(),
  currency: z.literal('ZAR'),
  openingBalanceCents: cents,
  openingBalanceDate: isoDate,
  /** Whether this account's balance counts as cash available for day-to-day spending. */
  includeInSpendable: z.boolean(),
  active: z.boolean(),
  /** Last statement/confirmed balance used as a reconciliation check. */
  reconciledBalanceCents: cents.optional(),
  reconciledDate: isoDate.optional(),
  ...recordMeta,
});
export type Account = z.infer<typeof accountSchema>;

// ---------------------------------------------------------------- Categories

export const CATEGORY_GROUPS = [
  'essential',
  'discretionary',
  'savings',
  'income',
  'business_expense',
  'business_income',
] as const;
export type CategoryGroup = (typeof CATEGORY_GROUPS)[number];
export const CATEGORY_GROUP_LABELS: Record<CategoryGroup, string> = {
  essential: 'Essential needs',
  discretionary: 'Wants / lifestyle',
  savings: 'Savings & goals',
  income: 'Income',
  business_expense: 'Business expense',
  business_income: 'Business income',
};

export const categorySchema = z.object({
  id,
  name: z.string().trim().min(1).max(60),
  kind: z.enum(['income', 'expense']),
  group: z.enum(CATEGORY_GROUPS),
  workspace: z.enum(['personal', 'business', 'both']),
  archived: z.boolean(),
  ...recordMeta,
});
export type Category = z.infer<typeof categorySchema>;

// ---------------------------------------------------------------- Transactions

export const TRANSACTION_TYPES = ['income', 'expense', 'transfer', 'refund', 'adjustment'] as const;
export type TransactionType = (typeof TRANSACTION_TYPES)[number];
export const TRANSACTION_TYPE_LABELS: Record<TransactionType, string> = {
  income: 'Income',
  expense: 'Expense',
  transfer: 'Transfer',
  refund: 'Refund / reversal',
  adjustment: 'Balance adjustment',
};

export const TRANSACTION_STATUSES = ['pending', 'posted', 'needs_review', 'excluded'] as const;
export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];
export const TRANSACTION_STATUS_LABELS: Record<TransactionStatus, string> = {
  pending: 'Pending',
  posted: 'Posted',
  needs_review: 'Needs review',
  excluded: 'Excluded',
};

export const TRANSACTION_SOURCES = [
  'manual',
  'csv',
  'pdf',
  'sms_text',
  'notification',
  'bank_integration',
] as const;
export type TransactionSource = (typeof TRANSACTION_SOURCES)[number];
export const TRANSACTION_SOURCE_LABELS: Record<TransactionSource, string> = {
  manual: 'Manual',
  csv: 'CSV import',
  pdf: 'PDF import',
  sms_text: 'Pasted SMS text',
  notification: 'Notification import',
  bank_integration: 'Bank integration',
};

export const TRANSFER_KINDS = ['internal', 'owner_contribution', 'owner_draw'] as const;
export type TransferKind = (typeof TRANSFER_KINDS)[number];
export const TRANSFER_KIND_LABELS: Record<TransferKind, string> = {
  internal: 'Internal transfer',
  owner_contribution: 'Owner contribution',
  owner_draw: 'Owner draw',
};

const transactionObject = z.object({
  id,
  accountId: id,
  date: isoDate,
  postedDate: isoDate.optional(),
  /** Clean display description / merchant name (editable). */
  description: z.string().trim().min(1, 'Description is required').max(200),
  /** Original imported text, preserved verbatim and never overwritten. */
  originalDescription: z.string().max(500).optional(),
  /** Signed amount: positive = money into the account, negative = money out. */
  amountCents: cents.refine((v) => v !== 0, 'Amount cannot be zero'),
  type: z.enum(TRANSACTION_TYPES),
  categoryId: id.nullable(),
  workspace: workspaceSchema,
  status: z.enum(TRANSACTION_STATUSES),
  source: z.enum(TRANSACTION_SOURCES),
  importBatchId: id.optional(),
  fingerprint: z.string().max(200).optional(),
  /** Shared by both legs of a transfer between owned accounts. */
  transferId: id.optional(),
  transferKind: z.enum(TRANSFER_KINDS).optional(),
  /** Explicit match to a recurring rule occurrence (forecast reconciliation). */
  recurringRuleId: id.optional(),
  recurringOccurrenceDate: isoDate.optional(),
  invoiceId: id.optional(),
  projectId: id.optional(),
  notes: z.string().max(1000).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20),
  archived: z.boolean(),
  ...recordMeta,
});

export const transactionSchema = transactionObject.superRefine((t, ctx) => {
  const sign = Math.sign(t.amountCents);
  if (t.type === 'income' && sign < 0) {
    ctx.addIssue({ code: 'custom', path: ['amountCents'], message: 'Income must be positive' });
  }
  if (t.type === 'expense' && sign > 0) {
    ctx.addIssue({ code: 'custom', path: ['amountCents'], message: 'Expenses must be negative' });
  }
  if (t.type === 'refund' && sign < 0) {
    ctx.addIssue({ code: 'custom', path: ['amountCents'], message: 'Refunds must be positive' });
  }
  if (t.type === 'transfer' && !t.transferId) {
    ctx.addIssue({ code: 'custom', path: ['transferId'], message: 'Transfers need a transfer ID' });
  }
  if (t.type !== 'transfer' && t.transferId) {
    ctx.addIssue({
      code: 'custom',
      path: ['type'],
      message: 'Only transfers can have a transfer ID',
    });
  }
});
export type Transaction = z.infer<typeof transactionObject>;

// ---------------------------------------------------------------- Budgets

export const budgetSchema = z.object({
  id,
  categoryId: id,
  workspace: workspaceSchema,
  period: z.literal('monthly'),
  limitCents: nonNegativeCents,
  active: z.boolean(),
  ...recordMeta,
});
export type Budget = z.infer<typeof budgetSchema>;

// ---------------------------------------------------------------- Goals

export const GOAL_TYPES = [
  'emergency_fund',
  'monthly_buffer',
  'personal_purchase',
  'business_growth',
  'other',
] as const;
export type GoalType = (typeof GOAL_TYPES)[number];
export const GOAL_TYPE_LABELS: Record<GoalType, string> = {
  emergency_fund: 'Emergency fund',
  monthly_buffer: 'Monthly buffer',
  personal_purchase: 'Personal purchases',
  business_growth: 'Business growth',
  other: 'Other',
};

export const GOAL_STATES = ['active', 'paused', 'completed', 'archived'] as const;

export const savingsGoalSchema = z.object({
  id,
  name: z.string().trim().min(1).max(80),
  goalType: z.enum(GOAL_TYPES),
  workspace: workspaceSchema,
  /** "emergency_auto" derives the target from essential expenses × configured months. */
  targetMode: z.enum(['fixed', 'emergency_auto']),
  targetCents: nonNegativeCents.nullable(),
  targetDate: isoDate.optional(),
  /** 1 = highest priority. */
  priority: z.number().int().min(1).max(99),
  state: z.enum(GOAL_STATES),
  /**
   * If set, the goal's money physically sits in this account. When that account is excluded from
   * spendable cash, the allocation is already outside eligible cash and is not deducted again.
   */
  linkedAccountId: id.optional(),
  plannedMonthlyCents: nonNegativeCents.optional(),
  ...recordMeta,
});
export type SavingsGoal = z.infer<typeof savingsGoalSchema>;

/**
 * Virtual allocation ledger. A positive amount allocates money to a goal, a negative amount is a
 * withdrawal. Goal balance = sum of its contributions. These never change account balances.
 */
export const goalContributionSchema = z.object({
  id,
  goalId: id,
  date: isoDate,
  amountCents: cents.refine((v) => v !== 0, 'Amount cannot be zero'),
  transactionId: id.optional(),
  note: z.string().max(200).optional(),
  ...recordMeta,
});
export type GoalContribution = z.infer<typeof goalContributionSchema>;

// ---------------------------------------------------------------- Recurring rules

export const FREQUENCIES = ['weekly', 'fortnightly', 'monthly', 'yearly', 'custom_days'] as const;
export type Frequency = (typeof FREQUENCIES)[number];
export const FREQUENCY_LABELS: Record<Frequency, string> = {
  weekly: 'Weekly',
  fortnightly: 'Fortnightly',
  monthly: 'Monthly',
  yearly: 'Yearly',
  custom_days: 'Every N days',
};

const recurringRuleObject = z.object({
  id,
  name: z.string().trim().min(1).max(80),
  direction: z.enum(['income', 'expense']),
  /** Expected magnitude (always positive). */
  amountCents: nonNegativeCents.refine((v) => v > 0, 'Amount must be more than zero'),
  frequency: z.enum(FREQUENCIES),
  intervalDays: z.number().int().min(1).max(366).optional(),
  /** First due date; later occurrences follow the frequency from here. */
  startDate: isoDate,
  endDate: isoDate.optional(),
  accountId: id.optional(),
  categoryId: id.optional(),
  workspace: workspaceSchema,
  active: z.boolean(),
  /** Occurrences the user has marked as paid outside the app, or skipped. */
  settledDates: z.array(isoDate),
  /** Days either side of the due date within which a posted transaction can auto-match. */
  matchWindowDays: z.number().int().min(0).max(31),
  alertLeadDays: z.number().int().min(0).max(60),
  ...recordMeta,
});

export const recurringRuleSchema = recurringRuleObject.refine(
  (r) => r.frequency !== 'custom_days' || r.intervalDays !== undefined,
  { message: 'Custom frequency needs an interval', path: ['intervalDays'] },
);
export type RecurringRule = z.infer<typeof recurringRuleObject>;

// ---------------------------------------------------------------- Future-ready entities
// Persisted now so the backup format and database schema are stable; UI arrives in later phases.

export const importBatchSchema = z.object({
  id,
  accountId: id,
  source: z.enum(TRANSACTION_SOURCES),
  fileName: z.string().max(260).optional(),
  importedAt: timestamp,
  transactionCount: z.number().int().min(0),
  errorCount: z.number().int().min(0),
  status: z.enum(['committed', 'undone']),
  ...recordMeta,
});
export type ImportBatch = z.infer<typeof importBatchSchema>;

export const categorisationRuleSchema = z.object({
  id,
  name: z.string().max(80),
  matchText: z.string().max(200),
  accountId: id.optional(),
  direction: z.enum(['in', 'out', 'any']),
  minAmountCents: nonNegativeCents.optional(),
  maxAmountCents: nonNegativeCents.optional(),
  categoryId: id,
  origin: z.enum(['user_rule', 'learned_mapping']),
  priority: z.number().int(),
  enabled: z.boolean(),
  ...recordMeta,
});
export type CategorisationRule = z.infer<typeof categorisationRuleSchema>;

export const projectSchema = z.object({
  id,
  name: z.string().trim().min(1).max(80),
  workspace: workspaceSchema,
  status: z.enum(['active', 'completed', 'archived']),
  budgetCents: nonNegativeCents.optional(),
  ...recordMeta,
});
export type Project = z.infer<typeof projectSchema>;

export const invoiceSchema = z.object({
  id,
  invoiceNumber: z.string().trim().min(1).max(40),
  client: z.string().trim().min(1).max(120),
  issueDate: isoDate,
  dueDate: isoDate,
  amountCents: nonNegativeCents,
  status: z.enum(['draft', 'sent', 'paid', 'void']),
  projectId: id.optional(),
  paidTransactionIds: z.array(id),
  ...recordMeta,
});
export type Invoice = z.infer<typeof invoiceSchema>;

// ---------------------------------------------------------------- Settings

export const SETTINGS_ID = 'app';

export const appSettingsSchema = z.object({
  id: z.literal(SETTINGS_ID),
  locale: z.literal('en-ZA'),
  timeZone: z.literal('Africa/Johannesburg'),
  theme: z.literal('dark'),
  /** Monthly income plan used as the salary budget base. */
  monthlySalaryCents: nonNegativeCents,
  monthlyTitheCents: nonNegativeCents,
  savingsRatePercent: z.number().min(0).max(100),
  /** Expected payday day-of-month (1–31, clamped to month length). Null = no payday set. */
  paydayDayOfMonth: z.number().int().min(1).max(31).nullable(),
  /** One-off override for the next payday (e.g. salary paid early before a weekend). */
  nextPaydayOverride: isoDate.nullable(),
  budgetPeriodMode: z.enum(['calendar_month', 'pay_period']),
  /** Cap available-to-spend at the remaining discretionary category budget. */
  strictBudgetCap: z.boolean(),
  /** Reserve this period's not-yet-allocated planned savings in available-to-spend. */
  reservePlannedSavings: z.boolean(),
  emergencyFundMonths: z.number().int().min(1).max(24),
  emergencyFundFixedTargetCents: nonNegativeCents.nullable(),
  essentialMonthlyOverrideCents: nonNegativeCents.nullable(),
  onboardingComplete: z.boolean(),
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type AppSettings = z.infer<typeof appSettingsSchema>;
