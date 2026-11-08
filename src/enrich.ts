import { buildWaterfallPayload, chainNeedsCatalog, checkStepsChain, type ChainOptions } from './chain.js';
import type { GetSalesClient } from './client.js';
import { parseCsv, serializeCsv, type CsvTable, type Delimiter } from './csv.js';
import { FlowError, UsageError } from './errors.js';
import { planMapping, type MappedColumn, type MappingPlan } from './mapping.js';
import { buildEnrichedCsv, objectsInTable, readDataSourceItems, readTableRows, type ExportedCsv, type TableRow } from './results.js';
import { MAX_ROWS_PER_RUN } from './spec.js';
import type {
  CreditsEstimate,
  DataSourceIncluded,
  DataSourceItem,
  DataSourceStatus,
  ObjectType,
  ProviderCatalogEntry,
  RunProgress,
  WaterfallPayload,
} from './types.js';

/** What `confirm` is asked before the one paid call. */
export interface ConfirmRequest {
  playtableSid: string;
  fieldSid: string;
  columnName: string;
  /** Rows the run would enqueue. */
  rowsToRun: number;
  /** The price from `estimate_credits`: likely `expected`, at most `max`, at least `min`. */
  estimate: CreditsEstimate;
  /**
   * The run's credit budget (`max_budget`). GetSales stops the run once its
   * recorded spend reaches it, and cells already running can finish past it.
   */
  maxBudget: number;
  /** True when the budget sits below the estimate's maximum, so the run may stop before every row is tried. */
  budgetBelowMax: boolean;
}

export type EnrichEvent =
  | { type: 'parsed'; rows: number; headers: string[]; delimiter: Delimiter }
  | { type: 'mapped'; columns: MappedColumn[]; builtFullName: boolean }
  | { type: 'warning'; message: string }
  | { type: 'chain'; steps: string[]; verify: string | null }
  | { type: 'table_created'; playtableSid: string; name: string }
  | { type: 'uploaded'; dataSourceSid: string; bytes: number }
  | { type: 'import_started'; totalRows: number; expectedSeconds: number }
  | { type: 'import_progress'; status: DataSourceStatus; counts: Record<string, number>; indexed: number }
  | { type: 'import_done'; counts: Record<string, number>; inTable: number }
  | { type: 'column_created'; fieldSid: string; name: string }
  | { type: 'estimated'; estimate: CreditsEstimate; rowsToRun: number; maxBudget: number; budgetBelowMax: boolean }
  | { type: 'run_started'; runSid: string; maxBudget: number }
  | { type: 'run_progress'; progress: RunProgress }
  | {
      type: 'cancel_requested';
      runSid: string;
      /** False when the run had already ended, so the cancel stopped nothing. */
      stopped: boolean;
      /** Queued cells sent back. */
      revertedCells: number;
      /** Cells a worker held at the stop: they finish and are charged. */
      inFlightCells: number;
      spentCredits: number;
    }
  | { type: 'run_ended'; state: 'finished' | 'cancelled' | 'timed_out'; progress: RunProgress | null }
  | { type: 'exported'; rows: number; counts: Record<string, number> };

