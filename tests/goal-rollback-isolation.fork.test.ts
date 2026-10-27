// RB01 rollback isolation drill for SYS07's goal-governance states on the company fork (never production).
//
// The previous release is a real rollback target extracted from git with `git archive` and executed by
// tests/fixtures/rb01-old-runner.ts. Two identical fixtures are seeded in separate namespaces; only B receives
// the SYS07 writes. The previous runtime bootstraps both and runs its own dispatcher for several ticks.
//
// New states and the previous release's behaviour (the design this drill verifies):
//   goal.state = 'needs_repair'          -> isolated: the old release knows no such state. Its goal-close
//                                            statement is `WHERE state = 'active'`, so it cannot complete the
//                                            goal, and its goal-bound repair/defer paths refuse a non-active
//                                            goal. It does not invent a new state.
//   goal.needs_repair / deadline / version -> ignored: the old release never reads these optional fields.
//   goal_outcome / goal_evidence           -> ignored: the old release never reads these tables, and never
//                                            writes them.
//   final gate remains an ordinary task    -> no task state, dependency, lease, acceptance or owner decision
//                                            is rewritten by SYS07, so the rollback adds no dispatch source and
//                                            cannot misdispatch waiting/gated work.
//
// The identical fixture in namespace A is the positive control: the old dispatcher still claims its ordinary
// ready task, proving the drill is measuring isolation, not a broken old runtime.
//
// Gated by RUN_SCK_ROLLBACK_FORK_TESTS=1 (scripts/test-worktrees.ts sets it).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordId } from 'surrealdb';
import { loadDatabaseConfig } from '../src/config.ts';
import { CompanyDatabase } from '../src/database.ts';
import { SurrealCompanyCore } from '../src/core.ts';
import { LocalEnrollmentAdmin } from '../src/enrollment.ts';
import { Workforce } from '../src/workforce.ts';

const ROOT = join(import.meta.dir, '..');
/** The release the rollback would land on: the SYS05 release this lane branched from. The deploy leg may
 * override it with whatever `active` points at when SYS07 lands. Read-only extraction, never a checkout. */
const OLD_RELEASE = process.env.SCK_RB01_OLD_RELEASE ?? 'c68d1d4d88a40422df24c7fb717d2760314607ca';
const TICKS = 3;
const NEW_TABLES = ['goal_outcome', 'goal_evidence'];
const run = process.env.RUN_SCK_ROLLBACK_FORK_TESTS === '1' ? describe : describe.skip;

type TaskState = { state: string; version: number; blockedTo: string | null; occupied: boolean };
type Relay = { exit: number; stdout?: string; stderr: string };
type Outcome = {
  ok: boolean; error?: string; bootstrap?: boolean; taskTotal?: number;
  ticks?: Array<Record<string, unknown>>; spawns?: string[]; tasks?: Record<string, TaskState>;
  relays?: Record<string, Relay>; logs?: string[];
};
type GoalRow = { id: RecordId; state: string; version?: number; needs_repair?: boolean; tasks?: { acceptance?: RecordId } };

/** `goal:⟨uuid⟩` and `goal:uuid` both normalise to the bare id. */
const norm = (value: unknown) => String(value).replace(/^(task|goal):/, '').replace(/[⟨⟩]/g, '');

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

async function tableDigest(database: CompanyDatabase, table: string): Promise<string> {
  const [rows] = await database.db.query<[unknown[]]>(`SELECT * FROM ${table} ORDER BY id;`);
  return createHash('sha256').update(JSON.stringify(rows ?? [])).digest('hex');
}

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

/** The identical fixture in each namespace: one ordinary ready task (positive control) and one goal whose final
 * gate is void. Only B gets the SYS07 outcome/evidence/needs_repair writes. */
