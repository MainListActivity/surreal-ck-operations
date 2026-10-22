/** Only provider error envelopes are evidence; task text mentioning quotas is not. */
export const QUOTA_ERROR = /usage cap reached|model_usage_exhausted|usage_exhausted|out of credits|credits exhausted|out of usage|quota|usage limit|rate.?limit|too many requests|\b402\b|\b429\b|credit balance|balance exhausted|payment required|billing|limit reached|at capacity/i;
export const QUOTA_RELEASE = '【基础设施：订阅额度耗尽】';
type Outcome = { kind: string; error?: { message: string; code?: string } };
type Item = { type: string; text?: string; message?: string };

export function quotaFailure(outcome: Outcome, timeline: readonly Item[], now = Date.now()): { reason: string; resetsAt?: number } | undefined {
  if (outcome.kind === 'canceled') return;
  let error = outcome.kind === 'failed' ? `${outcome.error?.code ?? ''} ${outcome.error?.message ?? ''}` : '';
  if (!QUOTA_ERROR.test(error)) {
    // The lifecycle timeline belongs to this turn. Only its last substantive item can
    // prove an unresolved failure; a recovered error earlier in the turn cannot.
    const last = [...timeline].reverse().find(i => !['reasoning', 'todo', 'notification'].includes(i.type));
    error = last?.type === 'error' ? last.message ?? ''
      : last?.type === 'assistant_message' && /^\s*(?:API Error:|\[System Error\]|Error:)/i.test(last.text ?? '') ? last.text! : '';
  }
  if (!QUOTA_ERROR.test(error)) return;
  // A clock without an offset is ambiguous (magpie and the host may use different
  // timezones). Let the existing bounded backoff handle it instead of guessing.
  const stamp = error.match(/\b(?:until|resets? (?:at|on))\s+(\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d))/i)?.[1];
  const reset = stamp ? Date.parse(stamp) : NaN;
  return { reason: '订阅额度耗尽/限流（API 拒绝）',
    ...(reset > now && reset <= now + 14 * 86400000 ? { resetsAt: Math.floor(reset / 1000) } : {}) };
}
