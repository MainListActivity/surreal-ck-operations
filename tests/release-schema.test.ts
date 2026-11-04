import { describe, expect, test } from 'bun:test';
import type { Surreal } from 'surrealdb';
import { RECOVERY_READ_TABLES, schemaRequirementFor, LEGACY_SCHEMA_MINIMUM } from '../src/company-release.ts';
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
  test('0.3.76 and later need schema 49 and the three recovery-read tables; 0.3.77 also needs schema 50', () => {
    expect(schemaRequirementFor('0.3.76')).toEqual({ schema: 49, tables: [...RECOVERY_READ_TABLES] });
    expect(schemaRequirementFor('0.3.77')).toEqual({ schema: 50, tables: [...RECOVERY_READ_TABLES] });
    expect(schemaRequirementFor('0.4.0')).toEqual({ schema: 50, tables: [...RECOVERY_READ_TABLES] });
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

  test('the three tables and the marker let a 0.3.76 release be verified', async () => {
    const result = await verifyReleaseSchema(fakeDb(49, [...RECOVERY_READ_TABLES]), '0.3.76');
    expect(result).toMatchObject({ schema: 49, schemaVersion: 49 });
    expect(result.tables).toEqual([...RECOVERY_READ_TABLES]);
  });

  test('a missing table keeps the release unverified', async () => {
    const db = fakeDb(49, RECOVERY_READ_TABLES.filter(table => table !== 'recovery_read_chain'));
    await expect(verifyReleaseSchema(db, '0.3.76')).rejects.toThrow(/missing the tables/);
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
});
