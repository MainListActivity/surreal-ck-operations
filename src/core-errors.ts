export class CompanyError extends Error {
  constructor(
    readonly code: 'unauthorized' | 'forbidden' | 'not_found' | 'conflict' | 'invalid' |
      'worktree_busy' | 'already_claimed' | 'lease_expired' | 'self_review' | 'temporarily_unavailable' | 'checkpoint_limit' |
      'not_configured' | 'payment_approval_required' | 'upstream_error' | 'login_failed' | 'limit_reached' | 'response_too_large' | 'snapshot_gone' | 'retire_refused' |
      'dispatch_paused',
    message: string,
    readonly retryable = false,
    /** Structured facts for callers that act on the error (for example the retirement gate's reasons and legal actions). */
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'CompanyError';
  }
}
