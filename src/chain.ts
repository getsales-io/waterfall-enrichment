import { UsageError } from './errors.js';
import type { MappingPlan } from './mapping.js';
import {
  EMAIL_FIND,
  EMAIL_VERIFY,
  MAX_OUTPUT_MAPPINGS,
  MAX_WATERFALL_STEPS,
  ROW_EMAIL_STEP,
  isSpecOperation,
  isSpecProvider,
} from './spec.js';
import type { ObjectType, OutputMapping, ProviderCatalogEntry, WaterfallPayload, WaterfallStep } from './types.js';

/** The work email chain of a people CSV: the email finders of the catalog, in the order given. */
export interface EmailChainOptions {
  kind: 'email';
  /** `email.find` providers in order. Default: every finder the catalog offers, in catalog order. */
  finders?: string[];
  /** Start the chain with the address the row already carries (`row:people.work_email`). */
  useRowEmail?: boolean;
  /** An `email.verify` provider run on every address a finder returns. */
  verify?: string | null;
  /**
   * With a verifier: true (default) accepts an address the verifier calls
   * `catch_all` or `unknown` and ends the chain there. False rejects it like
   * an invalid one, and the next finder runs.
   */
  acceptCatchAll?: boolean;
}

/** A chain written out step by step, for company rows or for your own tools. */
export interface StepsChainOptions {
  kind: 'steps';
  steps: WaterfallStep[];
  /** true (default): stop at the first step with an accepted result. */
  stopOnFirst?: boolean;
  outputMapping?: OutputMapping[] | null;
  verify?: WaterfallStep | null;
  acceptCatchAll?: boolean;
}

export type ChainOptions = EmailChainOptions | StepsChainOptions;

/** The finder inputs, as templates over the row's own attributes. */
export type FinderInputs = Partial<Record<'full_name' | 'linkedin_nickname' | 'company_name' | 'domain', string>>;

const TOOL_STEP = /^in:tool\.in_tl_[A-Za-z0-9]{12}$/;
const PROVIDER_STEP = /^in:([a-z0-9_-]+)\.([a-z_]+\.[a-z_]+)$/;
const OUTPUT_TARGET = /^(people|company)\.[a-z][a-z0-9_]*$/;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** A step written as `in:{provider}.{operation}`, split; null for every other form. */
export const parseProviderStep = (toolSid: string): { provider: string; operation: string } | null => {
  if (TOOL_STEP.test(toolSid)) return null;
  const match = PROVIDER_STEP.exec(toolSid);
  return match && match[1] !== undefined && match[2] !== undefined ? { provider: match[1], operation: match[2] } : null;
};

/** The providers of one catalog operation the workspace can call now, in catalog order. */
export const catalogProviders = (catalog: readonly ProviderCatalogEntry[], operation: string): string[] => {
  const providers: string[] = [];
  for (const entry of catalog) {
    if (entry.operation === operation && entry.platform_key && isSpecProvider(entry.provider) && !providers.includes(entry.provider)) {
      providers.push(entry.provider);
    }
  }
  return providers;
};

/**
 * The inputs every finder step sends, the same four the GetSales app's Find
 * work email column sends, each only when the CSV carries it. A finder reads
 * the inputs it serves and the chain moves on when it cannot use them.
 */
export const finderInputs = (plan: MappingPlan): FinderInputs => {
  const inputs: FinderInputs = {};
  if (plan.has.name) inputs.full_name = '{{people.full_name}}';
  if (plan.has.lnNickname) inputs.linkedin_nickname = '{{people.ln_nickname}}';
  if (plan.has.company) inputs.company_name = '{{people.company_name}}';
  if (plan.has.domain) inputs.domain = '{{company.domain}}';
  return inputs;
};

const describeStepForms = 'row:people.work_email, in:{provider}.{operation} or in:tool.{custom tool sid}';

/** Checks one step against the forms the API documents for a waterfall step. */
const checkStepForm = (step: WaterfallStep, label: string, objectType: ObjectType): void => {
  if (typeof step.tool_sid !== 'string' || step.tool_sid === '') throw new UsageError(`${label}: tool_sid is missing.`);
  if (!isRecord(step.params)) throw new UsageError(`${label}: params must be an object.`);
  if (step.tool_sid === ROW_EMAIL_STEP) {
    if (objectType !== 'people') throw new UsageError(`${label}: ${ROW_EMAIL_STEP} works on people rows only.`);
    return;
  }
  if (TOOL_STEP.test(step.tool_sid)) return;
  const provider = parseProviderStep(step.tool_sid);
  if (provider === null) {
    throw new UsageError(`${label}: "${step.tool_sid}" is not a step form this package builds. Use ${describeStepForms}.`);
  }
  if (!isSpecProvider(provider.provider)) throw new UsageError(`${label}: "${provider.provider}" is not a provider of the GetSales API.`);
  if (!isSpecOperation(provider.operation)) throw new UsageError(`${label}: "${provider.operation}" is not an operation of the GetSales API.`);
  if ((provider.operation === EMAIL_FIND || provider.operation === EMAIL_VERIFY) && objectType !== 'people') {
    throw new UsageError(`${label}: ${provider.operation} works on people rows only.`);
  }
};