async function seedFixture(database: CompanyDatabase, scratch: string): Promise<{ core: SurrealCompanyCore; gm: string; goalId: string; manualId: string; gateId: string }> {
  const core = new SurrealCompanyCore(database);
  const gm = await new LocalEnrollmentAdmin(database).enroll(`rb01-sys07-gm-${randomUUID().slice(0, 8)}`, 'gm', ['execute', 'review', 'manage']);
  await database.db.upsert(new RecordId('company_meta', 'config')).content({
    eval_enabled: false, jev_decisions: false, quota_floor_pct: 0, quota_weekly_floor_pct: 0, session_max_wakes: 0, session_max_input_k: 0,
  });
  const wf = new Workforce(database, join(scratch, 'unused-credential-files'));
  await wf.upsertDef('rb01-eng', { role: 'engineering', provider: 'codex', model: 'fixture', maxInstances: 2 });
  await wf.upsertDef('rb01-qa', { role: 'qa', provider: 'codex', model: 'fixture', maxInstances: 1 });
  await wf.upsertDef('rb01-gm', { role: 'gm', provider: 'codex', model: 'fixture', maxInstances: 1 });
  await core.createTask(gm, { title: 'rb01-ready', context: '就绪任务：旧版调度应认领，作为阳性对照。',
    executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: `rb01-sys07-ready-${randomUUID()}` });

  const goalId = `rb01-goal-${randomUUID().slice(0, 8)}`;
  const manualId = `rb01-goal-manual-${randomUUID().slice(0, 8)}`;
  const gateId = `rb01-goal-gate-${randomUUID().slice(0, 8)}`;
  const goal = new RecordId('goal', goalId);
  const manual = new RecordId('task', manualId);
  const gate = new RecordId('task', gateId);
  await database.db.query(`CREATE ONLY $t CONTENT {
    title: '运营验收', context: 'RB01 SYS07 目标夹具', state: 'done', kind: 'task', executor_role: 'product',
    reviewer_role: 'gm', dependencies: [], goal: $goal, version: 1, fence: 0, created_at: time::now() - 5d
  };`, { t: manual, goal });
  await database.db.query(`CREATE ONLY $t CONTENT {
    title: 'G3 老板最终验收', context: 'RB01 SYS07 终验夹具', state: 'void', kind: 'gate', executor_role: 'gm',
    reviewer_role: 'owner', dependencies: [], goal: $goal, version: 1, fence: 0, created_at: time::now() - 5d
  };`, { t: gate, goal });
  await database.db.query(`CREATE ONLY $g CONTENT {
    title: 'RB01 目标终验隔离', brief: 'SYS07 回滚演练目标', state: 'active', tier: 'standard', pipeline: 'software',
    tasks: { manual: $manual, acceptance: $gate }, anchors: [$manual, $gate], version: 0, created_at: time::now() - 5d
  };`, { g: goal, manual, gate });
  return { core, gm, goalId, manualId, gateId };
}

