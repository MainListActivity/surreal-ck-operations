import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordId } from 'surrealdb';
import { CompanyDatabase } from '../src/database.ts';
import { SurrealCompanyCore } from '../src/core.ts';
import { LocalEnrollmentAdmin } from '../src/enrollment.ts';
import { OutboundMessageStore } from '../src/outbound-messages.ts';
import { taskBrief } from '../src/dispatcher/brief.ts';
import { GoalGovernanceStore } from '../src/goal-store.ts';
import { ensureOwnerToken } from '../src/owner-token.ts';
import { OwnerDesk } from '../src/owner.ts';
import type { AcceptanceSourceAdapter, AcceptanceSourceInput, AcceptanceVerifyResult } from '../src/acceptance.ts';
import type { ClaimResult, TaskView } from '../src/contracts.ts';

setDefaultTimeout(120000);
// Isolated company fork on a private RocksDB store: the fake in role-message-flow.test.ts cannot show real query shapes.
const run = process.env.RUN_SCK_MESSAGE_FLOW_TESTS === '1' ? test : test.skip;
let dir: string, server: ReturnType<typeof Bun.spawn>, db: CompanyDatabase, core: SurrealCompanyCore, store: OutboundMessageStore, owner: string, count = 0;
let desk: OwnerDesk, eng: string, qa: string, storyAuthor: string, conceptDesign: string;
let checkedHead = '';
/** Deterministic CI source: a run URL resolves to a run whose head must be the submitted sha. */
class FakeAcceptanceAdapter implements AcceptanceSourceAdapter {
  runs = new Map<string, { headSha: string; conclusion: string; updatedAt: string }>();
  setRun(id: string, headSha: string) {
    this.runs.set(id, { headSha, conclusion: 'success', updatedAt: new Date(Date.now() + 60_000).toISOString() });
  }
  async verify(input: AcceptanceSourceInput): Promise<AcceptanceVerifyResult> {
    const runId = /\/actions\/runs\/(\d+)\/?$/.exec(input.runUrl)?.[1];
    const run = runId ? this.runs.get(runId) : undefined;
    if (!run) return { ok: false, reason: 'run not found' };
    if (run.headSha !== input.sha) return { ok: false, reason: 'head mismatch' };
    if (run.conclusion !== 'success') return { ok: false, reason: 'run not successful' };
    return {
      ok: true, sha: input.sha, at: run.updatedAt,
      ...(input.environment !== undefined ? { environment: input.environment } : {}),
      source: { provider: 'github-actions', runUrl: input.runUrl, runId,
        ...(input.environment !== undefined ? { environment: input.environment } : {}) },
    };
  }
}
const fake = new FakeAcceptanceAdapter();
let flowCore: SurrealCompanyCore;

beforeAll(async () => {
  if (process.env.RUN_SCK_MESSAGE_FLOW_TESTS !== '1') return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'sck-flow-')));
  const listener = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('fixture') });
  const port = listener.port!; listener.stop(true);
  server = Bun.spawn([join(homedir(), '.surrealdb/surreal'), 'start', '--bind', `127.0.0.1:${port}`, '--user', 'root', '--pass', 'fixture-only', '--log', 'error', `rocksdb:${dir}/db`], { stdout: 'ignore', stderr: 'ignore' });
  for (let n = 0; n < 200; n++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch {} await Bun.sleep(25); }
  db = new CompanyDatabase({ url: `ws://127.0.0.1:${port}/rpc`, rootUser: 'root', rootPassword: 'fixture-only', namespace: 'flow_fixture', database: 'control_plane' });
  await db.connect(); await db.bootstrap();
  core = new SurrealCompanyCore(db); store = new OutboundMessageStore(db.db);
  flowCore = new SurrealCompanyCore(db, { acceptance: { adapter: fake }, submitCheck: async () => ({ head: checkedHead }) });
  owner = ensureOwnerToken(dir);
  const enrollment = new LocalEnrollmentAdmin(db);
  await enrollment.ensureOwner(dir);
  eng = await enrollment.enroll('eng-a', 'engineering', ['execute', 'review']);
  qa = await enrollment.enroll('qa-a', 'qa', ['execute', 'review']);
  storyAuthor = await enrollment.enroll('story-a', 'story-author', ['execute', 'review']);
  conceptDesign = await enrollment.enroll('concept-design-a', 'concept-design', ['execute', 'review']);
  desk = new OwnerDesk(db);
  const storyDef = new RecordId('employee_def', 'story-track');
  await db.db.query(`CREATE $def CONTENT { role: 'story-author', provider: 'fixture', model: 'fixture', tracks: ['原著'], enabled: true };
    UPDATE $who SET def = $def;`, { def: storyDef, who: new RecordId('employee', 'story-a') });
  const gate = await flowCore.acceptanceGate(owner);
  if (!gate.enabled) {
    await flowCore.setAcceptanceGate(owner, { enabled: true, reason: 'SYS02 两段式软件线端到端取证', expectedVersion: gate.version, idempotencyKey: 'role-message-flow-gate' });
  }
});
afterAll(async () => { if (!dir) return; await db.close(); server.kill(); await server.exited; rmSync(dir, { recursive: true, force: true }); });

