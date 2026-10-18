import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  artifactPolicyFrom, artifactReclaimEnabledFrom, decideArtifact, keepsFile,
  TOMBSTONE, trimArtifactDir, type ArtifactPolicy,
} from '../src/dispatcher/artifact-reclaim.ts';

const DAY = 86_400_000;
const MB = 1_048_576;
const now = new Date('2026-10-18T00:00:00.000Z');
const policy = (over: Partial<ArtifactPolicy> = {}): ArtifactPolicy => ({
  ...artifactPolicyFrom({ artifactReclaimEnabled: true, artifactEvidenceGraceDays: 3, artifactDeliverableGraceDays: 7 }, {}, now),
  ...over,
});

const roots: string[] = [];
function serviceHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'sck-artifact-'));
  mkdirSync(join(home, 'evidence'), { recursive: true });
  mkdirSync(join(home, 'deliverables'), { recursive: true });
  mkdirSync(join(home, 'logs'), { recursive: true });
  roots.push(home);
  return home;
}
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

function seed(home: string, kind: 'evidence' | 'deliverables', taskId: string, files: Record<string, number | string>): string {
  const dir = join(home, kind, taskId);
  mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const path = join(dir, rel);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, typeof content === 'number' ? Buffer.alloc(content, 1) : content);
  }
  return dir;
}

const meta = { trigger: 'sweep' as const, runId: 'run-1', now };
const tree = (dir: string) => readdirSync(dir, { recursive: true }).sort();

describe('artifact keep rules', () => {
  test('small files and text stay, heavy media and archives go', () => {
    const rules = { keepSmallBytes: 128 * 1024, keepTextBytes: 2 * MB };
    expect(keepsFile('notes.md', 400_000, rules)).toBe(true);       // text under the text ceiling
    expect(keepsFile('thumb.png', 40_000, rules)).toBe(true);        // anything tiny stays
    expect(keepsFile('report.json', 8 * MB, rules)).toBe(false);     // text past the ceiling is heavy too
    expect(keepsFile('frame-001.png', 3 * MB, rules)).toBe(false);
    expect(keepsFile('render.mp4', 900 * MB, rules)).toBe(false);
    expect(keepsFile('delivery.zip', 1_600 * MB, rules)).toBe(false);
    expect(keepsFile(TOMBSTONE, 4096, rules)).toBe(true);
  });
});

