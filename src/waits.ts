/**
 * SYS05 · P1 typed waits on time and on trusted external events.
 *
 * A wait is a scheduling fact, not a sentence an employee writes. The employee states *why* it stops (a time,
 * a dependency, an upstream repair, a customer activation, an owner handoff, feedback), *who* is awaited, *when*
 * the condition may become true and *which trusted source* may say it did. The task then leaves the execution
 * queue with no lease and no employee capacity attached; the dispatcher releases only the condition itself.
 *
 * The rules this module encodes:
 *
 * 1. Time is an absolute instant, stored as epoch milliseconds. A display timezone never changes when the
 *    condition becomes true, so a daylight-saving transition cannot move a wake by an hour. A time without an
 *    explicit offset is refused instead of read in the host's local zone.
 * 2. Time releases time — nothing else. A due time never substitutes for an unfinished dependency or an owner
 *    decision: those gates are checked separately and hold the task.
 * 3. An external condition moves only on a typed event from a trusted source (a signed webhook, an authorized
 *    manager, or the owner relay). An employee saying it received feedback is not an event, and a duplicate,
 *    expired or wrongly-addressed event is refused.
 * 4. Unknown is a first-class answer. A handoff whose tool never returned a precise expiry is `unknown`; it is
 *    never computed from a duration and presented as if the provider had said it.
 *
 * The module is pure: no database, no I/O, no clock of its own. Callers pass `now`, so the arithmetic is exact in
 * tests and the same facts produce the same decision in the dispatcher, the core and the channel.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { CompanyError } from './core-errors.ts';

/** Why the task waits. The vocabulary is part of the contract; free text goes in `reason`. */
export const WAIT_KINDS = ['time', 'dependency', 'upstream_repair', 'customer_activation', 'owner_handoff', 'feedback'] as const;
export type WaitKind = typeof WAIT_KINDS[number];

/** Who may say the condition changed. `time` is the clock itself; the others are trusted sources. */
export const WAIT_SOURCE_KINDS = ['time', 'dependency', 'webhook', 'authorized_person', 'owner'] as const;
export type WaitSourceKind = typeof WAIT_SOURCE_KINDS[number];

/** The lifecycle of one wait episode. `waiting` is the only state that can release. */
export const WAIT_STATES = ['waiting', 'released', 'held', 'expired', 'cancelled', 'superseded'] as const;
export type WaitState = typeof WAIT_STATES[number];

/** Where a precise expiry came from. `unknown` is not a placeholder for "no expiry yet": it means no tool said one. */
export type ExpirySource = 'exact' | 'unknown';

export interface WaitSource {
  kind: WaitSourceKind;
  /** For webhook events: the provider that signed it (e.g. resend, github, product). */
  provider?: string;
  /** Optional named account the event belongs to; never a credential. */
  account?: string;
}

/** What the employee hands over when it stops. Progress is a snapshot, not a claim about the outside world. */
export interface WaitProgress {
  /** The holder that stopped, and the task version it held. Late writes from it must not revive this lease. */
  employee: string;
  taskVersion: number;
  /** Unix ms when the wait was entered. */
  at: number;
  /** The last resumable checkpoint text, already clipped and sanitized. */
  summary?: string;
}

/** One normalized wait. This is the shape stored and the shape every decision reads. */
export interface WaitRecord {
  waitKey: string;
  taskId: string;
  kind: WaitKind;
  state: WaitState;
  source: WaitSource;
  /** The role (or `owner`) that owns the condition. */
  ownerRole: string;
  /** Non-sensitive reference of the handed-off item (an id, a ticket key), never a link carrying a secret. */
  reference?: string;
  /** For dependency and upstream repairs: the exact task whose completion is the condition. */
  referenceTaskId?: string;
  /** The absolute instant (unix ms) from which the time condition is true. */
  notBefore?: number;
  /** The precise expiry the tool returned, unix ms; absent means `expiresSource = unknown`. */
  expiresAt?: number;
  expiresSource: ExpirySource;
  /** The next time a human or a poll should look at a condition that has not answered. */
  nextCheckAt?: number;
  /** IANA display zone only; it never participates in the release arithmetic. */
  timezone?: string;
  progress: WaitProgress;
  /** Technical items already completed, for the owner handoff card. Sanitized, bounded. */
  completed: string[];
  /** The concrete action the owner must take. */
  pendingAction?: string;
  /** A controlled handoff file that holds the actual secret material; only its name is ever exposed. */
  handoffFile?: string;
  reason: string;
  version: number;
  enteredAt: number;
}

