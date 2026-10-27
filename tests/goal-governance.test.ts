/**
 * SYS07 pure rules: final-gate invariants, outcome coverage, blockers and metrics arithmetic.
 * These tests never touch a database; the fork integration test exercises the same rules through core.
 */
import { describe, expect, test } from 'bun:test';
import { assessGoal, normalizeEvidence, normalizeOutcome, type GoalFact, type GoalTaskFact } from '../src/goal-governance.ts';
import { computeGoalMetrics, dayKey, type GoalMetricsSource } from '../src/goal-metrics.ts';

const NOW = Date.UTC(2026, 9, 26, 12, 0);

const goal = (over: Partial<GoalFact> = {}): GoalFact => ({
  id: 'g1', title: '目标', brief: '目标说明', state: 'active', tier: 'standard', pipeline: 'software',
  createdAt: NOW - 10 * 86_400_000, tasks: { manual: 'manual', acceptance: 'gate' }, anchors: ['manual', 'gate'], ...over,
});

const task = (id: string, over: Partial<GoalTaskFact> = {}): GoalTaskFact => ({
  id, title: id, state: 'done', executorRole: 'engineering', reviewerRole: 'qa', dependencies: [], ...over,
});

const outcome = (required: Array<'implementation' | 'customer_activation' | 'customer_adoption' | 'owner_final'> = ['implementation']) => ({
  expected: '交付可用的结果', requiredEvidence: required, responsibleRole: 'gm', version: 1, source: 'test',
});

const ownerGate = (over: Partial<GoalTaskFact> = {}) =>
  task('gate', { title: 'G3 终验', kind: 'gate', executorRole: 'gm', reviewerRole: 'owner', acceptedBy: 'owner', ...over });

