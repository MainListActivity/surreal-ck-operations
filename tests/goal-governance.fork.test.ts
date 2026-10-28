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
import { renderBrief } from '../src/owner-brief.ts';
import { isGoalMetricsSegment, type GoalMetricsSection, type GoalMetricsSegmentView, type GoalMetricsView } from '../src/goal-metrics.ts';
import { answerBytes, RESPONSE_BUDGET_BYTES } from '../src/response-budget.ts';
import type { GoalCard } from '../src/goal-governance.ts';
import type { GoalScanView } from '../src/goal-store.ts';

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

/** A real task row that belongs to no goal: the unscoped external work the governance card must not call missing. */
async function makeUnscopedTask(label: string, over: Record<string, unknown> = {}): Promise<string> {
  const id = taskId(label);
  const row = {
    title: label, context: 'SYS07 无目标归属的外部依赖夹具', state: 'done', kind: 'task',
    executor_role: 'engineering', reviewer_role: 'qa', dependencies: [],
    version: 1, fence: 0, created_at: new Date(Date.now() - 5 * 86_400_000), ...over,
  };
  await database.db.query('CREATE ONLY $t CONTENT $row;', { t: new RecordId('task', id), row });
  return id;
}

async function seedGoal(input: {
  id: string; tier?: string; state?: string; finalState?: string; acceptedBy?: string; reviewerRole?: string;
  outcomeRequired?: string[]; outcome?: boolean; deadline?: string; doneAt?: string; createdAt?: string;
  gateDependencies?: string[];
}): Promise<{ goalId: string; manualId: string; gateId: string }> {
  const goalId = input.id;
  const manualId = await makeTask(goalId, '运营验收', { executor_role: 'product', reviewer_role: 'gm', kind: 'task' });
  const gateId = await makeTask(goalId, 'G3 老板最终验收', {
    executor_role: 'gm', reviewer_role: input.reviewerRole ?? 'owner', kind: 'gate',
    state: input.finalState ?? 'done', ...(input.acceptedBy ? { accepted_by: input.acceptedBy } : {}),
    ...(input.gateDependencies ? { dependencies: input.gateDependencies } : {}),
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

describe('SYS07 follow-up: scan paging, owner surfaces and metrics sections', () => {
  /** 27 active goals: one repair gap, 25 quiet goals, and the SYS07 goal last with two parallel blockers. */
  async function seedCrowdedGoals(): Promise<{ lateGoalId: string; bulkGoalIds: string[]; waitTask: string; managerTask: string }> {
    // beforeEach deletes goals but keeps tasks (deleting them fires the model-evaluation reopen event), so a
    // fixed goal id would inherit an earlier test's orphan tasks. Each call gets fresh goal ids.
    const tag = randomUUID().slice(0, 8);
    const bulkGoalIds: string[] = [];
    for (let index = 0; index < 26; index++) {
      const id = `scan-bulk-${tag}-${String(index).padStart(2, '0')}`;
      bulkGoalIds.push(id);
      await seedGoal({
        id,
        createdAt: new Date(Date.now() - 10 * 86_400_000).toISOString(),
        ...(index === 0
          ? { finalState: 'done', acceptedBy: 'owner', outcomeRequired: ['customer_activation'] }
          : { finalState: 'review' }),
      });
    }
    const late = await seedGoal({
      id: `sys07-late-${tag}`,
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      finalState: 'review',
    });
    const waitTask = await makeTask(late.goalId, '客户激活等待', {
      state: 'blocked', executor_role: 'engineering', reviewer_role: 'qa',
      current_employee: 'eng-holder', created_at: new Date(Date.now() - 2 * 3_600_000),
    });
    await database.db.query(`CREATE task_wait CONTENT {
      wait_key: $key, task: $task, kind: 'customer_activation', state: 'waiting',
      source: { kind: 'authorized_person', by: 'fixture' }, owner_role: 'customer', expires_source: 'unknown',
      progress: { employee: 'eng-holder' }, completed: ['内部验收完成'], pending_action: '请客户确认激活',
      next_check_at: $next, reason: '等待客户激活回执并确认采纳结果', version: 1, entered_by: 'fixture', entered_version: 1,
      entered_at: $entered, updated_at: time::now()
    };`, { key: `wait-${waitTask}`, task: new RecordId('task', waitTask), next: Date.now() + 86_400_000,
      entered: new Date(Date.now() - 3_600_000) });
    const managerTask = await makeTask(late.goalId, '经理决策任务', {
      state: 'blocked', blocked_to: 'gm', executor_role: 'product', reviewer_role: 'gm',
      dispatch_blocked_since: Math.floor((Date.now() - 7_200_000) / 1000),
      created_at: new Date(Date.now() - 2 * 3_600_000),
    });
    await database.db.query('UPDATE $gate SET dependencies = [$wait, $manager];', {
      gate: new RecordId('task', late.gateId), wait: new RecordId('task', waitTask), manager: new RecordId('task', managerTask),
    });
    return { lateGoalId: late.goalId, bulkGoalIds, waitTask, managerTask };
  }

  test('the scan pages deterministically within the budget and reaches a goal behind the first page', async () => {
    const { lateGoalId, waitTask, managerTask } = await seedCrowdedGoals();
    const pages: GoalScanView[] = [];
    let cursor: string | undefined;
    for (let index = 0; index < 20; index++) {
      const page = await core.goalGovernanceScan(tokens.gm!, { pageSize: 5, ...(cursor ? { cursor } : {}) });
      pages.push(page);
      expect(answerBytes(page)).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
      if (!page.page.hasMore) break;
      expect(page.page.nextCursor).toBeTruthy();
      cursor = page.page.nextCursor;
    }
    const all = pages.flatMap(page => page.goals);
    const ids = all.map(card => card.goalId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(pages[0]!.page.total).toBe(27);
    expect(pages.every(page => page.scanned === 27)).toBe(true);
    expect(new Set(pages.map(page => page.page.snapshotAt)).size).toBe(1);
    expect(pages.at(-1)!.page.hasMore).toBe(false);
    expect(pages.every(page => JSON.stringify(page.counts) === JSON.stringify(pages[0]!.counts))).toBe(true);
    expect(pages[0]!.counts.needsRepair).toBeGreaterThanOrEqual(1);
    expect(ids.indexOf(lateGoalId)).toBeGreaterThan(20);

    const late = all.find(card => card.goalId === lateGoalId)!;
    expect(late).toBeTruthy();
    expect(late.blockers.map(blocker => blocker.taskId).sort()).toEqual([waitTask, managerTask, late.finalGate.taskId ?? ''].sort());
    const wait = late.blockers.find(blocker => blocker.taskId === waitTask)!;
    expect(wait.kind).toBe('wait');
    expect(wait.responsibleRole).toBe('engineering');
    expect(wait.holder).toBe('eng-holder');
    expect(wait.waitedMinutes).toBeGreaterThanOrEqual(59);
    expect(wait.nextTrigger).toBeTruthy();
    expect(wait.dependencyPath.map(item => item.taskId)).toContain(late.finalGate.taskId ?? '');
    expect(wait.handoff?.pendingAction ?? '').toContain('请客户确认');
    const manager = late.blockers.find(blocker => blocker.taskId === managerTask)!;
    expect(manager.kind).toBe('manager');
    expect(manager.responsibleRole).toBe('gm');
    expect(manager.waitedMinutes).toBeGreaterThanOrEqual(119);
  });

  test('the console and daily brief reach the last goal and render every blocker field and the final gate', async () => {
    const { lateGoalId, bulkGoalIds, waitTask, managerTask } = await seedCrowdedGoals();
    const lateTitle = `目标 ${lateGoalId}`;
    const desk = new OwnerDesk(database);
    const brief = await desk.brief();
    expect(brief.goalCardCoverage).toMatchObject({ total: 27, prioritized: true });
    const briefCard = brief.goalCards!.find(card => card.goalId === lateGoalId)!;
    expect(briefCard).toBeTruthy();
    expect(briefCard.blockers.map(blocker => blocker.taskId).sort()).toEqual([waitTask, managerTask, briefCard.finalGate.taskId ?? ''].sort());

    const apiCards: GoalCard[] = [];
    let cursor: string | undefined;
    for (let index = 0; index < 10; index++) {
      const page = await core.goalConsole(tokens.gm!, { pageSize: 10, ...(cursor ? { cursor } : {}) });
      apiCards.push(...page.goals);
      if (!page.page.hasMore) break;
      cursor = page.page.nextCursor;
    }
    expect(apiCards.length).toBe(27);
    const apiCard = apiCards.find(card => card.goalId === lateGoalId)!;
    expect(apiCard).toBeTruthy();
    expect(briefCard.blockers.map(blocker => blocker.taskId)).toEqual(apiCard.blockers.map(blocker => blocker.taskId));
    expect(briefCard.finalGate).toEqual(apiCard.finalGate);
    expect(briefCard.needsRepair).toBe(apiCard.needsRepair);
    expect(briefCard.stages.map(stage => `${stage.key}:${stage.status}`)).toEqual(apiCard.stages.map(stage => `${stage.key}:${stage.status}`));

    const data = await desk.briefData(Date.now(), '2026-10-27');
    const { text } = renderBrief(data);
    for (const part of [lateTitle, '责任：engineering', '持有人：eng-holder', '依赖路径：', '下一触发：', '交接：待办：请客户确认激活', '终验：', '证据任务：']) {
      expect(text).toContain(part);
    }
    // Severe blockers outrank quiet goals in the brief's 8-line cap, so the last-created SYS07 goal is named first.
    const lateIndex = text.indexOf(lateTitle);
    expect(lateIndex).toBeGreaterThanOrEqual(0);
    const firstQuiet = bulkGoalIds.slice(1).map(id => text.indexOf(`目标 ${id}`))
      .filter(index => index >= 0).sort((a, b) => a - b)[0];
    expect(firstQuiet).toBeDefined();
    expect(lateIndex).toBeLessThan(firstQuiet!);
    expect(text).toContain('待修复');
  });

  test('metrics sections page a real window and keep the window/denominator/coverage口径', async () => {
    const now = Date.now();
    const from = iso(now - 7 * 86_400_000), to = iso(now);
    for (let index = 0; index < 6; index++) {
      await seedGoal({ id: `metric-page-${index}`, doneAt: new Date(now - (index + 1) * 3_600_000).toISOString(),
        createdAt: new Date(now - 2 * 86_400_000).toISOString(), outcomeRequired: [] });
      const task = await makeTask(`metric-page-${index}`, `指标任务 ${index}`, { state: 'done', acceptance_attempt: 1,
        created_at: new Date(now - 3 * 3_600_000) });
      await database.db.query(`CREATE audit CONTENT { task: $task, actor: 'qa-1', action: 'accept', evidence: '通过', at: $at };`,
        { task: new RecordId('task', task), at: new Date(now - (index + 1) * 3_600_000) });
      await database.db.query(`CREATE model_execution CONTENT { task: $task, model: 'fixture', completed: true,
        input_tokens: $tokens, at: $at };`, { task: new RecordId('task', task), tokens: 100 + index, at: new Date(now - (index + 1) * 3_600_000) });
    }
    const full = await core.goalMetrics(tokens.gm!, { from, to, timezone: 'UTC' }) as GoalMetricsView;
    expect(isGoalMetricsSegment(full)).toBe(false);
    const collect = async <T>(section: GoalMetricsSection, pick: (segment: GoalMetricsSegmentView) => T[]): Promise<T[]> => {
      const out: T[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 20; page++) {
        const segment = await core.goalMetrics(tokens.gm!, { from, to, timezone: 'UTC', section, pageSize: 2, ...(cursor ? { cursor } : {}) });
        expect(isGoalMetricsSegment(segment)).toBe(true);
        if (!isGoalMetricsSegment(segment)) throw new Error('expected a metrics section');
        expect(segment.section).toBe(section);
        expect(answerBytes(segment)).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
        expect(segment.window).toMatchObject({ from: full.window.from, to: full.window.to, timezone: 'UTC', explicit: true });
        expect(Number.isFinite(Date.parse(segment.window.cutoffAt))).toBe(true);
        expect(segment.denominators).toEqual(full.denominators);
        expect(segment.coverage).toEqual(full.coverage);
        expect(segment.exclusions).toEqual(full.exclusions);
        out.push(...pick(segment));
        if (!segment.page?.hasMore) return out;
        cursor = segment.page.nextCursor;
      }
      throw new Error(`metrics section ${section} did not finish`);
    };
    expect(await collect('usage_by_goal', segment => (segment.data!.usage as { byGoal: Array<{ goalId: string }> }).byGoal.map(row => row.goalId)))
      .toEqual(full.usage.byGoal.map(row => row.goalId));
    expect(await collect('customer_evidence_missing_activation', segment => (segment.data!.customerEvidence as { missingActivation: string[] }).missingActivation))
      .toEqual(full.customerEvidence.missingActivation);
    expect(await collect('day_series', segment => (segment.data!.daySeries as Array<{ day: string }>).map(row => row.day)))
      .toEqual(full.daySeries.map(row => row.day));
  });
});

describe('whole-database external dependency classification', () => {
  test('existing rows are unscoped or cross-goal with their real state; only a row found nowhere is dangling', async () => {
    // Real rows with no goal: one done, one void. They exist, so the card must never call them missing.
    const unscopedDone = await makeUnscopedTask('orphan-done', { state: 'done' });
    const unscopedVoid = await makeUnscopedTask('orphan-void', { state: 'void' });
    // Two goals that land on the same scan page, so their tasks are loaded alongside the scanned goal's.
    await seedGoal({ id: 'other-done', state: 'done', finalState: 'done', acceptedBy: 'owner' });
    const otherDoneTask = await makeTask('other-done', '其他目标已完成任务', { state: 'done' });
    await seedGoal({ id: 'other-blocked' });
    const otherBlockedTask = await makeTask('other-blocked', '其他目标阻塞任务', { state: 'blocked', blocked_to: 'gm' });
    // The scanned goal depends on all four real rows plus one dependency that exists nowhere.
    const gone = `gone-${randomUUID()}`;
    const scanned = await seedGoal({
      id: 'scan-external', finalState: 'done', acceptedBy: 'owner',
      gateDependencies: [unscopedDone, unscopedVoid, otherDoneTask, otherBlockedTask, gone],
    });
    // A same-goal cycle must still be detected and not be hidden by the external classification.
    const cycleA = await makeTask('scan-external', '环 A', { state: 'blocked', dependencies: [] });
    const cycleB = await makeTask('scan-external', '环 B', { state: 'blocked', dependencies: [cycleA] });
    await database.db.query('UPDATE ONLY $t SET dependencies = $deps;', { t: new RecordId('task', cycleA), deps: [cycleB] });

    // Walk every page so the assertion also covers paging across multiple goals.
    const cards: GoalCard[] = [];
    let cursor: string | undefined;
    for (let index = 0; index < 20; index++) {
      const page = await core.goalGovernanceScan(tokens.gm!, { pageSize: 1, ...(cursor ? { cursor } : {}) });
      expect(answerBytes(page)).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
      cards.push(...page.goals);
      if (!page.page.hasMore) break;
      cursor = page.page.nextCursor;
    }
    const card = cards.find(item => item.goalId === scanned.goalId)!;
    expect(card).toBeTruthy();
    expect(card.graph.dangling).toEqual([{ taskId: scanned.gateId, dependency: gone }]);
    expect(card.graph.unscoped.map(item => [item.dependency, item.state]).sort())
      .toEqual([[unscopedDone, 'done'], [unscopedVoid, 'void']].sort());
    expect(card.graph.crossGoal.map(item => [item.dependency, item.goalId, item.state]).sort())
      .toEqual([[otherDoneTask, 'other-done', 'done'], [otherBlockedTask, 'other-blocked', 'blocked']].sort());
    expect(card.graph.cycle).toBe(true);
    const codes = card.repairReasons.map(reason => reason.code);
    expect(codes).toEqual(expect.arrayContaining(['dependency_unscoped', 'dependency_cross_goal', 'dependency_dangling', 'dependency_cycle']));
    // None of the four existing rows is described as missing; the unscoped one says external/unscoped, and the
    // blocked cross-goal one keeps its real state.
    const messages = card.repairReasons.map(reason => reason.message);
    for (const id of [unscopedDone, unscopedVoid, otherDoneTask, otherBlockedTask]) {
      expect(messages.some(message => message.includes(id) && message.includes('不存在'))).toBe(false);
    }
    expect(messages.some(message => message.includes(unscopedDone) && message.includes('external/unscoped'))).toBe(true);
    expect(messages.some(message => message.includes(otherBlockedTask) && message.includes('blocked'))).toBe(true);
    // Removing dangling does not flatten the goal: it still needs repair and is not ready to complete.
    expect(card.needsRepair).toBe(true);
    expect(card.readyToComplete).toBe(false);
    // The source rows are untouched: no delete, no rewrite of the business dependency edges.
    const [rows] = await database.db.query<[Array<{ id: unknown; goal?: unknown; dependencies?: unknown[] }>]>(
      'SELECT id, goal, dependencies FROM task WHERE id IN $ids;',
      { ids: [unscopedDone, unscopedVoid, otherDoneTask, otherBlockedTask].map(id => new RecordId('task', id)) });
    expect(rows?.length).toBe(4);
    const byId = new Map((rows ?? []).map(row => [String(row.id).replace(/^task:/, '').replace(/[⟨⟩]/g, ''), row]));
    expect(byId.get(unscopedDone)?.goal).toBeUndefined();
    expect(byId.get(unscopedVoid)?.goal).toBeUndefined();
    expect(String(byId.get(otherBlockedTask)?.goal)).toContain('other-blocked');
    expect(String(byId.get(otherDoneTask)?.goal)).toContain('other-done');
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
    // fixture closes it as done before completion. Completion itself still needs the recorded receipt.
    await database.db.query("UPDATE ONLY $task SET state = 'done', version += 1;", { task: new RecordId('task', readyId) });
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

  test('a manager final gate cannot satisfy a required owner_final', async () => {
    const { goalId } = await seedGoal({ id: 'owner-required-gm', reviewerRole: 'gm', acceptedBy: 'gm',
      outcomeRequired: ['implementation', 'owner_final'] });
    const card = await core.goalFinalize(tokens.gm!, { goalId });
    expect(card.state).toBe('needs_repair');
    expect(card.outcome.missing).toContain('owner_final');
    expect(card.stages.find(stage => stage.key === 'owner_final')).toMatchObject({ status: 'missing' });
  });

  test('a void implementation task without a completed successor leaves an implementation gap', async () => {
    const { goalId } = await seedGoal({ id: 'void-implementation', acceptedBy: 'owner',
      outcomeRequired: ['implementation', 'owner_final'] });
    const retired = await makeTask(goalId, '被作废的实现', { state: 'void', kind: 'task' });
    const card = await core.goalFinalize(tokens.gm!, { goalId });
    expect(card.state).toBe('needs_repair');
    expect(card.outcome.missing).toContain('implementation');
    expect(card.repairReasons.map(reason => reason.code)).toContain('implementation_void');
    expect(card.repairReasons.find(reason => reason.code === 'implementation_void')).toMatchObject({ taskId: retired });
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
    // A quick goal's old acceptance anchor is a kind=task gm gate. Repairing it must record the replaced audit,
    // otherwise the retired old anchor would look like abandoned implementation work forever.
    const quick = await seedGoal({ id: 'quick-repair', tier: 'quick', finalState: 'void', reviewerRole: 'gm',
      acceptedBy: undefined, outcomeRequired: ['implementation', 'final_acceptance'] });
    await database.db.query("UPDATE ONLY $task SET kind = 'task', executor_role = 'gm';",
      { task: new RecordId('task', quick.gateId) });
    const quickCandidate = await makeTask(quick.goalId, 'quick 运营验收候选', {
      state: 'blocked', kind: 'task', executor_role: 'gm', reviewer_role: 'gm',
      dependencies: [new RecordId('task', quick.manualId)],
    });
    const quickPreview = await core.goalFinalGatePreview(tokens.gm!, { goalId: quick.goalId, candidateTaskId: quickCandidate });
    expect(quickPreview.ready).toBe(true);
    await core.goalFinalGateRepair(tokens.gm!, {
      goalId: quick.goalId, candidateTaskId: quickCandidate, expectedOldTaskId: quick.gateId, expectedGoalVersion: 0,
      snapshotHash: quickPreview.snapshot.hash, reason: 'SYS07 回归：quick 旧验收误作废，改由新运营验收候选接替',
      idempotencyKey: 'repair-quick-gate',
    });
    const [replaced] = await database.db.query<[Array<{ n: number }>]>(
      "SELECT count() AS n FROM audit WHERE task = $task AND action = 'goal_final_gate_replaced' GROUP ALL;",
      { task: new RecordId('task', quick.gateId) });
    expect(replaced?.[0]?.n).toBe(1);
    await database.db.query("UPDATE ONLY $task SET state = 'done', accepted_by = 'gm', version += 1;",
      { task: new RecordId('task', quickCandidate) });
    const quickCard = await core.goalFinalize(tokens.gm!, { goalId: quick.goalId });
    expect(quickCard.state).toBe('done');
    expect(quickCard.goalComplete).toBe(true);

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
    }) as GoalMetricsView;
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

  test('a receipt recorded before the window still covers a goal completed inside it', async () => {
    const now = Date.now();
    const from = now - 86_400_000;
    const done = new Date(now - 3_600_000);
    await seedGoal({ id: 'metric-cross-window', doneAt: done.toISOString(), createdAt: new Date(now - 3 * 86_400_000).toISOString(),
      outcomeRequired: ['customer_activation'] });
    await database.db.query(`CREATE goal_evidence CONTENT {
      goal: $goal, kind: 'customer_activation', summary: '窗口前记录的客户激活回执', source: 'mail:customer-cross',
      confirmed_by: '客户赵六', evidence_type: 'external_receipt', at: $at, actor: 'test', version: 1,
      digest: 'cross-window-digest', created_at: time::now()
    };`, { goal: new RecordId('goal', 'metric-cross-window'), at: new Date(from - 86_400_000) });
    const metrics = await core.goalMetrics(tokens.gm!, {
      from: iso(from), to: iso(now), timezone: 'UTC', goalId: 'metric-cross-window',
    }) as GoalMetricsView;
    expect(metrics.customerEvidence).toMatchObject({ goalsDone: 1, goalsWithActivation: 1, missingActivation: [] });
  });

  test('metrics reject a non-IANA timezone and a non-manager reader', async () => {
    await expectRefused(core.goalMetrics(tokens.gm!, { timezone: 'Mars/Base' }), 'invalid', /IANA/);
    await expectRefused(core.goalMetrics(tokens.eng!, {}), 'forbidden', /经理|Capability denied/);
  });
});
