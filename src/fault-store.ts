/**
 * SYS04 · The persistence and enforcement layer for faults: one episode per cause and task, one budget per
 * fault object, one repair chain per incident.
 *
 * The store is the only place that writes the fault tables. Every read and every write is a single SurrealDB
 * statement (or one transaction), so the budget survives a lease change, a process restart and a concurrent
 * call: the reservation is an atomic `UPDATE ... WHERE attempts = $expected` on the budget row, not a
 * read-modify-write in the caller's memory.
 *
 * The rules this store enforces (AC02, AC04):
 *
 * - A budget belongs to a fault object: the task, the controlled target and the phase. The holder, the wording of
 *   the error and the identity alias are not in that key, so none of them can clear it.
 * - The budget is spent **before** a recovery attempt runs. A caller that cannot reserve does not run, and the
 *   server is the one that says no — in this session, in a new one, or after a restart.
 * - A failure that cannot be recovered (a refused request, a rejected password, an unknown outcome) stops the
 *   recovery at once and leaves a diagnosis behind. The stop is on the fault object, so swapping the alias does
 *   not restart it.
 * - When the budget runs out, one structured diagnostic is generated and one repair task is created or linked.
 *   The original task then waits on that repair as a normal dependency.
 */
import { RecordId } from 'surrealdb';
import {
  backoffWaitMs, budgetKey, decideAttempt, decideBudget, diagnosticFor, faultFingerprint, incidentKey,
  type BudgetDecision, type FaultBudgetLimits, type FaultBudgetState, type FaultDiagnostic, type FaultRecord,
} from './faults.ts';

/** The minimal DB surface this store needs. */
export interface FaultStoreDb {
  query<T extends unknown[] = unknown[]>(sql: string, vars?: Record<string, unknown>): Promise<T>;
  select<T>(id: unknown): Promise<T | undefined>;
}

/** The state of a fault episode. */
export type FaultEpisodeState = 'opened' | 'converged' | 'exhausted' | 'stopped' | 'resolved';

export interface FaultEpisodeRow {
  episode: string;
  fingerprint: string;
  incident: string;
  taskId: string;
  phase: string;
  state: FaultEpisodeState;
  evidenceRevision: number;
  notified: boolean;
  openedAt: string;
  updatedAt: string;
  resolvedAt?: string;
}

/** The budget of a fault object, as it is stored. */
export interface FaultScopeRow {
  key: string;
  taskId: string;
  target: string;
  phase: string;
  attempts: number;
  /** Every attempt this fault object ever cost, including the ones that succeeded. The audit keeps it. */
  totalAttempts: number;
  deadline: number;
  nextAllowedAt: number;
  lastAttemptAt?: number;
  lastHolder?: string;
  /** True when a failure was recorded: the object is in recovery and every further attempt is charged. */
  failed: boolean;
  /** True when a cause that cannot be recovered stopped the recovery. */
  stopped: boolean;
  stopReason?: string;
  stopFingerprint?: string;
  stopDiagnostic?: FaultDiagnostic;
  lastFingerprint?: string;
  lastIncident?: string;
  lastErrno?: string;
  lastHop?: string;
  lastHttpClass?: string;
  lastStatus?: number;
  lastElapsedMs?: number;
  maxAttempts: number;
  totalDeadlineMs: number;
  minIntervalMs: number;
  backoffMs: number;
  jitter: number;
  createdAt: string;
  updatedAt: string;
}

