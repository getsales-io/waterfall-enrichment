import type { CsvTable } from './csv.js';
import { UsageError } from './errors.js';
import type { FieldMappingEntry, ObjectType } from './types.js';

/**
 * Where a CSV column goes. Attribute targets travel in the import's
 * `field_mapping`; first and last name are joined into one Full name column
 * of the uploaded copy, since the import takes the name as `full_name`.
 */
export type MapTarget =
  | { kind: 'people_attribute'; target: string }
  | { kind: 'company_attribute'; target: string }
  | { kind: 'first_name' }
  | { kind: 'last_name' };

/** Targets of a people CSV, by the name `--map` takes. */
export const PEOPLE_TARGETS: Readonly<Record<string, MapTarget>> = {
  full_name: { kind: 'people_attribute', target: 'full_name' },
  first_name: { kind: 'first_name' },
  last_name: { kind: 'last_name' },
  work_email: { kind: 'people_attribute', target: 'work_email' },
  personal_email: { kind: 'people_attribute', target: 'personal_email' },
  company_name: { kind: 'people_attribute', target: 'company_name' },
  ln_nickname: { kind: 'people_attribute', target: 'ln_nickname' },
  ln_member_id: { kind: 'people_attribute', target: 'ln_member_id' },
  ln_id: { kind: 'people_attribute', target: 'ln_id' },
  sn_id: { kind: 'people_attribute', target: 'sn_id' },
  'company.domain': { kind: 'company_attribute', target: 'domain' },
  'company.website': { kind: 'company_attribute', target: 'website' },
};

/** Targets of a company CSV, by the name `--map` takes. */
export const COMPANY_TARGETS: Readonly<Record<string, MapTarget>> = {
  name: { kind: 'company_attribute', target: 'name' },
  domain: { kind: 'company_attribute', target: 'domain' },
  website: { kind: 'company_attribute', target: 'website' },
  ln_nickname: { kind: 'company_attribute', target: 'ln_nickname' },
  ln_id: { kind: 'company_attribute', target: 'ln_id' },
};

/** Header spellings recognized without `--map`, after normalizing (lowercase, words split on anything but a-z0-9). */
const PEOPLE_ALIASES: Readonly<Record<string, readonly string[]>> = {
  full_name: ['full name', 'fullname', 'name', 'contact name', 'person name'],
  first_name: ['first name', 'firstname', 'given name', 'first'],
  last_name: ['last name', 'lastname', 'surname', 'family name', 'last'],
  work_email: ['email', 'e mail', 'email address', 'e mail address', 'work email', 'work email address', 'business email', 'mail'],
  personal_email: ['personal email', 'personal email address', 'private email'],
  company_name: ['company', 'company name', 'organization', 'organisation', 'employer', 'account name'],
  ln_nickname: ['ln nickname', 'linkedin public id', 'public id'],
  ln_member_id: ['ln member id'],
  ln_id: ['ln id'],
  sn_id: ['sn id'],
  'company.domain': ['domain', 'company domain', 'website domain'],
  'company.website': ['website', 'company website', 'web site', 'homepage', 'company url'],
};

const COMPANY_ALIASES: Readonly<Record<string, readonly string[]>> = {
  name: ['name', 'company', 'company name', 'organization', 'organisation', 'account name', 'account'],
  domain: ['domain', 'company domain', 'website domain'],
  website: ['website', 'company website', 'web site', 'homepage', 'url', 'company url'],
  ln_nickname: ['ln nickname', 'linkedin public id', 'public id'],
  ln_id: ['ln id'],
};

/** The header of the column built from first and last name. */
export const BUILT_FULL_NAME_HEADER = 'Full name';

export const normalizeHeader = (header: string): string =>
  header
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** One column the import maps, for display. */
export interface MappedColumn {
  index: number;
  header: string;
  target: string;
}

/** What the uploaded copy carries and how the import maps it. */
export interface MappingPlan {
  objectType: ObjectType;
  /** `field_mapping` of `import_data_source`. */
  entries: FieldMappingEntry[];
  /** The mapped columns of the uploaded copy. */
  columns: MappedColumn[];
  /** Header row of the uploaded copy: the input's, plus the built Full name column when there is one. */
  uploadHeaders: string[];
  /** Data rows of the uploaded copy, in input order. */
  uploadRows: string[][];
  /** True when a Full name column was built from first and last name. */
  builtFullName: boolean;
  /** Which inputs the rows carry, for the finder inputs and their pre-flight check. */
  has: { name: boolean; company: boolean; domain: boolean; lnNickname: boolean; workEmail: boolean };
  warnings: string[];
}

const targetsFor = (objectType: ObjectType): Readonly<Record<string, MapTarget>> =>
  objectType === 'people' ? PEOPLE_TARGETS : COMPANY_TARGETS;

const aliasesFor = (objectType: ObjectType): Readonly<Record<string, readonly string[]>> =>
  objectType === 'people' ? PEOPLE_ALIASES : COMPANY_ALIASES;