export interface EnrichOptions {
  client: GetSalesClient;
  /** The CSV text; the first row is the header. */
  csv: string;
  /** The file's name, used for the table and source names. */
  fileName: string;
  /** What each row is. Default `people`. */
  objectType?: ObjectType;
  chain: ChainOptions;
  /** Header to target name, or null to leave a column out (see PEOPLE_TARGETS and COMPANY_TARGETS). */
  mapping?: Readonly<Record<string, string | null>>;
  /** Force a delimiter instead of sniffing it from the header line. */
  delimiter?: Delimiter;
  /**
   * The run's credit budget (`max_budget`). Default: the estimate's maximum
   * (`max` of `estimate_credits`), the figure the API says a run's budget is
   * set from. GetSales checks the run's recorded spend before each paid call
   * and cancels the run once the spend reaches the budget. Cells already
   * running at that moment still finish and are charged, so the total can pass
   * the budget by what those cells cost.
   */
  maxCredits?: number;
  /** Name of the new table. Default: the file name and the UTC time. */
  tableName?: string;
  /** Name of the waterfall column. Default: "Find work email" for the email chain, else "Waterfall". */
  columnName?: string;
  /** Asked once, after the estimate and before the paid run. Return true to start it. */
  confirm: (request: ConfirmRequest) => boolean | Promise<boolean>;
  /** Stop after the estimate: the table, the import and the column exist, no run starts. */
  estimateOnly?: boolean;
  onEvent?: (event: EnrichEvent) => void;
  /** Wait between two polls. Default 5000 ms. */
  pollIntervalMs?: number;
  /** Give up on an import that has not finished after this long. Default 30 minutes. */
  importTimeoutMs?: number;
  /** How long to wait for imported rows to show in the table's search. Default 3 minutes. */
  indexTimeoutMs?: number;
  /** Stop waiting for the run after this long; the run goes on in GetSales. Default: no end. */
  runTimeoutMs?: number;
  /** Aborting before the run stops the flow; aborting during the run cancels it. */
  signal?: AbortSignal;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

export type EnrichOutcome = 'finished' | 'cancelled' | 'timed_out' | 'declined' | 'estimate_only' | 'nothing_to_run';

export interface EnrichResult {
  outcome: EnrichOutcome;
  /**
   * For a cancelled run: who cancelled it. `server` is GetSales stopping it, for
   * example once its spend reached the budget or the workspace ran out of credits.
   */
  cancelledBy: 'you' | 'server' | null;
  playtableSid: string;
  dataSourceSid: string;
  fieldSid: string | null;
  runSid: string | null;
  estimate: CreditsEstimate | null;
  maxBudget: number | null;
  spentCredits: number | null;
  /** The enriched CSV; null when no run started (declined, estimate only). */
  output: ExportedCsv | null;
}

const DEFAULT_POLL_MS = 5_000;
const DEFAULT_IMPORT_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_INDEX_TIMEOUT_MS = 3 * 60_000;
const SETTLE_REREADS = 5;
const SETTLE_DELAY_MS = 2_000;

const funnelOf = (included: DataSourceIncluded): Record<string, number> => {
  const groups = included.data_source_items_counts?.groups.status;
  if (!groups || Array.isArray(groups)) return {};
  const counts: Record<string, number> = {};
  for (const [status, count] of Object.entries(groups)) if (typeof count === 'number') counts[status] = count;
  return counts;
};

const pad2 = (n: number): string => String(n).padStart(2, '0');

const defaultTableName = (fileName: string, now: Date): string => {
  const base = fileName.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '').trim() || 'CSV';
  const stamp = `${now.getUTCFullYear()}-${pad2(now.getUTCMonth() + 1)}-${pad2(now.getUTCDate())} ${pad2(now.getUTCHours())}:${pad2(now.getUTCMinutes())}:${pad2(now.getUTCSeconds())} UTC`;
  return `${base.slice(0, 200)} ${stamp}`;
};

const checkName = (value: string, what: string): string => {
  const name = value.trim();
  if (name.length < 1 || name.length > 255) throw new UsageError(`The ${what} must be 1 to 255 characters.`);
  return name;
};

/** Abortable wait; resolves early when the signal aborts. */
const waitFor = (ms: number, signal: AbortSignal | undefined): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });

/** Everything checked before the first request: the CSV, the mapping, the chain's form, the budget. */
interface Prepared {
  table: CsvTable;
  plan: MappingPlan;
  objectType: ObjectType;
  uploadBody: string;
  tableName: string;
  columnName: string;
  pollIntervalMs: number;
}

