import { UsageError } from './errors.js';

/** The delimiters the parser recognizes. Output keeps the input's delimiter. */
export const DELIMITERS = [',', ';', '\t', '|'] as const;
export type Delimiter = (typeof DELIMITERS)[number];

/** A parsed CSV: one header row, then data rows padded to the header's width. */
export interface CsvTable {
  headers: string[];
  rows: string[][];
  delimiter: Delimiter;
}

export const isDelimiter = (value: string): value is Delimiter => (DELIMITERS as readonly string[]).includes(value);

const stripBom = (text: string): string => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

/**
 * Picks the delimiter that occurs most often in the header line, counting
 * only outside quotes. A comma wins ties and a line with none of them.
 */
export const detectDelimiter = (input: string): Delimiter => {
  const text = stripBom(input);
  const counts = new Map<Delimiter, number>(DELIMITERS.map((d) => [d, 0]));
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && (c === '\n' || c === '\r')) break;
    if (!inQuotes && c !== undefined && isDelimiter(c)) counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  let best: Delimiter = ',';
  for (const d of DELIMITERS) {
    if ((counts.get(d) ?? 0) > (counts.get(best) ?? 0)) best = d;
  }
  return best;
};

/** RFC 4180 records: quoted fields, doubled quotes, CRLF, LF or CR line ends. */
const parseRecords = (text: string, delimiter: Delimiter): string[][] => {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }
    if (c === '"' && field === '') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (c === delimiter) {
      record.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (c === '\r' || c === '\n') {
      record.push(field);
      records.push(record);
      record = [];
      field = '';
      i += c === '\r' && text[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    field += c;
    i += 1;
  }
  if (inQuotes) throw new UsageError('The CSV has a quoted field that never closes.');
  if (field !== '' || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  return records;
};

const isBlank = (record: string[]): boolean => record.every((value) => value.trim() === '');

/**
 * Parses a CSV whose first row is the header. Blank lines are dropped, short
 * rows are padded, and empty trailing fields past the header are dropped; a
 * row with real values past the header is refused, since no column holds them.
 */
export const parseCsv = (input: string, options: { delimiter?: Delimiter } = {}): CsvTable => {
  const text = stripBom(input);
  const delimiter = options.delimiter ?? detectDelimiter(text);
  const records = parseRecords(text, delimiter).filter((record) => !isBlank(record));
  const headerRecord = records[0];
  if (headerRecord === undefined) throw new UsageError('The CSV is empty: it needs a header row and at least one data row.');
  const headers = headerRecord.map((name) => name.trim());
  const width = headers.length;
  const rows = records.slice(1).map((record, index) => {
    if (record.length > width) {
      const extra = record.slice(width);
      if (!isBlank(extra)) {
        throw new UsageError(`Data row ${index + 1} has ${record.length} fields, the header has ${width}.`);
      }
      return record.slice(0, width);
    }
    return record.length < width ? [...record, ...Array<string>(width - record.length).fill('')] : record;
  });
  if (rows.length === 0) throw new UsageError('The CSV has a header row and no data rows.');
  return { headers, rows, delimiter };
};

/** The first characters that make Excel, Google Sheets or LibreOffice read a cell as a formula. */
const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * Guards a value that did not come from the user's own file (a provider's
 * answer, an error text) against spreadsheet formula injection: when it starts
 * with =, +, -, @, a tab or a carriage return it gets a leading apostrophe, so
 * the spreadsheet shows it as text and never evaluates it. Any other value is
 * returned as it is. CSV quoting alone does not do this, since a quoted cell
 * that starts with = is still a formula once the file is opened.
 */
export const neutralizeFormula = (value: string): string => (FORMULA_START.test(value) ? `'${value}` : value);

const needsQuotes = (value: string, delimiter: Delimiter): boolean =>
  value.includes(delimiter) || /["\r\n]/.test(value) || /^\s|\s$/.test(value);

const quote = (value: string, delimiter: Delimiter): string =>
  needsQuotes(value, delimiter) ? `"${value.replace(/"/g, '""')}"` : value;

/** Writes RFC 4180 CSV with CRLF line ends and a final line end. */
export const serializeCsv = (headers: readonly string[], rows: ReadonlyArray<readonly string[]>, delimiter: Delimiter = ','): string =>
  `${[headers, ...rows].map((row) => row.map((value) => quote(value, delimiter)).join(delimiter)).join('\r\n')}\r\n`;