export interface FaultIncidentRow {
  incident: string;
  fingerprint: string;
  taskId?: string;
  target: string;
  environment?: string;
  identityAlias?: string;
  reports: number;
  state: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface FaultRepairRow {
  incident: string;
  fingerprint: string;
  taskId?: string;
  sourceTaskId?: string;
  state: 'open' | 'done' | 'void';
  diagnostic?: FaultDiagnostic;
  createdAt: string;
  updatedAt: string;
}

/** The outcome of a reservation: may the attempt run, and was a unit of the budget charged for it. */
export interface FaultReserveResult {
  allowed: boolean;
  /** The attempt number that was charged; 0 when the attempt was not charged (the first, unreserved attempt). */
  attempt: number;
  /** True when a unit of the budget was charged for this attempt. */
  charged: boolean;
  reason?: 'attempts_exhausted' | 'deadline_passed' | 'min_interval' | 'not_retryable' | 'lease_expired';
  nextAllowedAt?: number;
  waitMs: number;
  budget?: FaultBudgetState;
  diagnostic?: FaultDiagnostic;
}

/** The outcome of a report: what was recorded and whether the recovery may continue. */
export interface FaultReportResult {
  fault: FaultRecord;
  fingerprint: string;
  incident: string;
  episode: string;
  decision: BudgetDecision;
  /** True when this report opened the episode (the first one for this cause and task). */
  firstReport: boolean;
  /** True when the budget is spent and the recovery must stop. */
  exhausted: boolean;
  /** The diagnostic generated when the recovery stopped. */
  diagnostic?: FaultDiagnostic;
  /** The repair task that already exists for this incident, when there is one. */
  repairTaskId?: string;
}

/** The options a caller passes when it reserves an attempt. */
export interface FaultReserveInput {
  taskId: string;
  /** The controlled target the budget is spent on (never a raw URL). */
  target: string;
  phase: string;
  now: number;
  limits: FaultBudgetLimits;
  holder?: string;
  /** The jitter factor (0..1) used for this attempt, so the wait stays reproducible. */
  jitterFactor?: number;
  /** The end of the lease the attempt runs under: the attempt may not outlive the lock it runs in. */
  leaseExpiresAt?: number;
}

/** The options a caller passes when it reports a failure. */
export interface FaultReportInput {
  taskId: string;
  fault: FaultRecord;
  target: string;
  now: number;
  limits: FaultBudgetLimits;
  holder?: string;
  jitterFactor?: number;
  /**
   * The attempt number the caller already reserved. When it is given, the attempt is already charged and this
   * report must not charge it again; when it is absent, the report charges the attempt it describes.
   */
  attempt?: number;
  /**
   * False when the report only carries the machine facts of a failure that was already charged (a block that
   * reports what the broker already saw). The cause is recorded either way; only the charge is skipped.
   */
  charge?: boolean;
}

const asText = (value: unknown): string => {
  const raw = value && typeof value === 'object' && 'id' in value ? (value as { id: unknown }).id : value;
  const text = String(raw ?? '');
  return text.includes(':') ? text.split(':').slice(1).join(':') : text;
};

const asIso = (value: unknown): string => (value instanceof Date ? value.toISOString() : String(value ?? ''));

/** The id of the incident row (one per cause). */
const incidentId = (incident: string) => new RecordId('fault_incident', incident);

/** The id of the budget row (one per fault object). */
const scopeId = (key: string) => new RecordId('fault_budget', key);

/** The id of the repair row (one per incident). */
const repairId = (incident: string) => new RecordId('fault_repair', incident);

/** The id of the episode row (one per cause and task). */
const episodeId = (episode: string) => new RecordId('fault_episode', episode);

export class FaultStore {
  constructor(private readonly db: FaultStoreDb) {}

  /** The episode key of a cause and a task. It is derived, so a retry of the same report lands on the same episode. */
  static episodeKey(fingerprint: string, taskId: string): string {
    return `${fingerprint}#${taskId}`;
  }

  // ---------------------------------------------------------------- reads

  /** The budget of a fault object, or undefined when nothing was charged yet. */
  async scope(key: string): Promise<FaultScopeRow | undefined> {
    const row = await this.db.select<{
      key?: string; task?: unknown; target?: string; phase?: string; attempts?: number; total_attempts?: number;
      deadline?: number;
      next_allowed_at?: number; last_attempt_at?: number; last_holder?: string; failed?: boolean; stopped?: boolean;
      stop_reason?: string; stop_fingerprint?: string; stop_diagnostic?: unknown; last_fingerprint?: string;
      last_incident?: string; last_errno?: string; last_hop?: string; last_http_class?: string; last_status?: number;
      last_elapsed_ms?: number; max_attempts?: number; total_deadline_ms?: number; min_interval_ms?: number;
      backoff_ms?: number; jitter?: number; created_at?: unknown; updated_at?: unknown;
    }>(scopeId(key));
    if (!row) return undefined;
    return {
      key: row.key ?? key,
      taskId: asText(row.task),
      target: row.target ?? '',
      phase: row.phase ?? '',
      attempts: row.attempts ?? 0,
      totalAttempts: row.total_attempts ?? 0,
      deadline: row.deadline ?? 0,
      nextAllowedAt: row.next_allowed_at ?? 0,
      ...(row.last_attempt_at === undefined || row.last_attempt_at === null ? {} : { lastAttemptAt: row.last_attempt_at }),
      ...(row.last_holder === undefined || row.last_holder === null ? {} : { lastHolder: row.last_holder }),
      failed: row.failed ?? false,
      stopped: row.stopped ?? false,
      ...(row.stop_reason === undefined || row.stop_reason === null ? {} : { stopReason: row.stop_reason }),
      ...(row.stop_fingerprint === undefined || row.stop_fingerprint === null ? {} : { stopFingerprint: row.stop_fingerprint }),
      ...(row.stop_diagnostic === undefined || row.stop_diagnostic === null ? {} : { stopDiagnostic: row.stop_diagnostic as FaultDiagnostic }),
      ...(row.last_fingerprint === undefined || row.last_fingerprint === null ? {} : { lastFingerprint: row.last_fingerprint }),
      ...(row.last_incident === undefined || row.last_incident === null ? {} : { lastIncident: row.last_incident }),
      ...(row.last_errno === undefined || row.last_errno === null ? {} : { lastErrno: row.last_errno }),
      ...(row.last_hop === undefined || row.last_hop === null ? {} : { lastHop: row.last_hop }),
      ...(row.last_http_class === undefined || row.last_http_class === null ? {} : { lastHttpClass: row.last_http_class }),
      ...(row.last_status === undefined || row.last_status === null ? {} : { lastStatus: row.last_status }),
      ...(row.last_elapsed_ms === undefined || row.last_elapsed_ms === null ? {} : { lastElapsedMs: row.last_elapsed_ms }),
      maxAttempts: row.max_attempts ?? 0,
      totalDeadlineMs: row.total_deadline_ms ?? 0,
      minIntervalMs: row.min_interval_ms ?? 0,
      backoffMs: row.backoff_ms ?? 0,
      jitter: row.jitter ?? 0,
      createdAt: asIso(row.created_at),
      updatedAt: asIso(row.updated_at),
    };
  }

