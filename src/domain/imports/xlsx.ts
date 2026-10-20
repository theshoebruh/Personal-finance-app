import { type Unzipped, unzipSync } from 'fflate';
import { CsvError, MAX_ROWS, type ParsedCsv, finaliseRows } from './csv';

/**
 * Minimal reader for Excel workbooks (.xlsx / .xlsm): the first visible sheet's cell values as rows
 * of text, ready for the same mapping and review steps as a CSV.
 *
 * Only stored values are read. Formulas are never evaluated (their last saved result is used) and
 * macros are never run. The file is untrusted, so decompression is limited (a small file can't
 * expand into gigabytes) and only the few parts needed are unpacked.
 */

/** Largest any single unpacked part may be. */
const MAX_PART_BYTES = 40 * 1024 * 1024;
/** Largest total of all unpacked parts. */
const MAX_TOTAL_BYTES = 80 * 1024 * 1024;

const MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** Built-in number formats that display dates or times (ECMA-376, 18.8.30). */
const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

export function isWorkbookFileName(name: string): boolean {
  return /\.(xlsx|xlsm)$/i.test(name);
}

function xml(text: string, part: string): Document {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) {
    throw new CsvError(`This Excel file is damaged (${part} can’t be read).`);
  }
  return doc;
}

function children(el: Element | Document, local: string): Element[] {
  return Array.from(el.getElementsByTagNameNS(MAIN_NS, local));
}

/** Excel writes characters XML can't hold (e.g. line breaks, control codes) as _xHHHH_. */
function decodeEscapes(text: string): string {
  return text.replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex: string) =>
    String.fromCharCode(parseInt(hex, 16)),
  );
}

