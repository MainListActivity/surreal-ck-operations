import { expect, test } from 'bun:test';
import { evaluateDispatch, goalRootBlockers, goalWorkflowWaitRoots, submitCommitOf, type GoalRootFacts, type GoalWorkflowTaskFact } from '../src/dispatcher/dispatch-blocked.ts';

// SYS-DISP AC02/AC03: one root blocker per goal card, from the same verdicts the tick and the queue read.
const NOW = Date.UTC(2026, 9, 20, 1, 0);
const minutesAgo = (minutes: number) => NOW - minutes * 60_000;

test('a goal card names its material blocker first, then the longest wait, and counts the rest', () => {
  const waiting = evaluateDispatch({ taskId: 't-busy', goalId: 'g1', title: '执行任务', phase: 'execute', role: 'engineering', home: 'h',
    entries: [{ key: 'emp-1', eligible: false, code: 'session_busy' }], since: minutesAgo(30), checkedAt: NOW });
  const material = evaluateDispatch({ taskId: 't-review', goalId: 'g1', title: 'SYS01', phase: 'review', role: 'engineering', home: 'h',
    entries: [{ key: 'emp-author', eligible: false, code: 'author_recusal' }], since: minutesAgo(5), checkedAt: NOW });
  const roots = goalRootBlockers([waiting, material]);
  expect(roots).toHaveLength(1);
  expect(roots[0]).toMatchObject({ goalId: 'g1', taskId: 't-review', phase: 'review', feasible: false, others: 1, waitingMinutes: 5 });
  expect(roots[0]!.reasons.map(reason => reason.code)).toEqual(['author_recusal']);
  expect(roots[0]!.summary).toContain('复核无法派工');
});

test('among equally material blockers the longest wait is named first', () => {
  const older = evaluateDispatch({ taskId: 't-old', goalId: 'g2', title: '老任务', phase: 'execute', role: 'engineering', home: 'h',
    entries: [{ key: 'emp-1', eligible: false, code: 'session_busy' }], since: minutesAgo(90), checkedAt: NOW });
  const newer = evaluateDispatch({ taskId: 't-new', goalId: 'g2', title: '新任务', phase: 'execute', role: 'engineering', home: 'h',
    entries: [{ key: 'emp-1', eligible: false, code: 'session_busy' }], since: minutesAgo(10), checkedAt: NOW });
  const [root] = goalRootBlockers([newer, older]);
  expect(root).toMatchObject({ taskId: 't-old', others: 1, feasible: true, waitingMinutes: 90 });
});

test('dispatchable work, work without a goal, and other goals stay apart', () => {
  const dispatchable = evaluateDispatch({ taskId: 't-ok', goalId: 'g3', title: '可派工', phase: 'execute', role: 'engineering', home: 'h',
    entries: [{ key: 'emp-1', eligible: true }], checkedAt: NOW });
  const loose = evaluateDispatch({ taskId: 't-loose', title: '无目标', phase: 'execute', role: 'engineering', home: 'h',
    entries: [{ key: 'emp-1', eligible: false, code: 'session_busy' }], checkedAt: NOW });
  const other = evaluateDispatch({ taskId: 't-other', goalId: 'g4', title: '另一目标', phase: 'review', role: 'engineering', home: 'h',
    entries: [], checkedAt: NOW });
  const roots = goalRootBlockers([dispatchable, loose, other]);
  expect(roots.map(root => root.goalId)).toEqual(['g4']);
  expect(roots[0]).toMatchObject({ taskId: 't-other', others: 0, feasible: false });
  expect(roots[0]!.reasons.map(reason => reason.code)).toEqual(['no_candidate']);
});

test('no verdicts means no goal blockers, so a page with nothing blocked shows nothing', () => {
  expect(goalRootBlockers([])).toEqual([]);
});

// SYS-DISP AC03 (R2): the card's impact count, the waiting chain from the root, and the root's people.
test('the root counts every task waiting on it, names the deepest chain, and carries its people', () => {
  const root = evaluateDispatch({ taskId: 'sys01', goalId: 'g5', title: 'SYS01', phase: 'review', role: 'engineering', home: 'h',
    entries: [{ key: 'emp-author', eligible: false, code: 'author_recusal' }], since: minutesAgo(12), checkedAt: NOW });
  const facts: GoalRootFacts = {
    dependencies: new Map([['sys02', ['sys01']], ['sys03', ['sys02']], ['sys04', ['sys01']], ['unrelated', []]]),
    titles: new Map([['sys01', 'SYS01'], ['sys02', 'SYS02'], ['sys03', 'SYS03'], ['sys04', 'SYS04']]),
    people: new Map([['sys01', { implementer: 'emp-a', authors: ['emp-a', 'emp-b'], reviewers: ['emp-c'], submitter: 'emp-b', submitCommit: 'abc1234' }]]),
  };
  const [blocker] = goalRootBlockers([root], facts);
  expect(blocker).toMatchObject({ taskId: 'sys01', impact: 3,
    dependencyPath: [{ taskId: 'sys01', title: 'SYS01' }, { taskId: 'sys02', title: 'SYS02' }, { taskId: 'sys03', title: 'SYS03' }],
    people: { implementer: 'emp-a', authors: ['emp-a', 'emp-b'], reviewers: ['emp-c'], submitter: 'emp-b', submitCommit: 'abc1234' } });
});

