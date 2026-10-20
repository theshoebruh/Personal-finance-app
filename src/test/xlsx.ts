/** Test helper: builds small but valid Excel (.xlsx) workbooks from made-up rows. */
import { strToU8, zipSync } from 'fflate';

export type Cell =
  string | number | { f: string; v: string } | { date: number; style?: number } | null;
export interface Sheet {
  name: string;
  rows: Cell[][];
  hidden?: boolean;
}

const COLS = 'ABCDEFGHIJ';
const esc = (t: string) =>
  t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** Builds a minimal but valid .xlsx: shared strings, a date style (index 1) and a custom one (2). */
export function makeXlsx(
  sheets: Sheet[],
  opts: { date1904?: boolean; extra?: Record<string, Uint8Array> } = {},
) {
  const shared: string[] = [];
  const s = (t: string) => {
    const i = shared.indexOf(t);
    if (i >= 0) return i;
    shared.push(t);
    return shared.length - 1;
  };
  const files: Record<string, Uint8Array> = {};
  sheets.forEach((sheet, si) => {
    const rows = sheet.rows
      .map((row, ri) => {
        const cells = row
          .map((c, ci) => {
            const r = `${COLS[ci]}${ri + 1}`;
            if (c === null) return '';
            if (typeof c === 'number') return `<c r="${r}"><v>${c}</v></c>`;
            if (typeof c === 'string') {
              // Alternate shared and inline strings so both paths are covered.
              return ci % 2 === 0
                ? `<c r="${r}" t="s"><v>${s(c)}</v></c>`
                : `<c r="${r}" t="inlineStr"><is><t>${esc(c)}</t></is></c>`;
            }
            if ('f' in c) return `<c r="${r}" t="str"><f>${esc(c.f)}</f><v>${esc(c.v)}</v></c>`;
            return `<c r="${r}" s="${c.style ?? 1}"><v>${c.date}</v></c>`;
          })
          .join('');
        return `<row r="${ri + 1}">${cells}</row>`;
      })
      .join('');
    files[`xl/worksheets/sheet${si + 1}.xml`] = strToU8(
      `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`,
    );
  });
  files['xl/workbook.xml'] = strToU8(
    `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${
      opts.date1904 ? '<workbookPr date1904="1"/>' : ''
    }<sheets>${sheets
      .map(
        (sh, i) =>
          `<sheet name="${sh.name}" sheetId="${i + 1}"${sh.hidden ? ' state="hidden"' : ''} r:id="rId${i + 1}"/>`,
      )
      .join('')}</sheets></workbook>`,
  );
  files['xl/_rels/workbook.xml.rels'] = strToU8(
    `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
      .map(
        (_, i) =>
          `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
      )
      .join('')}</Relationships>`,
  );
  files['xl/sharedStrings.xml'] = strToU8(
    `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${shared
      .map((t) => `<si><t>${esc(t)}</t></si>`)
      .join('')}</sst>`,
  );
  files['xl/styles.xml'] = strToU8(
    `<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy\\ hh:mm"/></numFmts><cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/></cellXfs></styleSheet>`,
  );
  Object.assign(files, opts.extra);
  return zipSync(files);
}