  /** The budget as the pure module wants it. */
  private static stateOf(row: FaultScopeRow | undefined): FaultBudgetState | undefined {
    if (!row) return undefined;
    return {
      attempts: row.attempts,
      deadline: row.deadline,
      nextAllowedAt: row.nextAllowedAt,
      ...(row.lastAttemptAt === undefined ? {} : { lastAttemptAt: row.lastAttemptAt }),
      failed: row.failed,
      fingerprint: row.lastFingerprint ?? '',
      incident: row.lastIncident ?? '',
    };
  }

  /** The episode of a cause and a task. */
  async episode(episodeKey: string): Promise<FaultEpisodeRow | undefined> {
    const row = await this.db.select<{
      episode?: string; fingerprint?: string; incident?: string; task?: unknown; phase?: string; state?: string;
      evidence_revision?: number; notified?: boolean; opened_at?: unknown; updated_at?: unknown; resolved_at?: unknown;
    }>(episodeId(episodeKey));
    if (!row) return undefined;
    return {
      episode: row.episode ?? episodeKey,
      fingerprint: row.fingerprint ?? '',
      incident: row.incident ?? '',
      taskId: asText(row.task),
      phase: row.phase ?? '',
      state: (row.state ?? 'opened') as FaultEpisodeState,
      evidenceRevision: row.evidence_revision ?? 0,
      notified: row.notified ?? false,
      openedAt: asIso(row.opened_at),
      updatedAt: asIso(row.updated_at),
      ...(row.resolved_at === undefined || row.resolved_at === null ? {} : { resolvedAt: asIso(row.resolved_at) }),
    };
  }

  /** The episodes of a task, newest first. */
  async episodesOfTask(taskId: string): Promise<FaultEpisodeRow[]> {
    const [rows] = await this.db.query<[Array<{
      episode?: string; fingerprint?: string; incident?: string; task?: unknown; phase?: string; state?: string;
      evidence_revision?: number; notified?: boolean; opened_at?: unknown; updated_at?: unknown; resolved_at?: unknown;
    }>]>('SELECT * FROM fault_episode WHERE task = $task ORDER BY updated_at DESC;', { task: new RecordId('task', taskId) });
    const episodes: FaultEpisodeRow[] = [];
    for (const row of rows ?? []) {
      if (!row.episode) continue;
      episodes.push({
        episode: row.episode,
        fingerprint: row.fingerprint ?? '',
        incident: row.incident ?? '',
        taskId: asText(row.task),
        phase: row.phase ?? '',
        state: (row.state ?? 'opened') as FaultEpisodeState,
        evidenceRevision: row.evidence_revision ?? 0,
        notified: row.notified ?? false,
        openedAt: asIso(row.opened_at),
        updatedAt: asIso(row.updated_at),
        ...(row.resolved_at === undefined || row.resolved_at === null ? {} : { resolvedAt: asIso(row.resolved_at) }),
      });
    }
    return episodes;
  }

  /** The incident of a cause: the cross-task group that owns the repair chain. */
  async incident(incident: string): Promise<FaultIncidentRow | undefined> {
    const row = await this.db.select<{
      incident?: string; fingerprint?: string; first_task?: unknown; target?: string; environment?: string;
      identity_alias?: string; reports?: number; state?: string; first_seen_at?: unknown; last_seen_at?: unknown;
    }>(incidentId(incident));
    if (!row) return undefined;
    return {
      incident: row.incident ?? incident,
      fingerprint: row.fingerprint ?? '',
      ...(row.first_task === undefined || row.first_task === null ? {} : { taskId: asText(row.first_task) }),
      target: row.target ?? '',
      ...(row.environment === undefined || row.environment === null ? {} : { environment: row.environment }),
      ...(row.identity_alias === undefined || row.identity_alias === null ? {} : { identityAlias: row.identity_alias }),
      reports: row.reports ?? 0,
      state: row.state ?? 'opened',
      firstSeenAt: asIso(row.first_seen_at),
      lastSeenAt: asIso(row.last_seen_at),
    };
  }

