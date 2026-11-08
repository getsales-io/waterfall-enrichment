import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildWaterfallPayload, catalogProviders, parseStepsFile, type ChainOptions } from '../src/chain.js';
import { parseCsv } from '../src/csv.js';
import { UsageError } from '../src/errors.js';
import { planMapping } from '../src/mapping.js';
import { CATALOG, SIDS } from './helpers/scenario.js';

const peoplePlan = (csv = 'Full name,Company,Domain,Email\na,b,c,d\n') => planMapping(parseCsv(csv), 'people');
const companyPlan = () => planMapping(parseCsv('Company,Website\na,b\n'), 'company');

describe('catalogProviders', () => {
  it('lists the callable providers of an operation in catalog order, without ones lacking a platform key', () => {
    assert.deepEqual(catalogProviders(CATALOG, 'email.find'), ['hunter', 'findymail', 'anymailfinder']);
    assert.deepEqual(catalogProviders(CATALOG, 'email.verify'), ['emaillistverify']);
    assert.deepEqual(catalogProviders([{ ...CATALOG[1]!, provider: 'someone-new' }], 'email.find'), []);
  });
});

describe('buildWaterfallPayload, the work email chain', () => {
  it('takes the finders in the order given, after the row step, with the verifier', () => {
    const chain: ChainOptions = { kind: 'email', finders: ['findymail', 'hunter'], useRowEmail: true, verify: 'emaillistverify', acceptCatchAll: false };
    const { payload } = buildWaterfallPayload(chain, peoplePlan(), CATALOG);
    assert.deepEqual(
      payload.steps.map((step) => step.tool_sid),
      ['row:people.work_email', 'in:findymail.email.find', 'in:hunter.email.find'],
    );
    assert.deepEqual(payload.steps[0]?.params, {});
    assert.deepEqual(payload.steps[1]?.params, { full_name: '{{people.full_name}}', company_name: '{{people.company_name}}', domain: '{{company.domain}}' });
    assert.deepEqual(payload.verify, { tool_sid: 'in:emaillistverify.email.verify', params: {} });
    assert.equal(payload.accept_catch_all, false);
    assert.equal(payload.stop_on_first, true);
    assert.deepEqual(payload.output_mapping, [{ path: '$.email', target: 'people.work_email' }]);
  });

  it("verifies the row's own addresses alone when told to, and refuses that with no verifier", () => {
    const { payload } = buildWaterfallPayload({ kind: 'email', finders: [], useRowEmail: true, verify: 'emaillistverify' }, peoplePlan(), CATALOG);
    assert.deepEqual(
      payload.steps.map((step) => step.tool_sid),
      ['row:people.work_email'],
    );
    assert.throws(() => buildWaterfallPayload({ kind: 'email', finders: [], useRowEmail: true }, peoplePlan(), CATALOG), UsageError);
    assert.throws(() => buildWaterfallPayload({ kind: 'email', finders: [] }, peoplePlan(), CATALOG), /no finder was named/);
    assert.throws(() => buildWaterfallPayload({ kind: 'email' }, peoplePlan(), []), /catalog offers no email finder/);
  });

  it('refuses unknown, repeated or unpriced finders and an unknown verifier', () => {
    const plan = peoplePlan();
    assert.throws(() => buildWaterfallPayload({ kind: 'email', finders: ['nobody'] }, plan, CATALOG), /On offer: hunter, findymail, anymailfinder/);
    assert.throws(() => buildWaterfallPayload({ kind: 'email', finders: ['hunter', 'hunter'] }, plan, CATALOG), UsageError);
    assert.throws(() => buildWaterfallPayload({ kind: 'email', finders: ['custom'] }, plan, CATALOG), UsageError);
    assert.throws(() => buildWaterfallPayload({ kind: 'email', verify: 'hunter' }, plan, CATALOG), UsageError);
  });

  it('refuses finders when the rows carry neither a name with a company or domain, nor a public ID', () => {
    const plan = peoplePlan('Email,Notes\na,b\n');
    assert.throws(() => buildWaterfallPayload({ kind: 'email' }, plan, CATALOG), /name with a company or a domain/);
    const idOnly = peoplePlan('ln_nickname\nada-quill-example\n');
    const { payload } = buildWaterfallPayload({ kind: 'email' }, idOnly, CATALOG);
    assert.deepEqual(payload.steps[0]?.params, { linkedin_nickname: '{{people.ln_nickname}}' });
  });

  it('refuses the email chain on company rows', () => {
    assert.throws(() => buildWaterfallPayload({ kind: 'email' }, companyPlan(), CATALOG), UsageError);
  });
});