/** The gates that hold a condition even when its own trigger fired. */
export interface WaitGates {
  /** All recorded dependencies of the task are done or void. */
  dependenciesSatisfied: boolean;
  /** The owner really decided (through the owner relay), not a model saying so. */
  ownerApproved: boolean;
  /** The task is blocked for an owner gate: no wait may walk past it. */
  taskBlockedToOwner: boolean;
  /** A dependency reference task is done or void (for dependency / upstream_repair waits). */
  referenceComplete?: boolean;
}

/** The outcome of one release check. The code is machine-readable; the message is for the employee. */
export interface WaitDecision {
  release: boolean;
  code: 'released' | 'early' | 'awaiting_event' | 'event_mismatch' | 'duplicate_event' | 'expired'
    | 'owner_gate' | 'dependency' | 'not_waiting' | 'no_object';
  message: string;
  /** The next instant the condition could change, when it is a time condition. */
  nextAt?: number;
}

/** The raw fields an employee passes to `wait_task`. */
export interface WaitInput {
  kind: WaitKind | string;
  ownerRole?: string;
  reference?: string;
  referenceTaskId?: string;
  notBefore?: string;
  expiresAt?: string;
  nextCheckAt?: string;
  timezone?: string;
  completed?: string[];
  pendingAction?: string;
  handoffFile?: string;
  reason?: string;
  summary?: string;
}

/** The normalized form, ready to persist. */
export interface NormalizedWait {
  kind: WaitKind;
  source: WaitSource;
  ownerRole: string;
  reference?: string;
  referenceTaskId?: string;
  notBefore?: number;
  expiresAt?: number;
  expiresSource: ExpirySource;
  nextCheckAt?: number;
  timezone?: string;
  completed: string[];
  pendingAction?: string;
  handoffFile?: string;
  reason: string;
  summary?: string;
}

const invalid = (message: string): never => { throw new CompanyError('invalid', message); };

/** A secret-shaped string: a credential, a signed URL, or an invitation link. It may not enter a wait or a card. */
const SECRET_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/, 'JWT'],
  [/\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{10,}/, 'provider token'],
  [/\bsk-[A-Za-z0-9_-]{12,}/, 'API key'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/, 'Slack token'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i, 'bearer token'],
  [/\b[A-Za-z0-9_-]*(?:token|secret|password|passwd|api_?key|access_?key|signature|sig)=[A-Za-z0-9._%~+/=-]{8,}/i, 'signed URL parameter'],
  [/\b(?:invite|activation|reset)[-_]?(?:link|url|token)\b/i, 'invitation material'],
];
// Standard base64 with both cases and digits. Hyphenated ids and hex SHAs are identifiers employees legitimately
// cite, so the heuristic excludes `-`/`_` and requires 60+ characters instead of flagging every UUID-shaped key.
const B64_BLOB = /\b(?=[A-Za-z0-9+/=]*[A-Z])(?=[A-Za-z0-9+/=]*[a-z])(?=[A-Za-z0-9+/=]*\d)[A-Za-z0-9+/=]{60,}\b/;

/** Refuses a text that looks like it carries a credential or a secret-bearing link. Bounded and applied to every stored field. */
export function assertNonSensitive(text: string, field: string): string {
  for (const [pattern, label] of SECRET_PATTERNS) {
    if (pattern.test(text)) invalid(`${field} 不能包含${label}或带密钥的链接；只写非敏感的引用（id、文件名），secret 留在受控 handoff 文件里`);
  }
  if (B64_BLOB.test(text)) invalid(`${field} 看起来包含一段高熵密钥材料；只写非敏感的引用`);
  return text;
}

