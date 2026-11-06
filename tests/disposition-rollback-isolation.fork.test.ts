// RB01 rollback isolation drill for SYS03's new states on the company fork (never production).
//
// The previous release here is the tree currently deployed as `active` (read from the service home's `active` symlink,
// which is also the commit this lane branched from), extracted from git and run by tests/fixtures/rb01-old-runner.ts as
// the old runtime. Two identical fixtures are seeded in separate namespaces; only namespace B receives the new writes.
//
// New states, and what the previous release does with them (the design this drill verifies):
//   disposition_claim   (episode claim/lease)          → ignored: a table it never reads. The task it names is still
//                                                        blocked, so the old release dispatches exactly as before.
//   disposition_action  (business idempotency rows)    → ignored: its own idempotency lives in `idem`, untouched.
//   holder_notice       (notification outbox)          → ignored: notice delivery stays the new release's job; the old
//                                                        release keeps its own owner_notice channel.
//   external_action     (controlled external records)  → ignored: it never issues controlled external actions itself.
//   disposition_decided (task/audit/outbox + the old-visible episode signals) → denied entry: the decision takes the
//                                                        task out of the manager gate (defer/repair leave it waiting on
//                                                        a dependency) and closes the `gm-manager-action` rows the old
//                                                        release reads, so no session is raised for a disposed episode.
//   the new manager tools                              → refused: the old tool registry answers `unknown_tool`.
//   company_meta:installation.schema_version 035       → untouched: the old release only bumps the marker upward.
// Gated by RUN_SCK_ROLLBACK_FORK_TESTS=1 (scripts/test-worktrees.ts sets it).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordId } from 'surrealdb';
import { loadDatabaseConfig } from '../src/config.ts';
import { CompanyDatabase } from '../src/database.ts';
import { SurrealCompanyCore, id } from '../src/core.ts';
import { LocalEnrollmentAdmin } from '../src/enrollment.ts';
import { Workforce } from '../src/workforce.ts';

const ROOT = join(import.meta.dir, '..');
/**
 * The old-version oracle: the release a rollback would actually land on. QA V8 指出首版把它写成了 lane 起点的
 * `3a31f5d4`，而那并不是本次部署前的活动发布（`e0ce6a95`）——演练必须对着**真实回滚目标**跑，否则它证明的是
 * 「回滚到更旧的版本也不会误派工」，而不是「回滚到会接手的那一版不会误派工」。
 * 回滚目标随发布推进而变化，所以这里给出当前目标的默认值，并允许部署腿用 `SCK_RB01_OLD_RELEASE` 指向落库那一刻
 * `active` 指向的提交重跑（仓库只读、由 git archive 抽出，不 checkout）。
 */
const OLD_RELEASE = process.env.SCK_RB01_OLD_RELEASE ?? 'e0ce6a95fc5c488eea6000aa89dcd34b0c87383c';
const TICKS = 3;
/** Tasks the previous dispatcher must never claim, wake or change at all. */
const PROTECTED = ['rb01-waiting', 'rb01-gated-owner', 'rb01-held', 'rb01-done', 'rb01-void', 'rb01-lease-held'];
/** The manager gates: the same task legitimately raises one gm-attention in the control namespace under the old design,
 * and must raise none where SYS03 decided the episode. */
const GATES = ['rb01-gm-episode', 'rb01-repair-source'];
/** The tables SYS03 adds; the rollback must neither read nor change their contents. */
const NEW_TABLES = ['disposition_claim', 'disposition_action', 'holder_notice', 'external_action'];
const run = process.env.RUN_SCK_ROLLBACK_FORK_TESTS === '1' ? describe : describe.skip;

type TaskOutcome = { state: string; blockedTo: string | null; occupied: boolean; occupiedBy: string | null; version: number;
  dispatch: Record<string, boolean> };
type Relay = { exit: number; stdout?: string; stderr: string };
type Outcome = {
  ok: boolean; error?: string; bootstrap?: boolean; taskTotal?: number;
  ticks?: Array<Record<string, unknown>>; spawns?: string[]; tasks?: Record<string, TaskOutcome>;
  relays?: Record<string, Relay>; logs?: string[];
};
type GateRow = { task: string; status: string; resolution?: string };
type ChainShape = { state?: string; blockedTo?: string | null; version?: number; waitsOn?: string[] };

