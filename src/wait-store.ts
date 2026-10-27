/**
 * SYS05 · The persistence and atomicity layer for waits.
 *
 * Every rule that must survive a restart, a concurrent tick or a lease change lives here, not in the caller's
 * memory:
 *
 * - Entering a wait and releasing the execution lease are one transaction. A crash either leaves the task working
 *   (no wait row) or waiting with no lease — never a wait row while the holder still occupies a seat.
 * - A time condition is released by one compare-and-set on the wait row. Twenty ticks that see the same due row
 *   produce one release; the losers see an empty result and write nothing.
 * - An external event is accepted only once per source id (the unique event key). A duplicate, an expired wait or
 *   a wrong-object event is refused and leaves the task waiting.
 * - Cancel and extend carry the wait version the caller read. A stale version is refused, so two managers cannot
 *   silently overwrite each other's reason.
 */
import { RecordId } from 'surrealdb';
import {
  decideRelease, handoffCard, waitEventKey, waitKeyOf,
  type ExpirySource, type WaitEvent, type WaitEventInput, type WaitHandoffCard, type WaitKind, type WaitProgress,
  type WaitRecord, type WaitSource, type WaitState,
} from './waits.ts';
import type { TaskRow } from './core.ts';

/** The minimal DB surface this store needs. */
export interface WaitStoreDb {
  query<T extends unknown[] = unknown[]>(sql: string, vars?: Record<string, unknown>): Promise<T>;
  select<T>(id: unknown): Promise<T | undefined>;
}

export type WaitEpisodeState = WaitState;

export interface WaitRow {
  waitKey: string;
  taskId: string;
  kind: WaitKind;
  state: WaitEpisodeState;
  source: WaitSource;
  ownerRole: string;
  reference?: string;
  referenceTaskId?: string;
  notBefore?: number;
  expiresAt?: number;
  expiresSource: ExpirySource;
  nextCheckAt?: number;
  timezone?: string;
  progress: WaitProgress;
  completed: string[];
  pendingAction?: string;
  handoffFile?: string;
  reason: string;
  version: number;
  enteredBy: string;
  enteredVersion: number;
  enteredAt: number;
  releasedBy?: string;
  releaseSource?: string;
  heldReason?: string;
  cancelledReason?: string;
}

/** What the core hands to `enter`, after authorization and normalization. */
export interface EnterWaitInput {
  taskId: string;
  waitKey: string;
  normalized: {
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
  };
  progress: WaitProgress;
  /** The phase to restore when the wait releases. */
  resumeState: 'ready' | 'review';
  resumeRole: string;
  actor: string;
  employee: string;
  /** The lease proof the caller held. */
  proof: { deliveryId: string; fence: number; expectedVersion: number };
  now: number;
  evidence: string;
  idem?: string;
  digest?: string;
  auditId: string;
  outboxId: string;
}

export interface ReleaseDueResult {
  released: Array<{ waitKey: string; taskId: string }>;
  held: Array<{ waitKey: string; taskId: string; reason: string }>;
  expired: Array<{ waitKey: string; taskId: string }>;
  /** Rows that were due but did not release, with the machine reason (a race, a refusal). Useful for audit. */
  skipped?: Array<{ waitKey: string; taskId: string; code: string; message: string }>;
}

export interface ResolveWaitInput {
  wait: WaitRow;
  event: WaitEvent;
  expectedVersion: number;
  actor: string;
  /** True only when the caller is the owner relay: the owner really decided. */
  ownerApproved: boolean;
  now: number;
  /** A dependency event synthesized by the scheduler when its reference task finished. */
  synthesized?: boolean;
}

export interface ResolveWaitResult {
  released: boolean;
  code: 'released' | 'duplicate_event' | 'owner_gate' | 'dependency' | 'expired' | 'version_moved' | 'not_waiting' | 'event_mismatch';
  message: string;
  taskId: string;
}

const asText = (value: unknown): string => {
  const raw = value && typeof value === 'object' && 'id' in value ? (value as { id: unknown }).id : value;
  const text = String(raw ?? '');
  return text.includes(':') ? text.split(':').slice(1).join(':') : text;
};

const asMs = (value: unknown): number | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number') return value;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : undefined;
};

const waitId = (key: string) => new RecordId('task_wait', key);
const eventId = (key: string) => new RecordId('wait_event', key);

interface RawWait {
  wait_key?: string; task?: unknown; kind?: string; state?: string; source?: unknown; owner_role?: string;
  reference?: string; reference_task?: unknown; not_before?: number; expires_at?: number; expires_source?: string;
  next_check_at?: number; timezone?: string; progress?: unknown; completed?: string[]; pending_action?: string;
  handoff_file?: string; reason?: string; version?: number; entered_by?: string; entered_version?: number;
  entered_at?: unknown; released_by?: string; release_source?: string; held_reason?: string; cancelled_reason?: string;
}

