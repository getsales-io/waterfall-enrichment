/**
 * Values copied from the GetSales public OpenAPI documents. A waterfall step
 * names a provider and an operation from these lists only; the live provider
 * catalog then says which of them the workspace can call today.
 */

/** `provider` enum of `list_provider_catalog` entries. */
export const SPEC_PROVIDERS = [
  'openai',
  'anthropic',
  'google',
  'deepseek',
  'xai',
  'voyage',
  'cohere',
  'hunter',
  'findymail',
  'anymailfinder',
  'emaillistverify',
  'custom',
  'hubspot',
  'salesforce',
  'gohighlevel',
  'pipedrive',
  'attio',
  'folk',
  'serper',
] as const;

/** `operation` enum of `list_provider_catalog` entries. */
export const SPEC_OPERATIONS = [
  'llm.generate',
  'llm.embed',
  'email.find',
  'email.verify',
  'http.request',
  'crm.contact_upsert',
  'crm.company_upsert',
  'crm.associate',
  'crm.properties_list',
  'crm.activity_log',
  'crm.list_entry_add',
  'crm.lists_list',
  'crm.deal_upsert',
  'crm.pipelines_list',
  'serp.search',
  'audio.transcribe',
] as const;

export const EMAIL_FIND = 'email.find';
export const EMAIL_VERIFY = 'email.verify';

/** The row's own work email as a waterfall step (people only, at most once). */
export const ROW_EMAIL_STEP = 'row:people.work_email';

/** At most 10 steps per waterfall column. */
export const MAX_WATERFALL_STEPS = 10;

/** At most 20 output mappings per waterfall column. */
export const MAX_OUTPUT_MAPPINGS = 20;

/** `scope.object_sids` of a run holds at most 10,000 sids. */
export const MAX_ROWS_PER_RUN = 10_000;

/** `page_size` of a search answers at most 500 rows. */
export const MAX_PAGE_SIZE = 500;

export const isSpecProvider = (value: string): boolean => (SPEC_PROVIDERS as readonly string[]).includes(value);

export const isSpecOperation = (value: string): boolean => (SPEC_OPERATIONS as readonly string[]).includes(value);
