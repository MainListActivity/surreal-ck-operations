import type { Surreal } from 'surrealdb';
import { CompanyError } from './core-errors.ts';
import { schemaRequirementFor } from './company-release.ts';

/**
 * The startup migration receipt of a running release: the schema marker the bootstrap wrote and the
 * tables that exist in that database. It is read only — the verification never writes a marker and never
 * changes a row.
 */
export interface ReleaseSchemaReceipt { schemaVersion?: number; tables: string[] }

/** Read the receipt. A database that cannot be read is a failure, not an empty receipt. */
export async function readReleaseSchema(db: Surreal): Promise<ReleaseSchemaReceipt> {
  let marker: { schema_version?: number } | undefined;
  let info: { tables?: Record<string, unknown> } | undefined;
  // A SELECT ... FROM ONLY answers with the row itself; a plain SELECT answers with a row list.
  const first = (value: unknown): unknown => (Array.isArray(value) ? value[0] : value);
  try {
    const [markerRows, infoRows] = await db.query<[unknown, { tables?: Record<string, unknown> } | undefined]>(
      'SELECT schema_version FROM ONLY company_meta:installation; INFO FOR DB;');
    marker = first(markerRows) as { schema_version?: number } | undefined;
    info = infoRows ?? undefined;
  } catch (error) {
    throw new CompanyError('invalid', `schema receipt unreadable: ${String((error as Error)?.message ?? error).slice(0, 160)}`);
  }
  const tables = Object.keys(info?.tables ?? {});
  return { ...(marker?.schema_version === undefined ? {} : { schemaVersion: marker.schema_version }), tables };
}

/**
 * Check a target version against the receipt of the running database.
 *
 * The requirement comes from the target version, so an older target keeps the older minimum and a newer
 * target has to prove the newer schema and its tables. Anything missing keeps the release unverified.
 */
export async function verifyReleaseSchema(db: Surreal, version: string): Promise<{ schema: number; tables: string[]; schemaVersion: number }> {
  const required = schemaRequirementFor(version);
  const receipt = await readReleaseSchema(db);
  const schemaVersion = receipt.schemaVersion ?? 0;
  if (schemaVersion < required.schema) {
    throw new CompanyError('invalid', `schema ${schemaVersion} is below the ${required.schema} required by ${version}`);
  }
  const missing = required.tables.filter(table => !receipt.tables.includes(table));
  if (missing.length > 0) {
    throw new CompanyError('invalid', `schema ${schemaVersion} is missing the tables ${missing.join(', ')} required by ${version}`);
  }
  return { schema: required.schema, tables: required.tables, schemaVersion };
}
