// RB01 rollback isolation drill for SYS04's new states on the company fork (never production).
//
// The previous release here is a real rollback target (an ancestor of origin/main, and the release `active`
// pointed at when this drill was last verified), extracted from git and run by tests/fixtures/rb01-old-runner.ts
// as the old runtime. Two identical fixtures are seeded in separate namespaces; only namespace B receives the
// new writes.
//
// New states, and what the previous release does with them (the design this drill verifies):
//   fault_incident   (one row per cause, the cross-task group)        → ignored: a table it never reads.
//   fault_episode    (one episode per cause and task, with notified)  → ignored: the old release has no
//                                                                        concept of a fault episode, so it
//                                                                        never suppresses a wake because of one.
//   fault_budget     (the persistent recovery budget of a fault object)→ ignored: the old release has no
//                                                                        budget, so it never refuses an attempt.
//   fault_repair     (the one repair chain of an incident)             → ignored: the repair task it names is
//                                                                        an ordinary task, and the source task
//                                                                        waits on it as a normal dependency.
//   the exhausted task (state=blocked, blocked_to=NONE, dependencies)  → isolated: the old release's manager
//                                                                        gate is `state == 'blocked' AND
//                                                                        blocked_to == 'gm'` (old dispatcher.ts
//                                                                        :1219), and the defer that puts the task
//                                                                        into the dependency wait clears blocked_to,
//                                                                        so the old release neither claims it,
//                                                                        raises a session for it, nor wakes the
//                                                                        manager about it.
//   the repair chain task                                             → ordinary: it is a normal engineering
//                                                                        task with a QA reviewer, so the old
//                                                                        release may legitimately dispatch it.
//   company_meta:installation.schema_version 037                       → untouched: the old release only bumps
//                                                                        the marker upward.
//
// The positive control is the point of the drill: the same fixture in the control namespace A, which received
// none of the new writes, is dispatched exactly as the old release always dispatched it. A drill that only
// asserts "nothing happened" would also pass if the old runtime were simply broken.
//
// Gated by RUN_SCK_ROLLBACK_FORK_TESTS=1 (scripts/test-worktrees.ts sets it).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordId } from 'surrealdb';
import { loadDatabaseConfig } from '../src/config.ts';
import { CompanyDatabase } from '../src/database.ts';
import { SurrealCompanyCore, id } from '../src/core.ts';
import { LocalEnrollmentAdmin } from '../src/enrollment.ts';
import { FaultStore } from '../src/fault-store.ts';
import { budgetKey, classifyFault, faultFingerprint, type FaultBudgetLimits, type FaultPhase, type FaultTargetKind } from '../src/faults.ts';
import { Workforce } from '../src/workforce.ts';

const ROOT = join(import.meta.dir, '..');
/**
 * The old-version oracle: the release a rollback would actually land on. It must be a **real** rollback
 * target, not merely an older commit, otherwise the drill proves "rolling back to something even older also
 * misdispatches nothing" instead of "rolling back to the version that would take over misdispatches nothing".
 * The target moves as releases ship: the default names the release `active` pointed at when the drill was last
 * verified, and the deploy leg points `SCK_RB01_OLD_RELEASE` at whatever `active` points at when the release
 * lands (read-only: extracted with `git archive`, never checked out).
 */
const OLD_RELEASE = process.env.SCK_RB01_OLD_RELEASE ?? '11e7db2fae3f92205410a02634c61c43e99f413a';
const TICKS = 3;
/** Tasks the previous dispatcher must never claim, wake or change at all. */
const PROTECTED = ['rb01-waiting', 'rb01-gated-owner', 'rb01-held', 'rb01-done', 'rb01-void', 'rb01-lease-held'];
/** The manager gates: the same task legitimately raises one gm-attention in the control namespace under the old
 * design, and must raise none where SYS04 deferred it. */
