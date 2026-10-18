import { makeAccount, makeTxn } from '@/test/factories';
import { seedCategories } from '../defaults';
import type { CategorisationRule } from '../models';
import { buildStaging, guessMapping, parseCsv } from './index';
import {
  learnedCategories,
  merchantKey,
  suggestCategory,
  type CategoriseContext,
} from './categorise';

const NOW = '2026-10-01T00:00:00.000Z';
const categories = seedCategories(NOW);
const account = makeAccount({ id: 'acc-1', workspace: 'personal' });

function ctx(over: Partial<CategoriseContext> = {}): CategoriseContext {
  return { account, categories, rules: [], learned: new Map(), ...over };
}

describe('suggestCategory from the bank’s own categories', () => {
  // The category names Capitec uses, with the parent category as a fallback.
  it.each([
    [['Groceries', 'Food'], -16_280, 'cat-groceries'],
    [['Sport & Hobbies', 'Personal & Family'], -3_800, 'cat-entertainment'],
    [['Gifts', 'Personal & Family'], -28_489, 'cat-gifts'],
    [['Electricity', 'Household'], -200_600, 'cat-utilities'],
    [['Fees', 'Fees'], -100, 'cat-bank-fees'],
    [['Parking', 'Transport'], -800, 'cat-transport'],
    [['Fuel', 'Transport'], -128_150, 'cat-transport'],
    [['Home Improvements', 'Household'], -13_900, 'cat-household'],
    [['Clothing & Shoes', 'Personal & Family'], -5_099, 'cat-shopping'],
    [['Store Account Payments', 'Loans & Accounts'], -20_000, 'cat-debt'],
    [['Online Store', 'Personal & Family'], -68_900, 'cat-shopping'],
    [['Software/Games', 'Entertainment'], -36_956, 'cat-entertainment'],
    [['Salary', 'Income'], 1_200_000, 'cat-salary'],
  ])('%j (%i cents) → %s', (bankCategories, amountCents, expected) => {
    expect(suggestCategory({ description: 'X', amountCents, bankCategories }, ctx())).toEqual({
      categoryId: expected,
      source: 'bank',
    });
  });

  it('prefers your own category with the same name as the bank’s', () => {
    const parking = {
      ...categories[0]!,
      id: 'my-parking',
      name: 'Parking',
      kind: 'expense' as const,
      group: 'essential' as const,
    };
    expect(
      suggestCategory(
        { description: 'X', amountCents: -800, bankCategories: ['Parking'] },
        ctx({ categories: [...categories, parking] }),
      ),
    ).toEqual({ categoryId: 'my-parking', source: 'bank' });
  });

  it('falls back to the parent category, and leaves unknown ones uncategorised', () => {
    expect(
      suggestCategory(
        { description: 'X', amountCents: -500, bankCategories: ['Odd thing', 'Transport'] },
        ctx(),
      )?.categoryId,
    ).toBe('cat-transport');
    expect(
      suggestCategory(
        { description: 'X', amountCents: -500, bankCategories: ['Odd thing', 'Other'] },
        ctx(),
      ),
    ).toBeNull();
  });

  it('never puts money in under a spending category, or money out under an income one', () => {
    // A refund the bank files under Groceries is income here, so no spending category fits.
    expect(
      suggestCategory(
        { description: 'X', amountCents: 4_000, bankCategories: ['Groceries'] },
        ctx(),
      ),
    ).toBeNull();
    expect(
      suggestCategory({ description: 'X', amountCents: -4_000, bankCategories: ['Salary'] }, ctx()),
    ).toBeNull();
  });

  it('skips personal-only categories for a business account', () => {
    const biz = ctx({ account: { id: 'b', workspace: 'business' } });
    expect(
      suggestCategory({ description: 'X', amountCents: -500, bankCategories: ['Groceries'] }, biz),
    ).toBeNull();
    // Bank fees is shared between personal and business.
    expect(
      suggestCategory({ description: 'X', amountCents: -500, bankCategories: ['Fees'] }, biz)
        ?.categoryId,
    ).toBe('cat-bank-fees');
  });
});

