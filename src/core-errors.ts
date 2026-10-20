export class CompanyError extends Error {
  constructor(
    readonly code: 'unauthorized' | 'forbidden' | 'not_found' | 'conflict' | 'invalid' |
      'worktree_busy' | 'already_claimed' | 'lease_expired' | 'self_review' | 'temporarily_unavailable' | 'checkpoint_limit' |
      'not_configured' | 'payment_approval_required' | 'upstream_error' | 'login_failed' | 'limit_reached',
    message: string,
    readonly retryable = false,
    /** Structured reason a caller can act on (independence conflicts name the task, source and employee). Never credentials. */
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'CompanyError';
  }
}
