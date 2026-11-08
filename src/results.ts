import type { GetSalesClient } from './client.js';
import { neutralizeFormula, serializeCsv, type Delimiter } from './csv.js';
import { MAX_PAGE_SIZE } from './spec.js';
import type { DataSourceItem, FieldValue, ObjectType, RowIncluded, SearchEnvelope } from './types.js';

/** The columns the enriched CSV appends to the input's own. */
export const RESULT_HEADERS = [
  'enrichment_status',
  'enrichment_result',
  'enrichment_verdict',
  'enrichment_confidence',
  'enrichment_credits',
  'enrichment_note',
  'getsales_sid',
] as const;

/** The waterfall cell of one table row, or null when the row has no cell for the column yet. */
export interface TableRow {
  sid: string;
  cell: FieldValue | null;
}

export interface ExportedCsv {
  headers: string[];
  rows: string[][];
  csv: string;
  /** Output rows per `enrichment_status` value. */
  counts: Record<string, number>;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const text = (value: unknown): string => (value === null || value === undefined ? '' : String(value));

/** Every staged row of a csv source, in CSV order. */
export const readDataSourceItems = async (client: GetSalesClient, dataSourceSid: string): Promise<DataSourceItem[]> => {
  const items: DataSourceItem[] = [];
  let cursor: string | null = null;
  do {
    const page = await client.searchDataSourceItems({
      filter: { data_source_sid: { eq: dataSourceSid } },
      sort: { field: 'row_number', direction: 'asc' },
      page_size: MAX_PAGE_SIZE,
      cursor,
    });
    for (const entry of page.items) items.push(entry.item);
    cursor = page.pagination.has_more ? page.pagination.next_cursor : null;
  } while (cursor);
  return items;
};

/** Every row of the table with its cell of the waterfall column. */
export const readTableRows = async (
  client: GetSalesClient,
  objectType: ObjectType,
  playtableSid: string,
  fieldSid: string,
): Promise<Map<string, TableRow>> => {
  const rows = new Map<string, TableRow>();
  const pick = (values: FieldValue[] | undefined): FieldValue | null =>
    values?.find((value) => value.playtable_field_sid === fieldSid && (value.playtable_sid === undefined || value.playtable_sid === playtableSid)) ?? null;
  let cursor: string | null = null;
  do {
    const page: SearchEnvelope<{ sid: string }, RowIncluded> =
      objectType === 'people'
        ? await client.searchPeople({
            filter: { playtable_sid: { eq: playtableSid } },
            include: ['field_values'],
            page_size: MAX_PAGE_SIZE,
            cursor,
          })
        : await client.searchCompanies({
            filter: { playtable_sids: { in: [playtableSid] } },
            include: ['field_values'],
            page_size: MAX_PAGE_SIZE,
            cursor,
          });
    for (const entry of page.items) rows.set(entry.item.sid, { sid: entry.item.sid, cell: pick(entry.included?.field_values) });
    cursor = page.pagination.has_more ? page.pagination.next_cursor : null;
  } while (cursor);
  return rows;
};

/**
 * Whether a staged row's object sits in the table the import fed: a promoted
 * row, a person repeated inside the same file, or a company added to the
 * table. A person already homed in another table is skipped, not moved.
 */
export const isInTable = (item: DataSourceItem, objectType: ObjectType, playtableSid: string): boolean => {
  if (item.created_object_sid === null) return false;
  if (item.status === 'promoted') return true;
  if (item.status !== 'duplicate') return false;
  if (objectType === 'people') return item.already_in_playtable_sid === playtableSid || item.duplicate_action === 'moved';
  return item.duplicate_action !== 'skipped' && item.duplicate_action !== 'disqualified';
};

/** The distinct objects of the table the import fed, in CSV order. */
export const objectsInTable = (items: readonly DataSourceItem[], objectType: ObjectType, playtableSid: string): string[] => {
  const sids: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!isInTable(item, objectType, playtableSid) || item.created_object_sid === null || seen.has(item.created_object_sid)) continue;
    seen.add(item.created_object_sid);
    sids.push(item.created_object_sid);
  }
  return sids;
};

