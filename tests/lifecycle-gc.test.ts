import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { junkPathsFromPorcelain, meaningfulChanges, sweepArchiveBatches, sweepInstanceDirs } from '../src/dispatcher/lifecycle-gc.ts';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const now = new Date('2026-10-20T12:00:00.000Z');

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sck-gc-'));
  roots.push(dir);
  return dir;
}
function dirAt(parent: string, name: string, ageMs: number, file = 'payload.bin', bytes = 4096): string {
  const path = join(parent, name);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, file), Buffer.alloc(bytes, 1));
  const t = new Date(now.getTime() - ageMs);
  utimesSync(path, t, t);
  return path;
}

describe('meaningfulChanges', () => {
  test('untracked dependency trees are not work', () => {
    expect(meaningfulChanges('?? node_modules')).toBe(false);
    expect(meaningfulChanges('?? node_modules/\n?? plugin/node_modules/')).toBe(false);
    expect(meaningfulChanges('?? web/node_modules/.bin/x')).toBe(false);
    expect(meaningfulChanges('?? .venv/\n?? dist/\n?? build/')).toBe(false);
  });

  test('real untracked files and any tracked change are work', () => {
    expect(meaningfulChanges('?? wip.txt')).toBe(true);
    expect(meaningfulChanges('?? node_modules\n?? src/real-change.ts')).toBe(true);
    // Tracked modifications always count, even under a junk-looking path.
    expect(meaningfulChanges(' M package.json')).toBe(true);
    expect(meaningfulChanges(' M node_modules/foo/index.js')).toBe(true);
    expect(meaningfulChanges(' D src/old.ts')).toBe(true);
  });

  test('a clean tree is not dirty', () => {
    expect(meaningfulChanges('')).toBe(false);
    expect(meaningfulChanges('\n')).toBe(false);
  });
});

describe('sweepInstanceDirs', () => {
  const keep = new Set(['qa-codex-aaaaaa']);
  const graceMs = 48 * HOUR;

  test('removes dead channels past the grace, keeps live and young ones', async () => {
    const home = root();
    dirAt(home, 'qa-codex-aaaaaa', 30 * DAY);       // live: always kept
    dirAt(home, 'eng-devin-bbbbbb', 5 * DAY);       // dead and old: removed
    dirAt(home, 'eng-devin-cccccc', 1 * HOUR);      // dead but young: kept
    const result = await sweepInstanceDirs({ root: home, now, graceMs, keep });
    expect(result.removed).toEqual(['eng-devin-bbbbbb']);
    expect(result.bytes).toBeGreaterThan(0);
    expect(existsSync(join(home, 'eng-devin-bbbbbb'))).toBe(false);
    expect(existsSync(join(home, 'qa-codex-aaaaaa'))).toBe(true);
    expect(existsSync(join(home, 'eng-devin-cccccc'))).toBe(true);
  });

  test('foreign names are never removed and dry-run leaves everything', async () => {
    const home = root();
    dirAt(home, 'tasks', 30 * DAY);
    dirAt(home, 'report.md', 30 * DAY);
    dirAt(home, 'eng-devin-dddddd', 30 * DAY);
    const dry = await sweepInstanceDirs({ root: home, now, graceMs, keep, dryRun: true });
    expect(dry.removed).toEqual(['eng-devin-dddddd']);
    expect(existsSync(join(home, 'eng-devin-dddddd'))).toBe(true);
    const real = await sweepInstanceDirs({ root: home, now, graceMs, keep });
    expect(real.removed).toEqual(['eng-devin-dddddd']);
    expect(existsSync(join(home, 'tasks'))).toBe(true);
    expect(existsSync(join(home, 'report.md'))).toBe(true);
  });
});

describe('sweepArchiveBatches', () => {
  const retentionMs = 7 * DAY;

  test('removes only cold batches past retention', async () => {
    const home = root();
    dirAt(home, 'evidence-2026-10-01', 20 * DAY);
    dirAt(home, 'deliverables-2026-10-19', 1 * DAY);
    dirAt(home, 'evidence-2026-10-18', 2 * DAY);
    const result = await sweepArchiveBatches({ root: home, now, retentionMs });
    expect(result.removed).toEqual(['evidence-2026-10-01']);
    expect(existsSync(join(home, 'evidence-2026-10-01'))).toBe(false);
    expect(existsSync(join(home, 'deliverables-2026-10-19'))).toBe(true);
    expect(existsSync(join(home, 'evidence-2026-10-18'))).toBe(true);
  });

  test('unrecognised names are left for a human', async () => {
    const home = root();
    dirAt(home, 'manual-keep', 90 * DAY);
    dirAt(home, 'notes.txt', 90 * DAY);
    const result = await sweepArchiveBatches({ root: home, now, retentionMs });
    expect(result.removed).toEqual([]);
    expect(existsSync(join(home, 'manual-keep'))).toBe(true);
    expect(existsSync(join(home, 'notes.txt'))).toBe(true);
  });
});

describe('junkPathsFromPorcelain', () => {
  test('trims an untracked junk tree to its junk root', () => {
    expect(junkPathsFromPorcelain('?? node_modules/')).toEqual(['node_modules']);
    expect(junkPathsFromPorcelain('?? web/node_modules/.bin/x\n?? dist/')).toEqual(['web/node_modules', 'dist']);
    expect(junkPathsFromPorcelain('?? plugin/node_modules/\n?? plugin/bun.lock')).toEqual(['plugin/node_modules']);
  });

  test('real files, tracked changes and unsafe paths are never returned', () => {
    expect(junkPathsFromPorcelain('?? wip.txt')).toEqual([]);
    expect(junkPathsFromPorcelain(' M package.json')).toEqual([]);
    expect(junkPathsFromPorcelain('?? ../escape/node_modules')).toEqual([]);
    expect(junkPathsFromPorcelain('?? /abs/node_modules')).toEqual([]);
    expect(junkPathsFromPorcelain('')).toEqual([]);
  });
});
