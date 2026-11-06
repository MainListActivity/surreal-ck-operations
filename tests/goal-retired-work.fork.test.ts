/**
 * Owner disposition of retired goal work (goal_retired_work_resolved).
 *
 * A goal whose outcome contract requires `implementation` can be parked in needs_repair forever by one retired
 * task even when a replacement chain already finished. The owner-only disposition is the authorized exit, and
 * the console discovery view must list exactly the work that still needs it. These tests run on the company fork.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordId } from 'surrealdb';
import { loadDatabaseConfig } from '../src/config.ts';
import { CompanyDatabase } from '../src/database.ts';
import { GoalGovernanceStore } from '../src/goal-store.ts';

const NS = 'sck_agent_company_test_goal_retired_work';
const database = new CompanyDatabase({ ...loadDatabaseConfig(), namespace: NS, database: 'control_plane' });
setDefaultTimeout(300_000);
const credDir = mkdtempSync(join(tmpdir(), 'sck-goal-retired-work-'));
let store: GoalGovernanceStore;
let seq = 0;
const taskId = (label: string) => `${label}-${++seq}`;

beforeAll(async () => {
  await database.connect();
  await database.db.query(`DEFINE NAMESPACE IF NOT EXISTS ${NS};`);
  await database.db.use({ namespace: NS });
  await database.db.query('REMOVE DATABASE IF EXISTS control_plane;');
  await database.bootstrap();
  store = new GoalGovernanceStore(database.db);
});

afterAll(async () => {
  rmSync(credDir, { recursive: true, force: true });
  await database.close();
});

beforeEach(async () => {
  await database.db.query('DELETE goal_evidence; DELETE goal_outcome; DELETE task_wait; DELETE fault_episode; DELETE goal;');
});

async function makeTask(goal: string | undefined, label: string, over: Record<string, unknown> = {}): Promise<string> {
  const id = taskId(label);
  await database.db.query('CREATE ONLY $t CONTENT $row;', { t: new RecordId('task', id), row: {
    title: label, context: '目标历史任务处置夹具', state: 'done', kind: 'task',
    executor_role: 'engineering', reviewer_role: 'qa', dependencies: [],
    ...(goal ? { goal: new RecordId('goal', goal) } : {}),
    version: 1, fence: 0, created_at: new Date(Date.now() - 5 * 86_400_000), ...over,
  } });
  return id;
}

async function seedGoal(id: string, over: Record<string, unknown> = {}): Promise<{ goalId: string; gateId: string }> {
  const manualId = await makeTask(id, '运营验收', { executor_role: 'product', reviewer_role: 'owner' });
  const gateId = await makeTask(id, 'G3 老板最终验收', {
    executor_role: 'owner', reviewer_role: 'owner', kind: 'gate', state: 'done', accepted_by: 'owner',
  });
  await database.db.query('CREATE ONLY $g CONTENT $row;', { g: new RecordId('goal', id), row: {
    title: `目标 ${id}`, brief: '夹具', state: over.state ?? 'active', tier: 'standard', pipeline: 'software',
    created_at: new Date(Date.now() - 5 * 86_400_000),
    tasks: { manual: new RecordId('task', manualId), acceptance: new RecordId('task', gateId) },
    anchors: [new RecordId('task', manualId), new RecordId('task', gateId)], version: 0,
  } });
  await database.db.query(`CREATE ONLY $o CONTENT {
    goal: $goal, expected: '交付并验证预期客户结果', required_evidence: $required, responsible_role: 'owner',
    version: 1, source: 'test', actor: 'test', reason: '夹具成果契约', created_at: time::now(), updated_at: time::now()
  };`, { o: new RecordId('goal_outcome', id), goal: new RecordId('goal', id),
    required: over.required ?? ['implementation', 'owner_final'] });
  return { goalId: id, gateId };
}

async function goalVersion(goalId: string): Promise<number> {
  const [row] = await database.db.query<[Array<{ version?: number }>]>('SELECT version FROM ONLY $g;', { g: new RecordId('goal', goalId) });
  return row?.[0]?.version ?? 0;
}

describe('owner disposition of retired goal work', () => {
  test('a same-goal completed replacement settles the implementation evidence and closes the goal', async () => {
    const { goalId } = await seedGoal('rw-replaced');
    const oldId = await makeTask(goalId, '旧实现链', { state: 'void', version: 2 });
    const newId = await makeTask(goalId, '替代实现', {});
    await database.db.query("CREATE audit CONTENT { task: $t, actor: $a, action: 'retire', evidence: '重复链，替代任务已建', version: 2, at: time::now() };",
      { t: new RecordId('task', oldId), a: new RecordId('employee', 'gm-test') });

    const pending = await store.retiredWorkPending(goalId);
    expect(pending.items.map(item => item.taskId)).toEqual([oldId]);
    expect(pending.items[0]!.candidates.map(candidate => candidate.taskId)).toEqual([newId]);

    const before = await store.card(goalId);
    expect(before!.needsRepair).toBe(true);
    expect(before!.repairReasons.map(reason => reason.code)).toContain('implementation_void');
    expect(before!.outcome.missing).toContain('implementation');

    const done = await store.resolveRetiredWork({
      goalId, taskId: oldId, goalVersion: await goalVersion(goalId), taskVersion: 2,
      disposition: 'replaced', replacementTaskIds: [newId], reason: '替代实现已完成并验收，原链重复作废', actor: 'owner:test', key: 'rw-replaced-1',
    });
    expect(done.state).toBe('done');

    const after = await store.card(goalId);
    expect(after!.state).toBe('done');
    expect(after!.needsRepair).toBe(false);
    expect(after!.outcome.complete).toBe(true);
    expect(after!.repairReasons.map(reason => reason.code)).not.toContain('implementation_void');
    // The disposition is idempotent by key and the pending view no longer lists the settled task.
    expect((await store.retiredWorkPending(goalId)).items).toEqual([]);
  });

  test('a completed replacement outside the goal is accepted: the owner verifies it', async () => {
    const { goalId } = await seedGoal('rw-outside-goal');
    await seedGoal('rw-other-goal');
    const oldId = await makeTask(goalId, '旧实现链', { state: 'void', version: 2 });
    const foreignId = await makeTask('rw-other-goal', '别目标的实现', {});

    // The console prefill only suggests same-goal work, but the owner may legitimately point at completed
    // work delivered elsewhere; the audited owner decision is the authorization, not the goal binding.
    const pending = await store.retiredWorkPending(goalId);
    expect(pending.items[0]!.candidates).toEqual([]);
    const done = await store.resolveRetiredWork({
      goalId, taskId: oldId, goalVersion: await goalVersion(goalId), taskVersion: 2,
      disposition: 'replaced', replacementTaskIds: [foreignId], reason: '替代实现已在其他目标完成并验收', actor: 'owner:test', key: 'rw-outside-1',
    });
    expect(done.state).toBe('done');
    expect((await store.card(goalId))!.repairReasons.map(reason => reason.code)).not.toContain('implementation_void');
  });

  test('a fixture disposition settles retired work without a replacement', async () => {
    const { goalId } = await seedGoal('rw-fixture');
    const oldId = await makeTask(goalId, 'QA 负例夹具', { state: 'void', version: 3 });

    const done = await store.resolveRetiredWork({
      goalId, taskId: oldId, goalVersion: await goalVersion(goalId), taskVersion: 3,
      disposition: 'fixture', replacementTaskIds: [], reason: '夹具仅用于绑定负例探针，不是产品交付', actor: 'owner:test', key: 'rw-fixture-1',
    });
    expect(done.state).toBe('done');
    const card = await store.card(goalId);
    expect(card!.repairReasons.map(reason => reason.code)).not.toContain('implementation_void');
    expect((await store.retiredWorkPending(goalId)).items).toEqual([]);
  });

  test('the owner console exposes the pending retired work and keeps the route token-bound', async () => {
    const { goalId } = await seedGoal('rw-console');
    const oldId = await makeTask(goalId, '待处置历史任务', { state: 'void', version: 2 });
    const { createConsoleFetch, consoleUrl } = await import('../plugin/server/console.ts');
    const home = mkdtempSync(join(tmpdir(), 'sck-console-'));
    const fetch = createConsoleFetch({ home, lanBase: () => 'http://127.0.0.1:1',
      company: async () => ({ db: { db: database.db } }) as never });
    const base = consoleUrl(home, () => 'http://127.0.0.1:1');
    const res = await fetch(new Request(`${base}/api/goal-retired-pending?goalId=${goalId}`));
    expect(res.status).toBe(200);
    const body = await res.json() as { goalId: string; goalVersion: number; items: Array<{ taskId: string }> };
    expect(body.goalId).toBe(goalId);
    expect(body.items.map(item => item.taskId)).toEqual([oldId]);
    const wrongToken = await fetch(new Request(`http://127.0.0.1:1/o/wrong/api/goal-retired-pending?goalId=${goalId}`));
    expect(wrongToken.status).toBe(404);
    rmSync(home, { recursive: true, force: true });
  });
});