describe('lifecycle decisions come from task state and the audit clock', () => {
  const terminal = { terminalAt: new Date(now.getTime() - 10 * DAY) };
  test('only terminal tasks qualify', () => {
    expect(decideArtifact({ kind: 'evidence', state: 'doing', protection: 'none', tombstoned: false, terminalAt: terminal.terminalAt }, policy(), 'normal').reasons)
      .toEqual(['task-not-terminal']);
    expect(decideArtifact({ kind: 'evidence', state: 'done', protection: 'none', tombstoned: false, terminalAt: terminal.terminalAt }, policy(), 'normal').action)
      .toBe('trim');
    expect(decideArtifact({ kind: 'evidence', state: undefined, protection: 'none', tombstoned: false, terminalAt: new Date() }, policy(), 'normal').reasons)
      .toEqual(['no-task-row']);
  });
  test('grace windows differ per kind and retired work moves sooner', () => {
    const at = (days: number) => new Date(now.getTime() - days * DAY);
    const done = (kind: 'evidence' | 'deliverables', terminalAt: Date) =>
      decideArtifact({ kind, state: 'done', protection: 'none', tombstoned: false, terminalAt }, policy(), 'normal');
    expect(done('evidence', at(3)).action).toBe('trim');
    expect(done('evidence', at(2)).action).toBe('keep');
    expect(done('deliverables', at(3)).action).toBe('keep');   // owner-facing links live longer
    expect(done('deliverables', at(7)).action).toBe('trim');
    const retired = (kind: 'evidence' | 'deliverables', terminalAt: Date) =>
      decideArtifact({ kind, state: 'void', protection: 'none', tombstoned: false, terminalAt }, policy(), 'normal');
    expect(retired('evidence', at(1)).action).toBe('trim');   // void is not an accepted result
    expect(retired('deliverables', at(1)).action).toBe('trim');
    expect(retired('evidence', at(0.5)).action).toBe('keep');
  });
  test('unfinished work keeps its ancestors; pressure gives up the indirect ones first', () => {
    const direct = { kind: 'evidence' as const, state: 'done', tombstoned: false, terminalAt: new Date(now.getTime() - 30 * DAY), protection: 'direct' as const };
    expect(decideArtifact(direct, policy(), 'pressure').reasons).toEqual(['needed-by-open-task']);
    expect(decideArtifact({ ...direct, protection: 'direct' }, policy(), 'normal').reasons).toEqual(['needed-by-open-task']);
    expect(decideArtifact({ ...direct, protection: 'indirect' }, policy(), 'normal').reasons).toEqual(['needed-by-open-task']);
    expect(decideArtifact({ ...direct, protection: 'indirect' }, policy(), 'pressure').action).toBe('trim');
    expect(decideArtifact({ ...direct, protection: 'none' }, policy(), 'normal').action).toBe('trim');
  });
  test('pressure trims inside the normal grace once the disk is heading down', () => {
    const fresh = { kind: 'deliverables' as const, state: 'done', protection: 'none' as const, tombstoned: false, terminalAt: new Date(now.getTime() - 13 * 3_600_000) };
    expect(decideArtifact(fresh, policy(), 'normal').action).toBe('keep');
    expect(decideArtifact(fresh, policy(), 'pressure').reasons).toEqual(['disk-pressure']);
    const minutes = { kind: 'deliverables' as const, state: 'done', protection: 'none' as const, tombstoned: false, terminalAt: new Date(now.getTime() - 60 * 60_000) };
    expect(decideArtifact(minutes, policy(), 'pressure').action).toBe('keep');
  });
  test('the kill switch and the already-trimmed marker both refuse', () => {
    const off = policy({ enabled: false });
    expect(decideArtifact({ kind: 'evidence', state: 'done', protection: 'none', tombstoned: false, terminalAt: new Date(0) }, off, 'normal').reasons)
      .toEqual(['reclaim-disabled']);
    expect(decideArtifact({ kind: 'evidence', state: 'done', protection: 'none', tombstoned: true, terminalAt: new Date(0) }, policy(), 'pressure').reasons)
      .toEqual(['already-trimmed']);
    expect(decideArtifact({ kind: 'evidence', state: 'done', protection: 'none', tombstoned: false, terminalAt: undefined }, policy(), 'normal').reasons)
      .toEqual(['no-authority-clock']);
    expect(artifactReclaimEnabledFrom({ SCK_ARTIFACT_RECLAIM: '0' }, { artifactReclaimEnabled: true })).toBe(false);
    expect(artifactReclaimEnabledFrom({ SCK_ARTIFACT_RECLAIM: '1' }, { artifactReclaimEnabled: false })).toBe(true);
    expect(artifactReclaimEnabledFrom({}, { artifactReclaimEnabled: false })).toBe(false);
  });
});

