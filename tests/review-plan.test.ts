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
    { key: 'emp-author', kind: 'reuse', eligible: false, code: 'prior_submitter' },
    { key: 'spawn:def-eng', kind: 'spawn', eligible: false, code: 'seat_full' },
  ]);
  expect(plan).toEqual({ feasible: false, legal: [], spareSeat: false, reserve: undefined });
});

test('a busy legal reviewer keeps the path open and is the one reserved', () => {
  const plan = reviewPlanOf([
    { key: 'emp-busy', kind: 'reuse', eligible: false, code: 'session_busy' },
    { key: 'emp-author', kind: 'reuse', eligible: false, code: 'prior_submitter' },
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

