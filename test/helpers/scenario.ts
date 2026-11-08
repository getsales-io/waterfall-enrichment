import type { CreditsEstimate, DataSourceItem, FieldValue, ObjectType, ProviderCatalogEntry, RunProgress } from '../../src/types.js';
import { serviceBaseUrl } from '../../src/config.js';
import { MockApi, envelope, type RecordedCall } from './mockApi.js';

/** Invented sids, 18 characters each like the real ones. */
export const SIDS = {
  table: 'pt_tb_test00000001',
  otherTable: 'pt_tb_other0000001',
  source: 'ds_sc_test00000001',
  field: 'pt_fd_test00000001',
  otherField: 'pt_fd_other0000001',
  run: 'pt_rn_test00000001',
  ada: 'cr_pp_ada000000001',
  bruno: 'cr_pp_bruno0000001',
  chen: 'cr_pp_chen00000001',
  northwind: 'cr_co_north0000001',
  lumen: 'cr_co_lumen0000001',
  tool: 'in_tl_test00000001',
} as const;

/** Invented people on reserved example domains. Line 4 repeats line 1. */
export const PEOPLE_CSV =
  [
    'Full name,Company,Domain,Email,ln_nickname',
    'Ada Quill,Northwind Labs,northwind-labs.example,,ada-quill-example',
    'Bruno Vale,Harbor Pine,harborpine.example,,',
    'Chen Ito,Lumen Forge,lumenforge.example,chen@lumenforge.example,',
    'Ada Quill,Northwind Labs,northwind-labs.example,,ada-quill-example',
  ].join('\n') + '\n';

export const COMPANY_CSV = ['Company,Website', 'Northwind Labs,https://northwind-labs.example', 'Lumen Forge,https://lumenforge.example'].join('\n') + '\n';

const catalogEntry = (operation: string, provider: string, price: number, platformKey = true, model: string | null = null): ProviderCatalogEntry => ({
  operation,
  provider,
  model,
  name: `${operation}: ${provider}`,
  description: null,
  platform_key: platformKey,
  pricing_unit: 'per_call',
  price_min: price,
  price_expected: price,
  price_max: price,
  cacheable: operation.startsWith('email.'),
});

export const CATALOG: ProviderCatalogEntry[] = [
  catalogEntry('llm.generate', 'openai', 0.5, true, 'gpt-test'),
  catalogEntry('email.find', 'hunter', 1),
  catalogEntry('email.find', 'findymail', 1),
  catalogEntry('email.find', 'anymailfinder', 1),
  catalogEntry('email.find', 'custom', 1, false),
  catalogEntry('email.verify', 'emaillistverify', 0.1),
];

export const PEOPLE_ITEMS: DataSourceItem[] = [
  { sid: 'ds_it_test00000001', data_source_sid: SIDS.source, row_number: 1, status: 'promoted', status_reason: null, created_object_sid: SIDS.ada, already_in_playtable_sid: null, duplicate_action: null },
  {
    sid: 'ds_it_test00000002',
    data_source_sid: SIDS.source,
    row_number: 2,
    status: 'duplicate',
    status_reason: null,
    created_object_sid: SIDS.bruno,
    already_in_playtable_sid: SIDS.otherTable,
    duplicate_action: 'skipped',
  },
  { sid: 'ds_it_test00000003', data_source_sid: SIDS.source, row_number: 3, status: 'promoted', status_reason: null, created_object_sid: SIDS.chen, already_in_playtable_sid: null, duplicate_action: null },
  {
    sid: 'ds_it_test00000004',
    data_source_sid: SIDS.source,
    row_number: 4,
    status: 'duplicate',
    status_reason: null,
    created_object_sid: SIDS.ada,
    already_in_playtable_sid: SIDS.table,
    duplicate_action: 'skipped',
  },
];

