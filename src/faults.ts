/**
 * SYS04 · P0 fault classification, persistent budget and block convergence.
 *
 * A fault is a fact about one operation, not a sentence an employee wrote about it. This module turns a raw
 * failure into a structured, sanitized record (phase, hop, errno, HTTP class, elapsed, retryability, identity
 * alias, controlled target), derives the canonical keys that group the same underlying cause, and computes the
 * recovery budget that decides whether another attempt may run at all.
 *
 * Three rules shape everything here:
 *
 * 1. Nothing in this module reads a natural-language message to decide a permission or a retry. The keys are
 *    built from machine facts (phase, hop, errno, HTTP status class, target kind, environment). Two different
 *    wordings of the same error land on the same key; two genuinely different failures do not.
 * 2. Unknown is a first-class answer. A failure that cannot be classified stops the recovery instead of guessing
 *    that it was a network problem: only a connect timeout, a connection reset and an explicitly retryable 5xx are
 *    eligible for automatic recovery. A 403, a rejected password, a revoked permission and an invalid input stop
 *    immediately and produce an actionable diagnostic.
 * 3. The identity alias is recorded but never keys anything. The alias is the employee's own naming of an
 *    account, so an alias that is written differently — or swapped for another account — must not open a new
 *    budget, a new episode or a new wake. It is carried in the record (sanitized, canonical) for the audit, and
 *    the recovery scope is bound to the task, the controlled target and the phase instead.
 *
 * The module is pure: no database, no clock of its own, no I/O. Callers pass the clock. That keeps the arithmetic
 * (AC02) reproducible in tests and keeps the classification rules readable in one place.
 */

/** Where the failure happened. Fixed vocabulary: the phase names are part of the contract, not free text. */
export type FaultPhase =
  | 'authorize' | 'login' | 'consent' | 'exchange' | 'workspace_list' | 'workspace_ensure'
  | 'member_list' | 'member_add' | 'member_remove' | 'account_ensure' | 'request' | 'dispatch' | 'unknown';

/** Which hop of the operation failed. A hop is one network exchange, not one message. */
export type FaultHop = 'connect' | 'tls' | 'request' | 'response' | 'body' | 'dispatch' | 'none';

/** Where in the login flow a hop failed. It is part of the fingerprint, never of the budget key. */
export type FlowStage = 'authorize' | 'login' | 'consent' | 'exchange';

/** The HTTP outcome class. Statuses are bucketed so that 500 and 502 do not become two different incidents. */
export type HttpClass = 'none' | 'client_error' | 'auth' | 'not_found' | 'conflict' | 'server_error' | 'rate_limited' | 'unknown';

/** Whether the operation may be retried by the recovery mechanism, and why. */
export type FaultRetryability =
  /** A connect timeout, a connection reset, or an explicitly retryable 5xx: the request may be tried again. */
  | 'retryable'
  /** The upstream refused the request (4xx other than 408/429): retrying the same request cannot help. */
  | 'permanent'
  /** The request may have been sent and the outcome is unknown: never replay it blindly. */
  | 'unknown_outcome'
  /** The failure could not be classified: stop, and do not assume a network cause. */
  | 'unclassified';

/** The controlled target of the operation. Only these kinds are recorded; a raw URL never is. */
export type FaultTargetKind = 'idp_authorize' | 'idp_login' | 'idp_token' | 'product_api' | 'product_token' | 'workspace' | 'member' | 'account' | 'internal' | 'browser' | 'logout' | 'none';

/** One sanitized fault. Every field is a machine fact; none of them is a credential, a path or a free-text reason. */
export interface FaultRecord {
  phase: FaultPhase;
  /** The stage of the login flow that failed, when the failure came from one. */
  stage?: FlowStage;
  hop: FaultHop;
  /** The errno-style code (UND_ERR_CONNECT_TIMEOUT, ECONNRESET, ...) or 'none'. */
  errno: string;
  /** The HTTP status when there was one, else undefined. */
  status?: number;
  httpClass: HttpClass;
  /** Wall time of the failed operation in milliseconds. */
  elapsedMs: number;
  retryability: FaultRetryability;
  /** The identity alias the operation ran for, in canonical form (see canonicalAlias). Recorded, never keyed on. */
  identityAlias?: string;
  /** The controlled target kind. */
  target: FaultTargetKind;
  /** The environment the operation ran in (production, staging, ...). */
  environment?: string;
}