  /** The repair chain of an incident. */
  async repair(incident: string): Promise<FaultRepairRow | undefined> {
    const row = await this.db.select<{
      incident?: string; fingerprint?: string; task?: unknown; source_task?: unknown; state?: string;
      diagnostic?: unknown; created_at?: unknown; updated_at?: unknown;
    }>(repairId(incident));
    if (!row) return undefined;
    return {
      incident: row.incident ?? incident,
      fingerprint: row.fingerprint ?? '',
      ...(row.task === undefined || row.task === null ? {} : { taskId: asText(row.task) }),
      ...(row.source_task === undefined || row.source_task === null ? {} : { sourceTaskId: asText(row.source_task) }),
      state: (row.state ?? 'open') as FaultRepairRow['state'],
      ...(row.diagnostic === undefined || row.diagnostic === null ? {} : { diagnostic: row.diagnostic as FaultDiagnostic }),
      createdAt: asIso(row.created_at),
      updatedAt: asIso(row.updated_at),
    };
  }

  // ------------------------------------------------------------- the write

  /**
   * Reserve the next attempt of a fault object, before the attempt runs.
   *
   * The reservation is atomic: the budget row is updated with a `WHERE` on the attempt count that must not have
   * moved, so two concurrent callers cannot both spend the same attempt. The one that loses the race reads the
   * current state and is told the attempt is taken.
   *
   * The first attempt of an operation is not charged: nothing was known to be broken yet, and a successful call
   * must not eat the recovery budget. From the first recorded failure on, every attempt is charged — either by
   * its reservation or, for the attempt that was not reserved, by the report of its failure.
   */
  async reserve(input: FaultReserveInput): Promise<FaultReserveResult> {
    const key = budgetKey(input.taskId, input.target, input.phase);
    for (let round = 0; round < 4; round++) {
      const row = await this.scope(key);
      if (row?.stopped) {
        // A cause that cannot be recovered stopped this fault object. The stop is on the object, not on the
        // alias, so a rewritten alias does not restart the recovery.
        return {
          allowed: false, attempt: row.attempts + 1, charged: false, reason: 'not_retryable', waitMs: 0,
          ...(row.stopDiagnostic === undefined ? {} : { diagnostic: row.stopDiagnostic }),
        };
      }
      if (!row || !row.failed) {
        // The object is not in recovery: this attempt is the first one, and it costs no budget.
        return { allowed: true, attempt: 0, charged: false, waitMs: 0 };
      }
      const state = FaultStore.stateOf(row);
      const decision = decideAttempt(state, input.limits, input.now, input.leaseExpiresAt);
      if (!decision.allowed) {
        // A refused lease or a minimum interval is not a spent budget: only the budget itself opens the diagnosis.
        const spent = decision.reason === 'attempts_exhausted' || decision.reason === 'deadline_passed';
        const diagnostic = spent ? await this.noteExhaustion(row, input) : undefined;
        return {
          allowed: false, attempt: decision.attempt, charged: false, reason: decision.reason, waitMs: decision.waitMs,
          ...(decision.nextAllowedAt === undefined ? {} : { nextAllowedAt: decision.nextAllowedAt }),
          ...(diagnostic === undefined ? {} : { diagnostic }),
        };
      }
      const charged = await this.charge(key, row, input, decision.attempt, input.phase,
        row.deadline || input.now + input.limits.totalDeadlineMs).catch(() => undefined);
      if (charged) {
        return { allowed: true, attempt: decision.attempt, charged: true, waitMs: 0, budget: charged };
      }
      // The race was lost: read the row again and decide once more.
    }
    return { allowed: false, attempt: 0, charged: false, reason: 'attempts_exhausted', waitMs: 0 };
  }