/** "C12" → 2 (zero-based column index). */
function columnIndex(ref: string | null): number | null {
  const m = ref ? /^([A-Z]{1,3})\d+$/.exec(ref) : null;
  if (!m) return null;
  let n = 0;
  for (const ch of m[1]!) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Whether a custom number format shows a date (has d, m or y outside quotes and brackets). */
function isDateFormatCode(code: string): boolean {
  const plain = code
    .replace(/"[^"]*"/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\\./g, '');
  return /[dy]/i.test(plain) || (/m/i.test(plain) && !/[hs]/i.test(plain));
}

/** Excel serial date (days since 1899-12-30, or 1904-01-01 in 1904 mode) → "YYYY-MM-DD[ HH:MM]". */
function serialToDate(serial: number, date1904: boolean): string {
  const ms = Math.round((serial + (date1904 ? 1462 : 0)) * 86_400_000);
  const d = new Date(Date.UTC(1899, 11, 30) + ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const hasTime = d.getUTCHours() !== 0 || d.getUTCMinutes() !== 0;
  return hasTime ? `${date} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` : date;
}

/** A stored number as plain decimal text without float noise: 1234.5, -50, 0.07. */
function numberText(n: number): string {
  if (!Number.isFinite(n)) return '';
  return String(Math.round(n * 1e8) / 1e8);
}

function unzipParts(bytes: Uint8Array, wanted: (name: string) => boolean): Unzipped {
  let total = 0;
  let tooBig = false;
  let files: Unzipped;
  try {
    files = unzipSync(bytes, {
      filter: (f) => {
        if (!wanted(f.name)) return false;
        total += f.originalSize;
        if (f.originalSize > MAX_PART_BYTES || total > MAX_TOTAL_BYTES) {
          tooBig = true;
          return false;
        }
        return true;
      },
    });
  } catch {
    throw new CsvError(
      'This doesn’t look like an Excel (.xlsx) file. Old .xls workbooks aren’t supported: save it as .xlsx or CSV.',
    );
  }
  if (tooBig)
    throw new CsvError('This Excel file is too large to read. Export a shorter date range.');
  return files;
}

export function parseXlsx(bytes: Uint8Array): ParsedCsv {
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new CsvError(
      'This doesn’t look like an Excel (.xlsx) file. Old .xls workbooks aren’t supported: save it as .xlsx or CSV.',
    );
  }
  const text = (u: Uint8Array | undefined) => (u ? new TextDecoder().decode(u) : null);

  // 1. Workbook: which sheet comes first (skipping hidden ones), and the date system.
  const meta = unzipParts(bytes, (n) =>
    [
      'xl/workbook.xml',
      'xl/_rels/workbook.xml.rels',
      'xl/sharedStrings.xml',
      'xl/styles.xml',
    ].includes(n),
  );
  const workbookXml = text(meta['xl/workbook.xml']);
  if (!workbookXml) throw new CsvError('This Excel file has no sheets.');
  const workbook = xml(workbookXml, 'the workbook');
  const date1904 = ['1', 'true'].includes(
    children(workbook, 'workbookPr')[0]?.getAttribute('date1904') ?? '',
  );
  const sheets = children(workbook, 'sheet');
  const sheet = sheets.find((s) => !s.getAttribute('state')) ?? sheets[0];
  if (!sheet) throw new CsvError('This Excel file has no sheets.');
  const relId = sheet.getAttributeNS(REL_NS, 'id') ?? sheet.getAttribute('r:id');
  const rels = xml(
    text(meta['xl/_rels/workbook.xml.rels']) ?? '<Relationships/>',
    'the sheet list',
  );
  const target = Array.from(rels.getElementsByTagName('Relationship'))
    .find((r) => r.getAttribute('Id') === relId)
    ?.getAttribute('Target');
  if (!target) throw new CsvError('The first sheet of this Excel file can’t be found.');
  const sheetPath = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;

  // 2. Shared text and which cell styles are dates.
  const shared: string[] = [];
  const sharedXml = text(meta['xl/sharedStrings.xml']);
  if (sharedXml) {
    for (const si of children(xml(sharedXml, 'the text table'), 'si')) {
      // Rich text has several <t> runs; phonetic hints (<rPh>) are not part of the value.
      shared.push(
        decodeEscapes(
          children(si, 't')
            .filter((t) => (t.parentNode as Element | null)?.localName !== 'rPh')
            .map((t) => t.textContent ?? '')
            .join(''),
        ),
      );
    }
  }
  const dateStyles = new Set<number>();
  const stylesXml = text(meta['xl/styles.xml']);
  if (stylesXml) {
    const styles = xml(stylesXml, 'the styles');
    const custom = new Map(
      children(styles, 'numFmt').map((f) => [
        Number(f.getAttribute('numFmtId')),
        f.getAttribute('formatCode') ?? '',
      ]),
    );
    const cellXfs = children(styles, 'cellXfs')[0];
    if (cellXfs) {
      Array.from(cellXfs.children).forEach((xf, i) => {
        const id = Number(xf.getAttribute('numFmtId') ?? 0);
        const code = custom.get(id);
        if (BUILTIN_DATE_FORMATS.has(id) || (code !== undefined && isDateFormatCode(code))) {
          dateStyles.add(i);
        }
      });
    }
  }

  // 3. The sheet's cells.
  const sheetXml = text(unzipParts(bytes, (n) => n === sheetPath)[sheetPath]);
  if (!sheetXml) throw new CsvError('The first sheet of this Excel file can’t be read.');
  const rows: string[][] = [];
  for (const row of children(xml(sheetXml, 'the sheet'), 'row')) {
    if (rows.length > MAX_ROWS + 1) break; // finaliseRows reports it
    const cells: string[] = [];
    let next = 0;
    for (const c of children(row, 'c')) {
      const col = columnIndex(c.getAttribute('r')) ?? next;
      next = col + 1;
      const type = c.getAttribute('t') ?? 'n';
      const v = children(c, 'v')[0]?.textContent ?? '';
      let value = '';
      if (type === 's') value = shared[Number(v)] ?? '';
      else if (type === 'inlineStr')
        value = decodeEscapes(
          children(c, 't')
            .map((t) => t.textContent ?? '')
            .join(''),
        );
      else if (type === 'str') value = v;
      else if (type === 'b') value = v === '1' ? 'TRUE' : 'FALSE';
      else if (type === 'e') value = '';
      else if (v !== '') {
        const n = Number(v);
        value = dateStyles.has(Number(c.getAttribute('s') ?? -1))
          ? serialToDate(n, date1904)
          : numberText(n);
      }
      while (cells.length < col) cells.push('');
      cells[col] = value;
    }
    rows.push(cells);
  }
  const parsed = finaliseRows(rows, 'xlsx', [], 'spreadsheet');
  const name = sheet.getAttribute('name') ?? 'Sheet 1';
  return {
    ...parsed,
    note:
      sheets.length > 1
        ? `Read the sheet “${name}” (this workbook has ${sheets.length} sheets; only the first is imported).`
        : `Read the sheet “${name}”.`,
  };
}
