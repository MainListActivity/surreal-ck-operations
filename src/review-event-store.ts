/**
 * SYS-INT · Persistence and delivery for QA-review wake subscriptions.
 *
 * The rules that must survive a restart, a concurrent claim and a fresh registration live here:
 *
 * - Registering a watch is one transaction, and the current source state is read right after it. A QA claim or an
 *   already-requested signal that happened moments before the registration is therefore delivered, not lost.
 * - A wake event is identified by (watch, review fence, event kind). A replayed claim, a repeated request, a
 *   restarted process or two concurrent callers produce one event, and the unique index is what enforces it.
 * - Delivery only releases the collaboration task's own SYS05 feedback wait, and only when that wait names this
 *   watch as its reference. A late event is re-checked against the live review lease first; a moved fence, a
 *   different holder or an ended review invalidates it instead of waking anyone.
 * - Nothing here grants a scope, writes acceptance evidence or touches the source task's lease.
 */
import { createHash, randomUUID } from 'node:crypto';
import { RecordId } from 'surrealdb';
import { CompanyError } from './core-errors.ts';
import { assertNonSensitive } from './waits.ts';
import { WaitStore } from './wait-store.ts';
import {
  REVIEW_EVENT_VIEW_LIMIT, REVIEW_SIGNAL_GUIDANCE, REVIEW_WATCH_GUIDANCE,
  normalizeEventKinds, normalizeScopeSubjects, reviewEventKeyOf, reviewEventStaleReason, reviewWatchKeyOf,
  qaScopeSignalKeyOf, signalEventKind, validateWatchPair,
  type QaScopeSignalInput, type QaScopeSignalView, type ReviewDeliveryView, type ReviewEventKind, type ReviewSignalKind,
  type ReviewSignalView, type ReviewSourceState, type ReviewWakeView, type ReviewWatchCloseInput, type ReviewWatchInput,
  type ReviewWatchView,
} from './review-events.ts';

export interface ReviewEventDb {
  query<T extends unknown[] = unknown[]>(sql: string, vars?: Record<string, unknown>): Promise<T>;
  select<T>(id: unknown): Promise<T | undefined>;
}

interface WatchRow {
  id: RecordId; watch_key: string; goal: RecordId; source_task: RecordId; collaboration_task: RecordId;
  event_kinds: string[]; state: 'active' | 'closed'; version: number; reason: string; created_by: RecordId;
  created_at: string; updated_at: string; closed_at?: string; closed_by?: RecordId; closed_reason?: string;
}
interface SignalRow {
  id: RecordId; signal_key: string; task: RecordId; goal: RecordId; actor: string; fence: number;
  kind: ReviewSignalKind; state: 'requested' | 'retracted'; subjects: string[]; positive_ready: boolean;
  reason: string; version: number; created_at: string; updated_at: string; retracted_at?: string;
}
interface WakeRow {
  id: RecordId; event_key: string; watch: RecordId; source_task: RecordId; collaboration_task: RecordId;
  kind: ReviewEventKind; fence: number; actor: string; subjects: string[]; reason?: string;
  delivered: boolean; delivered_at?: string; code?: string; wait_key?: string; invalidated_reason?: string;
  created_at: string;
}
interface TaskFactsRow {
  state?: string; reviewer_role?: string; current_employee?: string; fence?: number; lease_expires_at?: number;
  goal?: RecordId; submitted_by?: string; implementer?: string;
}
interface IdemRow { payload_digest: string; result: unknown }

const hashOf = (...parts: Array<string | number>) =>
  createHash('sha256').update(parts.join('\u0000')).digest('hex');

export const reviewWatchId = (sourceTaskId: string, collaborationTaskId: string): string =>
  hashOf('watch', sourceTaskId, collaborationTaskId).slice(0, 32);

const watchRecord = (id: string) => new RecordId('qa_review_watch', id);
const signalRecord = (taskId: string, fence: number, actor: string) =>
  new RecordId('qa_review_signal', hashOf('signal', taskId, fence, actor).slice(0, 32));
const wakeRecord = (watchId: string, fence: number, kind: ReviewEventKind) =>
  new RecordId('qa_review_wake', hashOf('wake', watchId, fence, kind).slice(0, 32));
const idemRecord = (actor: string, action: string, key: string) =>
  new RecordId('idempotency', hashOf(actor, action, key));