const GATES = ['rb01-gm-episode', 'rb01-fault-exhausted'];
/** The tables SYS04 adds; the rollback must neither read nor change their contents. */
const NEW_TABLES = ['fault_incident', 'fault_episode', 'fault_budget', 'fault_repair'];
const run = process.env.RUN_SCK_ROLLBACK_FORK_TESTS === '1' ? describe : describe.skip;

const PHASE: FaultPhase = 'login';
const TARGET: FaultTargetKind = 'idp_login';
const limits: FaultBudgetLimits = { maxAttempts: 3, totalDeadlineMs: 120_000, minIntervalMs: 2_000, backoffMs: 5_000, jitter: 0 };

type TaskOutcome = { state: string; blockedTo: string | null; occupied: boolean; occupiedBy: string | null; version: number;
  dispatch: Record<string, boolean> };
type Relay = { exit: number; stdout?: string; stderr: string };
type Outcome = {
  ok: boolean; error?: string; bootstrap?: boolean; taskTotal?: number;
  ticks?: Array<Record<string, unknown>>; spawns?: string[]; tasks?: Record<string, TaskOutcome>;
  relays?: Record<string, Relay>; logs?: string[];
};
type ChainShape = { state?: string; blockedTo?: string | null; version?: number; waitsOn?: string[] };
type BudgetRow = { attempts?: number; total_attempts?: number; deadline?: number; last_attempt_at?: number; failed?: boolean };

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

/** A digest of a whole table in id order: equal digests mean not one row was added, changed or removed. */
async function tableDigest(database: CompanyDatabase, table: string): Promise<string> {
  const [rows] = await database.db.query<[unknown[]]>(`SELECT * FROM ${table} ORDER BY id;`);
  return createHash('sha256').update(JSON.stringify(rows ?? [])).digest('hex');
}

async function taskShape(database: CompanyDatabase, taskId: string): Promise<ChainShape> {
  const [row] = await database.db.query<[{ state: string; blocked_to?: string; version: number; dependencies?: RecordId[] } | undefined]>(
    'SELECT state, blocked_to, version, dependencies FROM ONLY $t;', { t: id('task', taskId) });
  return row ? { state: row.state, blockedTo: row.blocked_to ?? null, version: row.version,
    waitsOn: (row.dependencies ?? []).map(norm) } : {};
}

