import { basename } from 'node:path';
import type { WorktreeAssignment } from '../contracts.ts';

/** Path / branch patterns that identify company-managed task scenes (not releases or external tools). */
const PATH_MANAGED = /-(?:task|wt|review|sck-[0-9a-f]+)-[0-9a-f]{8}$/i;
const BRANCH_MANAGED = /^(?:task|lane)\/[0-9a-f]{8}(?:-[\w./-]+)?$/i;
const SHARED_PATH = /-sck-[0-9a-f]+-shared$/i;
const SHARED_BRANCH = /^sck\/shared-[0-9a-f]+$/i;
const RELEASE_MARKER = /\/SurrealCKCompany\/releases\//i;
const EXTERNAL_TOOL = /\/\.codex\/worktrees\//i;

export type ReclaimTrigger = 'accept' | 'sweep' | 'manual' | 'expire' | 'retire' | 'dry_run' | 'return' | 'revoke' | 'release';
export type ReclaimAction = 'delete' | 'skip' | 'wait_grace' | 'retain_branch';

export interface ReclaimDecision {
  action: ReclaimAction;
  deletable: boolean;
  reasons: string[];
  graceRemainingMs?: number;
  companyManaged: boolean;
}

export interface ReclaimPolicy {
  enabled: boolean;
  orphanGraceMs: number;
  now: Date;
}

export interface TreeVerdictInput {
  path: string;
  branch?: string;
  mode: WorktreeAssignment['mode'];
  protection?: string;
  main?: boolean;
  status: 'present' | 'missing' | 'drift';
  dirty: boolean;
  effectiveRefs: number;
  recoveryRefs: number;
  /** Non-terminal tasks of the tree's lane: a lane tree outlives every single task and dies with the last one. */
  laneOpen?: number;
  createdAt?: Date;
  lastUsedAt?: Date;
  lastReleasedAt?: Date;
}

export function isCompanyManagedPath(path: string, branch?: string): boolean {
  if (RELEASE_MARKER.test(path) || EXTERNAL_TOOL.test(path)) return false;
  const name = basename(path);
  if (SHARED_PATH.test(name) || (branch && SHARED_BRANCH.test(branch))) return true;
  if (PATH_MANAGED.test(name)) return true;
  if (branch && BRANCH_MANAGED.test(branch)) return true;
  return false;
}

export function isProtectedAlways(input: Pick<TreeVerdictInput, 'path' | 'mode' | 'protection' | 'main' | 'branch'>): string | undefined {
  if (input.main) return 'repository-main';
  if (input.mode === 'shared') return 'shared-retained';
  if (input.protection === 'repository-main') return 'repository-main';
  if (RELEASE_MARKER.test(input.path)) return 'active-or-rollback-release';
  if (EXTERNAL_TOOL.test(input.path)) return 'external-tool-tree';
  if (input.mode === 'protected' && input.protection && !isCompanyManagedPath(input.path, input.branch)) {
    return input.protection;
  }
  return undefined;
}

/** Authority clock for orphan grace: last release, else last use, else first registration. Never file mtime. */
export function orphanClock(input: Pick<TreeVerdictInput, 'lastReleasedAt' | 'lastUsedAt' | 'createdAt'>): Date | undefined {
  return input.lastReleasedAt ?? input.lastUsedAt ?? input.createdAt;
}

export function decideReclaim(input: TreeVerdictInput, policy: ReclaimPolicy): ReclaimDecision {
  const reasons: string[] = [];
  const companyManaged = isCompanyManagedPath(input.path, input.branch) || input.mode === 'exclusive' || input.mode === 'shared';
  const hard = isProtectedAlways(input);
  if (hard) {
    reasons.push(hard);
    if (input.effectiveRefs) reasons.push('active-reference');
    if (input.recoveryRefs) reasons.push('unfinished-scene');
    if (input.dirty) reasons.push('dirty-or-unavailable');
    if (input.status !== 'present') reasons.push(input.status);
    return { action: 'skip', deletable: false, reasons, companyManaged };
  }
  if (!policy.enabled) {
    return { action: 'skip', deletable: false, reasons: ['reclaim-disabled'], companyManaged };
  }
  if (input.effectiveRefs > 0) {
    return { action: 'skip', deletable: false, reasons: ['active-reference'], companyManaged };
  }
  if (input.recoveryRefs > 0) {
    return { action: 'skip', deletable: false, reasons: ['unfinished-scene'], companyManaged };
  }
  if (input.laneOpen) {
    return { action: 'skip', deletable: false, reasons: ['lane-open'], companyManaged };
  }
  if (input.status === 'missing') {
    return { action: 'skip', deletable: false, reasons: ['missing'], companyManaged };
  }
  if (input.status === 'drift') {
    return { action: 'skip', deletable: false, reasons: ['drift'], companyManaged };
  }
  if (input.dirty) {
    return { action: 'skip', deletable: false, reasons: ['dirty-or-untracked'], companyManaged };
  }
  if (!companyManaged) {
    return { action: 'skip', deletable: false, reasons: ['unknown-ownership'], companyManaged: false };
  }

  // Managed exclusive (and clean company task trees) with no effective refs: reclaim immediately.
  const immediate = input.mode === 'exclusive' || (companyManaged && input.mode !== 'protected');
  if (immediate && input.mode === 'exclusive') {
    return { action: 'delete', deletable: true, reasons: ['last-effective-ref-released'], companyManaged };
  }

  // Orphan sweep for confirmed company-managed trees (including adopted legacy task scenes).
  const clock = orphanClock(input);
  if (!clock) {
    return { action: 'skip', deletable: false, reasons: ['no-authority-clock'], companyManaged };
  }
  const age = policy.now.getTime() - clock.getTime();
  if (age < policy.orphanGraceMs) {
    return {
      action: 'wait_grace',
      deletable: false,
      reasons: ['within-orphan-grace'],
      graceRemainingMs: policy.orphanGraceMs - age,
      companyManaged,
    };
  }
  return { action: 'delete', deletable: true, reasons: ['orphan-past-grace'], companyManaged };
}

export function parseGraceDays(raw: unknown, fallback = 7): number {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : fallback;
  if (!Number.isFinite(n) || n < 0 || n > 3650) return fallback;
  return Math.floor(n);
}

export function reclaimEnabledFrom(env: NodeJS.ProcessEnv, config?: { worktree_reclaim_enabled?: boolean }): boolean {
  if (env.SCK_WORKTREE_RECLAIM === '0' || env.SCK_WORKTREE_RECLAIM === 'false') return false;
  if (env.SCK_WORKTREE_RECLAIM === '1' || env.SCK_WORKTREE_RECLAIM === 'true') return true;
  if (config && typeof config.worktree_reclaim_enabled === 'boolean') return config.worktree_reclaim_enabled;
  return true;
}
