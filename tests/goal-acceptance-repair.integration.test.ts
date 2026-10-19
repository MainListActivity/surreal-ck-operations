import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { RecordId } from 'surrealdb';
import { loadDatabaseConfig } from '../src/config.ts';
import { CompanyDatabase } from '../src/database.ts';
import { CompanyError, SurrealCompanyCore, asId, id } from '../src/core.ts';
import { LocalEnrollmentAdmin } from '../src/enrollment.ts';
import { OwnerDesk } from '../src/owner.ts';
import type { GoalAcceptanceRepair, GoalAcceptanceView, LeaseProof } from '../src/contracts.ts';

// Runs only on the isolated company fork started by scripts/test-worktrees.ts; never on production.
const config = { ...loadDatabaseConfig(), namespace: 'sck_agent_company_test', database: 'control_plane' };
const database = new CompanyDatabase(config);
const core = new SurrealCompanyCore(database);
const owner = new OwnerDesk(database);
const enrollment = new LocalEnrollmentAdmin(database);
const suffix = randomUUID().slice(0, 8);
let seq = 0;
const key = (label: string) => `gar-${suffix}-${label}-${++seq}`;
setDefaultTimeout(300000);

let gm: string, gm2: string, gmNoManage: string, productManage: string, productWorker: string, eng: string, qa: string;

beforeAll(async () => {
  await database.connect();
  await database.bootstrap();
  gm = await enrollment.enroll(`gar-gm-${suffix}`, 'gm', ['execute', 'review', 'manage']);
  gm2 = await enrollment.enroll(`gar-gm2-${suffix}`, 'gm', ['execute', 'review', 'manage']);
  gmNoManage = await enrollment.enroll(`gar-gm3-${suffix}`, 'gm', ['execute', 'review']);
  productManage = await enrollment.enroll(`gar-pm-${suffix}`, 'product', ['execute', 'review', 'manage']);
  productWorker = await enrollment.enroll(`gar-pw-${suffix}`, 'product', ['execute', 'review']);
  eng = await enrollment.enroll(`gar-eng-${suffix}`, 'engineering', ['execute', 'review']);
  qa = await enrollment.enroll(`gar-qa-${suffix}`, 'qa', ['execute', 'review']);
});

afterAll(async () => { await database.close(); });

type TaskFields = {
  id: RecordId; title: string; state: string; version: number; kind?: string;
  executor_role: string; reviewer_role: string; dependencies?: RecordId[];
};
type GoalFields = { state: string; tier?: string; tasks: Record<string, RecordId>; anchors: RecordId[] };

const taskRow = async (taskId: string) => (await database.db.select<TaskFields>(id('task', taskId)))!;
const goalRow = async (goalId: string) => (await database.db.select<GoalFields>(id('goal', goalId)))!;
const depsOf = (row: TaskFields) => (row.dependencies ?? []).map(asId).sort();
const preview = (goalId: string, candidateTaskId?: string, credential = gm): Promise<GoalAcceptanceView> =>
  core.goalAcceptancePreview!(credential, { goalId, candidateTaskId });
const repair = (input: GoalAcceptanceRepair, credential = gm) => core.goalAcceptanceRepair!(credential, input);
const proofOf = (claim: { task: { id: string; version: number }; deliveryId: string; fence: number }): LeaseProof =>
  ({ taskId: claim.task.id, deliveryId: claim.deliveryId, fence: claim.fence, expectedVersion: claim.task.version });

/** Executor claims and submits; reviewer claims the review and accepts. */
async function complete(executor: string, reviewer: string, taskId: string) {
  const claim = await core.claim(executor, taskId);
  const submitted = await core.submit(executor, proofOf(claim), { text: '夹具：实现与上线结果已提交，等待另一位工程师独立复核通过。', idempotencyKey: key('submit') });
  const review = await core.claim(reviewer, submitted.id);
  return core.accept(reviewer, proofOf(review), { text: '夹具：独立复核已逐项核对提交证据，确认通过并同意接收。', idempotencyKey: key('accept') });
}