/** A timezone is display metadata only; it must still be a real IANA zone, never a UTC offset standing in for one. */
export function isTimeZone(zone: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(zone)) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); return true; } catch { return false; }
}

const OFFSET_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Parses one absolute instant. An ISO date-time without an explicit offset is refused: reading it in the host's
 * local zone would move a wake by the host's offset, which is exactly the day-light-saving mistake this package
 * removes. A plain integer is epoch milliseconds.
 */
export function parseInstant(value: unknown, field: string): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value) || value < 0) invalid(`${field} 必须是正的毫秒时刻`);
    return value;
  }
  if (typeof value !== 'string') invalid(`${field} 必须是 ISO 8601 时刻并带时区偏移（如 2026-10-26T10:00:00+08:00）或毫秒数`);
  const text = (value as string).trim();
  if (!text) invalid(`${field} 必须是 ISO 8601 时刻并带时区偏移（如 2026-10-26T10:00:00+08:00）或毫秒数`);
  if (!OFFSET_INSTANT.test(text)) {
    invalid(`${field} 必须带明确时区偏移（Z 或 ±HH:MM）；不带偏移的本地时间会被拒绝，避免按宿主机时区算出错误的唤醒时刻`);
  }
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) invalid(`${field} 不是合法的 ISO 8601 时刻`);
  return parsed;
}

const bounded = (value: unknown, field: string, min: number, max: number): string | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') invalid(`${field} 必须是文本`);
  const text = (value as string).trim();
  if (text.length < min || text.length > max) invalid(`${field} 需为 ${min}-${max} 字`);
  return assertNonSensitive(text, field);
};

const strList = (value: unknown, field: string): string[] => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 10) invalid(`${field} 最多 10 项`);
  return (value as unknown[]).map((item: unknown, index: number) => {
    if (typeof item !== 'string') invalid(`${field}[${index}] 必须是文本`);
    const text = (item as string).trim();
    if (text.length === 0 || text.length > 240) invalid(`${field}[${index}] 需为 1-240 字`);
    return assertNonSensitive(text, `${field}[${index}]`);
  });
};

/** The kinds that can be satisfied only by a typed external event. */
export const EVENT_KINDS: ReadonlySet<WaitKind> = new Set(['customer_activation', 'feedback']);
/** The kinds whose condition is another task's terminal state. */
export const DEPENDENCY_KINDS: ReadonlySet<WaitKind> = new Set(['dependency', 'upstream_repair']);

const isKind = (value: string): value is WaitKind => (WAIT_KINDS as readonly string[]).includes(value);

/**
 * Normalizes and validates what an employee handed over. Refusals happen before the lease is released, so a bad
 * wait never leaves the task parked with no way to release it.
 */
