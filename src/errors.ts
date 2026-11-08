import type { McpErrorBody } from './types.js';

/** A request this package refused before anything reached the API, or input it cannot use. */
export class UsageError extends Error {
  override readonly name = 'UsageError';
}

/** A step of the flow that ended in a state the package cannot continue from. */
export class FlowError extends Error {
  override readonly name = 'FlowError';

  constructor(
    message: string,
    /** Sids created before the failure, so the caller can find or clean them up. */
    readonly created: { playtableSid?: string; dataSourceSid?: string; fieldSid?: string; runSid?: string } = {},
  ) {
    super(message);
  }
}

/** A refusal from the GetSales API: the `McpError` envelope, or an answer that was not one. */
export class GetSalesApiError extends Error {
  override readonly name = 'GetSalesApiError';
  readonly operationId: string;
  readonly status: number;
  readonly code: string;
  readonly recoverable: boolean;
  readonly suggestion: string | undefined;
  readonly fieldErrors: McpErrorBody['field_errors'];
  readonly context: Record<string, unknown> | undefined;
  readonly traceId: string | undefined;

  constructor(args: { operationId: string; status: number; body?: McpErrorBody; traceId?: string; fallbackMessage?: string }) {
    const body = args.body;
    super(GetSalesApiError.describe(args.operationId, args.status, body, args.traceId, args.fallbackMessage));
    this.operationId = args.operationId;
    this.status = args.status;
    this.code = body?.code ?? (args.status >= 500 ? 'internal_error' : 'unexpected_answer');
    this.recoverable = body?.recoverable ?? args.status >= 500;
    this.suggestion = body?.suggestion;
    this.fieldErrors = body?.field_errors;
    this.context = body?.context;
    this.traceId = args.traceId;
  }

  private static describe(
    operationId: string,
    status: number,
    body: McpErrorBody | undefined,
    traceId: string | undefined,
    fallbackMessage: string | undefined,
  ): string {
    const lines = [`${operationId} failed (HTTP ${status}${body ? `, ${body.code}` : ''}): ${body?.message ?? fallbackMessage ?? 'no error body'}`];
    if (body?.suggestion) lines.push(`Suggestion: ${body.suggestion}`);
    if (body?.field_errors) {
      for (const [field, errors] of Object.entries(body.field_errors)) {
        for (const error of errors) lines.push(`  ${field}: ${error.message}`);
      }
    }
    const reason = body?.context?.['reason'];
    if (typeof reason === 'string') lines.push(`Reason: ${reason}`);
    if (status === 403 && operationId === 'upload_csv') {
      lines.push('The signed upload link was refused (it lasts 15 minutes and works once). Run the tool again.');
    } else if (status === 403) {
      lines.push('Check the API key permissions: see "Which API key does it need?" in the README.');
    }
    if (traceId) lines.push(`Trace id: ${traceId}`);
    return lines.join('\n');
  }
}
