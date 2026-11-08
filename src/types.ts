/**
 * The slice of the GetSales public API this package uses, typed from the
 * public OpenAPI documents (services playtables and integrations). Only the
 * fields the package sends or reads are declared; the API may answer more.
 */

/** Which grid a row belongs to. */
export type ObjectType = 'people' | 'company';

/** The `meta` block of every answer. */
export interface Meta {
  trace_id: string;
  span_id?: string;
  timestamp?: string;
  duration_ms?: number;
  team_sid?: string | null;
  actor_type?: string | null;
}

/** `error` of the `McpError` envelope. `code` is one of the 16 codes of the error taxonomy. */
export interface McpErrorBody {
  code: string;
  message: string;
  recoverable: boolean;
  suggestion?: string;
  field_errors?: Record<string, Array<{ rule: string; message: string }>>;
  context?: Record<string, unknown>;
}

/** The failure envelope: `{success: false, error, meta}`. */
export interface McpErrorEnvelope {
  success: false;
  error: McpErrorBody;
  meta?: Meta;
}

/** `pagination` of a `search` answer. */
export interface Pagination {
  next_cursor: string | null;
  has_more: boolean;
  total_count: number | null;
}

/** A `search` answer: `items[]` of `{item, included?}` plus a forward cursor. */
export interface SearchEnvelope<T, I = Record<string, unknown>> {
  success: true;
  operation: 'search';
  items: Array<{ item: T; included?: I }>;
  pagination: Pagination;
  meta: Meta;
}

// ---------------------------------------------------------------- playtables

/**
 * `create_playtable` request. The table's own `config.auto_run` is left out:
 * the API stores it and reads it nowhere, since whether a column fires by
 * itself is the column's own `config.auto_run`.
 */
export interface CreatePlaytableRequest {
  name: string;
  description?: string | null;
}

/** The table row (`PlaytableDomain`), the fields this package reads. */
export interface Playtable {
  sid: string;
  name: string;
  people_default_view_sid: string;
  company_default_view_sid: string;
}

/** `create_playtable` answer. */
export interface CreatePlaytableResponse {
  success: true;
  operation: 'create';
  item: Playtable;
  already_exists: boolean;
  meta: Meta;
}

/** `create_data_source_upload_url` request. */
export interface CreateDataSourceUploadUrlRequest {
  playtable_sid: string;
  object_type?: ObjectType;
  mode?: 'create' | 'update';
  name?: string;
  on_duplicate?: 'skip' | 'move';
}

/** `result` of `create_data_source_upload_url`. */
export interface UploadUrlResult {
  upload_url: string;
  method: 'PUT';
  expires_at: string;
  max_bytes: number;
  content_types: string[];
}

/** `field_mapping[]` entry of a csv source. */
export interface FieldMappingEntry {
  /** CSV column index as a string ("3"). */
  source: string;
  target_kind: 'people_attribute' | 'company_attribute' | 'field_slug';
  target: string;
  name?: string | null;
}

export type DataSourceStatus = 'draft' | 'active' | 'paused' | 'completed' | 'failed';

/** The data source row (`DataSourceDomain`), the fields this package reads. */
export interface DataSource {
  sid: string;
  playtable_sid: string | null;
  name: string;
  type: string;
  object_type: ObjectType;
  status: DataSourceStatus;
  status_reason: string | null;
  field_mapping: FieldMappingEntry[] | null;
}

/** `import_data_source` request (mode `create`, so no `match`). */
export interface ImportDataSourceRequest {
  field_mapping: FieldMappingEntry[];
  object_type?: ObjectType;
  mode?: 'create';
  on_duplicate?: 'skip' | 'move';
}

/** `result` of `import_data_source`. */
export interface ImportDataSourceResult {
  total_rows: number;
  pending: {
    expected_completion_seconds: number;
    webhook_events: string[];
    polling_hint: string;
  };
}

export type DataSourceInclude = 'data_source_items_counts' | 'indexed_counts' | 'csv_preview';

/** `included` of `get_data_source`. */
export interface DataSourceIncluded {
  data_source_items_counts?: {
    total_count: number;
    /** The funnel by status; the API sends an empty array when there is nothing to group. */
    groups: { status: Record<string, number> | unknown[] };
  };
  indexed_counts?: { total_count: number };
  csv_preview?: { headers: string[]; rows: Array<Array<string | null>>; total_rows: number } | null;
}

export type DataSourceItemStatus = 'pending' | 'promoted' | 'duplicate' | 'stoplisted' | 'disqualified' | 'failed';

/** One staged CSV row (`search_data_source_items`), the fields this package reads. */
export interface DataSourceItem {
  sid: string;
  data_source_sid: string;
  /** 1-based CSV data-row position. */
  row_number: number | null;
  status: DataSourceItemStatus;
  status_reason: string | null;
  created_object_sid: string | null;
  already_in_playtable_sid: string | null;
  duplicate_action: 'skipped' | 'moved' | 'membership_added' | 'merged' | 'disqualified' | null;
}

