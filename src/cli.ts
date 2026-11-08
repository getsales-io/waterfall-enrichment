import { basename, dirname, extname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { parseStepsFile, type ChainOptions } from './chain.js';
import { GetSalesClient, type FetchLike } from './client.js';
import { isDelimiter, type Delimiter } from './csv.js';
import { enrichCsv, exportEnrichment, type ConfirmRequest, type EnrichEvent, type EnrichResult } from './enrich.js';
import { FlowError, GetSalesApiError, UsageError } from './errors.js';
import { parseMapOverrides } from './mapping.js';
import type { CreditsEstimate, ObjectType } from './types.js';
import { VERSION } from './version.js';

/** What the CLI touches outside itself, so tests can run it in memory. */
export interface CliIo {
  env: Readonly<Record<string, string | undefined>>;
  stdout: { write(chunk: string): unknown };
  stderr: { write(chunk: string): unknown };
  /** True when a person can answer the confirmation prompt. */
  interactive: boolean;
  /** Asks one question and returns the typed line. */
  prompt: (question: string) => Promise<string>;
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, data: string) => Promise<void>;
  exists: (path: string) => boolean;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  /** Aborted on Ctrl-C: before the run it stops the flow, during the run it cancels the run. */
  signal?: AbortSignal;
  now?: () => Date;
}

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;
export const EXIT_INTERRUPTED = 130;

const HELP = `waterfall-enrichment ${VERSION}

Enrich a CSV of people or companies through a new GetSales table: import it,
add a waterfall column, estimate the run, ask, run it once with a credit
budget, and write the enriched CSV.

Usage:
  waterfall-enrichment <input.csv> [options]
  waterfall-enrichment export <input.csv> --table <pt_tb_...> --source <ds_sc_...> --column <pt_fd_...> [options]

Environment:
  GETSALES_API_KEY           Your GetSales API key (gs_live_...).

Options:
  -o, --output <file>        Where to write the enriched CSV (default: <input>.enriched.csv).
      --overwrite            Replace the output file if it exists.
      --object <kind>        people (default) or company.
      --finders <list>       Email finders in order, comma separated (default: every
                             finder the provider catalog offers, in its order, or
                             "none" for no finder).
      --use-row-email        Start the chain with the address the row already has.
      --verify <provider>    Verify each found address with this provider.
      --reject-catch-all     With --verify: treat a catch-all or unknown address as rejected.
      --steps <file.json>    Build the chain from a JSON file instead (needed for company rows).
      --map <header=target>  Map a column by hand, repeatable. "header=-" leaves a column out.
      --max-credits <n>      The run's credit budget (default: the estimate's maximum).
                             The run stops once its spend reaches it, and cells
                             already running can finish past it.
  -y, --yes                  Start the run without asking. Needs --max-credits.
      --estimate-only        Stop after the estimate: no run, no credits spent.
      --table-name <name>    Name of the new table (default: file name and UTC time).
      --column-name <name>   Name of the waterfall column.
      --delimiter <d>        Force the CSV delimiter: , ; tab or |.
      --poll-interval <s>    Seconds between progress checks (default 5).
      --timeout <minutes>    Stop waiting for the run after this long. It goes on in GetSales.
  -h, --help                 Show this help.
  -v, --version              Show the version.

Export options:
      --table <sid>          The table (pt_tb_...).
      --source <sid>         The CSV source (ds_sc_...).
      --column <sid>         The waterfall column (pt_fd_...).

Ctrl-C during the run cancels it. Credits already spent stay spent.
Docs: https://docs.getsales.io
`;