describe('buildWaterfallPayload, a written-out chain', () => {
  it('accepts the three documented step forms in the order given', () => {
    const chain: ChainOptions = {
      kind: 'steps',
      steps: [
        { tool_sid: 'row:people.work_email', params: {} },
        { tool_sid: `in:tool.${SIDS.tool}`, params: { q: '{{people.full_name}}' } },
        { tool_sid: 'in:hunter.email.find', params: { domain: '{{company.domain}}' } },
      ],
      stopOnFirst: false,
      outputMapping: [{ path: '$.email', target: 'people.work_email' }],
    };
    const { payload } = buildWaterfallPayload(chain, peoplePlan(), CATALOG);
    assert.deepEqual(
      payload.steps.map((step) => step.tool_sid),
      ['row:people.work_email', `in:tool.${SIDS.tool}`, 'in:hunter.email.find'],
    );
    assert.equal(payload.stop_on_first, false);
    assert.equal('verify' in payload, false);
  });

  it('refuses forms outside the spec, people steps on company rows, too many steps and bad mappings', () => {
    const plan = peoplePlan();
    const steps = (tool_sid: string): ChainOptions => ({ kind: 'steps', steps: [{ tool_sid, params: {} }] });
    assert.throws(() => buildWaterfallPayload(steps('enrich_person_basic'), plan, CATALOG), /not a step form/);
    assert.throws(() => buildWaterfallPayload(steps('in:acme.email.find'), plan, CATALOG), /not a provider/);
    assert.throws(() => buildWaterfallPayload(steps('in:hunter.email.guess'), plan, CATALOG), /not an operation/);
    assert.throws(() => buildWaterfallPayload(steps('in:serper.serp.search'), plan, CATALOG), /offers no serp.search on serper/);
    assert.throws(() => buildWaterfallPayload(steps('in:tool.in_tl_short'), plan, CATALOG), /not a step form/);
    assert.throws(() => buildWaterfallPayload(steps('row:people.work_email'), companyPlan(), CATALOG), /people rows only/);
    assert.throws(() => buildWaterfallPayload(steps('in:hunter.email.find'), companyPlan(), CATALOG), /people rows only/);
    const eleven: ChainOptions = { kind: 'steps', steps: Array.from({ length: 11 }, () => ({ tool_sid: `in:tool.${SIDS.tool}`, params: {} })) };
    assert.throws(() => buildWaterfallPayload(eleven, plan, CATALOG), /at most 10 steps/);
    const badMapping: ChainOptions = { kind: 'steps', steps: [{ tool_sid: `in:tool.${SIDS.tool}`, params: {} }], outputMapping: [{ path: '$.x', target: 'record.x' }] };
    assert.throws(() => buildWaterfallPayload(badMapping, plan, CATALOG), /people.<attribute> or company.<attribute>/);
  });

  it("knows the providers and operations of the current catalog's lists, and leaves offering them to the live catalog", () => {
    const plan = peoplePlan();
    const steps = (tool_sid: string): ChainOptions => ({ kind: 'steps', steps: [{ tool_sid, params: {} }] });
    for (const [provider, operation] of [
      ['pipedrive', 'crm.deal_upsert'],
      ['attio', 'crm.list_entry_add'],
      ['folk', 'crm.contact_upsert'],
      ['salesforce', 'crm.activity_log'],
      ['gohighlevel', 'crm.pipelines_list'],
      ['hubspot', 'crm.lists_list'],
    ] as const) {
      assert.throws(
        () => buildWaterfallPayload(steps(`in:${provider}.${operation}`), plan, CATALOG),
        new RegExp(`offers no ${operation.replace('.', '\\.')} on ${provider}`),
        `${provider} ${operation} is a step form of the API`,
      );
    }
  });

  it('refuses params on the verify step, which checks the address a finder returns', () => {
    const chain: ChainOptions = {
      kind: 'steps',
      steps: [{ tool_sid: 'in:hunter.email.find', params: { domain: '{{company.domain}}' } }],
      verify: { tool_sid: 'in:emaillistverify.email.verify', params: { email: '{{people.work_email}}' } },
    };
    assert.throws(() => buildWaterfallPayload(chain, peoplePlan(), CATALOG), /verify takes no params/);
    const plain: ChainOptions = { ...chain, verify: { tool_sid: 'in:emaillistverify.email.verify', params: {} } };
    assert.deepEqual(buildWaterfallPayload(plain, peoplePlan(), CATALOG).payload.verify, { tool_sid: 'in:emaillistverify.email.verify', params: {} });
  });
});

describe('parseStepsFile', () => {
  it('reads the payload keys, or a bare array of steps', () => {
    const chain = parseStepsFile({
      steps: [{ tool_sid: `in:tool.${SIDS.tool}`, params: { domain: '{{company.domain}}' } }],
      stop_on_first: true,
      output_mapping: [{ path: '$.domain', target: 'company.domain' }],
    });
    assert.equal(chain.kind, 'steps');
    assert.equal(chain.steps.length, 1);
    assert.deepEqual(chain.outputMapping, [{ path: '$.domain', target: 'company.domain' }]);
    assert.deepEqual(parseStepsFile([{ tool_sid: `in:tool.${SIDS.tool}` }]).steps, [{ tool_sid: `in:tool.${SIDS.tool}`, params: {} }]);
  });

  it('refuses unknown keys and wrong types, so a typo never reaches the API', () => {
    assert.throws(() => parseStepsFile({ steps: [], stop_first: true }), /unknown key "stop_first"/);
    assert.throws(() => parseStepsFile({ steps: [{ tool_sid: 1 }] }), UsageError);
    assert.throws(() => parseStepsFile({ steps: [{ tool_sid: 'x', parms: {} }] }), /unknown key "parms"/);
    assert.throws(() => parseStepsFile({ steps: 'x' }), UsageError);
    assert.throws(() => parseStepsFile('steps'), UsageError);
  });
});
