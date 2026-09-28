export class CompanyError extends Error {
  constructor(
    readonly code: 'unauthorized' | 'forbidden' | 'not_found' | 'conflict' | 'invalid' |
      'already_claimed' | 'lease_expired' | 'self_review' | 'temporarily_unavailable',
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'CompanyError';
  }
}