export function normalizeWait(input: WaitInput, context: { now: number; ownerRole: string }): NormalizedWait {
  if (typeof input.kind !== 'string' || !isKind(input.kind)) {
    invalid(`kind 必须是 ${WAIT_KINDS.join(' / ')} 之一`);
  }
  const kind = input.kind as WaitKind;
  const reason = bounded(input.reason, 'reason', 10, 2000);
  if (!reason) invalid('reason 需为 10-2000 字，说明为什么等待');
  const reasonText = reason as string;
  const summary = bounded(input.summary, 'summary', 0, 1000);
  const reference = bounded(input.reference, 'reference', 0, 240);
  const completed = strList(input.completed, 'completed');
  const pendingAction = bounded(input.pendingAction, 'pendingAction', 0, 600);
  const handoffFile = bounded(input.handoffFile, 'handoffFile', 0, 300);
  const timezone = input.timezone === undefined || input.timezone === null ? undefined : String(input.timezone).trim();
  if (timezone !== undefined && !isTimeZone(timezone)) invalid(`timezone 必须是有 IANA 名称的显示时区（如 Asia/Shanghai），不能只写偏移`);
  const ownerRole = (input.ownerRole ?? context.ownerRole).trim();
  if (!ownerRole) invalid('ownerRole 必须写明谁负责解除这个等待');
  if (ownerRole.length > 60) invalid('ownerRole 最长 60 字');

  const notBefore = input.notBefore === undefined || input.notBefore === null
    ? undefined : parseInstant(input.notBefore, 'notBefore');
  const expiresAt = input.expiresAt === undefined || input.expiresAt === null
    ? undefined : parseInstant(input.expiresAt, 'expiresAt');
  const nextCheckAt = input.nextCheckAt === undefined || input.nextCheckAt === null
    ? undefined : parseInstant(input.nextCheckAt, 'nextCheckAt');

  let source: WaitSource;
  if (kind === 'time') {
    if (notBefore === undefined) invalid('时间等待必须给出 notBefore（带时区偏移的绝对时刻）');
    const due = notBefore as number;
    if (due < context.now - 1_000) invalid('notBefore 不能早于现在；已经到点的工作不应进入等待');
    if (expiresAt !== undefined && expiresAt <= due) invalid('expiresAt 必须晚于 notBefore');
    source = { kind: 'time' };
  } else if (DEPENDENCY_KINDS.has(kind)) {
    const referenceTaskId = bounded(input.referenceTaskId, 'referenceTaskId', 1, 200);
    if (!referenceTaskId) invalid(`${kind} 等待必须给出 referenceTaskId`);
    source = { kind: 'dependency' };
    if (notBefore !== undefined && notBefore < context.now - 1_000) invalid('notBefore 不能早于现在');
    if (expiresAt !== undefined && expiresAt <= context.now) invalid('expiresAt 必须晚于现在');
  } else if (kind === 'owner_handoff') {
    if (!completed.length) invalid('owner_handoff 等待必须列出已完成的技术项（completed）');
    if (!pendingAction) invalid('owner_handoff 等待必须写明待老板执行的动作（pendingAction）');
    source = { kind: 'owner' };
    if (notBefore !== undefined && notBefore < context.now - 1_000) invalid('notBefore 不能早于现在');
    if (expiresAt !== undefined && expiresAt <= context.now) invalid('expiresAt 必须晚于现在');
  } else {
    if (notBefore !== undefined) invalid(`${kind} 等待不是时间条件，不能给 notBefore`);
    if (expiresAt !== undefined && expiresAt <= context.now) invalid('expiresAt 必须晚于现在');
    source = { kind: kind === 'customer_activation' ? 'webhook' : 'authorized_person' };
  }
  if (nextCheckAt !== undefined && nextCheckAt <= context.now) invalid('nextCheckAt 必须晚于现在');
  if (expiresAt !== undefined && nextCheckAt !== undefined && nextCheckAt > expiresAt) invalid('nextCheckAt 不能晚于 expiresAt');

  return {
    kind, source, ownerRole,
    ...(reference === undefined ? {} : { reference }),
    ...(input.referenceTaskId === undefined || input.referenceTaskId === null ? {} : { referenceTaskId: String(input.referenceTaskId).trim() }),
    ...(notBefore === undefined ? {} : { notBefore }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
    expiresSource: expiresAt === undefined ? 'unknown' : 'exact',
    ...(nextCheckAt === undefined ? {} : { nextCheckAt }),
    ...(timezone === undefined || timezone === '' ? {} : { timezone }),
    completed,
    ...(pendingAction === undefined ? {} : { pendingAction }),
    ...(handoffFile === undefined ? {} : { handoffFile }),
    reason: reasonText,
    ...(summary === undefined || summary === '' ? {} : { summary }),
  };
}

/** The event an external source delivers. It names its object, so a wrong-object event is refused, not guessed at. */
export interface WaitEventInput {
  source: WaitSourceKind | string;
  provider?: string;
  account?: string;
  /** The provider's idempotency id. Required for a webhook, strongly recommended elsewhere. */
  eventId?: string;
  /** When the source says the event happened, epoch ms or ISO with an offset. */
  at?: string | number;
  /** Exactly one of the two must match the wait. */
  objectWaitId?: string;
  objectTaskId?: string;
  /** The owner's own words, for an owner decision transcribed through the owner relay. */
  ownerQuote?: string;
  /** The payload digest the webhook signature covered. */
  payloadDigest?: string;
}

export interface WaitEvent {
  source: WaitSourceKind;
  provider?: string;
  account?: string;
  eventId?: string;
  at: number;
  objectWaitId?: string;
  objectTaskId?: string;
  ownerQuote?: string;
  payloadDigest?: string;
  /** True only when a trusted channel verified a signature before calling core. */
  verified: boolean;
}

/** The canonical key that makes one source event count once for one wait. */
export function waitEventKey(waitKey: string, event: Pick<WaitEvent, 'source' | 'provider' | 'eventId'>): string | undefined {
  if (!event.eventId) return undefined;
  return [waitKey, event.source, event.provider ?? '-', event.eventId].join('|');
}

/**
 * Validates one external event against its wait. `verified` is set only by the channel that verified a webhook
 * signature; an authorized manager or the owner relay is trusted by role, and the core sets the flag there.
 */
export function validateEvent(wait: WaitRecord, input: WaitEventInput, now: number, trusted: { verified?: boolean } = {}): WaitEvent {
  const source = String(input.source ?? '');
  if (!(WAIT_SOURCE_KINDS as readonly string[]).includes(source)) invalid(`source 必须是 ${WAIT_SOURCE_KINDS.join(' / ')} 之一`);
  const kind = source as WaitSourceKind;
  if (kind === 'time') invalid('time 来源不能解除外部事件等待；取消请用 cancel_wait，延期请用 extend_wait');
  if (wait.kind === 'time') invalid('时间等待只由时钟解除；提前解除请用 cancel_wait');
  // Wrong object is the most common replay: an event for another task must never release this one.
  const objectWaitId = input.objectWaitId === undefined ? undefined : String(input.objectWaitId).trim();
  const objectTaskId = input.objectTaskId === undefined ? undefined : String(input.objectTaskId).trim();
  if (!objectWaitId && !objectTaskId) invalid('事件必须写明 objectWaitId 或 objectTaskId（错误对象的事件会被拒绝）');
  if (objectWaitId && objectWaitId !== wait.waitKey) invalid('事件对象不是这个等待（objectWaitId 不匹配）');
  if (objectTaskId && objectTaskId !== wait.taskId) invalid('事件对象不是这个任务（objectTaskId 不匹配）');
  if (wait.kind === 'owner_handoff' && kind !== 'owner') invalid('owner_handoff 只能由老板通过 owner relay 的决定解除，模型自称收到反馈不算');
  if (wait.kind === 'customer_activation' && !['webhook', 'authorized_person', 'owner'].includes(kind)) {
    invalid('customer_activation 只能由受信 webhook 或授权人确认解除');
  }
  if (wait.kind === 'upstream_repair' && !['dependency', 'authorized_person', 'webhook'].includes(kind)) {
    invalid('upstream_repair 只能由修复任务完成或授权人确认解除');
  }
  if (wait.kind === 'feedback' && !['authorized_person', 'webhook', 'owner'].includes(kind)) {
    invalid('feedback 只能由授权人或受信 webhook 确认解除');
  }
  const at = input.at === undefined ? now : parseInstant(input.at, 'at');
  // A future-dated event is not evidence that the condition already happened.
  if (at > now + 300_000) invalid('事件时间晚于现在，不能提前解除等待');
  if (at < wait.enteredAt - 300_000) invalid('事件早于等待创建，不能解除这个等待');
  if (wait.expiresAt !== undefined && at > wait.expiresAt) invalid('事件发生在等待到期之后，不能解除；如需继续请先延期');
  const eventId = input.eventId === undefined ? undefined : String(input.eventId).trim();
  if (kind === 'webhook') {
    if (!trusted.verified) invalid('webhook 事件必须经过签名校验；未验证的调用不能解除等待');
    if (!eventId) invalid('webhook 事件必须带 provider 的事件 id（用于去重）');
    if (!input.provider || !String(input.provider).trim()) invalid('webhook 事件必须带 provider');
  }
  if (kind === 'owner') {
    const quote = bounded(input.ownerQuote, 'ownerQuote', 2, 2000);
    if (!quote) invalid('owner 事件必须携带老板原话（ownerQuote），由 owner relay 记录');
    return {
      source: kind, at, verified: trusted.verified === true,
      ...(eventId ? { eventId } : {}),
      ...(objectWaitId ? { objectWaitId } : {}),
      ...(objectTaskId ? { objectTaskId } : {}),
      ownerQuote: quote,
      ...(input.payloadDigest ? { payloadDigest: String(input.payloadDigest) } : {}),
    };
  }
  if (kind === 'dependency') {
    return {
      source: kind, at, verified: true,
      ...(eventId ? { eventId } : {}),
      ...(objectWaitId ? { objectWaitId } : {}),
      ...(objectTaskId ? { objectTaskId } : {}),
    };
  }
  return {
    source: kind, at, verified: trusted.verified === true,
    ...(input.provider ? { provider: String(input.provider).trim() } : {}),
    ...(input.account ? { account: assertNonSensitive(String(input.account), 'account') } : {}),
    ...(eventId ? { eventId } : {}),
    ...(objectWaitId ? { objectWaitId } : {}),
    ...(objectTaskId ? { objectTaskId } : {}),
    ...(input.payloadDigest ? { payloadDigest: String(input.payloadDigest) } : {}),
  };
}

/**
 * The one release decision. The condition's own trigger is checked first, then every gate that the wait may not
 * walk past: an owner gate, an unfinished dependency, or an owner handoff without the owner's real decision.
 */
export function decideRelease(wait: WaitRecord, now: number, gates: WaitGates, event?: WaitEvent): WaitDecision {
  // `held` is a parked wait that the scheduler re-checks: its condition fired earlier but a dependency or an
  // owner gate was not clear. Re-evaluating it is not a new release; the same gates decide it below.
  if (wait.state !== 'waiting' && wait.state !== 'held') {
    return { release: false, code: 'not_waiting', message: `等待已处于 ${wait.state}，不能再解除` };
  }
  if (wait.expiresAt !== undefined) {
    const late = event === undefined || event.at > wait.expiresAt;
    if (now > wait.expiresAt && late) {
      return { release: false, code: 'expired', message: '等待已过期且没有在到期前到达的受信事件；需要延期或取消，不能自动放行' };
    }
  }
  if (gates.taskBlockedToOwner) {
    return { release: false, code: 'owner_gate', message: '任务仍在老板关口；等待不能代替老板批准' };
  }
  if (!gates.dependenciesSatisfied) {
    return { release: false, code: 'dependency', message: '任务依赖尚未完成；到点只释放时间条件，不代替依赖' };
  }
  if (wait.kind === 'owner_handoff') {
    if (!gates.ownerApproved) {
      return { release: false, code: 'owner_gate', message: '老板交接尚未通过 owner relay 收到老板本人的决定，模型自述不算' };
    }
    // The owner relay's decision IS the trusted event; the card keeps no extra secret to wait on.
    return { release: true, code: 'released', message: '老板已通过 owner relay 作出决定，解除交接等待' };
  }
  if (DEPENDENCY_KINDS.has(wait.kind)) {
    if (gates.referenceComplete !== true) {
      return { release: false, code: 'dependency', message: '所等的修复/上游任务尚未完成' };
    }
    return { release: true, code: 'released', message: '所等的任务已完成或作废，解除依赖等待' };
  }
  if (wait.kind === 'time') {
    if (wait.notBefore === undefined) return { release: false, code: 'no_object', message: '时间等待没有 notBefore，状态不可判定' };
    if (now < wait.notBefore) return { release: false, code: 'early', message: '尚未到 notBefore', nextAt: wait.notBefore };
    return { release: true, code: 'released', message: '时间条件已满足（其余关口另行核对）', nextAt: wait.notBefore };
  }
  if (!event) return { release: false, code: 'awaiting_event', message: '等待受信事件，尚未收到' };
  if (event.at > now + 300_000) return { release: false, code: 'event_mismatch', message: '事件时间在未来，不能解除' };
  if (wait.expiresAt !== undefined && event.at > wait.expiresAt) {
    return { release: false, code: 'expired', message: '事件发生在等待到期之后' };
  }
  return { release: true, code: 'released', message: '受信事件已确认，解除条件' };
}

/** The next instant the dispatcher should look at this wait, when it has one. Never a poll of an external service. */
export function nextWakeAt(wait: WaitRecord): number | undefined {
  const candidates = [wait.notBefore, wait.nextCheckAt].filter((value): value is number => value !== undefined);
  return candidates.length ? Math.min(...candidates) : undefined;
}

/** The risk bucket of an owner handoff. Reminders are deduped on this key, so one wait is not re-announced every tick. */
export type WaitRisk = 'unknown' | 'scheduled' | 'due_soon' | 'overdue';
export function waitRisk(wait: WaitRecord, now: number): WaitRisk {
  if (wait.expiresSource === 'unknown' || wait.expiresAt === undefined) return 'unknown';
  if (now >= wait.expiresAt) return 'overdue';
  if (wait.expiresAt - now <= 3_600_000) return 'due_soon';
  return 'scheduled';
}

/** The owner-notice key of one handoff and one risk bucket. A different bucket is a real new reminder; the same one is not. */
export function handoffNoticeKey(wait: WaitRecord, now: number): string {
  return `wait-handoff:${wait.waitKey}:${waitRisk(wait, now)}`;
}

/** One owner-facing card. It never carries the handoff file's contents or any secret-bearing link. */
export interface WaitHandoffCard {
  waitKey: string;
  taskId: string;
  taskTitle: string;
  kind: WaitKind;
  state: WaitState;
  completed: string[];
  pendingAction?: string;
  /** Who is waiting for whom, in the card's own words. */
  waitingOn: string;
  waitingBy: string;
  /** The expiry exactly as the tool returned it; `unknown` when no tool named one. */
  expiresAt: { value?: string; source: ExpirySource };
  nextCheckAt?: string;
  nextTrigger: string[];
  risk: WaitRisk;
  /** Safe to show: only the local handoff file name, never its path or the secret it contains. */
  handoffFileName?: string;
}

/** The safe file name of a controlled handoff file, or undefined when the value is not a plausible local path. */
export function handoffFileName(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const name = value.split(/[\\/]/).pop() ?? '';
  if (!name || name.length > 120) return undefined;
  if (name.includes('://')) return undefined;
  try { assertNonSensitive(name, 'handoffFile'); } catch { return undefined; }
  return name;
}

/** The allowed next triggers of a wait, stated on the card instead of left implicit. */
export function nextTriggersOf(wait: WaitRecord): string[] {
  switch (wait.kind) {
    case 'time': return ['到达 notBefore', '授权人取消或延期'];
    case 'dependency':
    case 'upstream_repair': return ['所等的任务完成或作废', '授权人确认上游已修复'];
    case 'customer_activation': return ['受信 webhook 确认客户已激活', '授权人确认'];
    case 'owner_handoff': return ['老板通过 owner relay 作出决定', '授权人取消或延期'];
    case 'feedback': return ['授权人确认收到反馈', '受信 webhook 确认'];
    default: return [];
  }
}

export function handoffCard(wait: WaitRecord, taskTitle: string, waitingBy: string, now: number): WaitHandoffCard {
  const file = handoffFileName(wait.handoffFile);
  return {
    waitKey: wait.waitKey,
    taskId: wait.taskId,
    taskTitle,
    kind: wait.kind,
    state: wait.state,
    completed: [...wait.completed],
    ...(wait.pendingAction === undefined ? {} : { pendingAction: wait.pendingAction }),
    waitingOn: wait.ownerRole,
    waitingBy,
    expiresAt: {
      ...(wait.expiresAt === undefined ? {} : { value: new Date(wait.expiresAt).toISOString() }),
      source: wait.expiresSource,
    },
    ...(wait.nextCheckAt === undefined ? {} : { nextCheckAt: new Date(wait.nextCheckAt).toISOString() }),
    nextTrigger: nextTriggersOf(wait),
    risk: waitRisk(wait, now),
    ...(file === undefined ? {} : { handoffFileName: file }),
  };
}

/**
 * The exact-and-only-once test for a time condition: it is due when `now >= notBefore`, with no rounding to a
 * minute, no local-time comparison and no tolerance that could fire early. Repeated calls at the same instant
 * answer the same thing; the store's compare-and-set is what makes the transition count once.
 */
export function timeConditionDue(notBefore: number | undefined, now: number): boolean {
  return notBefore !== undefined && now >= notBefore;
}

/**
 * The display of a time in its zone. This is the only place the timezone is used: it is for the card and the
 * employee, never for the release arithmetic. A DST gap or fold changes this string, not the instant.
 */
export function displayInZone(instant: number, timezone: string | undefined): string {
  if (timezone === undefined) return new Date(instant).toISOString();
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short',
    }).format(new Date(instant));
  } catch { return new Date(instant).toISOString(); }
}