async function goalTasks(goalId: string): Promise<TaskFields[]> {
  const [rows] = await database.db.query<[TaskFields[]]>(
    'SELECT id, title, state, version, kind, executor_role, reviewer_role, dependencies, created_at FROM task WHERE goal = $goal ORDER BY created_at, id;',
    { goal: id('goal', goalId) });
  return rows;
}

async function countAudits(taskId: string, action: string): Promise<number> {
  const [rows] = await database.db.query<[Array<{ n: number }>]>(
    'SELECT count() AS n FROM audit WHERE task = $task AND action = $action GROUP ALL;', { task: id('task', taskId), action });
  return rows[0]?.n ?? 0;
}

async function countOutbox(taskId: string, kind: string): Promise<number> {
  const [rows] = await database.db.query<[Array<{ n: number }>]>(
    'SELECT count() AS n FROM outbox WHERE task = $task AND kind = $kind GROUP ALL;', { task: id('task', taskId), kind });
  return rows[0]?.n ?? 0;
}

async function expectRefused(promise: Promise<unknown>, code: CompanyError['code'], pattern: RegExp) {
  const error = await promise.then(() => undefined, (reason: unknown) => reason);
  expect(error).toBeInstanceOf(CompanyError);
  expect((error as CompanyError).code).toBe(code);
  expect((error as CompanyError).message).toMatch(pattern);
}

/** Triage builds the real quick template: d0 实现与上线申请 (release) → d1 合入部署 (deploy) → manual 运营验收. */
async function quickGoal() {
  const goal = await owner.createGoal({ text: `验收引用修复夹具 ${suffix} ${++seq}`, source: 'owner:test', key: key('goal'), tier: 'quick' });
  const rows = await goalTasks(goal.id);
  const pick = (predicate: (row: TaskFields) => boolean) => asId(rows.find(predicate)!.id);
  return {
    goalId: goal.id,
    d0: pick(row => row.kind === 'release'),
    d1: pick(row => row.kind === 'deploy'),
    manual: pick(row => row.executor_role === 'product' && row.reviewer_role === 'gm'),
  };
}

/** The incident: the acceptance task is voided by mistake while the goal still points at it. */
async function voidedGoal() {
  const f = await quickGoal();
  await core.retireTask(gm, { taskId: f.manual, text: '误作废：quick 运营验收被当作重复任务作废（夹具复现）', idempotencyKey: key('retire') });
  return f;
}

async function createCandidate(goalId: string, dependencies: string[], executorRole: 'product' | 'engineering' = 'product') {
  const task = await core.createTask(gm, {
    title: `[修复] 运营验收候选 ${suffix} ${++seq}`, context: '夹具：quick 目标的运营验收候选，等待全部业务工作完成。',
    executorRole, reviewerRole: 'gm', kind: 'task', goalId, dependencies, idempotencyKey: key('candidate'),
  });
  return task.id;
}

/** Voided acceptance plus a blocked candidate that depends on the whole unfinished chain. */
async function incident() {
  const f = await voidedGoal();
  const candidate = await createCandidate(f.goalId, [f.d0, f.d1]);
  return { ...f, candidate };
}

const inputFor = (f: { goalId: string; manual: string; candidate: string }, snapshotHash: string, label: string): GoalAcceptanceRepair => ({
  goalId: f.goalId, expectedOldTaskId: f.manual, candidateTaskId: f.candidate, snapshotHash,
  text: '夹具修复：把误作废的运营验收引用改到受审候选，候选等待全部业务工作完成。', idempotencyKey: key(label),
});