/** Validates a written-out chain without the network: step forms, counts, the output mapping. */
export const checkStepsChain = (chain: StepsChainOptions, objectType: ObjectType): void => {
  if (!Array.isArray(chain.steps) || chain.steps.length === 0) throw new UsageError('The chain needs at least one step.');
  if (chain.steps.length > MAX_WATERFALL_STEPS) throw new UsageError(`A waterfall column takes at most ${MAX_WATERFALL_STEPS} steps.`);
  chain.steps.forEach((step, index) => checkStepForm(step, `Step ${index + 1}`, objectType));
  if (chain.steps.filter((step) => step.tool_sid === ROW_EMAIL_STEP).length > 1) {
    throw new UsageError(`${ROW_EMAIL_STEP} may appear once.`);
  }
  if (chain.verify) {
    checkStepForm(chain.verify, 'verify', objectType);
    if (parseProviderStep(chain.verify.tool_sid)?.operation !== EMAIL_VERIFY) {
      throw new UsageError('verify takes one in:{provider}.email.verify step.');
    }
    if (Object.keys(chain.verify.params).length > 0) {
      throw new UsageError('verify takes no params: it checks each address a finder returns.');
    }
  }
  const mapping = chain.outputMapping ?? [];
  if (mapping.length > MAX_OUTPUT_MAPPINGS) throw new UsageError(`output_mapping takes at most ${MAX_OUTPUT_MAPPINGS} entries.`);
  mapping.forEach((entry, index) => {
    if (!isRecord(entry) || typeof entry.path !== 'string' || entry.path === '' || entry.path.length > 512) {
      throw new UsageError(`output_mapping ${index + 1}: path must be a JSON path such as $.email.`);
    }
    if (typeof entry.target !== 'string' || !OUTPUT_TARGET.test(entry.target) || entry.target.length > 128) {
      throw new UsageError(`output_mapping ${index + 1}: target must be people.<attribute> or company.<attribute>.`);
    }
    if (objectType === 'company' && entry.target.startsWith('people.')) {
      throw new UsageError(`output_mapping ${index + 1}: a company row has no people.<attribute> target.`);
    }
  });
};

/** True when building the chain needs the provider catalog. */
export const chainNeedsCatalog = (chain: ChainOptions): boolean =>
  chain.kind === 'email' ||
  chain.steps.some((step) => parseProviderStep(step.tool_sid) !== null) ||
  (chain.verify !== undefined && chain.verify !== null);

/**
 * Builds the `action_waterfall` payload. Provider steps must be offered by the
 * catalog (with a platform key); the order is the caller's.
 */
export const buildWaterfallPayload = (
  chain: ChainOptions,
  plan: MappingPlan,
  catalog: readonly ProviderCatalogEntry[],
): { payload: WaterfallPayload; warnings: string[] } => {
  const warnings: string[] = [];
  if (chain.kind === 'steps') {
    checkStepsChain(chain, plan.objectType);
    const providerSteps = [...chain.steps, ...(chain.verify ? [chain.verify] : [])];
    for (const step of providerSteps) {
      const parsed = parseProviderStep(step.tool_sid);
      if (parsed === null) continue;
      const offered = catalogProviders(catalog, parsed.operation);
      if (!offered.includes(parsed.provider)) {
        throw new UsageError(
          `${step.tool_sid}: the provider catalog offers no ${parsed.operation} on ${parsed.provider}. On offer: ${offered.join(', ') || 'none'}.`,
        );
      }
    }
    const payload: WaterfallPayload = {
      steps: chain.steps.map((step) => ({ tool_sid: step.tool_sid, params: { ...step.params } })),
      stop_on_first: chain.stopOnFirst ?? true,
      output_mapping: chain.outputMapping && chain.outputMapping.length > 0 ? chain.outputMapping.map((m) => ({ ...m })) : null,
    };
    if (chain.verify) payload.verify = { tool_sid: chain.verify.tool_sid, params: { ...chain.verify.params } };
    if (chain.acceptCatchAll !== undefined) payload.accept_catch_all = chain.acceptCatchAll;
    return { payload, warnings };
  }

  if (plan.objectType !== 'people') {
    throw new UsageError('The work email chain runs on people rows. Company rows take a written-out chain (--steps).');
  }
  const offeredFinders = catalogProviders(catalog, EMAIL_FIND);
  const finders = chain.finders ?? offeredFinders;
  const seen = new Set<string>();
  for (const finder of finders) {
    if (seen.has(finder)) throw new UsageError(`The finder "${finder}" is listed twice.`);
    seen.add(finder);
    if (!offeredFinders.includes(finder)) {
      throw new UsageError(`"${finder}" is not an email finder the provider catalog offers. On offer: ${offeredFinders.join(', ') || 'none'}.`);
    }
  }
  let verify: WaterfallStep | null = null;
  if (chain.verify) {
    const offeredVerifiers = catalogProviders(catalog, EMAIL_VERIFY);
    if (!offeredVerifiers.includes(chain.verify)) {
      throw new UsageError(`"${chain.verify}" is not an email verifier the provider catalog offers. On offer: ${offeredVerifiers.join(', ') || 'none'}.`);
    }
    verify = { tool_sid: `in:${chain.verify}.${EMAIL_VERIFY}`, params: {} };
  }
  const useRowEmail = chain.useRowEmail ?? false;
  if (finders.length === 0 && !useRowEmail) {
    throw new UsageError(
      chain.finders === undefined
        ? 'The chain has no step: the provider catalog offers no email finder, and the row email step is off.'
        : 'The chain has no step: no finder was named, and the row email step is off (--use-row-email).',
    );
  }
  if (finders.length === 0 && verify === null) {
    throw new UsageError("A chain of the row's own address alone needs a verifier (--verify): without one it finds nothing new.");
  }
  if (finders.length > 0 && !((plan.has.name && (plan.has.company || plan.has.domain)) || plan.has.lnNickname)) {
    throw new UsageError(
      'The email finders need each person\'s name with a company or a domain, or a LinkedIn public ID, and the CSV has neither. ' +
        'Name the columns with --map, for example --map "Org=company_name".',
    );
  }
  if (useRowEmail && !plan.has.workEmail) warnings.push('The row email step is on, but no CSV column maps to work_email.');
  if (finders.length > 0 && plan.has.name && !plan.has.domain && !plan.has.lnNickname) {
    warnings.push('No domain column: finders that need a domain will move the chain on.');
  }

  const inputs = finderInputs(plan);
  const steps: WaterfallStep[] = [
    ...(useRowEmail ? [{ tool_sid: ROW_EMAIL_STEP, params: {} }] : []),
    ...finders.map((finder) => ({ tool_sid: `in:${finder}.${EMAIL_FIND}`, params: { ...inputs } })),
  ];
  if (steps.length > MAX_WATERFALL_STEPS) throw new UsageError(`A waterfall column takes at most ${MAX_WATERFALL_STEPS} steps.`);

  return {
    payload: {
      steps,
      stop_on_first: true,
      output_mapping: [{ path: '$.email', target: 'people.work_email' }],
      verify,
      accept_catch_all: chain.acceptCatchAll ?? true,
    },
    warnings,
  };
};