  /**
   * Report one failure: classify it, group it, and decide whether the recovery may continue.
   *
   * The attempt is charged exactly once — by its reservation when there was one, by this report otherwise. The
   * budget counters decide first and the cause decides last: a cause that cannot be recovered stops the fault
   * object at once, even while the budget still has room, and leaves a diagnosis behind.
   */
  async report(input: FaultReportInput): Promise<FaultReportResult> {
    const fingerprint = faultFingerprint(input.fault);
    const incident = incidentKey(input.fault);
    const key = budgetKey(input.taskId, input.target, input.fault.phase);
    const episodeKey = FaultStore.episodeKey(fingerprint, input.taskId);

    // 1. The incident: one row per cause, counting the reports across tasks and holders.
    await this.bumpIncident(incident, fingerprint, input);

    // 2. The scope: the attempt is charged here only when it was not charged by a reservation.
    let row = await this.scope(key);
    let state = FaultStore.stateOf(row);
    if (input.attempt === undefined && input.charge !== false) {
      // A recovery that was not running starts here: it gets its own deadline.
      const deadline = row && row.failed ? row.deadline : input.now + input.limits.totalDeadlineMs;
      const charged = await this.charge(key, row, input, (state?.attempts ?? 0) + 1, input.fault.phase, deadline)
        .catch(() => undefined);
      if (charged) state = charged;
      else { row = await this.scope(key); state = FaultStore.stateOf(row); }
    }
    await this.noteCause(key, fingerprint, incident, input);

    // 3. The decision: the budget first, the cause last.
    const decision = decideBudget(state, input.limits, input.now, input.fault);

    // 4. The episode: one per cause and task. The same evidence converges onto it.
    const episode = await this.touchEpisode(episodeKey, fingerprint, incident, input);

    // 5. A cause that cannot be recovered stops the fault object at once.
    if (input.fault.retryability !== 'retryable') {
      const diagnostic = diagnosticFor(input.fault, state ?? emptyState(input.limits, input.now), input.limits);
      await this.setStop(key, fingerprint, diagnostic);
      await this.retrying(() => this.setEpisodeState(episodeKey, 'stopped'));
      return {
        fault: input.fault, fingerprint, incident, episode: episodeKey,
        decision: { allowed: false, reason: 'not_retryable', attempt: decision.attempt, waitMs: 0 },
        firstReport: episode.firstReport, exhausted: false, diagnostic,
      };
    }

    // 6. The budget that ran out: one diagnostic and one repair chain.
    if (!decision.allowed && (decision.reason === 'attempts_exhausted' || decision.reason === 'deadline_passed')) {
      const diagnostic = diagnosticFor(input.fault, state ?? emptyState(input.limits, input.now), input.limits);
      await this.retrying(() => this.setEpisodeState(episodeKey, 'exhausted', diagnostic));
      const repair = await this.repair(incident);
      return {
        fault: input.fault, fingerprint, incident, episode: episodeKey, decision,
        firstReport: episode.firstReport, exhausted: true, diagnostic,
        ...(repair?.taskId === undefined ? {} : { repairTaskId: repair.taskId }),
      };
    }

    const repair = await this.repair(incident);
    return {
      fault: input.fault, fingerprint, incident, episode: episodeKey, decision,
      firstReport: episode.firstReport, exhausted: false,
      ...(repair?.taskId === undefined ? {} : { repairTaskId: repair.taskId }),
    };
  }

  /**
   * Charge one attempt to the budget, atomically.
   *
   * The update only lands when the row still holds the attempt count that was read, so two concurrent callers
   * cannot both spend the same attempt. The loser is told so by the empty result and decides again.
   */
  private async charge(key: string, row: FaultScopeRow | undefined,
    input: { taskId: string; target: string; now: number; limits: FaultBudgetLimits; holder?: string; jitterFactor?: number },
    attempt: number, phase: string, deadline: number): Promise<FaultBudgetState | undefined> {
    const now = input.now;
    const wait = backoffWaitMs(input.limits, attempt, input.jitterFactor ?? 0);
    const nextAllowedAt = now + wait + input.limits.minIntervalMs;
    const expected = row?.attempts ?? 0;
    // One statement, no transaction: the compare-and-set on the attempt count is the atomicity, and two
    // concurrent callers cannot both spend the same attempt. A transaction would only add conflicts.
    const exists = row !== undefined;
    const [rows] = exists
      ? await this.db.query<[Array<{ attempts?: number }>]>(`UPDATE $row SET attempts = $attempts,
          total_attempts = total_attempts + 1, deadline = $deadline, next_allowed_at = $next_allowed_at,
          last_attempt_at = $now, failed = true, updated_at = time::now()
          WHERE attempts = $expected RETURN AFTER;`, {
        row: scopeId(key), attempts: attempt, expected, deadline, next_allowed_at: nextAllowedAt, now,
      })
      : await this.db.query<[Array<{ attempts?: number }>]>(`CREATE $row CONTENT { key: $key, task: $task_ref,
          target: $target, phase: $phase, attempts: $attempts, total_attempts: $attempts, deadline: $deadline,
          next_allowed_at: $next_allowed_at, last_attempt_at: $now, failed: true, stopped: false,
          max_attempts: $max_attempts, total_deadline_ms: $total_deadline_ms, min_interval_ms: $min_interval_ms,
          backoff_ms: $backoff_ms, jitter: $jitter, created_at: time::now(), updated_at: time::now() };`, {
        row: scopeId(key), key, task_ref: new RecordId('task', input.taskId), target: input.target, phase,
        attempts: attempt, deadline, next_allowed_at: nextAllowedAt, now,
        max_attempts: input.limits.maxAttempts, total_deadline_ms: input.limits.totalDeadlineMs,
        min_interval_ms: input.limits.minIntervalMs, backoff_ms: input.limits.backoffMs, jitter: input.limits.jitter,
      });
    // The holder is optional, and SurrealDB reads a missing value as NONE while an explicit NULL is a different
    // value than the schema's option<> expects: it is written on its own.
    if (input.holder !== undefined) {
      await this.db.query('UPDATE $row SET last_holder = $holder;', { row: scopeId(key), holder: input.holder });
    }
    if (!rows?.length) return undefined;
    return {
      attempts: attempt, deadline, nextAllowedAt, lastAttemptAt: now, failed: true,
      fingerprint: row?.lastFingerprint ?? '', incident: row?.lastIncident ?? '',
    };
  }