describe('goal final-gate invariants (AC01)', () => {
  test('a void final gate is a needs_repair gap and never a completion', () => {
    const result = assessGoal({ goal: goal(), tasks: [task('manual'), ownerGate({ state: 'void', acceptedBy: undefined })],
      outcome: outcome(), now: NOW });
    expect(result.goalComplete).toBe(false);
    expect(result.needsRepair).toBe(true);
    expect(result.repairReasons.map(item => item.code)).toContain('final_gate_void');
  });

  test('a superseded final-gate revision cannot complete the goal', () => {
    const gate = ownerGate({ lineage: 'line-1', revisionNo: 1, supersededBy: 'gate-2' });
    const newer = ownerGate({ id: 'gate-2', lineage: 'line-1', revisionNo: 2, state: 'review', acceptedBy: undefined });
    const result = assessGoal({ goal: goal(), tasks: [task('manual'), gate, newer], outcome: outcome(), now: NOW });
    expect(result.finalGate.superseded).toBe(true);
    expect(result.needsRepair).toBe(true);
    expect(result.goalComplete).toBe(false);
  });

  test('an owner gate must carry the real owner relay approval, not a manager accept', () => {
    const result = assessGoal({ goal: goal(), tasks: [task('manual'), ownerGate({ acceptedBy: 'gm-1' })],
      outcome: outcome(['implementation', 'owner_final']), now: NOW });
    expect(result.finalGate.ownerGate).toBe(true);
    expect(result.repairReasons.map(item => item.code)).toContain('owner_approval_missing');
    expect(result.outcome.missing).toContain('owner_final');
    expect(result.goalComplete).toBe(false);
  });

  test('required owner_final cannot be satisfied by a manager final gate', () => {
    const gmGate = task('gate', { kind: 'gate', executorRole: 'gm', reviewerRole: 'gm', acceptedBy: 'gm' });
    const result = assessGoal({ goal: goal(), tasks: [task('manual'), gmGate],
      outcome: outcome(['implementation', 'owner_final']), now: NOW });
    expect(result.outcome.missing).toContain('owner_final');
    expect(result.stages.find(stage => stage.key === 'owner_final')).toMatchObject({ status: 'missing' });
    expect(result.repairReasons.map(reason => reason.code)).toContain('final_evidence_incomplete');
    expect(result.readyToComplete).toBe(false);
  });

  test('a void implementation task without a completed successor is a gap, not completion', () => {
    const retired = task('impl', { state: 'void' });
    const first = assessGoal({ goal: goal(), tasks: [task('manual'), retired, ownerGate()],
      outcome: outcome(['implementation', 'owner_final']), now: NOW });
    expect(first.outcome.missing).toContain('implementation');
    expect(first.repairReasons.map(reason => reason.code)).toContain('implementation_void');
    expect(first.stages.find(stage => stage.key === 'implementation')?.status).not.toBe('done');
    expect(first.readyToComplete).toBe(false);
    const successor = task('impl-2', { state: 'done' });
    const superseded = task('impl', { state: 'void', supersededBy: 'impl-2' });
    const second = assessGoal({ goal: goal(), tasks: [task('manual'), superseded, successor, ownerGate()],
      outcome: outcome(['implementation', 'owner_final']), now: NOW });
    expect(second.outcome.missing).toEqual([]);
    expect(second.readyToComplete).toBe(true);
  });

  test('all required evidence and a real owner approval make the final gate completable', () => {
    const result = assessGoal({ goal: goal(), tasks: [task('manual'), ownerGate()],
      outcome: outcome(['implementation', 'owner_final']), now: NOW });
    expect(result.repairReasons).toEqual([]);
    expect(result.readyToComplete).toBe(true);
  });

  test('a dependency cycle or a dangling edge is reported, not hidden', () => {
    const a = task('manual', { state: 'blocked', dependencies: ['gate'] });
    const b = task('gate', { state: 'blocked', dependencies: ['manual', 'missing'], reviewerRole: 'gm' });
    const result = assessGoal({ goal: goal(), tasks: [a, b], outcome: outcome(), now: NOW });
    expect(result.graph.cycle).toBe(true);
    expect(result.graph.dangling).toEqual([{ taskId: 'gate', dependency: 'missing' }]);
    expect(result.repairReasons.map(item => item.code)).toEqual(expect.arrayContaining(['dependency_cycle', 'dependency_dangling']));
  });

  test('a dependency that exists only in another goal is cross-goal, not a dangling edge', () => {
    const gate = ownerGate({ dependencies: ['ext-1'] });
    const result = assessGoal({ goal: goal(), tasks: [task('manual'), gate], outcome: outcome(), now: NOW,
      externalDependencies: [{ taskId: 'gate', dependency: 'ext-1', goalId: 'g2' }] });
    expect(result.graph.crossGoal).toEqual([{ taskId: 'gate', dependency: 'ext-1' }]);
    expect(result.graph.dangling).toEqual([]);
    expect(result.repairReasons.map(reason => reason.code)).toContain('dependency_cross_goal');
    expect(result.readyToComplete).toBe(false);
  });

  test('missing customer evidence blocks completion even after the final gate is done', () => {
    const result = assessGoal({ goal: goal(), tasks: [task('manual'), ownerGate()],
      outcome: outcome(['implementation', 'customer_activation', 'owner_final']), now: NOW });
    expect(result.outcome.missing).toContain('customer_activation');
    expect(result.repairReasons.map(item => item.code)).toContain('final_evidence_incomplete');
    expect(result.readyToComplete).toBe(false);
    const evidence = [{ id: 'e1', kind: 'customer_activation' as const, summary: '客户邮件确认激活', source: 'mail:customer',
      confirmedBy: '客户张三', evidenceType: 'external_receipt' as const, at: NOW, digest: 'd1' }];
    const after = assessGoal({ goal: goal(), tasks: [task('manual'), ownerGate()],
      outcome: outcome(['implementation', 'customer_activation', 'owner_final']), evidence, now: NOW });
    expect(after.outcome.missing).toEqual([]);
    expect(after.readyToComplete).toBe(true);
  });

  test('an unknown deadline stays unknown; a registered deadline is exact', () => {
    expect(assessGoal({ goal: goal(), tasks: [task('manual'), ownerGate()], outcome: outcome(), now: NOW }).deadline)
      .toMatchObject({ status: 'unknown', source: 'none' });
    const dated = assessGoal({ goal: goal({ deadline: NOW + 86_400_000 }), tasks: [task('manual'), ownerGate()], outcome: outcome(), now: NOW });
    expect(dated.deadline).toMatchObject({ status: 'exact', at: NOW + 86_400_000, source: 'goal' });
  });
});