test('repro: a voided quick acceptance keeps the goal on a dead anchor, and new work cannot attach to it', async () => {
  const f = await voidedGoal();
  const goal = await goalRow(f.goalId);
  expect(goal.state).toBe('active');
  expect(asId(goal.tasks.manual)).toBe(f.manual);
  expect(asId(goal.tasks.acceptance)).toBe(f.manual);
  expect(goal.anchors.map(asId)).toEqual([f.manual]);
  expect((await taskRow(f.manual)).state).toBe('void');
  const followup = await core.createTask(gm, {
    title: `[后续] 修复前新增 ${suffix}`, context: '夹具：作废锚点之后新增的业务工作。',
    executorRole: 'qa', reviewerRole: 'gm', goalId: f.goalId, idempotencyKey: key('followup'),
  });
  // The dead anchor never gains the new dependency, so the goal has no open acceptance to wait on it.
  expect(depsOf(await taskRow(f.manual))).toEqual([f.d1].sort());
  expect(followup.state).toBe('ready');
});

test('preview is read-only, reports the repair basis, and is limited to gm with manage', async () => {
  const f = await incident();
  const before = { goal: await goalRow(f.goalId), candidate: await taskRow(f.candidate), audits: await countAudits(f.candidate, 'goal_acceptance_repair') };
  const view = await preview(f.goalId, f.candidate);
  expect(view.ready).toBe(true);
  expect(view.violations).toEqual([]);
  expect(view.replaced?.id).toBe(f.manual);
  expect(view.replaced?.state).toBe('void');
  expect(view.unfinished.map(task => task.id).sort()).toEqual([f.d0, f.d1].sort());
  expect(view.candidate?.missing).toEqual([]);
  expect(view.diff.manual).toEqual({ from: f.manual, to: f.candidate });
  expect(view.snapshot.hash).toMatch(/^[0-9a-f]{64}$/);
  expect(await preview(f.goalId, f.candidate)).toEqual(view);
  expect(await goalRow(f.goalId)).toEqual(before.goal);
  expect(await taskRow(f.candidate)).toEqual(before.candidate);
  expect(await countAudits(f.candidate, 'goal_acceptance_repair')).toBe(before.audits);
  await expectRefused(preview(f.goalId, f.candidate, productManage), 'forbidden', /Only gm/);
  await expectRefused(preview(f.goalId, f.candidate, gmNoManage), 'forbidden', /Capability denied/);
  await expectRefused(preview(f.goalId, f.candidate, eng), 'forbidden', /Capability denied/);
  await expectRefused(preview(`no-such-goal-${suffix}`, f.candidate), 'not_found', /goal not found/);
});

test('gm repair repoints references and anchors in one audited step, keeps the voided task, and later work anchors to the candidate', async () => {
  const f = await incident();
  const voidBefore = await taskRow(f.manual);
  const view = await preview(f.goalId, f.candidate);
  const result = await repair(inputFor(f, view.snapshot.hash, 'allow'));
  expect(result).toMatchObject({ goalId: f.goalId, replacedTaskId: f.manual, anchors: [f.candidate], snapshotHash: view.snapshot.hash });
  expect(result.candidate).toMatchObject({ id: f.candidate, state: 'blocked', executorRole: 'product', reviewerRole: 'gm' });
  const goal = await goalRow(f.goalId);
  expect(asId(goal.tasks.manual)).toBe(f.candidate);
  expect(asId(goal.tasks.acceptance)).toBe(f.candidate);
  expect(goal.anchors.map(asId)).toEqual([f.candidate]);
  expect(goal.state).toBe('active');
  expect(await taskRow(f.manual)).toEqual(voidBefore);
  const voidHistory = await core.history(gm, f.manual);
  expect(voidHistory.map(entry => entry.action)).toEqual(expect.arrayContaining(['retire', 'goal_acceptance_replaced']));
  const candidateHistory = await core.history(gm, f.candidate);
  expect(candidateHistory.some(entry => entry.action === 'goal_acceptance_repair' && entry.evidence?.includes(view.snapshot.hash))).toBe(true);
  expect(await countOutbox(f.candidate, 'goal_acceptance_repaired')).toBe(1);
  // Work added after the repair waits on the live candidate, not on the void task.
  const followup = await core.createTask(gm, {
    title: `[后续] 修复后新增 ${suffix}`, context: '夹具：修复之后新增的业务工作。',
    executorRole: 'qa', reviewerRole: 'gm', goalId: f.goalId, idempotencyKey: key('followup'),
  });
  const candidateNow = await core.getTask(gm, f.candidate);
  expect(candidateNow.dependencies).toEqual(expect.arrayContaining([f.d0, f.d1, followup.id]));
  expect(candidateNow.state).toBe('blocked');
  expect(depsOf(await taskRow(f.manual))).toEqual([f.d1].sort());
});

