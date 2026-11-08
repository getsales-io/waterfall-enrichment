import { GETSALES_API_ORIGIN, serviceBaseUrl, type GetSalesService } from './config.js';
import { GetSalesApiError } from './errors.js';
import type {
  CancelPlaytableRunsRequest,
  CancelPlaytableRunsResult,
  Company,
  CreateDataSourceUploadUrlRequest,
  CreateEnrichRunRequest,
  CreatePlaytableFieldResponse,
  CreatePlaytableRequest,
  CreatePlaytableResponse,
  CreateWaterfallFieldRequest,
  CreditsEstimate,
  DataSource,
  DataSourceInclude,
  DataSourceIncluded,
  DataSourceItem,
  EstimateCreditsRequest,
  ImportDataSourceRequest,
  ImportDataSourceResult,
  McpErrorBody,
  Person,
  PlaytableRun,
  ProviderCatalogEntry,
  RowIncluded,
  RunProgress,
  SearchCompaniesRequest,
  SearchDataSourceItemsRequest,
  SearchEnvelope,
  SearchPeopleRequest,
  UploadUrlResult,
} from './types.js';
import { VERSION } from './version.js';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface GetSalesClientOptions {
  /** A GetSales API key (`gs_live_...`) or another bearer token the API accepts. */
  apiKey: string;
  /** API origin; defaults to the one constant in config.ts. */
  origin?: string;
  /** fetch implementation; defaults to the global fetch of Node 20+. */
  fetch?: FetchLike;
  /** Retries of a read-only call on a network error or HTTP 429, 502, 503 or 504. Default 3. */
  retries?: number;
  /** Wait function, replaceable in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** User-Agent header value. */
  userAgent?: string;
}

interface RequestSpec {
  operationId: string;
  service: GetSalesService;
  method: 'GET' | 'POST';
  path: string;
  query?: Array<[string, string]>;
  body?: unknown;
  /** Only read-only calls are retried; a write is sent once. */
  readOnly: boolean;
}

interface ActionEnvelope<R, I = unknown> {
  success: true;
  operation: 'action';
  action: string;
  item: I;
  result: R;
}

interface GetEnvelope<T, I> {
  success: true;
  operation: 'get';
  item: T;
  included?: I;
}