/** The raw inputs a caller has at the failure point. Everything here is already known to the caller. */
export interface FaultInput {
  phase: FaultPhase;
  /** The stage of the login flow that failed, when the failure came from one. */
  stage?: FlowStage;
  /** The errno-style code of the failure, when there was one. */
  errno?: string;
  /** The HTTP status of the failure, when there was one. */
  status?: number;
  /** The failure name, e.g. 'TimeoutError', 'TypeError'. */
  name?: string;
  /** Wall time of the failed operation. */
  elapsedMs?: number;
  /** The identity alias involved, if any. */
  identityAlias?: string;
  target?: FaultTargetKind;
  environment?: string;
  /**
   * Whether the request could have reached the upstream. `false` proves the request was never written
   * (a connect-phase failure); `true` means it may have been delivered; undefined means unknown.
   */
  requestSent?: boolean;
  /** Whether the operation is safe to repeat (a GET, an idempotent read). A non-idempotent write is never replayed. */
  idempotent?: boolean;
}

/** The canonical form of an identity alias. Case, spacing and separator variants fold onto one string. */
export function canonicalAlias(alias: string | undefined): string | undefined {
  if (alias === undefined) return undefined;
  const trimmed = alias.trim().toLowerCase();
  if (!trimmed) return undefined;
  return trimmed.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** The HTTP class of a status. The buckets are the ones the recovery rules distinguish. */
export function httpClassOf(status: number | undefined): HttpClass {
  if (status === undefined) return 'none';
  if (status === 401) return 'auth';
  if (status === 403) return 'client_error';
  if (status === 404) return 'not_found';
  if (status === 409 || status === 412) return 'conflict';
  if (status === 408 || status === 429) return 'rate_limited';
  if (status >= 500) return 'server_error';
  if (status >= 400) return 'client_error';
  return 'unknown';
}

/** The errno set that means "the connection never came up" — nothing was written, so the request may be repeated. */
const CONNECT_ERRNOS = new Set([
  'UND_ERR_CONNECT_TIMEOUT', 'ETIMEDOUT', 'ESOCKETTIMEDOUT',
  'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE',
]);

/**
 * The errno set that proves the connection was never established, so the request was never written.
 *
 * This is narrower than CONNECT_ERRNOS on purpose. EPIPE is a write-side error: it happens when the peer has already
 * gone away, which means the request may well have been sent (and, for a single-use challenge or code, consumed).
 * ETIMEDOUT and ESOCKETTIMEDOUT are connect-phase timeouts at the socket layer, but a timeout can also fire after
 * the request was written. Neither proves that nothing reached the upstream, so neither may justify repeating a
 * non-idempotent request. Only the errors below prove the connection never existed.
 */
const PROVABLY_UNSENT_ERRNOS = new Set([
  'UND_ERR_CONNECT_TIMEOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH',
]);

/**
 * Whether the failure proves the request was never written, so repeating the same request is safe even for a write.
 *
 * Used by the login path's same-hop retry. Deliberately stricter than the classifier's `hop === 'connect'`: the
 * classifier records where the failure happened, while this answers whether the wire was ever touched.
 */
export function isProvablyUnsentFailure(errno: string | undefined): boolean {
  if (!errno) return false;
  return PROVABLY_UNSENT_ERRNOS.has(errno);
}

/** The errno set that means "the connection broke" — the request may have been sent, so it is never replayed blindly. */
const RESET_ERRNOS = new Set(['ECONNRESET', 'UND_ERR_SOCKET', 'EPROTO', 'EHOSTDOWN', 'ENETRESET']);

/** The errno set that means the transport gave up before the request was written. */
const TIMEOUT_ERRNOS = new Set(['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'TimeoutError']);

/** 5xx statuses that are explicitly retryable. Others (501, 505) are permanent. */
const RETRYABLE_5XX = new Set([500, 502, 503, 504, 507, 508, 509]);

/** The errno of a TLS trust failure: never retryable, never downgradable. */
const TLS_ERRNOS = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID',
  'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_UNTRUSTED',
]);

/**
 * The classification of one failure. Pure: the same input always yields the same record, so two workers that saw
 * the same fault agree on the fingerprint without exchanging anything but the fingerprint itself.
 */
export function classifyFault(input: FaultInput): FaultRecord {
  const errno = (input.errno ?? '').trim();
  const status = input.status;
  const httpClass = httpClassOf(status);
  const name = input.name ?? '';
  const target = input.target ?? 'none';
  const elapsedMs = Math.max(0, Math.round(input.elapsedMs ?? 0));

  let hop: FaultHop = 'none';
  let retryability: FaultRetryability = 'unclassified';
  // True when the failure proves that nothing was written to the upstream: the request may be repeated even when
  // the operation is not idempotent, because nothing happened.
  let provedNotSent = false;

  if (TLS_ERRNOS.has(errno)) {
    // An untrusted certificate fails the same way on every attempt: permanent, and TLS is never downgraded.
    hop = 'tls';
    retryability = 'permanent';
  } else if (CONNECT_ERRNOS.has(errno)) {
    hop = 'connect';
    // A connect-phase failure proves the request was never written, so a repeat is safe.
    retryability = 'retryable';
    provedNotSent = true;
  } else if (RESET_ERRNOS.has(errno)) {
    hop = 'connect';
    // The connection broke: the request may have been delivered. Only an idempotent operation may be repeated.
    retryability = input.requestSent === false ? 'retryable' : (input.idempotent === true ? 'retryable' : 'unknown_outcome');
    provedNotSent = input.requestSent === false;
  } else if (TIMEOUT_ERRNOS.has(errno) || name === 'TimeoutError') {
    hop = input.requestSent === false ? 'connect' : 'response';
    retryability = input.requestSent === false ? 'retryable' : (input.idempotent === true ? 'retryable' : 'unknown_outcome');
    provedNotSent = input.requestSent === false;
  } else if (httpClass === 'server_error') {
    hop = 'response';
    retryability = status !== undefined && RETRYABLE_5XX.has(status) ? 'retryable' : 'permanent';
  } else if (httpClass === 'rate_limited') {
    hop = 'response';
    // A rate limit is not a fault to retry blindly: the recovery waits for the window the upstream names.
    retryability = 'permanent';
  } else if (httpClass === 'client_error' || httpClass === 'auth' || httpClass === 'not_found' || httpClass === 'conflict') {
    hop = 'response';
    retryability = 'permanent';
  } else if (httpClass === 'unknown' && status !== undefined) {
    hop = 'response';
    retryability = 'permanent';
  }

  // An explicitly non-idempotent write is never replayed — unless the failure proves that nothing was written.
  if (retryability === 'retryable' && input.idempotent === false && !provedNotSent) retryability = 'unknown_outcome';

  const alias = canonicalAlias(input.identityAlias);
  return {
    phase: input.phase,
    ...(input.stage === undefined ? {} : { stage: input.stage }),
    hop,
    errno: errno || 'none',
    ...(status === undefined ? {} : { status }),
    httpClass,
    elapsedMs,
    retryability,
    ...(alias === undefined ? {} : { identityAlias: alias }),
    target,
    ...(input.environment === undefined ? {} : { environment: input.environment }),
  };
}

/**
 * The canonical fingerprint of a fault: the identity of the cause.
 *
 * The phase and hop say where it happened, the errno and HTTP class say what failed, the target kind and the
 * environment say against what. The elapsed time is deliberately NOT part of it: a slow failure and a fast
 * failure of the same kind are one cause. The identity alias is deliberately not part of it either — the alias is
 * the employee's own spelling of an account, and an alias that is swapped or rewritten must not open a new
 * episode, a new budget or a new wake (AC01/AC03).
 */
export function faultFingerprint(fault: FaultRecord): string {
  return [
    fault.phase,
    fault.stage ?? '-',
    fault.hop,
    fault.errno,
    fault.httpClass,
    fault.status ?? '-',
    fault.target,
    fault.environment ?? '-',
  ].join('|');
}

/**
 * The incident key of a cause: the same outage seen from different hops or from different tasks.
 *
 * The hop is dropped (a connect timeout and a body timeout of the same outage are one incident), the task is not
 * part of the key (the same cause across tasks is one incident with one repair chain). What separates incidents is
 * the cause, the environment and the permission context — never the wording, never the employee, never the alias.
 */
export function incidentKey(fault: FaultRecord): string {
  return [fault.phase, fault.errno, fault.httpClass, fault.status ?? '-', fault.target, fault.environment ?? '-'].join('|');
}

/**
 * The budget key of a fault object: the scope the recovery budget is spent on.
 *
 * It binds the task, the controlled target and the phase, and nothing else. The holder is not in it (a new
 * holder does not get a fresh budget), the alias is not in it (a rewritten or swapped alias does not either) and
 * the wording of the error is not in it (only machine facts are). The consequence is deliberate: the only way to
 * spend a new unit of budget is to make another attempt.
 */
export function budgetKey(taskId: string, target: string, phase: string): string {
  return [taskId, target, phase].join('|');
}

/** The persisted budget of one fault object. Every field survives a lease change and a process restart. */
export interface FaultBudgetState {
  /** Attempts already charged to this scope. */
  attempts: number;
  /** The absolute deadline of the whole recovery, unix milliseconds. */
  deadline: number;
  /** The earliest time another attempt may start, unix milliseconds (last attempt plus the minimum interval and backoff). */
  nextAllowedAt: number;
  /** The last attempt's timestamp, unix milliseconds. */
  lastAttemptAt?: number;
  /** True when a failure was recorded for this scope: the object is in recovery. */
  failed: boolean;
  /** The fingerprint of the last recorded cause, for the audit and the diagnostic. */
  fingerprint: string;
  /** The incident key of the last recorded cause. */
  incident: string;
}

/**
 * The exact receipt of one charged reservation. It is the only thing an unexecuted call may give back:
 * the refund restores the row this reservation moved, and only while the row still matches the values this
 * reservation wrote. A newer failure, a stop, a lift or a real success makes the refund a no-op.
 *
 * A token that names the pre-state lets the store restore it without trusting a cached copy: the CAS is on
 * the post-state, so a concurrent write wins and the refund never overwrites it.
 */
export interface FaultRefund {
  /** The budget key this reservation belongs to (taskId|target|phase). */
  key: string;
  taskId: string;
  target: string;
  phase: string;
  /** The state this reservation wrote; the refund's CAS must find exactly this. */
  chargedAttempts: number;
  chargedTotalAttempts: number;
  chargedDeadline: number;
  chargedNextAllowedAt: number;
  chargedLastAttemptAt: number;
  /** The state before the reservation; the only fields the refund restores. */
  priorAttempts: number;
  priorTotalAttempts: number;
  priorDeadline: number;
  priorNextAllowedAt: number;
  priorLastAttemptAt?: number;
  priorFailed: boolean;
}

/** The limits a caller applies to a fault object. */
export interface FaultBudgetLimits {
  /** How many attempts the recovery may spend in total. */
  maxAttempts: number;
  /** The total wall time the recovery may take, milliseconds. */
  totalDeadlineMs: number;
  /** The minimum gap between two attempts, milliseconds. */
  minIntervalMs: number;
  /** The backoff base; the wait grows with the attempt number. */
  backoffMs: number;
  /** The jitter fraction of the backoff, 0..1. A caller passes a deterministic value so the arithmetic stays reproducible. */
  jitter: number;
}

/** The decision of the budget check, with the reason in words. */
export interface BudgetDecision {
  allowed: boolean;
  /** Why the attempt is refused; undefined when it is allowed. */
  reason?: 'attempts_exhausted' | 'deadline_passed' | 'min_interval' | 'not_retryable' | 'lease_expired';
  /** The earliest time another attempt may start (when the refusal is a timing one). */
  nextAllowedAt?: number;
  /** The attempt number this decision refers to (1-based). */
  attempt: number;
  /** The wait before this attempt, milliseconds (0 when allowed without waiting). */
  waitMs: number;
}

/** The default limits. A connect timeout gets a few tries; the total stays inside one tool call. */
export const DEFAULT_FAULT_BUDGET: FaultBudgetLimits = {
  maxAttempts: 3,
  totalDeadlineMs: 120_000,
  minIntervalMs: 2_000,
  backoffMs: 5_000,
  jitter: 0.2,
};

/**
 * The backoff wait before attempt N (1-based), with the jitter folded in. The jitter is passed in rather than
 * drawn, so the same inputs always produce the same wait and the audit trail can be recomputed.
 */
export function backoffWaitMs(limits: FaultBudgetLimits, attempt: number, jitterFactor: number): number {
  const base = limits.backoffMs * Math.max(0, attempt - 1);
  const jitter = Math.round(base * limits.jitter * jitterFactor);
  return Math.max(0, base + jitter);
}

/**
 * The budget decision for an attempt, without the cause.
 *
 * This is the gate the reservation uses: the caller asks "may attempt N run now?" before it runs, and only the
 * persisted counters answer. The cause is not known yet at that point, so it cannot be part of the answer — a
 * refusal here always means the budget, never the wording of an error.
 */
export function decideAttempt(state: FaultBudgetState | undefined, limits: FaultBudgetLimits, now: number,
  /** The validity window of the lease the attempt runs under; the attempt may not outlive it. */
  leaseExpiresAt?: number): BudgetDecision {
  const attempt = (state?.attempts ?? 0) + 1;
  if (!state) {
    return { allowed: true, attempt, waitMs: 0 };
  }
  if (state.attempts >= limits.maxAttempts) {
    return { allowed: false, reason: 'attempts_exhausted', attempt, waitMs: 0 };
  }
  if (state.deadline <= now) {
    return { allowed: false, reason: 'deadline_passed', attempt, nextAllowedAt: state.deadline, waitMs: 0 };
  }
  // The attempt runs inside the lease: it may neither start after the lease ended nor be scheduled past it. A lease
  // refusal is not a spent budget — the task has to be claimed again, and the counters stay as they are.
  if (leaseExpiresAt !== undefined && (leaseExpiresAt <= now || state.nextAllowedAt >= leaseExpiresAt)) {
    return { allowed: false, reason: 'lease_expired', attempt, nextAllowedAt: leaseExpiresAt, waitMs: 0 };
  }
  if (state.nextAllowedAt > now) {
    return { allowed: false, reason: 'min_interval', attempt, nextAllowedAt: state.nextAllowedAt, waitMs: state.nextAllowedAt - now };
  }
  return { allowed: true, attempt, waitMs: 0 };
}

/**
 * The decision for a recorded failure: may the recovery continue?
 *
 * The budget counters decide first; the cause decides last and wins. A failure that is not retryable (a refused
 * request, a rejected password, an unknown outcome) stops the recovery at once, even while the budget still has
 * room — that is the point of the classification.
 */
export function decideBudget(state: FaultBudgetState | undefined, limits: FaultBudgetLimits, now: number, fault: FaultRecord): BudgetDecision {
  const attempt = (state?.attempts ?? 0) + 1;
  if (fault.retryability !== 'retryable') {
    return { allowed: false, reason: 'not_retryable', attempt, waitMs: 0 };
  }
  if (!state) return { allowed: true, attempt, waitMs: 0 };
  if (state.attempts >= limits.maxAttempts) {
    return { allowed: false, reason: 'attempts_exhausted', attempt, waitMs: 0 };
  }
  if (state.deadline <= now) {
    return { allowed: false, reason: 'deadline_passed', attempt, nextAllowedAt: state.deadline, waitMs: 0 };
  }
  // The minimum interval is a hint, not a refusal: the recovery may continue, the next attempt may not start yet.
  const waitMs = Math.max(0, state.nextAllowedAt - now);
  return { allowed: true, attempt, waitMs, ...(waitMs > 0 ? { nextAllowedAt: state.nextAllowedAt } : {}) };
}

/** The budget state after an attempt is charged. The deadline and the next allowed time are computed here, not by the caller. */
export function spendBudget(
  previous: FaultBudgetState | undefined, limits: FaultBudgetLimits, now: number, fault: FaultRecord, jitterFactor: number,
): FaultBudgetState {
  const attempt = (previous?.attempts ?? 0) + 1;
  const deadline = previous?.deadline ?? now + limits.totalDeadlineMs;
  const wait = backoffWaitMs(limits, attempt, jitterFactor);
  return {
    attempts: attempt,
    deadline,
    nextAllowedAt: now + wait + limits.minIntervalMs,
    lastAttemptAt: now,
    failed: previous?.failed ?? true,
    fingerprint: faultFingerprint(fault),
    incident: incidentKey(fault),
  };
}

/**
 * The jitter factor of a budget scope, derived from its key. It is a function of the scope alone, so every attempt
 * of one scope waits a reproducible amount and the audit trail can be recomputed from the stored key. Two scopes
 * do not back off in lockstep.
 */
export function jitterFactorOf(key: string): number {
  let hash = 0;
  for (let index = 0; index < key.length; index++) hash = (hash * 31 + key.charCodeAt(index)) >>> 0;
  return (hash % 1000) / 1000;
}

/** The structured diagnostic produced when a recovery stops. It is generated once per cause, not per report. */
export interface FaultDiagnostic {
  fingerprint: string;
  incident: string;
  phase: FaultPhase;
  hop: FaultHop;
  errno: string;
  httpClass: HttpClass;
  status?: number;
  attempts: number;
  maxAttempts: number;
  elapsedMs: number;
  /** What an operator should do, in words. Fixed per class, never composed from an error message. */
  guidance: string;
  /** The retryability of the fault that stopped the recovery. */
  retryability: FaultRetryability;
}

/** The guidance per outcome. It never names a credential and never suggests weakening a control. */
export function diagnosticFor(fault: FaultRecord, state: FaultBudgetState, limits: FaultBudgetLimits): FaultDiagnostic {
  let guidance: string;
  if (fault.httpClass === 'auth' || fault.httpClass === 'client_error') {
    guidance = 'The upstream refused the request (permission or input). Repeating it cannot help: check the account authorization, the requested scope and the input, then retry after the cause is fixed.';
  } else if (fault.httpClass === 'not_found') {
    guidance = 'The upstream did not know the requested object. Verify the identifier and the environment before repeating the call.';
  } else if (fault.httpClass === 'conflict') {
    guidance = 'The upstream reported a conflict with the current state. Read the current state and decide what should change before repeating the call.';
  } else if (fault.httpClass === 'rate_limited') {
    guidance = 'The upstream is rate limiting this identity. Wait for the window the upstream reports; repeating earlier only spends more of the budget.';
  } else if (fault.hop === 'tls') {
    guidance = 'The certificate was not trusted. The transport must not be weakened: fix the trust store or the certificate and try again.';
  } else if (fault.retryability === 'unknown_outcome') {
    guidance = 'The request may have reached the upstream, so it is not repeated blindly. Check the upstream state first: the result may already exist.';
  } else if (fault.retryability === 'retryable') {
    guidance = 'Every recovery attempt for this object failed and the recovery budget is spent. The repair is tracked as one incident with one repair task.';
  } else if (fault.retryability === 'unclassified') {
    guidance = 'The failure could not be classified, so it was not treated as a network fault and the recovery stopped. Read the upstream response and fix the cause before repeating the call.';
  } else {
    guidance = 'The upstream failed in a way that repeating the call cannot fix. Read the upstream state and fix the cause before repeating the call.';
  }
  return {
    fingerprint: faultFingerprint(fault),
    incident: incidentKey(fault),
    phase: fault.phase,
    hop: fault.hop,
    errno: fault.errno,
    httpClass: fault.httpClass,
    ...(fault.status === undefined ? {} : { status: fault.status }),
    attempts: state.attempts,
    maxAttempts: limits.maxAttempts,
    elapsedMs: fault.elapsedMs,
    guidance,
    retryability: fault.retryability,
  };
}

/**
 * The evidence a report carries. It is sanitized: the phase, hop, errno, HTTP class, elapsed time, the canonical
 * identity alias and the controlled target kind — never a message, a URL, a path or a credential.
 */
export function faultEvidence(fault: FaultRecord): Record<string, unknown> {
  return {
    phase: fault.phase,
    ...(fault.stage === undefined ? {} : { stage: fault.stage }),
    hop: fault.hop,
    errno: fault.errno,
    httpClass: fault.httpClass,
    ...(fault.status === undefined ? {} : { status: fault.status }),
    elapsedMs: fault.elapsedMs,
    retryability: fault.retryability,
    target: fault.target,
    ...(fault.identityAlias === undefined ? {} : { identityAlias: fault.identityAlias }),
    ...(fault.environment === undefined ? {} : { environment: fault.environment }),
    fingerprint: faultFingerprint(fault),
  };
}

/** The machine facts of a failed operation: the flow stage, the errno, the HTTP status and the error's name. */
export interface FaultFacts {
  stage?: FlowStage;
  errno?: string;
  status?: number;
  name?: string;
}

/**
 * The facts of a thrown error, read from its fields and never from its message. The IdP client attaches the facts
 * of the hop that failed (`facts`); the other errors carry the errno on `cause` and the HTTP status on `status`.
 */
export function faultFactsOf(error: unknown): FaultFacts {
  const carried = (error as { facts?: FaultFacts } | undefined)?.facts;
  const cause = (error as { cause?: { code?: unknown } } | undefined)?.cause;
  const own = error as { name?: unknown; status?: unknown; response?: { status?: unknown } } | undefined;
  const errno = carried?.errno ?? (typeof cause?.code === 'string' ? cause.code : undefined);
  const status = carried?.status
    ?? (typeof own?.status === 'number' ? own.status : undefined)
    ?? (typeof own?.response?.status === 'number' ? own.response.status : undefined);
  const name = carried?.name ?? (typeof own?.name === 'string' ? own.name : undefined);
  return {
    ...(carried?.stage === undefined ? {} : { stage: carried.stage }),
    ...(errno === undefined ? {} : { errno }),
    ...(status === undefined ? {} : { status }),
    ...(name === undefined ? {} : { name }),
  };
}