describe('learning from what you chose before', () => {
  it('recognises the same merchant despite changing numbers', () => {
    expect(merchantKey('Recurring Card Purchase admyt Parking 0412')).toBe(
      merchantKey('Recurring Card Purchase admyt Parking 0519'),
    );
    expect(merchantKey('POS 12A34 CHECKERS')).toBe('pos checkers');
  });

  it('uses your most common choice for that merchant and beats the bank’s category', () => {
    const learned = learnedCategories([
      makeTxn({
        accountId: 'acc-1',
        description: 'Takealot 1',
        categoryId: 'cat-gifts',
        updatedAt: '2026-09-01T00:00:00Z',
      }),
      makeTxn({
        accountId: 'acc-1',
        description: 'Takealot 2',
        categoryId: 'cat-gifts',
        updatedAt: '2026-09-02T00:00:00Z',
      }),
      makeTxn({
        accountId: 'acc-1',
        description: 'Takealot 3',
        categoryId: 'cat-shopping',
        updatedAt: '2026-09-03T00:00:00Z',
      }),
      makeTxn({ accountId: 'acc-1', description: 'Takealot 4', categoryId: null }),
    ]);
    expect(learned.get('takealot')).toBe('cat-gifts');
    expect(
      suggestCategory(
        { description: 'TAKEALOT 99', amountCents: -68_900, bankCategories: ['Online Store'] },
        ctx({ learned }),
      ),
    ).toEqual({ categoryId: 'cat-gifts', source: 'learned' });
  });

  it('ignores archived transactions and transfers', () => {
    const learned = learnedCategories([
      makeTxn({ accountId: 'acc-1', description: 'Old', categoryId: 'cat-gifts', archived: true }),
      makeTxn({
        accountId: 'acc-1',
        description: 'Move',
        categoryId: 'cat-gifts',
        type: 'transfer',
      }),
    ]);
    expect(learned.size).toBe(0);
  });
});

describe('rules and fees', () => {
  const rule: CategorisationRule = {
    id: 'r1',
    name: 'Church',
    matchText: 'grace church',
    direction: 'out',
    categoryId: 'cat-tithe',
    origin: 'user_rule',
    priority: 1,
    enabled: true,
    isDemo: false,
    createdAt: NOW,
    updatedAt: NOW,
  };

  it('applies your enabled rules first', () => {
    const c = ctx({ rules: [rule], learned: new Map([['grace church eft', 'cat-gifts']]) });
    expect(
      suggestCategory(
        { description: 'Grace Church EFT', amountCents: -120_000, bankCategories: ['Gifts'] },
        c,
      ),
    ).toEqual({ categoryId: 'cat-tithe', source: 'rule' });
    expect(
      suggestCategory(
        { description: 'Grace Church EFT', amountCents: -120_000 },
        ctx({ rules: [{ ...rule, enabled: false }] }),
      ),
    ).toBeNull();
    // Direction "out" doesn't match money in.
    expect(
      suggestCategory(
        { description: 'Grace Church refund', amountCents: 500 },
        ctx({ rules: [rule] }),
      ),
    ).toBeNull();
  });

  it('files a fee split off a purchase under Bank fees', () => {
    expect(
      suggestCategory(
        {
          description: 'Fee: Card purchase',
          amountCents: -200,
          splitFee: true,
          bankCategories: ['Clothing & Shoes'],
        },
        ctx(),
      ),
    ).toEqual({ categoryId: 'cat-bank-fees', source: 'fee' });
  });
});

describe('staging a Capitec-style statement', () => {
  const CSV = `Nr,Account,Posting Date,Transaction Date,Description,Original Description,Parent Category,Category,Money In,Money Out,Fee,Balance
1,0000000000,2026-09-01,2026-08-30 13:40,Coffee shop,COFFEE SHOP,Food,Groceries,,-50.00,,1000.00
2,0000000000,2026-09-01,2026-09-01 23:20,SMS Notification Fee,SMS NOTIFICATION FEE,Fees,Fees,,,-0.70,999.30
3,0000000000,2026-09-02,2026-09-01 10:00,Card purchase,SHOP 123,Personal & Family,Clothing & Shoes,,-100.00,-2.00,897.30
4,0000000000,2026-09-03,2026-09-03 08:00,Mystery,MYSTERY,Other,Uncategorised,,-10.00,,887.30
`;

  it('picks up the Category and Parent Category columns and suggests categories', () => {
    const rows = parseCsv(CSV).rows;
    const m = guessMapping(rows);
    expect(m).toMatchObject({ categoryColumn: 7, parentCategoryColumn: 6, descriptionColumn: 4 });
    const staging = buildStaging(rows, m, account, [], {
      accounts: [account],
      transactions: [],
      categories,
      rules: [],
    });
    expect(staging.rows.map((r) => [r.description, r.categoryId, r.categorySource])).toEqual([
      ['Coffee shop', 'cat-groceries', 'bank'],
      ['SMS Notification Fee', 'cat-bank-fees', 'bank'],
      ['Card purchase', 'cat-shopping', 'bank'],
      ['Fee: Card purchase', 'cat-bank-fees', 'fee'],
      ['Mystery', null, null],
    ]);
  });
});