interface CreateEnvelope<T> {
  success: true;
  operation: 'create';
  item: T;
  already_exists: boolean;
}

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const DATA_SOURCE_SID = /^ds_sc_[A-Za-z0-9]{12}$/;

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const parseJson = (text: string): unknown => {
  if (text.trim() === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const errorBodyOf = (json: unknown): McpErrorBody | undefined => {
  if (!isRecord(json) || json['success'] !== false || !isRecord(json['error'])) return undefined;
  const error = json['error'];
  return typeof error['code'] === 'string' && typeof error['message'] === 'string' ? (error as unknown as McpErrorBody) : undefined;
};

const traceIdOf = (json: unknown, response: Response): string | undefined => {
  if (isRecord(json) && isRecord(json['meta']) && typeof json['meta']['trace_id'] === 'string') return json['meta']['trace_id'];
  return response.headers.get('x-trace-id') ?? undefined;
};

/**
 * A typed client for the GetSales API operations this package uses. Every
 * method maps to one operation of the public OpenAPI (its operationId is in
 * the method's comment). Answers are the API's own envelopes.
 */
export class GetSalesClient {
  private readonly apiKey: string;
  private readonly origin: string;
  private readonly fetchImpl: FetchLike;
  private readonly retries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly userAgent: string;

  constructor(options: GetSalesClientOptions) {
    const apiKey = options.apiKey?.trim() ?? '';
    if (apiKey === '' || /\s/.test(apiKey)) {
      throw new TypeError('GetSalesClient needs an API key: one token with no spaces (gs_live_...).');
    }
    const fetchImpl = options.fetch ?? (globalThis.fetch as FetchLike | undefined);
    if (fetchImpl === undefined) throw new TypeError('No fetch implementation: use Node 20 or later, or pass options.fetch.');
    this.apiKey = apiKey;
    this.origin = options.origin ?? GETSALES_API_ORIGIN;
    this.fetchImpl = fetchImpl;
    this.retries = Math.max(0, options.retries ?? 3);
    this.sleep = options.sleep ?? defaultSleep;
    this.userAgent = options.userAgent ?? `waterfall-enrichment/${VERSION}`;
  }

  // ------------------------------------------------------------ playtables

  /** `create_playtable`: POST /api/playtables. */
  async createPlaytable(body: CreatePlaytableRequest): Promise<CreatePlaytableResponse> {
    return this.send<CreatePlaytableResponse>({
      operationId: 'create_playtable',
      service: 'playtables',
      method: 'POST',
      path: '/api/playtables',
      body,
      readOnly: false,
    });
  }

  /** `create_data_source_upload_url`: POST /api/data-sources/upload-url. */
  async createDataSourceUploadUrl(body: CreateDataSourceUploadUrlRequest): Promise<UploadUrlResult> {
    const envelope = await this.send<ActionEnvelope<UploadUrlResult>>({
      operationId: 'create_data_source_upload_url',
      service: 'playtables',
      method: 'POST',
      path: '/api/data-sources/upload-url',
      body,
      readOnly: false,
    });
    return envelope.result;
  }

  /**
   * The PUT half of `create_data_source_upload_url`: the raw CSV bytes go to the
   * signed URL as the body, with no bearer (the signature is the credential).
   * The answer is the `create` envelope of the draft csv source.
   */
  async uploadCsv(uploadUrl: string, csv: string, contentType = 'text/csv'): Promise<DataSource> {
    let url: URL;
    try {
      url = new URL(uploadUrl);
    } catch {
      throw new GetSalesApiError({ operationId: 'upload_csv', status: 0, fallbackMessage: 'the upload URL in the answer is not a URL' });
    }
    if (url.protocol !== 'https:') {
      throw new GetSalesApiError({ operationId: 'upload_csv', status: 0, fallbackMessage: 'the upload URL in the answer is not https' });
    }
    let response: Response;
    try {
      response = await this.fetchImpl(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': contentType, Accept: 'application/json', 'User-Agent': this.userAgent },
        body: csv,
      });
    } catch (error) {
      throw new GetSalesApiError({ operationId: 'upload_csv', status: 0, fallbackMessage: `network error: ${(error as Error).message}` });
    }
    const json = parseJson(await response.text());
    if (!response.ok || !isRecord(json) || json['success'] !== true) {
      throw this.apiError('upload_csv', response, json);
    }
    const envelope = json as unknown as CreateEnvelope<DataSource>;
    if (!isRecord(envelope.item) || typeof envelope.item.sid !== 'string' || !DATA_SOURCE_SID.test(envelope.item.sid)) {
      throw new GetSalesApiError({
        operationId: 'upload_csv',
        status: response.status,
        fallbackMessage: 'the upload answer carries no draft source sid (ds_sc_...)',
      });
    }
    return envelope.item;
  }

  /** `import_data_source`: POST /api/data-sources/{sid}/import. */
  async importDataSource(sid: string, body: ImportDataSourceRequest): Promise<{ item: DataSource | null; result: ImportDataSourceResult }> {
    const envelope = await this.send<ActionEnvelope<ImportDataSourceResult, DataSource | null>>({
      operationId: 'import_data_source',
      service: 'playtables',
      method: 'POST',
      path: `/api/data-sources/${encodeURIComponent(sid)}/import`,
      body,
      readOnly: false,
    });
    return { item: envelope.item, result: envelope.result };
  }

  /** `get_data_source`: GET /api/data-sources/{sid}. */
  async getDataSource(sid: string, include: DataSourceInclude[] = []): Promise<{ item: DataSource; included: DataSourceIncluded }> {
    const envelope = await this.send<GetEnvelope<DataSource, DataSourceIncluded>>({
      operationId: 'get_data_source',
      service: 'playtables',
      method: 'GET',
      path: `/api/data-sources/${encodeURIComponent(sid)}`,
      query: include.map((value) => ['include[]', value]),
      readOnly: true,
    });
    return { item: envelope.item, included: envelope.included ?? {} };
  }

  /** `search_data_source_items`: POST /api/data-source-items/search. */
  async searchDataSourceItems(body: SearchDataSourceItemsRequest): Promise<SearchEnvelope<DataSourceItem>> {
    return this.send<SearchEnvelope<DataSourceItem>>({
      operationId: 'search_data_source_items',
      service: 'playtables',
      method: 'POST',
      path: '/api/data-source-items/search',
      body,
      readOnly: true,
    });
  }

  /** `create_playtable_field`: POST /api/playtable-fields. */
  async createPlaytableField(body: CreateWaterfallFieldRequest): Promise<CreatePlaytableFieldResponse> {
    return this.send<CreatePlaytableFieldResponse>({
      operationId: 'create_playtable_field',
      service: 'playtables',
      method: 'POST',
      path: '/api/playtable-fields',
      body,
      readOnly: false,
    });
  }

  /**
   * `estimate_credits`: POST /api/playtable-fields/estimate-credits. Free,
   * writes nothing. Answers min, expected and max in credits. A run's
   * `max_budget` is set from `max`, never from `expected`.
   */
  async estimateCredits(body: EstimateCreditsRequest): Promise<CreditsEstimate> {
    const envelope = await this.send<ActionEnvelope<CreditsEstimate>>({
      operationId: 'estimate_credits',
      service: 'playtables',
      method: 'POST',
      path: '/api/playtable-fields/estimate-credits',
      body,
      readOnly: true,
    });
    return envelope.result;
  }

  /** `create_playtable_run`: POST /api/playtable-runs. The only paid call of the package. */
  async createPlaytableRun(body: CreateEnrichRunRequest): Promise<PlaytableRun> {
    if (!(typeof body.max_budget === 'number' && Number.isFinite(body.max_budget) && body.max_budget > 0)) {
      throw new TypeError('createPlaytableRun refuses a run without a positive max_budget.');
    }
    const envelope = await this.send<CreateEnvelope<PlaytableRun>>({
      operationId: 'create_playtable_run',
      service: 'playtables',
      method: 'POST',
      path: '/api/playtable-runs',
      body,
      readOnly: false,
    });
    return envelope.item;
  }

  /** `get_playtable_run`: GET /api/playtable-runs/{sid} with include[]=progress. */
  async getPlaytableRun(sid: string): Promise<{ item: PlaytableRun; progress: RunProgress | null }> {
    const envelope = await this.send<GetEnvelope<PlaytableRun, { progress?: RunProgress }>>({
      operationId: 'get_playtable_run',
      service: 'playtables',
      method: 'GET',
      path: `/api/playtable-runs/${encodeURIComponent(sid)}`,
      query: [['include[]', 'progress']],
      readOnly: true,
    });
    return { item: envelope.item, progress: envelope.included?.progress ?? null };
  }

  /**
   * `cancel_playtable_runs`: POST /api/playtable-runs/cancel. The body names
   * exactly one scope (`run_sid`, `field_sid` or `playtable_sid`), and a scope
   * with nothing left running answers `runs: []`. Queued cells go back, cells
   * a worker holds finish and are charged, spent credits stay spent.
   */
  async cancelPlaytableRuns(body: CancelPlaytableRunsRequest): Promise<CancelPlaytableRunsResult> {
    const named = (['run_sid', 'field_sid', 'playtable_sid'] as const).filter((key) => {
      const value: unknown = (body as Record<string, unknown>)[key];
      return typeof value === 'string' && value !== '';
    });
    if (named.length !== 1) {
      throw new TypeError('cancelPlaytableRuns takes exactly one of run_sid, field_sid or playtable_sid.');
    }
    const envelope = await this.send<ActionEnvelope<CancelPlaytableRunsResult>>({
      operationId: 'cancel_playtable_runs',
      service: 'playtables',
      method: 'POST',
      path: '/api/playtable-runs/cancel',
      body,
      readOnly: false,
    });
    return envelope.result;
  }

  /** `search_people`: POST /api/people/search. */
  async searchPeople(body: SearchPeopleRequest): Promise<SearchEnvelope<Person, RowIncluded>> {
    return this.send<SearchEnvelope<Person, RowIncluded>>({
      operationId: 'search_people',
      service: 'playtables',
      method: 'POST',
      path: '/api/people/search',
      body,
      readOnly: true,
    });
  }

  /** `search_companies`: POST /api/companies/search. */
  async searchCompanies(body: SearchCompaniesRequest): Promise<SearchEnvelope<Company, RowIncluded>> {
    return this.send<SearchEnvelope<Company, RowIncluded>>({
      operationId: 'search_companies',
      service: 'playtables',
      method: 'POST',
      path: '/api/companies/search',
      body,
      readOnly: true,
    });
  }

  // ---------------------------------------------------------- integrations

  /** `list_provider_catalog`: GET /api/provider-catalog on the integrations service. */
  async listProviderCatalog(): Promise<ProviderCatalogEntry[]> {
    const envelope = await this.send<ActionEnvelope<{ entries: ProviderCatalogEntry[] }>>({
      operationId: 'list_provider_catalog',
      service: 'integrations',
      method: 'GET',
      path: '/api/provider-catalog',
      readOnly: true,
    });
    return envelope.result.entries;
  }

  // ---------------------------------------------------------------- wiring

  private async send<T>(spec: RequestSpec): Promise<T> {
    const query = spec.query && spec.query.length > 0 ? `?${new URLSearchParams(spec.query).toString()}` : '';
    const url = `${serviceBaseUrl(spec.service, this.origin)}${spec.path}${query}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: 'application/json',
      'User-Agent': this.userAgent,
    };
    const init: RequestInit = { method: spec.method, headers };
    if (spec.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(spec.body);
    }

    const attempts = spec.readOnly ? this.retries + 1 : 1;
    for (let attempt = 1; ; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetchImpl(url, init);
      } catch (error) {
        if (attempt < attempts) {
          await this.sleep(this.backoff(attempt));
          continue;
        }
        throw new GetSalesApiError({
          operationId: spec.operationId,
          status: 0,
          fallbackMessage: `network error: ${(error as Error).message}`,
        });
      }

      const json = parseJson(await response.text());
      if (response.ok && isRecord(json) && json['success'] === true) return json as T;

      if (RETRYABLE_STATUS.has(response.status) && attempt < attempts) {
        await this.sleep(this.retryDelay(json, attempt));
        continue;
      }
      throw this.apiError(spec.operationId, response, json);
    }
  }

  private apiError(operationId: string, response: Response, json: unknown): GetSalesApiError {
    const args: ConstructorParameters<typeof GetSalesApiError>[0] = { operationId, status: response.status };
    const body = errorBodyOf(json);
    if (body) args.body = body;
    else args.fallbackMessage = `the answer was not a GetSales envelope (HTTP ${response.status})`;
    const traceId = traceIdOf(json, response);
    if (traceId) args.traceId = traceId;
    return new GetSalesApiError(args);
  }

  private backoff(attempt: number): number {
    return Math.min(8_000, 1_000 * 2 ** (attempt - 1));
  }

  /** The server's `error.context.retry_after` (seconds) when it sends one, else the backoff. */
  private retryDelay(json: unknown, attempt: number): number {
    const body = errorBodyOf(json);
    const retryAfter = body?.context?.['retry_after'];
    if (typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter >= 0) {
      return Math.min(60_000, Math.ceil(retryAfter * 1_000));
    }
    return this.backoff(attempt);
  }
}