/** Reads a cell value: an email finder stores a record `{email, confidence, verdict}`; other steps store their own value. */
export const readCellValue = (value: string | null | undefined): { result: string; verdict: string; confidence: string } => {
  if (value === null || value === undefined || value === '') return { result: '', verdict: '', confidence: '' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return { result: value, verdict: '', confidence: '' };
  }
  if (isRecord(parsed) && typeof parsed['email'] === 'string') {
    return { result: parsed['email'], verdict: text(parsed['verdict']), confidence: text(parsed['confidence']) };
  }
  if (typeof parsed === 'string') return { result: parsed, verdict: '', confidence: '' };
  return { result: value, verdict: '', confidence: '' };
};

const describeItem = (item: DataSourceItem): string => {
  switch (item.status) {
    case 'duplicate':
      return item.already_in_playtable_sid
        ? `already in another table (${item.already_in_playtable_sid}), ${item.duplicate_action ?? 'skipped'}`
        : `duplicate, ${item.duplicate_action ?? 'skipped'}`;
    case 'pending':
      return 'not processed yet';
    case 'promoted':
      return 'added, not visible in the table yet';
    default:
      return item.status_reason ?? '';
  }
};

const uniqueHeaders = (inputHeaders: readonly string[]): string[] => {
  const used = new Set(inputHeaders);
  return RESULT_HEADERS.map((header) => {
    let name: string = header;
    for (let n = 2; used.has(name); n += 1) name = `${header}_${n}`;
    used.add(name);
    return name;
  });
};

/**
 * Joins the input rows (in upload order) with the staged rows (by CSV row
 * number) and the table rows (by sid), and writes the enriched CSV: every
 * input column, then RESULT_HEADERS. The input columns are written exactly as
 * they came in. The appended values come from GetSales and its providers, so
 * each text value goes through neutralizeFormula, and the credits column
 * holds a number or nothing.
 */
export const buildEnrichedCsv = (args: {
  headers: readonly string[];
  rows: ReadonlyArray<readonly string[]>;
  delimiter: Delimiter;
  items: readonly DataSourceItem[];
  tableRows: ReadonlyMap<string, TableRow>;
}): ExportedCsv => {
  const byRowNumber = new Map<number, DataSourceItem>();
  for (const item of args.items) if (item.row_number !== null) byRowNumber.set(item.row_number, item);

  const counts: Record<string, number> = {};
  const credited = new Set<string>();
  const rows = args.rows.map((input, index) => {
    const item = byRowNumber.get(index + 1);
    let status: string;
    let result = '';
    let verdict = '';
    let confidence = '';
    let credits = '';
    let note = '';
    let sid = '';
    if (item === undefined) {
      status = 'not_imported';
      note = 'GetSales has no staged row for this line';
    } else {
      sid = item.created_object_sid ?? '';
      const tableRow = item.created_object_sid ? args.tableRows.get(item.created_object_sid) : undefined;
      if (tableRow) {
        const cell = tableRow.cell;
        status = cell?.status ?? 'empty';
        ({ result, verdict, confidence } = readCellValue(cell?.value));
        // A row's credits show on its first line only, so a sum over the column is what the run spent.
        if (!credited.has(tableRow.sid)) {
          credited.add(tableRow.sid);
          credits = typeof cell?.cost === 'number' && Number.isFinite(cell.cost) ? String(cell.cost) : '';
        }
        note = cell?.error_msg ?? (item.status === 'duplicate' ? 'same person or company as an earlier line' : '');
      } else {
        status = item.status;
        note = describeItem(item);
      }
    }
    counts[status] = (counts[status] ?? 0) + 1;
    const safe = neutralizeFormula;
    return [...input, safe(status), safe(result), safe(verdict), safe(confidence), credits, safe(note), safe(sid)];
  });

  const headers = [...args.headers, ...uniqueHeaders(args.headers)];
  return { headers, rows, csv: serializeCsv(headers, rows, args.delimiter), counts };
};
