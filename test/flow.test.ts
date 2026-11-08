import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GetSalesClient } from '../src/client.js';
import { parseCsv, serializeCsv } from '../src/csv.js';
import { enrichCsv, type ConfirmRequest, type EnrichEvent, type EnrichOptions } from '../src/enrich.js';
import { FlowError, UsageError } from '../src/errors.js';
import { RESULT_HEADERS } from '../src/results.js';
import { noSleep } from './helpers/mockApi.js';
import { ADA_EMAIL, COMPANY_CSV, ESTIMATE, PEOPLE_CSV, PEOPLE_ITEMS, SIDS, creditsEstimate, flowApi, progress, type ScenarioOptions } from './helpers/scenario.js';

const KEY = 'gs_live_test0000000000000000000000000000000000';

const setup = (scenario: ScenarioOptions = {}, overrides: Partial<EnrichOptions> = {}) => {
  const { api, state } = flowApi(scenario);
  const events: EnrichEvent[] = [];
  const confirms: ConfirmRequest[] = [];
  const client = new GetSalesClient({ apiKey: KEY, fetch: api.fetch, sleep: noSleep });
  const options: EnrichOptions = {
    client,
    csv: PEOPLE_CSV,
    fileName: 'people.csv',
    chain: { kind: 'email' },
    confirm: (request) => {
      confirms.push(request);
      return true;
    },
    onEvent: (event) => events.push(event),
    sleep: noSleep,
    now: () => new Date('2026-11-03T10:00:00Z'),
    ...overrides,
  };
  return { api, state, events, confirms, options };
};

const outputRows = (csv: string): Record<string, string>[] => {
  const table = parseCsv(csv);
  return table.rows.map((row) => Object.fromEntries(table.headers.map((header, i) => [header, row[i] ?? ''])));
};

