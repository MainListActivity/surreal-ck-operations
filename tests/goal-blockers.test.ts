import { expect, test } from 'bun:test';
import { evaluateDispatch, goalRootBlockers, submitCommitOf, type GoalRootFacts } from '../src/dispatcher/dispatch-blocked.ts';

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
