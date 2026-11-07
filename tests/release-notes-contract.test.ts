import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { releaseNotesSchema } from '../src/company-release.ts';

// The release notes are the material the upgrade card is built from: `readCompanyRelease` parses them with
// `releaseNotesSchema` and refuses anything else. A green CI that ships notes the schema rejects leaves the
// upgrade unregistrable, so the contract is checked here on every pull request.
const ROOT = join(import.meta.dir, '..');

const notes = JSON.parse(await Bun.file(join(ROOT, 'company-release.json')).text()) as Record<string, unknown>;
const pkg = JSON.parse(await Bun.file(join(ROOT, 'package.json')).text()) as { version: string };
const pluginPkg = JSON.parse(await Bun.file(join(ROOT, 'plugin/package.json')).text()) as { version: string };

describe('the release notes are registrable', () => {
  test('company-release.json parses with the schema the upgrade card uses', () => {
    const parsed = releaseNotesSchema.safeParse(notes);
    if (!parsed.success) console.log(JSON.stringify(parsed.error.issues, null, 1));
    expect(parsed.success).toBe(true);
  });

  test('the notes stay inside the schema limits, stated explicitly', () => {
    const changes = notes.changes as string[];
    expect(changes.length).toBeGreaterThan(0);
    expect(changes.length).toBeLessThanOrEqual(10);
    for (const change of changes) expect(change.length).toBeLessThanOrEqual(240);
    expect(Buffer.byteLength(JSON.stringify(notes))).toBeLessThanOrEqual(5000);
    const impact = notes.impact as string[];
    expect(impact.length).toBeLessThanOrEqual(8);
    for (const item of impact) expect(item.length).toBeLessThanOrEqual(240);
    expect((notes.migration as string).length).toBeLessThanOrEqual(400);
    expect((notes.rollback as string).length).toBeLessThanOrEqual(400);
  });

  test('the version is the one the packages carry', () => {
    expect(notes.version).toBe(pkg.version);
    expect(notes.version).toBe(pluginPkg.version);
  });

  test('the notes name the schema they reuse', () => {
    const text = JSON.stringify(notes);
    expect(text).toContain('lane_note');
    expect(text).toContain('053');
  });

  test('the limits are real: an eleventh change or a long one is refused', () => {
    const many = { ...notes, changes: Array.from({ length: 11 }, (_, index) => `变更 ${index}`) };
    expect(releaseNotesSchema.safeParse(many).success).toBe(false);
    const long = { ...notes, changes: ['x'.repeat(241)] };
    expect(releaseNotesSchema.safeParse(long).success).toBe(false);
    const heavy = { ...notes, changes: Array.from({ length: 10 }, () => '变'.repeat(240)) };
    expect(releaseNotesSchema.safeParse(heavy).success).toBe(false);
  });
});