const STEPS_FILE_KEYS = new Set(['steps', 'stop_on_first', 'output_mapping', 'verify', 'accept_catch_all']);

const parseStep = (raw: unknown, label: string): WaterfallStep => {
  if (!isRecord(raw)) throw new UsageError(`${label} must be an object with tool_sid and params.`);
  for (const key of Object.keys(raw)) {
    if (key !== 'tool_sid' && key !== 'params') throw new UsageError(`${label} has an unknown key "${key}".`);
  }
  if (typeof raw['tool_sid'] !== 'string') throw new UsageError(`${label}: tool_sid must be a string.`);
  const params = raw['params'] ?? {};
  if (!isRecord(params)) throw new UsageError(`${label}: params must be an object.`);
  return { tool_sid: raw['tool_sid'], params };
};

/**
 * Reads a steps file: a JSON object with `steps` (and optionally
 * `stop_on_first`, `output_mapping`, `verify`, `accept_catch_all`), the same
 * keys as the column's payload, or a bare array of steps.
 */
export const parseStepsFile = (raw: unknown): StepsChainOptions => {
  const body = Array.isArray(raw) ? { steps: raw } : raw;
  if (!isRecord(body)) throw new UsageError('The steps file must hold a JSON object with a "steps" array.');
  for (const key of Object.keys(body)) {
    if (!STEPS_FILE_KEYS.has(key)) throw new UsageError(`The steps file has an unknown key "${key}".`);
  }
  if (!Array.isArray(body['steps'])) throw new UsageError('The steps file needs a "steps" array.');
  const chain: StepsChainOptions = {
    kind: 'steps',
    steps: body['steps'].map((step, index) => parseStep(step, `Step ${index + 1}`)),
  };
  if (body['stop_on_first'] !== undefined) {
    if (typeof body['stop_on_first'] !== 'boolean') throw new UsageError('stop_on_first must be true or false.');
    chain.stopOnFirst = body['stop_on_first'];
  }
  if (body['accept_catch_all'] !== undefined) {
    if (typeof body['accept_catch_all'] !== 'boolean') throw new UsageError('accept_catch_all must be true or false.');
    chain.acceptCatchAll = body['accept_catch_all'];
  }
  if (body['verify'] !== undefined && body['verify'] !== null) chain.verify = parseStep(body['verify'], 'verify');
  const mapping = body['output_mapping'];
  if (mapping !== undefined && mapping !== null) {
    if (!Array.isArray(mapping)) throw new UsageError('output_mapping must be an array of {path, target}.');
    chain.outputMapping = mapping.map((entry, index) => {
      if (!isRecord(entry) || typeof entry['path'] !== 'string' || typeof entry['target'] !== 'string') {
        throw new UsageError(`output_mapping ${index + 1} must be {"path": "...", "target": "..."}.`);
      }
      return { path: entry['path'], target: entry['target'] };
    });
  }
  return chain;
};
