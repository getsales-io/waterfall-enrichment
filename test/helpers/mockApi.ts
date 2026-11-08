import type { FetchLike } from '../../src/client.js';

/** One request the code under test sent. */
export interface RecordedCall {
  method: string;
  url: string;
  /** The path without the origin, e.g. /playtables/v1/api/playtables. */
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  rawBody: string | undefined;
  body: unknown;
}

export interface MockAnswer {
  status?: number;
  json?: unknown;
  text?: string;
  headers?: Record<string, string>;
}

export type Handler = (call: RecordedCall) => MockAnswer | Promise<MockAnswer>;

const meta = { trace_id: '0190f5b2-0000-7000-8000-000000000001', span_id: '0123456789abcdef', timestamp: '2026-11-03T10:00:00Z', duration_ms: 3 };

/** The success envelopes, with a meta block. */
export const envelope = {
  create: (item: unknown, alreadyExists = false): unknown => ({ success: true, operation: 'create', item, already_exists: alreadyExists, meta }),
  action: (action: string, result: unknown, item: unknown = null): unknown => ({ success: true, operation: 'action', action, item, result, meta }),
  get: (item: unknown, included: unknown = {}): unknown => ({ success: true, operation: 'get', item, included, includes: [], meta }),
  search: (items: Array<{ item: unknown; included?: unknown }>, nextCursor: string | null = null): unknown => ({
    success: true,
    operation: 'search',
    items,
    pagination: { next_cursor: nextCursor, has_more: nextCursor !== null, total_count: null },
    applied_filters: {},
    includes: [],
    meta,
  }),
  error: (code: string, message: string, extra: Record<string, unknown> = {}): unknown => ({
    success: false,
    error: { code, message, recoverable: false, ...extra },
    meta,
  }),
};

/** A fetch stand-in that routes by method and path and records every call. */
export class MockApi {
  readonly calls: RecordedCall[] = [];
  private readonly routes: Array<{ method: string; pattern: RegExp; handler: Handler }> = [];

  on(method: string, pattern: RegExp, handler: Handler): this {
    this.routes.push({ method, pattern, handler });
    return this;
  }

  /** Calls whose method and path match. */
  callsTo(method: string, pattern: RegExp): RecordedCall[] {
    return this.calls.filter((call) => call.method === method && pattern.test(call.path));
  }

  /** "METHOD path" of every call, in order. */
  trail(): string[] {
    return this.calls.map((call) => `${call.method} ${call.path}`);
  }

  readonly fetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const rawBody = typeof init?.body === 'string' ? init.body : undefined;
    let body: unknown;
    if (rawBody !== undefined && headers['content-type'] === 'application/json') body = JSON.parse(rawBody);
    const call: RecordedCall = { method: init?.method ?? 'GET', url: input, path: url.pathname, query: url.searchParams, headers, rawBody, body };
    this.calls.push(call);
    const route = this.routes.find((r) => r.method === call.method && r.pattern.test(call.path));
    if (!route) {
      return new Response(JSON.stringify(envelope.error('not_found', `no mock for ${call.method} ${call.path}`)), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }
    const answer = await route.handler(call);
    const text = answer.text ?? JSON.stringify(answer.json ?? null);
    return new Response(text, { status: answer.status ?? 200, headers: { 'content-type': 'application/json', ...(answer.headers ?? {}) } });
  };
}

export const noSleep = async (): Promise<void> => {};