const rowOf = (raw: RawWait): WaitRow => ({
  waitKey: raw.wait_key ?? '',
  taskId: asText(raw.task),
  kind: (raw.kind ?? 'time') as WaitKind,
  state: (raw.state ?? 'waiting') as WaitState,
  source: (raw.source ?? { kind: 'time' }) as WaitSource,
  ownerRole: raw.owner_role ?? '',
  ...(raw.reference === undefined || raw.reference === null ? {} : { reference: raw.reference }),
  ...(raw.reference_task === undefined || raw.reference_task === null ? {} : { referenceTaskId: asText(raw.reference_task) }),
  ...(raw.not_before === undefined || raw.not_before === null ? {} : { notBefore: raw.not_before }),
  ...(raw.expires_at === undefined || raw.expires_at === null ? {} : { expiresAt: raw.expires_at }),
  expiresSource: (raw.expires_source ?? (raw.expires_at ? 'exact' : 'unknown')) as ExpirySource,
  ...(raw.next_check_at === undefined || raw.next_check_at === null ? {} : { nextCheckAt: raw.next_check_at }),
  ...(raw.timezone === undefined || raw.timezone === null ? {} : { timezone: raw.timezone }),
  progress: (raw.progress ?? {}) as WaitProgress,
  completed: Array.isArray(raw.completed) ? raw.completed : [],
  ...(raw.pending_action === undefined || raw.pending_action === null ? {} : { pendingAction: raw.pending_action }),
  ...(raw.handoff_file === undefined || raw.handoff_file === null ? {} : { handoffFile: raw.handoff_file }),
  reason: raw.reason ?? '',
  version: raw.version ?? 1,
  enteredBy: raw.entered_by ?? '',
  enteredVersion: raw.entered_version ?? 0,
  enteredAt: asMs(raw.entered_at) ?? 0,
  ...(raw.released_by === undefined || raw.released_by === null ? {} : { releasedBy: raw.released_by }),
  ...(raw.release_source === undefined || raw.release_source === null ? {} : { releaseSource: raw.release_source }),
  ...(raw.held_reason === undefined || raw.held_reason === null ? {} : { heldReason: raw.held_reason }),
  ...(raw.cancelled_reason === undefined || raw.cancelled_reason === null ? {} : { cancelledReason: raw.cancelled_reason }),
});

/** The pure view a decision consumes. The row's own identity is preserved. */
export function waitRecordOf(row: WaitRow): WaitRecord {
  return {
    waitKey: row.waitKey, taskId: row.taskId, kind: row.kind, state: row.state, source: row.source,
    ownerRole: row.ownerRole,
    ...(row.reference === undefined ? {} : { reference: row.reference }),
    ...(row.referenceTaskId === undefined ? {} : { referenceTaskId: row.referenceTaskId }),
    ...(row.notBefore === undefined ? {} : { notBefore: row.notBefore }),
    ...(row.expiresAt === undefined ? {} : { expiresAt: row.expiresAt }),
    expiresSource: row.expiresSource,
    ...(row.nextCheckAt === undefined ? {} : { nextCheckAt: row.nextCheckAt }),
    ...(row.timezone === undefined ? {} : { timezone: row.timezone }),
    progress: row.progress,
    completed: row.completed,
    ...(row.pendingAction === undefined ? {} : { pendingAction: row.pendingAction }),
    ...(row.handoffFile === undefined ? {} : { handoffFile: row.handoffFile }),
    reason: row.reason,
    version: row.version,
    enteredAt: row.enteredAt,
  };
}

export class WaitStore {
  constructor(private readonly db: WaitStoreDb) {}

  static key(taskId: string, seed: string): string { return waitKeyOf(taskId, seed); }

