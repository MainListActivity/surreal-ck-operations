import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Surreal } from 'surrealdb';
import { RECOVERY_READ_TABLES, schemaRequirementFor, LEGACY_SCHEMA_MINIMUM } from '../src/company-release.ts';
import { CLOUD_SCHEMA_VERSION } from '../src/database.ts';
import { readReleaseSchema, verifyReleaseSchema } from '../src/release-schema.ts';

// The upgrade records a release as verified only after the running database proves it reached the schema that
// version needs. These are synthetic receipts; the real fork proof lives in tests/recovery-read.fork.test.ts.
function fakeDb(schemaVersion: number | undefined, tables: string[], fail = false) {
  const db = {
    query: async () => {
      if (fail) throw new Error('database unreachable');
      return [[schemaVersion === undefined ? {} : { schema_version: schemaVersion }],
        { tables: Object.fromEntries(tables.map(table => [table, {}])) }];
    },
  } as unknown as Surreal;
  return db;
}

describe('the schema a target version must have reached', () => {
  test('0.3.76 and later need schema 49; 0.3.77 schema 50; 0.3.78 schema 51 with outbound_message; 0.3.79 schema 52 with route; 0.3.80 schema 52; 0.3.81 schema 53 with lane_note', () => {
    // Schema 052 removed the recovery-read tables again, so no version may require them anymore.
    expect(schemaRequirementFor('0.3.76')).toEqual({ schema: 49, tables: [] });
    expect(schemaRequirementFor('0.3.77')).toEqual({ schema: 50, tables: [] });
    expect(schemaRequirementFor('0.3.78')).toEqual({ schema: 51, tables: ['outbound_message'] });
    expect(schemaRequirementFor('0.3.79')).toEqual({ schema: 52, tables: ['route'] });
    expect(schemaRequirementFor('0.3.80')).toEqual({ schema: 52, tables: [] });
    expect(schemaRequirementFor('0.3.81')).toEqual({ schema: 53, tables: ['lane_note'] });
    expect(schemaRequirementFor('0.3.82')).toEqual({ schema: 53, tables: [] });
    expect(schemaRequirementFor('0.3.90')).toEqual({ schema: 53, tables: [] });
    expect(schemaRequirementFor('0.4.0').schema).toBe(58);
  });

  test('an older target keeps the older minimum: 49 is not forced onto every historical version', () => {
    expect(schemaRequirementFor('0.3.75')).toEqual({ schema: LEGACY_SCHEMA_MINIMUM, tables: [] });
    expect(schemaRequirementFor('0.2.0')).toEqual({ schema: LEGACY_SCHEMA_MINIMUM, tables: [] });
  });

  test('the receipt is read only and reports the marker and the tables', async () => {
    const receipt = await readReleaseSchema(fakeDb(49, [...RECOVERY_READ_TABLES]));
    expect(receipt.schemaVersion).toBe(49);
    expect(receipt.tables).toEqual([...RECOVERY_READ_TABLES]);
  });

  test('the marker alone lets a 0.3.76 release be verified on a post-052 database', async () => {
    const result = await verifyReleaseSchema(fakeDb(49, ['outbound_message', 'route']), '0.3.76');
    expect(result).toMatchObject({ schema: 49, schemaVersion: 49 });
    expect(result.tables).toEqual([]);
  });

  test('a missing table keeps the release unverified', async () => {
    const db = fakeDb(52, []);
    await expect(verifyReleaseSchema(db, '0.3.79')).rejects.toThrow(/missing the tables/);
  });

  test('an old marker keeps the release unverified', async () => {
    const db = fakeDb(41, [...RECOVERY_READ_TABLES]);
    await expect(verifyReleaseSchema(db, '0.3.76')).rejects.toThrow(/below the 49/);
  });

  test('an unreadable receipt keeps the release unverified', async () => {
    const db = fakeDb(49, [...RECOVERY_READ_TABLES], true);
    await expect(verifyReleaseSchema(db, '0.3.76')).rejects.toThrow(/unreadable/);
  });

  test('an older target is verified by the old minimum alone', async () => {
    const result = await verifyReleaseSchema(fakeDb(41, []), '0.3.75');
    expect(result).toMatchObject({ schema: LEGACY_SCHEMA_MINIMUM, schemaVersion: 41, tables: [] });
  });

  test('0.5.0 needs schema 60; 0.6.0 needs schema 61 and the node tables; 0.7.0 needs schema 61; 0.7.1 needs schema 62 (outbox dropped)', () => {
    expect(schemaRequirementFor('0.5.0')).toEqual({ schema: 60, tables: [] });
    expect(schemaRequirementFor('0.6.0')).toEqual({ schema: 61, tables: ['node_release', 'node_rollback'] });
    expect(schemaRequirementFor('0.7.0')).toEqual({ schema: 61, tables: [] });
    expect(schemaRequirementFor('0.7.1')).toEqual({ schema: 62, tables: [] });
    expect(CLOUD_SCHEMA_VERSION).toBe(62);
  });

  test('the version in package.json needs the schema this code applies', () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, '../package.json'), 'utf8')) as { version: string };
    expect(schemaRequirementFor(pkg.version).schema).toBe(CLOUD_SCHEMA_VERSION);
  });
});