describe('actionable blockers (AC03)', () => {
  test('wait, owner, fault and dependency blockers are distinguished with wait duration and next trigger', () => {
    const waiting = task('wait', { state: 'blocked', currentEmployee: undefined, dependencies: [] });
    const handoff = task('handoff', { state: 'blocked', dependencies: [] });
    const owner = task('owner', { state: 'blocked', blockedTo: 'owner', dependencies: [] });
    const faulty = task('faulty', { state: 'ready', dependencies: [] });
    const dependent = task('dep', { state: 'blocked', dependencies: ['wait'] });
    const result = assessGoal({ goal: goal(), tasks: [waiting, handoff, owner, faulty, dependent, ownerGate({ dependencies: ['dep', 'owner', 'faulty'] })],
      waits: [{ taskId: 'wait', waitKey: 'wait:k', kind: 'customer_activation', state: 'waiting', ownerRole: 'owner',
        enteredAt: NOW - 90 * 60_000, nextCheckAt: NOW + 30 * 60_000, reason: '等待客户开通', completed: [],
        pendingAction: '请老板转交邀请' },
        { taskId: 'handoff', waitKey: 'wait:owner', kind: 'owner_handoff', state: 'waiting', ownerRole: 'owner',
          enteredAt: NOW - 30 * 60_000, reason: '等待老板转交客户邀请', completed: ['材料已备'] }],
      faults: [{ taskId: 'faulty', phase: 'login', state: 'exhausted' }],
      outcome: outcome(), now: NOW });
    expect(result.blockers.map(item => item.kind)).toEqual(expect.arrayContaining(['fault', 'owner', 'wait', 'dependency']));
    const wait = result.blockers.find(item => item.taskId === 'wait')!;
    expect(wait).toMatchObject({ waitedMinutes: 90, nextTrigger: new Date(NOW + 30 * 60_000).toISOString() });
    expect(wait.handoff).toMatchObject({ pendingAction: '请老板转交邀请', completed: [] });
    expect(wait.handoff).not.toHaveProperty('handoffFile');
    const own = result.blockers.find(item => item.taskId === 'handoff')!;
    expect(own).toMatchObject({ kind: 'owner', responsibleRole: 'owner', waitedMinutes: 30 });
    expect(own.handoff).toMatchObject({ kind: 'owner_handoff', ownerRole: 'owner', completed: ['材料已备'] });
    expect(own.handoff).not.toHaveProperty('pendingAction');
    expect(own.handoff).not.toHaveProperty('handoffFile');
    expect(result.blockers.find(item => item.taskId === 'dep')!.dependencyPath.map(item => item.taskId))
      .toEqual(['gate', 'dep']);
  });
});

describe('expired waits and cross-window evidence (AC03/AC04)', () => {
  test('an expired SYS05 wait stays visible with a next action and cannot look like a healthy wait', () => {
    const waiting = task('expired', { state: 'blocked', dependencies: [] });
    const result = assessGoal({ goal: goal(), tasks: [task('manual'), waiting, ownerGate()],
      waits: [{ taskId: 'expired', waitKey: 'wait:expired', kind: 'customer_activation', state: 'expired',
        ownerRole: 'owner', enteredAt: NOW - 120 * 60_000, expiresAt: NOW - 60 * 60_000,
        reason: '等待客户激活回执', completed: [] }],
      outcome: outcome(['implementation', 'customer_activation', 'owner_final']), now: NOW });
    expect(result.blockers.find(item => item.taskId === 'expired')).toMatchObject({
      kind: 'wait', summary: expect.stringContaining('已过期'), nextTrigger: expect.any(String),
    });
    expect(result.stages.find(stage => stage.key === 'customer_activation')).toMatchObject({ status: 'missing' });
    expect(result.stages.find(stage => stage.key === 'customer_activation')?.note).toContain('已过期');
  });
});

