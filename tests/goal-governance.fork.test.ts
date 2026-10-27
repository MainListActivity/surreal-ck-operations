/**
 * SYS07 AC05 · goal governance on the real core and the company fork.
 *
 * The fixture seeds known results: a void final gate, a done owner gate without a customer receipt, a manager
 * accept on an owner gate, a repairable final-gate reference, and an accepted task with token usage but no
 * provider billing. Every assertion compares the API output with the source rows; historical owner decisions
 * and task rows are never rewritten.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordId } from 'surrealdb';
import { loadDatabaseConfig } from '../src/config.ts';
import { CompanyDatabase } from '../src/database.ts';
import { SurrealCompanyCore } from '../src/core.ts';
import { CompanyError } from '../src/core-errors.ts';
import { LocalEnrollmentAdmin } from '../src/enrollment.ts';
import { OwnerDesk } from '../src/owner.ts';

const NS = 'sck_agent_company_test_goal_sys07';
const database = new CompanyDatabase({ ...loadDatabaseConfig(), namespace: NS, database: 'control_plane' });
setDefaultTimeout(300_000);
const credDir = mkdtempSync(join(tmpdir(), 'sck-goal-sys07-'));
const tokens: Record<string, string> = {};
const core = new SurrealCompanyCore(database);

beforeAll(async () => {
  await database.connect();
  await database.db.query(`DEFINE NAMESPACE IF NOT EXISTS ${NS};`);
  await database.db.use({ namespace: NS });
  await database.db.query('REMOVE DATABASE IF EXISTS control_plane;');
  await database.bootstrap();
  const enrollment = new LocalEnrollmentAdmin(database);
  for (const [name, role, caps] of [
    ['gm', 'gm', ['execute', 'review', 'manage']],
    ['product', 'product', ['execute', 'review', 'manage']],
    ['eng', 'engineering', ['execute', 'review']],
  ] as const) tokens[name] = await enrollment.enroll(`w-${name}`, role, caps);
});

afterAll(async () => { rmSync(credDir, { recursive: true, force: true }); });

beforeEach(async () => {
  // Tasks are left in place: deleting them fires the model-evaluation reopen event on a NONE row. Goals are
  // deleted, so their orphan tasks are invisible to every goal query; metric reads only use current goal task ids.
  await database.db.query('DELETE goal_evidence; DELETE goal_outcome; DELETE task_wait; DELETE fault_episode; DELETE goal;');
});

let seq = 0;
const iso = (ms: number) => new Date(ms).toISOString();
const taskId = (label: string) => `${label}-${++seq}`;

async function makeTask(goal: string, label: string, over: Record<string, unknown> = {}): Promise<string> {
  const id = taskId(label);
  const row = {
    title: label, context: 'SYS07 目标终验测试夹具', state: 'done', kind: 'task',
    executor_role: 'engineering', reviewer_role: 'qa', dependencies: [], goal: new RecordId('goal', goal),
    version: 1, fence: 0, created_at: new Date(Date.now() - 5 * 86_400_000), ...over,
  };
  await database.db.query('CREATE ONLY $t CONTENT $row;', { t: new RecordId('task', id), row });
  return id;
}

async function seedGoal(input: {
  id: string; tier?: string; state?: string; finalState?: string; acceptedBy?: string; reviewerRole?: string;
  outcomeRequired?: string[]; outcome?: boolean; deadline?: string; doneAt?: string; createdAt?: string;
}): Promise<{ goalId: string; manualId: string; gateId: string }> {
  const goalId = input.id;
  const manualId = await makeTask(goalId, '运营验收', { executor_role: 'product', reviewer_role: 'gm', kind: 'task' });
  const gateId = await makeTask(goalId, 'G3 老板最终验收', {
    executor_role: 'gm', reviewer_role: input.reviewerRole ?? 'owner', kind: 'gate',
    state: input.finalState ?? 'done', ...(input.acceptedBy ? { accepted_by: input.acceptedBy } : {}),
  });
  const goalRow = {
    title: `目标 ${goalId}`, brief: 'SYS07 目标夹具', state: input.state ?? 'active', tier: input.tier ?? 'standard',
    pipeline: 'software', created_at: input.createdAt ? new Date(input.createdAt) : new Date(Date.now() - 5 * 86_400_000),
    tasks: { manual: new RecordId('task', manualId), acceptance: new RecordId('task', gateId) },
    anchors: [new RecordId('task', manualId), new RecordId('task', gateId)],
    version: 0,
    ...(input.doneAt ? { done_at: new Date(input.doneAt) } : {}),
    ...(input.deadline ? { deadline: new Date(input.deadline) } : {}),
  };
  await database.db.query('CREATE ONLY $g CONTENT $row;', { g: new RecordId('goal', goalId), row: goalRow });
  if (input.outcome !== false) {
    await database.db.query(`CREATE ONLY $o CONTENT {
      goal: $goal, expected: '交付并验证预期客户结果', required_evidence: $required, responsible_role: 'gm',
      version: 1, source: 'test', actor: 'test', reason: 'SYS07 夹具成果契约', created_at: time::now(), updated_at: time::now()
    };`, { o: new RecordId('goal_outcome', goalId), goal: new RecordId('goal', goalId),
      required: input.outcomeRequired ?? [] });
  }
  return { goalId, manualId, gateId };
}

async function expectRefused(promise: Promise<unknown>, code: CompanyError['code'], pattern: RegExp) {
  const error = await promise.then(() => undefined, (reason: unknown) => reason);
  expect(error).toBeInstanceOf(CompanyError);
  expect((error as CompanyError).code).toBe(code);
  expect((error as CompanyError).message).toMatch(pattern);
}

describe('goal console, scan and permissions (AC01/AC03/AC05)', () => {
  test('the console pages deterministically, exposes blockers and deadlines, and rejects non-gm readers', async () => {
    const first = await seedGoal({ id: 'page-1', finalState: 'review', acceptedBy: undefined });
    const second = await seedGoal({ id: 'page-2', deadline: new Date(Date.now() + 86_400_000).toISOString() });
    const third = await seedGoal({ id: 'page-3', finalState: 'void', acceptedBy: undefined });
    await expectRefused(core.goalConsole(tokens.eng!, { pageSize: 1 }), 'forbidden', /经理|Capability denied/);
    const page1 = await core.goalConsole(tokens.gm!, { pageSize: 1 });
    expect(page1.page).toMatchObject({ pageSize: 1, returned: 1, hasMore: true, total: 3 });
    // A goal created between pages belongs to a later listing; the pinned snapshot must not shift or duplicate it.
    const later = await seedGoal({ id: 'page-later', createdAt: new Date(Date.now() + 60_000).toISOString() });
    const page2 = await core.goalConsole(tokens.gm!, { pageSize: 1, cursor: page1.page.nextCursor });
    const page3 = await core.goalConsole(tokens.gm!, { pageSize: 1, cursor: page2.page.nextCursor });
    const ids = [...page1.goals, ...page2.goals, ...page3.goals].map(card => card.goalId);
    expect(new Set(ids).size).toBe(3);
    expect(page3.page.hasMore).toBe(false);
    expect(page2.page.total).toBe(3);
    expect([...page1.goals, ...page2.goals, ...page3.goals].some(card => card.goalId === later.goalId)).toBe(false);
    const voided = [...page1.goals, ...page2.goals, ...page3.goals].find(card => card.goalId === third.goalId)!;
    expect(voided.needsRepair).toBe(true);
    expect(voided.repairReasons.map(reason => reason.code)).toContain('final_gate_void');
    const dated = [...page1.goals, ...page2.goals, ...page3.goals].find(card => card.goalId === second.goalId)!;
    expect(dated.deadline).toMatchObject({ status: 'exact', source: 'goal' });
    expect(first.goalId).toBe('page-1');
  });

  test('the company brief and the goal console read the same card facts', async () => {
    const { goalId } = await seedGoal({ id: 'brief-1', finalState: 'void', acceptedBy: undefined, deadline: new Date(Date.now() + 3_600_000).toISOString() });
    // The owner console/daily brief carries goalCards; the MCP company block deliberately does not, so that a
    // handful of goals cannot break the bounded company response. Both read the same GoalGovernanceStore cards.
    const brief = await new OwnerDesk(database).brief();
    const fromBrief = brief.goalCards?.find(card => card.goalId === goalId);
    const fromConsole = (await core.goalConsole(tokens.gm!, { goalId })).goals[0];
    expect(fromBrief).toBeTruthy();
    expect(fromBrief).toMatchObject({
      goalId: fromConsole!.goalId, needsRepair: fromConsole!.needsRepair,
      deadline: fromConsole!.deadline, finalGate: fromConsole!.finalGate,
    });
    expect(fromBrief!.blockers.map(blocker => blocker.taskId)).toEqual(fromConsole!.blockers.map(blocker => blocker.taskId));
  });

  test('the dry-run scan never writes a goal version or an audit row', async () => {
    await seedGoal({ id: 'scan-1', finalState: 'void', acceptedBy: undefined });
    const before = await database.db.query<[Array<{ version: number }>]>('SELECT version FROM goal;');
    const [auditsBefore] = await database.db.query<[Array<{ n: number }>]>('SELECT count() AS n FROM audit GROUP ALL;');
    const scan = await core.goalGovernanceScan(tokens.gm!);
    expect(scan.dryRun).toBe(true);
    expect(scan.counts.needsRepair).toBeGreaterThanOrEqual(1);
    const after = await database.db.query<[Array<{ version: number }>]>('SELECT version FROM goal;');
    const [auditsAfter] = await database.db.query<[Array<{ n: number }>]>('SELECT count() AS n FROM audit GROUP ALL;');
    expect(after[0]).toEqual(before[0]);
    expect(auditsAfter?.[0]?.n ?? 0).toBe(auditsBefore?.[0]?.n ?? 0);
  });
});

describe('RB01 rollback isolation drill (new writes -> previous release)', () => {
  test('a needs_repair goal is inert to the previous release: no close, no lease change, no misdispatch', async () => {
    const { goalId, gateId } = await seedGoal({ id: 'rb01-1', outcomeRequired: ['customer_activation'], acceptedBy: 'owner' });
    const readyId = await makeTask(goalId, '旧版可领取任务', { state: 'ready', executor_role: 'engineering' });
    await database.db.query(`CREATE audit CONTENT { task: $task, actor: 'owner:relay', action: 'owner_approve',
      evidence: '老板原话：先验收，客户激活回执后完成', at: time::now() };`, { task: new RecordId('task', gateId) });
    const pending = await core.goalFinalize(tokens.gm!, { goalId });
    expect(pending.state).toBe('needs_repair');
    // New release writes the receipt while the goal is parked for repair.
    await core.goalEvidenceRecord(tokens.gm!, {
      goalId, kind: 'customer_activation', summary: '客户邮件确认激活', source: 'mail:customer-rb01',
      confirmedBy: '客户李四', evidenceType: 'external_receipt', reason: 'RB01 演练：新版写入客户回执',
      idempotencyKey: 'rb01-receipt',
    });
    const goal = new RecordId('goal', goalId);
    const taskFields = 'id, state, version, current_employee, wait_state, dependencies';
    const [goalBefore] = await database.db.query<[Array<Record<string, unknown>>]>(
      'SELECT state, version, needs_repair, needs_repair_reason FROM goal WHERE id = $goal;', { goal });
    const [tasksBefore] = await database.db.query<[Array<Record<string, unknown>>]>(
      `SELECT ${taskFields} FROM task WHERE goal = $goal ORDER BY id;`, { goal });
    const [newOutcomes] = await database.db.query<[Array<{ n: number }>]>(
      'SELECT count() AS n FROM goal_outcome WHERE goal = $goal GROUP ALL;', { goal });
    const [newEvidence] = await database.db.query<[Array<{ n: number }>]>(
      'SELECT count() AS n FROM goal_evidence WHERE goal = $goal GROUP ALL;', { goal });
    expect(newOutcomes?.[0]?.n).toBe(1);
    expect(newEvidence?.[0]?.n).toBe(1);
    expect(goalBefore?.[0]?.state).toBe('needs_repair');

    // Previous release projection: only task/goal fields it knew. New tables and fields are invisible.
    const [oldRead] = await database.db.query<[Array<Record<string, unknown>>]>(
      `SELECT id, state, version, goal.state AS goal_state FROM task WHERE goal = $goal ORDER BY id;`, { goal });
    for (const row of oldRead ?? []) {
      expect(new Set(Object.keys(row))).toEqual(new Set(['id', 'state', 'version', 'goal_state']));
      expect(row.goal_state).toBe('needs_repair');
    }
    expect(oldRead?.some(row => String(row.id).includes(readyId))).toBe(true);

    // Previous release's goal-close statement is active-only, so it cannot complete the parked goal.
    await database.db.query("UPDATE goal SET state = 'done', done_at = time::now() WHERE state = 'active' AND tasks.acceptance = $gate;",
      { gate: new RecordId('task', gateId) });
    const [goalAfter] = await database.db.query<[Array<Record<string, unknown>>]>(
      'SELECT state, version, needs_repair, needs_repair_reason FROM goal WHERE id = $goal;', { goal });
    expect(goalAfter).toEqual(goalBefore);
    expect(goalAfter?.[0]?.state).not.toBe('active');

    // Two previous-release dispatch scans see the same open set; neither mutates a task or takes a lease, so
    // the parked goal produces zero misdispatches (the old acceptance guard rejects the non-active goal).
    const dispatchSql = "SELECT id FROM task WHERE goal = $goal AND state IN ['ready', 'review'] AND wait_state != 'waiting' ORDER BY id;";
    const [roundOne] = await database.db.query<[Array<{ id: RecordId }>]>(dispatchSql, { goal });
    const [roundTwo] = await database.db.query<[Array<{ id: RecordId }>]>(dispatchSql, { goal });
    expect(roundTwo?.map(row => String(row.id))).toEqual(roundOne?.map(row => String(row.id)));
    expect(roundTwo?.map(row => String(row.id)).filter(id => id.includes(readyId))).toHaveLength(1);
    const [tasksAfter] = await database.db.query<[Array<Record<string, unknown>>]>(
      `SELECT ${taskFields} FROM task WHERE goal = $goal ORDER BY id;`, { goal });
    expect(tasksAfter).toEqual(tasksBefore);

    // Forward release then observes the same goal; the open task was not consumed by the old scans, so the
    // fixture retires it before completion. Completion itself still needs the recorded receipt.
    await database.db.query("UPDATE ONLY $task SET state = 'void', version += 1;", { task: new RecordId('task', readyId) });
    const done = await core.goalFinalize(tokens.gm!, { goalId });
    expect(done.state).toBe('done');
    expect(done.goalComplete).toBe(true);
    const gate = await database.db.select<Record<string, unknown>>(new RecordId('task', gateId));
    expect(gate?.accepted_by).toBe('owner');
  });
});

describe('default outcome contract at triage (AC02)', () => {
  test('a newly triaged goal starts with a structured outcome, required evidence and a responsible role', async () => {
    const goal = await core.relayGoal(tokens.gm!, {
      text: '把一个内部小改动交付上线', ownerQuote: '老板说：把这个小改动做完上线',
      idempotencyKey: `triage-default-${++seq}`,
    });
    await core.triageGoal(tokens.gm!, { goalId: goal.id, tier: 'quick', reason: 'SYS07 回归：triage 默认成果契约' });
    const outcome = await database.db.select<Record<string, unknown>>(new RecordId('goal_outcome', goal.id));
    expect(outcome).toBeTruthy();
    expect(String(outcome?.expected)).toContain('内部小改动');
    expect(outcome?.responsible_role).toBe('gm');
    expect(outcome?.required_evidence).toEqual(['implementation', 'final_acceptance']);
    expect(outcome?.version).toBe(1);
  });
});

describe('final-gate completion and evidence (AC01/AC02/AC05)', () => {
  test('a void final gate becomes needs_repair and never closes the goal', async () => {
    const { goalId, gateId } = await seedGoal({ id: 'void-1', finalState: 'void', acceptedBy: undefined });
    const before = await database.db.select<Record<string, unknown>>(new RecordId('task', gateId));
    const card = await core.goalFinalize(tokens.gm!, { goalId });
    expect(card.state).toBe('needs_repair');
    expect(card.goalComplete).toBe(false);
    expect(card.needsRepair).toBe(true);
    expect(card.repairReasons.map(reason => reason.code)).toContain('final_gate_void');
    const after = await database.db.select<Record<string, unknown>>(new RecordId('task', gateId));
    expect(after).toEqual(before);
    const row = await database.db.select<Record<string, unknown>>(new RecordId('goal', goalId));
    expect(row).toMatchObject({ state: 'needs_repair', needs_repair: true });
    expect(String(row?.needs_repair_reason)).toContain('作废');
  });

  test('a done owner gate still needs a real customer receipt; a test account cannot supply it', async () => {
    const { goalId, gateId } = await seedGoal({ id: 'customer-1', outcomeRequired: ['customer_activation'], acceptedBy: 'owner' });
    await database.db.query(`CREATE audit CONTENT { task: $task, actor: 'owner:relay', action: 'owner_approve', evidence: '老板原话：同意上线', at: time::now() };`,
      { task: new RecordId('task', gateId) });
    const [ownerAuditsBefore] = await database.db.query<[Array<{ n: number }>]>(
      "SELECT count() AS n FROM audit WHERE task = $task AND action = 'owner_approve' GROUP ALL;", { task: new RecordId('task', gateId) });
    const pending = await core.goalFinalize(tokens.gm!, { goalId });
    expect(pending.state).toBe('needs_repair');
    expect(pending.outcome.missing).toContain('customer_activation');
    expect(pending.needsRepair).toBe(true);
    await expectRefused(core.goalEvidenceRecord(tokens.gm!, {
      goalId, kind: 'customer_activation', summary: '客户已激活', source: 'test@example.com', confirmedBy: '客户张三',
      evidenceType: 'external_receipt', reason: 'SYS07 回归：测试账号不能冒充真实客户回执', idempotencyKey: 'test-receipt-1',
    }), 'invalid', /测试账号/);
    const recorded = await core.goalEvidenceRecord(tokens.gm!, {
      goalId, kind: 'customer_activation', summary: '客户邮件确认已激活并开始使用', source: 'mail:customer-42',
      confirmedBy: '客户张三', evidenceType: 'external_receipt', at: iso(Date.now() - 60_000),
      reason: 'SYS07 回归：记录真实客户激活回执，不代填', idempotencyKey: 'real-receipt-1',
    });
    expect(recorded.kind).toBe('customer_activation');
    const done = await core.goalFinalize(tokens.gm!, { goalId });
    expect(done.state).toBe('done');
    expect(done.goalComplete).toBe(true);
    const [ownerAuditsAfter] = await database.db.query<[Array<{ n: number }>]>(
      "SELECT count() AS n FROM audit WHERE task = $task AND action = 'owner_approve' GROUP ALL;", { task: new RecordId('task', gateId) });
    expect(ownerAuditsAfter?.[0]?.n).toBe(ownerAuditsBefore?.[0]?.n);
    const gate = await database.db.select<Record<string, unknown>>(new RecordId('task', gateId));
    expect(gate?.accepted_by).toBe('owner');
  });

  test('an owner gate accepted by a manager is refused as an owner approval', async () => {
    const { goalId } = await seedGoal({ id: 'owner-fake', acceptedBy: 'gm-1' });
    const card = await core.goalFinalize(tokens.gm!, { goalId });
    expect(card.state).toBe('needs_repair');
    expect(card.needsRepair).toBe(true);
    expect(card.repairReasons.map(reason => reason.code)).toContain('owner_approval_missing');
  });

  test('outcome registration is version-locked and a scope change needs the current version', async () => {
    await seedGoal({ id: 'version-1', outcome: false });
    const first = await core.goalOutcomeRegister(tokens.gm!, {
      goalId: 'version-1', expectedVersion: 0, expected: '交付客户可采纳的结果',
      requiredEvidence: ['customer_activation'], responsibleRole: 'gm', reason: 'SYS07 回归：登记成果契约',
      idempotencyKey: 'outcome-v1',
    });
    expect(first.version).toBe(1);
    await expectRefused(core.goalOutcomeRegister(tokens.gm!, {
      goalId: 'version-1', expectedVersion: 0, expected: '重复登记', requiredEvidence: [], responsibleRole: 'gm',
      reason: 'SYS07 回归：旧版本必须被拒绝', idempotencyKey: 'outcome-stale',
    }), 'conflict', /already registered|version moved/);
    const second = await core.goalOutcomeRegister(tokens.gm!, {
      goalId: 'version-1', expectedVersion: 1, expected: '交付客户可采纳并可回访的结果',
      requiredEvidence: ['customer_activation', 'customer_adoption'], responsibleRole: 'gm',
      reason: 'SYS07 回归：授权补充客户采纳证据', idempotencyKey: 'outcome-v2',
    });
    expect(second.version).toBe(2);
  });

  test('two concurrent scope changes at the same version: exactly one wins', async () => {
    await seedGoal({ id: 'concurrent-outcome-1', outcome: false });
    const first = await core.goalOutcomeRegister(tokens.gm!, {
      goalId: 'concurrent-outcome-1', expectedVersion: 0, expected: '先登记一个客户可采纳的结果',
      requiredEvidence: ['customer_activation'], responsibleRole: 'gm', reason: 'SYS07 回归：并发 CAS 的基线契约',
      idempotencyKey: 'outcome-concurrent-base',
    });
    expect(first.version).toBe(1);
    const results = await Promise.allSettled([
      core.goalOutcomeRegister(tokens.gm!, {
        goalId: 'concurrent-outcome-1', expectedVersion: 1, expected: '并发方案 A：客户激活后完成',
        requiredEvidence: ['customer_activation'], responsibleRole: 'gm', reason: 'SYS07 回归：并发方案 A 的授权变更',
        idempotencyKey: 'outcome-concurrent-a',
      }),
      core.goalOutcomeRegister(tokens.gm!, {
        goalId: 'concurrent-outcome-1', expectedVersion: 1, expected: '并发方案 B：客户采纳后完成',
        requiredEvidence: ['customer_adoption'], responsibleRole: 'gm', reason: 'SYS07 回归：并发方案 B 的授权变更',
        idempotencyKey: 'outcome-concurrent-b',
      }),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')!;
    expect((rejected.reason as CompanyError).code).toBe('conflict');
    const row = await database.db.select<Record<string, unknown>>(new RecordId('goal_outcome', 'concurrent-outcome-1'));
    expect(row?.version).toBe(2);
  });
});

describe('final-gate repair (AC01)', () => {
  test('a void gate is repaired by a CAS reference change, preserving the void task and audit', async () => {
    const { goalId, gateId } = await seedGoal({ id: 'repair-1', finalState: 'void', acceptedBy: undefined });
    const work = await makeTask(goalId, '未完成补证', { state: 'ready', kind: 'task' });
    const candidate = await makeTask(goalId, '新的 G3 终验', {
      state: 'blocked', kind: 'gate', executor_role: 'gm', reviewer_role: 'owner', dependencies: [new RecordId('task', work)],
    });
    const preview = await core.goalFinalGatePreview(tokens.gm!, { goalId, candidateTaskId: candidate });
    expect(preview.ready).toBe(true);
    expect(preview.currentFinalGate).toMatchObject({ taskId: gateId, voided: true });
    expect(preview.candidate).toMatchObject({ taskId: candidate, reviewerRole: 'owner' });
    const repaired = await core.goalFinalGateRepair(tokens.gm!, {
      goalId, candidateTaskId: candidate, expectedOldTaskId: gateId, expectedGoalVersion: 0,
      snapshotHash: preview.snapshot.hash, reason: 'SYS07 回归：终验关口被误作废，改由覆盖全部未完成工作的新关口接替',
      idempotencyKey: 'repair-final-1',
    });
    expect(repaired).toMatchObject({ goalId, oldTaskId: gateId, newTaskId: candidate, goalVersion: 1 });
    const goal = await database.db.select<Record<string, unknown>>(new RecordId('goal', goalId));
    expect(String((goal?.tasks as Record<string, unknown>).acceptance)).toContain(candidate);
    // Repair moves the reference but does not declare the goal healthy: the new gate still has to be accepted and
    // the old release must not see an active goal it could close in the meantime.
    expect(goal?.state).toBe('needs_repair');
    expect(goal?.needs_repair).toBe(true);
    const old = await database.db.select<Record<string, unknown>>(new RecordId('task', gateId));
    expect(old?.state).toBe('void');
    const [audits] = await database.db.query<[Array<{ n: number }>]>(
      "SELECT count() AS n FROM audit WHERE action = 'goal_final_gate_repair' GROUP ALL;");
    expect(audits?.[0]?.n).toBe(1);
    const candidate2 = await makeTask(goalId, '另一个 G3 终验', {
      state: 'blocked', kind: 'gate', executor_role: 'gm', reviewer_role: 'owner', dependencies: [new RecordId('task', work), new RecordId('task', candidate)],
    });
    const secondPreview = await core.goalFinalGatePreview(tokens.gm!, { goalId, candidateTaskId: candidate2 });
    expect(secondPreview.ready).toBe(true);
    await expectRefused(core.goalFinalGateRepair(tokens.gm!, {
      goalId, candidateTaskId: candidate2, expectedOldTaskId: gateId, expectedGoalVersion: 0,
      snapshotHash: preview.snapshot.hash, reason: 'SYS07 回归：旧快照不能再次修复', idempotencyKey: 'repair-final-stale',
    }), 'conflict', /snapshot|version|moved/i);
  });
});

describe('business metrics (AC04/AC05)', () => {
  test('known source rows produce the same totals, first-pass denominator, token usage and unknown cost', async () => {
    const now = Date.now();
    const created = new Date(now - 3 * 3_600_000);
    const done = new Date(now - 60 * 60_000);
    await seedGoal({ id: 'metric-1', doneAt: done.toISOString(), createdAt: new Date(now - 2 * 86_400_000).toISOString(),
      outcomeRequired: [] });
    const task = await makeTask('metric-1', '已验收任务', { state: 'done', acceptance_attempt: 1, created_at: created });
    await database.db.query(`CREATE audit CONTENT { task: $task, actor: 'qa-1', action: 'accept', evidence: '验收通过', at: $at };`,
      { task: new RecordId('task', task), at: done });
    await database.db.query(`CREATE model_execution CONTENT { task: $task, model: 'fixture', completed: true,
      input_tokens: 100, output_tokens: 25, cache_read_tokens: 10, at: $at };`, { task: new RecordId('task', task), at: done });
    const rework = await makeTask('metric-1', '返工后验收', { state: 'done', acceptance_attempt: 2, created_at: created });
    await database.db.query(`CREATE audit CONTENT { task: $task, actor: 'qa-1', action: 'return', evidence: '第一次退回', at: $at };`,
      { task: new RecordId('task', rework), at: new Date(now - 2 * 3_600_000) });
    await database.db.query(`CREATE audit CONTENT { task: $task, actor: 'qa-1', action: 'accept', evidence: '返工后通过', at: $at };`,
      { task: new RecordId('task', rework), at: done });
    const metrics = await core.goalMetrics(tokens.gm!, {
      from: iso(now - 86_400_000), to: iso(now), timezone: 'UTC', goalId: 'metric-1',
    });
    expect(metrics.denominators).toMatchObject({ goalsDone: 1, tasksAccepted: 2, firstPassKnown: 2 });
    expect(metrics.acceptance.firstPass).toMatchObject({ passed: 1, known: 2, rate: 0.5 });
    expect(metrics.usage).toMatchObject({ tasksAccepted: 2, tasksWithUsage: 1,
      tokens: { input: 100, output: 25, cacheRead: 10 }, cost: { status: 'unknown' } });
    expect(metrics.events.taskReturns).toMatchObject({ real: 1, channelRollback: 0, total: 1 });
    expect(metrics.cycleTime.goal.known).toBe(1);
    expect(metrics.cycleTime.task.known).toBe(2);
    expect(metrics.window).toMatchObject({ timezone: 'UTC', explicit: true });
    expect(metrics.definitions.usage).toContain('provider');
    expect(metrics.usage.cost).toMatchObject({ status: 'unknown' });
  });

  test('metrics reject a non-IANA timezone and a non-manager reader', async () => {
    await expectRefused(core.goalMetrics(tokens.gm!, { timezone: 'Mars/Base' }), 'invalid', /IANA/);
    await expectRefused(core.goalMetrics(tokens.eng!, {}), 'forbidden', /经理|Capability denied/);
  });
});
