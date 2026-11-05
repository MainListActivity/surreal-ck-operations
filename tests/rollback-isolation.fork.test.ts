// RB01 rollback isolation drill on the company fork (never production). The previous release 8d03d35 is extracted from git
// and run as the old runtime by tests/fixtures/rb01-old-runner.ts; new-version writes come from this worktree. Two identical
// fixtures are seeded in separate namespaces. Only namespace B receives the new version's write (a paged read that creates
// company_meta:cursor_key). The previous runtime then runs against both, and its decisions must match.
// Gated by RUN_SCK_ROLLBACK_FORK_TESTS=1 (scripts/test-worktrees.ts sets it).
// The independence isolation evidence (a policy written by the new code, then the old release on the same data) is
// tests/rollback-isolation-independence.fork.test.ts, which pins 20b384e — the release deployed as `active` today.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordId } from 'surrealdb';
import { loadDatabaseConfig } from '../src/config.ts';
import { CompanyDatabase } from '../src/database.ts';
import { SurrealCompanyCore, asId, id } from '../src/core.ts';
import { LocalEnrollmentAdmin } from '../src/enrollment.ts';
import { SnapshotStore } from '../src/snapshot-store.ts';
import { Workforce } from '../src/workforce.ts';

const ROOT = join(import.meta.dir, '..');
/** The release deployed as `active` today. Its git tree is the old-version oracle. */
const OLD_RELEASE = '8d03d351d23ae20da4fd5ba0d7e10891cd712fe3';
const TICKS = 3;
const LONG = '中文🙂'.repeat(2000);
/** Tasks the previous dispatcher must never claim, spawn for, or change. gm-gated work is handled separately below. */
const PROTECTED = ['rb01-waiting', 'rb01-gated-owner', 'rb01-held', 'rb01-done', 'rb01-void'];
const run = process.env.RUN_SCK_ROLLBACK_FORK_TESTS === '1' ? describe : describe.skip;

type TaskOutcome = { state: string; blockedTo: string | null; occupied: boolean; occupiedBy: string | null; version: number; dispatch: Record<string, boolean> };
type Relay = { exit: number; keys?: string[] | null; taskCount?: number | null; historyCount?: number | null; isArray?: boolean; stdout?: string; stderr: string };
type Outcome = {
  ok: boolean; error?: string; bootstrap?: boolean; taskTotal?: number;
  ticks?: Array<Record<string, unknown>>; spawns?: string[]; tasks?: Record<string, TaskOutcome>;
  relays?: { getContext: Relay; getTaskHistory: Relay; listWorktrees: Relay; getAdminSummary: Relay; readTaskText: Relay;
    dispositionStatus: Relay; holderNotices: Relay };
  logs?: string[];
};

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const pick = (record: Record<string, number>, keys: string[]) => Object.fromEntries(keys.map(key => [key, record[key]]));
const cursorKeyRow = (database: CompanyDatabase) => database.db.select<{ key: string }>(id('company_meta', 'cursor_key'));

async function countRows(database: CompanyDatabase, table: string): Promise<number> {
  const [rows] = await database.db.query<[Array<{ n: number }>]>(`SELECT count() AS n FROM ${table} GROUP ALL;`);
  return rows?.[0]?.n ?? 0;
}

/**
 * Extracts the previous release from git (a read of the repository objects, nothing is checked out) and runs the plugin
 * vendoring step the way plugin/scripts/vendor.sh does. The worktree's node_modules is linked in; dependencies are
 * unchanged since the release, so both trees resolve the same packages.
 */