test('without facts the card keeps the verdict view and names nobody rather than inventing an implementer', () => {
  const root = evaluateDispatch({ taskId: 'sys05', goalId: 'g6', title: 'SYS05', phase: 'execute', role: 'engineering', home: 'h',
    entries: [{ key: 'emp-1', eligible: false, code: 'session_busy' }], since: minutesAgo(3), checkedAt: NOW });
  const [blocker] = goalRootBlockers([root]);
  expect(blocker).toMatchObject({ impact: 0, dependencyPath: [{ taskId: 'sys05', title: 'SYS05' }], people: { authors: [], reviewers: [] } });
  expect(blocker!.people.implementer).toBeUndefined();
});

test('the submit commit comes from the evidence text only when the text names one', () => {
  expect(submitCommitOf('提交：`c33ee8b`，PR #1469')).toBe('c33ee8b');
  expect(submitCommitOf('验证 commit 9f1a2b3c4d5e，之前提交 A84634C')).toBe('a84634c');
  expect(submitCommitOf('PR #1469，未写提交号')).toBeUndefined();
});


test('workflow wait roots classify active lease and gates, count only in-goal impact, and keep stable order', () => {
  const collectedAt = '2026-10-20T01:00:00.000Z';
  const task = (taskId: string, extra: Partial<GoalWorkflowTaskFact> = {}): GoalWorkflowTaskFact => ({
    taskId, goalId: 'g1', title: taskId, state: 'blocked', dependencies: [], ...extra,
  });
  const facts: GoalRootFacts = { dependencies: new Map(), titles: new Map(), people: new Map(), collectedAt,
    tasks: new Map([
      ['lease', task('lease', { state: 'review', reviewerRole: 'qa', currentEmployee: 'qa-1', leaseExpiresAt: Date.parse(collectedAt) / 1000 + 60 })],
      ['wait-1', task('wait-1', { dependencies: ['lease'] })],
      ['wait-2', task('wait-2', { dependencies: ['wait-1'] })],
      ['manager', task('manager', { blockedTo: 'gm' })],
      ['owner', task('owner', { blockedTo: 'owner' })],
    ]) };
  const summary = goalWorkflowWaitRoots(facts);
  expect(summary).toMatchObject({ available: true, checkedAt: collectedAt, totalRoots: 3, shownRoots: 3 });
  expect(summary.roots.map(root => root.kind)).toEqual(['manager', 'owner', 'active_lease']);
  expect(summary.roots[2]).toMatchObject({ taskId: 'lease', workflowState: 'review', impact: 2,
    dependencyPath: [{ taskId: 'lease', title: 'lease' }, { taskId: 'wait-1', title: 'wait-1' }, { taskId: 'wait-2', title: 'wait-2' }] });
});

test('workflow waits fail closed for cycles, missing dependencies, hidden edges and unknown states', () => {
  const task = (taskId: string, extra: Partial<GoalWorkflowTaskFact> = {}): GoalWorkflowTaskFact => ({
    taskId, goalId: 'g1', title: taskId, state: 'blocked', dependencies: [], ...extra,
  });
  const summary = goalWorkflowWaitRoots({ dependencies: new Map(), titles: new Map(), people: new Map(),
    collectedAt: '2026-10-20T01:00:00.000Z', tasks: new Map([
      ['cycle-a', task('cycle-a', { dependencies: ['cycle-b'] })],
      ['cycle-b', task('cycle-b', { dependencies: ['cycle-a'] })],
      ['missing', task('missing', { dependencies: ['absent'] })],
      ['hidden', task('hidden', { dependencies: ['inside'], hiddenDependencies: 1 })],
      ['inside', task('inside', { state: 'ready' })],
      ['bad-state', task('bad-state', { state: 'future' })],
    ]) });
  expect(summary.roots.map(root => root.taskId)).toEqual(['bad-state', 'cycle-a', 'hidden', 'missing']);
  expect(summary.roots.find(root => root.taskId === 'cycle-a')).toMatchObject({ kind: 'unknown', unknownReason: '依赖关系存在循环' });
  const missing = summary.roots.find(root => root.taskId === 'missing')!;
  expect(missing.kind).toBe('unknown');
  expect(missing).not.toHaveProperty('impact');
  expect(missing).not.toHaveProperty('dependencyPath');
  expect(summary.roots.find(root => root.taskId === 'hidden')).toMatchObject({ kind: 'unknown', unknownReason: '存在当前目标不可见范围的依赖' });
  expect(summary.roots.find(root => root.taskId === 'bad-state')).toMatchObject({ kind: 'unknown', workflowState: 'unknown' });
  expect(summary.roots.every(root => root.impact === undefined)).toBe(true);
});

