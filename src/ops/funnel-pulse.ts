/**
 * Read-only projection of the CK product funnel summary (`GET /api/ops/funnel-summary`, CK #258).
 *
 * The upstream contract fixes one known event and one UTC day per call and aggregates inside the database, so no
 * row-level workspace key is ever returned. This module re-checks that contract on the company side: only the
 * declared summary state, the public aggregates and the coverage marker are projected. Unknown fields are ignored;
 * a response that contradicts the request or its own state is refused instead of being passed through. The 5/3
 * suppression floor and the single coverage reason are fixed here too, so a weakened upstream cannot leak
 * low-sample counts or introduce free-form coverage text.
 */
import { CompanyError } from '../core-errors.ts';

/** Kept in sync with CK `server/src/funnel/events.ts`; the upstream endpoint rejects any other event. */
export const FUNNEL_PULSE_EVENTS = [
  'invite_issued',
  'first_login',
  'template_created',
  'import_succeeded',
  'first_success',
  'ai_proposal_adopted',
  'return_week2',
] as const;

export type FunnelPulseEvent = typeof FUNNEL_PULSE_EVENTS[number];

export type FunnelPulseState = 'empty' | 'suppressed' | 'reported';

/**
 * Company-side suppression floor, fixed independently of the upstream response (CK #258 declares the same 5/3).
 * An upstream that reports a lower threshold, or a `reported` sample below this floor, is refused rather than
 * trusted — otherwise a lowered threshold would leak precise low-sample counts.
 */
export const FUNNEL_PULSE_MIN_TOTAL_COUNT = 5;
export const FUNNEL_PULSE_MIN_WORKSPACE_COUNT = 3;

/** The only coverage reason the contract defines; anything else is refused, never relayed. */
export const FUNNEL_PULSE_COVERAGE_REASON = 'no_collection_coverage_signal';

export interface FunnelPulseReport {
  event: FunnelPulseEvent;
  day: string;
  state: FunnelPulseState;
  /** Exact only when `reported`; `null` when suppressed, `0` when empty. */
  totalCount: number | null;
  workspaceCount: number | null;
  thresholds: { minTotalCount: number; minWorkspaceCount: number };
  coverage: { state: 'unknown'; complete: false; reason: string; source: 'funnel_event_count' };
  limits: { readOnly: true; rowLevel: false; singleEvent: true; singleUtcDay: true };
}

export function isFunnelPulseEvent(value: unknown): value is FunnelPulseEvent {
  return typeof value === 'string' && (FUNNEL_PULSE_EVENTS as readonly string[]).includes(value);
}

/** A strict YYYY-MM-DD that survives a UTC round trip (so 2026-02-30 is refused). */
export function isUtcDay(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

const inconsistent = (detail: string) =>
  new CompanyError('upstream_error', `产品漏斗汇总响应不符合契约，拒绝投影（${detail}）`, true);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;

function readThresholds(value: unknown): { minTotalCount: number; minWorkspaceCount: number } {
  if (!isRecord(value)) throw inconsistent('缺少阈值');
  const minTotalCount = value.minTotalCount;
  const minWorkspaceCount = value.minWorkspaceCount;
  if (!isCount(minTotalCount) || !isCount(minWorkspaceCount)) throw inconsistent('阈值非法');
  if (minTotalCount < FUNNEL_PULSE_MIN_TOTAL_COUNT || minWorkspaceCount < FUNNEL_PULSE_MIN_WORKSPACE_COUNT) {
    throw inconsistent('上游阈值低于公司固定下限');
  }
  return { minTotalCount, minWorkspaceCount };
}

function readCoverage(value: unknown): FunnelPulseReport['coverage'] {
  if (!isRecord(value)) throw inconsistent('缺少覆盖标记');
  if (value.state !== 'unknown' || value.complete !== false) throw inconsistent('覆盖标记不是 unknown');
  if (value.source !== 'funnel_event_count') throw inconsistent('覆盖来源非法');
  if (value.reason !== FUNNEL_PULSE_COVERAGE_REASON) throw inconsistent('覆盖原因不是契约字面量');
  return { state: 'unknown', complete: false, reason: FUNNEL_PULSE_COVERAGE_REASON, source: 'funnel_event_count' };
}

/**
 * Validates one upstream summary for the requested (event, day) and returns the projection.
 *
 * A response for another event/day, a state the contract does not define, counts that contradict the state and its
 * thresholds, or a coverage marker that claims more than "unknown" is refused. The raw body is never echoed.
 */
export function parseFunnelPulse(event: FunnelPulseEvent, day: string, body: unknown): FunnelPulseReport {
  if (!isRecord(body)) throw inconsistent('响应不是对象');
  if (body.event !== event) throw inconsistent('事件与请求不一致');
  if (body.day !== day) throw inconsistent('日期与请求不一致');
  const state = body.state;
  if (state !== 'empty' && state !== 'suppressed' && state !== 'reported') throw inconsistent('state 非法');
  const thresholds = readThresholds(body.thresholds);
  const coverage = readCoverage(body.coverage);

  let totalCount: number | null;
  let workspaceCount: number | null;
  if (state === 'empty') {
    if (body.totalCount !== 0 || body.workspaceCount !== 0) throw inconsistent('空窗计数不为零');
    totalCount = 0;
    workspaceCount = 0;
  } else if (state === 'suppressed') {
    if (body.totalCount !== null || body.workspaceCount !== null) throw inconsistent('抑制态返回了精确计数');
    totalCount = null;
    workspaceCount = null;
  } else {
    if (!isCount(body.totalCount) || !isCount(body.workspaceCount)) throw inconsistent('汇总计数非法');
    if (body.totalCount < FUNNEL_PULSE_MIN_TOTAL_COUNT || body.workspaceCount < FUNNEL_PULSE_MIN_WORKSPACE_COUNT) {
      throw inconsistent('reported 低样本低于公司固定下限');
    }
    if (body.totalCount < thresholds.minTotalCount || body.workspaceCount < thresholds.minWorkspaceCount) {
      throw inconsistent('reported 低于上游抑制阈值');
    }
    totalCount = body.totalCount;
    workspaceCount = body.workspaceCount;
  }

  return {
    event,
    day,
    state,
    totalCount,
    workspaceCount,
    thresholds,
    coverage,
    limits: { readOnly: true, rowLevel: false, singleEvent: true, singleUtcDay: true },
  };
}