const newTask = () => core.createTask(owner, { title: `Flow task ${++count}`, context: 'fixture', executorRole: 'engineering', reviewerRole: 'qa', dependencies: [], idempotencyKey: `flow-${count}-${crypto.randomUUID()}` } as never);

run('edit, hold and send work on a real database, and a sent message stays locked', async () => {
  const task = await newTask();
  const [execute] = await store.createTaskDrafts(task.id, 'engineering', 'qa', true);
  expect((await store.edit(execute!.id, '改成这句', 'owner:test')).body).toBe('改成这句');
  expect((await store.setHold(execute!.id, true, 'owner:test')).state).toBe('held');
  expect(await store.prepareSend(task.id, 'execute', 'e1')).toBeNull();
  await store.setHold(execute!.id, false, 'owner:test');
  const prepared = await store.prepareSend(task.id, 'execute', 'e1');
  expect(prepared!.body).toBe('改成这句');
  await store.markSent(execute!.id, 'e1', prepared!.body);
  await expect(store.edit(execute!.id, '已发后不许改', 'owner:test')).rejects.toThrow('locked');
  await expect(store.setHold(execute!.id, true, 'owner:test')).rejects.toThrow('locked');
  const locked = (await store.list(task.id)).find(m => m.id === execute!.id)!;
  expect([locked.body, locked.state, locked.hold]).toEqual(['改成这句', 'sent', false]);
});

run('a re-dispatch of the same step repeats the owner-edited body', async () => {
  const task = await newTask();
  const [execute] = await store.createTaskDrafts(task.id, 'engineering', 'qa', true);
  await store.edit(execute!.id, '老板改过', 'owner:test');
  await store.prepareSend(task.id, 'execute', 'e1');
  expect((await store.prepareSend(task.id, 'execute', 'e2'))!.body).toBe('老板改过');
});

run('migration 051 replays cleanly, reroutes gm reviewer to product for qa, and converts gm executor to product with manager continuation', async () => {
  const sql = readFileSync(join(import.meta.dir, '..', 'schema/051-role-message-flow.surql'), 'utf8');
  await db.db.query(sql);
  const dep = await newTask();
  const gmTask = await newTask();
  const depId = new RecordId('task', dep.id);
  const gmId = new RecordId('task', gmTask.id);
  await db.db.query("UPDATE $t SET executor_role = 'gm', reviewer_role = 'qa', state = 'blocked', blocked_to = NONE, dependencies = [$dep];", { t: gmId, dep: depId });

  const qaTask = await newTask();
  const qaId = new RecordId('task', qaTask.id);
  await db.db.query("UPDATE $t SET executor_role = 'qa', reviewer_role = 'gm';", { t: qaId });

  await db.db.query(sql);
  const [rows] = await db.db.query<[Array<{ state: string; executor_role: string; dependency_continuation: string; blocked_to: unknown; version: number }>]>(
    'SELECT state, executor_role, dependency_continuation, blocked_to, version FROM $t;', { t: gmId });
  expect(rows[0]).toMatchObject({
    state: 'blocked',
    executor_role: 'product',
    dependency_continuation: 'manager',
    version: gmTask.version + 1,
  });
  expect(rows[0].blocked_to ?? null).toBeNull();
  expect(rows[0].state).not.toBe('void');

  const [audit] = await db.db.query<[unknown[]]>("SELECT action FROM audit WHERE task = $t AND action = 'gm_role_retired';", { t: gmId });
  expect(audit.length).toBe(1);

  await db.db.query("UPDATE $t SET state = 'done';", { t: depId });
  await new OwnerDesk(db).unlockDependents({ taskId: dep.id, source: 'owner:test' });

  const [unlockedRows] = await db.db.query<[Array<{ state: string; blocked_to: unknown }>]>(
    'SELECT state, blocked_to FROM $t;', { t: gmId });
  expect(unlockedRows[0].state).toBe('blocked');
  expect(unlockedRows[0].blocked_to).toBe('owner');

  const [qaRows] = await db.db.query<[Array<{ reviewer_role: string }>]>(
    'SELECT reviewer_role FROM $t;', { t: qaId });
  expect(qaRows[0].reviewer_role).toBe('product');
});

