// Blocking review finding (AC3, byte budget): qa_observation_read accepts only scopeId/taskId/goalId, so there is no paging
// input to narrow an over-budget goal answer. The relay replaces such an answer whole with response_too_large and MCP refuses
// it. These regressions build the production shape the review measured (20 roots, 2-step paths, contract-max titles) and
// measure the answer the way both paths do: answerBytes against RESPONSE_BUDGET_BYTES, and guardRelayResponse on the result.
import { expect, test } from 'bun:test';
import type { QaObservationGoalWaitRoot, QaObservationGoalWaitSummary, QaObservationReadView } from '../src/contracts.ts';
import { QA_OBSERVATION_WAIT_RELEASE_RESERVE_BYTES, fitGoalWaitSummary } from '../src/qa-observation.ts';
import { RESPONSE_BUDGET_BYTES, answerBytes, guardRelayResponse } from '../src/response-budget.ts';

const checkedAt = '2026-10-22T03:00:00.000Z';
const goalId = '29e2764898591aae';
// 200 characters, the documented title bound (docs/query-paging.md): 4 ASCII + 3-byte CJK, the worst case the budget must hold.
const maxTitle = (label: string, index: number): string => `${label}${String(index).padStart(2, '0')} ` + '长标题'.repeat(64);

const root = (index: number, title = maxTitle('等待根', index)): QaObservationGoalWaitRoot => ({
  goalId, taskId: `task-root-${String(index).padStart(2, '0')}`, title, workflowState: 'review', kind: 'dependency',
  basis: 'task.dependencies', waitingForRole: 'qa', nextTrigger: '依赖任务完成、撤销或恢复后重新判定', goalRootCount: 20,
  impact: 2, dependencyPath: [
    { taskId: `task-root-${String(index).padStart(2, '0')}`, title },
    { taskId: `task-step-${String(index).padStart(2, '0')}`, title: maxTitle('后续', index) },
  ],
  people: { implementer: 'engineering-fable-12c5e9', authors: ['engineering-fable-12c5e9', 'engineering-fable-aa75b8'],
    reviewers: ['qa-claude-429b95'], submitter: 'engineering-fable-12c5e9', submitCommit: 'e0a74a8851c54612b7cecc0a5b98df9b0eac5c16' },
  peopleSource: 'contributor-audit', submitterSource: 'submit-audit', submitCommitSource: 'submit-audit-evidence',
  peopleCheckedAt: checkedAt, submitCheckedAt: checkedAt,
});

const summary = (count: number, roots = Array.from({ length: count }, (_, index) => root(index))): QaObservationGoalWaitSummary => ({
  source: 'workflow-graph', available: true, checkedAt, totalRoots: roots.length, shownRoots: roots.length, truncated: false, roots,
});

// The answer core returns for a goal subject: the pass fields, the root blocker with its reasons, and the waits under test.
const rootBlocker = {
  taskId: 'task-root-00', title: maxTitle('根阻点', 0), phase: 'review' as const, workflowState: 'review' as const, summary: '无独立复核人选',
  feasible: false, waitingMinutes: 30, since: checkedAt, checkedAt, eligibleCount: 0, undispatchable: 0, others: 1,
  factsAvailable: true, impact: 2, dependencyPath: [{ taskId: 'task-root-00', title: maxTitle('根阻点', 0) }],
  people: { implementer: 'engineering-fable-12c5e9', authors: ['engineering-fable-12c5e9'], reviewers: [], submitCommit: 'e0a74a8' },
  reasons: Array.from({ length: 20 }, (_, index) => ({ code: `reason-${index}`, text: `原因 ${index} ` + '生产标题'.repeat(30),
    candidates: ['candidate'], owner: 'owner', recovery: '经理增补独立复核人选', nextTrigger: '新增编制或员工', basis: 'tick:staffing-pool',
    actions: [{ authority: 'owner', label: '经理用 def_ensure 增加编制', tool: 'def_ensure', executable: true }] })),
};