const OPTIONS = {
  output: { type: 'string', short: 'o' },
  overwrite: { type: 'boolean' },
  object: { type: 'string' },
  finders: { type: 'string' },
  'use-row-email': { type: 'boolean' },
  verify: { type: 'string' },
  'reject-catch-all': { type: 'boolean' },
  steps: { type: 'string' },
  map: { type: 'string', multiple: true },
  'max-credits': { type: 'string' },
  yes: { type: 'boolean', short: 'y' },
  'estimate-only': { type: 'boolean' },
  'table-name': { type: 'string' },
  'column-name': { type: 'string' },
  delimiter: { type: 'string' },
  'poll-interval': { type: 'string' },
  timeout: { type: 'string' },
  table: { type: 'string' },
  source: { type: 'string' },
  column: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
} as const;

type Values = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true; strict: true }>>['values'];

export const formatCredits = (value: number): string => value.toLocaleString('en-US', { maximumFractionDigits: 2 });

/** An estimate as a range with its likely figure: "0 to 6 credits, likely 2.4". */
const formatEstimateRange =(estimate: Pick<CreditsEstimate, 'min' | 'expected' | 'max'>): string =>
  `${formatCredits(estimate.min)} to ${formatCredits(estimate.max)} credits, likely ${formatCredits(estimate.expected)}`;

const cellCount = (count: number, kind: string): string => `${count} ${kind} cell${count === 1 ? '' : 's'}`;

const positiveNumber = (raw: string | undefined, flag: string): number | undefined => {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!(Number.isFinite(value) && value > 0)) throw new UsageError(`${flag} takes a number above 0, got "${raw}".`);
  return value;
};

const parseDelimiter = (raw: string | undefined): Delimiter | undefined => {
  if (raw === undefined) return undefined;
  const value = raw === 'tab' || raw === '\\t' ? '\t' : raw;
  if (!isDelimiter(value)) throw new UsageError('--delimiter takes , ; tab or |.');
  return value;
};

const parseObject = (raw: string | undefined): ObjectType => {
  if (raw === undefined || raw === 'people') return 'people';
  if (raw === 'company' || raw === 'companies') return 'company';
  throw new UsageError('--object takes people or company.');
};

const defaultOutput = (input: string): string => join(dirname(input), `${basename(input, extname(input))}.enriched.csv`);

const sidFlag = (raw: string | undefined, flag: string, prefix: string): string => {
  if (raw === undefined || !new RegExp(`^${prefix}[A-Za-z0-9]{12}$`).test(raw)) {
    throw new UsageError(`${flag} takes a ${prefix}... sid of 18 characters.`);
  }
  return raw;
};

const describeCounts = (counts: Record<string, number>): string =>
  Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([status, n]) => `${status} ${n}`)
    .join(', ') || 'none';