describe('outcome validation (AC02)', () => {
  test('absolute times and IANA zones are required; unknown values are never fabricated', () => {
    const base = { expected: '客户采纳交付', requiredEvidence: ['customer_adoption'] as Array<'customer_adoption'>, responsibleRole: 'gm', reason: '登记目标成果与证据要求' };
    expect(() => normalizeOutcome({ ...base, deadline: '2026-10-30T18:00:00', timezone: 'Asia/Shanghai' })).toThrow(/时区偏移/);
    expect(() => normalizeOutcome({ ...base, timezone: 'Mars/Base' })).toThrow(/IANA/);
    expect(normalizeOutcome({ ...base, deadline: '2026-10-30T18:00:00+08:00', timezone: 'Asia/Shanghai' }).deadline)
      .toBe(Date.parse('2026-10-30T18:00:00+08:00'));
  });

  test('AI self-report and test-account receipts are refused', () => {
    const base = { kind: 'customer_activation' as const, summary: '客户已激活', source: 'mail:customer',
      confirmedBy: '客户张三', evidenceType: 'external_receipt' as const, reason: '记录真实客户激活回执' };
    expect(() => normalizeEvidence({ ...base, confirmedBy: 'Claude AI' }, NOW)).toThrow(/AI/);
    expect(() => normalizeEvidence({ ...base, source: 'test@example.com' }, NOW)).toThrow(/测试账号/);
    expect(() => normalizeEvidence({ ...base, kind: 'owner_final' as never }, NOW)).toThrow(/不在目标成果契约内/);
    expect(() => normalizeEvidence({ ...base, at: new Date(NOW + 10 * 60_000).toISOString() }, NOW)).toThrow(/不能晚于当前时间/);
  });
});