const prepare = (options: EnrichOptions): Prepared => {
  const objectType = options.objectType ?? 'people';
  if (objectType !== 'people' && objectType !== 'company') throw new UsageError('objectType is people or company.');
  if (options.maxCredits !== undefined && !(Number.isFinite(options.maxCredits) && options.maxCredits > 0)) {
    throw new UsageError('The credit budget must be a number above 0.');
  }
  if (typeof options.confirm !== 'function') throw new UsageError('confirm is required: it is asked before the paid run.');
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_MS;
  if (!(pollIntervalMs >= 0)) throw new UsageError('pollIntervalMs must be 0 or more.');

  const table = parseCsv(options.csv, options.delimiter ? { delimiter: options.delimiter } : {});
  if (table.rows.length > MAX_ROWS_PER_RUN) {
    throw new UsageError(`One run takes at most ${MAX_ROWS_PER_RUN.toLocaleString('en-US')} rows and this CSV has ${table.rows.length.toLocaleString('en-US')}. Split it.`);
  }
  const plan = planMapping(table, objectType, options.mapping ?? {});
  if (options.chain.kind === 'steps') checkStepsChain(options.chain, objectType);
  else if (objectType !== 'people') {
    throw new UsageError('The work email chain runs on people rows. Company rows take a written-out chain (--steps).');
  }

  const now = (options.now ?? (() => new Date()))();
  return {
    table,
    plan,
    objectType,
    uploadBody: serializeCsv(plan.uploadHeaders, plan.uploadRows, ','),
    tableName: checkName(options.tableName ?? defaultTableName(options.fileName, now), 'table name'),
    columnName: checkName(options.columnName ?? (options.chain.kind === 'email' ? 'Find work email' : 'Waterfall'), 'column name'),
    pollIntervalMs,
  };
};

/**
 * Runs the whole flow on a new GetSales table: create the table, upload and
 * import the CSV, add the waterfall column (auto run off), price it with
 * `estimate_credits`, ask `confirm`, start one enrich run with `max_budget` as
 * its budget, poll it, and read the enriched rows back into a CSV.
 */
