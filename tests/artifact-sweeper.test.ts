import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TOMBSTONE, type ArtifactKind } from '../src/dispatcher/artifact-reclaim.ts';
import {
  ArtifactReclaimer, summarizeReclaim, type ArtifactTaskInfo, type ArtifactTaskSource,
} from '../src/dispatcher/artifact-sweeper.ts';

const DAY = 86_400_000;
const MB = 1_048_576;
const now = new Date('2026-10-18T00:00:00.000Z');
const ago = (days: number) => new Date(now.getTime() - days * DAY);

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

function serviceHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'sck-sweeper-'));
  for (const dir of ['evidence', 'deliverables', 'logs']) mkdirSync(join(home, dir), { recursive: true });
  roots.push(home);
  return home;
}

function seed(home: string, kind: ArtifactKind, taskId: string, bytes: number): void {
  const dir = join(home, kind, taskId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'payload.bin'), Buffer.alloc(bytes, 1));
  writeFileSync(join(dir, 'note.md'), '# trail');
}

/** Task source stub: the DB adapter's shape without a database. */
function source(tasks: Record<string, ArtifactTaskInfo>): ArtifactTaskSource {
  return { tasks: async () => new Map(Object.entries(tasks)) };
}

interface Harness {
  home: string;
  reclaimer: ArtifactReclaimer;
  setFree: (mb: number) => void;
  /** Model the probe off what was actually trimmed: each finished task dir frees its payload. */
  freeFromTrimmed: (startMb: number, perTaskMb: number) => void;
  setTasks: (tasks: Record<string, ArtifactTaskInfo>) => void;
  logs: string[];
}
function harness(tasks: Record<string, ArtifactTaskInfo>, freeDiskMb = 65_536): Harness {
  const home = serviceHome();
  const logs: string[] = [];
  let free = freeDiskMb;
  let rows = tasks;
  const probe = () => free;
  const reclaimer = new ArtifactReclaimer({
    home,
    tasks: { tasks: async () => new Map(Object.entries(rows)) },
    config: async () => ({ artifactReclaimEnabled: true, artifactEvidenceGraceDays: 3, artifactDeliverableGraceDays: 7 }),
    freeDiskMb: probe, now: () => now, env: {}, log: message => logs.push(message),
  });
  const freeFromTrimmed = (startMb: number, perTaskMb: number) => {
    free = startMb;
    const trimmedDirs = () => {
      let count = 0;
      for (const kind of ['evidence', 'deliverables']) {
        let names: string[] = [];
        try { names = readdirSync(join(home, kind)); } catch { continue; }
        count += names.filter(n => existsSync(join(home, kind, n, TOMBSTONE))).length;
      }
      return count;
    };
    (reclaimer as unknown as { deps: { freeDiskMb: () => number } }).deps.freeDiskMb =
      () => startMb + trimmedDirs() * perTaskMb;
  };
  return {
    home, reclaimer, logs,
    setFree: mb => { free = mb; },
    freeFromTrimmed,
    setTasks: next => { rows = next; },
  };
}

const settled = (over: Partial<ArtifactTaskInfo> = {}): ArtifactTaskInfo =>
  ({ state: 'done', terminalAt: ago(10), protection: 'none', ...over });

