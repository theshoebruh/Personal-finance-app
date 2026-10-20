import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { makeAccount } from '@/test/factories';
import { buildStaging } from './build';
import { guessMapping } from './normalise';
import { type Sheet, makeXlsx } from '@/test/xlsx';
import { parseXlsx, isWorkbookFileName } from './xlsx';

// 46296 = 2026-10-01 in the 1900 date system.
const STATEMENT: Sheet = {
  name: 'Transactions',
  rows: [
    ['Date', 'Description', 'Amount', 'Balance'],
    [{ date: 46296 }, 'Coffee shop', -50.25, 949.75],
    [{ date: 46297.5625, style: 2 }, 'SALARY', 12000, 12949.75],
    [{ date: 46298 }, 'Rounding', 0.30000000000000004, null],
    [{ date: 46298 }, { f: 'B2&" (copy)"', v: 'Formula text' }, -0.07, 1],
  ],
};

describe('reading Excel workbooks', () => {
  it('recognises .xlsx and .xlsm names', () => {
    expect(isWorkbookFileName('October.XLSX')).toBe(true);
    expect(isWorkbookFileName('macro.xlsm')).toBe(true);
    expect(isWorkbookFileName('old.xls')).toBe(false);
    expect(isWorkbookFileName('march.csv')).toBe(false);
  });

  it('reads the first sheet as text rows: dates, amounts, shared and inline text, formulas', () => {
    const p = parseXlsx(makeXlsx([STATEMENT]));
    expect(p.rows).toEqual([
      ['Date', 'Description', 'Amount', 'Balance'],
      ['2026-10-01', 'Coffee shop', '-50.25', '949.75'],
      ['2026-10-02 13:30', 'SALARY', '12000', '12949.75'],
      ['2026-10-03', 'Rounding', '0.3'],
      ['2026-10-03', 'Formula text', '-0.07', '1'],
    ]);
    expect(p.note).toBe('Read the sheet “Transactions”.');
    expect(p.warnings).toEqual([]);
  });

  it('handles the 1904 date system and gaps between cells', () => {
    const p = parseXlsx(
      makeXlsx(
        [
          {
            name: 'S',
            rows: [
              ['Date', null, 'Amount'],
              [{ date: 44834 }, null, -1],
            ],
          },
        ],
        { date1904: true },
      ),
    );
    expect(p.rows[1]).toEqual(['2026-10-01', '', '-1']);
  });

  it('skips a hidden first sheet and says when a workbook has several sheets', () => {
    const p = parseXlsx(
      makeXlsx([
        { name: 'Notes', hidden: true, rows: [['secret', 'x']] },
        STATEMENT,
        { name: 'Summary', rows: [['a', 'b']] },
      ]),
    );
    expect(p.rows[0]).toEqual(['Date', 'Description', 'Amount', 'Balance']);
    expect(p.note).toMatch(/“Transactions” \(this workbook has 3 sheets/);
  });

  it('decodes Excel’s _xHHHH_ escapes and cleans text like a CSV', () => {
    // Excel stores a carriage return as _x000D_ and a bell character as _x0007_.
    const p = parseXlsx(
      makeXlsx([
        {
          name: 'S',
          rows: [
            ['Date', 'Desc'],
            ['Card_x000D_purchase', 'A_x0007_  B & C'],
          ],
        },
      ]),
    );
    expect(p.rows[1]).toEqual(['Card purchase', 'A B & C']);
  });

  it('rejects files that aren’t .xlsx, are damaged or would unpack to something huge', () => {
    expect(() => parseXlsx(strToU8('Date,Amount\n2026-10-01,1'))).toThrow(
      /doesn’t look like an Excel/,
    );
    expect(() => parseXlsx(zipSync({ 'readme.txt': strToU8('hi') }))).toThrow(/no sheets/);
    const broken = makeXlsx([STATEMENT], {
      extra: { 'xl/workbook.xml': strToU8('<workbook><sheets><sheet') },
    });
    expect(() => parseXlsx(broken)).toThrow(/damaged/);
    // 41 MB of zeros compresses to a few KB: refused before it is unpacked.
    const bomb = makeXlsx([STATEMENT], {
      extra: { 'xl/sharedStrings.xml': new Uint8Array(41 * 1024 * 1024) },
    });
    expect(() => parseXlsx(bomb)).toThrow(/too large/);
  });
});

describe('a workbook written by a real spreadsheet library (openpyxl)', () => {
  // fixtures/openpyxl-statement.xlsx: made-up rows in a Capitec-like layout, saved by openpyxl
  // 3.1.5 with date formats dd/mm/yyyy and yyyy-mm-dd hh:mm, and a second "Notes" sheet.
  const bytes = () =>
    new Uint8Array(
      readFileSync(resolve(process.cwd(), 'src/domain/imports/fixtures/openpyxl-statement.xlsx')),
    );

  it('reads its dates, money columns and sheet name', () => {
    const p = parseXlsx(bytes());
    expect(p.rows[0]).toEqual([
      'Nr',
      'Posting Date',
      'Transaction Date',
      'Description',
      'Category',
      'Money In',
      'Money Out',
      'Fee',
      'Balance',
    ]);
    expect(p.rows[1]).toEqual([
      '1',
      '2026-09-29',
      '2026-09-29 08:15',
      'Salary - Example Employer',
      'Salary',
      '12000',
      '',
      '',
      '12100',
    ]);
    expect(p.rows[3]).toEqual([
      '3',
      '2026-10-02',
      '2026-10-02 09:00',
      'Card purchase',
      'Groceries',
      '',
      '-100',
      '-2',
      '11952.5',
    ]);
    expect(p.note).toMatch(/“Statement” \(this workbook has 2 sheets/);
  });

  it('stages it like a CSV, including split money columns and fees', () => {
    const p = parseXlsx(bytes());
    const mapping = guessMapping(p.rows);
    expect(mapping).toMatchObject({ dateColumn: 1, descriptionColumn: 3, feeColumn: 7 });
    const account = makeAccount({ id: 'main' });
    const staged = buildStaging(p.rows, mapping, account, []).rows.filter((r) => r.include);
    expect(staged.map((r) => [r.date, r.description, r.amountCents])).toEqual([
      ['2026-09-29', 'Salary - Example Employer', 1_200_000],
      ['2026-10-01', 'Coffee shop', -4_550],
      ['2026-10-02', 'Card purchase', -10_000],
      ['2026-10-02', 'Fee: Card purchase', -200],
      ['2026-10-03', 'SMS Notification Fee', -70],
    ]);
  });
});