describe('trimArtifactDir', () => {
  const rules = { keepSmallBytes: 128 * 1024, keepTextBytes: 2 * MB };
  test('keeps the small trail, removes the heavy files, records a tombstone', async () => {
    const home = serviceHome();
    seed(home, 'evidence', 'task-a', {
      'report.md': '# 验收记录', 'log.txt': 'ok', 'timeline.json': '{}',
      'frames/frame-0001.png': 3 * MB, 'render/final.mp4': 40 * MB, 'bundle.zip': 12 * MB,
    });
    const result = await trimArtifactDir({ root: join(home, 'evidence'), kind: 'evidence', taskId: 'task-a', rules, meta });
    expect(result.removedFiles).toBe(3);
    expect(result.removedBytes).toBe(55 * MB);
    expect(result.keptFiles).toBe(3);
    expect(result.errors).toBe(0);
    expect(tree(join(home, 'evidence', 'task-a'))).toEqual([TOMBSTONE, 'log.txt', 'report.md', 'timeline.json']);
    const tombstone = JSON.parse(await Bun.file(join(home, 'evidence', 'task-a', TOMBSTONE)).text());
    expect(tombstone.version).toBe(1);
    expect(tombstone.taskId).toBe('task-a');
    expect(tombstone.kind).toBe('evidence');
    expect(tombstone.trigger).toBe('sweep');
    expect(tombstone.reclaimedAt).toBe(now.toISOString());
    expect(tombstone.removedFiles).toBe(3);
    expect(tombstone.removedBytes).toBe(55 * MB);
    expect(tombstone.byExt['.png']).toEqual({ files: 1, bytes: 3 * MB });
    expect(tombstone.largest[0]).toEqual({ path: 'render/final.mp4', bytes: 40 * MB });
  });
  test('a dependency tree is never evidence', async () => {
    const home = serviceHome();
    seed(home, 'evidence', 'task-b', { 'app/node_modules/left-pad/index.js': 'x', 'app/package.json': '{}', 'shot.png': 5 * MB });
    const result = await trimArtifactDir({ root: join(home, 'evidence'), kind: 'evidence', taskId: 'task-b', rules, meta });
    expect(result.junkDirs).toEqual(['app/node_modules']);
    expect(result.removedFiles).toBe(2); // the junk file + the shot
    expect(tree(join(home, 'evidence', 'task-b', 'app'))).toEqual(['package.json']);
  });
  test('dry-run changes nothing, symlinks are counted but never followed or removed', async () => {
    const home = serviceHome();
    seed(home, 'evidence', 'task-c', { 'shot.png': 6 * MB, 'note.md': 'hi' });
    symlinkSync('/etc/passwd', join(home, 'evidence', 'task-c', 'link.txt'));
    const before = tree(join(home, 'evidence', 'task-c'));
    const result = await trimArtifactDir({ root: join(home, 'evidence'), kind: 'evidence', taskId: 'task-c', rules, dryRun: true, meta });
    expect(result.dryRun).toBe(true);
    expect(result.removedFiles).toBe(1);
    expect(result.removedBytes).toBe(6 * MB);
    expect(result.symlinks).toBe(1);
    expect(tree(join(home, 'evidence', 'task-c'))).toEqual(before);
    expect(readdirSync(join(home, 'evidence', 'task-c'))).toContain('link.txt');
  });
  test('nothing to trim means no tombstone: a task dir is re-checked, not marked done', async () => {
    const home = serviceHome();
    seed(home, 'evidence', 'task-d', { 'note.md': 'hi' });
    const result = await trimArtifactDir({ root: join(home, 'evidence'), kind: 'evidence', taskId: 'task-d', rules, meta });
    expect(result.removedFiles).toBe(0);
    expect(tree(join(home, 'evidence', 'task-d'))).toEqual(['note.md']);
  });
  test('refuses anything that is not a plain task directory under the root', async () => {
    const home = serviceHome();
    for (const bad of ['../escape', 'a/b', '', '.', 'has space', 'x'.repeat(129), 'loose-file.png']) {
      const result = await trimArtifactDir({ root: join(home, 'evidence'), kind: 'evidence', taskId: bad, rules, meta });
      expect(result.refused).toBeDefined();
      expect(['invalid-task-id', 'missing', 'not-a-plain-directory']).toContain(result.refused!);
    }
    writeFileSync(join(home, 'evidence', 'loosetxt'), 'x');
    expect((await trimArtifactDir({ root: join(home, 'evidence'), kind: 'evidence', taskId: 'loosetxt', rules, meta })).refused)
      .toBe('not-a-plain-directory');
    const outside = mkdtempSync(join(tmpdir(), 'sck-outside-'));
    roots.push(outside);
    symlinkSync(outside, join(home, 'evidence', 'linked-dir'));
    expect((await trimArtifactDir({ root: join(home, 'evidence'), kind: 'evidence', taskId: 'linked-dir', rules, meta })).refused)
      .toBe('not-a-plain-directory');
  });
  test('a run cut short by its deadline reports partial and writes no tombstone', async () => {
    const home = serviceHome();
    seed(home, 'evidence', 'task-e', { 'a.png': 3 * MB, 'b.png': 3 * MB, 'c.png': 3 * MB });
    const result = await trimArtifactDir({
      root: join(home, 'evidence'), kind: 'evidence', taskId: 'task-e', rules, meta, deadline: Date.now() - 1,
    });
    expect(result.partial).toBe(true);
    expect(readdirSync(join(home, 'evidence', 'task-e'))).not.toContain(TOMBSTONE);
  });
});