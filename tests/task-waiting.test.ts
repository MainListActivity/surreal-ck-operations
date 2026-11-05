import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { waitingOf } from '../src/core.ts';
import { waitingLabel } from '../plugin/shared/waiting-label';

// RW06 C3 / RW05: the boss and manager task views read one descriptor derived from authoritative row facts. A review-phase wait
// names the reviewing role and the phase it restores; a manager or owner gate names itself; a fact the row lacks is unknown and
// never silently becomes an execute wait.
const base = {
  state: 'blocked' as const, blocked_to: undefined as 'owner' | 'owner' | undefined,
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
  const manager = waitingOf({ ...base, blocked_to: 'owner', resume_state: 'doing', resume_role: 'engineering' });
  expect(manager).toMatchObject({ kind: 'owner', resumeState: 'doing', role: 'engineering' });
  const owner = waitingOf({ ...base, blocked_to: 'owner', resume_state: 'review' });
  expect(owner).toMatchObject({ kind: 'owner', resumeState: 'review', role: 'owner' });
  expect(waitingOf({ ...base, state: 'review' as never })).toBeUndefined();
  expect(waitingOf({ ...base, state: 'doing' as never })).toBeUndefined();
});

test('the task row renders the tested waiting text: review prerequisite vs manager vs owner vs unknown', () => {
  expect(waitingLabel({ kind: 'dependency', resumeState: 'review', role: 'qa', dependenciesCount: 1 })).toBe('等待测试的复核前置（恢复复核）· 依赖 1 项');
  expect(waitingLabel({ kind: 'dependency', resumeState: 'ready', role: 'engineering', dependenciesCount: 2 })).toBe('等待工程的就绪前置（恢复就绪）· 依赖 2 项');
  expect(waitingLabel({ kind: 'owner', resumeState: 'review', role: 'qa', dependenciesCount: 0 })).toBe('等待老板决定（恢复复核）· 依赖 0 项');
  expect(waitingLabel({ kind: 'owner', resumeState: 'review', role: 'owner', dependenciesCount: 0 })).toBe('等待老板决定（恢复复核）· 依赖 0 项');
  expect(waitingLabel({ kind: 'dependency', resumeState: 'unknown', role: 'unknown', dependenciesCount: 0 })).toBe('等待未知岗位的未知阶段前置（恢复未知阶段）· 依赖 0 项');
  // The text names the reviewing role for a review wait, never the execute role.
  expect(waitingLabel({ kind: 'dependency', resumeState: 'review', role: 'qa', dependenciesCount: 1 })).not.toContain('工程');
});

test('the plugin task row actually renders that text: it imports the shared label and calls it on the task waiting facts', () => {
  const client = readFileSync(join(import.meta.dir, '..', 'plugin', 'client', 'company.tsx'), 'utf8');
  expect(client).toContain('import { waitingLabel } from "../shared/waiting-label"');
  expect(client).toContain('{waitingLabel(task.waiting)}');
});