  /**
   * Run one transaction and surface the real failure message. The driver reports a failed transaction as a generic
   * "not executed due to a failed transaction" on the awaited query; `.responses()` names the statement that threw,
   * which is what the caller's stable error code (lease expired, already waiting, version moved) is built from.
   */
  private async tx<T>(sql: string, vars: Record<string, unknown>): Promise<T | undefined> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const runner = this.db.query(sql, vars) as unknown as {
        responses(): Promise<Array<{ success: boolean; result?: unknown; error?: { message?: string } }>>;
      };
      const responses = await runner.responses();
      const failures = responses.filter(response => !response.success);
      if (failures.length) {
        const messages = failures.map(response => response.error?.message ?? '').filter(Boolean);
        const cause = messages.find(message => !message.includes('not executed due to') && !message.startsWith('Cannot COMMIT'))
          ?? messages[0] ?? 'transaction failed';
        // The company fork's quota admission reports a lost race as a conflict. A tick that loses the race
        // re-reads and decides again; only a non-conflict failure is a refusal.
        if (/conflict/i.test(cause) && attempt < 4) {
          await Bun.sleep(5 * (attempt + 1));
          continue;
        }
        throw new Error(cause);
      }
      return responses.map(response => response.success ? response.result : undefined).at(-2) as T | undefined;
    }
    throw new Error('transaction retries exhausted');
  }

  // ------------------------------------------------------------------ reads

  async wait(waitKey: string): Promise<WaitRow | undefined> {
    const raw = await this.db.select<RawWait>(waitId(waitKey));
    if (!raw) return undefined;
    const row = rowOf(raw);
    return row.waitKey ? row : undefined;
  }

  /** The open wait of a task, if any. There is at most one by construction. */
  async openOfTask(taskId: string): Promise<WaitRow | undefined> {
    const [rows] = await this.db.query<[RawWait[]]>(
      "SELECT * FROM task_wait WHERE task = $task AND state = 'waiting' ORDER BY entered_at DESC LIMIT 1;",
      { task: new RecordId('task', taskId) });
    return rows?.[0] ? rowOf(rows[0]) : undefined;
  }

  async waitsOfTask(taskId: string): Promise<WaitRow[]> {
    const [rows] = await this.db.query<[RawWait[]]>(
      'SELECT * FROM task_wait WHERE task = $task ORDER BY entered_at DESC LIMIT 50;',
      { task: new RecordId('task', taskId) });
    return (rows ?? []).map(rowOf);
  }

  async list(input: { state?: WaitState; taskId?: string; limit?: number } = {}): Promise<WaitRow[]> {
    const limit = Math.min(Math.max(input.limit ?? 30, 1), 100);
    const conditions: string[] = [];
    const vars: Record<string, unknown> = { limit };
    if (input.state) { conditions.push('state = $state'); vars.state = input.state; }
    if (input.taskId) { conditions.push('task = $task'); vars.task = new RecordId('task', input.taskId); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const [rows] = await this.db.query<[RawWait[]]>(
      `SELECT * FROM task_wait ${where} ORDER BY entered_at DESC LIMIT $limit;`, vars);
    return (rows ?? []).map(rowOf);
  }

  /** The owner handoff cards, newest first. Read-only and bounded. */
  async handoffCards(now: number, limit = 20): Promise<WaitHandoffCard[]> {
    const [rows] = await this.db.query<[RawWait[]]>(
      `SELECT * FROM task_wait WHERE kind = 'owner_handoff' AND state IN ['waiting', 'expired', 'held']
       ORDER BY entered_at DESC LIMIT $limit;`, { limit });
    const waits = (rows ?? []).map(rowOf);
    if (!waits.length) return [];
    // The card is read by the boss: it must name the real task and the party that waits, not a placeholder. One
    // batched task read keeps the card off the per-row round-trip path the WSS channel cannot afford.
    const ids = [...new Set(waits.map(wait => wait.taskId))].map(taskId => new RecordId('task', taskId));
    const [tasks] = await this.db.query<[Array<{ id?: unknown; title?: string; executor_role?: string }>]>(
      'SELECT id, title, executor_role FROM task WHERE id IN $ids;', { ids });
    const byId = new Map((tasks ?? []).map(task => [asText(task.id), task]));
    return waits.map(wait => {
      const task = byId.get(wait.taskId);
      const waitingBy = task?.executor_role ?? wait.progress?.employee ?? wait.ownerRole;
      return handoffCard(waitRecordOf(wait), task?.title ?? wait.taskId, waitingBy, now);
    });
  }

  /** Waits whose next human check is due. This raises a look-at-it reminder; it releases nothing. */
  async dueChecks(now: number, limit = 50): Promise<WaitRow[]> {
    const [rows] = await this.db.query<[RawWait[]]>(
      `SELECT * FROM task_wait WHERE state = 'waiting' AND next_check_at != NONE AND next_check_at <= $now
       ORDER BY next_check_at LIMIT $limit;`, { now, limit });
    return (rows ?? []).map(rowOf);
  }

  /**
   * Expired waits stay on the task until someone cancels or extends them; the row itself is no longer scanned by
   * `releaseDue`. Keep a stable reminder so an expired wait cannot silently disappear from the queue.
   */
  async expiredChecks(limit = 50): Promise<WaitRow[]> {
    const [rows] = await this.db.query<[RawWait[]]>(
      `SELECT * FROM task_wait WHERE state = 'expired' ORDER BY updated_at DESC LIMIT $limit;`, { limit });
    return (rows ?? []).map(rowOf);
  }

  // ------------------------------------------------------------------ enter

  /**
   * Enter a wait: one transaction creates the wait row, clears the lease and moves the task out of the dispatch
   * queue. The task becomes a dependency-shaped blocked task (`blocked_to = NONE`) so an older release does not
   * dispatch it either; `wait_state` is the new code's marker.
   */
  async enter(input: EnterWaitInput): Promise<TaskRow | undefined> {
    const n = input.normalized;
    const source = { kind: n.source.kind, ...(n.source.provider === undefined ? {} : { provider: n.source.provider }) };
    const row = await this.tx<TaskRow>(`BEGIN;
      LET $now = time::unix(time::now());
      LET $t = SELECT * FROM ONLY $task;
      IF $t = NONE { THROW 'task not found' };
      IF $t.state = 'void' { THROW 'task retired' };
      IF $t.state NOT IN ['doing', 'review'] { THROW 'task not held' };
      IF $t.lease_expires_at = NONE OR $t.lease_expires_at <= $now { THROW 'lease expired' };
      IF $t.current_employee != $employee OR $t.delivery_id != $delivery OR $t.fence != $fence OR $t.version != $expected { THROW 'stale lease or version' };
      IF $t.wait_state = 'waiting' { THROW 'task already waiting' };
      IF $kind = 'dependency' OR $kind = 'upstream_repair' {
        IF $reference_task = NONE { THROW 'reference task required' };
        IF $reference = $task { THROW 'a task cannot wait on itself' };
      };
      // Any lingering open wait is superseded: one waiting row per task.
      UPDATE task_wait SET state = 'superseded', updated_at = time::now() WHERE task = $task AND state = 'waiting';
      CREATE ONLY $wait CONTENT {
        wait_key: $key, task: $task, kind: $kind, state: 'waiting', source: $source,
        owner_role: $owner_role, reference: $reference, reference_task: $reference_task,
        not_before: $not_before, expires_at: $expires_at, expires_source: $expires_source,
        next_check_at: $next_check, timezone: $timezone, progress: $progress,
        completed: $completed, pending_action: $pending_action, handoff_file: $handoff_file,
        reason: $reason, version: 1, entered_by: $employee, entered_version: $t.version,
        entered_at: time::now(), updated_at: time::now()
      };
      LET $next = UPDATE ONLY $task SET
        state = 'blocked', blocked_to = NONE, resume_state = $resume_state, resume_role = $resume_role,
        current_employee = NONE, delivery_id = NONE, lease_expires_at = NONE,
        wait_state = 'waiting', wait_kind = $kind, wait_episode = $key, wait_not_before = $not_before,
        wait_expires_at = $expires_at, wait_next_check_at = $next_check, wait_owner_role = $owner_role,
        wait_source = $source_kind, wait_version = 1, wait_entered_at = time::now(),
        version = $t.version + 1 RETURN AFTER;
      UPDATE employee SET active_task = NONE WHERE id = $actor AND active_task = $task;
      CREATE ONLY $audit CONTENT { task: $task, actor: $actor, action: 'wait', evidence: $evidence,
        version: $next.version, at: time::now(), phase: IF $t.state = 'review' THEN 'review' ELSE 'execute' END };
      LET $sequence = UPDATE ONLY company_meta:outbox_counter SET value += 1 RETURN AFTER;
      CREATE ONLY $outbox CONTENT { task: $task, kind: 'wait', sequence: $sequence.value,
        payload: { version: $next.version, state: $next.state, wait_kind: $kind, wait_key: $key }, at: time::now() };
      ${input.idem ? 'CREATE ONLY $idem CONTENT { payload_digest: $digest, result: $next };' : ''}
      RETURN $next;
      COMMIT;`, {
      task: new RecordId('task', input.taskId), wait: waitId(input.waitKey), key: input.waitKey,
      kind: n.kind, state: 'waiting', source,
      source_kind: n.source.kind,
      owner_role: n.ownerRole,
      reference: n.reference ?? undefined,
      reference_task: n.referenceTaskId ? new RecordId('task', n.referenceTaskId) : undefined,
      not_before: n.notBefore ?? undefined,
      expires_at: n.expiresAt ?? undefined,
      expires_source: n.expiresSource,
      next_check: n.nextCheckAt ?? undefined,
      timezone: n.timezone ?? undefined,
      progress: input.progress,
      completed: n.completed,
      pending_action: n.pendingAction ?? undefined,
      handoff_file: n.handoffFile ?? undefined,
      reason: n.reason,
      resume_state: input.resumeState,
      resume_role: input.resumeRole,
      actor: new RecordId('employee', input.actor),
      employee: input.employee,
      delivery: input.proof.deliveryId,
      fence: input.proof.fence,
      expected: input.proof.expectedVersion,
      evidence: input.evidence,
      audit: new RecordId('audit', input.auditId),
      outbox: new RecordId('outbox', input.outboxId),
      ...(input.idem ? { idem: new RecordId('idempotency', input.idem), digest: input.digest } : {}),
    });
    return row;
  }

  // ------------------------------------------------------------------ release

  /**
   * Release every condition that is true now. A time wait releases when `now >= not_before`; a dependency wait
   * releases when its reference task is done or void. Only after both the condition and the task's own gates are
   * clear: a due time never walks past an unfinished dependency or an owner gate.
   */
  async releaseDue(now: number): Promise<ReleaseDueResult> {
    const [rows] = await this.db.query<[RawWait[]]>(
      `SELECT * FROM task_wait WHERE (state = 'waiting' AND (
         (kind = 'time' AND not_before != NONE AND not_before <= $now)
         OR (kind IN ['dependency', 'upstream_repair'] AND reference_task != NONE)
       )) OR state = 'held'
       ORDER BY not_before, entered_at LIMIT 200;`, { now });
    const result: ReleaseDueResult = { released: [], held: [], expired: [], skipped: [] };
    for (const raw of rows ?? []) {
      const row = rowOf(raw);
      if (!row.waitKey) continue;
      const dependency = row.kind === 'dependency' || row.kind === 'upstream_repair';
      let referenceComplete = true;
      if (dependency && row.referenceTaskId) {
        const [ref] = await this.db.query<[Array<{ state?: string }>]>(
          'SELECT state FROM $ref;', { ref: new RecordId('task', row.referenceTaskId) });
        referenceComplete = ref?.[0]?.state === 'done' || ref?.[0]?.state === 'void';
      }
      // A held row is re-checked every tick: once its dependencies/reference finish, it returns to the queue
      // without a manager having to remember it. The release transaction re-reads the reference state, so this
      // pre-check cannot release a task that moved in between. External-event waits are never released by a tick:
      // they need their own trusted event, so a held one waits for resolve/extend/cancel.
      if (dependency && !referenceComplete) continue;
      if (row.state === 'held' && !dependency && row.kind !== 'time') continue;
      if (row.state === 'held' && row.kind === 'time' && (row.notBefore === undefined || now < row.notBefore)) continue;
      const event: WaitEvent = {
        source: row.kind === 'time' ? 'time' : 'dependency', at: now, verified: true,
        ...(row.kind === 'time' ? {} : { eventId: `dependency:${row.referenceTaskId ?? '-'}:done` }),
        objectWaitId: row.waitKey, objectTaskId: row.taskId,
      };
      const outcome = await this.releaseOne(row, event, now, {
        source: row.kind === 'time' ? 'time' : 'dependency', actor: 'system:dispatcher',
        ownerApproved: false, referenceComplete,
        requireReferenceTerminal: dependency,
      });
      if (outcome.released) result.released.push({ waitKey: row.waitKey, taskId: row.taskId });
      else if (outcome.code === 'expired') result.expired.push({ waitKey: row.waitKey, taskId: row.taskId });
      else if (row.state === 'held') {
        // Already held and still not releasable: leave it parked (no repeated held notice every tick).
        result.skipped!.push({ waitKey: row.waitKey, taskId: row.taskId, code: outcome.code, message: outcome.message });
      } else if (outcome.code === 'owner_gate' || outcome.code === 'dependency') {
        result.held.push({ waitKey: row.waitKey, taskId: row.taskId, reason: outcome.message });
        // Mark held so the tick does not retry the same row forever; the card and the owner show why.
        await this.db.query(`UPDATE $wait SET state = 'held', held_reason = $reason, updated_at = time::now()
          WHERE state = 'waiting' AND version = $version;`, {
          wait: waitId(row.waitKey), reason: outcome.message, version: row.version,
        }).catch(() => undefined);
      } else {
        result.skipped!.push({ waitKey: row.waitKey, taskId: row.taskId, code: outcome.code, message: outcome.message });
      }
    }
    return result;
  }

  /** One compare-and-set release. The first caller wins; every other caller sees `version_moved`. */
  async releaseOne(row: WaitRow, event: WaitEvent, now: number, options: {
    source: string; actor: string; ownerApproved: boolean; referenceComplete: boolean;
    /** True for a system dependency event: the reference task must be done/void inside this transaction too. */
    requireReferenceTerminal?: boolean;
  }): Promise<ResolveWaitResult> {
    const gates = {
      dependenciesSatisfied: false, ownerApproved: options.ownerApproved, taskBlockedToOwner: false,
      referenceComplete: options.referenceComplete,
    };
    // The pure decision is the same one the core uses; this pre-check gives a readable answer and the SQL
    // compare-and-set below is what actually makes it count once.
    const decision = decideRelease(waitRecordOf(row), now, { ...gates, dependenciesSatisfied: true }, event);
    if (!decision.release) {
      return { released: false, code: decision.code === 'early' ? 'not_waiting' : decision.code as ResolveWaitResult['code'],
        message: decision.message, taskId: row.taskId };
    }
    const key = waitEventKey(row.waitKey, event);
    try {
      const next = await this.tx<{ id?: unknown }>(`BEGIN;
        LET $w = SELECT * FROM ONLY $wait;
        IF $w = NONE OR $w.state NOT IN ['waiting', 'held'] OR $w.version != $expected { THROW 'wait version moved' };
        IF $require_reference AND $w.reference_task != NONE {
          LET $ref = SELECT state FROM ONLY $w.reference_task;
          IF $ref = NONE OR $ref.state NOT IN ['done', 'void'] { THROW 'reference task not terminal' };
        };
        LET $t = SELECT * FROM ONLY $w.task;
        IF $t = NONE { THROW 'task not found' };
        IF $t.wait_episode != $w.wait_key { THROW 'wait superseded' };
        IF $t.state != 'blocked' { THROW 'task not blocked' };
        IF $t.blocked_to = 'owner' { THROW 'owner gate still holds' };
        LET $unsat = SELECT VALUE count() FROM $t.dependencies WHERE state NOT IN ['done', 'void'] GROUP ALL;
        IF ($unsat[0] ?? 0) > 0 { THROW 'dependencies incomplete' };
        LET $next = UPDATE ONLY $t.id SET
          state = IF $t.resume_state = 'review' THEN 'review' ELSE 'ready' END,
          blocked_to = NONE, resume_state = NONE, resume_role = NONE,
          current_employee = NONE, delivery_id = NONE, lease_expires_at = NONE,
          wait_state = NONE, wait_kind = NONE, wait_episode = NONE, wait_not_before = NONE,
          wait_expires_at = NONE, wait_next_check_at = NONE, wait_owner_role = NONE,
          wait_source = NONE, wait_version = NONE, wait_entered_at = NONE,
          version = $t.version + 1 RETURN AFTER;
        LET $released = UPDATE ONLY $wait SET state = 'released', released_at = time::now(),
          release_source = $source, released_by = $actor, version = $w.version + 1
          WHERE state IN ['waiting', 'held'] AND version = $expected RETURN AFTER;
        IF $released = NONE { THROW 'wait version moved' };
        ${key ? `CREATE ONLY $event CONTENT { event_key: $event_key, wait_key: $w.wait_key, task: $w.task,
          kind: $event_kind, provider: $provider, external_id: $external_id, at_ms: $at, accepted: true,
          actor: $actor, created_at: time::now() };` : ''}
        CREATE ONLY $audit CONTENT { task: $w.task, actor: $w.entered_by, action: 'wait_released',
          evidence: $evidence, version: $next.version, at: time::now(),
          phase: IF $next.state = 'review' THEN 'review' ELSE 'execute' END };
        LET $sequence = UPDATE ONLY company_meta:outbox_counter SET value += 1 RETURN AFTER;
        CREATE ONLY $outbox CONTENT { task: $w.task, kind: 'wait_released', sequence: $sequence.value,
          payload: { version: $next.version, state: $next.state, wait_key: $w.wait_key, source: $source }, at: time::now() };
        RETURN $next;
        COMMIT;`, {
        wait: waitId(row.waitKey), expected: row.version,
        source: options.source, actor: options.actor,
        require_reference: options.requireReferenceTerminal === true,
        ...(key ? {
          event: eventId(key), event_key: key, event_kind: event.source,
          provider: event.provider ?? undefined, external_id: event.eventId ?? undefined,
          at: event.at,
        } : {}),
        evidence: `等待 ${row.waitKey}（${row.kind}）由 ${options.source} 解除；任务回到原阶段`,
        audit: new RecordId('audit', `${row.waitKey}:released`),
        outbox: new RecordId('outbox', `${row.waitKey}:released`),
      });
      if (!next) {
        return { released: false, code: 'version_moved', message: '等待版本已移动，可能是另一个调度轮已解除', taskId: row.taskId };
      }
      return { released: true, code: 'released', message: '条件已解除，任务回到原阶段', taskId: row.taskId };
    } catch (error) {
      const message = (error as Error)?.message ?? '';
      if (/event_key|already exists|duplicate/i.test(message)) {
        return { released: false, code: 'duplicate_event', message: '该来源事件已经处理过（重复事件被拒绝）', taskId: row.taskId };
      }
      if (/owner gate/i.test(message)) {
        return { released: false, code: 'owner_gate', message: '任务仍在老板关口，等待不能代替老板批准', taskId: row.taskId };
      }
      if (/dependencies incomplete/i.test(message)) {
        return { released: false, code: 'dependency', message: '任务依赖尚未完成，到点只释放时间条件', taskId: row.taskId };
      }
      if (/reference task not terminal/i.test(message)) {
        return { released: false, code: 'dependency', message: '引用的修复/上游任务尚未完成或作废', taskId: row.taskId };
      }
      return { released: false, code: 'version_moved', message: `释放未落地：${message.slice(0, 160)}`, taskId: row.taskId };
    }
  }

  /**
   * Resolve a wait from a typed external event. The event has already been validated by the pure module; this
   * method is the atomic acceptance: unique event key, wait version CAS, and the same dependency/owner gates.
   */
  async resolve(input: ResolveWaitInput): Promise<ResolveWaitResult> {
    const row = input.wait;
    const event = input.event;
    const key = waitEventKey(row.waitKey, event);
    // A dependency wait is valid only when the reference task really is terminal. This applies to both the
    // system dependency event and a signed webhook: a provider's signature proves the event is authentic, not that
    // the referenced repair finished. An authorized person is the explicit human exemption and is audited as such.
    const referenceKinds = row.kind === 'dependency' || row.kind === 'upstream_repair';
    const authorizedExemption = event.source === 'authorized_person';
    let referenceComplete = true;
    if (referenceKinds && row.referenceTaskId) {
      const [refs] = await this.db.query<[Array<{ state?: string }>]>(
        'SELECT state FROM $ref;', { ref: new RecordId('task', row.referenceTaskId) });
      referenceComplete = refs?.[0]?.state === 'done' || refs?.[0]?.state === 'void';
    }
    const gateReference = referenceKinds && !authorizedExemption ? referenceComplete : true;
    const requireReferenceTerminal = referenceKinds && !authorizedExemption;
    const decision = decideRelease(waitRecordOf(row), input.now, {
      dependenciesSatisfied: true, ownerApproved: input.ownerApproved, taskBlockedToOwner: false,
      referenceComplete: gateReference,
    }, event);
    if (!decision.release) {
      // Record the refused event for the audit, without making it count. A refused event must not be replayed.
      if (key) {
        await this.db.query(`IF (SELECT * FROM ONLY $event) = NONE {
            CREATE ONLY $event CONTENT { event_key: $key, wait_key: $wait_key, task: $task, kind: $kind,
              provider: $provider, external_id: $external_id, at_ms: $at, accepted: false, refusal: $refusal,
              actor: $actor, ${event.ownerQuote ? 'owner_quote: $owner_quote,' : ''} created_at: time::now() };
          };`, {
          event: eventId(key), key, wait_key: row.waitKey, task: new RecordId('task', row.taskId),
          kind: event.source, provider: event.provider ?? undefined, external_id: event.eventId ?? undefined,
          at: event.at, refusal: decision.code, actor: input.actor,
          ...(event.ownerQuote ? { owner_quote: event.ownerQuote } : {}),
        }).catch(() => undefined);
      }
      return { released: false, code: decision.code as ResolveWaitResult['code'], message: decision.message, taskId: row.taskId };
    }
    const outcome = await this.releaseOne(row, event, input.now, {
      source: event.source, actor: input.actor, ownerApproved: input.ownerApproved,
      referenceComplete: gateReference, requireReferenceTerminal,
    });
    if (outcome.released && event.ownerQuote) {
      await this.db.query(
        'UPDATE $event SET owner_quote = $quote WHERE wait_key = $wait AND kind = $kind AND accepted = true;',
        { event: eventId(waitEventKey(row.waitKey, event)!), quote: event.ownerQuote, wait: row.waitKey, kind: event.source },
      ).catch(() => undefined);
    }
    return outcome;
  }

  // ------------------------------------------------------------------ cancel / extend

  /**
   * Cancel a wait under its version. `resume` is the caller's explicit statement that the blocker is gone:
   * without it the task stays blocked and is handed to the manager — cancelling a wait is not the same as
   * resolving the condition.
   */
  async cancel(input: {
    waitKey: string; expectedVersion: number; reason: string; actor: string; resume: boolean; now: number;
  }): Promise<{ cancelled: boolean; taskId?: string; state?: string; message: string }> {
    try {
      const next = await this.tx<{ task?: unknown; state?: string; resume_state?: string }>(`BEGIN;
        LET $w = SELECT * FROM ONLY $wait;
        IF $w = NONE OR $w.state NOT IN ['waiting', 'expired', 'held'] { THROW 'wait not open' };
        IF $w.version != $expected { THROW 'wait version moved' };
        LET $cancelled = UPDATE ONLY $wait SET state = 'cancelled', cancelled_reason = $reason,
          updated_at = time::now(), version = $w.version + 1 WHERE version = $expected RETURN AFTER;
        IF $cancelled = NONE { THROW 'wait version moved' };
        LET $t = SELECT * FROM ONLY $w.task;
        LET $unsat = SELECT VALUE count() FROM $t.dependencies WHERE state NOT IN ['done', 'void'] GROUP ALL;
        LET $blocked = ($unsat[0] ?? 0) > 0 OR $t.blocked_to = 'owner' OR !$resume;
        LET $next = UPDATE ONLY $t.id SET
          state = IF $blocked THEN 'blocked' ELSE ($t.resume_state ?? 'ready') END,
          blocked_to = IF $blocked THEN (IF $t.blocked_to = 'owner' THEN 'owner' ELSE 'gm' END) ELSE NONE END,
          resume_state = IF $blocked THEN ($t.resume_state ?? 'ready') ELSE NONE END,
          resume_role = IF $blocked THEN $t.resume_role ELSE NONE END,
          wait_state = NONE, wait_kind = NONE, wait_episode = NONE, wait_not_before = NONE,
          wait_expires_at = NONE, wait_next_check_at = NONE, wait_owner_role = NONE,
          wait_source = NONE, wait_version = NONE, wait_entered_at = NONE,
          version = $t.version + 1 RETURN AFTER;
        CREATE ONLY $audit CONTENT { task: $w.task, actor: $actor, action: 'wait_cancelled', evidence: $reason,
          version: $next.version, at: time::now() };
        LET $sequence = UPDATE ONLY company_meta:outbox_counter SET value += 1 RETURN AFTER;
        CREATE ONLY $outbox CONTENT { task: $w.task, kind: 'wait_cancelled', sequence: $sequence.value,
          payload: { version: $next.version, state: $next.state, wait_key: $w.wait_key }, at: time::now() };
        RETURN $next;
        COMMIT;`, {
        wait: waitId(input.waitKey), expected: input.expectedVersion, reason: input.reason,
        actor: input.actor, resume: input.resume,
        audit: new RecordId('audit', `${input.waitKey}:cancelled`),
        outbox: new RecordId('outbox', `${input.waitKey}:cancelled`),
      });
      return { cancelled: Boolean(next), ...(next?.task === undefined ? {} : { taskId: asText(next.task) }),
        ...(next?.state === undefined ? {} : { state: next.state }), message: '等待已取消' };
    } catch (error) {
      return { cancelled: false, message: `取消失败：${((error as Error)?.message ?? '').slice(0, 160)}` };
    }
  }

  /** Extend or re-arm a wait under its version. A stale version is refused; the reason is stored. */
  async extend(input: {
    waitKey: string; expectedVersion: number; reason: string; actor: string;
    notBefore?: number; expiresAt?: number; nextCheckAt?: number; now: number;
  }): Promise<{ extended: boolean; version?: number; message: string }> {
    if (input.notBefore === undefined && input.expiresAt === undefined && input.nextCheckAt === undefined) {
      return { extended: false, message: '延期至少要给出新的 notBefore、expiresAt 或 nextCheckAt' };
    }
    try {
      const next = await this.tx<{ version?: number }>(`BEGIN;
        LET $w = SELECT * FROM ONLY $wait;
        IF $w = NONE OR $w.state IN ['released', 'cancelled', 'superseded'] { THROW 'wait not extendable' };
        IF $w.version != $expected { THROW 'wait version moved' };
        LET $next = UPDATE ONLY $wait SET
          state = 'waiting',
          not_before = IF $not_before != NONE THEN $not_before ELSE $w.not_before END,
          expires_at = IF $expires_at != NONE THEN $expires_at ELSE $w.expires_at END,
          expires_source = IF $expires_at != NONE THEN 'exact' ELSE $w.expires_source END,
          next_check_at = IF $next_check != NONE THEN $next_check ELSE $w.next_check_at END,
          cancelled_reason = NONE, held_reason = NONE,
          reason = $reason, updated_at = time::now(), version = $w.version + 1
          WHERE version = $expected RETURN AFTER;
        IF $next = NONE { THROW 'wait version moved' };
        LET $t = SELECT * FROM ONLY $w.task;
        LET $task_next = UPDATE ONLY $t.id SET
          wait_state = 'waiting', wait_kind = $w.kind, wait_episode = $w.wait_key,
          wait_not_before = $next.not_before, wait_expires_at = $next.expires_at,
          wait_next_check_at = $next.next_check_at, wait_owner_role = $w.owner_role,
          wait_version = $next.version, version = $t.version + 1 RETURN AFTER;
        CREATE ONLY $audit CONTENT { task: $w.task, actor: $actor, action: 'wait_extended', evidence: $reason,
          version: $task_next.version, at: time::now() };
        RETURN $next;
        COMMIT;`, {
        wait: waitId(input.waitKey), expected: input.expectedVersion, reason: input.reason, actor: input.actor,
        not_before: input.notBefore ?? undefined, expires_at: input.expiresAt ?? undefined,
        next_check: input.nextCheckAt ?? undefined,
        audit: new RecordId('audit', `${input.waitKey}:extended`),
        outbox: new RecordId('outbox', `${input.waitKey}:extended`),
      }).catch(error => {
        throw error;
      });
      return { extended: Boolean(next), ...(next?.version === undefined ? {} : { version: next.version }), message: '等待已延期' };
    } catch (error) {
      return { extended: false, message: `延期失败：${((error as Error)?.message ?? '').slice(0, 160)}` };
    }
  }

  /** Mark waits whose precise expiry passed with no accepted event. The task stays blocked; nothing is auto-released. */
  async markExpired(now: number): Promise<Array<{ waitKey: string; taskId: string }>> {
    const [rows] = await this.db.query<[RawWait[]]>(
      `UPDATE task_wait SET state = 'expired', updated_at = time::now()
       WHERE state IN ['waiting', 'held'] AND expires_at != NONE AND expires_at < $now RETURN AFTER;`, { now });
    return (rows ?? []).map(row => ({ waitKey: row.wait_key ?? '', taskId: asText(row.task) }));
  }

  /**
   * Migrate one legacy time-bounded task into a wait. This is deliberately per task: a batch run could release an
   * owner gate or a gate whose real blocker is not time, so the caller must name the task and its version. Owner
   * gates are refused outright; the legacy `quota_resets_at` is the only time bound this accepts.
   */
  async migrateLegacy(input: {
    taskId: string; waitKey: string; expectedVersion: number; reason: string; actor: string; now: number;
    auditId: string; outboxId: string;
  }): Promise<TaskRow | undefined> {
    return this.tx<TaskRow>(`BEGIN;
      LET $t = SELECT * FROM ONLY $task;
      IF $t = NONE { THROW 'task not found' };
      IF $t.version != $expected { THROW 'task version moved' };
      IF $t.state IN ['done', 'void'] { THROW 'task terminal' };
      IF $t.state != 'blocked' { THROW 'task not blocked for migration' };
      IF $t.wait_state = 'waiting' { THROW 'task already waiting' };
      IF $t.reviewer_role = 'owner' OR $t.blocked_to = 'owner' { THROW 'owner gate cannot be migrated' };
      IF $t.current_employee != NONE AND $t.lease_expires_at > time::unix(time::now()) { THROW 'task still leased' };
      IF $t.quota_resets_at = NONE OR ($t.quota_resets_at * 1000) <= $now { THROW 'task has no future time bound' };
      LET $not_before = $t.quota_resets_at * 1000;
      LET $resume = $t.resume_state ?? (IF $t.state = 'review' THEN 'review' ELSE 'ready' END);
      LET $role = $t.resume_role ?? (IF $t.state = 'review' THEN $t.reviewer_role ELSE $t.executor_role END);
      UPDATE task_wait SET state = 'superseded', updated_at = time::now() WHERE task = $task AND state IN ['waiting', 'held'];
      CREATE ONLY $wait CONTENT {
        wait_key: $key, task: $task, kind: 'time', state: 'waiting', source: { kind: 'time' },
        owner_role: $role, not_before: $not_before, expires_source: 'unknown',
        progress: { employee: 'system:migration', taskVersion: $t.version, at: $now },
        completed: [], reason: $reason, version: 1, entered_by: 'system:migration',
        entered_version: $t.version, entered_at: time::now(), updated_at: time::now()
      };
      LET $next = UPDATE ONLY $t.id SET
        state = 'blocked', blocked_to = NONE, resume_state = $resume, resume_role = $role,
        current_employee = NONE, delivery_id = NONE, lease_expires_at = NONE,
        wait_state = 'waiting', wait_kind = 'time', wait_episode = $key, wait_not_before = $not_before,
        wait_expires_at = NONE, wait_next_check_at = NONE, wait_owner_role = $role,
        wait_source = 'time', wait_version = 1, wait_entered_at = time::now(), quota_resets_at = NONE,
        version = $t.version + 1 RETURN AFTER;
      UPDATE employee SET active_task = NONE WHERE active_task = $task;
      CREATE ONLY $audit CONTENT { task: $task, actor: $actor, action: 'wait_migrated', evidence: $reason,
        version: $next.version, at: time::now() };
      LET $sequence = UPDATE ONLY company_meta:outbox_counter SET value += 1 RETURN AFTER;
      CREATE ONLY $outbox CONTENT { task: $task, kind: 'wait_migrated', sequence: $sequence.value,
        payload: { version: $next.version, state: $next.state, wait_key: $key }, at: time::now() };
      RETURN $next;
      COMMIT;`, {
      task: new RecordId('task', input.taskId), wait: waitId(input.waitKey), key: input.waitKey,
      expected: input.expectedVersion, reason: input.reason, actor: input.actor, now: input.now,
      audit: new RecordId('audit', input.auditId), outbox: new RecordId('outbox', input.outboxId),
    });
  }

}
