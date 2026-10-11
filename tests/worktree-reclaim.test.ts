import { expect, test } from 'bun:test';
import {
  decideReclaim, isCompanyManagedPath, orphanClock, parseGraceDays, reclaimEnabledFrom,
} from '../src/dispatcher/worktree-reclaim.ts';

const day = 86_400_000;
const now = new Date('2026-10-10T12:00:00.000Z');
const policy = { enabled: true, orphanGraceMs: 7 * day, now };

test('company-managed path and branch patterns', () => {
  expect(isCompanyManagedPath('/Users/y/IdeaProjects/surreal_ck-task-54697f41', 'task/54697f41')).toBe(true);
  expect(isCompanyManagedPath('/Users/y/IdeaProjects/maplayer-content-wt-4ee3530a', 'task/4ee3530a')).toBe(true);
  expect(isCompanyManagedPath('/Users/y/IdeaProjects/surreal_ck-review-3d67d639', undefined)).toBe(true);
  expect(isCompanyManagedPath('/Users/y/IdeaProjects/surreal_ck-sck-9eab69e5-shared', 'sck/shared-9eab69e5abcd')).toBe(true);
  expect(isCompanyManagedPath('/Users/y/IdeaProjects/surreal_ck-task-8b30e437', 'task/8b30e437-invite')).toBe(true);
  expect(isCompanyManagedPath('/Users/y/Library/Application Support/SurrealCKCompany/releases/abc', 'main')).toBe(false);
  expect(isCompanyManagedPath('/Users/y/.codex/worktrees/27a8/surreal_ck', undefined)).toBe(false);
  expect(isCompanyManagedPath('/Users/y/IdeaProjects/surreal_ck', 'main')).toBe(false);
});

test('exclusive clean tree without refs is immediately deletable', () => {
  const d = decideReclaim({
    path: '/tmp/repo-sck-aaa-bbbbbbbb', branch: 'task/bbbbbbbb', mode: 'exclusive',
    status: 'present', dirty: false, effectiveRefs: 0, recoveryRefs: 0,
    lastUsedAt: now,
  }, policy);
  expect(d).toMatchObject({ action: 'delete', deletable: true });
  expect(d.reasons).toContain('last-effective-ref-released');
});

test('shared and main stay protected', () => {
  expect(decideReclaim({
    path: '/tmp/repo-sck-aaa-shared', branch: 'sck/shared-aaa', mode: 'shared',
    status: 'present', dirty: false, effectiveRefs: 0, recoveryRefs: 0,
  }, policy).reasons).toContain('shared-retained');
  expect(decideReclaim({
    path: '/tmp/repo', branch: 'main', mode: 'protected', protection: 'repository-main', main: true,
    status: 'present', dirty: false, effectiveRefs: 0, recoveryRefs: 0,
  }, policy).reasons).toContain('repository-main');
});

test('recovery and dirty refs block deletion', () => {
  expect(decideReclaim({
    path: '/tmp/repo-task-aaaaaaaa', branch: 'task/aaaaaaaa', mode: 'exclusive',
    status: 'present', dirty: false, effectiveRefs: 0, recoveryRefs: 1,
  }, policy).reasons).toContain('unfinished-scene');
  expect(decideReclaim({
    path: '/tmp/repo-task-aaaaaaaa', branch: 'task/aaaaaaaa', mode: 'exclusive',
    status: 'present', dirty: true, effectiveRefs: 0, recoveryRefs: 0,
  }, policy).reasons).toContain('dirty-or-untracked');
});

test('orphan grace uses authority clock, not inventing dates', () => {
  const created = new Date(now.getTime() - 3 * day);
  expect(orphanClock({ createdAt: created })).toEqual(created);
  const within = decideReclaim({
    path: '/tmp/repo-task-cccccccc', branch: 'task/cccccccc', mode: 'protected',
    protection: 'legacy-or-release: manual adoption required',
    status: 'present', dirty: false, effectiveRefs: 0, recoveryRefs: 0,
    createdAt: created, lastUsedAt: created,
  }, policy);
  expect(within.action).toBe('wait_grace');
  expect(within.graceRemainingMs).toBeGreaterThan(0);

  const aged = decideReclaim({
    path: '/tmp/repo-task-cccccccc', branch: 'task/cccccccc', mode: 'protected',
    protection: 'legacy-or-release: manual adoption required',
    status: 'present', dirty: false, effectiveRefs: 0, recoveryRefs: 0,
    lastReleasedAt: new Date(now.getTime() - 8 * day),
  }, policy);
  expect(aged).toMatchObject({ action: 'delete', deletable: true });
  expect(aged.reasons).toContain('orphan-past-grace');
});

test('unknown ownership and disabled reclaim never delete', () => {
  const unknown = decideReclaim({
    path: '/tmp/mystery-tree', branch: 'feature/x', mode: 'protected',
    protection: 'legacy-or-release: manual adoption required',
    status: 'present', dirty: false, effectiveRefs: 0, recoveryRefs: 0,
    lastUsedAt: new Date(0),
  }, policy);
  expect(unknown.deletable).toBe(false);
  expect(unknown.action).toBe('skip');
  expect(unknown.reasons.some(r => r.includes('legacy-or-release') || r === 'unknown-ownership')).toBe(true);

  // Company-shaped path without exclusive/shared mode still needs grace / managed check, not blind delete.
  const shaped = decideReclaim({
    path: '/tmp/other-feature', branch: 'eng/issue-1', mode: 'exclusive',
    status: 'present', dirty: false, effectiveRefs: 0, recoveryRefs: 0,
    lastUsedAt: new Date(0),
  }, policy);
  expect(shaped.action).toBe('delete'); // exclusive mode is company-managed by allocation

  expect(decideReclaim({
    path: '/tmp/repo-task-aaaaaaaa', branch: 'task/aaaaaaaa', mode: 'exclusive',
    status: 'present', dirty: false, effectiveRefs: 0, recoveryRefs: 0,
  }, { ...policy, enabled: false }).reasons).toContain('reclaim-disabled');
});

test('env and config switches', () => {
  expect(reclaimEnabledFrom({ SCK_WORKTREE_RECLAIM: '0' })).toBe(false);
  expect(reclaimEnabledFrom({}, { worktree_reclaim_enabled: false })).toBe(false);
  expect(reclaimEnabledFrom({}, {})).toBe(true);
  expect(parseGraceDays('14')).toBe(14);
  expect(parseGraceDays('nope')).toBe(7);
});

test('a lane tree outlives every single task and dies with the last open one', () => {
  const tree = { path: '/tmp/repo-sck-aaa-bbbbbbbb', branch: 'lane/bbbbbbbb-billing', mode: 'exclusive' as const, status: 'present' as const, dirty: false, effectiveRefs: 0, recoveryRefs: 0, lastUsedAt: now };
  expect(isCompanyManagedPath(tree.path, tree.branch)).toBe(true);
  expect(decideReclaim({ ...tree, laneOpen: 2 }, policy)).toMatchObject({ action: 'skip', deletable: false, reasons: ['lane-open'] });
  expect(decideReclaim({ ...tree, laneOpen: 0 }, policy)).toMatchObject({ action: 'delete', deletable: true });
  expect(decideReclaim({ ...tree, laneOpen: 0, dirty: true }, policy).reasons).toEqual(['dirty-or-untracked']);
});