/** The SYS05 wait a collaboration task enters to be woken by one watch: `kind=feedback` + this reference. */
export const reviewWatchRef = (watchId: string): string => `review-watch:${watchId}`;
/** The watch a wait reference names, or undefined when the wait is not a review-event wait. */
export const watchOfRef = (reference: string | undefined): string | undefined => {
  if (!reference || !reference.startsWith('review-watch:')) return undefined;
  const id = reference.slice('review-watch:'.length);
  return /^[a-f0-9]{32}$/.test(id) ? id : undefined;
};

const asId = (value: unknown): string =>
  value instanceof RecordId ? String(value.id) : String(value ?? '').split(':').slice(1).join(':');

const signalView = (row: SignalRow): ReviewSignalView => ({
  id: asId(row.id), taskId: asId(row.task), goalId: asId(row.goal), actor: row.actor, fence: row.fence,
  kind: row.kind, state: row.state, subjects: [...(row.subjects ?? [])], positiveReady: row.positive_ready === true,
  reason: row.reason, createdAt: String(row.created_at),
  ...(row.retracted_at ? { retractedAt: String(row.retracted_at) } : {}),
});

const deliveryView = (row: WakeRow): ReviewDeliveryView => ({
  eventId: row.event_key, kind: row.kind, fence: row.fence, actor: row.actor, at: String(row.created_at),
  delivered: row.delivered === true,
  ...(row.delivered_at ? { deliveredAt: String(row.delivered_at) } : {}),
  ...(row.code ? { code: row.code } : {}),
  ...(row.invalidated_reason ? { invalidatedReason: row.invalidated_reason } : {}),
});

const requireReason = (value: unknown): string => {
  if (typeof value !== 'string' || value.trim().length < 8 || value.length > 2000) {
    throw new CompanyError('invalid', 'reason must be 8-2000 characters');
  }
  return value.trim();
};