async function extractPreviousRelease(into: string): Promise<void> {
  const archive = Bun.spawn(['git', 'archive', OLD_RELEASE, '--', 'src', 'schema', 'plugin', 'package.json', 'tsconfig.json'], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
  const untar = Bun.spawn(['tar', '-x', '-C', into], { stdin: archive.stdout, stdout: 'ignore', stderr: 'pipe' });
  const [archiveExit, untarExit] = await Promise.all([archive.exited, untar.exited]);
  if (archiveExit !== 0 || untarExit !== 0) throw new Error(`extracting ${OLD_RELEASE} failed: git exit ${archiveExit}, tar exit ${untarExit}`);
  symlinkSync(join(ROOT, 'node_modules'), join(into, 'node_modules'));
  const vendor = Bun.spawn(['sh', join(into, 'plugin/scripts/vendor.sh')], { cwd: into, stdout: 'ignore', stderr: 'pipe' });
  const vendorExit = await vendor.exited;
  if (vendorExit !== 0) throw new Error(`vendoring the previous plugin failed: ${await new Response(vendor.stderr).text()}`);
}

async function openFork(namespace: string): Promise<CompanyDatabase> {
  const database = new CompanyDatabase({ ...loadDatabaseConfig(), namespace, database: 'control_plane' });
  await database.connect();
  await database.bootstrap();
  return database;
}

/**
 * The same fixture in each namespace. Tasks are created through the core; the waiting, gated, held, done and void states
 * are written the way the state machine leaves them (blocked with no route, blocked to owner or gm, a live lease, terminal).
 */
async function seedFixture(database: CompanyDatabase, scratch: string): Promise<{ core: SurrealCompanyCore; gm: string }> {
  const core = new SurrealCompanyCore(database);
  const gm = await new LocalEnrollmentAdmin(database).enroll('rb01-gm', 'owner', ['execute', 'review', 'manage']);
  await database.db.upsert(id('company_meta', 'config')).content({
    eval_enabled: false, jev_decisions: false, quota_floor_pct: 0, quota_weekly_floor_pct: 0, session_max_wakes: 0, session_max_input_k: 0,
  });
  const wf = new Workforce(database, join(scratch, 'unused-credential-files'));
  await wf.upsertDef('rb01-eng', { role: 'engineering', provider: 'codex', model: 'fixture', maxInstances: 2 });
  await wf.upsertDef('rb01-gm', { role: 'owner', provider: 'codex', model: 'fixture', maxInstances: 1 });
  const make = (title: string, context: string) =>
    core.createTask(gm, { title, context, executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: `rb01-${title}` });
  await make('rb01-ready', '就绪任务：旧版调度应认领，作为阳性对照。');
  await make('rb01-ready-long', LONG);
  await make('rb01-waiting', '等待依赖：应保持阻塞且不派工。');
  await make('rb01-gated-owner', '门禁（owner）：不派工。');
  await make('rb01-gated-gm', '门禁（gm）：只允许 gm-attention 通知，不认领。');
  await make('rb01-held', '他人持有有效租约：不得认领。');
  await make('rb01-done', '已完成：不得触碰。');
  await make('rb01-void', '已作废：不得触碰。');
  const [rows] = await database.db.query<[Array<{ id: RecordId; title: string }>]>('SELECT id, title FROM task;');
  const ref = new Map((rows ?? []).map(row => [row.title, row.id]));
  const at = (title: string): RecordId => {
    const found = ref.get(title);
    if (!found) throw new Error(`fixture task missing: ${title}`);
    return found;
  };
  await database.db.query('UPDATE ONLY $t SET state = "blocked", blocked_to = NONE, dependencies = [$dep], version = version + 1;',
    { t: at('rb01-waiting'), dep: at('rb01-ready-long') });
  await database.db.query('UPDATE ONLY $t SET state = "blocked", blocked_to = "owner", version = version + 1;', { t: at('rb01-gated-owner') });
  await database.db.query('UPDATE ONLY $t SET state = "blocked", blocked_to = "owner", version = version + 1;', { t: at('rb01-gated-gm') });
  await database.db.query('UPDATE ONLY $t SET state = "doing", current_employee = "rb01-held-employee", lease_expires_at = time::unix(time::now()) + 3600, version = version + 1;',
    { t: at('rb01-held') });
  await database.db.query('UPDATE ONLY $t SET state = "done", version = version + 1;', { t: at('rb01-done') });
  await database.db.query('UPDATE ONLY $t SET state = "void", version = version + 1;', { t: at('rb01-void') });
  return { core, gm };
}

/** Runs the previous release's dispatcher and comm path in its own process against one namespace. */
async function runPrevious(namespace: string, oldRoot: string): Promise<Outcome> {
  const proc = Bun.spawn([process.execPath, join(ROOT, 'tests/fixtures/rb01-old-runner.ts')], {
    cwd: ROOT, stdout: 'pipe', stderr: 'pipe',
    env: { ...process.env, RB01_OLD_ROOT: oldRoot, RB01_NAMESPACE: namespace, RB01_DATABASE: 'control_plane', RB01_TICKS: String(TICKS) },
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  const line = stdout.split('\n').find(text => text.startsWith('RB01_RESULT '));
  if (!line) throw new Error(`previous-release runner produced no result: ${stderr.slice(-1200)}`);
  return JSON.parse(line.slice('RB01_RESULT '.length)) as Outcome;
}

run('RB01 rollback isolation: previous release against new-version data', () => {
  let oldRoot = '';
  let scratch = '';
  let forkA: CompanyDatabase | undefined;
  let forkB: CompanyDatabase | undefined;
  const seededVersions = new Map<string, number>();
  const counts: Record<'A' | 'B', Record<string, number>> = { A: {}, B: {} };
  const afterNewReads: Record<string, number> = {};
  const afterRollback: Record<'A' | 'B', Record<string, number>> = { A: {}, B: {} };
  const outcomes = {} as { A: Outcome; B: Outcome };
  let cursorKeyA: string | undefined;
  let cursorKeyB: string | undefined;
  let cursorKeyBAfterRollback: string | undefined;
  const afterSweep: Record<string, number> = {};
  let swept = 0;
  let expectedGone: unknown;

  beforeAll(async () => {
    oldRoot = mkdtempSync(join(tmpdir(), 'rb01-old-'));
    scratch = mkdtempSync(join(tmpdir(), 'rb01-new-'));
    await extractPreviousRelease(oldRoot);
    const suffix = randomUUID().slice(0, 8);
    const namespaceA = `rb01_a_${suffix}`;
    const namespaceB = `rb01_b_${suffix}`;
    forkA = await openFork(namespaceA);
    forkB = await openFork(namespaceB);
    await seedFixture(forkA, scratch);
    const seededB = await seedFixture(forkB, scratch);
    const tables = ['task', 'audit', 'outbox', 'query_snapshot', 'query_snapshot_row'];
    for (const [label, database] of [['A', forkA], ['B', forkB]] as const) {
      for (const table of tables) counts[label][table] = await countRows(database, table);
    }
    const [seedRows] = await forkB.db.query<[Array<{ title: string; version: number }>]>('SELECT title, version FROM task;');
    for (const row of seedRows ?? []) seededVersions.set(row.title, row.version);
    cursorKeyA = (await cursorKeyRow(forkA))?.key ? 'present' : undefined;
    // The new version's writes: paged reads whose continuations are sealed create company_meta:cursor_key and stored
    // listings (context, history, worktrees). Namespace B only.
    const page = await seededB.core.contextView(seededB.gm, { pageSize: 2 });
    expect(page.page?.nextCursor).toBeString();
    await seededB.core.adminSummary(seededB.gm, {});
    await seededB.core.worktreePage(seededB.gm, { pageSize: 1 });
    const [ready] = await forkB.db.query<[Array<{ id: RecordId }>]>("SELECT id FROM task WHERE title = 'rb01-ready';");
    const history = await seededB.core.historyView(seededB.gm, asId(ready![0]!.id), { pageSize: 1 });
    expect(history.history.length).toBeGreaterThan(0);
    // Counted after the new reads: they may store listings, never task, audit or outbox rows.
    for (const table of tables) afterNewReads[table] = await countRows(forkB, table);
    // Expiry and sweep (C4): a listing taken with a 500 ms lifetime expires on its own. Its cursor is then refused as
    // snapshot_gone, and the sweep removes its header and rows. The listings above keep their normal lifetime.
    const shortLived = new SurrealCompanyCore(forkB, { snapshots: { ttlMs: 500 } });
    const brief = await shortLived.contextView(seededB.gm, { pageSize: 2 });
    await Bun.sleep(700);
    expectedGone = await shortLived.contextView(seededB.gm, { pageSize: 2, cursor: brief.page!.nextCursor! })
      .then(() => undefined, (error: unknown) => error);
    swept = await new SnapshotStore(forkB.db).sweep();
    for (const table of tables) afterSweep[table] = await countRows(forkB, table);
    const keyB = await cursorKeyRow(forkB);
    cursorKeyB = keyB?.key ? sha(keyB.key) : undefined;
    outcomes.A = await runPrevious(namespaceA, oldRoot);
    outcomes.B = await runPrevious(namespaceB, oldRoot);
    for (const table of tables) afterRollback.B[table] = await countRows(forkB, table);
    for (const table of tables) afterRollback.A[table] = await countRows(forkA, table);
    const keyAfter = await cursorKeyRow(forkB);
    cursorKeyBAfterRollback = keyAfter?.key ? sha(keyAfter.key) : undefined;
    if (process.env.SCK_RB01_EVIDENCE_DIR) {
      writeFileSync(join(process.env.SCK_RB01_EVIDENCE_DIR, 'rb01-rollback-results.json'), JSON.stringify({
        previousRelease: OLD_RELEASE, ticks: TICKS, seededVersions: Object.fromEntries(seededVersions), rowCounts: counts,
        rowCountsAfterNewReads: afterNewReads, rowCountsAfterSweep: afterSweep, sweptListings: swept, rowCountsAfterRollback: afterRollback,
        cursorKeyDigest: { aBeforeRollback: cursorKeyA, bBeforeRollback: cursorKeyB, bAfterRollback: cursorKeyBAfterRollback },
        outcomes,
      }, null, 2));
    }
  }, 900_000);

  afterAll(async () => {
    await forkA?.close();
    await forkB?.close();
    if (oldRoot) {
      // Unlink the node_modules symlink before removing the tree so nothing follows it into the worktree.
      try { unlinkSync(join(oldRoot, 'node_modules')); } catch { /* never linked */ }
      rmSync(oldRoot, { recursive: true, force: true });
    }
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }, 120_000);

  test('the oracle is the previous release tree, not this worktree', () => {
    expect(existsSync(join(oldRoot, 'src/query-input.ts'))).toBe(false);
    expect(readFileSync(join(oldRoot, 'src/mcp/server.ts'), 'utf8')).not.toContain('pageSize');
    expect(existsSync(join(oldRoot, 'plugin/server/vendor/src/comm.ts'))).toBe(true);
  });

  test('the new version writes one persisted record, company_meta:cursor_key, and only namespace B has it', () => {
    expect(cursorKeyA).toBeUndefined();
    expect(cursorKeyB).toBeDefined();
    // Both namespaces were seeded identically before any new read.
    expect(counts.B).toEqual(counts.A);
    // The new reads changed no task, audit or outbox rows. They stored listings in B only (snapshot census).
    expect(pick(afterNewReads, ['task', 'audit', 'outbox'])).toEqual(pick(counts.B, ['task', 'audit', 'outbox']));
    expect(counts.A.query_snapshot).toBe(0);
    expect(counts.A.query_snapshot_row).toBe(0);
    expect(afterNewReads.query_snapshot).toBeGreaterThan(0);
    expect(afterNewReads.query_snapshot_row).toBeGreaterThan(0);
  });

  test('a listing past its lifetime is refused as snapshot_gone, and the sweep removes its header and rows, leaving the live listings', () => {
    expect((expectedGone as { code?: string } | undefined)?.code).toBe('snapshot_gone');
    expect(swept).toBeGreaterThanOrEqual(1);
    expect(pick(afterSweep, ['query_snapshot', 'query_snapshot_row'])).toEqual(pick(afterNewReads, ['query_snapshot', 'query_snapshot_row']));
    expect(afterSweep.query_snapshot).toBeGreaterThan(0);
    expect(afterSweep.query_snapshot_row).toBeGreaterThan(0);
  });

  test('the previous runtime boots on new-version data and decides the same with or without the new write', () => {
    expect(outcomes.A.ok).toBe(true);
    expect(outcomes.B.ok).toBe(true);
    expect(outcomes.B.bootstrap).toBe(true);
    expect(outcomes.B.ticks).toEqual(outcomes.A.ticks);
    expect(outcomes.B.spawns).toEqual(outcomes.A.spawns);
    expect(outcomes.B.tasks).toEqual(outcomes.A.tasks);
  });

  test('positive control: the previous dispatcher claims the eligible ready tasks on new-version data', () => {
    for (const label of ['A', 'B'] as const) {
      const tasks = outcomes[label].tasks!;
      expect(tasks['rb01-ready']).toMatchObject({ state: 'doing', occupied: true });
      expect(tasks['rb01-ready'].dispatch.execute).toBe(true);
      expect(tasks['rb01-ready-long']).toMatchObject({ state: 'doing', occupied: true });
      expect(tasks['rb01-ready-long'].dispatch.execute).toBe(true);
    }
  });

  test('zero misdispatch: waiting, owner-gated, held, done and void tasks are never claimed or changed; gm gates only raise gm-attention', () => {
    for (const label of ['A', 'B'] as const) {
      const tasks = outcomes[label].tasks!;
      for (const title of PROTECTED) {
        const seeded = seededVersions.get(title);
        if (seeded === undefined) throw new Error(`no seeded version for ${title}`);
        expect(tasks[title].version).toBe(seeded);
        expect(Object.values(tasks[title].dispatch).some(Boolean)).toBe(false);
      }
    }
    const b = outcomes.B.tasks!;
    expect(b['rb01-waiting']).toMatchObject({ state: 'blocked', blockedTo: null, occupied: false });
    expect(b['rb01-gated-owner']).toMatchObject({ state: 'blocked', blockedTo: 'owner', occupied: false });
    expect(b['rb01-held']).toMatchObject({ state: 'doing', occupied: true, occupiedBy: 'rb01-held-employee' });
    expect(b['rb01-done']).toMatchObject({ state: 'done', occupied: false });
    expect(b['rb01-void']).toMatchObject({ state: 'void', occupied: false });
    // gm-gated work: the previous release's gm-attention notice is its designed behaviour; an executor claim is not.
    expect(b['rb01-gated-gm']).toMatchObject({ state: 'blocked', blockedTo: 'owner', occupied: false });
    expect(b['rb01-gated-gm'].dispatch.execute).toBe(false);
    expect(b['rb01-gated-gm'].dispatch['gm-attention']).toBe(true);
  });

  test('the previous runtime reads new-version data without the new semantics: paging ignored, new tools refused', () => {
    for (const label of ['A', 'B'] as const) {
      const r = outcomes[label].relays!;
      expect(r.getContext.exit).toBe(0);
      expect(r.getContext.keys).not.toContain('page');
      expect(r.getContext.taskCount).toBeGreaterThan(2);
      expect(r.getTaskHistory.exit).toBe(0);
      expect(r.getTaskHistory.keys).toEqual(['history']);
      expect(r.listWorktrees.exit).toBe(0);
      expect(r.listWorktrees.isArray).toBe(true);
      expect(r.getAdminSummary.exit).toBe(1);
      expect(r.getAdminSummary.stderr).toContain('unknown_tool');
      expect(r.readTaskText.exit).toBe(1);
      expect(r.readTaskText.stderr).toContain('unknown_tool');
    }
  });

  test('the cursor secret and the stored listings written by the new version are untouched by the rollback runs', () => {
    expect(cursorKeyB).toBeDefined();
    expect(cursorKeyBAfterRollback).toBe(cursorKeyB);
    expect(cursorKeyA).toBeUndefined();
    expect(pick(afterRollback.B, ['query_snapshot', 'query_snapshot_row'])).toEqual(pick(afterSweep, ['query_snapshot', 'query_snapshot_row']));
  });
});