export const COMPANY_ITEMS: DataSourceItem[] = [
  { sid: 'ds_it_test00000011', data_source_sid: SIDS.source, row_number: 1, status: 'promoted', status_reason: null, created_object_sid: SIDS.northwind, already_in_playtable_sid: null, duplicate_action: null },
  {
    sid: 'ds_it_test00000012',
    data_source_sid: SIDS.source,
    row_number: 2,
    status: 'duplicate',
    status_reason: null,
    created_object_sid: SIDS.lumen,
    already_in_playtable_sid: null,
    duplicate_action: 'membership_added',
  },
];

const cell = (objectSid: string, status: FieldValue['status'], value: string | null, cost: number | null, errorMsg: string | null): FieldValue => ({
  sid: `pt_vl_${objectSid.slice(6)}`,
  playtable_sid: SIDS.table,
  playtable_field_sid: SIDS.field,
  object_sid: objectSid,
  value,
  status,
  cost,
  error_msg: errorMsg,
  finished_at: '2026-11-03T10:05:00Z',
});

export const ADA_EMAIL = 'ada@northwind-labs.example';

export const PEOPLE_CELLS: Record<string, FieldValue | null> = {
  [SIDS.ada]: cell(SIDS.ada, 'done', JSON.stringify({ email: ADA_EMAIL, confidence: 95, verdict: 'valid' }), 1, null),
  [SIDS.chen]: cell(SIDS.chen, 'error', null, 0, 'not_found'),
};

export const COMPANY_CELLS: Record<string, FieldValue | null> = {
  [SIDS.northwind]: cell(SIDS.northwind, 'done', JSON.stringify({ employees: 42 }), 0.5, null),
  [SIDS.lumen]: cell(SIDS.lumen, 'done', '120', 0.5, null),
};

/** An `estimate_credits` answer for one column over the scope, with the numbers given. */
export const creditsEstimate = (min: number, expected: number, max: number, rows = 2): CreditsEstimate => ({
  min,
  expected,
  max,
  currency: 'credits',
  priced_at: '2026-11-03T10:01:00Z',
  basis: { rows: { form: 'scope', requested: null, matched: 2 }, rows_sampled: 0, sampled: false },
  actions: [
    {
      type: 'column',
      min,
      expected,
      max,
      rows,
      per_row: rows > 0 ? { min: min / rows, expected: expected / rows, max: max / rows } : null,
      detail: {
        field_sid: SIDS.field,
        rows_matched: 2,
        rows_to_run: rows,
        steps: [
          { tool_sid: 'in:hunter.email.find', price_min: 0, price_max: 1 },
          { tool_sid: 'in:findymail.email.find', price_min: 0, price_max: 1 },
          { tool_sid: 'in:anymailfinder.email.find', price_min: 0, price_max: 1 },
        ],
      },
    },
  ],
});

export const ESTIMATE: CreditsEstimate = creditsEstimate(0, 2.4, 6);

export const progress = (state: RunProgress['state'], processed: number, spent: number): RunProgress => ({
  state,
  total_jobs: 2,
  pending_jobs: 2 - processed,
  processed_jobs: processed,
  failed_jobs: 0,
  cancelled_at: state === 'cancelled' ? '2026-11-03T10:06:00Z' : null,
  spent_credits: spent,
});

export interface ScenarioOptions {
  objectType?: ObjectType;
  tableAlreadyExists?: boolean;
  fieldAutoRun?: boolean;
  previewHeaders?: string[];
  importStatus?: 'completed' | 'failed' | 'paused';
  importStatusReason?: string;
  items?: DataSourceItem[];
  estimate?: CreditsEstimate;
  runStates?: RunProgress[];
  /** The run had already ended when the cancel came: the cancel answers runs [] and stops nothing. */
  cancelFindsNothing?: boolean;
  cells?: Record<string, FieldValue | null>;
  catalog?: ProviderCatalogEntry[];
}

/** Live state the tests read after a run. */
export interface ScenarioState {
  uploadedBody: string | null;
  cancelled: boolean;
}

