import { expect, test } from 'bun:test';
import { evaluateDispatch, globalBlock, type EvaluatedEntry } from '../src/dispatcher/dispatch-blocked.ts';

// SYS-DISP AC02 (R5): every reason carries its source (basis) and structured recovery actions. An executable action names the
// operations tool that performs it and the authority that may run it; an action with no tool says who acts outside the system.
const NOW = Date.UTC(2026, 9, 20, 2, 0);

const verdictOf = (entries: EvaluatedEntry[] | undefined, phase: 'execute' | 'review' = 'execute', globals = [] as ReturnType<typeof globalBlock>[]) =>
  evaluateDispatch({ taskId: 't-r5', goalId: 'g-r5', title: 'R5 任务', phase, role: 'engineering', home: 'h', entries, globalBlocks: globals, checkedAt: NOW });

test('a manager-fixable candidate block names def_ensure as an executable gm action, with its basis', () => {
  const verdict = verdictOf([{ key: 'emp-1', eligible: false, code: 'seat_full' }]);
  const [reason] = verdict.reasons;
  expect(reason).toMatchObject({ code: 'seat_full', owner: 'gm', basis: 'tick:staffing-pool' });
  expect(reason!.actions).toEqual([expect.objectContaining({ authority: 'gm', tool: 'def_ensure', executable: true })]);
});

test('a recusal names the manager tool that adds an independent reviewer, sourced from the contribution audit', () => {
  const verdict = verdictOf([{ key: 'emp-author', eligible: false, code: 'author_recusal' }], 'review');
  const [reason] = verdict.reasons;
  expect(reason).toMatchObject({ code: 'author_recusal', basis: 'contribution-audit' });
  expect(reason!.actions[0]).toMatchObject({ authority: 'gm', executable: true });
  expect(reason!.actions[0]!.tool).toBe('def_ensure');
});

test('a takeover block is executable through implementer_takeover', () => {
  const verdict = verdictOf([{ key: 'emp-1', eligible: false, code: 'implementer_mismatch' }]);
  expect(verdict.reasons[0]!.actions[0]).toMatchObject({ authority: 'gm', tool: 'implementer_takeover', executable: true });
});

test('owner-only and outside-system recoveries are not executable and say who acts', () => {
  const quota = verdictOf([{ key: 'emp-1', eligible: false, code: 'quota' }]);
  expect(quota.reasons[0]!.actions).toEqual([expect.objectContaining({ authority: 'owner', executable: false })]);
  expect(quota.reasons[0]!.basis).toBe('tick:quota-rows');
  const busy = verdictOf([{ key: 'emp-1', eligible: false, code: 'session_busy' }]);
  expect(busy.reasons[0]!.actions[0]).toMatchObject({ authority: 'gm', executable: false });
  expect(busy.reasons[0]!.actions[0]!.tool).toBeUndefined();
});

test('a pass-wide gate names its source and an outside-system action', () => {
  const verdict = verdictOf(undefined, 'execute', [globalBlock('paused')]);
  expect(verdict.reasons[0]).toMatchObject({ code: 'paused', basis: 'tick:global-gate' });
  expect(verdict.reasons[0]!.actions[0]).toMatchObject({ authority: 'gm', executable: false });
});

test('an unknown state is never shown as busy: its basis is the read that failed', () => {
  const verdict = verdictOf(undefined);
  expect(verdict.reasons.map(reason => reason.code)).toEqual(['unknown']);
  expect(verdict.reasons[0]).toMatchObject({ basis: 'read:state-or-audit' });
  expect(verdict.feasible).toBe(false);
});

test('an unavailable implementer is replaced by the system itself, not by the manager', () => {
  const verdict = verdictOf([{ key: '*', eligible: false, code: 'implementer_unavailable' }]);
  const [reason] = verdict.reasons;
  expect(reason).toMatchObject({ code: 'implementer_unavailable', owner: 'system', basis: 'tick:session-status' });
  expect(reason!.actions).toEqual([expect.objectContaining({ authority: 'system', executable: false })]);
  expect(reason!.actions[0]!.tool).toBeUndefined();
  expect(reason!.recovery).toContain('系统自动改派');
  expect(reason!.nextTrigger).toContain('系统自动改派');
});
