import { expect, test } from 'bun:test';
import { waitingOf } from '../src/core.ts';

// RW06 C3 / RW05: the boss and manager task views read one descriptor derived from authoritative row facts. A review-phase wait
// names the reviewing role and the phase it restores; a manager or owner gate names itself; a fact the row lacks is unknown and
// never silently becomes an execute wait.
const base = {
  state: 'blocked' as const, blocked_to: undefined as 'gm' | 'owner' | undefined,
  resume_state: undefined as 'ready' | 'doing' | 'review' | undefined, resume_role: undefined as string | undefined,
  reviewer_role: 'qa' as const, executor_role: 'engineering' as const, dependencies: [],
};

test('a review-phase dependency wait names the reviewer role and the review phase it restores', () => {
  const waiting = waitingOf({ ...base, resume_state: 'review', resume_role: 'qa', dependencies: ['task:dep'] as never });
  expect(waiting).toEqual({ kind: 'dependency', resumeState: 'review', role: 'qa', dependenciesCount: 1 });
});

test('an empty resume role on a review wait is not read as an execute wait: the reviewer role stands in', () => {
  const waiting = waitingOf({ ...base, resume_state: 'review', reviewer_role: 'qa' });
  expect(waiting).toMatchObject({ kind: 'dependency', resumeState: 'review', role: 'qa' });
  expect(waiting!.role).not.toBe('engineering');
});

test('an execute-phase wait names the executor role, and an unknown phase is unknown rather than a default', () => {
  expect(waitingOf({ ...base, resume_state: 'ready' })).toMatchObject({ kind: 'dependency', resumeState: 'ready', role: 'engineering' });
  expect(waitingOf({ ...base, resume_state: 'doing' })).toMatchObject({ kind: 'dependency', resumeState: 'doing', role: 'engineering' });
  expect(waitingOf({ ...base })).toMatchObject({ kind: 'dependency', resumeState: 'unknown', role: 'unknown' });
});

test('manager and owner gates are distinct kinds, and a non-blocked task has no waiting descriptor', () => {
  const manager = waitingOf({ ...base, blocked_to: 'gm', resume_state: 'doing', resume_role: 'engineering' });
  expect(manager).toMatchObject({ kind: 'manager', resumeState: 'doing', role: 'engineering' });
  const owner = waitingOf({ ...base, blocked_to: 'owner', resume_state: 'review' });
  expect(owner).toMatchObject({ kind: 'owner', resumeState: 'review', role: 'owner' });
  expect(waitingOf({ ...base, state: 'review' as never })).toBeUndefined();
  expect(waitingOf({ ...base, state: 'doing' as never })).toBeUndefined();
});