test('same key and payload replay the stored result, a changed payload conflicts, and a restarted service still replays', async () => {
  const f = await incident();
  const view = await preview(f.goalId, f.candidate);
  const input = inputFor(f, view.snapshot.hash, 'replay');
  const first = await repair(input);
  expect(await repair({ ...input })).toEqual(first);
  await expectRefused(repair({ ...input, text: '同一个 key 换了一段理由，必须冲突。' }), 'conflict', /different input/);
  const restartedDb = new CompanyDatabase(config);
  await restartedDb.connect();
  await restartedDb.useDatabase();
  try {
    const restarted = new SurrealCompanyCore(restartedDb);
    expect(await restarted.goalAcceptanceRepair!(gm, input)).toEqual(first);
    const after = await restarted.goalAcceptancePreview!(gm, { goalId: f.goalId, candidateTaskId: f.candidate });
    expect(after.goal.tasks.manual).toBe(f.candidate);
    expect(after.ready).toBe(false);
    expect(after.violations.map(violation => violation.code)).toContain('conflict');
  } finally {
    await restartedDb.close();
  }
});

test('stale snapshot, a different expected reference, and a missing candidate are refused without writes', async () => {
  const f = await incident();
  const view = await preview(f.goalId, f.candidate);
  await expectRefused(repair(inputFor(f, '0'.repeat(64), 'stale')), 'conflict', /snapshot moved/);
  await expectRefused(repair({ ...inputFor(f, view.snapshot.hash, 'oldref'), expectedOldTaskId: f.d0 }), 'conflict', /expected task differs/);
  await expectRefused(repair({ ...inputFor(f, view.snapshot.hash, 'ghost'), candidateTaskId: `ghost-${suffix}` }), 'not_found', /candidate task not found/);
  expect(asId((await goalRow(f.goalId)).tasks.manual)).toBe(f.manual);
  expect(await countAudits(f.candidate, 'goal_acceptance_repair')).toBe(0);
});

test('candidate shape and state are enforced: product to gm, kind task, blocked, unleased, unsubmitted', async () => {
  const cases: Array<{ label: string; make: (f: Awaited<ReturnType<typeof voidedGoal>>) => Promise<string>; code: CompanyError['code']; pattern: RegExp }> = [
    { label: 'engineering executor', make: async f => createCandidate(f.goalId, [f.d0, f.d1], 'engineering'), code: 'invalid', pattern: /executed by product and reviewed by gm/ },
    { label: 'ready (no dependencies)', make: async f => createCandidate(f.goalId, []), code: 'conflict', pattern: /must be blocked, found ready/ },
    {
      label: 'void', code: 'conflict', pattern: /must be blocked, found void/,
      make: async f => {
        const candidate = await createCandidate(f.goalId, [f.d0, f.d1]);
        await core.retireTask(gm, { taskId: candidate, text: '夹具：作废候选以验证状态门', idempotencyKey: key('void-candidate') });
        return candidate;
      },
    },
    {
      label: 'doing (claimed)', code: 'conflict', pattern: /must be blocked, found doing/,
      make: async f => {
        const candidate = await createCandidate(f.goalId, []);
        // A separate product employee keeps this lease from blocking productWorker in the closure fixture.
        await core.claim(productManage, candidate);
        return candidate;
      },
    },
  ];
  for (const testCase of cases) {
    const f = await voidedGoal();
    const candidate = await testCase.make(f);
    const hash = (await preview(f.goalId, candidate)).snapshot.hash;
    await expectRefused(repair({ ...inputFor({ ...f, candidate }, hash, `shape-${testCase.label}`) }), testCase.code, testCase.pattern);
    expect(asId((await goalRow(f.goalId)).tasks.manual), testCase.label).toBe(f.manual);
  }
});

