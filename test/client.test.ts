import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { GetSalesClient } from '../src/client.js';
import { GETSALES_API_ORIGIN, serviceBaseUrl } from '../src/config.js';
import { GetSalesApiError } from '../src/errors.js';
import { VERSION } from '../src/version.js';
import { MockApi, envelope, noSleep } from './helpers/mockApi.js';

const KEY = 'gs_live_test0000000000000000000000000000000000';

describe('GetSalesClient', () => {
  it('builds every URL from the one origin constant and the service path', async () => {
    const api = new MockApi().on('GET', /provider-catalog$/, () => ({ json: envelope.action('provider-catalog', { entries: [] }) }));
    await new GetSalesClient({ apiKey: KEY, fetch: api.fetch }).listProviderCatalog();
    assert.equal(api.calls[0]?.url, `${GETSALES_API_ORIGIN}/integrations/v1/api/provider-catalog`);
    assert.equal(serviceBaseUrl('playtables', 'https://example.test/'), 'https://example.test/playtables/v1');
    assert.equal(api.calls[0]?.headers['user-agent'], `waterfall-enrichment/${VERSION}`);
  });

  it('retries a read-only call on 503, waiting retry_after when the server sends it', async () => {
    let calls = 0;
    const waits: number[] = [];
    const api = new MockApi().on('GET', /\/api\/playtable-runs\//, () => {
      calls += 1;
      return calls === 1
        ? { status: 503, json: envelope.error('service_unavailable', 'try again', { context: { retry_after: 2 } }) }
        : { json: envelope.get({ sid: 'pt_rn_test00000001' }, { progress: null }) };
    });
    const client = new GetSalesClient({ apiKey: KEY, fetch: api.fetch, sleep: async (ms) => void waits.push(ms) });
    const answer = await client.getPlaytableRun('pt_rn_test00000001');
    assert.equal(answer.item.sid, 'pt_rn_test00000001');
    assert.equal(calls, 2);
    assert.deepEqual(waits, [2_000]);
  });

  it('never retries a write', async () => {
    const api = new MockApi().on('POST', /\/api\/playtables$/, () => ({ status: 503, json: envelope.error('service_unavailable', 'busy') }));
    const client = new GetSalesClient({ apiKey: KEY, fetch: api.fetch, sleep: noSleep });
    await assert.rejects(client.createPlaytable({ name: 'x' }), GetSalesApiError);
    assert.equal(api.calls.length, 1);
  });

  it('prices through estimate_credits on the playtables service and answers its result', async () => {
    const result = {
      min: 0.5,
      expected: 1.25,
      max: 3,
      currency: 'credits',
      priced_at: '2026-11-08T09:00:00Z',
      basis: { rows: { form: 'scope', requested: null, matched: 1 }, rows_sampled: 0, sampled: false },
      actions: [
        {
          type: 'column',
          min: 0.5,
          expected: 1.25,
          max: 3,
          rows: 1,
          per_row: { min: 0.5, expected: 1.25, max: 3 },
          detail: { field_sid: 'pt_fd_test00000001', rows_matched: 1, rows_to_run: 1, steps: [] },
        },
      ],
    };
    const api = new MockApi().on('POST', /^\/playtables\/v1\/api\/playtable-fields\/estimate-credits$/, () => ({ json: envelope.action('estimate_credits', result) }));
    const client = new GetSalesClient({ apiKey: KEY, fetch: api.fetch });
    const body = {
      playtable_sid: 'pt_tb_test00000001',
      object_type: 'people' as const,
      rows: { object_sids: ['cr_pp_ada000000001'] },
      actions: [{ type: 'column' as const, field_sid: 'pt_fd_test00000001' }],
    };
    const estimate = await client.estimateCredits(body);
    assert.deepEqual(estimate, result);
    assert.equal(api.calls[0]?.url, `${GETSALES_API_ORIGIN}/playtables/v1/api/playtable-fields/estimate-credits`);
    assert.equal(api.calls[0]?.method, 'POST');
    assert.deepEqual(api.calls[0]?.body, body);
  });

  it('cancels through the one cancel route with the scope in the body, and refuses no scope or two before sending', async () => {
    const result = {
      dry_run: false,
      runs: [{ sid: 'pt_rn_test00000001', waiting: false, reverted_cells_count: 4, in_flight_cells_count: 2 }],
      cancelled_count: 1,
      reverted_cells_count: 4,
      in_flight_cells_count: 2,
      spent_credits: 3.5,
    };
    const api = new MockApi().on('POST', /^\/playtables\/v1\/api\/playtable-runs\/cancel$/, () => ({ json: envelope.action('cancel', result) }));
    const client = new GetSalesClient({ apiKey: KEY, fetch: api.fetch });
    assert.deepEqual(await client.cancelPlaytableRuns({ run_sid: 'pt_rn_test00000001', dry_run: false }), result);
    assert.equal(api.calls[0]?.url, `${GETSALES_API_ORIGIN}/playtables/v1/api/playtable-runs/cancel`);
    assert.deepEqual(api.calls[0]?.body, { run_sid: 'pt_rn_test00000001', dry_run: false });

    const twoScopes = { run_sid: 'pt_rn_test00000001', playtable_sid: 'pt_tb_test00000001' } as unknown as Parameters<GetSalesClient['cancelPlaytableRuns']>[0];
    const noScope = { dry_run: true } as unknown as Parameters<GetSalesClient['cancelPlaytableRuns']>[0];
    await assert.rejects(client.cancelPlaytableRuns(twoScopes), TypeError);
    await assert.rejects(client.cancelPlaytableRuns(noScope), TypeError);
    assert.equal(api.calls.length, 1, 'neither refused body reached the API');
  });

  it('turns the error envelope into a GetSalesApiError with code, reason, fields and trace id', async () => {
    const api = new MockApi().on('POST', /\/api\/playtable-fields$/, () => ({
      status: 403,
      json: envelope.error('forbidden', 'Not allowed', { suggestion: 'Ask an owner', context: { reason: 'can_manage_playtables' }, field_errors: { name: [{ rule: 'max', message: 'too long' }] } }),
    }));
    const client = new GetSalesClient({ apiKey: KEY, fetch: api.fetch });
    await assert.rejects(
      client.createPlaytableField({
        playtable_sid: 'pt_tb_test00000001',
        object_type: 'people',
        type: 'action_waterfall',
        name: 'x',
        payload: { steps: [], stop_on_first: true, output_mapping: null },
        config: { auto_run: false, run_condition: null, nl_condition: null, daily_credit_limit: null, preset_sid: null },
      }),
      (error: unknown) => {
        assert.ok(error instanceof GetSalesApiError);
        assert.equal(error.status, 403);
        assert.equal(error.code, 'forbidden');
        assert.equal(error.operationId, 'create_playtable_field');
        assert.equal(error.traceId, '0190f5b2-0000-7000-8000-000000000001');
        assert.match(error.message, /Reason: can_manage_playtables/);
        assert.match(error.message, /name: too long/);
        assert.match(error.message, /Which API key does it need/);
        return true;
      },
    );
  });

  it('reports an answer that is not an envelope', async () => {
    const api = new MockApi().on('GET', /provider-catalog$/, () => ({ status: 502, text: '<html>bad gateway</html>' }));
    const client = new GetSalesClient({ apiKey: KEY, fetch: api.fetch, sleep: noSleep, retries: 1 });
    await assert.rejects(client.listProviderCatalog(), /not a GetSales envelope \(HTTP 502\)/);
    assert.equal(api.calls.length, 2);
  });

  it('refuses a paid run without a positive budget before sending it', async () => {
    const api = new MockApi();
    const client = new GetSalesClient({ apiKey: KEY, fetch: api.fetch });
    for (const max_budget of [0, -1, Number.NaN]) {
      await assert.rejects(
        client.createPlaytableRun({ playtable_sid: 'pt_tb_test00000001', object_type: 'people', type: 'enrich', field_sids: ['pt_fd_test00000001'], scope: { object_sids: ['cr_pp_ada000000001'] }, max_budget }),
        TypeError,
      );
    }
    assert.equal(api.calls.length, 0);
  });

  it('refuses an upload URL that is not https, and an upload answer without a draft sid', async () => {
    const api = new MockApi().on('PUT', /\/uploads\//, () => ({ json: envelope.create({ sid: 'nope' }) }));
    const client = new GetSalesClient({ apiKey: KEY, fetch: api.fetch });
    await assert.rejects(client.uploadCsv('http://example.test/uploads/x', 'a\r\n1\r\n'), /not https/);
    await assert.rejects(client.uploadCsv(`${serviceBaseUrl('playtables')}/uploads/data-sources/x`, 'a\r\n1\r\n'), /no draft source sid/);
  });

  it('needs an API key', () => {
    assert.throws(() => new GetSalesClient({ apiKey: '  ' }), TypeError);
    assert.throws(() => new GetSalesClient({ apiKey: 'gs_live_a b' }), TypeError);
  });

  it('keeps VERSION equal to package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
    assert.equal(VERSION, pkg.version);
  });
});