/** Turns flow events into progress lines on stderr, printing a repeated state once. */
const progressPrinter = (io: CliIo, fileName: string): ((event: EnrichEvent) => void) => {
  const say = (line: string): void => {
    io.stderr.write(`${line}\n`);
  };
  let lastImport = '';
  let lastRun = '';
  return (event) => {
    switch (event.type) {
      case 'parsed':
        say(`Read ${event.rows} rows and ${event.headers.length} columns from ${fileName}.`);
        break;
      case 'mapped':
        say(
          event.columns.length === 0
            ? 'No column maps to a GetSales attribute, so the rows land whole in the Data source cell.'
            : `Columns: ${event.columns.map((c) => `${c.header} -> ${c.target}`).join(', ')}${event.builtFullName ? ' (Full name built from first and last name)' : ''}.`,
        );
        break;
      case 'warning':
        say(`Note: ${event.message}`);
        break;
      case 'chain':
        say(`Chain: ${event.steps.join(', ')}${event.verify ? `, verified by ${event.verify}` : ''}.`);
        break;
      case 'table_created':
        say(`Created the table "${event.name}" (${event.playtableSid}).`);
        break;
      case 'uploaded':
        say(`Uploaded ${event.bytes} bytes (source ${event.dataSourceSid}).`);
        break;
      case 'import_started':
        say(`Importing ${event.totalRows} rows...`);
        break;
      case 'import_progress': {
        const counted = Object.values(event.counts).some((n) => n > 0) ? `, ${describeCounts(event.counts)}` : '';
        const line = `Import: ${event.status}${counted}, ${event.indexed} in the table`;
        if (line !== lastImport) say(line);
        lastImport = line;
        break;
      }
      case 'import_done':
        say(`Import done: ${describeCounts(event.counts)}. ${event.inTable} rows to enrich.`);
        break;
      case 'column_created':
        say(`Added the column "${event.name}" (${event.fieldSid}) with auto run off.`);
        break;
      case 'estimated': {
        const { estimate } = event;
        say(`Estimate for ${event.rowsToRun} rows: ${formatEstimateRange(estimate)}.`);
        say(`  ${formatCredits(estimate.min)} if every row ends on its cheapest step, ${formatCredits(estimate.max)} if every row runs the whole chain.`);
        say(
          `Run budget: ${formatCredits(event.maxBudget)} credits${event.budgetBelowMax ? " (your budget, below the estimate's maximum)" : event.maxBudget === estimate.max ? " (the estimate's maximum)" : ''}.`,
        );
        break;
      }
      case 'run_started':
        say(`Started run ${event.runSid} with a budget of ${formatCredits(event.maxBudget)} credits. Ctrl-C cancels it.`);
        break;
      case 'run_progress': {
        const p = event.progress;
        const line = `Run: ${p.state}, ${p.processed_jobs} of ${p.total_jobs} done, ${formatCredits(p.spent_credits)} credits spent`;
        if (line !== lastRun) say(line);
        lastRun = line;
        break;
      }
      case 'cancel_requested': {
        if (!event.stopped) {
          say(`The run had already ended, so there was nothing to cancel. Credits spent: ${formatCredits(event.spentCredits)}.`);
          break;
        }
        const running =
          event.inFlightCells === 0
            ? ''
            : event.inFlightCells === 1
              ? ', 1 running cell finishes and is charged'
              : `, ${event.inFlightCells} running cells finish and are charged`;
        say(`Cancelled the run: ${cellCount(event.revertedCells, 'queued')} sent back${running}. Credits spent so far: ${formatCredits(event.spentCredits)}.`);
        break;
      }
      case 'run_ended':
      case 'exported':
        break;
    }
  };
};

const buildChain = async (values: Values, io: CliIo): Promise<ChainOptions> => {
  if (values.steps !== undefined) {
    const emailFlags = ['finders', 'use-row-email', 'verify', 'reject-catch-all'] as const;
    const clash = emailFlags.find((flag) => values[flag] !== undefined);
    if (clash) throw new UsageError(`--steps builds the whole chain, so drop --${clash}.`);
    let raw: unknown;
    try {
      raw = JSON.parse(await io.readFile(values.steps));
    } catch (error) {
      if (error instanceof SyntaxError) throw new UsageError(`${values.steps} is not valid JSON: ${error.message}`);
      throw new UsageError(`Cannot read ${values.steps}: ${(error as Error).message}`);
    }
    return parseStepsFile(raw);
  }
  const chain: ChainOptions = { kind: 'email', useRowEmail: values['use-row-email'] ?? false, acceptCatchAll: !(values['reject-catch-all'] ?? false) };
  if (values.finders !== undefined) {
    const list = values.finders.trim().toLowerCase();
    chain.finders = list === 'none' ? [] : list.split(',').map((name) => name.trim()).filter((name) => name !== '');
  }
  if (values.verify !== undefined) chain.verify = values.verify.trim().toLowerCase();
  if (values['reject-catch-all'] && values.verify === undefined) throw new UsageError('--reject-catch-all goes with --verify.');
  return chain;
};

