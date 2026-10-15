import { makeAccount, makeTxn } from '@/test/factories';
import {
  type ColumnMapping,
  CsvError,
  checkRunningBalance,
  detectDateFormat,
  guessMapping,
  normaliseRows,
  parseCsv,
  parseDate,
  sanitiseCell,
  stageRows,
  summariseStaging,
  transactionFingerprint,
  findRepeatedImports,
} from '.';

const signed: ColumnMapping = {
  hasHeader: true,
  dateColumn: 0,
  descriptionColumn: 1,
  extraDescriptionColumn: null,
  amountMode: 'signed',
  amountColumn: 2,
  debitColumn: null,
  creditColumn: null,
  referenceColumn: null,
  balanceColumn: 3,
  dateFormat: 'auto',
  invertSign: false,
};

describe('parseCsv', () => {
  it('reads quoted fields, BOM and semicolon-delimited Excel exports', () => {
    const bom = String.fromCharCode(0xfeff);
    const p = parseCsv(
      `${bom}Date;Description;Amount\n2026-03-01;"Checkers; Rosebank";-120,50\n\n`,
    );
    expect(p.delimiter).toBe(';');
    expect(p.rows).toEqual([
      ['Date', 'Description', 'Amount'],
      ['2026-03-01', 'Checkers; Rosebank', '-120,50'],
    ]);
  });

  it('rejects empty and single-column files with readable errors', () => {
    expect(() => parseCsv('   ')).toThrow(CsvError);
    expect(() => parseCsv('just\none\ncolumn')).toThrow(/one column/);
  });

  it('treats cell text as untrusted', () => {
    expect(sanitiseCell('  =CMD|x\u0007  \n spaced ')).toBe('=CMD|x spaced');
    expect(sanitiseCell('x'.repeat(600))).toHaveLength(500);
  });
});

describe('dates', () => {
  it('parses supported formats and ignores times', () => {
    expect(parseDate('2026/03/15', 'YYYY-MM-DD')).toBe('2026-03-15');
    expect(parseDate('2026-03-15T10:22:00Z', 'YYYY-MM-DD')).toBe('2026-03-15');
    expect(parseDate('15/03/2026', 'DD/MM/YYYY')).toBe('2026-03-15');
    expect(parseDate('03/15/2026', 'MM/DD/YYYY')).toBe('2026-03-15');
    expect(parseDate('15 Mar 2026', 'D MMM YYYY')).toBe('2026-03-15');
    expect(parseDate('5-September-26', 'D MMM YYYY')).toBe('2026-09-05');
    expect(parseDate('31/02/2026', 'DD/MM/YYYY')).toBeNull();
  });

  it('detects day/month order and flags ambiguity (defaulting to South African D/M/Y)', () => {
    expect(detectDateFormat(['13/03/2026', '01/04/2026'])).toEqual({
      format: 'DD/MM/YYYY',
      ambiguous: false,
    });
    expect(detectDateFormat(['03/13/2026'])).toEqual({ format: 'MM/DD/YYYY', ambiguous: false });
    expect(detectDateFormat(['01/02/2026', '03/04/2026'])).toEqual({
      format: 'DD/MM/YYYY',
      ambiguous: true,
    });
    expect(detectDateFormat(['2026-03-01'])).toEqual({ format: 'YYYY-MM-DD', ambiguous: false });
    expect(detectDateFormat(['garbage']).format).toBeNull();
    // One malformed cell does not break detection for the rest of the file.
    expect(detectDateFormat(['2026-03-01', 'n/a', '2026-03-02']).format).toBe('YYYY-MM-DD');
  });
});