/** `task:⟨uuid⟩` and `task:uuid` both normalise to the bare id, so ids compare across query shapes. */
const norm = (value: unknown) => String(value).replace(/^task:/, '').replace(/[⟨⟩]/g, '');

/** Extracts the previous release from git (a read of repository objects, nothing is checked out) and vendors its plugin. */
async function extractPreviousRelease(into: string): Promise<void> {
  const archive = Bun.spawn(['git', 'archive', OLD_RELEASE, '--', 'src', 'schema', 'plugin', 'package.json', 'tsconfig.json'],
    { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
  const untar = Bun.spawn(['tar', '-x', '-C', into], { stdin: archive.stdout, stdout: 'ignore', stderr: 'pipe' });
  const [archiveExit, untarExit] = await Promise.all([archive.exited, untar.exited]);
  if (archiveExit !== 0 || untarExit !== 0) throw new Error(`extracting ${OLD_RELEASE} failed: git exit ${archiveExit}, tar exit ${untarExit}`);
  symlinkSync(join(ROOT, 'node_modules'), join(into, 'node_modules'));
  const vendor = Bun.spawn(['sh', join(into, 'plugin/scripts/vendor.sh')], { cwd: into, stdout: 'ignore', stderr: 'pipe' });
  if (await vendor.exited !== 0) throw new Error(`vendoring the previous plugin failed: ${await new Response(vendor.stderr).text()}`);
}

async function openFork(namespace: string): Promise<CompanyDatabase> {
  const database = new CompanyDatabase({ ...loadDatabaseConfig(), namespace, database: 'control_plane' });
  await database.connect();
  await database.bootstrap();
  return database;
}

async function countRows(database: CompanyDatabase, table: string): Promise<number> {
  const [rows] = await database.db.query<[Array<{ n: number }>]>(`SELECT count() AS n FROM ${table} GROUP ALL;`);
  return rows?.[0]?.n ?? 0;
}

async function taskShape(database: CompanyDatabase, taskId: string): Promise<ChainShape> {
  const [row] = await database.db.query<[{ state: string; blocked_to?: string; version: number; dependencies?: RecordId[] } | undefined]>(
    'SELECT state, blocked_to, version, dependencies FROM ONLY $t;', { t: id('task', taskId) });
  return row ? { state: row.state, blockedTo: row.blocked_to ?? null, version: row.version,
    waitsOn: (row.dependencies ?? []).map(norm) } : {};
}

/** The identical fixture in each namespace: ordinary dispatch states plus the manager gates SYS03 disposes of. */
async function seedFixture(database: CompanyDatabase, scratch: string): Promise<{ core: SurrealCompanyCore; gm: string; wf: Workforce }> {
  const core = new SurrealCompanyCore(database);
  const gm = await new LocalEnrollmentAdmin(database).enroll('rb01-sys03-gm', 'owner', ['execute', 'review', 'manage']);
  await database.db.upsert(id('company_meta', 'config')).content({
    eval_enabled: false, jev_decisions: false, quota_floor_pct: 0, quota_weekly_floor_pct: 0, session_max_wakes: 0, session_max_input_k: 0,
  });
  const wf = new Workforce(database, join(scratch, 'unused-credential-files'));
  await wf.upsertDef('rb01-eng', { role: 'engineering', provider: 'codex', model: 'fixture', maxInstances: 2 });
  await wf.upsertDef('rb01-qa', { role: 'qa', provider: 'codex', model: 'fixture', maxInstances: 1 });
  await wf.upsertDef('rb01-gm', { role: 'owner', provider: 'codex', model: 'fixture', maxInstances: 1 });
  const make = (title: string, context: string) =>
    core.createTask(gm, { title, context, executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: `rb01-sys03-${title}` });
  await make('rb01-ready', '就绪任务：旧版调度应认领，作为阳性对照。');
  await make('rb01-ready-long', '就绪任务（长上下文）：旧版调度应认领。');
  await make('rb01-waiting', '等待依赖：应保持阻塞且不派工。');
  await make('rb01-gated-owner', '门禁（owner）：不派工。');
  await make('rb01-held', '他人持有有效租约：不得认领。');
  await make('rb01-done', '已完成：不得触碰。');
  await make('rb01-void', '已作废：不得触碰。');
  await make('rb01-gm-episode', '门禁（gm）+ 待办：新版处置后旧版不得再拉起会话。');
  await make('rb01-repair-source', '门禁（gm）：新版建修复链后旧版不得再拉起会话。');
  await make('rb01-lease-held', '门禁（owner）+ 新版活租约：旧版对它一无所知，也不得改动。');
  const [rows] = await database.db.query<[Array<{ id: RecordId; title: string; version: number }>]>('SELECT id, title, version FROM task;');
  const ref = new Map((rows ?? []).map(row => [row.title, row.id]));
  const versionOf = new Map((rows ?? []).map(row => [row.title, row.version]));
  const at = (title: string): RecordId => {
    const found = ref.get(title);
    if (!found) throw new Error(`fixture task missing: ${title}`);
    return found;
  };
  const now = Math.floor(Date.now() / 1000);
  await database.db.query('UPDATE ONLY $t SET state = "blocked", blocked_to = NONE, dependencies = [$dep], version = version + 1;',
    { t: at('rb01-waiting'), dep: at('rb01-ready-long') });
  await database.db.query('UPDATE ONLY $t SET state = "blocked", blocked_to = "owner", version = version + 1;', { t: at('rb01-gated-owner') });
  await database.db.query(`UPDATE ONLY $t SET state = "blocked", blocked_to = "owner", dispatch_blocked_phase = "execute",
    dispatch_blocked_since = $since, version = version + 1;`, { t: at('rb01-lease-held'), since: now });
  await database.db.query(`UPDATE ONLY $t SET state = "doing", current_employee = "rb01-held-employee",
    lease_expires_at = time::unix(time::now()) + 3600, version = version + 1;`, { t: at('rb01-held') });
  await database.db.query('UPDATE ONLY $t SET state = "done", version = version + 1;', { t: at('rb01-done') });
  await database.db.query('UPDATE ONLY $t SET state = "void", version = version + 1;', { t: at('rb01-void') });
  // A manager gate with a persisted episode start, an implementer, and the durable manager todo the old release reads.
  for (const title of ['rb01-gm-episode', 'rb01-repair-source']) {
    const taskId = norm(at(title));
    await database.db.query(`UPDATE ONLY $t SET state = "blocked", blocked_to = "owner", resume_state = "doing", current_employee = NONE,
      lease_expires_at = NONE, dispatch_blocked_phase = "execute", dispatch_blocked_since = $since, version = version + 2;`,
      { t: at(title), since: now });
    await wf.openManagerAction({ taskId, phase: 'execute', episode: now * 1000, reason: 'implementer_unavailable',
      action: 'implementer_takeover', version: versionOf.get(title)! + 2, repo: scratch, implementer: 'rb01-eng-1' });
  }
  return { core, gm, wf };
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

run('RB01 rollback isolation: SYS03 disposal states against the previous release', () => {
  let oldRoot = '';
  let scratch = '';
  let forkA: CompanyDatabase | undefined;
  let forkB: CompanyDatabase | undefined;
  const versionsBeforeRollback: Record<'A' | 'B', Record<string, number>> = { A: {}, B: {} };
  const taskIdByTitle = new Map<string, string>();
  const seedCounts: Record<'A' | 'B', Record<string, number>> = { A: {}, B: {} };
  const newTableCounts: Record<'seed' | 'written' | 'after', Record<string, number>> = { seed: {}, written: {}, after: {} };
  const outcomes = {} as { A: Outcome; B: Outcome };
  const gatesBefore = new Map<string, GateRow>();
  const gatesAfter = new Map<string, GateRow>();
  const chainBefore: ChainShape = {};
  const chainAfter: ChainShape = {};
  const schemaVersion: Record<string, number | undefined> = {};
  const disposedEpisodes: Record<string, unknown> = {};

  beforeAll(async () => {
    oldRoot = mkdtempSync(join(tmpdir(), 'rb01-sys03-old-'));
    scratch = mkdtempSync(join(tmpdir(), 'rb01-sys03-new-'));
    await extractPreviousRelease(oldRoot);
    const suffix = randomUUID().slice(0, 8);
    const namespaceA = `rb01_sys03_a_${suffix}`;
    const namespaceB = `rb01_sys03_b_${suffix}`;
    forkA = await openFork(namespaceA);
    forkB = await openFork(namespaceB);
    const seededA = await seedFixture(forkA, scratch);
    const seededB = await seedFixture(forkB, scratch);
    const tables = [...NEW_TABLES, 'task', 'audit', 'outbox', 'dispatch'];
    for (const [label, database] of [['A', forkA], ['B', forkB]] as const) {
      for (const table of tables) seedCounts[label][table] = await countRows(database, table);
    }
    const [seedRows] = await forkB.db.query<[Array<{ id: RecordId; title: string; version: number }>]>('SELECT id, title, version FROM task;');
    for (const row of seedRows ?? []) taskIdByTitle.set(row.title, norm(row.id));
    const versionsOf = async (database: CompanyDatabase) => {
      const [rows] = await database.db.query<[Array<{ title: string; version: number }>]>('SELECT title, version FROM task;');
      return Object.fromEntries((rows ?? []).map(row => [row.title, row.version]));
    };
    for (const table of NEW_TABLES) newTableCounts.seed[table] = await countRows(forkB, table);
    const idOf = (title: string) => {
      const taskId = taskIdByTitle.get(title);
      if (!taskId) throw new Error(`fixture task missing: ${title}`);
      return taskId;
    };
    const episodeOf = async (title: string) => {
      const [row] = await forkB!.db.query<[{ version: number; dispatch_blocked_since: number }]>(
        'SELECT version, dispatch_blocked_since FROM ONLY $t;', { t: id('task', idOf(title)) });
      return { taskId: idOf(title), version: row!.version, sinceMs: row!.dispatch_blocked_since * 1000 };
    };

    // ---- the new version's writes, in namespace B only.
    // 1. A decided episode: the task leaves the manager gate and waits on a dependency; the old-visible todo row closes.
    const gateEpisode = await episodeOf('rb01-gm-episode');
    const gateClaim = await seededB.core.claimDisposition(seededB.gm,
      { taskId: gateEpisode.taskId, phase: 'execute', sinceMs: gateEpisode.sinceMs, reason: 'RB01 演练：处置该门禁 episode' });
    const gateDecision = await seededB.core.decideDisposition(seededB.gm, { taskId: gateEpisode.taskId, phase: 'execute',
      sinceMs: gateEpisode.sinceMs, claimToken: gateClaim.claim.token!, episodeVersion: gateClaim.claim.episodeVersion,
      action: 'defer', expectedVersion: gateEpisode.version, dependencies: [idOf('rb01-waiting')],
      text: 'RB01 演练：该 episode 已处置，原任务改为等待依赖。', idempotencyKey: 'rb01-sys03-defer' });
    // 2. A repair decision: one chain, and the source waits on it instead of sitting in the gate.
    const repairEpisode = await episodeOf('rb01-repair-source');
    const repairClaim = await seededB.core.claimDisposition(seededB.gm,
      { taskId: repairEpisode.taskId, phase: 'execute', sinceMs: repairEpisode.sinceMs, reason: 'RB01 演练：修复链处置该 episode' });
    const repairDecision = await seededB.core.decideDisposition(seededB.gm, { taskId: repairEpisode.taskId, phase: 'execute',
      sinceMs: repairEpisode.sinceMs, claimToken: repairClaim.claim.token!, episodeVersion: repairClaim.claim.episodeVersion,
      action: 'repair', expectedVersion: repairEpisode.version, text: 'RB01 演练：建修复链，原任务改为等待修复完成。',
      repair: { title: 'rb01 修复链', context: 'RB01 isolation drill repair chain', executorRole: 'engineering', reviewerRole: 'qa',
        dependencies: [idOf('rb01-waiting')] }, idempotencyKey: 'rb01-sys03-repair' });
    const repairChainId = repairDecision.repairTaskId!;
    // 3. A live disposition lease on a task the old release never touches either way (blocked to the owner).
    const leaseEpisode = await episodeOf('rb01-lease-held');
    const leaseClaim = await seededB.core.claimDisposition(seededB.gm,
      { taskId: leaseEpisode.taskId, phase: 'execute', sinceMs: leaseEpisode.sinceMs, reason: 'RB01 演练：活租约（不决定）' });
    // 4. A controlled external action plus one out-of-band reconciliation, both only in the new tables.
    const gateway = { cancelRun: async () => ({ confirmed: false as const, error: 'RB01 drill: provider unreadable' }),
      observeRun: async () => ({ readable: true as const, exists: true, runStatus: 'completed', conclusion: 'cancelled',
        externalAccount: 'shared-bot', attribution: 'unknown_actor' as const }) };
    const actionCore = new SurrealCompanyCore(forkB, { externalActions: { gateway } });
    // The action binds the version the task has *now* (the defer above moved it), the same CAS a manager tool applies.
    const gateAfterDecision = await episodeOf('rb01-gm-episode');
    await actionCore.cancelCiRun(seededB.gm, { kind: 'ci-run-cancel', repo: 'surreal-ck/operations-fixture', runId: '8801',
      reason: 'RB01 演练：受控外部动作记录', prerequisiteTaskId: gateEpisode.taskId, prerequisiteVersion: gateAfterDecision.version,
      actionKey: 'rb01-sys03-ci-cancel' });
    await actionCore.reconcileCiRuns(seededB.gm, { runs: [{ repo: 'surreal-ck/operations-fixture', runId: '8802' }] });
    disposedEpisodes.defer = { outcome: gateDecision.outcome, action: gateDecision.decision?.action };
    disposedEpisodes.repair = { outcome: repairDecision.outcome, repairTaskId: repairChainId, claimStatus: leaseClaim.outcome };
    Object.assign(chainBefore, await taskShape(forkB, repairChainId));
    for (const table of NEW_TABLES) newTableCounts.written[table] = await countRows(forkB, table);
    for (const table of tables) seedCounts.B[table] = seedCounts.B[table]; // seed counts stay the pre-write reference for A
    const gateRows = async (database: CompanyDatabase) => {
      const [rows] = await database.db.query<[Array<GateRow>]>(
        "SELECT task, status, resolution FROM dispatch WHERE purpose = 'gm-manager-action' ORDER BY task;");
      return new Map((rows ?? []).map(row => [norm(row.task), row]));
    };
    for (const [key, row] of await gateRows(forkB)) gatesBefore.set(key, row);
    const [versionA] = await forkA.db.query<[{ schema_version?: number } | undefined]>('SELECT schema_version FROM ONLY company_meta:installation;')
    const [versionB] = await forkB.db.query<[{ schema_version?: number } | undefined]>('SELECT schema_version FROM ONLY company_meta:installation;')
    schemaVersion.before = versionB?.schema_version;

    // ---- the rollback: the same previous release runs against both namespaces.
    versionsBeforeRollback.A = await versionsOf(forkA);
    versionsBeforeRollback.B = await versionsOf(forkB);
    outcomes.A = await runPrevious(namespaceA, oldRoot);
    outcomes.B = await runPrevious(namespaceB, oldRoot);

    for (const [key, row] of await gateRows(forkB)) gatesAfter.set(key, row);
    for (const table of tables) seedCounts.B[`after_${table}`] = await countRows(forkB, table);
    for (const table of NEW_TABLES) newTableCounts.after[table] = await countRows(forkB, table);
    Object.assign(chainAfter, await taskShape(forkB, repairChainId));
    const [versionAfter] = await forkB.db.query<[{ schema_version?: number } | undefined]>('SELECT schema_version FROM ONLY company_meta:installation;')
    schemaVersion.after = versionAfter?.schema_version;
    if (process.env.SCK_RB01_EVIDENCE_DIR) {
      mkdirSync(process.env.SCK_RB01_EVIDENCE_DIR, { recursive: true });
      writeFileSync(join(process.env.SCK_RB01_EVIDENCE_DIR, 'rb01-sys03-rollback-results.json'), JSON.stringify({
        previousRelease: OLD_RELEASE, ticks: TICKS, versionsBeforeRollback,
        rowCounts: { seed: seedCounts, newTables: newTableCounts },
        disposedEpisodes, managerGateRows: { before: Object.fromEntries(gatesBefore), after: Object.fromEntries(gatesAfter) },
        repairChain: { before: chainBefore, after: chainAfter }, schemaVersion, outcomes,
      }, null, 2));
    }
  }, 900_000);

  afterAll(async () => {
    await forkA?.close();
    await forkB?.close();
    if (oldRoot) {
      try { unlinkSync(join(oldRoot, 'node_modules')); } catch { /* never linked */ }
      rmSync(oldRoot, { recursive: true, force: true });
    }
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }, 120_000);

  test('the oracle is the previous release tree, not this worktree', () => {
    expect(existsSync(join(oldRoot, 'src/disposition.ts'))).toBe(false);
    expect(readFileSync(join(oldRoot, 'src/mcp/server.ts'), 'utf8')).not.toContain('claim_disposition');
    expect(readFileSync(join(oldRoot, 'plugin/server/sidecar.ts'), 'utf8')).not.toContain('decide_disposition');
  });

  test('the new states exist where the new version wrote them, and the control namespace has none of them', () => {
    // The two namespaces were seeded identically, and no new table existed before the new version ran.
    for (const table of NEW_TABLES) expect(seedCounts.A[table]).toBe(0);
    for (const table of NEW_TABLES) {
      expect(newTableCounts.seed[table]).toBe(0);
      expect(newTableCounts.written[table]).toBeGreaterThan(0);
    }
    expect(seedCounts.B.dispatch).toBeGreaterThanOrEqual(seedCounts.A.dispatch);
    // The new decision built exactly one repair chain, waiting on its dependency.
    expect(chainBefore.state).toBe('blocked');
    expect(chainBefore.blockedTo ?? null).toBeNull();
    expect(chainBefore.waitsOn).toHaveLength(1);
  });

  test('the previous runtime boots on new-version data and answers its own tool surface', () => {
    for (const label of ['A', 'B'] as const) {
      expect(outcomes[label].ok).toBe(true);
      expect(outcomes[label].ticks).toHaveLength(TICKS);
      expect(outcomes[label].taskTotal).toBeGreaterThan(0);
      // Liveness of the old runtime's own tool surface: an ordinary read that predates SYS03 and must still work.
      expect(outcomes[label].relays!.getTaskHistory.exit).toBe(0);
      // QA V8: `get_context` is probed with a **deliberately bogus** cursor, and the old release refuses it by name —
      // cursors are versioned and signed, so a made-up one fails verification. That is the release's own designed
      // behaviour (it exists identically before and after SYS03), not a cursor the new version issued and the old one
      // rejected: nothing in this drill hands a new-version cursor to the old runtime. Recorded here so the evidence
      // explains itself instead of leaving a bare failure.
      const ctx = outcomes[label].relays!.getContext;
      expect(ctx.exit).not.toBe(0);
      expect(`${ctx.stdout ?? ''}${ctx.stderr ?? ''}`).toContain('cursor');
    }
    expect(outcomes.B.bootstrap).toBe(true);
  });

  test('positive control: the previous dispatcher still claims the eligible ready work in both namespaces', () => {
    for (const label of ['A', 'B'] as const) {
      const tasks = outcomes[label].tasks!;
      for (const title of ['rb01-ready', 'rb01-ready-long'] as const) {
        expect(tasks[title]).toMatchObject({ state: 'doing', occupied: true });
        expect(tasks[title].dispatch.execute).toBe(true);
      }
    }
  });

  test('zero misdispatch: waiting, gated, held, terminal and disposed tasks are never claimed or changed', () => {
    for (const label of ['A', 'B'] as const) {
      const tasks = outcomes[label].tasks!;
      for (const title of PROTECTED) {
        const before = versionsBeforeRollback[label][title];
        if (before === undefined) throw new Error(`no pre-rollback version for ${title}`);
        // The rollback changed no version of a task it must leave alone, and dispatched nothing into them.
        expect(tasks[title].version).toBe(before);
        expect(Object.values(tasks[title].dispatch).some(Boolean)).toBe(false);
      }
    }
    const b = outcomes.B.tasks!;
    expect(b['rb01-waiting']).toMatchObject({ state: 'blocked', blockedTo: null });
    expect(b['rb01-gated-owner']).toMatchObject({ state: 'blocked', blockedTo: 'owner' });
    expect(b['rb01-held']).toMatchObject({ state: 'doing', occupied: true, occupiedBy: 'rb01-held-employee' });
    expect(b['rb01-done']).toMatchObject({ state: 'done' });
    expect(b['rb01-void']).toMatchObject({ state: 'void' });
    // The disposed episodes stay exactly where the new decision left them: waiting, out of the manager gate.
    expect(b['rb01-gm-episode']).toMatchObject({ state: 'blocked', blockedTo: null });
    expect(b['rb01-repair-source']).toMatchObject({ state: 'blocked', blockedTo: null });
    expect(b['rb01-lease-held']).toMatchObject({ state: 'blocked', blockedTo: 'owner' });
  });

  test('denied entry: a disposed manager episode raises no session, while the same gate does in the control namespace', () => {
    // A disposes nothing, so the previous release treats its gates as it always did: one gm-attention dispatch per gate.
    expect(outcomes.A.tasks!['rb01-gm-episode'].dispatch['gm-attention']).toBe(true);
    expect(outcomes.A.tasks!['rb01-repair-source'].dispatch['gm-attention']).toBe(true);
    // B's gates were disposed: the decision left the tasks out of the gate and closed the durable todo rows.
    expect(outcomes.B.tasks!['rb01-gm-episode'].dispatch['gm-attention']).toBe(false);
    expect(outcomes.B.tasks!['rb01-repair-source'].dispatch['gm-attention']).toBe(false);
    for (const title of GATES) {
      expect(outcomes.A.tasks![title].version).toBe(versionsBeforeRollback.A[title]);
      expect(outcomes.B.tasks![title].version).toBe(versionsBeforeRollback.B[title]);
      expect(outcomes.B.tasks![title].occupied).toBe(false);
    }
    const episodeId = taskIdByTitle.get('rb01-gm-episode')!;
    expect(gatesBefore.get(episodeId)?.status).toBe('closed');
    expect(String(gatesBefore.get(episodeId)?.resolution)).toContain('disposition');
    expect(gatesAfter.get(episodeId)?.status).toBe('closed');
    // The repair chain the new version built is still waiting on its dependency, untouched by the old release.
    expect(chainAfter).toMatchObject({ state: 'blocked', blockedTo: null });
    expect(chainAfter.version).toBe(chainBefore.version);
  });

  test('the new tables are neither read nor written by the rollback, and the schema marker is not downgraded', () => {
    for (const table of NEW_TABLES) expect(newTableCounts.after[table]).toBe(newTableCounts.written[table]);
    // 合线后最高模块是本线的 035（主干已收的 034 是 SYS03 处置账本）：只断言下界，
    // “不降级”的语义仍由下一行 before === after 守住。
    expect(schemaVersion.before).toBeGreaterThanOrEqual(34);
    expect(schemaVersion.after).toBeGreaterThanOrEqual(34);
    expect(schemaVersion.before).toBe(schemaVersion.after);
  });

  test('refused entry: the previous release answers unknown_tool for the new manager tools', () => {
    for (const label of ['A', 'B'] as const) {
      const relays = outcomes[label].relays!;
      expect(relays.dispositionStatus.exit).toBe(1);
      expect(relays.dispositionStatus.stderr).toContain('unknown_tool');
      expect(relays.holderNotices.exit).toBe(1);
      expect(relays.holderNotices.stderr).toContain('unknown_tool');
    }
  });
});