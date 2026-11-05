// SYS-INT · QA 评审协同的持久事件唤醒（纯规则）。
//
// 真实阻塞 3cf7477d v19：协同任务用固定时间等待 QA 观察窗口，QA 的真实复核租约与结构化请求不唤醒它。
// 这里把“独立 QA 领到源任务的 review 租约”或“当前 QA 持有人发出结构化 scope 请求”收敛为一个 authorization
// 事件，把“同一 scope 正向取证完成、结构化请求撤销”收敛为一个 positive 事件。事件只解除协同任务的 SYS05
// 等待并让调度器重新派老板；它不生成 grant/revoke、不写业务验收结论、不改源任务租约、不扩大 subjects。
//
// 事件身份 = 源任务 + review fence + 事件类型（在一条订阅内）。同一 fence 的 claim 与结构化请求共享同一个
// authorization 事件（先到者生效，后到者是重复）；return/换人抬高 fence，旧 fence 的事件不能在事后交付，
// 交付前还要核对源任务仍在同一 holder 的活租约上。
import { CompanyError } from './core-errors.ts';

export const REVIEW_EVENT_KINDS = ['authorization', 'positive'] as const;
export type ReviewEventKind = typeof REVIEW_EVENT_KINDS[number];

export type ReviewSignalKind = 'request' | 'retract';

export const REVIEW_EVENT_MAX_SUBJECTS = 50;
/** Delivered/invalidated history a watch view carries; older rows stay in the table for audit. */
export const REVIEW_EVENT_VIEW_LIMIT = 20;

export const isReviewEventKind = (value: string): value is ReviewEventKind =>
  (REVIEW_EVENT_KINDS as readonly string[]).includes(value);

/** The wake identity inside one subscription: a repeat of this triple is the same event, not a second wake. */
export const reviewEventKeyOf = (sourceTaskId: string, fence: number, kind: ReviewEventKind): string =>
  `${sourceTaskId}:${fence}:${kind}`;

/** One subscription only ever binds one ordered pair of tasks; registering the same pair again is that subscription. */
export const reviewWatchKeyOf = (sourceTaskId: string, collaborationTaskId: string): string =>
  `${sourceTaskId}|${collaborationTaskId}`;

/** One QA holder has at most one structured signal per review lease. */
export const qaScopeSignalKeyOf = (taskId: string, fence: number, actor: string): string =>
  `${taskId}:${fence}:${actor}`;

/** A structured request is the authorization phase; only its positive retract is the second wake. */
export const signalEventKind = (kind: ReviewSignalKind): ReviewEventKind =>
  kind === 'request' ? 'authorization' : 'positive';

const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

/** Task ids are exact ids: no glob, wildcard or pattern is accepted, so a watch can never be widened. */
const exactTaskId = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !TASK_ID.test(value.trim())) {
    throw new CompanyError('invalid', `${field} must be one exact task id (no wildcard or pattern)`);
  }
  return value.trim();
};

export const normalizeEventKinds = (input: unknown): ReviewEventKind[] => {
  if (input === undefined || input === null) return [...REVIEW_EVENT_KINDS];
  if (!Array.isArray(input) || input.length === 0 || input.length > REVIEW_EVENT_KINDS.length) {
    throw new CompanyError('invalid', `eventKinds must be 1-${REVIEW_EVENT_KINDS.length} of ${REVIEW_EVENT_KINDS.join(' / ')}`);
  }
  const seen = new Set<ReviewEventKind>();
  for (const raw of input) {
    if (typeof raw !== 'string' || !isReviewEventKind(raw)) {
      throw new CompanyError('invalid', `eventKinds must be ${REVIEW_EVENT_KINDS.join(' / ')}`);
    }
    seen.add(raw);
  }
  return REVIEW_EVENT_KINDS.filter(kind => seen.has(kind));
};

export const sameEventKinds = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && REVIEW_EVENT_KINDS.every(kind => left.includes(kind) === right.includes(kind));

export const normalizeScopeSubjects = (input: unknown): string[] => {
  if (!Array.isArray(input) || input.length === 0 || input.length > REVIEW_EVENT_MAX_SUBJECTS) {
    throw new CompanyError('invalid', `subjects must be 1-${REVIEW_EVENT_MAX_SUBJECTS} task ids`);
  }
  const seen = new Set<string>();
  for (const raw of input) seen.add(exactTaskId(raw, 'subject'));
  return [...seen].sort();
};

export const sameSubjects = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index]);

export interface ReviewWatchPair { sourceTaskId: string; collaborationTaskId: string; }

