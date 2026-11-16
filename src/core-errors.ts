export type CompanyErrorCode =
  'unauthorized' | 'forbidden' | 'not_found' | 'conflict' | 'invalid' |
  'worktree_busy' | 'already_claimed' | 'lease_expired' | 'self_review' | 'temporarily_unavailable' | 'checkpoint_limit' |
  'not_configured' | 'unavailable' | 'payment_approval_required' | 'upstream_error' | 'login_failed' | 'limit_reached' | 'response_too_large' | 'snapshot_gone' | 'retire_refused';

/**
 * 全部公司错误码的运行时列表。执行端把作业失败写成 `${code}: ${message}`，网关与老板端据此还原错误类别，
 * 所以列表必须与 CompanyErrorCode 一致；漏掉的码会被当成上游失败。下面的类型断言保证这一点。
 */
export const CORE_ERROR_CODES = [
  'unauthorized', 'forbidden', 'not_found', 'conflict', 'invalid', 'worktree_busy', 'already_claimed', 'lease_expired',
  'self_review', 'temporarily_unavailable', 'checkpoint_limit', 'not_configured', 'unavailable', 'payment_approval_required',
  'upstream_error', 'login_failed', 'limit_reached', 'response_too_large', 'snapshot_gone', 'retire_refused',
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