// ---------------------------------------------------------------- webhook trust

/** The canonical string a webhook signature covers: the typed facts, never a free-form body. */
export function webhookPayload(input: {
  eventId: string; provider: string; objectWaitId?: string; objectTaskId?: string; at: number;
}): string {
  return JSON.stringify({
    eventId: input.eventId, provider: input.provider, at: input.at,
    objectWaitId: input.objectWaitId ?? '', objectTaskId: input.objectTaskId ?? '',
  });
}

/** HMAC-SHA256 over the canonical payload, hex. The secret is held by the broker/channel, never by an employee. */
export function signWaitWebhook(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

/** Constant-time signature verification. A missing secret/signature is a refusal, not an empty pass. */
export function verifyWaitWebhook(secret: string | undefined, payload: string, signature: unknown): boolean {
  if (!secret || typeof signature !== 'string' || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  const expected = Buffer.from(signWaitWebhook(secret, payload), 'hex');
  const actual = Buffer.from(signature, 'hex');
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

// ---------------------------------------------------------------- legacy migration

/** One legacy task considered for migration. This is a read-only preview; nothing is released here. */
export interface WaitMigrationCandidate {
  taskId: string;
  state: string;
  blockedTo?: string;
  quotaResetsAt?: number;
  eligible: boolean;
  /** `owner_gate` is never automatically migrated: a boss gate is not a time wait. */
  reason?: 'owner_gate' | 'already_waiting' | 'not_time_bounded' | 'eligible';
}

/**
 * The dry-run list for legacy tasks. It never resolves an owner gate, and it names why each row would or would
 * not be migrated instead of producing a bulk release. The caller has to confirm one task at a time.
 */
export function migrationPreview(rows: ReadonlyArray<{
  id: string; state: string; blocked_to?: string; quota_resets_at?: number; wait_state?: string;
}>, now: number): WaitMigrationCandidate[] {
  return rows.map(row => {
    const base = {
      taskId: row.id, state: row.state,
      ...(row.blocked_to === undefined ? {} : { blockedTo: row.blocked_to }),
      ...(row.quota_resets_at === undefined ? {} : { quotaResetsAt: row.quota_resets_at * 1000 }),
    };
    if (row.blocked_to === 'owner') return { ...base, eligible: false, reason: 'owner_gate' as const };
    if (row.wait_state === 'waiting') return { ...base, eligible: false, reason: 'already_waiting' as const };
    if (row.state !== 'blocked' || row.quota_resets_at === undefined || row.quota_resets_at * 1000 <= now) {
      return { ...base, eligible: false, reason: 'not_time_bounded' as const };
    }
    return { ...base, eligible: true, reason: 'eligible' as const };
  });
}

/** The stable identity of one entered wait. The task id makes an accidental cross-task lookup impossible. */
export function waitKeyOf(taskId: string, seed: string): string {
  return `${taskId}:${seed}`;
}