test('unfinished work must be covered, dependency cycles are refused, and a candidate from another goal is refused', async () => {
  const partial = await voidedGoal();
  const partialCandidate = await createCandidate(partial.goalId, [partial.d0]);
  await expectRefused(repair(inputFor({ ...partial, candidate: partialCandidate }, (await preview(partial.goalId, partialCandidate)).snapshot.hash, 'partial')),
    'invalid', /does not depend on unfinished goal work: .*/);

  const cyclic = await incident();
  const waiter = await core.createTask(gm, {
    title: `[后续] 反向依赖 ${suffix}`, context: '夹具：依赖候选的业务工作，用于验证环检测。',
    executorRole: 'qa', reviewerRole: 'gm', goalId: cyclic.goalId, dependencies: [cyclic.candidate], idempotencyKey: key('waiter'),
  });
  // Force the candidate to also wait on the waiter, which already waits on the candidate.
  await database.db.query('UPDATE ONLY $candidate SET dependencies += $waiter;', { candidate: id('task', cyclic.candidate), waiter: id('task', waiter.id) });
  await expectRefused(repair(inputFor(cyclic, (await preview(cyclic.goalId, cyclic.candidate)).snapshot.hash, 'cycle')),
    'invalid', /dependency cycle/);

  const other = await voidedGoal();
  const otherCandidate = await createCandidate(other.goalId, [other.d0, other.d1]);
  const mine = await incident();
  await expectRefused(repair(inputFor({ ...mine, candidate: otherCandidate }, (await preview(other.goalId, otherCandidate)).snapshot.hash, 'cross')),
    'invalid', /belongs to another goal/);
  expect(asId((await goalRow(mine.goalId)).tasks.manual)).toBe(mine.manual);
});

test('owner gates, a finished goal, a non-quick tier, and a live acceptance are refused', async () => {
  const gated = await incident();
  await core.createTask(gm, {
    title: `[门] 老板关口 ${suffix}`, context: '夹具：老板关口，修复工具不得绕过。',
    executorRole: 'product', reviewerRole: 'owner', goalId: gated.goalId, idempotencyKey: key('owner-gate'),
  });
  await expectRefused(repair(inputFor(gated, (await preview(gated.goalId, gated.candidate)).snapshot.hash, 'owner-gate')),
    'invalid', /owner acceptance gate/);

  const finished = await incident();
  const finishedHash = (await preview(finished.goalId, finished.candidate)).snapshot.hash;
  await database.db.query('UPDATE ONLY $goal SET state = $state;', { goal: id('goal', finished.goalId), state: 'done' });
  await expectRefused(repair(inputFor(finished, finishedHash, 'done')), 'conflict', /goal is done, not active/);

  const standard = await owner.createGoal({ text: `标准目标夹具 ${suffix} ${++seq}`, source: 'owner:test', key: key('standard'), tier: 'standard' });
  const anyTask = asId((await goalTasks(standard.id))[0]!.id);
  await expectRefused(repair({
    goalId: standard.id, expectedOldTaskId: anyTask, candidateTaskId: anyTask, snapshotHash: '0'.repeat(64),
    text: '标准目标不能走快速修复入口。', idempotencyKey: key('standard-repair'),
  }), 'invalid', /goal tier must be quick/);

  const live = await quickGoal();
  const liveCandidate = await createCandidate(live.goalId, [live.d0, live.d1]);
  await expectRefused(repair({
    goalId: live.goalId, expectedOldTaskId: live.manual, candidateTaskId: liveCandidate, snapshotHash: '0'.repeat(64),
    text: '运营验收尚未作废，不能修复。', idempotencyKey: key('live'),
  }), 'conflict', /must be void, found blocked/);
});