const summarize = (io: CliIo, result: EnrichResult, outputPath: string | null, inputPath: string): void => {
  const out = (line: string): void => {
    io.stdout.write(`${line}\n`);
  };
  switch (result.outcome) {
    case 'estimate_only':
      out('Estimate only: no run started, no credits spent.');
      break;
    case 'declined':
      out('Not started: no run, no credits spent.');
      break;
    case 'nothing_to_run':
      out('Nothing to enrich: no imported row is waiting for the column.');
      break;
    case 'finished':
      out(`Run ${result.runSid} finished: ${formatCredits(result.spentCredits ?? 0)} of ${formatCredits(result.maxBudget ?? 0)} credits spent.`);
      break;
    case 'cancelled':
      out(
        result.cancelledBy === 'you'
          ? `Run ${result.runSid} cancelled: ${formatCredits(result.spentCredits ?? 0)} credits spent.`
          : `Run ${result.runSid} was cancelled in GetSales (for example when its spend reached the budget or the workspace ran out of credits): ${formatCredits(result.spentCredits ?? 0)} credits spent, budget ${formatCredits(result.maxBudget ?? 0)}.`,
      );
      break;
    case 'timed_out':
      out(`Stopped waiting for run ${result.runSid}. It goes on in GetSales, and the CSV holds the rows done so far.`);
      break;
  }
  if (result.output && outputPath) out(`Wrote ${outputPath}: ${result.output.rows.length} rows (${describeCounts(result.output.counts)}).`);
  out(`Table ${result.playtableSid}, source ${result.dataSourceSid}${result.fieldSid ? `, column ${result.fieldSid}` : ''}`);
  if (result.fieldSid) {
    out(`Export again later: waterfall-enrichment export ${inputPath} --table ${result.playtableSid} --source ${result.dataSourceSid} --column ${result.fieldSid}`);
  }
};

const runExport = async (values: Values, positionals: string[], io: CliIo, client: GetSalesClient): Promise<number> => {
  const input = positionals[1];
  if (input === undefined) throw new UsageError('export needs the input CSV path.');
  const playtableSid = sidFlag(values.table, '--table', 'pt_tb_');
  const dataSourceSid = sidFlag(values.source, '--source', 'ds_sc_');
  const fieldSid = sidFlag(values.column, '--column', 'pt_fd_');
  const outputPath = values.output ?? defaultOutput(input);
  if (io.exists(outputPath) && !values.overwrite) throw new UsageError(`${outputPath} exists. Pass --overwrite or another --output.`);
  const delimiter = parseDelimiter(values.delimiter);
  const output = await exportEnrichment({
    client,
    csv: await io.readFile(input),
    objectType: parseObject(values.object),
    playtableSid,
    dataSourceSid,
    fieldSid,
    ...(delimiter ? { delimiter } : {}),
  });
  await io.writeFile(outputPath, output.csv);
  io.stdout.write(`Wrote ${outputPath}: ${output.rows.length} rows (${describeCounts(output.counts)}).\n`);
  return EXIT_OK;
};

