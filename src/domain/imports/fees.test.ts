import { makeAccount } from '@/test/factories';
import { buildStaging, guessMapping, parseCsv } from './index';

/**
 * Made-up rows in the layout Capitec uses: Money In / Money Out / Fee columns, fees usually on
 * their own line, negative amounts for money out. No real account data.
 */
const CAPITEC = `Nr,Account,Posting Date,Transaction Date,Description,Original Description,Parent Category,Category,Money In,Money Out,Fee,Balance
1,0000000000,2026-09-01,2026-08-30 13:40,Coffee shop,COFFEE SHOP,Food,Groceries,,-50.00,,1000.00
2,0000000000,2026-09-01,2026-09-01 23:20,SMS Notification Fee,SMS NOTIFICATION FEE,Fees,Fees,,,-0.70,999.30
3,0000000000,2026-09-02,2026-09-01 10:00,Card purchase,SHOP 123,Shopping,Clothing,,-100.00,-2.00,897.30
4,0000000000,2026-09-03,2026-09-03 08:00,Salary,EMPLOYER,Income,Salary,5000.00,,,5897.30
5,0000000000,2026-09-03,2026-09-03 23:20,SMS Notification Fee,SMS NOTIFICATION FEE,Fees,Fees,,,0.35,5896.95
`;

const account = makeAccount({ id: 'acc-1', openingBalanceDate: '2026-08-01' });

describe('bank fee column', () => {
  const parsed = parseCsv(CAPITEC);

  it('is picked up from a "Fee" header alongside Money In / Money Out', () => {
    const m = guessMapping(parsed.rows);
    expect(m).toMatchObject({
      amountMode: 'debit_credit',
      dateColumn: 2,
      descriptionColumn: 4,
      creditColumn: 8,
      debitColumn: 9,
      feeColumn: 10,
      balanceColumn: 11,
      referenceColumn: null,
    });
  });

  it('imports fee-only lines and splits a line with both an amount and a fee', () => {
    const staging = buildStaging(parsed.rows, guessMapping(parsed.rows), account, []);
    expect(staging.mappingErrors).toEqual([]);
    expect(
      staging.rows.map((r) => [r.line, r.description, r.amountCents, r.status, !!r.splitFee]),
    ).toEqual([
      [2, 'Coffee shop', -5_000, 'new', false],
      [3, 'SMS Notification Fee', -70, 'new', false],
      [4, 'Card purchase', -10_000, 'new', false],
      [4, 'Fee: Card purchase', -200, 'new', true],
      [5, 'Salary', 500_000, 'new', false],
      // A fee shown as a positive number is still money out.
      [6, 'SMS Notification Fee', -35, 'new', false],
    ]);
    // Every row has its own fingerprint, so the fee is never mistaken for a duplicate.
    expect(new Set(staging.rows.map((r) => r.fingerprint)).size).toBe(6);
    expect(staging.rows.every((r) => r.identicalLines.length === 0)).toBe(true);
  });

  it('counts fees in the running-balance check, so it agrees with the bank to the cent', () => {
    const { balanceCheck } = buildStaging(parsed.rows, guessMapping(parsed.rows), account, []);
    expect(balanceCheck).toMatchObject({
      pairsChecked: 4,
      consistentPairs: 4,
      order: 'oldest_first',
      suggestInvertSign: false,
      closing: { date: '2026-09-03', balanceCents: 589_695 },
    });
  });

  it('leaves fee-only lines unreadable when the fee column is switched off', () => {
    const m = { ...guessMapping(parsed.rows), feeColumn: null };
    const staging = buildStaging(parsed.rows, m, account, []);
    const fees = staging.rows.filter((r) => r.description === 'SMS Notification Fee');
    expect(fees.map((r) => [r.status, r.errors])).toEqual([
      ['invalid', ['Missing amount']],
      ['invalid', ['Missing amount']],
    ]);
    expect(staging.rows.find((r) => r.description === 'Card purchase')?.amountCents).toBe(-10_000);
    expect(staging.rows.some((r) => r.splitFee)).toBe(false);
  });

  it('treats a zero fee as no fee and reports an unreadable one', () => {
    const csv = `Date,Description,Money In,Money Out,Fee
2026-09-01,Zero fee,,-10.00,0.00
2026-09-02,Bad fee,,-10.00,abc
`;
    const rows = parseCsv(csv).rows;
    const staging = buildStaging(rows, guessMapping(rows), account, []);
    expect(staging.rows.map((r) => [r.description, r.amountCents, r.status, r.errors])).toEqual([
      ['Zero fee', -1_000, 'new', []],
      ['Bad fee', -1_000, 'invalid', ['Unreadable fee "abc"']],
    ]);
  });

  it('works with a single signed amount column too', () => {
    const csv = `Date,Description,Amount,Bank charges
2026-09-01,Transfer out,-500.00,-5.50
2026-09-02,Monthly account fee,,-7.00
`;
    const rows = parseCsv(csv).rows;
    const m = guessMapping(rows);
    expect(m).toMatchObject({ amountMode: 'signed', amountColumn: 2, feeColumn: 3 });
    expect(
      buildStaging(rows, m, account, []).rows.map((r) => [r.description, r.amountCents]),
    ).toEqual([
      ['Transfer out', -50_000],
      ['Fee: Transfer out', -550],
      ['Monthly account fee', -700],
    ]);
  });
});
