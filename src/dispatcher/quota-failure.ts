/** Only provider error envelopes are evidence; task text mentioning quotas is not. */
export const QUOTA_ERROR = /usage cap reached|model_usage_exhausted|usage_exhausted|out of credits|credits exhausted|out of usage|quota|usage limit|rate.?limit|too many requests|\b402\b|\b429\b|credit balance|balance exhausted|payment required|billing|limit reached|at capacity/i;
export const QUOTA_RELEASE = '【基础设施：订阅额度耗尽】';
type Outcome = { kind: string; error?: { message: string; code?: string } };
type Item = { type: string; text?: string; message?: string };

const RESET_LEAD = String.raw`\b(?:until|resets? (?:at|on))\s+`;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
/** magpie's heldClock: today HH:MM UTC±H[:MM], otherwise Mon D HH:MM UTC±H[:MM]. */
function resetTime(error: string, now: number): number | undefined {
  const candidates: number[] = [];
  for (const m of error.matchAll(new RegExp(RESET_LEAD + String.raw`(\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d))`, 'gi'))) {
    candidates.push(Date.parse(m[1]!));
  }
  const clock = new RegExp(RESET_LEAD + String.raw`(?:(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})\s+)?(\d{2}):(\d{2})\s+UTC([+-])(\d{1,2})(?::(\d{2}))?(?![\d:])`, 'gi');
  for (const m of error.matchAll(clock)) {
    const hour = Number(m[3]), minute = Number(m[4]), offsetHour = Number(m[6]), offsetMinute = Number(m[7] ?? 0);
    if (hour > 23 || minute > 59 || offsetHour > 14 || offsetMinute > 59 || offsetHour === 14 && offsetMinute !== 0) continue;
    const offset = (m[5] === '-' ? -1 : 1) * (offsetHour * 60 + offsetMinute) * 60000;
    const local = new Date(now + offset);
    const month = m[1] ? MONTHS.indexOf(m[1].toLowerCase()) : local.getUTCMonth();
    const day = m[2] ? Number(m[2]) : local.getUTCDate();
    // A date may cross New Year. A clock without a date means today in the
    // stated offset; a stale message must not invent another day of cooldown.
    for (const year of m[1] ? [local.getUTCFullYear(), local.getUTCFullYear() + 1] : [local.getUTCFullYear()]) {
      const wall = new Date(Date.UTC(year, month, day, hour, minute));
      if (wall.getUTCMonth() !== month || wall.getUTCDate() !== day) continue;
      candidates.push(wall.getTime() - offset);
    }
  }
  const valid = candidates.filter(t => t > now && t <= now + 14 * 86400000);
  return valid.length ? Math.floor(Math.min(...valid) / 1000) : undefined;
}

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
  // No explicit offset/date interpretation: retain the bounded-backoff fallback.
  const resetsAt = resetTime(error, now);
  return { reason: '订阅额度耗尽/限流（API 拒绝）',
    ...(resetsAt !== undefined ? { resetsAt } : {}) };
}