/** The CLI. Returns the exit code. */
export const main = async (argv: readonly string[], io: CliIo): Promise<number> => {
  let parsed: { values: Values; positionals: string[] };
  try {
    parsed = parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    io.stderr.write(`${(error as Error).message}\nRun waterfall-enrichment --help for the options.\n`);
    return EXIT_USAGE;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    io.stdout.write(HELP);
    return EXIT_OK;
  }
  if (values.version) {
    io.stdout.write(`${VERSION}\n`);
    return EXIT_OK;
  }

  try {
    const apiKey = io.env['GETSALES_API_KEY']?.trim();
    const isExport = positionals[0] === 'export';
    const input = isExport ? positionals[1] : positionals[0];
    if (input === undefined) throw new UsageError('Give the input CSV path. Run waterfall-enrichment --help for the options.');
    if (positionals.length > (isExport ? 2 : 1)) throw new UsageError(`One input file only, got: ${positionals.join(' ')}.`);
    if (!apiKey) throw new UsageError('Set GETSALES_API_KEY to your GetSales API key (in the app: Settings, API keys).');
    if (/\s/.test(apiKey)) throw new UsageError('GETSALES_API_KEY holds a space. It takes the key alone (gs_live_...).');
    const client = new GetSalesClient({ apiKey, ...(io.fetch ? { fetch: io.fetch } : {}), ...(io.sleep ? { sleep: io.sleep } : {}) });
    if (isExport) return await runExport(values, positionals, io, client);

    const objectType = parseObject(values.object);
    const maxCredits = positiveNumber(values['max-credits'], '--max-credits');
    const pollSeconds = positiveNumber(values['poll-interval'], '--poll-interval') ?? 5;
    const timeoutMinutes = positiveNumber(values.timeout, '--timeout');
    const delimiter = parseDelimiter(values.delimiter);
    const estimateOnly = values['estimate-only'] ?? false;
    const yes = values.yes ?? false;
    if (yes && maxCredits === undefined) {
      throw new UsageError('--yes starts a paid run without asking, so it needs --max-credits: the budget you choose.');
    }
    if (!yes && !estimateOnly && !io.interactive) {
      throw new UsageError('No terminal to ask in: pass --yes with --max-credits, or --estimate-only.');
    }
    const outputPath = values.output ?? defaultOutput(input);
    if (!estimateOnly && io.exists(outputPath) && !values.overwrite) {
      throw new UsageError(`${outputPath} exists. Pass --overwrite or another --output.`);
    }
    const mapping = parseMapOverrides(values.map ?? []);
    const chain = await buildChain(values, io);
    let csv: string;
    try {
      csv = await io.readFile(input);
    } catch (error) {
      throw new UsageError(`Cannot read ${input}: ${(error as Error).message}`);
    }

    const confirm = async (request: ConfirmRequest): Promise<boolean> => {
      if (yes) {
        io.stderr.write(`Starting the run (--yes): budget ${formatCredits(request.maxBudget)} credits.\n`);
        return true;
      }
      const answer = await io.prompt(
        `Start the run on ${request.rowsToRun} rows (${formatEstimateRange(request.estimate)}) with a budget of ${formatCredits(request.maxBudget)} credits? [y/N] `,
      );
      return /^y(es)?$/i.test(answer.trim());
    };

    const result = await enrichCsv({
      client,
      csv,
      fileName: basename(input),
      objectType,
      chain,
      mapping,
      confirm,
      estimateOnly,
      onEvent: progressPrinter(io, basename(input)),
      pollIntervalMs: pollSeconds * 1_000,
      ...(delimiter ? { delimiter } : {}),
      ...(maxCredits !== undefined ? { maxCredits } : {}),
      ...(values['table-name'] !== undefined ? { tableName: values['table-name'] } : {}),
      ...(values['column-name'] !== undefined ? { columnName: values['column-name'] } : {}),
      ...(timeoutMinutes !== undefined ? { runTimeoutMs: timeoutMinutes * 60_000 } : {}),
      ...(io.signal ? { signal: io.signal } : {}),
      ...(io.sleep ? { sleep: io.sleep } : {}),
      ...(io.now ? { now: io.now } : {}),
    });

    if (result.output) await io.writeFile(outputPath, result.output.csv);
    summarize(io, result, result.output ? outputPath : null, input);
    return result.outcome === 'cancelled' && result.cancelledBy === 'you' ? EXIT_INTERRUPTED : EXIT_OK;
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr.write(`${error.message}\n`);
      return EXIT_USAGE;
    }
    if (error instanceof FlowError || error instanceof GetSalesApiError) {
      io.stderr.write(`${error.message}\n`);
      if (error instanceof FlowError) {
        const created = Object.entries(error.created).filter(([, sid]) => sid);
        if (created.length > 0) io.stderr.write(`Created before the stop: ${created.map(([kind, sid]) => `${kind} ${sid}`).join(', ')}.\n`);
      }
      return io.signal?.aborted ? EXIT_INTERRUPTED : EXIT_FAILED;
    }
    throw error;
  }
};
