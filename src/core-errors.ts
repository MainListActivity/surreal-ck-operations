export class CompanyError extends Error {
  constructor(
    readonly code: 'unauthorized' | 'forbidden' | 'not_found' | 'conflict' | 'invalid' |
      'worktree_busy' | 'already_claimed' | 'lease_expired' | 'self_review' | 'temporarily_unavailable' | 'checkpoint_limit' |
      'not_configured' | 'payment_approval_required' | 'upstream_error' | 'login_failed' | 'limit_reached' |
      'response_too_large' | 'snapshot_gone',
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'CompanyError';
  }
}