describe('enrichCsv, the whole flow', () => {
  it('creates, uploads, imports, adds the column, estimates, runs once and exports, in that order', async () => {
    const { api, options } = setup();
    const result = await enrichCsv(options);

    assert.equal(result.outcome, 'finished');
    assert.deepEqual(
      api.trail().map((line) => line.replace(/\b(pt_tb_|ds_sc_|pt_fd_|pt_rn_)[A-Za-z0-9]{12}\b/g, '$1*')),
      [
        'GET /integrations/v1/api/provider-catalog',
        'POST /playtables/v1/api/playtables',
        'POST /playtables/v1/api/data-sources/upload-url',
        'PUT /playtables/v1/uploads/data-sources/AbCdEfGhIjKlMnOpQrStUvWxYz012345',
        'GET /playtables/v1/api/data-sources/ds_sc_*',
        'POST /playtables/v1/api/data-sources/ds_sc_*/import',
        'GET /playtables/v1/api/data-sources/ds_sc_*',
        'GET /playtables/v1/api/data-sources/ds_sc_*',
        'POST /playtables/v1/api/data-source-items/search',
        'POST /playtables/v1/api/data-source-items/search',
        'POST /playtables/v1/api/playtable-fields',
        'POST /playtables/v1/api/playtable-fields/estimate-credits',
        'POST /playtables/v1/api/playtable-runs',
        'GET /playtables/v1/api/playtable-runs/pt_rn_*',
        'GET /playtables/v1/api/playtable-runs/pt_rn_*',
        'POST /playtables/v1/api/people/search',
      ],
    );
    assert.equal(api.callsTo('POST', /\/playtable-runs$/).length, 1, 'exactly one run');
  });

  it('creates the table with no run setting of its own and the column with auto run off', async () => {
    const { api, options } = setup();
    await enrichCsv(options);
    const table = api.callsTo('POST', /\/api\/playtables$/)[0]?.body;
    // The table's config.auto_run is stored and read by nothing: the column's own flag decides.
    assert.deepEqual(table, { name: 'people 2026-11-03 10:00:00 UTC', description: 'Waterfall enrichment of people.csv' });
    const field = api.callsTo('POST', /\/playtable-fields$/)[0]?.body as Record<string, unknown>;
    assert.equal(field['type'], 'action_waterfall');
    assert.equal(field['object_type'], 'people');
    assert.equal(field['add_to_default_view'], true);
    assert.deepEqual(field['config'], { auto_run: false, run_condition: null, nl_condition: null, daily_credit_limit: null, preset_sid: null });
  });

  it('builds the chain from the catalog finders in catalog order, with the inputs the CSV carries', async () => {
    const { api, options } = setup();
    await enrichCsv(options);
    const payload = (api.callsTo('POST', /\/playtable-fields$/)[0]?.body as { payload: Record<string, unknown> }).payload;
    const inputs = { full_name: '{{people.full_name}}', linkedin_nickname: '{{people.ln_nickname}}', company_name: '{{people.company_name}}', domain: '{{company.domain}}' };
    assert.deepEqual(payload, {
      steps: [
        { tool_sid: 'in:hunter.email.find', params: inputs },
        { tool_sid: 'in:findymail.email.find', params: inputs },
        { tool_sid: 'in:anymailfinder.email.find', params: inputs },
      ],
      stop_on_first: true,
      output_mapping: [{ path: '$.email', target: 'people.work_email' }],
      verify: null,
      accept_catch_all: true,
    });
  });

  it('sends the CSV to the signed URL with no bearer, then maps the columns by index', async () => {
    const { api, state, options } = setup();
    await enrichCsv(options);
    const put = api.callsTo('PUT', /\/uploads\/data-sources\//)[0];
    assert.ok(put);
    assert.equal(put.headers['authorization'], undefined, 'no bearer on the signed upload');
    assert.equal(put.headers['content-type'], 'text/csv');
    const table = parseCsv(PEOPLE_CSV);
    assert.equal(state.uploadedBody, serializeCsv(table.headers, table.rows));

    const mint = api.callsTo('POST', /\/upload-url$/)[0]?.body;
    assert.deepEqual(mint, { playtable_sid: SIDS.table, object_type: 'people', mode: 'create', name: 'people.csv', on_duplicate: 'skip' });
    const importBody = api.callsTo('POST', /\/import$/)[0]?.body;
    assert.deepEqual(importBody, {
      field_mapping: [
        { source: '0', target_kind: 'people_attribute', target: 'full_name' },
        { source: '1', target_kind: 'people_attribute', target: 'company_name' },
        { source: '2', target_kind: 'company_attribute', target: 'domain' },
        { source: '3', target_kind: 'people_attribute', target: 'work_email' },
        { source: '4', target_kind: 'people_attribute', target: 'ln_nickname' },
      ],
      object_type: 'people',
      mode: 'create',
      on_duplicate: 'skip',
    });
    const every = api.calls.filter((call) => call.method !== 'PUT');
    assert.ok(every.every((call) => call.headers['authorization'] === `Bearer ${KEY}`), 'every API call carries the key');
  });

  it('prices the column with estimate_credits over the scope the run then takes, the rows of the new table only', async () => {
    const { api, options } = setup();
    await enrichCsv(options);
    const estimates = api.callsTo('POST', /^\/playtables\/v1\/api\/playtable-fields\/estimate-credits$/);
    assert.equal(estimates.length, 1);
    assert.deepEqual(estimates[0]?.body, {
      playtable_sid: SIDS.table,
      object_type: 'people',
      rows: { object_sids: [SIDS.ada, SIDS.chen] },
      actions: [{ type: 'column', field_sid: SIDS.field }],
    });
    assert.equal(api.callsTo('POST', /\/playtable-runs\/estimate$/).length, 0, 'the retired estimate route is never called');
    const run = api.callsTo('POST', /\/playtable-runs$/)[0]?.body as Record<string, unknown>;
    assert.deepEqual(run['scope'], { object_sids: [SIDS.ada, SIDS.chen] });
    assert.deepEqual(run['field_sids'], [SIDS.field]);
    assert.equal(run['type'], 'enrich');
    assert.equal(api.callsTo('GET', /\/playtable-runs\//)[0]?.query.getAll('include[]').join(','), 'progress');
  });

  it("takes the rows to run from the column's action of the estimate, and runs nothing when it has none", async () => {
    const { api, confirms, options } = setup({ estimate: creditsEstimate(0, 0, 0, 0) });
    const result = await enrichCsv(options);
    assert.equal(result.outcome, 'nothing_to_run');
    assert.equal(confirms.length, 0, 'nothing to ask about');
    assert.equal(api.callsTo('POST', /\/playtable-runs$/).length, 0);
    assert.ok(result.output, 'the CSV is still written');
  });

  it('writes every input row back with the result columns, joined by row number', async () => {
    const { options } = setup();
    const result = await enrichCsv(options);
    assert.ok(result.output);
    const table = parseCsv(result.output.csv);
    assert.deepEqual(table.headers, ['Full name', 'Company', 'Domain', 'Email', 'ln_nickname', ...RESULT_HEADERS]);
    const rows = outputRows(result.output.csv);
    assert.equal(rows.length, 4);
    assert.deepEqual(
      rows.map((row) => [row['enrichment_status'], row['enrichment_result'], row['enrichment_verdict'], row['enrichment_credits'], row['getsales_sid']]),
      [
        ['done', ADA_EMAIL, 'valid', '1', SIDS.ada],
        ['duplicate', '', '', '', SIDS.bruno],
        ['error', '', '', '0', SIDS.chen],
        ['done', ADA_EMAIL, 'valid', '', SIDS.ada],
      ],
    );
    assert.match(rows[1]?.['enrichment_note'] ?? '', /already in another table \(pt_tb_other0000001\)/);
    assert.equal(rows[2]?.['enrichment_note'], 'not_found');
    assert.equal(rows[3]?.['enrichment_note'], 'same person or company as an earlier line');
    assert.deepEqual(result.output.counts, { done: 2, duplicate: 1, error: 1 });
    assert.equal(result.spentCredits, 1);
  });
});

describe('enrichCsv, the credit budget', () => {
  it("sets the run's budget to the estimate's max, never its expected or min, when no budget is given", async () => {
    const { api, confirms, options } = setup({ estimate: creditsEstimate(1.5, 2.25, 6) });
    const result = await enrichCsv(options);
    const run = api.callsTo('POST', /\/playtable-runs$/)[0]?.body as { max_budget: number };
    assert.equal(run.max_budget, 6);
    assert.equal(result.maxBudget, 6);
    assert.equal(confirms[0]?.maxBudget, 6);
    assert.equal(confirms[0]?.budgetBelowMax, false);
    assert.equal(confirms[0]?.rowsToRun, 2);
    assert.deepEqual([confirms[0]?.estimate.min, confirms[0]?.estimate.expected, confirms[0]?.estimate.max], [1.5, 2.25, 6]);
  });

  it('runs with the caller budget, warns it may stop early, and reports a server cancel', async () => {
    const { api, events, confirms, options } = setup(
      { runStates: [progress('running', 1, 1), progress('cancelled', 1, 2)] },
      { maxCredits: 2 },
    );
    const result = await enrichCsv(options);
    const run = api.callsTo('POST', /\/playtable-runs$/)[0]?.body as { max_budget: number };
    assert.equal(run.max_budget, 2);
    assert.equal(confirms[0]?.budgetBelowMax, true);
    assert.ok(events.some((event) => event.type === 'warning' && /may stop before every row/.test(event.message)));
    assert.equal(result.outcome, 'cancelled');
    assert.equal(result.cancelledBy, 'server');
    assert.equal(result.spentCredits, 2);
    assert.equal(api.callsTo('POST', /\/cancel$/).length, 0, 'the server cancelled it, not the client');
    assert.ok(result.output, 'the rows done before the stop are still exported');
  });

  it('refuses a budget of 0, a negative budget and a budget that is not a number before any request', async () => {
    for (const maxCredits of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const { api, options } = setup({}, { maxCredits });
      await assert.rejects(enrichCsv(options), UsageError);
      assert.equal(api.calls.length, 0);
    }
  });

  it('never starts a run when confirm says no', async () => {
    const { api, options } = setup({}, { confirm: () => false });
    const result = await enrichCsv(options);
    assert.equal(result.outcome, 'declined');
    assert.equal(result.runSid, null);
    assert.equal(api.callsTo('POST', /\/playtable-runs$/).length, 0);
    assert.equal(result.output, null);
  });

  it('stops after the estimate with estimateOnly, and never asks', async () => {
    let asked = false;
    const { api, options } = setup({}, { estimateOnly: true, confirm: () => (asked = true) });
    const result = await enrichCsv(options);
    assert.equal(result.outcome, 'estimate_only');
    assert.equal(asked, false);
    assert.equal(api.callsTo('POST', /\/playtable-runs$/).length, 0);
    assert.equal(result.estimate?.max, ESTIMATE.max);
  });

  it('refuses to run when the estimate tops out at 0 and no budget is given', async () => {
    const { api, options } = setup({ estimate: creditsEstimate(0, 0, 0) });
    await assert.rejects(enrichCsv(options), FlowError);
    assert.equal(api.callsTo('POST', /\/playtable-runs$/).length, 0);
  });

  it('refuses a column the server answers with auto run on, before the estimate', async () => {
    const { api, options } = setup({ fieldAutoRun: true });
    await assert.rejects(enrichCsv(options), /auto run on/);
    assert.equal(api.callsTo('POST', /\/estimate-credits$/).length, 0);
    assert.equal(api.callsTo('POST', /\/playtable-runs$/).length, 0);
  });

  it('cancels the run through cancel_playtable_runs, naming the run, when the signal aborts during the run', async () => {
    const controller = new AbortController();
    const { api, events, options } = setup(
      { runStates: [progress('running', 1, 1), progress('running', 1, 1), progress('running', 1, 1)] },
      {
        signal: controller.signal,
        onEvent: (event) => {
          events.push(event);
          if (event.type === 'run_started') controller.abort();
        },
      },
    );
    const result = await enrichCsv(options);
    const cancels = api.callsTo('POST', /^\/playtables\/v1\/api\/playtable-runs\/cancel$/);
    assert.equal(cancels.length, 1);
    assert.deepEqual(cancels[0]?.body, { run_sid: SIDS.run, dry_run: false });
    assert.equal(api.callsTo('POST', /\/playtable-runs\/pt_rn_[A-Za-z0-9]{12}\/cancel$/).length, 0, 'the retired per-run route is never called');
    assert.deepEqual(
      events.find((event) => event.type === 'cancel_requested'),
      { type: 'cancel_requested', runSid: SIDS.run, stopped: true, revertedCells: 1, inFlightCells: 1, spentCredits: 1 },
    );
    assert.equal(result.outcome, 'cancelled');
    assert.equal(result.cancelledBy, 'you');
  });

  it('says GetSales stopped the run when the cancel finds it already ended', async () => {
    const controller = new AbortController();
    const { api, events, options } = setup(
      { runStates: [progress('running', 1, 1), progress('cancelled', 1, 2)], cancelFindsNothing: true },
      {
        signal: controller.signal,
        onEvent: (event) => {
          events.push(event);
          if (event.type === 'run_started') controller.abort();
        },
      },
    );
    const result = await enrichCsv(options);
    assert.equal(api.callsTo('POST', /\/playtable-runs\/cancel$/).length, 1);
    assert.equal(events.find((event) => event.type === 'cancel_requested' && event.stopped === false)?.type, 'cancel_requested');
    assert.equal(result.outcome, 'cancelled');
    assert.equal(result.cancelledBy, 'server', 'the cancel stopped nothing, so the stop was GetSales');
    assert.equal(result.spentCredits, 2);
  });
});

describe('enrichCsv, refusals', () => {
  it('stops when a table of that name already exists, before any upload', async () => {
    const { api, options } = setup({ tableAlreadyExists: true });
    await assert.rejects(enrichCsv(options), /already exists/);
    assert.equal(api.callsTo('POST', /\/upload-url$/).length, 0);
  });

  it('stops before the import when the server read another header', async () => {
    const { api, options } = setup({ previewHeaders: ['Name', 'Org', 'Domain', 'Email', 'ln_nickname'] });
    await assert.rejects(enrichCsv(options), (error: unknown) => {
      assert.ok(error instanceof FlowError);
      assert.equal(error.created.dataSourceSid, SIDS.source);
      return true;
    });
    assert.equal(api.callsTo('POST', /\/import$/).length, 0);
  });

  it('reports a failed import with its reason, and starts no column or run', async () => {
    const { api, options } = setup({ importStatus: 'failed', importStatusReason: 'allowance_exhausted' });
    await assert.rejects(enrichCsv(options), /allowance_exhausted/);
    assert.equal(api.callsTo('POST', /\/playtable-fields$/).length, 0);
  });

  it('runs nothing when no imported row landed in the new table', async () => {
    const elsewhere = PEOPLE_ITEMS.map((item) => ({ ...item, status: 'duplicate' as const, already_in_playtable_sid: SIDS.otherTable }));
    const { api, options } = setup({ items: elsewhere });
    const result = await enrichCsv(options);
    assert.equal(result.outcome, 'nothing_to_run');
    assert.equal(api.callsTo('POST', /\/playtable-fields$/).length, 0);
    assert.equal(api.callsTo('POST', /\/playtable-runs/).length, 0);
    assert.deepEqual(result.output?.counts, { duplicate: 4 });
  });

  it('refuses a finder the catalog does not offer, before creating anything', async () => {
    const { api, options } = setup({}, { chain: { kind: 'email', finders: ['custom'] } });
    await assert.rejects(enrichCsv(options), /not an email finder the provider catalog offers/);
    assert.deepEqual(api.trail(), ['GET /integrations/v1/api/provider-catalog']);
  });

  it('refuses more rows than one run takes, before any request', async () => {
    const rows = Array.from({ length: 10_001 }, (_, i) => `Person ${i},Northwind Labs,northwind-labs.example`);
    const { api, options } = setup({}, { csv: ['Full name,Company,Domain', ...rows].join('\n') });
    await assert.rejects(enrichCsv(options), /at most 10,000 rows and this CSV has 10,001/);
    assert.equal(api.calls.length, 0);
  });

  it('refuses the email chain on company rows before any request', async () => {
    const { api, options } = setup({}, { objectType: 'company', csv: COMPANY_CSV });
    await assert.rejects(enrichCsv(options), UsageError);
    assert.equal(api.calls.length, 0);
  });
});

describe('enrichCsv, company rows with your own tool', () => {
  it('builds the written-out chain, skips the catalog, and reads companies back', async () => {
    const { api, options } = setup(
      { objectType: 'company' },
      {
        objectType: 'company',
        csv: COMPANY_CSV,
        fileName: 'companies.csv',
        chain: { kind: 'steps', steps: [{ tool_sid: `in:tool.${SIDS.tool}`, params: { domain: '{{company.domain}}' } }] },
      },
    );
    const result = await enrichCsv(options);
    assert.equal(api.callsTo('GET', /provider-catalog/).length, 0);
    const field = api.callsTo('POST', /\/playtable-fields$/)[0]?.body as { name: string; payload: unknown; object_type: string };
    assert.equal(field.name, 'Waterfall');
    assert.equal(field.object_type, 'company');
    assert.deepEqual(field.payload, {
      steps: [{ tool_sid: `in:tool.${SIDS.tool}`, params: { domain: '{{company.domain}}' } }],
      stop_on_first: true,
      output_mapping: null,
    });
    const importBody = api.callsTo('POST', /\/import$/)[0]?.body as { field_mapping: unknown };
    assert.deepEqual(importBody.field_mapping, [
      { source: '0', target_kind: 'company_attribute', target: 'name' },
      { source: '1', target_kind: 'company_attribute', target: 'website' },
    ]);
    const run = api.callsTo('POST', /\/playtable-runs$/)[0]?.body as { scope: unknown };
    assert.deepEqual(run.scope, { object_sids: [SIDS.northwind, SIDS.lumen] });
    assert.equal(api.callsTo('POST', /\/companies\/search$/).length, 1);
    const rows = outputRows(result.output?.csv ?? '');
    assert.deepEqual(
      rows.map((row) => [row['enrichment_status'], row['enrichment_result']]),
      [
        ['done', '{"employees":42}'],
        ['done', '120'],
      ],
    );
  });
});