/** Refuses a pair that is not two distinct exact task ids. Same-goal and role checks need the database and live in core. */
export function validateWatchPair(input: ReviewWatchPair): ReviewWatchPair {
  const sourceTaskId = exactTaskId(input.sourceTaskId, 'sourceTaskId');
  const collaborationTaskId = exactTaskId(input.collaborationTaskId, 'collaborationTaskId');
  if (sourceTaskId === collaborationTaskId) {
    throw new CompanyError('invalid', 'the source and the collaboration task must be two different tasks');
  }
  return { sourceTaskId, collaborationTaskId };
}

/** The live facts a wake is checked against. All are re-read at delivery time, never trusted from the event row. */
export interface ReviewSourceState {
  state?: string;
  reviewerRole?: string;
  holder?: string;
  fence?: number;
  leaseLive: boolean;
}

/**
 * Why a stored event must not be delivered now, or undefined when it still describes the live review lease.
 * A return (holder gone), a re-claim (fence moved) or an expired lease all invalidate the old event: only the
 * holder that actually holds the review at that fence can have authorized or completed anything.
 */
export function reviewEventStaleReason(source: ReviewSourceState, event: { fence: number; actor: string }): string | undefined {
  if (source.state === undefined) return 'the source task no longer exists';
  if (source.state !== 'review' || source.reviewerRole !== 'qa') return 'the source task is no longer in QA review';
  if (source.fence !== event.fence) return 'the review fence moved; the stored event belongs to an older claim';
  if (source.holder !== event.actor) return 'the review holder changed; the stored event belongs to another employee';
  if (!source.leaseLive) return 'the review lease is not live';
  return undefined;
}

export interface ReviewWatchInput {
  sourceTaskId: string;
  collaborationTaskId: string;
  eventKinds?: string[];
  reason: string;
  idempotencyKey: string;
}

export interface ReviewWatchCloseInput {
  watchId: string;
  expectedVersion: number;
  reason: string;
  idempotencyKey: string;
}

export interface ReviewWatchStatusInput { watchId?: string; sourceTaskId?: string; collaborationTaskId?: string }

export interface QaScopeSignalInput {
  taskId: string;
  fence: number;
  kind: ReviewSignalKind;
  subjects: string[];
  positiveReady?: boolean;
  reason: string;
  idempotencyKey: string;
}

export interface ReviewDeliveryView {
  eventId: string;
  kind: ReviewEventKind;
  fence: number;
  actor: string;
  at: string;
  delivered: boolean;
  deliveredAt?: string;
  /** Why the delivery did not release the collaboration wait, or why the event was invalidated. */
  code?: string;
  invalidatedReason?: string;
}

export interface ReviewSignalView {
  id: string;
  taskId: string;
  goalId: string;
  actor: string;
  fence: number;
  kind: ReviewSignalKind;
  state: 'requested' | 'retracted';
  subjects: string[];
  positiveReady: boolean;
  reason: string;
  createdAt: string;
  retractedAt?: string;
}

export interface ReviewWakeView {
  watchId: string;
  eventId: string;
  kind: ReviewEventKind;
  fence: number;
  released: boolean;
  code: string;
}

export interface ReviewWatchView {
  id: string;
  goalId: string;
  sourceTaskId: string;
  collaborationTaskId: string;
  eventKinds: string[];
  state: 'active' | 'closed';
  version: number;
  reason: string;
  createdAt: string;
  closedAt?: string;
  closedReason?: string;
  /** The live source facts at read time; a stale watch is visible instead of silently assumed. */
  source: { state?: string; reviewerRole?: string; holder?: string; fence?: number; leaseLive: boolean };
  signal?: ReviewSignalView;
  deliveries: ReviewDeliveryView[];
  guidance: string;
}

export interface QaScopeSignalView {
  signal: ReviewSignalView;
  event: { kind: ReviewEventKind; created: boolean; fence: number };
  woken: ReviewWakeView[];
  guidance: string;
}

export const REVIEW_WATCH_GUIDANCE =
  'This watch only wakes the registered collaboration task through its SYS05 feedback wait. It grants no scope, '
  + 'changes no task lease and signs no acceptance. Checkpoint text such as SCOPE_REQUEST or SCOPE_POSITIVE_READY '
  + 'is a hint only: only qa_review_scope_signal from the live review holder creates a signal.';

export const REVIEW_SIGNAL_GUIDANCE =
  'The signal carries task ids only (no task text, no credentials). A request wakes the collaboration task once per '
  + 'review fence; the positive retract (positiveReady=true) wakes it a second time. It neither grants a QA scope nor '
  + 'accepts anything.';