/** The identical fixture in each namespace: ordinary dispatch states plus the manager gates SYS04 defers. */
async function seedFixture(database: CompanyDatabase, scratch: string): Promise<{ core: SurrealCompanyCore; gm: string; wf: Workforce }> {
  const core = new SurrealCompanyCore(database, { faults: { limits, clock: () => 1_700_000_000_000 } });
  const gm = await new LocalEnrollmentAdmin(database).enroll('rb01-sys04-gm', 'gm', ['execute', 'review', 'manage']);
  await database.db.upsert(id('company_meta', 'config')).content({
    eval_enabled: false, jev_decisions: false, quota_floor_pct: 0, quota_weekly_floor_pct: 0, session_max_wakes: 0, session_max_input_k: 0,
  });
  const wf = new Workforce(database, join(scratch, 'unused-credential-files'));
  await wf.upsertDef('rb01-eng', { role: 'engineering', provider: 'codex', model: 'fixture', maxInstances: 2 });
  await wf.upsertDef('rb01-qa', { role: 'qa', provider: 'codex', model: 'fixture', maxInstances: 1 });
  await wf.upsertDef('rb01-gm', { role: 'gm', provider: 'codex', model: 'fixture', maxInstances: 1 });
  const make = (title: string, context: string) =>
    core.createTask(gm, { title, context, executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: `rb01-sys04-${title}` });
  await make('rb01-ready', '就绪任务：旧版调度应认领，作为阳性对照。');
  await make('rb01-ready-long', '就绪任务（长上下文）：旧版调度应认领。');
  await make('rb01-waiting', '等待依赖：应保持阻塞且不派工。');
  await make('rb01-gated-owner', '门禁（owner）：不派工。');
  await make('rb01-held', '他人持有有效租约：不得认领。');
  await make('rb01-done', '已完成：不得触碰。');
  await make('rb01-void', '已作废：不得触碰。');
  await make('rb01-gm-episode', '门禁（gm）+ 待办：新版处置后旧版不得再拉起会话。');
  await make('rb01-fault-exhausted', '门禁（gm）：新版恢复预算耗尽并转入等待修复后，旧版不得再拉起会话。');
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
  for (const title of ['rb01-gm-episode', 'rb01-fault-exhausted']) {
    const taskId = norm(at(title));
    await database.db.query(`UPDATE ONLY $t SET state = "blocked", blocked_to = "gm", resume_state = "doing", current_employee = NONE,
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

run('RB01 rollback isolation: SYS04 fault states against the previous release', () => {
  let oldRoot = '';
  let scratch = '';
  let forkA: CompanyDatabase | undefined;
  let forkB: CompanyDatabase | undefined;
  const versionsBeforeRollback: Record<'A' | 'B', Record<string, number>> = { A: {}, B: {} };
  const taskIdByTitle = new Map<string, string>();
  const seedCounts: Record<'A' | 'B', Record<string, number>> = { A: {}, B: {} };
  const newTableCounts: Record<'seed' | 'written' | 'after', Record<string, number>> = { seed: {}, written: {}, after: {} };
  const outcomes = {} as { A: Outcome; B: Outcome };
  const chainBefore: ChainShape = {};
  const chainAfter: ChainShape = {};
  const schemaVersion: Record<string, number | undefined> = {};
  /** The budget of the exhausted fault object, before and after the rollback: the audit must stay recomputable. */
  const budgetBefore: BudgetRow = {};
  const budgetAfter: BudgetRow = {};
  /** The episode of the exhausted fault object, and whether the manager was ever told about it. */
  const episodeBefore: { state?: string; notified?: boolean; evidence_revision?: number } = {};
  const episodeAfter: { state?: string; notified?: boolean; evidence_revision?: number } = {};
  const refusal: { allowed?: boolean; reason?: string } = {};
  const newTableDigests: Record<'written' | 'after', Record<string, string>> = { written: {}, after: {} };

  beforeAll(async () => {
    oldRoot = mkdtempSync(join(tmpdir(), 'rb01-sys04-old-'));
    scratch = mkdtempSync(join(tmpdir(), 'rb01-sys04-new-'));
    await extractPreviousRelease(oldRoot);
    const suffix = randomUUID().slice(0, 8);
    const namespaceA = `rb01_sys04_a_${suffix}`;
    const namespaceB = `rb01_sys04_b_${suffix}`;
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

    // ---- the new version's writes, in namespace B only.
    // 1. The recovery budget of one fault object runs out: the same cause, three failed attempts.
    const faultTaskId = idOf('rb01-fault-exhausted');
    const scope = { taskId: faultTaskId, employeeId: 'rb01-eng-1' };
    const fault = classifyFault({ phase: PHASE, errno: 'UND_ERR_CONNECT_TIMEOUT', elapsedMs: 20_000,
      identityAlias: 'LCA04_MEMBER', target: TARGET, environment: 'production' });
    const store = new FaultStore(forkB.db);
    for (let attempt = 1; attempt <= limits.maxAttempts; attempt++) {
      await store.report({ taskId: faultTaskId, fault, target: TARGET, now: 1_700_000_000_000 + attempt * 10_000,
        limits, holder: 'rb01-eng-1' });
    }
    // The budget is spent, so the fourth attempt is refused by the server.
    const refused = await store.reserve({ taskId: faultTaskId, target: TARGET, phase: PHASE,
      now: 1_700_000_000_000 + 40_000, limits });
    Object.assign(refusal, { allowed: refused.allowed, reason: refused.reason });
    // 2. The manager is told about the cause exactly once: the episode is notified.
    const episodeKey = `${faultFingerprint(fault)}#${faultTaskId}`;
    await store.markNotified(episodeKey);
    // 3. The exhausted task leaves the manager gate and waits on the one repair chain of the incident.
    const [episodes] = await forkB.db.query<[Array<{ episode?: string; state?: string; notified?: boolean; evidence_revision?: number }>]>(
      'SELECT episode, state, notified, evidence_revision FROM fault_episode WHERE task = $t;', { t: id('task', faultTaskId) });
    const episodeRow = (episodes ?? [])[0];
    if (!episodeRow?.episode) throw new Error('the fault episode of the exhausted task is missing');
    const [repairs] = await forkB.db.query<[Array<{ incident?: string; task?: unknown; state?: string }>]>(
      'SELECT incident, task, state FROM fault_repair;');
    const repairIncident = (repairs ?? [])[0]?.incident;
    if (!repairIncident) throw new Error('the repair chain of the incident is missing');
    // The repair task is the one the manager's defer will point the source task at. It is created here as an
    // ordinary engineering task, exactly as the new version creates it when a budget runs out.
    const repairTask = await seededB.core.createTask(seededB.gm, {
      title: 'rb01 故障修复', context: 'RB01 isolation drill: the one repair chain of the incident',
      executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: 'rb01-sys04-repair',
    });
    await forkB.db.query('UPDATE $row SET task = $task_ref, source_task = $source_ref, state = "open" WHERE incident = $incident;', {
      row: new RecordId('fault_repair', repairIncident), task_ref: id('task', repairTask.id), source_ref: id('task', faultTaskId),
      incident: repairIncident,
    });
    // The source task is a gm gate; the new version's defer moves it into the dependency wait, which clears
    // blocked_to — the single field the old release's manager gate filters on.
    await seededB.core.deferTaskUntil(seededB.gm, {
      taskId: faultTaskId, dependencies: [repairTask.id],
      text: 'RB01 演练：恢复预算已耗尽，原任务等待唯一修复链完成后再继续。', idempotencyKey: 'rb01-sys04-defer',
    });
    Object.assign(chainBefore, await taskShape(forkB, faultTaskId));
    const budgetRow = await store.scope(budgetKey(faultTaskId, TARGET, PHASE));
    Object.assign(budgetBefore, { attempts: budgetRow?.attempts, total_attempts: budgetRow?.totalAttempts,
      deadline: budgetRow?.deadline, last_attempt_at: budgetRow?.lastAttemptAt, failed: budgetRow?.failed });
    const episodeBeforeRow = await store.episode(episodeRow.episode);
    Object.assign(episodeBefore, { state: episodeBeforeRow?.state, notified: episodeBeforeRow?.notified,
      evidence_revision: episodeBeforeRow?.evidenceRevision });
    for (const table of NEW_TABLES) {
      newTableCounts.written[table] = await countRows(forkB, table);
      newTableDigests.written[table] = await tableDigest(forkB, table);
    }
    const [versionB] = await forkB.db.query<[{ schema_version?: number } | undefined]>('SELECT schema_version FROM ONLY company_meta:installation;')
    schemaVersion.before = versionB?.schema_version;

    // ---- the rollback: the same previous release runs against both namespaces.
    versionsBeforeRollback.A = await versionsOf(forkA);
    versionsBeforeRollback.B = await versionsOf(forkB);
    outcomes.A = await runPrevious(namespaceA, oldRoot);
    outcomes.B = await runPrevious(namespaceB, oldRoot);

    for (const table of tables) seedCounts.B[`after_${table}`] = await countRows(forkB, table);
    for (const table of NEW_TABLES) {
      newTableCounts.after[table] = await countRows(forkB, table);
      newTableDigests.after[table] = await tableDigest(forkB, table);
    }
    Object.assign(chainAfter, await taskShape(forkB, faultTaskId));
    const budgetAfterRow = await store.scope(budgetKey(faultTaskId, TARGET, PHASE));
    Object.assign(budgetAfter, { attempts: budgetAfterRow?.attempts, total_attempts: budgetAfterRow?.totalAttempts,
      deadline: budgetAfterRow?.deadline, last_attempt_at: budgetAfterRow?.lastAttemptAt, failed: budgetAfterRow?.failed });
    const episodeAfterRow = await store.episode(episodeRow.episode);
    Object.assign(episodeAfter, { state: episodeAfterRow?.state, notified: episodeAfterRow?.notified,
      evidence_revision: episodeAfterRow?.evidenceRevision });
    const [versionAfter] = await forkB.db.query<[{ schema_version?: number } | undefined]>('SELECT schema_version FROM ONLY company_meta:installation;')
    schemaVersion.after = versionAfter?.schema_version;
    if (process.env.SCK_RB01_EVIDENCE_DIR) {
      mkdirSync(process.env.SCK_RB01_EVIDENCE_DIR, { recursive: true });
      writeFileSync(join(process.env.SCK_RB01_EVIDENCE_DIR, 'rb01-sys04-rollback-results.json'), JSON.stringify({
        previousRelease: OLD_RELEASE, ticks: TICKS, versionsBeforeRollback,
        rowCounts: { seed: seedCounts, newTables: newTableCounts },
        exhaustedTask: { taskId: faultTaskId, before: chainBefore, after: chainAfter },
        budget: { before: budgetBefore, after: budgetAfter },
        episode: { before: episodeBefore, after: episodeAfter },
        schemaVersion, outcomes,
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
    expect(existsSync(join(oldRoot, 'src/fault-store.ts'))).toBe(false);
    expect(existsSync(join(oldRoot, 'src/faults.ts'))).toBe(false);
    expect(readFileSync(join(oldRoot, 'src/mcp/server.ts'), 'utf8')).not.toContain('fault_episode');
    // The old release's schema stops before SYS04's, and it never mentions the fault tables.
    expect(existsSync(join(oldRoot, 'schema/037-fault-budget.surql'))).toBe(false);
    expect(existsSync(join(oldRoot, 'schema/036-disposition-replay-fence.surql'))).toBe(true);
  });

  test('the new states exist where the new version wrote them, and the control namespace has none of them', () => {
    // The two namespaces were seeded identically, and no new table existed before the new version ran.
    for (const table of NEW_TABLES) expect(seedCounts.A[table]).toBe(0);
    for (const table of NEW_TABLES) {
      expect(newTableCounts.seed[table]).toBe(0);
      expect(newTableCounts.written[table]).toBeGreaterThan(0);
    }
    // The budget ran out, so the episode is exhausted and the repair chain exists.
    expect(budgetBefore.attempts).toBe(limits.maxAttempts);
    // The fourth attempt is refused by name, not merely unallowed.
    expect(refusal).toEqual({ allowed: false, reason: 'attempts_exhausted' });
    expect(episodeBefore.state).toBe('exhausted');
    // The manager was told about the cause exactly once.
    expect(episodeBefore.notified).toBe(true);
    // The exhausted task left the manager gate and waits on the one repair chain.
    expect(chainBefore.state).toBe('blocked');
    expect(chainBefore.blockedTo ?? null).toBeNull();
    expect(chainBefore.waitsOn).toHaveLength(1);
  });

  test('the previous runtime boots on new-version data and answers its own tool surface', () => {
    for (const label of ['A', 'B'] as const) {
      expect(outcomes[label].ok).toBe(true);
      expect(outcomes[label].ticks).toHaveLength(TICKS);
      expect(outcomes[label].taskTotal).toBeGreaterThan(0);
      // Liveness of the old runtime's own tool surface: an ordinary read that predates SYS04 and must still work.
      expect(outcomes[label].relays!.getTaskHistory.exit).toBe(0);
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

  test('zero misdispatch: waiting, gated, held, terminal and deferred tasks are never claimed or changed', () => {
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
  });

  test('isolated entry: an exhausted fault raises no session and no manager wake, while the same gate does in the control namespace', () => {
    // A defers nothing, so the previous release treats its gates as it always did: one gm-attention dispatch per gate.
    expect(outcomes.A.tasks!['rb01-gm-episode'].dispatch['gm-attention']).toBe(true);
    expect(outcomes.A.tasks!['rb01-fault-exhausted'].dispatch['gm-attention']).toBe(true);
    // B's gate was deferred: the task left the manager gate (blocked_to is cleared) and waits on the repair chain.
    expect(outcomes.B.tasks!['rb01-fault-exhausted'].dispatch['gm-attention']).toBe(false);
    expect(outcomes.B.tasks!['rb01-fault-exhausted'].dispatch.execute).toBe(false);
    expect(outcomes.B.tasks!['rb01-fault-exhausted'].occupied).toBe(false);
    for (const title of GATES) {
      expect(outcomes.A.tasks![title].version).toBe(versionsBeforeRollback.A[title]);
      expect(outcomes.B.tasks![title].version).toBe(versionsBeforeRollback.B[title]);
      expect(outcomes.B.tasks![title].occupied).toBe(false);
    }
    // The deferred task stays exactly where the new version left it: waiting, out of the manager gate.
    expect(chainAfter).toMatchObject({ state: 'blocked', blockedTo: null });
    expect(chainAfter.version).toBe(chainBefore.version);
  });

  test('the previous release never names the new tables, and the rollback leaves their contents unchanged', () => {
    const named: string[] = [];
    for (const dir of ['src', 'plugin/server']) {
      for (const file of new Bun.Glob('**/*.ts').scanSync({ cwd: join(oldRoot, dir) })) {
        if (file.split('/').includes('vendor')) continue;
        const text = readFileSync(join(oldRoot, dir, file), 'utf8');
        for (const table of NEW_TABLES) if (text.includes(table)) named.push(`${dir}/${file}:${table}`);
      }
    }
    expect(named).toEqual([]);
    for (const table of NEW_TABLES) expect(newTableDigests.after[table]).toBe(newTableDigests.written[table]);
    // The highest schema the previous release knows is 036; the new one is 037. The old release only bumps the
    // marker upward, so "not downgraded" is the before === after assertion below.
    expect(schemaVersion.before).toBeGreaterThanOrEqual(36);
    expect(schemaVersion.after).toBeGreaterThanOrEqual(36);
    expect(schemaVersion.before).toBe(schemaVersion.after);
  });

  test('the recovery budget survives the rollback, and the audit is recomputable', () => {
    // The old release knows nothing about the budget, so it neither spends it nor clears it.
    expect(budgetAfter.attempts).toBe(budgetBefore.attempts);
    expect(budgetAfter.total_attempts).toBe(budgetBefore.total_attempts);
    expect(budgetAfter.deadline).toBe(budgetBefore.deadline);
    expect(budgetAfter.last_attempt_at).toBe(budgetBefore.last_attempt_at);
    expect(budgetAfter.failed).toBe(budgetBefore.failed);
    // The deadline is the first attempt's start plus the total deadline: recomputable, not drifting.
    // The first report ran at 1_700_000_010_000 (the loop's first iteration), and that is where the recovery
    // deadline is anchored.
    expect(budgetBefore.deadline).toBe(1_700_000_010_000 + limits.totalDeadlineMs);
    // The last attempt is the third one, ten seconds after the second.
    expect(budgetBefore.last_attempt_at).toBe(1_700_000_030_000);
    // The episode is untouched: the manager notice and the evidence revision stay as the new version left them.
    expect(episodeAfter.state).toBe(episodeBefore.state);
    expect(episodeAfter.notified).toBe(episodeBefore.notified);
    expect(episodeAfter.evidence_revision).toBe(episodeBefore.evidence_revision);
  });
});
