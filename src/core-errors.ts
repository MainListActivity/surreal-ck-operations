export type CompanyErrorCode =
  'unauthorized' | 'forbidden' | 'not_found' | 'conflict' | 'invalid' |
  'worktree_busy' | 'already_claimed' | 'lease_expired' | 'self_review' | 'temporarily_unavailable' | 'checkpoint_limit' |
  'not_configured' | 'unavailable' | 'payment_approval_required' | 'upstream_error' | 'login_failed' | 'limit_reached' | 'response_too_large' | 'snapshot_gone' | 'retire_refused' |
  // A submit waits on CI that has not finished (queued, running, or not started yet): a normal wait, retryable.
  'ci_pending' |
  // CI ran for the submitted sha and no run succeeded: the work cannot be verified as it stands.
  'ci_failed';

/**
 * 全部公司错误码的运行时列表。执行端把作业失败写成 `${code}: ${message}`，网关与老板端据此还原错误类别，
 * 所以列表必须与 CompanyErrorCode 一致；漏掉的码会被当成上游失败。下面的类型断言保证这一点。
 */
export const CORE_ERROR_CODES = [
  'unauthorized', 'forbidden', 'not_found', 'conflict', 'invalid', 'worktree_busy', 'already_claimed', 'lease_expired',
  'self_review', 'temporarily_unavailable', 'checkpoint_limit', 'not_configured', 'unavailable', 'payment_approval_required',
  'upstream_error', 'login_failed', 'limit_reached', 'response_too_large', 'snapshot_gone', 'retire_refused',
  'ci_pending', 'ci_failed',
] as const satisfies readonly CompanyErrorCode[];

/** 编译期检查：联合类型里的每个码都在上面的列表里；少列一个，这一行就是类型错误。 */
type AssertNever<T extends never> = T;
export type UnlistedErrorCode = AssertNever<Exclude<CompanyErrorCode, (typeof CORE_ERROR_CODES)[number]>>;

export class CompanyError extends Error {
  constructor(
    readonly code: CompanyErrorCode,
    message: string,
    readonly retryable = false,
    /** Structured facts a caller can act on: the retirement gate's reasons and legal actions
     * (task, source, employee). Never credentials. */
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'CompanyError';
  }
}

export type RepoLockState = 'busy' | 'unavailable' | 'lost';

/**
 * The repository allocation lock was not taken, or was lost before the action ran. Nothing was allocated or written, and the
 * cause is the host's lock rather than an employee or a provider, so the caller retries on a later pass. `lock` says which:
 * 'busy' (not taken within the acquire limit), 'unavailable' (the lock helper could not start, or ended before taking the
 * lock) or 'lost' (the helper ended after taking the lock, before the action started). See host-node.ts withRepoLock.
 */
export class RepoLockError extends CompanyError {
  constructor(readonly lock: RepoLockState, message: string) {
    super('conflict', message, true);
    this.name = 'RepoLockError';
  }
}

/** True for a RepoLockError, also when it was made by another copy of this module (the plugin bundle vendors its own). */
export function isRepoLockError(error: unknown): error is RepoLockError {
  return error instanceof RepoLockError || (error instanceof Error && error.name === 'RepoLockError');
}