describe('normal sweeps', () => {
  test('trims terminal work past its grace and leaves everything else with a reason', async () => {
    const w = harness({
      old: settled(),                                   // done, 10d → trim
      recent: settled({ terminalAt: ago(1) }),          // inside the 3d evidence grace
      open: { state: 'doing', protection: 'none' },     // still running
      needed: settled({ protection: 'direct' }),        // a live task depends on it
      gone: { state: 'done', terminalAt: ago(30), protection: 'none' }, // no directory at all
    });
    seed(w.home, 'evidence', 'old', 5 * MB);
    seed(w.home, 'evidence', 'recent', 5 * MB);
    seed(w.home, 'evidence', 'open', 5 * MB);
    seed(w.home, 'evidence', 'needed', 5 * MB);

    const result = await w.reclaimer.reclaim({ trigger: 'sweep' });
    expect(result.mode).toBe('normal');
    expect(result.dryRun).toBe(false);
    expect(result.trimmed.map(t => t.taskId)).toEqual(['old']);
    expect(result.trimmed[0]).toMatchObject({ kind: 'evidence', reason: 'past-grace', removedFiles: 1, state: 'done' });
    expect(result.removedFiles).toBe(1);
    expect(result.skipped['needed-by-open-task']).toBe(1);
    expect(result.skipped['task-not-terminal']).toBe(1);
    expect(result.skipped['within-grace']).toBe(1);
    for (const keep of ['recent', 'open', 'needed']) {
      expect(readdirSync(join(w.home, 'evidence', keep)).sort()).toEqual(['note.md', 'payload.bin']);
    }
  });

  test('evidence and deliverables are trimmed together: a clone frees nothing until both are gone', async () => {
    const w = harness({ old: settled() });
    seed(w.home, 'evidence', 'old', 5 * MB);
    seed(w.home, 'deliverables', 'old', 5 * MB);
    const result = await w.reclaimer.reclaim({ trigger: 'sweep' });
    expect(result.trimmed.map(t => t.kind).sort()).toEqual(['deliverables', 'evidence']);
    expect(result.freedBytes).toBe(10 * MB);
  });

  test('deliverables keep their grace even when the evidence window has passed', async () => {
    // 4 days old: past the 3-day evidence window, inside the 7-day deliverables one.
    const w = harness({ task: settled({ terminalAt: ago(4) }) });
    seed(w.home, 'evidence', 'task', 4 * MB);
    seed(w.home, 'deliverables', 'task', 4 * MB);
    const result = await w.reclaimer.reclaim({ trigger: 'sweep' });
    expect(result.trimmed.map(t => t.kind)).toEqual(['evidence']);
    expect(readdirSync(join(w.home, 'deliverables', 'task'))).toContain('payload.bin');
    expect(result.skipped['within-grace']).toBe(1);
  });

  test('dry-run reports what would go without touching a single file', async () => {
    const w = harness({ old: settled() });
    seed(w.home, 'evidence', 'old', 3 * MB);
    const result = await w.reclaimer.reclaim({ trigger: 'dry_run' });
    expect(result.dryRun).toBe(true);
    expect(result.trimmed[0]).toMatchObject({ taskId: 'old', removedBytes: 3 * MB });
    expect(result.removedFiles).toBe(1);
    expect(readdirSync(join(w.home, 'evidence', 'old')).sort()).toEqual(['note.md', 'payload.bin']);
    // Nothing was written to the ledger either.
    expect(readdirSync(join(w.home, 'logs'))).toEqual([]);
  });

  test('an already-trimmed directory is not re-walked, unless asked', async () => {
    const w = harness({ old: settled() });
    seed(w.home, 'evidence', 'old', 3 * MB);
    await w.reclaimer.reclaim({ trigger: 'sweep' });
    expect(readdirSync(join(w.home, 'evidence', 'old'))).toContain(TOMBSTONE);
    const again = await w.reclaimer.reclaim({ trigger: 'sweep' });
    expect(again.trimmed).toEqual([]);
    expect(again.skipped['already-trimmed']).toBe(1);
    writeFileSync(join(w.home, 'evidence', 'old', 'late-arrival.mp4'), Buffer.alloc(2 * MB, 1));
    const forced = await w.reclaimer.reclaim({ trigger: 'sweep', force: true });
    expect(forced.trimmed.map(t => t.taskId)).toEqual(['old']);
    expect(readdirSync(join(w.home, 'evidence', 'old'))).not.toContain('late-arrival.mp4');
  });

  test('every run appends one JSONL line per trimmed directory plus a summary', async () => {
    const w = harness({ old: settled() });
    seed(w.home, 'evidence', 'old', 3 * MB);
    await w.reclaimer.reclaim({ trigger: 'sweep' });
    const lines = readFileSync(join(w.home, 'logs', 'artifact-reclaim.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ taskId: 'old', kind: 'evidence', removedFiles: 1 });
    expect(lines[1]).toMatchObject({ summary: true, trimmed: 1, freeDiskMbBefore: 65536 });
    expect(w.logs[0]).toContain('artifact reclaim sweep');
  });

  test('the kill switch stops automatic runs but an explicit dry-run still answers', async () => {
    const w = harness({ old: settled() });
    seed(w.home, 'evidence', 'old', 3 * MB);
    const stopped = new ArtifactReclaimer({
      home: w.home, tasks: source({ old: settled() }),
      config: async () => ({ artifactReclaimEnabled: true, artifactEvidenceGraceDays: 3, artifactDeliverableGraceDays: 7 }),
      now: () => now, env: { SCK_ARTIFACT_RECLAIM: '0' },
    });
    expect((await stopped.reclaim({ trigger: 'sweep' })).disabled).toBe(true);
    expect((await stopped.reclaim({ trigger: 'pressure', targetFreeMb: 1 })).disabled).toBe(true);
    const manual = await stopped.reclaim({ trigger: 'dry_run' });
    expect(manual.disabled).toBeUndefined();
    expect(manual.trimmed.map(t => t.taskId)).toEqual(['old']);
    expect(readdirSync(join(w.home, 'evidence', 'old'))).toContain('payload.bin');
  });
});

describe('pressure reclaim', () => {
  test('ignores the grace for work already settled, oldest first, and stops at the target', async () => {
    const w = harness({
      freshest: settled({ terminalAt: ago(0.8) }),   // 19h: under the 12h pressure window
      middling: settled({ terminalAt: ago(2) }),
      oldest: settled({ terminalAt: ago(20) }),
      needed: settled({ terminalAt: ago(30), protection: 'direct' }),
    }, 2048);
    for (const id of ['freshest', 'middling', 'oldest', 'needed']) seed(w.home, 'evidence', id, 4 * MB);
    w.freeFromTrimmed(2048, 4096); // 4 MB of payload stands in for 4096 MB of real free space

    const result = await w.reclaimer.reclaim({ trigger: 'pressure', targetFreeMb: 10_000 });
    expect(result.mode).toBe('pressure');
    // It stops the moment the probe says there is room: 2048 → 6144 → 10_240 ≥ 10_000 after two tasks.
    expect(result.targetMet).toBe(true);
    expect(result.freeDiskMbAfter).toBe(10_240);
    expect(result.trimmed.map(t => t.taskId)).toEqual(['oldest', 'middling']);
    // `oldest` (20d) was already past grace; only the 2-day-old one needed the pressure path.
    expect(result.trimmed.map(t => t.reason)).toEqual(['past-grace', 'disk-pressure']);
    // Untouched because the target was met first: a live task's evidence is never a candidate.
    expect(readdirSync(join(w.home, 'evidence', 'freshest'))).toContain('payload.bin');
    expect(readdirSync(join(w.home, 'evidence', 'needed'))).toContain('payload.bin');
  });

  test('a task inside the normal grace becomes eligible once the disk is heading down', async () => {
    const w = harness({ fresh: settled({ terminalAt: ago(0.6) }) }, 2048);   // 14.4h old, disk low
    seed(w.home, 'evidence', 'fresh', 4 * MB);
    expect((await w.reclaimer.reclaim({ trigger: 'sweep' })).trimmed).toEqual([]);
    const pressured = await w.reclaimer.reclaim({ trigger: 'pressure', targetFreeMb: 4096 });
    expect(pressured.trimmed.map(t => t.reason)).toEqual(['disk-pressure']);
    // Younger than the 12h pressure window even under pressure: a just-finished task is still whole.
    seed(w.home, 'evidence', 'minutes', 4 * MB);
    w.setTasks({ minutes: settled({ terminalAt: ago(0.2) }) });
    const second = await w.reclaimer.reclaim({ trigger: 'pressure', targetFreeMb: 4096 });
    expect(second.trimmed.map(t => t.taskId)).toEqual([]);
  });
});

describe('operational shape', () => {
  test('a concurrent run is refused rather than interleaved', async () => {
    const w = harness({ old: settled() });
    seed(w.home, 'evidence', 'old', 3 * MB);
    const [a, b] = await Promise.all([w.reclaimer.reclaim({ trigger: 'sweep' }), w.reclaimer.reclaim({ trigger: 'sweep' })]);
    expect([a, b].filter(r => r.busy)).toHaveLength(1);
    expect([a, b].filter(r => r.trimmed.length)).toHaveLength(1);
  });

  test('a time-boxed run reports truncation and leaves the rest to the next run', async () => {
    const tasks: Record<string, ArtifactTaskInfo> = {};
    for (let i = 0; i < 12; i++) tasks[`t${i}`] = settled({ terminalAt: ago(10 + i) });
    const w = harness(tasks);
    for (const id of Object.keys(tasks)) seed(w.home, 'evidence', id, 2 * MB);
    const first = await w.reclaimer.reclaim({ trigger: 'sweep', maxMs: 1 });
    expect(first.truncated).toBe(true);
    const rest = await w.reclaimer.reclaim({ trigger: 'sweep' });
    expect(rest.trimmed.length + first.trimmed.length).toBe(12);
  });

  test('a single task can be targeted without touching the rest', async () => {
    const w = harness({ a: settled(), b: settled() });
    seed(w.home, 'evidence', 'a', 3 * MB);
    seed(w.home, 'evidence', 'b', 3 * MB);
    const result = await w.reclaimer.reclaim({ trigger: 'sweep', taskId: 'a' });
    expect(result.trimmed.map(t => t.taskId)).toEqual(['a']);
    expect(readdirSync(join(w.home, 'evidence', 'b'))).toContain('payload.bin');
  });

  test('the one-line summary states what moved and why nothing did', async () => {
    const w = harness({ old: settled(), recent: settled({ terminalAt: ago(1) }) });
    seed(w.home, 'evidence', 'old', 2 * MB);
    seed(w.home, 'evidence', 'recent', 2 * MB);
    const trimmed = summarizeReclaim(await w.reclaimer.reclaim({ trigger: 'sweep' }));
    expect(trimmed).toContain('回收 1 个终态任务的大文件');
    expect(trimmed).toContain('64.0→64.0 GB');
    const idle = summarizeReclaim(await w.reclaimer.reclaim({ trigger: 'sweep' }));
    expect(idle).toContain('没有可回收的终态任务产物');
    expect(idle).toContain('仍在宽限期内 1');
  });
});
describe('emergency reclaim and the two switches', () => {
  /** Build a reclaimer against a fixed home so each switch combination gets a fresh tree. */
  const make = (home: string, env: Record<string, string>, enabled: boolean) => new ArtifactReclaimer({
    home, tasks: source({ old: settled() }),
    config: async () => ({ artifactReclaimEnabled: enabled, artifactEvidenceGraceDays: 3, artifactDeliverableGraceDays: 7 }),
    now: () => now, env,
  });

  test('gate-triggered emergency reclaim ignores the config switch', async () => {
    const w = harness({ old: settled() });
    seed(w.home, 'evidence', 'old', 3 * MB);
    w.setFree(128);
    const r = await make(w.home, {}, false).reclaim({ trigger: 'pressure', targetFreeMb: 20_480, emergency: true });
    expect(r.disabled).toBeUndefined();
    expect(r.trimmed.map(t => t.taskId)).toEqual(['old']);
    expect(existsSync(join(w.home, 'evidence', 'old', 'payload.bin'))).toBe(false);
  });

  test('routine sweeps stay off when the config switch is off', async () => {
    const w = harness({ old: settled() });
    seed(w.home, 'evidence', 'old', 3 * MB);
    const r = await make(w.home, {}, false).reclaim({ trigger: 'sweep' });
    expect(r.disabled).toBe(true);
    expect(r.disabledReason).toBe('config');
    expect(r.trimmed).toHaveLength(0);
    expect(summarizeReclaim(r)).toContain('artifact_reclaim_enabled=false');
    expect(existsSync(join(w.home, 'evidence', 'old', 'payload.bin'))).toBe(true);
  });

  test('the env hard stop beats emergency reclaim and says so', async () => {
    const w = harness({ old: settled() });
    seed(w.home, 'evidence', 'old', 3 * MB);
    w.setFree(128);
    const r = await make(w.home, { SCK_ARTIFACT_RECLAIM: '0' }, true)
      .reclaim({ trigger: 'pressure', targetFreeMb: 20_480, emergency: true });
    expect(r.disabled).toBe(true);
    expect(r.disabledReason).toBe('env');
    expect(r.trimmed).toHaveLength(0);
    expect(summarizeReclaim(r)).toContain('SCK_ARTIFACT_RECLAIM=0');
    expect(existsSync(join(w.home, 'evidence', 'old', 'payload.bin'))).toBe(true);
  });
});