test('twenty concurrent repairs commit exactly once and the losers are refused', async () => {
  const f = await incident();
  const hash = (await preview(f.goalId, f.candidate)).snapshot.hash;
  const settled = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => repair(inputFor(f, hash, `race-${i}`))));
  expect(settled.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
  for (const outcome of settled) {
    if (outcome.status === 'rejected') {
      expect(outcome.reason).toBeInstanceOf(CompanyError);
      expect(['conflict', 'temporarily_unavailable']).toContain((outcome.reason as CompanyError).code);
    }
  }
  expect(asId((await goalRow(f.goalId)).tasks.manual)).toBe(f.candidate);
  expect(await countAudits(f.candidate, 'goal_acceptance_repair')).toBe(1);
  expect(await countOutbox(f.candidate, 'goal_acceptance_repaired')).toBe(1);
});

test('identical concurrent requests with one key share one committed result', async () => {
  const f = await incident();
  const hash = (await preview(f.goalId, f.candidate)).snapshot.hash;
  const input = inputFor(f, hash, 'shared-key');
  const settled = await Promise.allSettled(Array.from({ length: 20 }, () => repair(input)));
  const results = settled.map(outcome => {
    if (outcome.status !== 'fulfilled') throw outcome.reason;
    return outcome.value;
  });
  for (const result of results) expect(result).toEqual(results[0]!);
  expect(await countAudits(f.candidate, 'goal_acceptance_repair')).toBe(1);
});

test('a failure after the writes rolls the whole repair back, and the same key can retry', async () => {
  const f = await incident();
  const hash = (await preview(f.goalId, f.candidate)).snapshot.hash;
  const input = inputFor(f, hash, 'fault');
  const surreal = database.db as unknown as { query: (sql: string, vars?: Record<string, unknown>) => unknown };
  const original = surreal.query.bind(database.db);
  // RETURN ends the transaction block early, so the injected failure must sit before it, after every write.
  surreal.query = (sql: string, vars?: Record<string, unknown>) => original(
    sql.includes('goal acceptance moved') && sql.includes('RETURN $result;')
      ? sql.replace('RETURN $result;', "THROW 'injected failure after writes';")
      : sql,
    vars);
  try {
    await expect(repair(input)).rejects.toBeInstanceOf(CompanyError);
  } finally {
    surreal.query = original;
  }
  expect(asId((await goalRow(f.goalId)).tasks.manual)).toBe(f.manual);
  expect(await countAudits(f.candidate, 'goal_acceptance_repair')).toBe(0);
  expect(await countAudits(f.manual, 'goal_acceptance_replaced')).toBe(0);
  expect(await countOutbox(f.candidate, 'goal_acceptance_repaired')).toBe(0);
  const retried = await repair(input);
  expect(retried.replacedTaskId).toBe(f.manual);
  expect(asId((await goalRow(f.goalId)).tasks.manual)).toBe(f.candidate);
});

test('the repaired goal closes only after every dependency is done and the candidate is accepted by another gm', async () => {
  const f = await incident();
  await repair(inputFor(f, (await preview(f.goalId, f.candidate)).snapshot.hash, 'close'));
  const followup = await core.createTask(gm, {
    title: `[后续] 真实登录补验 ${suffix}`, context: '夹具：修复后仍需完成的业务工作。',
    executorRole: 'qa', reviewerRole: 'gm', goalId: f.goalId, idempotencyKey: key('followup'),
  });
  await complete(eng, productWorker, f.d0);
  expect((await taskRow(f.d1)).state).toBe('ready');
  await complete(eng, qa, f.d1);
  expect((await taskRow(f.candidate)).state).toBe('blocked');
  await expect(core.claim(productWorker, f.candidate)).rejects.toBeInstanceOf(CompanyError);
  expect((await goalRow(f.goalId)).state).toBe('active');
  await complete(qa, gm2, followup.id);
  expect((await taskRow(f.candidate)).state).toBe('ready');
  await complete(productWorker, gm2, f.candidate);
  expect((await taskRow(f.candidate)).state).toBe('done');
  expect((await goalRow(f.goalId)).state).toBe('done');
  expect((await taskRow(f.manual)).state).toBe('void');
});
