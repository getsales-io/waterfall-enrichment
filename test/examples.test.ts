import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { buildWaterfallPayload, parseStepsFile } from '../src/chain.js';
import { parseCsv } from '../src/csv.js';
import { planMapping } from '../src/mapping.js';
import { CATALOG } from './helpers/scenario.js';

const read = (path: string): string => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

describe('the shipped examples', () => {
  it('examples/people.csv maps every column and builds the default chain', () => {
    const plan = planMapping(parseCsv(read('examples/people.csv')), 'people');
    assert.deepEqual(
      plan.columns.map((column) => column.target),
      ['full_name', 'company_name', 'company.domain', 'work_email', 'ln_nickname'],
    );
    const { payload } = buildWaterfallPayload({ kind: 'email', useRowEmail: true, verify: 'emaillistverify' }, plan, CATALOG);
    assert.equal(payload.steps.length, 4);
  });

  it('examples/company-steps.json builds a chain for examples/companies.csv', () => {
    const plan = planMapping(parseCsv(read('examples/companies.csv')), 'company');
    const chain = parseStepsFile(JSON.parse(read('examples/company-steps.json')));
    const { payload } = buildWaterfallPayload(chain, plan, CATALOG);
    assert.equal(payload.steps[0]?.tool_sid, 'in:tool.in_tl_YOURTOOLSID1');
  });

  it('the JSON steps example in the README is a valid steps file', () => {
    const block = /```json\n([\s\S]*?)```/.exec(read('README.md'))?.[1];
    assert.ok(block, 'README has a json block');
    const chain = parseStepsFile(JSON.parse(block));
    const plan = planMapping(parseCsv(read('examples/companies.csv')), 'company');
    assert.doesNotThrow(() => buildWaterfallPayload(chain, plan, CATALOG));
  });
});