// ---- 两段式软件线 + 目标闭环（真实 fork，验收门开启） ----

interface FlowTaskRow {
  id: RecordId; kind: string; executor_role: string; reviewer_role: string;
  requirement?: string; acceptance_text?: string;
  work_intent?: { kind?: string; lane?: string };
  acceptance_criteria?: Array<{ id: string; kind: string; required: boolean }>;
}
const keyOf = () => `flow-e2e-${crypto.randomUUID()}`;
const proofOf = (c: ClaimResult | { task: TaskView; deliveryId: string; fence: number }, version = c.task.version) =>
  ({ taskId: c.task.id, deliveryId: c.deliveryId, fence: c.fence, expectedVersion: version });
const goalTasks = async (goalId: string): Promise<FlowTaskRow[]> => {
  const [rows] = await db.db.query<[FlowTaskRow[]]>(
    'SELECT id, kind, executor_role, reviewer_role, requirement, acceptance_text, work_intent, acceptance_criteria FROM task WHERE goal = $goal;',
    { goal: new RecordId('goal', goalId) });
  return rows ?? [];
};
const goalCard = async (goalId: string) => (await new GoalGovernanceStore(db.db).card(goalId))!;
const completedAudit = async (goalId: string) => {
  const [rows] = await db.db.query<[Array<{ action: string }>]>(
    "SELECT action FROM audit WHERE goal = $goal AND action = 'goal_completed';", { goal: new RecordId('goal', goalId) });
  return rows ?? [];
};
/** One software goal through the real two-step line: engineering implements/deploys/self-verifies, qa re-verifies. */
const runSoftwareLine = async (tier: 'quick' | 'standard', runId: string) => {
  const goal = await desk.createGoal({ text: `${tier} 软件目标：把导出功能发布到生产`, source: 'owner:test', key: keyOf(), pipeline: 'software', tier });
  expect((await desk.triage(goal.id, tier, 'test')).state).toBe('active');
  const [task] = await goalTasks(goal.id);
  expect(task).toBeDefined();
  const taskId = String(task!.id.id);
  // One task is the whole goal, and it is the goal's final gate.
  expect(task!.kind).toBe('deploy');
  expect(task!.executor_role).toBe('engineering');
  expect(task!.reviewer_role).toBe('qa');
  expect(task!.work_intent?.kind).toBe('code');
  expect(task!.work_intent?.lane).toMatch(/^delivery-[0-9a-f]{8}$/);
  expect(goal.tasks.acceptance).toBe(taskId);
  expect(goal.tasks.manual).toBe(taskId);
  // Dispatch criterion: the task's own required machine criterion, which the employee can record.
  const acId = await store.machineCriterionId(taskId);
  expect(acId).toBe('AC-BASE-DEPLOY-1');

  const claim = await flowCore.claim(eng, taskId);
  expect(claim.task.state).toBe('doing');
  const brief = taskBrief(claim);
  expect(brief).toContain('## 需求');
  expect(brief).toContain('## 验收标准');
  expect(brief).toContain(`${tier} 软件目标：把导出功能发布到生产`);

  const sha = `head-${tier}`;
  fake.setRun(runId, sha);
  const recorded = await flowCore.recordAcceptanceEvidence(eng, {
    taskId, acId, sha,
    source: { provider: 'github-actions', runUrl: `https://github.com/x/y/actions/runs/${runId}` },
    idempotencyKey: keyOf(),
  });
  expect(recorded).toMatchObject({ acId, sha, verified: true, kind: 'machine' });
  checkedHead = sha;
  const submitted = await flowCore.submit(eng, proofOf(claim), {
    text: '实现已合入并发布到生产，按验收标准逐条自验通过，提交 qa 复验。', acceptance: { sha }, idempotencyKey: keyOf(),
  });
  expect(submitted.state).toBe('review');

  const review = await flowCore.claim(qa, taskId);
  expect(review.task.state).toBe('review');
  const accepted = await flowCore.accept(qa, proofOf(review), {
    text: 'qa 已在生产按验收标准逐条复验，结果符合要求，接受交付。', idempotencyKey: keyOf(),
  });
  expect(accepted.state).toBe('done');
  const card = await goalCard(goal.id);
  expect(card.state).toBe('done');
  expect(card.repairReasons).toEqual([]);
  expect(await completedAudit(goal.id)).toHaveLength(1);
  return { goalId: goal.id, taskId };
};