const view = (waits: QaObservationGoalWaitSummary): QaObservationReadView => ({
  meta: { checkedAt, dataSource: 'live', instanceAt: checkedAt, runtimeRelease: 'release-e0a74a8851c5',
    scope: { id: 'scope-1', goalId, deploymentTaskId: 'task-root-00', qaEmployee: 'qa-claude-429b95',
      leaseHolder: 'qa-claude-429b95', leaseFence: 16, subjects: ['task-root-00'], status: 'active', expiresAt: checkedAt,
      version: 1, reason: '隔离预算回归', createdAt: checkedAt },
    completeness: { complete: true, dispatchComplete: true } },
  goal: { id: goalId, states: { blocked: 29, doing: 1, done: 43, review: 1, void: 1 }, total: 75, undispatchable: 0,
    dispatchAvailable: true, dispatchComplete: true, dispatchSource: 'dispatcher-pass', dispatchCheckedAt: checkedAt,
    waits, root: rootBlocker },
});

const fits = (candidate: QaObservationGoalWaitSummary): boolean =>
  answerBytes(view(candidate)) <= RESPONSE_BUDGET_BYTES - QA_OBSERVATION_WAIT_RELEASE_RESERVE_BYTES;

test('the unfitted 20-root goal answer reproduces the review failure: over budget, and the relay replaces it whole', () => {
  const unfitted = view(summary(20));
  expect(answerBytes(unfitted)).toBeGreaterThan(RESPONSE_BUDGET_BYTES);
  expect(guardRelayResponse({ ok: true as const, data: unfitted })).toMatchObject({ ok: false, code: 'response_too_large' });
});

test('20 roots x 2-step paths under contract-max titles fit after the budget cut, and the relay passes the answer unchanged', () => {
  const original = summary(20);
  const fitted = fitGoalWaitSummary(original, fits);
  const answer = view(fitted);
  expect(answerBytes(answer)).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
  const guarded = guardRelayResponse({ ok: true as const, data: answer });
  expect(guarded).toMatchObject({ ok: true });
  expect((guarded as { data?: unknown }).data).toBe(answer);
  // What was left out is stated, and the count is the evaluator's own total, never the shown count.
  expect(fitted.totalRoots).toBe(20);
  expect(fitted.shownRoots).toBe(fitted.roots.length);
  expect(fitted.roots.length).toBeGreaterThan(0);
  expect(fitted.roots.length).toBeLessThan(20);
  expect(fitted.truncated).toBe(true);
  expect(fitted.budgetLimited).toBe(true);
  // The kept roots are the evaluator's highest-priority prefix, in its order.
  expect(fitted.roots).toEqual(original.roots.slice(0, fitted.roots.length));
  expect(fitted.checkedAt).toBe(checkedAt);
  expect(fitted.source).toBe('workflow-graph');
});

test('a summary that already fits is returned untouched: no marker, no copy', () => {
  const small = summary(1);
  expect(fits(small)).toBe(true);
  expect(fitGoalWaitSummary(small, fits)).toBe(small);
});

test('an unavailable summary is never rewritten by the budget cut', () => {
  const unavailable: QaObservationGoalWaitSummary = { source: 'workflow-graph', available: false, totalRoots: 0, shownRoots: 0,
    truncated: false, reason: 'workflow graph could not be read', roots: [] };
  expect(fitGoalWaitSummary(unavailable, () => false)).toBe(unavailable);
});

test('when no root fits whole, the first root keeps its priority and loses path steps first, marked as truncated', () => {
  const original = summary(3);
  const fullPathBytes = answerBytes(view({ ...original, shownRoots: 1, truncated: true, budgetLimited: true, roots: [original.roots[0]!] }));
  // A ceiling between the shortened path and the full path: only the path cut can fit.
  const ceiling = fullPathBytes - 1;
  const fitted = fitGoalWaitSummary(original, candidate => answerBytes(view(candidate)) <= ceiling);
  expect(fitted.roots).toHaveLength(1);
  expect(fitted.roots[0]!.taskId).toBe(original.roots[0]!.taskId);
  expect(fitted.roots[0]!.dependencyPath).toHaveLength(1);
  expect(fitted.roots[0]!.dependencyPathTruncated).toBe(true);
  expect(fitted).toMatchObject({ totalRoots: 3, shownRoots: 1, truncated: true, budgetLimited: true });
});

test('when not even one shortened root fits, the answer says so instead of being replaced by the relay', () => {
  const original = summary(20);
  const fitted = fitGoalWaitSummary(original, () => false);
  expect(fitted).toMatchObject({ totalRoots: 20, shownRoots: 0, truncated: true, budgetLimited: true, roots: [] });
});