describe('normaliseRows', () => {
  it('normalises signed amounts and keeps invalid rows with errors (never guessing)', () => {
    const rows = [
      ['Date', 'Description', 'Amount', 'Balance'],
      ['01/03/2026', 'Salary', 'R12 000,00', '12 000.00'],
      ['02/03/2026', 'Checkers', '-450.10', '11549.90'],
      ['bad', 'Mystery', '10', ''],
      ['03/03/2026', '', 'abc', ''],
      ['04/03/2026', 'Zero', '0', ''],
    ];
    const { rows: out, dateFormatAmbiguous } = normaliseRows(rows, signed);
    // 01–04/03 read either way, so day/month order is flagged as ambiguous (D/M/Y assumed).
    expect(dateFormatAmbiguous).toBe(true);
    expect(out[0]).toMatchObject({
      line: 2,
      date: '2026-03-01',
      amountCents: 1_200_000,
      balanceCents: 1_200_000,
      errors: [],
    });
    expect(out[1]!.amountCents).toBe(-45_010);
    expect(out[2]!.errors[0]).toMatch(/Unreadable date/);
    expect(out[3]!.errors).toEqual(
      expect.arrayContaining(['Missing description', 'Unreadable amount "abc"']),
    );
    expect(out[4]!.errors).toContain('Amount is zero');
  });

  it('handles debit/credit columns, CR/DR markers and sign inversion', () => {
    const rows = [
      ['2026-03-01', 'Card purchase', '150.00', ''],
      ['2026-03-02', 'Refund', '', '20.00'],
      ['2026-03-03', 'Both', '1', '1'],
      ['2026-03-04', 'Neither', '', ''],
    ];
    const m: ColumnMapping = {
      ...signed,
      hasHeader: false,
      amountMode: 'debit_credit',
      amountColumn: null,
      debitColumn: 2,
      creditColumn: 3,
      balanceColumn: null,
    };
    const out = normaliseRows(rows, m).rows;
    expect(out.map((r) => r.amountCents)).toEqual([-15_000, 2_000, null, null]);
    expect(out[2]!.errors).toContain('Both debit and credit have a value');
    expect(out[3]!.errors).toContain('Missing amount');

    const cr = normaliseRows([['2026-03-01', 'x', '100.00 DR', '']], {
      ...signed,
      hasHeader: false,
      balanceColumn: null,
    }).rows;
    expect(cr[0]!.amountCents).toBe(-10_000);
    const inv = normaliseRows([['2026-03-01', 'x', '100.00', '']], {
      ...signed,
      hasHeader: false,
      balanceColumn: null,
      invertSign: true,
    }).rows;
    expect(inv[0]!.amountCents).toBe(-10_000);
  });

  it('reports ambiguous day/month dates', () => {
    const { dateFormatUsed, dateFormatAmbiguous } = normaliseRows(
      [
        ['Date', 'D', 'A'],
        ['01/02/2026', 'x', '1'],
        ['03/04/2026', 'y', '2'],
      ],
      { ...signed, balanceColumn: null },
    );
    expect(dateFormatUsed).toBe('DD/MM/YYYY');
    expect(dateFormatAmbiguous).toBe(true);
  });
});

describe('guessMapping', () => {
  it('maps common header names', () => {
    const m = guessMapping([['Posting Date', 'Description', 'Debits', 'Credits', 'Balance']]);
    expect(m).toMatchObject({
      hasHeader: true,
      dateColumn: 0,
      descriptionColumn: 1,
      amountMode: 'debit_credit',
      debitColumn: 2,
      creditColumn: 3,
      balanceColumn: 4,
    });
    const s = guessMapping([['Date', 'Reference', 'Description', 'Amount', 'Balance']]);
    expect(s).toMatchObject({
      amountMode: 'signed',
      amountColumn: 3,
      descriptionColumn: 2,
      referenceColumn: 1,
      balanceColumn: 4,
    });
  });

  it('falls back to positional mapping without a header', () => {
    expect(guessMapping([['2026-03-01', 'Coffee', '-35.00']])).toMatchObject({
      hasHeader: false,
      dateColumn: 0,
      descriptionColumn: 1,
      amountColumn: 2,
    });
  });
});

