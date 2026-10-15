import { type AppSettings, type Category, type CategoryGroup, SETTINGS_ID } from './models';

/**
 * Editable starting defaults from the requirements (section 3.1). These are a plan, not facts:
 * the user can change all of them in Settings.
 */
export function defaultSettings(now: string): AppSettings {
  return {
    id: SETTINGS_ID,
    locale: 'en-ZA',
    timeZone: 'Africa/Johannesburg',
    theme: 'dark',
    monthlySalaryCents: 1_200_000,
    monthlyTitheCents: 120_000,
    savingsRatePercent: 20,
    paydayDayOfMonth: null,
    nextPaydayOverride: null,
    budgetPeriodMode: 'calendar_month',
    strictBudgetCap: true,
    reservePlannedSavings: true,
    emergencyFundMonths: 3,
    emergencyFundFixedTargetCents: null,
    essentialMonthlyOverrideCents: null,
    onboardingComplete: false,
    createdAt: now,
    updatedAt: now,
  };
}

type SeedCategory = [
  id: string,
  name: string,
  kind: Category['kind'],
  group: CategoryGroup,
  ws: Category['workspace'],
];

/** Stable IDs so seeding is idempotent and backups from different devices line up. */
const SEED_CATEGORIES: SeedCategory[] = [
  ['cat-salary', 'Salary', 'income', 'income', 'personal'],
  ['cat-side-income', 'Side income', 'income', 'income', 'personal'],
  ['cat-interest', 'Interest', 'income', 'income', 'both'],
  ['cat-other-income', 'Other income', 'income', 'income', 'both'],
  ['cat-tithe', 'Tithe', 'expense', 'essential', 'personal'],
  ['cat-housing', 'Rent / housing', 'expense', 'essential', 'personal'],
  ['cat-groceries', 'Groceries', 'expense', 'essential', 'personal'],
  ['cat-utilities', 'Electricity & water', 'expense', 'essential', 'personal'],
  ['cat-transport', 'Transport & fuel', 'expense', 'essential', 'personal'],
  ['cat-phone', 'Phone & internet', 'expense', 'essential', 'personal'],
  ['cat-insurance', 'Insurance', 'expense', 'essential', 'personal'],
  ['cat-medical', 'Medical', 'expense', 'essential', 'personal'],
  ['cat-debt', 'Debt repayments', 'expense', 'essential', 'personal'],
  ['cat-bank-fees', 'Bank fees', 'expense', 'essential', 'both'],
  ['cat-eating-out', 'Eating out & takeaways', 'expense', 'discretionary', 'personal'],
  ['cat-entertainment', 'Entertainment', 'expense', 'discretionary', 'personal'],
  ['cat-shopping', 'Shopping', 'expense', 'discretionary', 'personal'],
  ['cat-subscriptions', 'Subscriptions', 'expense', 'discretionary', 'personal'],
  ['cat-personal-care', 'Personal care', 'expense', 'discretionary', 'personal'],
  ['cat-gifts', 'Gifts & donations', 'expense', 'discretionary', 'personal'],
  ['cat-household', 'Household supplies', 'expense', 'discretionary', 'personal'],
  ['cat-biz-revenue', 'Sales / revenue', 'income', 'business_income', 'business'],
  ['cat-biz-stock', 'Stock & materials', 'expense', 'business_expense', 'business'],
  ['cat-biz-software', 'Software & tools', 'expense', 'business_expense', 'business'],
  ['cat-biz-marketing', 'Marketing', 'expense', 'business_expense', 'business'],
  ['cat-biz-delivery', 'Delivery & courier', 'expense', 'business_expense', 'business'],
  ['cat-biz-other', 'Other business costs', 'expense', 'business_expense', 'business'],
];

export function seedCategories(now: string): Category[] {
  return SEED_CATEGORIES.map(([id, name, kind, group, workspace]) => ({
    id,
    name,
    kind,
    group,
    workspace,
    archived: false,
    isDemo: false,
    createdAt: now,
    updatedAt: now,
  }));
}
