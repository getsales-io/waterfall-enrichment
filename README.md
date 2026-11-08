# GetSales: Waterfall Enrichment

`waterfall-enrichment` is a command line tool and a TypeScript library that enriches a CSV of people or companies through a table in your [GetSales](https://getsales.io/) workspace. GetSales is LinkedIn and email outreach for agencies and GTM teams, in one app. Describe who you sell to, and GetSales finds the people and their work emails, scores them and writes the first lines, and every reply comes back to a team inbox.

The tool imports your file, adds a waterfall column that asks providers in the order you choose, shows you the estimate, starts one run with a credit budget you confirm, and writes the enriched rows back to a CSV, line for line.

More on the product side: [waterfall enrichment on GetSales](https://getsales.io/waterfall-enrichment/). The API it calls: [GetSales API docs](https://docs.getsales.io).

```bash
export GETSALES_API_KEY=gs_live_...
npx @getsales/waterfall-enrichment people.csv --use-row-email --finders findymail,hunter --verify emaillistverify
```

## What is waterfall enrichment?

Waterfall enrichment asks several data providers for the same fact, one after another, and stops at the first one that answers. Providers cover different people, so a chain can answer rows that any single provider misses, and a row the first provider answers never reaches the second.

In GetSales a waterfall is a column of a table, of type `action_waterfall`. Each step of the column is one provider, or one tool of your own. The cell keeps the first accepted answer, and when the chain has a verifier, a found address counts as an answer only once the verifier accepts it.

## How does this library run it on GetSales?

It runs eight steps, each a documented call of the GetSales API:

| Step | API operation |
|---|---|
| 1. Read which finders and verifiers the workspace can call, and build the chain from them in your order | `list_provider_catalog` |
| 2. Create a new table | `create_playtable` |
| 3. Mint a signed upload link, PUT the CSV to it, and check GetSales read the same header and row count | `create_data_source_upload_url`, `get_data_source` |
| 4. Import the rows with their columns mapped to people or company attributes, and wait until they are in the table | `import_data_source`, `search_data_source_items` |
| 5. Add the waterfall column, auto run off | `create_playtable_field` |
| 6. Price the column over the rows the run will take (free) and ask you | `estimate_credits` |
| 7. Start one run with your budget as its `max_budget`, and follow it | `create_playtable_run`, `get_playtable_run` |
| 8. Read the enriched rows and write the CSV | `search_people` or `search_companies` |

Ctrl-C while the run is going cancels it through `cancel_playtable_runs`, named by the run's sid. Its queued cells go back to what they held, and cells already running finish and are charged.

Why one explicit run and no auto run: a column with auto run on fills every row that lands in the table by itself, outside any run's budget. The tool adds its column with auto run off, so the only paid work is the run you confirmed, and its `max_budget` is the budget that applies.

People who already sit in another table of your workspace stay there. The import skips them (`on_duplicate: skip`) and their lines come back with the status `duplicate`. A person who appears twice in the file is enriched once.

## What does it cost?

GetSales charges data credits for the steps that run. The tool never guesses a price: the estimate comes from GetSales (`estimate_credits`), priced from the provider catalog over the rows the run will take, and is shown before anything is spent as a range from min to max, with expected as the likely figure.

| Figure | Meaning |
|---|---|
| min | every row ends on its cheapest step |
| expected | what the rows are expected to cost, the likely figure |
| max | every row runs the whole chain |

The run's budget (`max_budget`) is the estimate's max unless you set `--max-credits`. That is what GetSales asks for, never the expected figure: rows that cost more than expected would use up a budget set there before the last rows run. Before each paid call GetSales compares what the run has spent so far with the budget, and once the spend reaches it, GetSales cancels the run and the CSV holds the rows done by then. Cells already running at that moment still finish and are charged, so the total can pass the budget by what those cells cost. A budget below the max can stop the run before every row is tried. Credits already spent stay spent when a run is cancelled.

`--yes` starts a run without asking, so it only works together with `--max-credits`, the budget you choose. `--estimate-only` stops after the estimate and spends nothing.

Plans and credit prices: [getsales.io/pricing](https://getsales.io/pricing/).

## Which data can it find?

What a waterfall column can return depends on its steps. The tool builds two kinds of chain, both from what the API documents.

**Work emails for people, the default.** The steps are the `email.find` providers of your workspace's provider catalog, in the order you give (`--finders findymail,hunter`). Without `--finders` it takes every finder the catalog offers, in catalog order. Each finder gets the person's full name, company name, company domain and LinkedIn public ID, whichever the CSV has.

- `--use-row-email` puts the address the row already has first in the chain (`row:people.work_email`), so a known address is used before any finder runs.
- `--verify <provider>` runs an `email.verify` provider of the catalog on every address a finder returns. An address counts once it is `valid`, or `catch_all` or `unknown` (the verifier could not confirm it) unless you pass `--reject-catch-all`. Otherwise the next finder runs. Addresses found by the verifier's own vendor are taken as they come, without a second check.
- The address found is kept in the cell and written to the person's work email when that field is empty.

**Your own steps, for people or companies.** `--steps file.json` takes the chain as JSON, with the same keys as the column's payload. Each step is one of the three forms the API documents for a waterfall step:

- `row:people.work_email`, the row's own address (people only)
- `in:{provider}.{operation}`, a provider and operation of the provider catalog, such as `in:hunter.email.find`
- `in:tool.{sid}`, an HTTP tool of your own workspace (the `search_custom_tools` operation lists them)

A `verify` step is one `in:{provider}.email.verify` step with no params: it checks each address a finder returns.

Company rows have no built-in finder, so they always take a steps file:

```json
{
  "steps": [
    { "tool_sid": "in:tool.in_tl_YOURTOOLSID1", "params": { "domain": "{{company.domain}}" } }
  ],
  "stop_on_first": true
}
```

Step params may use the row's own values as templates: `{{people.full_name}}`, `{{people.company_name}}`, `{{people.ln_nickname}}`, `{{people.work_email}}`, `{{company.name}}`, `{{company.domain}}`, `{{company.website}}`.

**The columns it reads.** Headers are matched by name, case and punctuation aside. `--map "Header=target"` sends any other column to a target, and `--map "Header=-"` leaves one out.

| People target | Headers it recognizes |
|---|---|
| `full_name` | Full name, Name, Contact name |
| `first_name`, `last_name` | First name, Last name, Surname (joined into a Full name column of the uploaded copy) |
| `work_email` | Email, E-mail, Email address, Work email |
| `personal_email` | Personal email |
| `company_name` | Company, Company name, Organization, Employer |
| `company.domain` | Domain, Company domain |
| `company.website` | Website, Company website, Homepage |
| `ln_nickname` | ln_nickname, LinkedIn public ID |
| `ln_member_id`, `ln_id`, `sn_id` | the same names |

| Company target | Headers it recognizes |
|---|---|
| `name` | Name, Company, Company name, Organization, Account |
| `domain` | Domain, Company domain |
| `website` | Website, Company website, Homepage, URL |
| `ln_nickname`, `ln_id` | the same names, LinkedIn public ID |

The output keeps every column of your file as it was. Only the copy uploaded to GetSales gets the joined Full name column.

## How do I run it from the command line?

You need Node.js 20 or later and an API key in `GETSALES_API_KEY`.

```bash
npm install -g @getsales/waterfall-enrichment

# price it first, spend nothing
waterfall-enrichment people.csv --estimate-only

# the row's own address first, then two finders, each address verified; asks before the run
waterfall-enrichment people.csv --use-row-email --finders findymail,hunter --verify emaillistverify

# unattended, with a budget you set
waterfall-enrichment people.csv --max-credits 200 --yes -o people.enriched.csv

# columns with other names
waterfall-enrichment leads.csv --map "Org=company_name" --map "Site=company.website" --map "Notes=-"

# companies, through your own HTTP tool
waterfall-enrichment companies.csv --object company --steps company-steps.json

# read the results again later, from the sids the run printed
waterfall-enrichment export people.csv --table pt_tb_... --source ds_sc_... --column pt_fd_...
```

A run looks like this (sids shortened, numbers invented):

```text
Read 4 rows and 5 columns from people.csv.
Columns: Full name -> full_name, Company -> company_name, Domain -> company.domain, Email -> work_email, ln_nickname -> ln_nickname.
Chain: row:people.work_email, in:findymail.email.find, in:hunter.email.find, verified by in:emaillistverify.email.verify.
Created the table "people 2026-11-03 10:00:00 UTC" (pt_tb_...).
Uploaded 301 bytes (source ds_sc_...).
Importing 4 rows...
Import: active, 0 in the table
Import: completed, promoted 3, duplicate 1, 3 in the table
Import done: promoted 3, duplicate 1. 3 rows to enrich.
Added the column "Find work email" (pt_fd_...) with auto run off.
Estimate for 3 rows: 0 to 6.3 credits, likely 2.4.
  0 if every row ends on its cheapest step, 6.3 if every row runs the whole chain.
Run budget: 6.3 credits (the estimate's maximum).
Start the run on 3 rows (0 to 6.3 credits, likely 2.4) with a budget of 6.3 credits? [y/N] y
Started run pt_rn_... with a budget of 6.3 credits. Ctrl-C cancels it.
Run: finished, 3 of 3 done, 2 credits spent
Run pt_rn_... finished: 2 of 6.3 credits spent.
Wrote people.enriched.csv: 4 rows (done 3, duplicate 1).
Table pt_tb_..., source ds_sc_..., column pt_fd_...
Export again later: waterfall-enrichment export people.csv --table pt_tb_... --source ds_sc_... --column pt_fd_...
```

| Option | What it does |
|---|---|
| `-o, --output <file>` | Where to write the enriched CSV. Default: `<input>.enriched.csv` beside the input. |
| `--overwrite` | Replace the output file if it exists. Without it the tool stops before doing anything. |
| `--object <kind>` | `people` (default) or `company`. |
| `--finders <list>` | Email finders in order, comma separated. Default: every finder the catalog offers. `none` for no finder. |
| `--use-row-email` | Start the chain with the address the row already has. |
| `--verify <provider>` | Verify every found address with this `email.verify` provider. |
| `--reject-catch-all` | With `--verify`: a catch-all or unknown address does not count, the next finder runs. |
| `--steps <file.json>` | Build the chain from a JSON file. Needed for company rows. |
| `--map <header=target>` | Map a column by hand, repeatable. `header=-` leaves a column out. |
| `--max-credits <n>` | The run's credit budget. Default: the estimate's max. The run stops once its spend reaches it, and cells already running can finish past it. |
| `-y, --yes` | Start the run without asking. Needs `--max-credits`. |
| `--estimate-only` | Stop after the estimate: the table, the import and the column exist, no run starts. |
| `--table-name <name>` | Name of the new table. Default: the file name and the UTC time. |
| `--column-name <name>` | Name of the waterfall column. Default: `Find work email`, or `Waterfall` for a steps file. |
| `--delimiter <d>` | Force the delimiter: `,` `;` `tab` or `\|`. By default it is read off the header line, and the output keeps it. |
| `--poll-interval <s>` | Seconds between progress checks. Default 5. |
| `--timeout <minutes>` | Stop waiting for the run. It goes on in GetSales, and `export` reads it later. |

**The columns it adds to your CSV:**

| Column | What it holds |
|---|---|
| `enrichment_status` | The cell's status (`done`, `error`, `empty`, `queued`, `running`, `run_condition_not_met`), or for a line that never reached the table its import outcome (`duplicate`, `stoplisted`, `disqualified`, `failed`, `pending`) |
| `enrichment_result` | The address found, or the value your own step returned (a value past 2,000 characters comes back as a preview, and the cell in the app holds it whole) |
| `enrichment_verdict` | The verifier's word on the address (`valid`, `catch_all` or `unknown`), when a verifier ran |
| `enrichment_confidence` | The finder's confidence, when it gives one |
| `enrichment_credits` | Credits the row's cell spent, on the first line of a repeated person only, so the column adds up to the run |
| `enrichment_note` | Why there is no result: the cell's error, or the import's reason |
| `getsales_sid` | The person (`cr_pp_...`) or company (`cr_co_...`) in GetSales |

The values in these columns come from GetSales and its providers, so the tool guards them against spreadsheet formulas: a value that starts with `=`, `+`, `-`, `@`, a tab or a carriage return is written with a leading apostrophe (`'`), and Excel, Google Sheets or LibreOffice show it as text instead of running it. `enrichment_credits` only ever holds a number. Your own columns are written exactly as they were.

Exit codes: `0` done (also when you answer no), `1` the API or the flow stopped it, `2` bad input or options (nothing was created), `130` you cancelled the run with Ctrl-C.

**With Docker.** The image builds and tests the tool, then runs it with no other dependency:

```bash
docker build -t waterfall-enrichment .
docker run --rm -it -e GETSALES_API_KEY -v "$PWD:/data" waterfall-enrichment people.csv
```

On Linux add `--user "$(id -u):$(id -g)"` so the container can write the output into your folder.

## Which API key does it need?

Create a key in the app under Settings, API keys ([authentication](https://docs.getsales.io/authentication)). The key must be allowed to manage tables. GetSales keys carry permission tokens rather than a role, and this tool needs these five:

| Token | Used for |
|---|---|
| `can_manage_playtables` | creating the table and the waterfall column |
| `can_act_playtables` | uploading and importing the CSV, starting and cancelling the run |
| `can_view_playtables` | the import's progress and rows, the estimate, the run's progress |
| `can_view_people` | reading the enriched people or companies |
| `can_view_integrations` | reading the provider catalog |

A key with Full access (the owner's grant, or the Superadmin preset) has all five. The Operator and View only presets do not include `can_manage_playtables`, so a key made from either gets a 403 at the first step. Keep the key's Playtables reach on All: a key held to selected tables cannot open the table this tool creates.

Errors arrive as the GetSales error envelope, and the tool prints its code, message, suggestion and trace id.

## How do I use it from code?

```ts
import { readFile, writeFile } from 'node:fs/promises';
import { GetSalesClient, enrichCsv } from '@getsales/waterfall-enrichment';

const client = new GetSalesClient({ apiKey: process.env.GETSALES_API_KEY ?? '' });

const result = await enrichCsv({
  client,
  csv: await readFile('people.csv', 'utf8'),
  fileName: 'people.csv',
  chain: { kind: 'email', finders: ['findymail', 'hunter'], useRowEmail: true, verify: 'emaillistverify' },
  maxCredits: 200,
  // Asked once, after the estimate and before the paid run: here, run only when the budget covers the estimate's max.
  confirm: ({ estimate, maxBudget }) => estimate.max <= maxBudget,
  onEvent: (event) => console.error(event.type),
});

if (result.output) await writeFile('people.enriched.csv', result.output.csv);
console.log(result.outcome, result.spentCredits);
```

`GetSalesClient` also exposes each API call on its own (`createPlaytable`, `importDataSource`, `estimateCredits`, `createPlaytableRun`, `cancelPlaytableRuns` and the rest), typed from the public OpenAPI. `createPlaytableRun` refuses a run without a positive `max_budget`, and `cancelPlaytableRuns` refuses a body that names no scope or more than one.

## What does it change in my workspace?

- It adds a table named after the file and the time, holding the imported people or companies and the waterfall column. Delete the table in the app when you no longer need it.
- People already in another table are not moved, and a found address only fills an empty work email.
- It never sends a message, starts a workflow or acts on any channel.

## Links

- [Waterfall enrichment on GetSales](https://getsales.io/waterfall-enrichment/)
- [GetSales API docs](https://docs.getsales.io)
- [API keys and authentication](https://docs.getsales.io/authentication)

## License

MIT, see [LICENSE](LICENSE).

GetSales is an independent product and is not affiliated with, endorsed by, or sponsored by LinkedIn Corporation. LinkedIn and the LinkedIn logo are trademarks of LinkedIn Corporation. Use of GetSales is at your own risk and subject to the applicable third-party platform terms.
