import { expect, test } from 'bun:test';
import { evaluateDispatch, reviewPlanOf } from '../src/dispatcher/dispatch-blocked.ts';
import { staffingPool } from '../src/dispatcher/dispatcher.ts';
import type { EmployeeDef, EmployeeInst } from '../src/workforce.ts';

// SYS-DISP AC05 (R1): the review an execute claim needs. Authors never count. Capacity states do not make a reviewer illegal.
// A spare seat (even one whose provider is in quota) keeps the path open. With no spare seat one legal reviewer is reserved and
// must not implement the same task. Without any legal path the verdict is a manager decision that waiting does not clear.
const NOW = Date.UTC(2026, 9, 20, 3, 0);

test('no legal reviewer and no spare seat is infeasible', () => {
  const plan = reviewPlanOf([
    { key: 'emp-author', kind: 'reuse', eligible: false, code: 'author_recusal' },
    { key: 'spawn:def-eng', kind: 'spawn', eligible: false, code: 'seat_full' },
  ]);
  expect(plan).toEqual({ feasible: false, legal: [], spareSeat: false, reserve: undefined });
});

test('a busy legal reviewer keeps the path open and is the one reserved', () => {
  const plan = reviewPlanOf([
    { key: 'emp-busy', kind: 'reuse', eligible: false, code: 'session_busy' },
    { key: 'emp-author', kind: 'reuse', eligible: false, code: 'author_recusal' },
  ]);
  expect(plan).toMatchObject({ feasible: true, legal: ['emp-busy'], spareSeat: false, reserve: 'emp-busy' });
});

test('among legal reviewers the reserved one is eligible now, in key order', () => {
  const plan = reviewPlanOf([
    { key: 'emp-b', kind: 'reuse', eligible: false, code: 'quota' },
    { key: 'emp-c', kind: 'reuse', eligible: true },
    { key: 'emp-a', kind: 'reuse', eligible: true },
  ]);
  expect(plan).toMatchObject({ feasible: true, legal: ['emp-a', 'emp-b', 'emp-c'], reserve: 'emp-a' });
});

test('a spare seat keeps the path open with no reservation, even when its provider is in quota or at capacity', () => {
  const plan = reviewPlanOf([
    { key: 'emp-a', kind: 'reuse', eligible: true },
    { key: 'spawn:def-eng', kind: 'spawn', eligible: false, code: 'quota' },
  ]);
  expect(plan).toMatchObject({ feasible: true, spareSeat: true, reserve: undefined });
  expect(reviewPlanOf([{ key: 'spawn:def-x', kind: 'spawn', eligible: false, code: 'provider_capacity' }]).feasible).toBe(true);
});

test('track, disabled, model-slot and credential-file reviewers are not legal and never keep the path open', () => {
  const plan = reviewPlanOf([
    { key: 'emp-track', kind: 'reuse', eligible: false, code: 'track_mismatch' },
    { key: 'emp-off', kind: 'reuse', eligible: false, code: 'def_disabled' },
    { key: 'emp-slot', kind: 'reuse', eligible: false, code: 'model_slot' },
    { key: 'emp-file', kind: 'reuse', eligible: false, code: 'credential_file' },
    { key: 'spawn:def-off', kind: 'spawn', eligible: false, code: 'def_disabled' },
    { key: 'spawn:def-full', kind: 'spawn', eligible: false, code: 'seat_full' },
  ]);
  expect(plan).toMatchObject({ feasible: false, legal: [], spareSeat: false });
  expect(plan.reserve).toBeUndefined();
});

test('a reserved reviewer is never picked to implement the same task, and the others stay eligible', () => {
  const def = { id: 'def-eng', role: 'engineering', provider: 'claude', model: 'fixture-model', enabled: true, maxInstances: 2,
    weight: 1, tracks: [] } as unknown as EmployeeDef;
  const inst = (id: string) => ({ id, def: 'def-eng', role: 'engineering', provider: 'claude', model: 'fixture-model',
    repoHome: '/fixture/repo' }) as unknown as EmployeeInst;
  const pool = staffingPool({ role: 'engineering', home: '/fixture/repo', defs: [def], insts: [inst('emp-a'), inst('emp-b')],
    states: new Map([['emp-a', 'idle' as const], ['emp-b', 'idle' as const]]), holding: new Set(), health: new Map(),
    quotaBlocked: new Map(), busyBy: new Map(), providerMax: { claude: 4 }, slots: new Map(), opsRepo: '/fixture/ops',
    sidecar: false, now: NOW, reserved: new Set(['emp-a']) });
  expect(pool.find(entry => entry.key === 'emp-a')).toMatchObject({ eligible: false, code: 'review_capacity' });
  expect(pool.find(entry => entry.key === 'emp-b')).toMatchObject({ eligible: true });
});

test('review_capacity is a manager decision that waiting never clears, and the card names it once', () => {
  const verdict = evaluateDispatch({ taskId: 't-cap', goalId: 'g-cap', title: 'SYS-CAP', phase: 'execute', role: 'engineering', home: 'h',
    entries: [{ key: 'emp-impl', eligible: false, code: 'review_capacity' }, { key: '*', eligible: false, code: 'review_capacity' }],
    since: NOW - 60 * 60_000, checkedAt: NOW });
  expect(verdict).toMatchObject({ dispatchable: false, feasible: false, eligibleCount: 0 });
  expect(verdict.reasons).toHaveLength(1);
  expect(verdict.reasons[0]).toMatchObject({ code: 'review_capacity', owner: 'gm', candidates: ['*', 'emp-impl'], basis: 'tick:review-capacity' });
  expect(verdict.reasons[0]!.actions[0]).toMatchObject({ authority: 'gm', tool: 'def_ensure', executable: true });
});