  /**
   * Settle a successful attempt: the fault object works again, so the recovery is over.
   *
   * The reserved attempt is refunded — a call that works costs no recovery budget — and the next failure starts a
   * fresh recovery with a fresh deadline. The cumulative count stays in `total_attempts` for the audit.
   */
  async settle(key: string, now: number): Promise<void> {
    await this.db.query(`UPDATE $row SET failed = false, attempts = 0, next_allowed_at = $now,
      updated_at = time::now() WHERE key = $key AND failed = true;`, { row: scopeId(key), key, now });
  }

  /** Record the cause on the scope row: the last fingerprint, the last incident and the machine facts. */
  private async noteCause(key: string, fingerprint: string, incident: string, input: { fault: FaultRecord }): Promise<void> {
    const fault = input.fault;
    await this.db.query(`UPDATE $row SET failed = true, last_fingerprint = $fingerprint, last_incident = $incident,
      last_errno = $errno, last_hop = $hop, last_http_class = $http_class,
      last_elapsed_ms = $elapsed, updated_at = time::now() WHERE key = $key;`, {
      row: scopeId(key), key, fingerprint, incident, errno: fault.errno, hop: fault.hop, http_class: fault.httpClass,
      elapsed: fault.elapsedMs,
    });
    if (fault.status !== undefined) {
      await this.db.query('UPDATE $row SET last_status = $status;', { row: scopeId(key), status: fault.status });
    }
  }

  /** Stop the fault object: a cause that cannot be recovered does not spend more attempts. */
  private async setStop(key: string, fingerprint: string, diagnostic: FaultDiagnostic): Promise<void> {
    await this.db.query(`UPDATE $row SET stopped = true, stop_reason = 'not_retryable', stop_fingerprint = $fingerprint,
      stop_diagnostic = $diagnostic, updated_at = time::now() WHERE key = $key;`, {
      row: scopeId(key), key, fingerprint, diagnostic,
    });
  }

  /**
   * The budget ran out: the episode is marked exhausted and the one diagnostic of the incident is written to the
   * repair row. The repair task itself is created by the manager who picks the task up, so the repair follows the
   * normal task rules instead of appearing on its own.
   */
  private async noteExhaustion(row: FaultScopeRow, input: FaultReserveInput): Promise<FaultDiagnostic | undefined> {
    const fingerprint = row.lastFingerprint;
    const incident = row.lastIncident;
    if (!fingerprint || !incident) return undefined;
    const fault: FaultRecord = {
      phase: (row.phase || 'unknown') as FaultRecord['phase'],
      hop: (row.lastHop || 'none') as FaultRecord['hop'],
      errno: row.lastErrno || 'none',
      ...(row.lastStatus === undefined ? {} : { status: row.lastStatus }),
      httpClass: (row.lastHttpClass || 'none') as FaultRecord['httpClass'],
      elapsedMs: row.lastElapsedMs ?? 0,
      retryability: 'retryable',
      target: (row.target || 'none') as FaultRecord['target'],
    };
    const state: FaultBudgetState = {
      attempts: row.attempts, deadline: row.deadline, nextAllowedAt: row.nextAllowedAt,
      ...(row.lastAttemptAt === undefined ? {} : { lastAttemptAt: row.lastAttemptAt }),
      failed: true, fingerprint, incident,
    };
    const diagnostic = { ...diagnosticFor(fault, state, input.limits), fingerprint, incident };
    await this.retrying(() => this.setEpisodeState(FaultStore.episodeKey(fingerprint, row.taskId), 'exhausted', diagnostic));
    return diagnostic;
  }