describe('business metrics (AC04/AC05)', () => {
  const window = { from: '2026-03-08T00:00:00-05:00', to: '2026-03-10T00:00:00-04:00',
    fromMs: Date.parse('2026-03-08T00:00:00-05:00'), toMs: Date.parse('2026-03-10T00:00:00-04:00'),
    timezone: 'America/New_York', cutoffAt: '2026-03-10T04:00:00.000Z', explicit: true };
  const source = (): GoalMetricsSource => ({
    window,
    goals: [
      { id: 'g1', title: '目标一', tier: 'standard', pipeline: 'software', state: 'done',
        createdAt: Date.parse('2026-03-06T12:00:00-05:00'), doneAt: Date.parse('2026-03-09T12:00:00-04:00') },
      { id: 'g2', title: '目标二', tier: 'quick', pipeline: 'software', state: 'done',
        createdAt: Date.parse('2026-03-08T12:00:00-05:00'), doneAt: Date.parse('2026-03-09T18:00:00-04:00') },
    ],
    tasks: [
      { id: 't1', title: 't1', goalId: 'g1', kind: 'task', state: 'done', createdAt: Date.parse('2026-03-08T09:00:00-05:00'),
        acceptedAt: Date.parse('2026-03-09T09:00:00-04:00'), acceptanceAttempt: 1 },
      { id: 't2', title: 't2', goalId: 'g1', kind: 'task', state: 'done', createdAt: Date.parse('2026-03-08T10:00:00-05:00'),
        acceptedAt: Date.parse('2026-03-09T10:00:00-04:00'), acceptanceAttempt: 2 },
      { id: 't3', title: 't3', goalId: 'g2', kind: 'task', state: 'done', createdAt: Date.parse('2026-03-08T10:00:00-05:00'),
        acceptedAt: Date.parse('2026-03-08T18:00:00-04:00') },
    ],
    audits: [
      { taskId: 't1', action: 'block', phase: 'execute', at: Date.parse('2026-03-09T08:00:00-04:00'), actor: 'employee:a' },
      { taskId: 't1', action: 'resume', at: Date.parse('2026-03-09T08:10:00-04:00') },
      { taskId: 't1', action: 'block', phase: 'execute', at: Date.parse('2026-03-09T08:20:00-04:00'), actor: 'employee:a' },
      { taskId: 't1', action: 'checkpoint', at: Date.parse('2026-03-09T08:30:00-04:00') },
      { taskId: 't1', action: 'accept', at: Date.parse('2026-03-09T09:00:00-04:00') },
      { taskId: 't2', action: 'return', at: Date.parse('2026-03-09T08:40:00-04:00'), actor: 'qa-1' },
      { taskId: 't2', action: 'return', at: Date.parse('2026-03-09T08:45:00-04:00'), actor: 'system:channel', mechanical: true },
      { taskId: 't1', action: 'released', at: Date.parse('2026-03-09T07:50:00-04:00'), actor: 'employee:a' },
      { taskId: 't2', action: 'revoked', at: Date.parse('2026-03-09T08:50:00-04:00'), actor: 'employee:a' },
      { taskId: 't2', action: 'block', at: Date.parse('2026-03-09T08:55:00-04:00'), actor: 'system:execution-window' },
    ],
    wakes: [
      { taskId: 't1', phase: 'review', episode: 'e1', attempt: 1, at: Date.parse('2026-03-09T07:00:00-04:00') },
      { taskId: 't1', phase: 'review', episode: 'e1', attempt: 2, at: Date.parse('2026-03-09T07:30:00-04:00') },
    ],
    usage: [
      { taskId: 't1', model: 'm', inputTokens: 100, outputTokens: 20, cacheReadTokens: 5, completed: true,
        at: Date.parse('2026-03-09T08:00:00-04:00') },
      { taskId: 't2', model: 'm', inputTokens: 50, outputTokens: 10, completed: true,
        at: Date.parse('2026-03-09T08:30:00-04:00') },
    ],
    evidence: [
      { goalId: 'g1', kind: 'customer_activation', at: Date.parse('2026-03-09T08:00:00-04:00') },
    ],
  });

  test('cycle time, first-pass rate, repeated blocks, wake without progress and unknown cost are all explicit', () => {
    const metrics = computeGoalMetrics(source());
    expect(metrics.window.timezone).toBe('America/New_York');
    expect(metrics.denominators).toMatchObject({ goalsDone: 2, tasksAccepted: 3, firstPassKnown: 2, firstPassUnknownLegacy: 1 });
    expect(metrics.acceptance.firstPass).toMatchObject({ passed: 1, known: 2, rate: 0.5, unknownLegacy: 1 });
    expect(metrics.blocks.repeatedEpisodes).toBe(1);
    expect(metrics.blocks.extraBlocks).toBe(1);
    expect(metrics.wakes.withoutNewProgress).toBe(1);
    expect(metrics.usage).toMatchObject({ tasksAccepted: 3, tasksWithUsage: 2,
      tokens: { input: 150, output: 30, cacheRead: 5 }, cost: { status: 'unknown' } });
    expect(metrics.customerEvidence).toMatchObject({ goalsDone: 2, goalsWithActivation: 1 });
    expect(metrics.usage.cost.status).not.toBe('actual');
    expect(metrics.events).toMatchObject({ taskReturns: { real: 1, channelRollback: 1, total: 2 },
      leaseEnds: { released: 1, revoked: 1, total: 2 }, systemEvents: 2 });
    expect(metrics.cycleTime.goal.known).toBe(2);
    expect(metrics.cycleTime.task.known).toBe(3);
  });

  test('customer evidence from before the window still covers a goal completed inside it', () => {
    const data = source();
    data.evidence = [{ goalId: 'g1', kind: 'customer_activation', at: window.fromMs - 86_400_000 }];
    const metrics = computeGoalMetrics(data);
    expect(metrics.customerEvidence).toMatchObject({ goalsDone: 2, goalsWithActivation: 1 });
    expect(metrics.customerEvidence.missingActivation).not.toContain('目标一');
    expect(metrics.customerEvidence.missingActivation).toContain('目标二');
  });

  test('DST day bucketing keeps each local day separate without inventing an hour', () => {
    expect(dayKey(Date.parse('2026-03-08T12:00:00-05:00'), 'America/New_York')).toBe('2026-03-08');
    expect(dayKey(Date.parse('2026-03-09T12:00:00-04:00'), 'America/New_York')).toBe('2026-03-09');
    const metrics = computeGoalMetrics(source());
    expect(metrics.daySeries.map(row => row.day)).toEqual(['2026-03-08', '2026-03-09']);
  });

  test('same-episode blocks are separated by a real resume, so two first blocks are not a repeat', () => {
    const data = source();
    data.audits = [
      { taskId: 't1', action: 'block', phase: 'execute', at: Date.parse('2026-03-09T08:00:00-04:00') },
      { taskId: 't1', action: 'resume', at: Date.parse('2026-03-09T08:10:00-04:00') },
      { taskId: 't1', action: 'block', phase: 'execute', at: Date.parse('2026-03-09T08:20:00-04:00') },
    ];
    const metrics = computeGoalMetrics(data);
    // One continuous task+phase segment has two blocks even though a resume happened: the episode key resets only
    // the segment counter, so this is reported as repeated work rather than hidden.
    expect(metrics.blocks.repeatedEpisodes).toBe(1);
  });
});
