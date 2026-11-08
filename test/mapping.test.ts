import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseCsv } from '../src/csv.js';
import { UsageError } from '../src/errors.js';
import { parseMapOverrides, planMapping } from '../src/mapping.js';

describe('planMapping, people', () => {
  it('recognizes the usual headers and maps them by column index', () => {
    const table = parseCsv('E-mail,Full Name,Organisation,Company domain,LinkedIn public ID,Notes\nx,y,z,w,v,u\n');
    const plan = planMapping(table, 'people');
    assert.deepEqual(plan.entries, [
      { source: '0', target_kind: 'people_attribute', target: 'work_email' },
      { source: '1', target_kind: 'people_attribute', target: 'full_name' },
      { source: '2', target_kind: 'people_attribute', target: 'company_name' },
      { source: '3', target_kind: 'company_attribute', target: 'domain' },
      { source: '4', target_kind: 'people_attribute', target: 'ln_nickname' },
    ]);
    assert.deepEqual(plan.has, { name: true, company: true, domain: true, lnNickname: true, workEmail: true });
    assert.equal(plan.builtFullName, false);
    assert.deepEqual(plan.uploadHeaders, table.headers);
  });

  it('builds a Full name column from first and last name, appended to the uploaded copy', () => {
    const table = parseCsv('First name,Last name,Website\nAda,Quill,https://northwind-labs.example\nChen,,https://lumenforge.example\n');
    const plan = planMapping(table, 'people');
    assert.equal(plan.builtFullName, true);
    assert.deepEqual(plan.uploadHeaders, ['First name', 'Last name', 'Website', 'Full name']);
    assert.deepEqual(
      plan.uploadRows.map((row) => row[3]),
      ['Ada Quill', 'Chen'],
    );
    assert.deepEqual(plan.entries, [
      { source: '2', target_kind: 'company_attribute', target: 'website' },
      { source: '3', target_kind: 'people_attribute', target: 'full_name' },
    ]);
    assert.deepEqual(table.headers, ['First name', 'Last name', 'Website'], 'the input itself is untouched');
  });

  it('lets --map send a column anywhere, skip one, and win over recognition', () => {
    const table = parseCsv('Email,Backup email,Org,Name\na,b,c,d\n');
    const plan = planMapping(table, 'people', { 'Backup email': 'work_email', Email: 'personal_email', Name: null, org: 'company_name' });
    assert.deepEqual(plan.entries, [
      { source: '0', target_kind: 'people_attribute', target: 'personal_email' },
      { source: '1', target_kind: 'people_attribute', target: 'work_email' },
      { source: '2', target_kind: 'people_attribute', target: 'company_name' },
    ]);
    assert.equal(plan.has.name, false);
  });

  it('keeps the first column of a target and notes the rest', () => {
    const plan = planMapping(parseCsv('Email,Work email\na,b\n'), 'people');
    assert.deepEqual(plan.entries, [{ source: '0', target_kind: 'people_attribute', target: 'work_email' }]);
    assert.equal(plan.warnings.length, 1);
  });

  it('refuses an unknown column, an unknown target and two columns on one target', () => {
    const table = parseCsv('Email,Name\na,b\n');
    assert.throws(() => planMapping(table, 'people', { Phone: 'work_email' }), UsageError);
    assert.throws(() => planMapping(table, 'people', { Email: 'phone_number' }), UsageError);
    assert.throws(() => planMapping(table, 'people', { Email: 'work_email', Name: 'work_email' }), UsageError);
  });
});

describe('planMapping, companies', () => {
  it('maps a company CSV onto company attributes', () => {
    const plan = planMapping(parseCsv('Company,URL,ln_id\nNorthwind Labs,https://northwind-labs.example,1234\n'), 'company');
    assert.deepEqual(plan.entries, [
      { source: '0', target_kind: 'company_attribute', target: 'name' },
      { source: '1', target_kind: 'company_attribute', target: 'website' },
      { source: '2', target_kind: 'company_attribute', target: 'ln_id' },
    ]);
  });
});

describe('parseMapOverrides', () => {
  it('reads Header=target and Header=-, splitting on the last equals sign', () => {
    assert.deepEqual(parseMapOverrides(['Org=company_name', 'a=b=c=work_email', 'Notes=-']), {
      Org: 'company_name',
      'a=b=c': 'work_email',
      Notes: null,
    });
  });

  it('refuses a value with no target and a header named twice', () => {
    assert.throws(() => parseMapOverrides(['Org']), UsageError);
    assert.throws(() => parseMapOverrides(['Org=']), UsageError);
    assert.throws(() => parseMapOverrides(['Org=company_name', 'Org=-']), UsageError);
  });
});