/** `search_data_source_items` request. */
export interface SearchDataSourceItemsRequest {
  filter: { data_source_sid: { eq: string } };
  sort?: { field: 'created_at' | 'updated_at' | 'row_number'; direction?: 'asc' | 'desc' };
  page_size?: number;
  cursor?: string | null;
}

/** One step of an `action_waterfall` column. */
export interface WaterfallStep {
  tool_sid: string;
  params: Record<string, unknown>;
}

/** Winning result path onto a `people.<attr>` or `company.<attr>` target, fill-if-empty. */
export interface OutputMapping {
  path: string;
  target: string;
}

/** `payload` of an `action_waterfall` column. */
export interface WaterfallPayload {
  steps: WaterfallStep[];
  stop_on_first: boolean;
  output_mapping: OutputMapping[] | null;
  /** One `in:{provider}.email.verify` step with no params, run on every address a finder returns. */
  verify?: WaterfallStep | null;
  /** True (the API's default): a `catch_all` or `unknown` verdict accepts the address and ends the chain. */
  accept_catch_all?: boolean;
}

/**
 * `config` of an action column. The schema lists all five keys as required;
 * null is the documented "none" of each (run_condition null = always run).
 */
export interface ActionFieldConfig {
  auto_run: boolean;
  run_condition: null;
  nl_condition: null;
  daily_credit_limit: number | null;
  preset_sid: null;
}

/** `create_playtable_field` request, for the waterfall column this package adds. */
export interface CreateWaterfallFieldRequest {
  playtable_sid: string;
  object_type: ObjectType;
  type: 'action_waterfall';
  name: string;
  payload: WaterfallPayload;
  config: ActionFieldConfig;
  add_to_default_view?: boolean;
}

/** The column row (`PlaytableFieldDomain`), the fields this package reads. */
export interface PlaytableField {
  sid: string;
  playtable_sid: string;
  object_type: ObjectType;
  name: string;
  slug: string;
  type: string;
  config: { auto_run: boolean } | null;
}

/** `create_playtable_field` answer. */
export interface CreatePlaytableFieldResponse {
  success: true;
  operation: 'create';
  item: PlaytableField;
  already_exists: boolean;
  meta: Meta;
}

/** The scope form this package uses: explicit row sids (at most 10,000). */
export interface RunScope {
  object_sids: string[];
}

/**
 * A `column` action of `estimate_credits`: a saved action column run over the
 * rows, priced the way an enrich run over the same scope would run it.
 */
export interface EstimateCreditsColumnAction {
  type: 'column';
  field_sid: string;
  /** Count done cells as runnable again (they would be charged again). Default false. */
  force_rerun?: boolean | null;
  /** Price only the cells that have not run, or only the error cells: the run's own `params.cells`. */
  cells?: 'not_run' | 'error' | null;
}

/**
 * `estimate_credits` request, with the one action kind this package prices.
 * `rows` takes the run's own scope form, so the price covers the rows the run
 * would take. Omitted, a column is priced over its whole table.
 */
export interface EstimateCreditsRequest {
  /** The table (pt_tb_). Optional for a column action, which names its own table through its column. */
  playtable_sid?: string | null;
  object_type?: ObjectType | null;
  /** A count of rows (0 to 1,000,000), or the run's scope. */
  rows?: number | RunScope | null;
  /** 1 to 20 actions, priced in the order given and summed. */
  actions: EstimateCreditsColumnAction[];
}

/** `detail` of a `column` action in an `estimate_credits` answer. */
export interface ColumnEstimateDetail {
  field_sid: string;
  rows_matched: number;
  rows_to_run: number;
  steps: Array<{ tool_sid: string; price_min: number; price_max: number }>;
}

/** One priced action of an `estimate_credits` answer, in the order asked. */
export interface CreditsEstimateAction {
  type: 'column' | 'column_draft' | 'unit' | 'semantic_index' | 'play';
  /** Credits when every row ends on its cheapest step. */
  min: number;
  /** Credits the rows are expected to cost. */
  expected: number;
  /** Credits on the dearest path: what a run's `max_budget` is set from. */
  max: number;
  /** The rows the numbers cover: for a column, the rows the run would take. */
  rows: number;
  /** The price of one row, where a row has one. */
  per_row: { min: number; expected: number | null; max: number } | null;
  /** The engine's own breakdown: ColumnEstimateDetail for a `column` action. */
  detail: Record<string, unknown>;
}

/**
 * `result` of `estimate_credits`, in credits: the sums over the actions. The
 * API's rule is to pass `max` as a run's `max_budget`, never `expected`.
 */