run('RB01 rollback isolation: SYS07 goal states against the previous release', () => {
  let oldRoot = '';
  let scratch = '';
  let forkA: CompanyDatabase | undefined;
  let forkB: CompanyDatabase | undefined;
  const goalBefore: Record<'A' | 'B', GoalRow | undefined> = { A: undefined, B: undefined };
  const goalAfter: Record<'A' | 'B', GoalRow | undefined> = { A: undefined, B: undefined };
  const taskBefore: Record<'A' | 'B', Record<string, TaskState>> = { A: {}, B: {} };
  const taskAfter: Record<'A' | 'B', Record<string, TaskState>> = { A: {}, B: {} };
  const digestsBefore: Record<string, string> = {};
  const digestsAfter: Record<string, string> = {};
  const counts: Record<'A' | 'B', Record<string, number>> = { A: {}, B: {} };
  const schemaVersion: Partial<Record<'before' | 'after', number | undefined>> = {};
  const outcomes = {} as { A: Outcome; B: Outcome };
  const fixture = {} as Record<'A' | 'B', Awaited<ReturnType<typeof seedFixture>>>;

  const readGoal = async (database: CompanyDatabase, goalId: string) => {
    const [rows] = await database.db.query<[GoalRow[]]>(
      'SELECT id, state, version, needs_repair, tasks FROM goal WHERE id = $goal;', { goal: new RecordId('goal', goalId) });
    return rows?.[0];
  };
  const readGoalTasks = async (database: CompanyDatabase, goalId: string) => {
    const [rows] = await database.db.query<[Array<{ id: RecordId; state: string; version: number; blocked_to?: string; current_employee?: string }>]>(
      'SELECT id, state, version, blocked_to, current_employee FROM task WHERE goal = $goal ORDER BY id;', { goal: new RecordId('goal', goalId) });
    return Object.fromEntries((rows ?? []).map(row => [norm(row.id), {
      state: row.state, version: row.version, blockedTo: row.blocked_to ?? null, occupied: Boolean(row.current_employee),
    }]));
  };

  beforeAll(async () => {
    oldRoot = mkdtempSync(join(tmpdir(), 'rb01-sys07-old-'));
    scratch = mkdtempSync(join(tmpdir(), 'rb01-sys07-new-'));
    await extractPreviousRelease(oldRoot);
    const suffix = randomUUID().slice(0, 8);
    const namespaceA = `rb01_sys07_a_${suffix}`;
    const namespaceB = `rb01_sys07_b_${suffix}`;
    forkA = await openFork(namespaceA);
    forkB = await openFork(namespaceB);
    fixture.A = await seedFixture(forkA, scratch);
    fixture.B = await seedFixture(forkB, scratch);

    // ---- the new version's writes, in namespace B only.
    const gm = fixture.B.gm;
    await fixture.B.core.goalOutcomeRegister(gm, {
      goalId: fixture.B.goalId, expectedVersion: 0, expected: '交付客户激活并采纳的结果',
      requiredEvidence: ['customer_activation'], responsibleRole: 'gm',
      reason: 'RB01 演练：新版登记目标成果与客户激活证据要求', idempotencyKey: `rb01-sys07-outcome-${suffix}`,
    });
    const card = await fixture.B.core.goalFinalize(gm, { goalId: fixture.B.goalId });
    expect(card.state).toBe('needs_repair');
    await fixture.B.core.goalEvidenceRecord(gm, {
      goalId: fixture.B.goalId, kind: 'customer_activation', summary: '客户邮件确认已激活',
      source: 'mail:customer-rb01-sys07', confirmedBy: '客户王五', evidenceType: 'external_receipt',
      reason: 'RB01 演练：新版写入真实客户回执', idempotencyKey: `rb01-sys07-receipt-${suffix}`,
    });
    for (const [label, database] of [['A', forkA], ['B', forkB]] as const) {
      const f = fixture[label];
      goalBefore[label] = await readGoal(database, f.goalId);
      taskBefore[label] = await readGoalTasks(database, f.goalId);
      counts[label] = {
        goal_outcome: (await database.db.query<[Array<{ n: number }>]>('SELECT count() AS n FROM goal_outcome GROUP ALL;'))[0]?.[0]?.n ?? 0,
        goal_evidence: (await database.db.query<[Array<{ n: number }>]>('SELECT count() AS n FROM goal_evidence GROUP ALL;'))[0]?.[0]?.n ?? 0,
      };
    }
    expect(counts.A).toEqual({ goal_outcome: 0, goal_evidence: 0 });
    expect(counts.B).toEqual({ goal_outcome: 1, goal_evidence: 1 });
    expect(goalBefore.A?.state).toBe('active');
    expect(goalBefore.B?.state).toBe('needs_repair');
    expect(goalBefore.B?.needs_repair).toBe(true);
    for (const table of NEW_TABLES) digestsBefore[table] = await tableDigest(forkB, table);
    const [versionBefore] = await forkB.db.query<[{ schema_version?: number } | undefined]>(
      'SELECT schema_version FROM ONLY company_meta:installation;');
    schemaVersion.before = versionBefore?.schema_version;

    // ---- the rollback: the previous release runs its own dispatcher against both namespaces.
    outcomes.A = await runPrevious(namespaceA, oldRoot);
    outcomes.B = await runPrevious(namespaceB, oldRoot);

    for (const [label, database] of [['A', forkA], ['B', forkB]] as const) {
      const f = fixture[label];
      goalAfter[label] = await readGoal(database, f.goalId);
      taskAfter[label] = await readGoalTasks(database, f.goalId);
    }
    for (const table of NEW_TABLES) digestsAfter[table] = await tableDigest(forkB, table);
    const [versionAfter] = await forkB.db.query<[{ schema_version?: number } | undefined]>(
      'SELECT schema_version FROM ONLY company_meta:installation;');
    schemaVersion.after = versionAfter?.schema_version;
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
    expect(existsSync(join(oldRoot, 'src/goal-store.ts'))).toBe(false);
    expect(existsSync(join(oldRoot, 'schema/042-goal-governance.surql'))).toBe(false);
    expect(readFileSync(join(oldRoot, 'src/mcp/server.ts'), 'utf8')).not.toContain('goal_outcome');
  });

  test('the new goal state and tables exist only where the new version wrote them', () => {
    expect(goalBefore.A).toMatchObject({ state: 'active' });
    expect(goalBefore.A?.needs_repair ?? false).toBe(false);
    expect(goalBefore.B).toMatchObject({ state: 'needs_repair', needs_repair: true });
    expect(counts.A).toEqual({ goal_outcome: 0, goal_evidence: 0 });
    expect(counts.B).toEqual({ goal_outcome: 1, goal_evidence: 1 });
  });

  test('the previous runtime boots on new-version data and still serves its own read surface', () => {
    for (const label of ['A', 'B'] as const) {
      expect(outcomes[label].ok).toBe(true);
      expect(outcomes[label].ticks).toHaveLength(TICKS);
      expect(outcomes[label].taskTotal).toBeGreaterThan(0);
      expect(outcomes[label].relays!.getTaskHistory.exit).toBe(0);
      const ctx = outcomes[label].relays!.getContext;
      expect(ctx.exit).not.toBe(0);
      expect(`${ctx.stdout ?? ''}${ctx.stderr ?? ''}`).toContain('cursor');
    }
    expect(outcomes.B.bootstrap).toBe(true);
  });

  test('positive control: the previous dispatcher still claims the ordinary ready task in both namespaces', () => {
    for (const label of ['A', 'B'] as const) {
      const ready = outcomes[label].tasks?.['rb01-ready'];
      expect(ready).toMatchObject({ state: 'doing', occupied: true });
      expect(ready!.version).toBeGreaterThan(1);
    }
  });

  test('zero misdispatch: goal tasks keep their state, version and holder; the goal is never closed', () => {
    for (const label of ['A', 'B'] as const) {
      expect(taskAfter[label]).toEqual(taskBefore[label]);
      expect(goalAfter[label]?.state).toBe(goalBefore[label]?.state);
      expect(goalAfter[label]?.version).toBe(goalBefore[label]?.version);
      expect(goalAfter[label]?.needs_repair ?? false).toBe(goalBefore[label]?.needs_repair ?? false);
      for (const task of Object.values(taskAfter[label])) {
        expect(task.occupied).toBe(false);
      }
    }
    // B stays parked even though the previous release ran; A was never parked.
    expect(goalAfter.A?.state).toBe('active');
    expect(goalAfter.B?.state).toBe('needs_repair');
    const gate = Object.entries(taskAfter.B)
      .find(([id]) => id === norm(fixture.B.gateId))?.[1];
    expect(gate).toMatchObject({ state: 'void', occupied: false });
  });

  test('the previous release never reads or changes goal_outcome/goal_evidence', () => {
    const named: string[] = [];
    for (const dir of ['src', 'plugin/server']) {
      for (const file of new Bun.Glob('**/*.ts').scanSync({ cwd: join(oldRoot, dir) })) {
        if (file.split('/').includes('vendor')) continue;
        const text = readFileSync(join(oldRoot, dir, file), 'utf8');
        for (const table of NEW_TABLES) if (text.includes(table)) named.push(`${dir}/${file}:${table}`);
      }
    }
    expect(named).toEqual([]);
    for (const table of NEW_TABLES) expect(digestsAfter[table]).toBe(digestsBefore[table]);
    // The old release knows schema 040, the new one 042; it only bumps the marker upward.
    expect(schemaVersion.before).toBeGreaterThanOrEqual(42);
    expect(schemaVersion.after).toBe(schemaVersion.before);
  });
});