  /** Count the report on the incident row: one row per cause, across tasks and holders. */
  private async bumpIncident(incident: string, fingerprint: string, input: { taskId: string; fault: FaultRecord }): Promise<void> {
    const fault = input.fault;
    // One statement, no explicit transaction: the query string is already atomic, and an open transaction would
    // collide with a concurrent one on the shared connection.
    await this.db.query(`IF (SELECT * FROM ONLY $row) = NONE {
        CREATE $row CONTENT { incident: $incident, fingerprint: $fingerprint, state: 'opened',
          first_task: $task_ref, target: $target, reports: 1,
          first_seen_at: time::now(), last_seen_at: time::now() };
      } ELSE {
        UPDATE $row SET last_seen_at = time::now(), reports += 1;
      };`, {
      row: incidentId(incident), incident, fingerprint, task_ref: new RecordId('task', input.taskId),
      target: fault.target,
    });
    if (fault.environment !== undefined) {
      await this.db.query('UPDATE $row SET environment = $environment;', { row: incidentId(incident), environment: fault.environment });
    }
    if (fault.identityAlias !== undefined) {
      await this.db.query('UPDATE $row SET identity_alias = $alias;', { row: incidentId(incident), alias: fault.identityAlias });
    }
  }

  /**
   * Open or converge the episode of a cause and a task.
   *
   * The first report opens the episode. A later report of the same evidence converges onto it: the manager has
   * one episode to act on, not one per report. Only new evidence (a different fingerprint, and therefore a
   * different episode) or the repair finishing opens a new stage.
   */
  private async touchEpisode(episodeKey: string, fingerprint: string, incident: string, input: FaultReportInput): Promise<{ firstReport: boolean }> {
    const existing = await this.episode(episodeKey);
    if (!existing) {
      await this.db.query(`CREATE $row CONTENT { episode: $episode, fingerprint: $fingerprint, incident: $incident,
        task: $task_ref, phase: $phase, state: 'opened', evidence_revision: 1, notified: false,
        opened_at: time::now(), updated_at: time::now() };`, {
      row: episodeId(episodeKey), episode: episodeKey, fingerprint, incident,
      task_ref: new RecordId('task', input.taskId), phase: input.fault.phase,
    });
      return { firstReport: true };
    }
    if (existing.state === 'resolved') {
      // The repair finished: the same cause may open a new stage, with its own revision.
      await this.db.query(`UPDATE $row SET state = 'opened', evidence_revision = $revision, notified = false,
        resolved_at = NONE, updated_at = time::now();`, {
      row: episodeId(episodeKey), revision: existing.evidenceRevision + 1,
    });
      return { firstReport: true };
    }
    // The same evidence: it converges. The episode stays 'opened' until the manager has been told about it.
    const state = existing.notified ? 'converged' : 'opened';
    await this.db.query('UPDATE $row SET state = $state, updated_at = time::now();', { row: episodeId(episodeKey), state });
    return { firstReport: false };
  }

  /** Move the episode to a state, and write the one diagnostic of the incident into the repair row. */
  private async setEpisodeState(episodeKey: string, state: FaultEpisodeState, diagnostic?: FaultDiagnostic): Promise<void> {
    await this.db.query('UPDATE $row SET state = $state, updated_at = time::now();', { row: episodeId(episodeKey), state });
    if (!diagnostic) return;
    const incident = diagnostic.incident;
    await this.db.query(`IF (SELECT * FROM ONLY $row) = NONE {
        CREATE $row CONTENT { incident: $incident, fingerprint: $fingerprint, state: 'open', diagnostic: $diagnostic,
          created_at: time::now(), updated_at: time::now() };
      } ELSE {
        UPDATE $row SET diagnostic = $diagnostic, updated_at = time::now();
      };`, {
      row: repairId(incident), incident, fingerprint: diagnostic.fingerprint, diagnostic,
    });
  }

  /**
   * Record that the episode reached the manager: exactly one notification per episode. A second call is a no-op,
   * so ten identical reports still produce one notice.
   */
  async markNotified(episodeKey: string, stageStartedAt?: number): Promise<boolean> {
    const [updated] = await this.db.query<[Array<{ notified?: boolean }>]>(
      `UPDATE $episode SET notified = true, notified_at = time::now(), notified_stage_at = IF $stage = NONE THEN NONE ELSE <datetime>$stage END, updated_at = time::now()
       WHERE notified = false OR ($stage != NONE AND (notified_stage_at = NONE OR notified_stage_at < <datetime>$stage)) RETURN AFTER;`,
      { episode: episodeId(episodeKey), stage: stageStartedAt === undefined ? undefined : new Date(stageStartedAt).toISOString() });
    return (updated?.length ?? 0) > 0;
  }