const findHeader = (headers: readonly string[], wanted: string): number => {
  const exact = headers.indexOf(wanted);
  if (exact >= 0) return exact;
  const normalized = normalizeHeader(wanted);
  return headers.findIndex((header) => normalizeHeader(header) === normalized);
};

/**
 * Decides the import's column mapping. `overrides` maps a header to a target
 * name, or to null to leave a column out of the recognition; every other
 * column is recognized by its header, the first column winning a target.
 */
export const planMapping = (
  table: CsvTable,
  objectType: ObjectType,
  overrides: Readonly<Record<string, string | null>> = {},
): MappingPlan => {
  const targets = targetsFor(objectType);
  const aliases = aliasesFor(objectType);
  const assigned = new Map<string, number>();
  const taken = new Set<number>();
  const warnings: string[] = [];

  for (const [header, target] of Object.entries(overrides)) {
    const index = findHeader(table.headers, header);
    if (index < 0) {
      throw new UsageError(`--map names a column "${header}" the CSV does not have. Columns: ${table.headers.join(', ')}.`);
    }
    if (taken.has(index)) throw new UsageError(`--map names the column "${header}" twice.`);
    taken.add(index);
    if (target === null) continue;
    if (!Object.hasOwn(targets, target)) {
      throw new UsageError(`--map target "${target}" is not one of the ${objectType} targets: ${Object.keys(targets).join(', ')}.`);
    }
    if (assigned.has(target)) throw new UsageError(`--map sends two columns to ${target}.`);
    assigned.set(target, index);
  }

  const aliasToTarget = new Map<string, string>();
  for (const [target, spellings] of Object.entries(aliases)) {
    for (const spelling of spellings) aliasToTarget.set(spelling, target);
  }
  table.headers.forEach((header, index) => {
    if (taken.has(index)) return;
    const target = aliasToTarget.get(normalizeHeader(header));
    if (target === undefined) return;
    const holder = assigned.get(target);
    if (holder !== undefined) {
      warnings.push(`Column "${header}" also reads as ${target}, and "${table.headers[holder]}" is used.`);
      return;
    }
    assigned.set(target, index);
  });

  const uploadHeaders = [...table.headers];
  let uploadRows = table.rows.map((row) => [...row]);
  let builtFullName = false;
  const firstIndex = assigned.get('first_name');
  const lastIndex = assigned.get('last_name');
  if (objectType === 'people' && !assigned.has('full_name') && (firstIndex !== undefined || lastIndex !== undefined)) {
    let header = BUILT_FULL_NAME_HEADER;
    for (let n = 2; uploadHeaders.includes(header); n += 1) header = `${BUILT_FULL_NAME_HEADER} ${n}`;
    uploadHeaders.push(header);
    uploadRows = uploadRows.map((row) => {
      const parts = [firstIndex, lastIndex].map((i) => (i === undefined ? '' : (row[i] ?? '').trim())).filter((part) => part !== '');
      return [...row, parts.join(' ')];
    });
    assigned.set('full_name', uploadHeaders.length - 1);
    builtFullName = true;
  }

  const entries: FieldMappingEntry[] = [];
  const columns: MappedColumn[] = [];
  const ordered = [...assigned.entries()].sort((a, b) => a[1] - b[1]);
  for (const [targetName, index] of ordered) {
    const target = targets[targetName];
    if (target === undefined || target.kind === 'first_name' || target.kind === 'last_name') continue;
    entries.push({ source: String(index), target_kind: target.kind, target: target.target });
    columns.push({ index, header: uploadHeaders[index] ?? '', target: targetName });
  }

  const has =
    objectType === 'people'
      ? {
          name: assigned.has('full_name'),
          company: assigned.has('company_name'),
          domain: assigned.has('company.domain') || assigned.has('company.website'),
          lnNickname: assigned.has('ln_nickname'),
          workEmail: assigned.has('work_email'),
        }
      : {
          name: assigned.has('name'),
          company: assigned.has('name'),
          domain: assigned.has('domain') || assigned.has('website'),
          lnNickname: assigned.has('ln_nickname'),
          workEmail: false,
        };

  return { objectType, entries, columns, uploadHeaders, uploadRows, builtFullName, has, warnings };
};

/** Parses `--map` values of the form `Header=target`, or `Header=-` to leave a column out. */
export const parseMapOverrides = (values: readonly string[]): Record<string, string | null> => {
  const overrides: Record<string, string | null> = {};
  for (const value of values) {
    const at = value.lastIndexOf('=');
    if (at <= 0 || at === value.length - 1) {
      throw new UsageError(`--map takes "Column header=target" (or "Column header=-" to skip a column), got "${value}".`);
    }
    const header = value.slice(0, at).trim();
    const target = value.slice(at + 1).trim();
    if (Object.hasOwn(overrides, header)) throw new UsageError(`--map names the column "${header}" twice.`);
    overrides[header] = target === '-' ? null : target;
  }
  return overrides;
};
