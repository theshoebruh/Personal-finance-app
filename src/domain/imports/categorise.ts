import type { Account, CategorisationRule, Category, Transaction } from '../models';
import type { Cents } from '../money';
import { normaliseText } from '../calculations/recurring';

/** Where a suggested category came from, shown next to it in the import review. */
export type CategorySource = 'rule' | 'learned' | 'fee' | 'bank' | 'you';

export interface CategorySuggestion {
  categoryId: string;
  source: CategorySource;
}

export interface CategoriseContext {
  account: Pick<Account, 'id' | 'workspace'>;
  categories: readonly Category[];
  rules: readonly CategorisationRule[];
  /** From `learnedCategories`: what you chose before for the same description. */
  learned: ReadonlyMap<string, string>;
}

const BANK_FEES = 'cat-bank-fees';

/**
 * Common bank category names (Capitec, FNB, Standard Bank, Absa, Nedbank, TymeBank, Discovery…)
 * mapped to the built-in categories, most specific first. Matched against the bank's category
 * text, lower-cased.
 */
const BANK_HINTS: readonly [RegExp, string][] = [
  [/\btithe/, 'cat-tithe'],
  [/fee|bank charge|service charge|admin charge/, BANK_FEES],
  [/salary|salaries|wage|payroll/, 'cat-salary'],
  [/interest/, 'cat-interest'],
  [/grocer|supermarket/, 'cat-groceries'],
  [
    /restaurant|takeaway|take-away|take away|fast food|coffee|eating out|dining|food and drink|food & drink/,
    'cat-eating-out',
  ],
  [/fuel|petrol|parking|transport|taxi|e-?hailing|toll|vehicle|motor|travel/, 'cat-transport'],
  [/electric|water|municipal|utilit/, 'cat-utilities'],
  [/cell|airtime|mobile|data bundle|internet|telephone|phone|telecom|wifi/, 'cat-phone'],
  [/insurance|funeral|life cover|assurance/, 'cat-insurance'],
  [/medical|pharma|doctor|health|dentist|hospital|optometr/, 'cat-medical'],
  [/\brent\b|\bbond\b|home loan|mortgage|housing|levies|levy/, 'cat-housing'],
  [/loan|debt|store account|credit card|repayment|instal/, 'cat-debt'],
  [/subscription|streaming|membership/, 'cat-subscriptions'],
  [/entertainment|movie|cinema|music|software|game|sport|hobb|leisure|event/, 'cat-entertainment'],
  [/personal care|beauty|hair|cosmetic|toiletr|gym|fitness|wellness/, 'cat-personal-care'],
  [/gift|donation|charit|church/, 'cat-gifts'],
  [/home improvement|hardware|household|homeware|furniture|garden|diy/, 'cat-household'],
  [/cloth|shoe|fashion|online stor|shopping|electronic|department store|retail/, 'cat-shopping'],
  [/^income$|other income|refund|reward|cashback|cash back/, 'cat-other-income'],
];

/** Key used to recognise the same merchant or payment again: lower-case words, no digits. */
export function merchantKey(description: string): string {
  return normaliseText(description)
    .replace(/\b[a-z]*\d[a-z\d]*\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Whether a category can be used for this amount in this account (same rules as manual entry). */
export function categoryFits(
  category: Category | undefined,
  account: Pick<Account, 'workspace'>,
  amountCents: Cents,
): category is Category {
  if (!category || category.archived) return false;
  if (category.workspace !== 'both' && category.workspace !== account.workspace) return false;
  return category.kind === (amountCents > 0 ? 'income' : 'expense');
}

/**
 * What you chose before: for each merchant key, the category used most often on your past
 * transactions (the most recently changed one breaks ties). Transfers, adjustments and
 * uncategorised transactions are ignored.
 */
export function learnedCategories(transactions: readonly Transaction[]): Map<string, string> {
  const tally = new Map<string, Map<string, { count: number; latest: string }>>();
  for (const t of transactions) {
    if (t.archived || !t.categoryId || t.type === 'transfer' || t.type === 'adjustment') continue;
    const key = merchantKey(t.description);
    if (!key) continue;
    const byCat = tally.get(key) ?? new Map<string, { count: number; latest: string }>();
    const entry = byCat.get(t.categoryId) ?? { count: 0, latest: '' };
    entry.count++;
    if (t.updatedAt > entry.latest) entry.latest = t.updatedAt;
    byCat.set(t.categoryId, entry);
    tally.set(key, byCat);
  }
  const out = new Map<string, string>();
  for (const [key, byCat] of tally) {
    const best = [...byCat.entries()].sort(
      (a, b) => b[1].count - a[1].count || (a[1].latest < b[1].latest ? 1 : -1),
    )[0]!;
    out.set(key, best[0]);
  }
  return out;
}

function ruleMatches(
  rule: CategorisationRule,
  row: { description: string; amountCents: Cents },
  accountId: string,
): boolean {
  if (!rule.enabled) return false;
  if (rule.accountId && rule.accountId !== accountId) return false;
  if (rule.direction === 'in' && row.amountCents <= 0) return false;
  if (rule.direction === 'out' && row.amountCents >= 0) return false;
  const magnitude = Math.abs(row.amountCents);
  if (rule.minAmountCents !== undefined && magnitude < rule.minAmountCents) return false;
  if (rule.maxAmountCents !== undefined && magnitude > rule.maxAmountCents) return false;
  const needle = normaliseText(rule.matchText);
  return needle !== '' && normaliseText(row.description).includes(needle);
}

/**
 * Suggests one of your categories for an imported row, or null. In order: your own rules, then
 * what you chose before for the same merchant, then Bank fees for a fee split off a purchase, then
 * the bank's own category (your category with the same name first, then the built-in mapping).
 * A suggestion is only made when the category fits the amount (income vs spending) and account.
 */
export function suggestCategory(
  row: {
    description: string;
    amountCents: Cents;
    bankCategories?: readonly string[] | undefined;
    splitFee?: boolean | undefined;
  },
  ctx: CategoriseContext,
): CategorySuggestion | null {
  const byId = new Map(ctx.categories.map((c) => [c.id, c]));
  const fits = (id: string | undefined) =>
    id !== undefined && categoryFits(byId.get(id), ctx.account, row.amountCents);

  const rule = [...ctx.rules]
    .sort((a, b) => a.priority - b.priority)
    .find((r) => ruleMatches(r, row, ctx.account.id) && fits(r.categoryId));
  if (rule) return { categoryId: rule.categoryId, source: 'rule' };

  if (row.splitFee && fits(BANK_FEES)) return { categoryId: BANK_FEES, source: 'fee' };

  const learned = ctx.learned.get(merchantKey(row.description));
  if (fits(learned)) return { categoryId: learned!, source: 'learned' };

  for (const bank of row.bankCategories ?? []) {
    const name = normaliseText(bank);
    if (!name) continue;
    const sameName = ctx.categories.find((c) => normaliseText(c.name) === name && fits(c.id));
    if (sameName) return { categoryId: sameName.id, source: 'bank' };
    // The first matching hint decides; if it doesn't fit (e.g. a refund in a spending category),
    // try the next bank category rather than a looser hint.
    const lower = bank.toLowerCase();
    const hint = BANK_HINTS.find(([re]) => re.test(lower));
    if (hint && fits(hint[1])) return { categoryId: hint[1], source: 'bank' };
  }
  return null;
}