test('owner void gate satisfies only a goal anchor, while ordinary dependants remain unknown', () => {
  const ownerGate: GoalWorkflowTaskFact = { taskId: 'owner-gate', goalId: 'g1', title: '老板关口', state: 'void', reviewerRole: 'owner', dependencies: [] };
  const otherWait: GoalWorkflowTaskFact = { taskId: 'other-wait', goalId: 'g1', title: '另一个等待根', state: 'ready', dependencies: [] };
  const anchor: GoalWorkflowTaskFact = { taskId: 'anchor', goalId: 'g1', title: '目标锚点', state: 'blocked', goalAnchor: true, dependencies: ['owner-gate', 'other-wait'] };
  const ordinary: GoalWorkflowTaskFact = { taskId: 'ordinary', goalId: 'g1', title: '普通依赖', state: 'blocked', dependencies: ['owner-gate'] };
  const summary = goalWorkflowWaitRoots({ dependencies: new Map(), titles: new Map(), people: new Map(),
    collectedAt: '2026-10-20T01:00:00.000Z', tasks: new Map([[ownerGate.taskId, ownerGate], [otherWait.taskId, otherWait], [anchor.taskId, anchor], [ordinary.taskId, ordinary]]) });
  expect(summary.roots.find(root => root.taskId === 'anchor')).toBeUndefined();
  expect(summary.roots.find(root => root.taskId === 'other-wait')).toMatchObject({ kind: 'dependency', impact: 1 });
  expect(summary.roots.find(root => root.taskId === 'ordinary')).toMatchObject({ kind: 'unknown', unknownReason: '非目标锚点仍依赖已作废的老板关口' });
});

test('workflow waits report no roots after all dependencies are terminal and expose truncation counts', () => {
  const done: GoalWorkflowTaskFact = { taskId: 'done', goalId: 'g1', title: 'done', state: 'done', dependencies: [] };
  const finished: GoalWorkflowTaskFact = { taskId: 'finished', goalId: 'g1', title: 'finished', state: 'blocked', dependencies: ['done'] };
  const facts: GoalRootFacts = { dependencies: new Map(), titles: new Map(), people: new Map(), collectedAt: '2026-10-20T01:00:00.000Z',
    tasks: new Map([['done', done], ['finished', finished]]) };
  expect(goalWorkflowWaitRoots(facts).roots).toMatchObject([{ taskId: 'finished', kind: 'unknown', workflowState: 'blocked' }]);
  const noWaits = goalWorkflowWaitRoots({ ...facts, tasks: new Map([['done', done]]) });
  expect(noWaits).toMatchObject({ totalRoots: 0, shownRoots: 0, truncated: false, roots: [] });
  const many = new Map<string, GoalWorkflowTaskFact>();
  for (let i = 0; i < 3; i++) many.set(`unknown-${i}`, { taskId: `unknown-${i}`, goalId: 'g1', title: `u${i}`, state: 'future', dependencies: [] });
  expect(goalWorkflowWaitRoots({ ...facts, tasks: many }, 2)).toMatchObject({ totalRoots: 3, shownRoots: 2, truncated: true });
});


test('workflow wait roots mark a bounded dependency path when the impact chain exceeds the path limit', () => {
  const tasks = new Map<string, GoalWorkflowTaskFact>();
  tasks.set('root', { taskId: 'root', goalId: 'g1', title: 'root', state: 'ready', dependencies: [] });
  for (let i = 1; i <= 10; i++) tasks.set(`blocked-${i}`, { taskId: `blocked-${i}`, goalId: 'g1', title: `blocked-${i}`,
    state: 'blocked', dependencies: [i === 1 ? 'root' : `blocked-${i - 1}`] });
  const [root] = goalWorkflowWaitRoots({ dependencies: new Map(), titles: new Map(), people: new Map(), collectedAt: '2026-10-20T01:00:00.000Z', tasks }).roots;
  expect(root).toMatchObject({ taskId: 'root', kind: 'dependency', impact: 10, dependencyPathTruncated: true });
  expect(root?.dependencyPath).toHaveLength(8);
});

test('workflow wait root ordering is stable when input maps arrive in a different insertion order', () => {
  const make = (ids: string[]) => goalWorkflowWaitRoots({ dependencies: new Map(), titles: new Map(), people: new Map(),
    collectedAt: '2026-10-20T01:00:00.000Z', tasks: new Map(ids.map(taskId => [taskId, {
      taskId, goalId: 'g1', title: taskId, state: 'future', dependencies: [],
    }])) }).roots.map(root => root.taskId);
  expect(make(['z-root', 'a-root', 'm-root'])).toEqual(['a-root', 'm-root', 'z-root']);
  expect(make(['m-root', 'z-root', 'a-root'])).toEqual(['a-root', 'm-root', 'z-root']);
});