  /**
   * Lift the recovery of one incident on one task: its repair is done, so the episodes of that incident close and
   * the budgets it spent on this task start over (AC04). This is the only way a spent budget comes back — not a new
   * session, a new holder or a re-claimed lease. Only the task's own budgets are reset; the total stays for the audit.
   */
  async liftRepair(input: { taskId: string; incident: string; now: number; limits: FaultBudgetLimits }): Promise<void> {
    const task = new RecordId('task', input.taskId);
    await this.db.query(`UPDATE fault_episode SET state = 'resolved', resolved_at = time::now(), updated_at = time::now()
      WHERE task = $task AND incident = $incident AND state != 'resolved';`, { task, incident: input.incident });
    await this.db.query(`UPDATE fault_budget SET attempts = 0, deadline = $deadline, next_allowed_at = $now,
      stopped = false, stop_reason = NONE, stop_fingerprint = NONE, stop_diagnostic = NONE, failed = false,
      updated_at = time::now() WHERE task = $task AND last_incident = $incident;`, {
      task, incident: input.incident, deadline: input.now + input.limits.totalDeadlineMs, now: input.now,
    });
    await this.db.query(`UPDATE $row SET state = 'done', updated_at = time::now();`, { row: repairId(input.incident) });
  }

  /**
   * Create or link the one repair task of an incident and return its id. The incident key is unique, so a second
   * exhaustion of the same cause links the existing repair instead of creating a second chain.
   */
  async ensureRepair(input: {
    incident: string; fingerprint: string; sourceTaskId: string; diagnostic: FaultDiagnostic; now: number;
    /** Creates the repair task; the caller owns task creation so the repair follows the normal task rules. */
    createTask: (input: { incident: string; fingerprint: string; sourceTaskId: string; diagnostic: FaultDiagnostic }) => Promise<string>;
  }): Promise<string> {
    const existing = await this.repair(input.incident);
    if (existing?.taskId) return existing.taskId;
    const taskId = await input.createTask({
      incident: input.incident, fingerprint: input.fingerprint, sourceTaskId: input.sourceTaskId, diagnostic: input.diagnostic,
    });
    await this.db.query(`IF (SELECT * FROM ONLY $row) = NONE {
        CREATE $row CONTENT { incident: $incident, fingerprint: $fingerprint, task: $task_ref, source_task: $source_ref,
          state: 'open', diagnostic: $diagnostic, created_at: time::now(), updated_at: time::now() };
      } ELSE {
        UPDATE $row SET task = $task_ref, source_task = $source_ref, diagnostic = $diagnostic, updated_at = time::now();
      };`, {
      row: repairId(input.incident), incident: input.incident, fingerprint: input.fingerprint,
      task_ref: new RecordId('task', taskId), source_ref: new RecordId('task', input.sourceTaskId),
      diagnostic: input.diagnostic,
    });
    return taskId;
  }

  /**
   * Run a write that may collide with a concurrent one on the shared connection.
   *
   * A conflict is not a failure of the rule: the same write lands again a moment later. A write that keeps
   * colliding is left to the next call, which reads the current state and writes the same thing.
   */
  private async retrying<T>(write: () => Promise<T>, times = 3): Promise<T | undefined> {
    for (let round = 0; round < times; round++) {
      try { return await write(); }
      catch (error) {
        const message = (error as Error)?.message ?? '';
        if (!/conflict|busy|failed transaction/i.test(message)) throw error;
      }
    }
    return undefined;
  }

  /** The audit trail of a fault object: the stored budget, from which the arithmetic is recomputable. */
  async budgetTrail(key: string): Promise<FaultScopeRow | undefined> {
    return this.scope(key);
  }

  /** Every budget scope of a task, newest first. The diagnostic face reads this; it never invents a row. */
  async scopesOfTask(taskId: string): Promise<FaultScopeRow[]> {
    // SurrealDB requires every ORDER BY field to appear in the selection.
    const [rows] = await this.db.query<[Array<{ key?: string; updated_at?: unknown }>]>(
      'SELECT key, updated_at FROM fault_budget WHERE task = $task ORDER BY updated_at DESC;',
      { task: new RecordId('task', taskId) },
    );
    const scopes: FaultScopeRow[] = [];
    for (const row of rows ?? []) {
      if (!row.key) continue;
      const scope = await this.scope(row.key);
      if (scope) scopes.push(scope);
    }
    return scopes;
  }
}

/** The empty state of a scope that was never charged. */
const emptyState = (limits: FaultBudgetLimits, now: number): FaultBudgetState => ({
  attempts: 0, deadline: now + limits.totalDeadlineMs, nextAllowedAt: now, failed: true, fingerprint: '', incident: '',
});