run('two-step software line (quick): one deploy task, engineering self-verifies with CI evidence, qa accepts, goal done', async () => {
  await runSoftwareLine('quick', '101');
});

run('two-step software line (standard): the same one-task line closes the goal end-to-end', async () => {
  await runSoftwareLine('standard', '102');
});

run('qa return sends engineering back to a rework dispatch and the goal stays open', async () => {
  const goal = await desk.createGoal({ text: '返工路径：导出失败要能被 qa 退回', source: 'owner:test', key: keyOf(), pipeline: 'software', tier: 'quick' });
  const [task] = await goalTasks(goal.id);
  const taskId = String(task!.id.id);
  const claim = await flowCore.claim(eng, taskId);
  const sha = 'head-rework';
  fake.setRun('103', sha);
  await flowCore.recordAcceptanceEvidence(eng, {
    taskId, acId: 'AC-BASE-DEPLOY-1', sha,
    source: { provider: 'github-actions', runUrl: 'https://github.com/x/y/actions/runs/103' }, idempotencyKey: keyOf(),
  });
  checkedHead = sha;
  await flowCore.submit(eng, proofOf(claim), { text: '首轮实现已发布，提交 qa 生产复验，等待结论。', acceptance: { sha }, idempotencyKey: keyOf() });
  const review = await flowCore.claim(qa, taskId);
  const returned = await flowCore.returnTask(qa, proofOf(review), {
    text: '生产中导出报错，退回工程修复后重新发布复验。', idempotencyKey: keyOf(),
  });
  expect(returned.state).toBe('ready');
  // The same engineer can claim again, and the next dispatch step is rework.
  const again = await flowCore.claim(eng, taskId);
  expect(again.task.state).toBe('doing');
  expect(await store.nextStep(taskId)).toBe('rework');
  const draft = await store.ensureDraft(taskId, 'rework', 'engineering', true);
  expect(draft.step).toBe('rework');
  expect(draft.body).toContain('findings/round-NN.md');
  expect((await goalCard(goal.id)).state).not.toBe('done');
});

run('story goal: one story-author task on the 原著 track, qa accepts, goal done', async () => {
  const goal = await desk.createGoal({ text: '故事目标：写一篇关于灯塔的短篇故事', source: 'owner:test', key: keyOf(), pipeline: 'story' });
  expect((await desk.triage(goal.id, 'quick', 'test')).state).toBe('active');
  const [task] = await goalTasks(goal.id);
  expect(task).toMatchObject({ kind: 'task', executor_role: 'story-author', reviewer_role: 'qa' });
  const taskId = String(task!.id.id);
  const claim = await flowCore.claim(storyAuthor, taskId);
  expect(claim.task.discipline).toBe('原著');
  expect(claim.task.state).toBe('doing');
  const submitted = await flowCore.submit(storyAuthor, proofOf(claim), {
    text: '短篇故事初稿已完成，包含三个章节与结尾，提交 qa 复核。', idempotencyKey: keyOf(),
  });
  expect(submitted.state).toBe('review');
  const review = await flowCore.claim(qa, taskId);
  const accepted = await flowCore.accept(qa, proofOf(review), { text: '故事结构与文字已复核，章节完整，接受本次交付。', idempotencyKey: keyOf() });
  expect(accepted.state).toBe('done');
  const card = await goalCard(goal.id);
  expect(card.state).toBe('done');
  expect(card.repairReasons).toEqual([]);
});

run('video goal: one concept-design task approved by the owner closes the goal', async () => {
  const goal = await desk.createGoal({ text: '视频目标：做一支 30 秒的概念短片', source: 'owner:test', key: keyOf(), pipeline: 'video' });
  expect((await desk.triage(goal.id, 'quick', 'test')).state).toBe('active');
  const [task] = await goalTasks(goal.id);
  expect(task).toMatchObject({ kind: 'task', executor_role: 'concept-design', reviewer_role: 'owner' });
  const taskId = String(task!.id.id);
  const claim = await flowCore.claim(conceptDesign, taskId);
  expect(claim.task.state).toBe('doing');
  const submitted = await flowCore.submit(conceptDesign, proofOf(claim), {
    text: '30 秒概念短片已交付：分镜、关键帧与剪辑版本齐备，提交老板验收。', idempotencyKey: keyOf(),
  });
  expect(submitted.state).toBe('review');
  const decided = await desk.decide({ taskId, decision: 'approve', note: 'ok', source: 'owner:test', key: keyOf() });
  expect(decided.state).toBe('done');
  const card = await goalCard(goal.id);
  expect(card.state).toBe('done');
  expect(card.repairReasons).toEqual([]);
  expect(await completedAudit(goal.id)).toHaveLength(1);
});