/** The whole API as one happy path, with knobs to break each step. */
export const flowApi = (options: ScenarioOptions = {}): { api: MockApi; state: ScenarioState } => {
  const objectType = options.objectType ?? 'people';
  const items = options.items ?? (objectType === 'people' ? PEOPLE_ITEMS : COMPANY_ITEMS);
  const cells = options.cells ?? (objectType === 'people' ? PEOPLE_CELLS : COMPANY_CELLS);
  const runStates = options.runStates ?? [progress('running', 1, 1), progress('finished', 2, 1)];
  const state: ScenarioState = { uploadedBody: null, cancelled: false };
  let dataSourcePolls = 0;
  let runPolls = 0;
  const api = new MockApi();
  const uploadUrl = `${serviceBaseUrl('playtables')}/uploads/data-sources/AbCdEfGhIjKlMnOpQrStUvWxYz012345?expires=1762165200&signature=test`;

  const dataSource = (status: string, reason: string | null = null): Record<string, unknown> => ({
    sid: SIDS.source,
    team_sid: 'ts_tm_test00000001',
    playtable_sid: SIDS.table,
    name: 'people.csv',
    type: 'csv',
    object_type: objectType,
    status,
    status_reason: reason,
    field_mapping: null,
  });

  api
    .on('GET', /^\/integrations\/v1\/api\/provider-catalog$/, () => ({
      json: envelope.action('provider-catalog', { entries: options.catalog ?? CATALOG }),
    }))
    .on('POST', /^\/playtables\/v1\/api\/playtables$/, (call: RecordedCall) => {
      const body = call.body as { name: string };
      return {
        json: envelope.create(
          {
            sid: SIDS.table,
            team_sid: 'ts_tm_test00000001',
            name: body.name,
            people_default_view_sid: 'pt_vw_test00000001',
            company_default_view_sid: 'pt_vw_test00000002',
            config: { auto_run: false },
          },
          options.tableAlreadyExists ?? false,
        ),
      };
    })
    .on('POST', /^\/playtables\/v1\/api\/data-sources\/upload-url$/, () => ({
      json: envelope.action('upload-url', {
        upload_url: uploadUrl,
        method: 'PUT',
        expires_at: '2026-11-03T10:15:00Z',
        max_bytes: 52_428_800,
        content_types: ['text/csv', 'text/plain'],
      }),
    }))
    .on('PUT', /^\/playtables\/v1\/uploads\/data-sources\//, (call) => {
      state.uploadedBody = call.rawBody ?? null;
      return { json: { ...(envelope.create(dataSource('draft')) as object), preview: { headers: [], rows: [], total_rows: 0 } } };
    })
    .on('GET', /^\/playtables\/v1\/api\/data-sources\/ds_sc_[A-Za-z0-9]{12}$/, (call) => {
      const include = call.query.getAll('include[]');
      if (include.includes('csv_preview')) {
        const lines = (state.uploadedBody ?? '').split('\r\n').filter((line) => line !== '');
        const headers = options.previewHeaders ?? (lines[0] ?? '').split(',');
        return { json: envelope.get(dataSource('draft'), { csv_preview: { headers, rows: [], total_rows: lines.length - 1 } }) };
      }
      dataSourcePolls += 1;
      const promoted = items.filter((item) => item.status === 'promoted').length;
      const funnel: Record<string, number> = {};
      for (const item of items) funnel[item.status] = (funnel[item.status] ?? 0) + 1;
      if (dataSourcePolls === 1) {
        return {
          json: envelope.get(dataSource('active'), {
            data_source_items_counts: { total_count: items.length, groups: { status: [] } },
            indexed_counts: { total_count: 0 },
          }),
        };
      }
      const status = options.importStatus ?? 'completed';
      return {
        json: envelope.get(dataSource(status, options.importStatusReason ?? null), {
          data_source_items_counts: { total_count: items.length, groups: { status: funnel } },
          indexed_counts: { total_count: promoted },
        }),
      };
    })
    .on('POST', /^\/playtables\/v1\/api\/data-sources\/ds_sc_[A-Za-z0-9]{12}\/import$/, () => ({
      json: envelope.action(
        'import',
        { total_rows: items.length, pending: { expected_completion_seconds: 60, webhook_events: ['data-sources.completed', 'data-sources.failed'], polling_hint: 'poll get' } },
        dataSource('active'),
      ),
    }))
    .on('POST', /^\/playtables\/v1\/api\/data-source-items\/search$/, (call) => {
      const cursor = (call.body as { cursor?: string | null }).cursor ?? null;
      const page = cursor === null ? items.slice(0, 2) : items.slice(2);
      return { json: envelope.search(page.map((item) => ({ item })), cursor === null && items.length > 2 ? 'cursor-2' : null) };
    })
    .on('POST', /^\/playtables\/v1\/api\/playtable-fields$/, (call) => {
      const body = call.body as { name: string; type: string };
      return {
        json: envelope.create({
          sid: SIDS.field,
          playtable_sid: SIDS.table,
          object_type: objectType,
          name: body.name,
          slug: 'find_work_email',
          type: body.type,
          config: { auto_run: options.fieldAutoRun ?? false, run_condition: null, nl_condition: null, daily_credit_limit: null, preset_sid: null },
        }),
      };
    })
    .on('POST', /^\/playtables\/v1\/api\/playtable-fields\/estimate-credits$/, () => ({
      json: envelope.action('estimate_credits', options.estimate ?? ESTIMATE),
    }))
    .on('POST', /^\/playtables\/v1\/api\/playtable-runs$/, (call) => {
      const body = call.body as { max_budget: number; field_sids: string[] };
      return {
        json: envelope.create({
          sid: SIDS.run,
          playtable_sid: SIDS.table,
          object_type: objectType,
          type: 'enrich',
          field_sids: body.field_sids,
          max_budget: body.max_budget,
          estimated_cost: 2.4,
          created_at: '2026-11-03T10:02:00Z',
          finished_at: null,
        }),
      };
    })
    .on('GET', /^\/playtables\/v1\/api\/playtable-runs\/pt_rn_[A-Za-z0-9]{12}$/, () => {
      const answer = state.cancelled ? progress('cancelled', 1, 1) : (runStates[Math.min(runPolls, runStates.length - 1)] ?? progress('finished', 2, 1));
      runPolls += 1;
      return { json: envelope.get({ sid: SIDS.run, playtable_sid: SIDS.table, object_type: objectType, type: 'enrich' }, { progress: answer }) };
    })
    .on('POST', /^\/playtables\/v1\/api\/playtable-runs\/cancel$/, (call) => {
      const body = (call.body ?? {}) as { run_sid?: string; dry_run?: boolean };
      if (options.cancelFindsNothing || body.run_sid !== SIDS.run) {
        return {
          json: envelope.action('cancel', { dry_run: false, runs: [], cancelled_count: 0, reverted_cells_count: 0, in_flight_cells_count: 0, spent_credits: 2 }),
        };
      }
      state.cancelled = true;
      return {
        json: envelope.action('cancel', {
          dry_run: false,
          runs: [{ sid: SIDS.run, waiting: false, reverted_cells_count: 1, in_flight_cells_count: 1 }],
          cancelled_count: 1,
          reverted_cells_count: 1,
          in_flight_cells_count: 1,
          spent_credits: 1,
        }),
      };
    })
    .on('POST', /^\/playtables\/v1\/api\/people\/search$/, () => ({
      json: envelope.search(
        [SIDS.ada, SIDS.chen].map((sid) => ({
          item: { sid, playtable_sid: SIDS.table, work_email: null, email_status: null, status: 'ok' },
          included: {
            field_values: [
              { sid: 'pt_vl_widget000001', playtable_sid: SIDS.table, playtable_field_sid: SIDS.otherField, object_sid: sid, value: 'csv', status: 'done' },
              ...(cells[sid] ? [cells[sid]] : []),
            ],
          },
        })),
      ),
    }))
    .on('POST', /^\/playtables\/v1\/api\/companies\/search$/, () => ({
      json: envelope.search(
        [SIDS.northwind, SIDS.lumen].map((sid) => ({
          item: { sid, playtable_sids: [SIDS.table], domain: null, status: 'ok' },
          included: { field_values: cells[sid] ? [cells[sid]] : [] },
        })),
      ),
    }));

  return { api, state };
};