export const enrichCsv = async (options: EnrichOptions): Promise<EnrichResult> => {
  const prepared = prepare(options);
  const { client, signal } = options;
  const { table, plan, objectType, pollIntervalMs } = prepared;
  const emit = (event: EnrichEvent): void => options.onEvent?.(event);
  // An abort cuts a wait short so the flow reacts at once; once the run is
  // cancelled the signal stays aborted, so the waits after it run in full.
  const pause = (ms: number, abortable = true): Promise<void> =>
    options.sleep ? options.sleep(ms) : waitFor(ms, abortable ? signal : undefined);
  const clock = (): number => (options.now ? options.now().getTime() : Date.now());

  emit({ type: 'parsed', rows: table.rows.length, headers: table.headers, delimiter: table.delimiter });
  emit({ type: 'mapped', columns: plan.columns, builtFullName: plan.builtFullName });
  for (const message of plan.warnings) emit({ type: 'warning', message });

  // The chain is built and checked against the provider catalog before anything is created.
  const catalog: ProviderCatalogEntry[] = chainNeedsCatalog(options.chain) ? await client.listProviderCatalog() : [];
  const built = buildWaterfallPayload(options.chain, plan, catalog);
  const payload: WaterfallPayload = built.payload;
  for (const message of built.warnings) emit({ type: 'warning', message });
  emit({ type: 'chain', steps: payload.steps.map((step) => step.tool_sid), verify: payload.verify?.tool_sid ?? null });

  // 1. The table. What fires by itself is each column's own auto run, so the
  // table carries no run setting.
  const created = await client.createPlaytable({
    name: prepared.tableName,
    description: `Waterfall enrichment of ${options.fileName}`,
  });
  if (created.already_exists) {
    throw new FlowError(`A table named "${prepared.tableName}" already exists in the workspace. Pick another table name. Nothing was imported.`);
  }
  const playtableSid = created.item.sid;
  emit({ type: 'table_created', playtableSid, name: created.item.name });

  // 2. The upload: mint the signed URL, PUT the bytes, confirm the server read the same header and rows.
  const upload = await client.createDataSourceUploadUrl({
    playtable_sid: playtableSid,
    object_type: objectType,
    mode: 'create',
    name: options.fileName.replace(/^.*[\\/]/, '').slice(0, 255) || 'upload.csv',
    on_duplicate: 'skip',
  });
  const bytes = Buffer.byteLength(prepared.uploadBody, 'utf8');
  if (bytes > upload.max_bytes) {
    throw new FlowError(`The CSV is ${bytes} bytes and the upload takes at most ${upload.max_bytes}.`, { playtableSid });
  }
  const contentType = upload.content_types.includes('text/csv') ? 'text/csv' : (upload.content_types[0] ?? 'text/csv');
  const draft = await client.uploadCsv(upload.upload_url, prepared.uploadBody, contentType);
  const dataSourceSid = draft.sid;
  emit({ type: 'uploaded', dataSourceSid, bytes });

  const previewed = await client.getDataSource(dataSourceSid, ['csv_preview']);
  const preview = previewed.included.csv_preview;
  if (preview) {
    const headersMatch =
      preview.headers.length === plan.uploadHeaders.length &&
      plan.columns.every((column) => (preview.headers[column.index] ?? '').trim() === column.header.trim());
    if (!headersMatch || preview.total_rows !== plan.uploadRows.length) {
      throw new FlowError(
        `GetSales read the upload differently (header: ${preview.headers.join(', ')}; ${preview.total_rows} rows) ` +
          `than this tool wrote it (header: ${plan.uploadHeaders.join(', ')}; ${plan.uploadRows.length} rows). Nothing was imported.`,
        { playtableSid, dataSourceSid },
      );
    }
  } else {
    emit({ type: 'warning', message: 'GetSales sent no preview of the upload, so its header was not compared.' });
  }

  // 3. The import, then the wait until it ends and its rows show in the table's search.
  const imported = await client.importDataSource(dataSourceSid, {
    field_mapping: plan.entries,
    object_type: objectType,
    mode: 'create',
    on_duplicate: 'skip',
  });
  emit({ type: 'import_started', totalRows: imported.result.total_rows, expectedSeconds: imported.result.pending.expected_completion_seconds });

  const importStarted = clock();
  const importTimeoutMs = options.importTimeoutMs ?? DEFAULT_IMPORT_TIMEOUT_MS;
  const indexTimeoutMs = options.indexTimeoutMs ?? DEFAULT_INDEX_TIMEOUT_MS;
  let endedAt: number | null = null;
  let funnel: Record<string, number> = {};
  for (;;) {
    if (signal?.aborted) throw new FlowError('Stopped before the run. No credits were spent.', { playtableSid, dataSourceSid });
    const polled = await client.getDataSource(dataSourceSid, ['data_source_items_counts', 'indexed_counts']);
    funnel = funnelOf(polled.included);
    const indexed = polled.included.indexed_counts?.total_count ?? 0;
    emit({ type: 'import_progress', status: polled.item.status, counts: funnel, indexed });
    if (polled.item.status === 'failed' || polled.item.status === 'paused') {
      throw new FlowError(`The import stopped (${polled.item.status}${polled.item.status_reason ? `: ${polled.item.status_reason}` : ''}).`, {
        playtableSid,
        dataSourceSid,
      });
    }
    if (polled.item.status === 'completed') {
      endedAt ??= clock();
      if (indexed >= (funnel['promoted'] ?? 0)) break;
      if (clock() - endedAt >= indexTimeoutMs) {
        emit({ type: 'warning', message: `Only ${indexed} of ${funnel['promoted'] ?? 0} imported rows show in the table's search so far. Going on.` });
        break;
      }
    } else if (clock() - importStarted >= importTimeoutMs) {
      throw new FlowError('The import did not finish in time. It goes on in GetSales, no column was added and no credits were spent.', {
        playtableSid,
        dataSourceSid,
      });
    }
    await pause(pollIntervalMs);
  }

  const items: DataSourceItem[] = await readDataSourceItems(client, dataSourceSid);
  const scope = objectsInTable(items, objectType, playtableSid);
  emit({ type: 'import_done', counts: funnel, inTable: scope.length });

  const base = {
    cancelledBy: null,
    playtableSid,
    dataSourceSid,
    fieldSid: null as string | null,
    runSid: null as string | null,
    estimate: null as CreditsEstimate | null,
    maxBudget: null as number | null,
    spentCredits: null as number | null,
  };
  const exportRows = (tableRows: ReadonlyMap<string, TableRow>): ExportedCsv => {
    const output = buildEnrichedCsv({ headers: table.headers, rows: table.rows, delimiter: table.delimiter, items, tableRows });
    emit({ type: 'exported', rows: output.rows.length, counts: output.counts });
    return output;
  };
  if (scope.length === 0) {
    return { ...base, outcome: 'nothing_to_run', output: exportRows(new Map()) };
  }

  // 4. The waterfall column, auto run off: only the explicit run below spends credits.
  const field = await client.createPlaytableField({
    playtable_sid: playtableSid,
    object_type: objectType,
    type: 'action_waterfall',
    name: prepared.columnName,
    payload,
    config: { auto_run: false, run_condition: null, nl_condition: null, daily_credit_limit: null, preset_sid: null },
    add_to_default_view: true,
  });
  const fieldSid = field.item.sid;
  if (field.item.type !== 'action_waterfall') {
    throw new FlowError(`The table already has a column with this slug of type ${field.item.type}.`, { playtableSid, dataSourceSid, fieldSid });
  }
  if (field.item.config?.auto_run !== false) {
    throw new FlowError('The waterfall column answered with auto run on. No run was started.', { playtableSid, dataSourceSid, fieldSid });
  }
  emit({ type: 'column_created', fieldSid, name: field.item.name });

  // 5. The estimate (free): the column over the same scope the run will take.
  // The budget is the estimate's max unless the caller set one, never its
  // expected figure: a row billed above its expected price would stop the
  // run before the last rows.
  const estimate = await client.estimateCredits({
    playtable_sid: playtableSid,
    object_type: objectType,
    rows: { object_sids: scope },
    actions: [{ type: 'column', field_sid: fieldSid }],
  });
  const column =
    estimate.actions.find((action) => action.type === 'column' && action.detail['field_sid'] === fieldSid) ??
    estimate.actions.find((action) => action.type === 'column');
  const rowsToRun = column?.rows ?? estimate.basis?.rows?.matched ?? 0;
  const withField = { ...base, fieldSid, estimate };
  if (rowsToRun === 0) {
    return { ...withField, outcome: 'nothing_to_run', output: exportRows(await readTableRows(client, objectType, playtableSid, fieldSid)) };
  }
  const maxBudget = options.maxCredits ?? estimate.max;
  if (!(Number.isFinite(maxBudget) && maxBudget > 0)) {
    throw new FlowError('The estimate tops out at 0 credits, so there is no budget to run with. Set a credit budget to run anyway.', {
      playtableSid,
      dataSourceSid,
      fieldSid,
    });
  }
  const budgetBelowMax = maxBudget < estimate.max;
  emit({ type: 'estimated', estimate, rowsToRun, maxBudget, budgetBelowMax });
  if (budgetBelowMax) {
    emit({ type: 'warning', message: `The budget (${maxBudget} credits) is below the estimate's maximum (${estimate.max}), so the run may stop before every row is tried.` });
  }
  const withBudget = { ...withField, maxBudget };
  if (options.estimateOnly) return { ...withBudget, outcome: 'estimate_only', output: null };

  // 6. One explicit run with its budget, after the caller says yes.
  const confirmed = await options.confirm({ playtableSid, fieldSid, columnName: prepared.columnName, rowsToRun, estimate, maxBudget, budgetBelowMax });
  if (!confirmed || signal?.aborted) return { ...withBudget, outcome: 'declined', output: null };

  const run = await client.createPlaytableRun({
    playtable_sid: playtableSid,
    object_type: objectType,
    type: 'enrich',
    field_sids: [fieldSid],
    scope: { object_sids: scope },
    max_budget: maxBudget,
  });
  const runSid = run.sid;
  emit({ type: 'run_started', runSid, maxBudget });

  const runStarted = clock();
  let progress: RunProgress | null = null;
  let cancelRequested = false;
  // True once the cancel below stopped the run itself. A run that had already
  // ended (finished, or stopped by GetSales) answers with nothing cancelled.
  let stoppedByYou = false;
  let state: 'finished' | 'cancelled' | 'timed_out';
  for (;;) {
    if (signal?.aborted && !cancelRequested) {
      cancelRequested = true;
      const cancelled = await client.cancelPlaytableRuns({ run_sid: runSid, dry_run: false });
      stoppedByYou = cancelled.cancelled_count > 0;
      emit({
        type: 'cancel_requested',
        runSid,
        stopped: stoppedByYou,
        revertedCells: cancelled.reverted_cells_count,
        inFlightCells: cancelled.in_flight_cells_count,
        spentCredits: cancelled.spent_credits,
      });
    }
    progress = (await client.getPlaytableRun(runSid)).progress;
    if (progress) emit({ type: 'run_progress', progress });
    if (progress?.state === 'finished' || progress?.state === 'cancelled') {
      state = progress.state;
      break;
    }
    if (options.runTimeoutMs !== undefined && clock() - runStarted >= options.runTimeoutMs) {
      state = 'timed_out';
      break;
    }
    await pause(cancelRequested ? Math.min(pollIntervalMs, 1_000) : pollIntervalMs, !cancelRequested);
  }
  emit({ type: 'run_ended', state, progress });

  // 7. The export, after the cells settle (search can trail a fresh write by seconds).
  let tableRows = await readTableRows(client, objectType, playtableSid, fieldSid);
  if (state !== 'timed_out') {
    for (let reread = 0; reread < SETTLE_REREADS; reread += 1) {
      const unsettled = scope.some((sid) => {
        const row = tableRows.get(sid);
        return row === undefined || row.cell?.status === 'queued' || row.cell?.status === 'running';
      });
      if (!unsettled) break;
      await pause(SETTLE_DELAY_MS, false);
      tableRows = await readTableRows(client, objectType, playtableSid, fieldSid);
    }
  }

  return {
    ...withBudget,
    runSid,
    outcome: state,
    cancelledBy: state === 'cancelled' ? (stoppedByYou ? 'you' : 'server') : null,
    spentCredits: progress?.spent_credits ?? null,
    output: exportRows(tableRows),
  };
};

/** Re-reads a finished (or still going) enrichment into a CSV, from the sids the flow printed. */
export const exportEnrichment = async (options: {
  client: GetSalesClient;
  csv: string;
  delimiter?: Delimiter;
  objectType?: ObjectType;
  playtableSid: string;
  dataSourceSid: string;
  fieldSid: string;
}): Promise<ExportedCsv> => {
  const table = parseCsv(options.csv, options.delimiter ? { delimiter: options.delimiter } : {});
  const objectType = options.objectType ?? 'people';
  const items = await readDataSourceItems(options.client, options.dataSourceSid);
  const tableRows = await readTableRows(options.client, objectType, options.playtableSid, options.fieldSid);
  return buildEnrichedCsv({ headers: table.headers, rows: table.rows, delimiter: table.delimiter, items, tableRows });
};