export interface CreditsEstimate {
  /** Every row ends on its cheapest step. */
  min: number;
  /** What the rows are expected to cost. */
  expected: number;
  /** The dearest path: the budget a run is given. */
  max: number;
  currency: 'credits';
  /** ISO 8601 UTC: when the prices were read. */
  priced_at: string;
  basis: {
    /** `form` is count, scope or table. `matched` is the scope's row count (approximate), null for a count. */
    rows: { form: string; requested: number | null; matched: number | null };
    rows_sampled: number;
    sampled: boolean;
  };
  actions: CreditsEstimateAction[];
}

/**
 * `create_playtable_run` request, type `enrich`. `max_budget` is the run's
 * credit budget: the run stops once its recorded spend reaches it, and cells
 * already running can finish past it.
 */
export interface CreateEnrichRunRequest {
  playtable_sid: string;
  object_type: ObjectType;
  type: 'enrich';
  field_sids: string[];
  scope: RunScope;
  max_budget: number;
}

/** The run row (`PlaytableRunDomain`), the fields this package reads. */
export interface PlaytableRun {
  sid: string;
  playtable_sid: string;
  object_type: ObjectType;
  type: 'enrich' | 'export' | 'import' | 'bulk';
  field_sids: string[] | null;
  max_budget: number | null;
  estimated_cost: number | null;
  created_at: string;
  finished_at: string | null;
}

export type RunState = 'waiting' | 'resolving' | 'queued' | 'running' | 'finished' | 'cancelled';

/** `included.progress` of `get_playtable_run`. */
export interface RunProgress {
  state: RunState;
  total_jobs: number;
  pending_jobs: number;
  processed_jobs: number;
  failed_jobs: number;
  cancelled_at: string | null;
  spent_credits: number;
}

/**
 * `cancel_playtable_runs` request: exactly one scope, the run (`run_sid`),
 * every unfinished run holding a column (`field_sid`) or every unfinished run
 * of a table (`playtable_sid`). `dry_run: true` answers the counts and stops
 * nothing. False or absent stops the runs.
 */
export type CancelPlaytableRunsRequest =
  | { run_sid: string; field_sid?: never; playtable_sid?: never; dry_run?: boolean }
  | { field_sid: string; run_sid?: never; playtable_sid?: never; dry_run?: boolean }
  | { playtable_sid: string; run_sid?: never; field_sid?: never; dry_run?: boolean };

/** `result` of `cancel_playtable_runs`. */
export interface CancelPlaytableRunsResult {
  /** True: the counts are what a stop would do, and nothing was stopped. */
  dry_run: boolean;
  /** The unfinished runs found, empty when nothing was left running (the run had already ended). */
  runs: Array<{ sid: string; waiting: boolean; reverted_cells_count: number; in_flight_cells_count: number }>;
  /** Runs this call stopped (0 on a dry run, and a run that ended on its own meanwhile is not counted). */
  cancelled_count: number;
  /** Queued cells sent back to what they held before the run. */
  reverted_cells_count: number;
  /** Cells a worker held at the stop: they finish and are charged. */
  in_flight_cells_count: number;
  /** The runs' spend so far. The in-flight cells can still add to it. */
  spent_credits: number;
}

export type CellStatus = 'empty' | 'queued' | 'running' | 'done' | 'error' | 'run_condition_not_met';

/** A cell (`PlaytableFieldValueDomain`), as the people and companies searches hydrate it. */
export interface FieldValue {
  sid: string;
  playtable_sid?: string;
  playtable_field_sid?: string;
  object_sid?: string;
  value?: string | null;
  status?: CellStatus;
  cost?: number | null;
  error_msg?: string | null;
  finished_at?: string | null;
}

/** What a people or companies search attaches with `include: ["field_values"]`. */
export interface RowIncluded {
  field_values?: FieldValue[];
}

/** A person (`search_people` item), the fields this package reads. */
export interface Person {
  sid: string;
  playtable_sid: string;
  work_email: string | null;
  email_status: string | null;
  status: string;
}

/** A company (`search_companies` item), the fields this package reads. */
export interface Company {
  sid: string;
  playtable_sids: string[];
  domain: string | null;
  status: string;
}

/** `search_people` request, scoped to one table. */
export interface SearchPeopleRequest {
  filter: { playtable_sid: { eq: string } };
  include?: Array<'field_values'>;
  page_size?: number;
  cursor?: string | null;
}

/** `search_companies` request, scoped to one table. */
export interface SearchCompaniesRequest {
  filter: { playtable_sids: { in: string[] } };
  include?: Array<'field_values'>;
  page_size?: number;
  cursor?: string | null;
}

// -------------------------------------------------------------- integrations

/** One entry of `list_provider_catalog`, the fields this package reads. */
export interface ProviderCatalogEntry {
  operation: string;
  provider: string;
  model: string | null;
  name: string;
  description: string | null;
  platform_key: boolean;
  pricing_unit: string;
  price_min: number;
  price_expected: number;
  price_max: number;
  cacheable: boolean;
}