export class ReviewEventStore {
  constructor(
    private readonly db: ReviewEventDb,
    private readonly waits: WaitStore,
    private readonly clock: () => number,
  ) {}

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
        const tagged = /review events (invalid|moved): ([^'"\n]+)/i.exec(cause);
        if (tagged) {
          const kind = tagged[1]!.toLowerCase() === 'moved' ? 'conflict' : 'invalid';
          throw new CompanyError(kind, `Review events ${tagged[1]!.toLowerCase()}: ${tagged[2]!.trim()}`);
        }
        if (/conflict/i.test(cause) && attempt < 4) { await Bun.sleep(5 * (attempt + 1)); continue; }
        if (/already exists|duplicate/i.test(cause)) throw new CompanyError('conflict', 'Review events moved: the row already exists');
        throw new CompanyError('conflict', `Review events failed: ${cause.slice(0, 160)}`);
      }
      return responses.map(response => response.success ? response.result : undefined).at(-2) as T | undefined;
    }
    throw new CompanyError('temporarily_unavailable', 'Review event transaction retries exhausted', true);
  }

  private async replay<T>(ident: RecordId, digest: string): Promise<T | undefined> {
    const prior = await this.db.select<IdemRow>(ident);
    if (!prior) return undefined;
    if (prior.payload_digest !== digest) throw new CompanyError('conflict', 'Idempotency key reused with different input');
    return prior.result as T;
  }

  /** The live facts of one source task; every delivery re-reads them instead of trusting the event row. */
  async sourceState(taskId: string): Promise<ReviewSourceState> {
    const row = await this.db.select<TaskFactsRow>(new RecordId('task', taskId));
    const live = row?.lease_expires_at !== undefined && row.lease_expires_at !== null &&
      row.lease_expires_at > Math.floor(this.clock() / 1000);
    return {
      ...(row?.state === undefined ? {} : { state: row.state }),
      ...(row?.reviewer_role === undefined ? {} : { reviewerRole: row.reviewer_role }),
      ...(row?.current_employee === undefined ? {} : { holder: row.current_employee }),
      ...(row?.fence === undefined ? {} : { fence: row.fence }),
      leaseLive: live,
    };
  }

  private async watchView(row: WatchRow): Promise<ReviewWatchView> {
    const source = await this.sourceState(asId(row.source_task));
    const [wakes] = await this.db.query<[WakeRow[]]>(
      'SELECT * FROM qa_review_wake WHERE watch = $watch ORDER BY created_at DESC LIMIT $limit;',
      { watch: row.id, limit: REVIEW_EVENT_VIEW_LIMIT });
    const [signals] = await this.db.query<[SignalRow[]]>(
      'SELECT * FROM qa_review_signal WHERE task = $task ORDER BY updated_at DESC LIMIT 1;',
      { task: row.source_task });
    const signal = signals?.[0];
    return {
      id: asId(row.id), goalId: asId(row.goal), sourceTaskId: asId(row.source_task),
      collaborationTaskId: asId(row.collaboration_task), eventKinds: [...(row.event_kinds ?? [])],
      state: row.state === 'closed' ? 'closed' : 'active', version: row.version, reason: row.reason,
      createdAt: String(row.created_at),
      ...(row.closed_at ? { closedAt: String(row.closed_at) } : {}),
      ...(row.closed_reason ? { closedReason: row.closed_reason } : {}),
      source, ...(signal ? { signal: signalView(signal) } : {}),
      deliveries: (wakes ?? []).map(deliveryView),
      guidance: REVIEW_WATCH_GUIDANCE,
    };
  }

  private async watchRow(watchId: string): Promise<WatchRow | undefined> {
    return this.db.select<WatchRow>(watchRecord(watchId));
  }

  // ------------------------------------------------------------------ registration

  /**
   * Register (or re-open) the one watch of an ordered task pair and deliver whatever the current state already
   * warrants. The insert and the state read are deliberately adjacent: a claim that lands between them is seen by
   * the state read, and a claim that landed before the insert is seen by it too.
   */
  async register(input: ReviewWatchInput & { actor: string }): Promise<ReviewWatchView> {
    const pair = validateWatchPair(input);
    const kinds = normalizeEventKinds(input.eventKinds);
    const reason = assertNonSensitive(requireReason(input.reason), 'reason');
    const ident = idemRecord(input.actor, 'qa_review_watch_register', input.idempotencyKey);
    const digest = hashOf('register', pair.sourceTaskId, pair.collaborationTaskId, kinds.join(','), reason);
    const prior = await this.replay<WatchRow>(ident, digest);
    if (prior) return this.watchView(prior);
    const id = reviewWatchId(pair.sourceTaskId, pair.collaborationTaskId);
    const query = `BEGIN;
      LET $who = SELECT * FROM ONLY $actor;
      IF $who = NONE OR $who.revoked = true OR 'manage' NOT IN $who.capabilities OR $who.role != 'gm' { THROW 'review events invalid: only gm may register a review watch' };
      LET $s = SELECT * FROM ONLY $source;
      LET $c = SELECT * FROM ONLY $collab;
      IF $s = NONE { THROW 'review events invalid: source task not found' };
      IF $c = NONE { THROW 'review events invalid: collaboration task not found' };
      IF $s.goal = NONE OR $c.goal = NONE OR $s.goal != $c.goal { THROW 'review events invalid: both tasks must be in the same goal' };
      IF $s.reviewer_role != 'qa' { THROW 'review events invalid: the source task is not reviewed by qa' };
      IF $c.state IN ['done', 'void'] { THROW 'review events invalid: the collaboration task is already terminal' };
      LET $existing = SELECT * FROM ONLY $watch;
      IF $existing = NONE {
        CREATE ONLY $watch CONTENT { watch_key: $watch_key, goal: $s.goal, source_task: $source, collaboration_task: $collab,
          event_kinds: $kinds, state: 'active', version: 1, reason: $reason, created_by: $actor,
          created_at: time::now(), updated_at: time::now() };
      } ELSE {
        IF $existing.event_kinds != $kinds { THROW 'review events moved: the watch exists with other event kinds; close it before re-registering' };
        UPDATE ONLY $watch SET state = 'active', reason = $reason, version = $existing.version + 1,
          updated_at = time::now(), closed_at = NONE, closed_by = NONE, closed_reason = NONE;
      };
      CREATE ONLY $audit CONTENT { task: $source, actor: $actor, action: 'qa_review_watch_register',
        evidence: $evidence, at: time::now(), fence: $s.fence };
      CREATE ONLY $idem CONTENT { at: time::now(), payload_digest: $digest, result: (SELECT * FROM ONLY $watch) };
      RETURN SELECT * FROM ONLY $watch;
      COMMIT;`;
    const evidence = `${reason}\n[qa_review_watch_register] watch=${id} source=${pair.sourceTaskId} collaboration=${pair.collaborationTaskId} kinds=${kinds.join(',')}`;
    const row = await this.tx<WatchRow>(query, {
      actor: new RecordId('employee', input.actor), source: new RecordId('task', pair.sourceTaskId),
      collab: new RecordId('task', pair.collaborationTaskId), watch: watchRecord(id),
      watch_key: reviewWatchKeyOf(pair.sourceTaskId, pair.collaborationTaskId),
      kinds, reason, evidence, digest, idem: ident, audit: new RecordId('audit', randomUUID()),
    });
    if (!row) throw new CompanyError('temporarily_unavailable', 'Review watch was not stored; retry', true);
    const stored = await this.watchRow(id) ?? row;
    // Current state, read after the insert: a claim or a structured request that preceded the registration is
    // delivered here instead of waiting for a second event that may never come.
    await this.syncCurrentState(stored);
    return this.watchView(stored);
  }

  /** Emit whatever the current source state already warrants. The event key makes repeated syncs one event. */
  async syncWatch(watchId: string): Promise<void> {
    const watch = await this.watchRow(watchId);
    if (watch) await this.syncCurrentState(watch);
  }

  private async syncCurrentState(watch: WatchRow): Promise<void> {
    if (watch.state !== 'active') return;
    const sourceId = asId(watch.source_task);
    const facts = await this.db.select<TaskFactsRow>(watch.source_task);
    if (!facts) return;
    const kinds = watch.event_kinds ?? [];
    const live = facts.lease_expires_at !== undefined && facts.lease_expires_at !== null &&
      facts.lease_expires_at > Math.floor(this.clock() / 1000);
    if (facts.state === 'review' && facts.reviewer_role === 'qa' && live && facts.current_employee && facts.fence &&
        kinds.includes('authorization')) {
      await this.emit({ watch, sourceTaskId: sourceId, fence: facts.fence, kind: 'authorization',
        actor: facts.current_employee, subjects: [], reason: 'the QA review lease is held on this source task' });
    }
    const [signals] = await this.db.query<[SignalRow[]]>(
      'SELECT * FROM qa_review_signal WHERE task = $task ORDER BY updated_at DESC LIMIT 1;', { task: watch.source_task });
    const signal = signals?.[0];
    if (!signal) return;
    if (signal.state === 'requested' && kinds.includes('authorization')) {
      await this.emit({ watch, sourceTaskId: sourceId, fence: signal.fence, kind: 'authorization',
        actor: signal.actor, subjects: [...signal.subjects], reason: signal.reason });
    }
    if (signal.state === 'retracted' && signal.positive_ready && kinds.includes('positive')) {
      await this.emit({ watch, sourceTaskId: sourceId, fence: signal.fence, kind: 'positive',
        actor: signal.actor, subjects: [...signal.subjects], reason: signal.reason });
    }
  }

  // ------------------------------------------------------------------ events

  /** Create one wake event per (watch, fence, kind), then try to deliver it. */
  private async emit(input: { watch: WatchRow; sourceTaskId: string; fence: number; kind: ReviewEventKind;
    actor: string; subjects: string[]; reason: string }): Promise<ReviewWakeView | undefined> {
    const watchId = asId(input.watch.id);
    const id = wakeRecord(watchId, input.fence, input.kind);
    const key = `${watchId}:${reviewEventKeyOf(input.sourceTaskId, input.fence, input.kind)}`;
    const existing = await this.db.select<WakeRow>(id);
    if (existing?.delivered) {
      // The event already woke the collaboration task: this caller is a duplicate notification, not a second wake.
      return { watchId, eventId: existing.event_key, kind: existing.kind, fence: existing.fence, released: false, code: 'duplicate' };
    }
    if (existing?.invalidated_reason) {
      return { watchId, eventId: existing.event_key, kind: existing.kind, fence: existing.fence,
        released: false, code: 'invalidated' };
    }
    if (!existing) {
      const created = await this.db.query(
        'CREATE ONLY $id CONTENT { event_key: $key, watch: $watch, source_task: $source, collaboration_task: $collab, '
        + 'kind: $kind, fence: $fence, actor: $actor, subjects: $subjects, reason: $reason, delivered: false, '
        + 'created_at: time::now() };', {
          id, key, watch: input.watch.id, source: new RecordId('task', input.sourceTaskId),
          collab: input.watch.collaboration_task, kind: input.kind, fence: input.fence, actor: input.actor,
          subjects: [...input.subjects].sort(), reason: input.reason.slice(0, 600),
        }).then(() => true, (error: unknown) => {
          // Two concurrent emitters: the unique event_key makes the second one a duplicate, not a second wake.
          if (/already exists|duplicate|conflict/i.test(String((error as Error)?.message ?? error))) return false;
          throw error;
        });
      if (created) {
        await this.db.query(`CREATE audit CONTENT { task: $source, actor: $source_actor, action: 'qa_review_wake_event',
          evidence: $evidence, at: time::now(), fence: $fence };`, {
          source: new RecordId('task', input.sourceTaskId), source_actor: new RecordId('employee', input.actor),
          evidence: `[qa_review_wake_event] watch=${watchId} kind=${input.kind} fence=${input.fence} actor=${input.actor} subjects=${[...input.subjects].sort().join(',')}`,
          fence: input.fence,
        }).catch(() => undefined);
      }
    }
    const row = await this.db.select<WakeRow>(id);
    if (!row) return undefined;
    return this.deliver(row, input.watch);
  }

  private async mark(
    row: WakeRow, code: string,
    extra: { delivered?: boolean; waitKey?: string; invalidatedReason?: string } = {},
  ): Promise<ReviewWakeView> {
    const base: ReviewWakeView = { watchId: asId(row.watch), eventId: row.event_key, kind: row.kind,
      fence: row.fence, released: extra.delivered === true, code };
    const sets = ['delivered = $delivered', 'code = $code'];
    const vars: Record<string, unknown> = { id: row.id, delivered: extra.delivered === true, code };
    if (extra.delivered) sets.push('delivered_at = time::now()');
    if (extra.waitKey) { sets.push('wait_key = $wait_key'); vars.wait_key = extra.waitKey; }
    if (extra.invalidatedReason) {
      sets.push('invalidated_reason = $invalidated_reason');
      vars.invalidated_reason = extra.invalidatedReason.slice(0, 300);
    }
    await this.db.query(
      `UPDATE $id SET ${sets.join(', ')} WHERE delivered = false AND invalidated_reason = NONE;`, vars,
    ).catch(() => undefined);
    return base;
  }

  /**
   * Deliver one stored event: re-check the live review lease, then release the collaboration task's own feedback
   * wait — the one whose reference names this watch. Anything else leaves the event pending (to be drained when the
   * task really enters that wait) or invalidated (when the review moved on).
   */
  private async deliver(row: WakeRow, watchHint?: WatchRow): Promise<ReviewWakeView> {
    if (row.delivered) return { watchId: asId(row.watch), eventId: row.event_key, kind: row.kind, fence: row.fence,
      released: true, code: row.code ?? 'delivered' };
    if (row.invalidated_reason) return { watchId: asId(row.watch), eventId: row.event_key, kind: row.kind,
      fence: row.fence, released: false, code: 'invalidated' };
    const watch = watchHint ?? await this.db.select<WatchRow>(row.watch);
    if (!watch || watch.state !== 'active') return this.mark(row, 'watch_closed', { invalidatedReason: 'the watch is closed' });
    const stale = reviewEventStaleReason(await this.sourceState(asId(row.source_task)),
      { fence: row.fence, actor: row.actor });
    if (stale) return this.mark(row, 'stale', { invalidatedReason: stale });
    const wait = await this.waits.openOfTask(asId(row.collaboration_task));
    if (!wait) return this.mark(row, 'no_wait');
    if (wait.kind !== 'feedback') return this.mark(row, 'wait_not_feedback');
    if (wait.reference !== reviewWatchRef(asId(watch.id))) return this.mark(row, 'wait_reference_mismatch');
    const now = this.clock();
    const outcome = await this.waits.resolve({
      wait, expectedVersion: wait.version, actor: 'system:review-events', ownerApproved: false, now,
      event: {
        source: 'authorized_person', at: now, verified: true, provider: 'qa-review-events',
        eventId: row.event_key, objectWaitId: wait.waitKey, objectTaskId: asId(row.collaboration_task),
      },
    });
    if (outcome.released) return this.mark(row, 'released', { delivered: true, waitKey: wait.waitKey });
    if (outcome.code === 'duplicate_event' || outcome.code === 'version_moved') {
      // Either another delivery already released this wait (the wake happened once, not twice), or the wait itself
      // moved (cancelled, extended, superseded). Only a released wait counts as delivered; anything else stays
      // pending so a later legitimate wait can still be woken by this event.
      const current = await this.waits.wait(wait.waitKey);
      if (current?.state === 'released') {
        return this.mark(row, 'already_released', { delivered: true, waitKey: wait.waitKey });
      }
      return this.mark(row, 'wait_moved');
    }
    return this.mark(row, outcome.code);
  }

  /** Drain the pending events of one collaboration task; called when it enters its feedback wait. */
  async deliverPendingFor(collaborationTaskId: string): Promise<ReviewWakeView[]> {
    const [rows] = await this.db.query<[WakeRow[]]>(
      `SELECT * FROM qa_review_wake WHERE collaboration_task = $task AND delivered = false
       AND invalidated_reason = NONE ORDER BY created_at LIMIT 20;`,
      { task: new RecordId('task', collaborationTaskId) });
    const delivered: ReviewWakeView[] = [];
    for (const row of rows ?? []) delivered.push(await this.deliver(row));
    return delivered;
  }

  /** A QA review claim of a watched source task: invalidate older-fence events, then emit this fence's authorization. */
  async onReviewClaimed(sourceTaskId: string, actor: string, fence: number): Promise<ReviewWakeView[]> {
    await this.invalidatePending(sourceTaskId, fence, 'the review fence moved; the stored event belongs to an older claim');
    const [watches] = await this.db.query<[WatchRow[]]>(
      "SELECT * FROM qa_review_watch WHERE source_task = $source AND state = 'active';",
      { source: new RecordId('task', sourceTaskId) });
    const woken: ReviewWakeView[] = [];
    for (const watch of watches ?? []) {
      if (!(watch.event_kinds ?? []).includes('authorization')) continue;
      const view = await this.emit({ watch, sourceTaskId, fence, kind: 'authorization', actor, subjects: [],
        reason: 'an independent QA claimed the review lease of this source task' });
      if (view) woken.push(view);
    }
    return woken;
  }

  /** The review hold ended (return / release): events never delivered can no longer be trusted. */
  async invalidateSource(sourceTaskId: string, reason: string): Promise<number> {
    return this.invalidatePending(sourceTaskId, undefined, reason);
  }

  private async invalidatePending(sourceTaskId: string, keepFence: number | undefined, reason: string): Promise<number> {
    const [rows] = await this.db.query<[WakeRow[]]>(
      `SELECT * FROM qa_review_wake WHERE source_task = $source AND delivered = false
       AND invalidated_reason = NONE AND fence != $keep;`,
      { source: new RecordId('task', sourceTaskId), keep: keepFence ?? -1 });
    for (const row of rows ?? []) {
      await this.db.query('UPDATE $id SET invalidated_reason = $reason WHERE delivered = false AND invalidated_reason = NONE;',
        { id: row.id, reason: reason.slice(0, 300) }).catch(() => undefined);
    }
    return rows?.length ?? 0;
  }

  // ------------------------------------------------------------------ structured QA signal

  async signal(input: QaScopeSignalInput & { actor: string }): Promise<QaScopeSignalView> {
    const subjects = normalizeScopeSubjects(input.subjects);
    if (!Number.isSafeInteger(input.fence) || input.fence < 1) throw new CompanyError('invalid', 'Invalid fence');
    if (input.kind !== 'request' && input.kind !== 'retract') throw new CompanyError('invalid', 'kind must be request or retract');
    const positiveReady = input.kind === 'retract' ? input.positiveReady === true : false;
    const reason = assertNonSensitive(requireReason(input.reason), 'reason');
    const ident = idemRecord(input.actor, 'qa_review_scope_signal', input.idempotencyKey);
    const digest = hashOf('signal', input.taskId, input.fence, input.kind, subjects.join(','), String(positiveReady), reason);
    const prior = await this.replay<SignalRow>(ident, digest);
    if (prior) {
      return { signal: signalView(prior), event: { kind: signalEventKind(prior.kind), created: false, fence: prior.fence },
        woken: [], guidance: REVIEW_SIGNAL_GUIDANCE };
    }
    const id = signalRecord(input.taskId, input.fence, input.actor);
    const query = `BEGIN;
      LET $who = SELECT * FROM ONLY $actor;
      IF $who = NONE OR $who.revoked = true OR $who.role != 'qa' OR 'review' NOT IN $who.capabilities { THROW 'review events invalid: only a qa reviewer may signal a review scope' };
      LET $t = SELECT * FROM ONLY $task;
      IF $t = NONE { THROW 'review events invalid: task not found' };
      IF $t.state != 'review' OR $t.reviewer_role != 'qa' { THROW 'review events invalid: the task is not in qa review' };
      IF $t.current_employee != $me OR $t.fence != $fence { THROW 'review events invalid: review holder or fence does not match' };
      IF $t.lease_expires_at = NONE OR $t.lease_expires_at <= time::unix(time::now()) { THROW 'review events invalid: the review lease is not live' };
      IF $t.submitted_by = $me OR $t.implementer = $me { THROW 'review events invalid: the qa employee authored this task' };
      IF $t.goal = NONE { THROW 'review events invalid: the task has no goal' };
      FOR $s IN $subjects {
        LET $sub = SELECT * FROM ONLY type::record('task', $s);
        IF $sub = NONE { THROW 'review events invalid: a subject task does not exist' };
        IF $sub.goal = NONE OR $sub.goal != $t.goal { THROW 'review events invalid: a subject is not in the review goal' };
        IF $sub.submitted_by = $me OR $sub.implementer = $me { THROW 'review events invalid: the qa employee authored a subject task' };
      };
      LET $sig = SELECT * FROM ONLY $signal;
      IF $sig = NONE {
        IF $kind != 'request' { THROW 'review events invalid: a retract needs an earlier request at this fence' };
        CREATE ONLY $signal CONTENT { signal_key: $signal_key, task: $task, goal: $t.goal, actor: $me, fence: $fence,
          kind: 'request', state: 'requested', subjects: $subjects, positive_ready: false, reason: $reason,
          version: 1, created_at: time::now(), updated_at: time::now() };
      } ELSE {
        IF $sig.state = 'retracted' { THROW 'review events moved: the signal at this fence was already retracted' };
        IF $kind != 'retract' { THROW 'review events moved: the signal at this fence is already requested' };
        UPDATE ONLY $signal SET kind = 'retract', state = 'retracted', positive_ready = $positive_ready,
          reason = $reason, retracted_at = time::now(), updated_at = time::now(), version = $sig.version + 1;
      };
      CREATE ONLY $audit CONTENT { task: $task, actor: $actor, action: 'qa_review_scope_signal',
        evidence: $evidence, at: time::now(), fence: $fence };
      CREATE ONLY $idem CONTENT { at: time::now(), payload_digest: $digest, result: (SELECT * FROM ONLY $signal) };
      RETURN SELECT * FROM ONLY $signal;
      COMMIT;`;
    const evidence = `${reason}\n[qa_review_scope_signal] task=${input.taskId} fence=${input.fence} kind=${input.kind} `
      + `positiveReady=${positiveReady} subjects=${subjects.join(',')}`;
    const row = await this.tx<SignalRow>(query, {
      actor: new RecordId('employee', input.actor), me: input.actor, task: new RecordId('task', input.taskId),
      fence: input.fence, subjects, positive_ready: positiveReady, reason, kind: input.kind,
      signal_key: qaScopeSignalKeyOf(input.taskId, input.fence, input.actor),
      signal: id, evidence, digest, idem: ident, audit: new RecordId('audit', randomUUID()),
    });
    if (!row) throw new CompanyError('temporarily_unavailable', 'Review signal was not stored; retry', true);
    const eventKind = signalEventKind(row.kind);
    const [watches] = await this.db.query<[WatchRow[]]>(
      "SELECT * FROM qa_review_watch WHERE source_task = $source AND state = 'active';",
      { source: new RecordId('task', input.taskId) });
    const woken: ReviewWakeView[] = [];
    for (const watch of watches ?? []) {
      if (!(watch.event_kinds ?? []).includes(eventKind)) continue;
      const view = await this.emit({ watch, sourceTaskId: input.taskId, fence: row.fence, kind: eventKind,
        actor: row.actor, subjects: [...row.subjects], reason: row.reason });
      if (view) woken.push(view);
    }
    return { signal: signalView(row), event: { kind: eventKind, created: true, fence: row.fence }, woken,
      guidance: REVIEW_SIGNAL_GUIDANCE };
  }

  // ------------------------------------------------------------------ reads / close

  async close(input: ReviewWatchCloseInput & { actor: string }): Promise<ReviewWatchView> {
    const ident = idemRecord(input.actor, 'qa_review_watch_close', input.idempotencyKey);
    const digest = hashOf('close', input.watchId, input.expectedVersion, input.reason);
    const prior = await this.replay<WatchRow>(ident, digest);
    if (prior) return this.watchView(prior);
    const reason = assertNonSensitive(requireReason(input.reason), 'reason');
    const query = `BEGIN;
      LET $who = SELECT * FROM ONLY $actor;
      IF $who = NONE OR $who.revoked = true OR $who.role != 'gm' OR 'manage' NOT IN $who.capabilities { THROW 'review events invalid: only gm may close a review watch' };
      LET $w = SELECT * FROM ONLY $watch;
      IF $w = NONE { THROW 'review events invalid: watch not found' };
      IF $w.version != $expected { THROW 'review events moved: watch version changed' };
      IF $w.state != 'active' { THROW 'review events moved: the watch is not active' };
      LET $src = SELECT * FROM ONLY $w.source_task;
      LET $next = UPDATE ONLY $watch SET state = 'closed', version = $w.version + 1, closed_at = time::now(),
        closed_by = $actor, closed_reason = $reason, updated_at = time::now() RETURN AFTER;
      CREATE ONLY $audit CONTENT { task: $w.source_task, actor: $actor, action: 'qa_review_watch_close',
        evidence: $evidence, at: time::now(), fence: IF $src = NONE THEN NONE ELSE $src.fence END };
      CREATE ONLY $idem CONTENT { at: time::now(), payload_digest: $digest, result: $next };
      RETURN $next;
      COMMIT;`;
    const row = await this.tx<WatchRow>(query, {
      actor: new RecordId('employee', input.actor), watch: watchRecord(input.watchId),
      expected: input.expectedVersion, reason, digest, idem: ident,
      evidence: `${reason}\n[qa_review_watch_close] watch=${input.watchId} expectedVersion=${input.expectedVersion}`,
      audit: new RecordId('audit', randomUUID()),
    });
    if (!row) throw new CompanyError('temporarily_unavailable', 'Review watch was not closed; retry', true);
    await this.invalidatePending(asId(row.source_task), undefined, 'the watch was closed');
    return this.watchView(await this.watchRow(input.watchId) ?? row);
  }

  async status(filter: { watchId?: string; sourceTaskId?: string; collaborationTaskId?: string } = {}): Promise<ReviewWatchView[]> {
    const conditions: string[] = [];
    const vars: Record<string, unknown> = { limit: 20 };
    if (filter.watchId) { conditions.push('id = $watch'); vars.watch = watchRecord(filter.watchId); }
    if (filter.sourceTaskId) { conditions.push('source_task = $source'); vars.source = new RecordId('task', filter.sourceTaskId); }
    if (filter.collaborationTaskId) { conditions.push('collaboration_task = $collab'); vars.collab = new RecordId('task', filter.collaborationTaskId); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const [rows] = await this.db.query<[WatchRow[]]>(
      `SELECT * FROM qa_review_watch ${where} ORDER BY created_at DESC LIMIT $limit;`, vars);
    const views: ReviewWatchView[] = [];
    for (const row of rows ?? []) views.push(await this.watchView(row));
    return views;
  }

  /** The structured signals of one task (or the newest), read-only. */
  async signals(input: { taskId?: string; limit?: number } = {}): Promise<ReviewSignalView[]> {
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 50);
    const [rows] = input.taskId
      ? await this.db.query<[SignalRow[]]>(
        'SELECT * FROM qa_review_signal WHERE task = $task ORDER BY updated_at DESC LIMIT $limit;',
        { task: new RecordId('task', input.taskId), limit })
      : await this.db.query<[SignalRow[]]>(
        'SELECT * FROM qa_review_signal ORDER BY updated_at DESC LIMIT $limit;', { limit });
    return (rows ?? []).map(signalView);
  }
}