describe('staging and duplicates', () => {
  const acc = makeAccount({ id: 'acc-1' });
  const row = (
    line: number,
    date: string,
    description: string,
    amountCents: number,
    reference: string | null = null,
  ) => ({
    line,
    raw: [],
    date,
    description,
    amountCents,
    reference,
    balanceCents: null,
    errors: [],
  });

  it('normalises descriptions in fingerprints and uses references when present', () => {
    expect(transactionFingerprint('a', '2026-03-01', -100, 'CHECKERS  Rosebank!!')).toBe(
      transactionFingerprint('a', '2026-03-01', -100, 'checkers rosebank'),
    );
    expect(transactionFingerprint('a', '2026-03-01', -100, 'x', 'REF1')).not.toBe(
      transactionFingerprint('a', '2026-03-01', -100, 'x', 'REF2'),
    );
  });

  it('marks re-imported rows as duplicates but keeps genuinely repeated purchases', () => {
    const fp = transactionFingerprint(acc.id, '2026-03-05', -3_500, 'Coffee');
    const existing = [
      makeTxn({
        accountId: acc.id,
        date: '2026-03-05',
        amountCents: -3_500,
        description: 'Coffee',
        source: 'csv',
        fingerprint: fp,
      }),
    ];
    const staged = stageRows(
      [row(2, '2026-03-05', 'Coffee', -3_500), row(3, '2026-03-05', 'Coffee', -3_500)],
      acc.id,
      existing,
    );
    expect(staged.map((s) => s.status)).toEqual(['duplicate', 'new']);
    expect(staged.map((s) => s.include)).toEqual([false, true]);
    expect(staged[1]!.identicalLines).toEqual([2]);
  });

  it('flags a likely match with a manually entered transaction, unticked by default', () => {
    const manual = makeTxn({
      accountId: acc.id,
      date: '2026-03-04',
      amountCents: -12_000,
      description: 'Lunch',
      source: 'manual',
    });
    const staged = stageRows([row(2, '2026-03-06', 'WOOLWORTHS FOOD', -12_000)], acc.id, [manual]);
    expect(staged[0]).toMatchObject({ status: 'possible_duplicate', include: false });
    expect(staged[0]!.duplicateOf).toMatchObject({
      transactionId: manual.id,
      reason: 'manual_entry_match',
    });
    // Outside the window or another account: new.
    expect(stageRows([row(2, '2026-03-10', 'X', -12_000)], acc.id, [manual])[0]!.status).toBe(
      'new',
    );
    expect(stageRows([row(2, '2026-03-04', 'X', -12_000)], 'other', [manual])[0]!.status).toBe(
      'new',
    );
  });

  it('ignores archived transactions and never includes invalid rows', () => {
    const fp = transactionFingerprint(acc.id, '2026-03-05', -100, 'X');
    const archived = makeTxn({
      accountId: acc.id,
      date: '2026-03-05',
      amountCents: -100,
      description: 'X',
      fingerprint: fp,
      source: 'csv',
      archived: true,
    });
    const bad = { ...row(3, '2026-03-05', 'Bad', -1), errors: ['Unreadable amount'] };
    const staged = stageRows([row(2, '2026-03-05', 'X', -100), bad], acc.id, [archived]);
    expect(staged.map((s) => [s.status, s.include])).toEqual([
      ['new', true],
      ['invalid', false],
    ]);
  });

  it('summarises the batch, including rows before the opening balance date', () => {
    const a = makeAccount({ openingBalanceDate: '2026-03-03' });
    const staged = stageRows(
      [row(2, '2026-03-01', 'In', 10_000), row(3, '2026-03-05', 'Out', -2_500)],
      a.id,
      [],
    );
    expect(summariseStaging(staged, a)).toMatchObject({
      totalRows: 2,
      selected: 2,
      selectedInCents: 10_000,
      selectedOutCents: 2_500,
      dateRange: { from: '2026-03-01', to: '2026-03-05' },
      beforeOpeningDate: 1,
    });
  });
});

describe('running balance check', () => {
  const r = (date: string, amountCents: number, balanceCents: number) => ({
    line: 0,
    raw: [],
    date,
    description: 'x',
    amountCents,
    reference: null,
    balanceCents,
    errors: [],
  });

  it('detects order and closing balance', () => {
    const asc = checkRunningBalance([
      r('2026-03-01', 1000, 11000),
      r('2026-03-02', -500, 10500),
      r('2026-03-03', -200, 10300),
    ]);
    expect(asc).toMatchObject({
      order: 'oldest_first',
      consistentPairs: 2,
      suggestInvertSign: false,
      closing: { date: '2026-03-03', balanceCents: 10300 },
    });
    const desc = checkRunningBalance([
      r('2026-03-03', -200, 10300),
      r('2026-03-02', -500, 10500),
      r('2026-03-01', 1000, 11000),
    ]);
    expect(desc).toMatchObject({
      order: 'newest_first',
      closing: { date: '2026-03-03', balanceCents: 10300 },
    });
  });

  it('suggests inverting signs when balances only agree that way', () => {
    const c = checkRunningBalance([
      r('2026-03-01', -1000, 11000),
      r('2026-03-02', 500, 10500),
      r('2026-03-03', 200, 10300),
    ]);
    expect(c?.suggestInvertSign).toBe(true);
    expect(checkRunningBalance([r('2026-03-01', 1, 1)])).toBeNull();
  });
});

describe('repeated imports across devices', () => {
  const t = (id: string, batch: string, extra: Partial<Parameters<typeof makeTxn>[0]> = {}) =>
    makeTxn({
      id,
      accountId: 'acc',
      source: 'csv',
      importBatchId: batch,
      fingerprint: 'fp-coffee',
      description: 'COFFEE',
      date: '2026-03-02',
      amountCents: -3_500,
      ...extra,
    });

  it('flags a statement imported in two batches', () => {
    const r = findRepeatedImports([t('a', 'b1'), t('b', 'b2')]);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ copies: 2, maxInOneFile: 1 });
  });

  it('allows genuine identical rows within one file, and ignores archived and manual entries', () => {
    expect(findRepeatedImports([t('a', 'b1'), t('b', 'b1')])).toEqual([]);
    // Two coffees in each of two overlapping statements = the same two purchases: still only 2 per file.
    expect(
      findRepeatedImports([t('a', 'b1'), t('b', 'b1'), t('c', 'b2'), t('d', 'b2')])[0],
    ).toMatchObject({ copies: 4, maxInOneFile: 2 });
    expect(findRepeatedImports([t('a', 'b1'), t('b', 'b2', { archived: true })])).toEqual([]);
    expect(findRepeatedImports([t('a', 'b1'), t('b', 'b2', { accountId: 'other' })])).toEqual([]);
  });
});
