import { randomUUID } from 'node:crypto';
import { RecordId } from 'surrealdb';
import type { CompanyDatabase } from './database.ts';
import { ROLES, type CompanyBrief, type OwnerDecision, type Role, type TaskId, type TaskView } from './contracts.ts';
import { ProjectStore } from './projects.ts';
import type { BriefData, RoleCapacity, WaitingItem } from './owner-brief.ts';
import { asId, CompanyError, HASH, id, REQUIRED_TRACKS, requireText, view, type IdempotencyRow, type TaskRow } from './core.ts';
import { assertRoleContract, loadContract } from './role-contract.ts';
import type { DispatchVerdict } from './dispatcher/dispatch-blocked.ts';
import { dispatchBlockedList } from './dispatcher/dispatch-list.ts';
import { acceptanceError, acceptanceSubject, evaluateAcceptance, humanSignoffs, loadAcceptanceEvidence, loadAcceptanceGate, type AcceptanceTaskRow, type HumanSignoff } from './acceptance.ts';

export type OwnerCommandKind = 'approve' | 'reject' | 'reply' | 'direction' | 'instruct' | 'pause' | 'resume';
export interface OwnerCommandRow {
  id: RecordId;
  kind: OwnerCommandKind;
  text?: string;
  task?: string;
  source: string;
  status: 'pending' | 'applying' | 'applied' | 'failed';
  created_at: Date;
}

export interface OwnerNotice { key: string; text: string; at: string }

export interface OwnerInbox {
  gates: Array<{ task: TaskView; submission?: string }>;
  questions: Array<{ task: TaskView; question?: string }>;
  notices: OwnerNotice[];
  pendingCommands: number;
}

// WSS to the production DB sustains only ~50KB/s: keep every routine response small
// or interactive RPCs queue behind multi-second transfers and hit the 30s daemon timeout.
const LIST_CTX_CHARS = 1200;
const GATE_EVIDENCE_CHARS = 8000;


const EMIT_CREATED = (task: string) => `
  CREATE audit CONTENT { task: ${task}, actor: $source, action: 'create', version: 1, at: time::now() };
  LET $seq = UPDATE ONLY company_meta:outbox_counter SET value += 1 RETURN AFTER;
  CREATE outbox CONTENT { task: ${task}, kind: 'created', sequence: $seq.value, payload: { state: ${task}.state }, at: time::now() };`;

/** Owner-side operations. Used by the owner CLI, the dispatcher (owner_command table) and owner relay. */
/** The brief names this many blocked items; the rest are counted in `total` and said so, never dropped silently. */
const BRIEF_DISPATCH_ROWS = 12;

const briefDispatch = (verdicts: DispatchVerdict[]): BriefData['dispatchBlocked'] => {
  const list = dispatchBlockedList(verdicts, BRIEF_DISPATCH_ROWS);
  return { total: list.bound.total, rows: list.items };
};

export class OwnerDesk {
  constructor(private readonly database: CompanyDatabase, private readonly opsRepo?: string) {
  }
  private get db() { return this.database.db; }


  /** approve/reject an owner-reviewed gate, or reply to a task blocked to the owner. */
  async decide(input: { taskId: TaskId; decision: OwnerDecision; note: string; source: string; key: string; expectedVersion?:number }): Promise<TaskView> {
    if (!['approve', 'reject', 'reply'].includes(input.decision)) throw new CompanyError('invalid', 'Invalid decision');
    requireText(input.note ?? '', 'note', input.decision === 'approve' ? 0 : 2, 20000);
    const idem = id('idempotency', HASH(`owner\0decide\0${input.key}`));
    const digest = HASH(JSON.stringify({ taskId: input.taskId, decision: input.decision, note: input.note, expectedVersion:input.expectedVersion }));
    const prior = await this.db.select<IdempotencyRow>(idem);
    if (prior) {
      if (prior.payload_digest !== digest) throw new CompanyError('conflict', 'Idempotency key reused with different input');
      return view(prior.result);
    }
    const evidence = `来源：${input.source}\n决定：${input.decision}\n${input.note ?? ''}`.trim();
    // SYS02 AC03/AC06: an owner approval calls the same evaluator. Machine evidence must be server-verified; the owner
    // signs required human criteria here, in the same transaction that closes the gate. The owner gate is never auto-approved.
    let humanEvidence: HumanSignoff[] = [];
    if (input.decision === 'approve') {
      const taskRow = await this.db.select<AcceptanceTaskRow>(id('task', input.taskId));
      if (!taskRow) throw new CompanyError('not_found', 'task not found');
      const gate = await loadAcceptanceGate(this.db);
      const verdict = evaluateAcceptance({
        subject: acceptanceSubject(taskRow), evidence: await loadAcceptanceEvidence(this.db, input.taskId),
        phase: 'owner', actor: { employeeId: 'owner', role: 'owner', human: true, owner: true }, gate,
      });
      if (!verdict.ok) throw acceptanceError(verdict);
      humanEvidence = humanSignoffs(verdict, input.taskId, 'owner', taskRow.acceptance_attempt ?? 0);
    }
    const rows = await this.run(`BEGIN;
      LET $t = SELECT * FROM ONLY $task;
      IF $t = NONE { THROW 'task not found' };
      IF $expected_version != NONE AND $t.version != $expected_version { THROW 'task version moved' };
      IF $decision IN ['approve', 'reject'] AND ($t.state != 'review' OR $t.reviewer_role != 'owner') { THROW 'task is not awaiting owner review' };
      IF $decision = 'reply' AND ($t.state != 'blocked' OR $t.blocked_to != 'owner') { THROW 'task is not waiting for an owner answer' };
      LET $next = UPDATE ONLY $task SET
        state = IF $decision = 'approve' THEN 'done'
          ELSE IF $decision = 'reject' THEN 'ready'
          ELSE ($t.resume_state ?? 'ready') END,
        accepted_by = IF $decision = 'approve' THEN 'owner' ELSE $t.accepted_by END,
        blocked_to = NONE, resume_role = NONE, resume_state = NONE, current_employee = NONE,
        delivery_id = NONE, lease_expires_at = NONE, version = $t.version + 1
        RETURN AFTER;
      CREATE audit CONTENT { task: $task, actor: $actor, action: 'owner_' + $decision, evidence: $evidence, version: $next.version, at: time::now() };
      LET $sequence = UPDATE ONLY company_meta:outbox_counter SET value += 1 RETURN AFTER;
      CREATE outbox CONTENT { task: $task, kind: 'owner_decision', sequence: $sequence.value, payload: { decision: $decision, state: $next.state }, at: time::now() };
      IF $decision = 'approve' {
        FOR $e IN $human_evidence {
          CREATE acceptance_evidence CONTENT {
            task: $task, ac_id: $e.acId, kind: 'human', sha: $e.sha, environment: $t.acceptance_environment,
            attempt: $e.attempt,
            evidence_type: 'review-signoff', source: { provider: 'owner' }, verified: true, verifier: 'owner',
            actor: 'owner', at: time::now(), criteria_version: $e.criteriaVersion, task_version: $next.version, digest: $e.digest
          };
        };
      };
      CREATE ONLY $idem CONTENT { at: time::now(), payload_digest: $digest, result: $next };
      RETURN $next;
      COMMIT;`, {
      task: id('task', input.taskId), expected_version:input.expectedVersion, decision: input.decision, evidence, actor: input.source, idem, digest, human_evidence: humanEvidence,
    });
    const decided = rows.at(-2) as TaskRow;
    return view(decided);
  }

  /**
   * Owner-level repair for mis-routed work: moves a task that has not started (blocked or ready, no live
   * lease, never submitted) to another executor and/or reviewer role. The project's role contract and the
   * required-track roles are checked exactly as at creation, and the move is audited.
   */
  async reassign(input: { taskId: TaskId; executorRole?: Role; reviewerRole?: Role | 'owner'; note: string; source: string; key: string }): Promise<TaskView> {
    requireText(input.note, 'note', 4, 4000);
    if (!input.executorRole && !input.reviewerRole) throw new CompanyError('invalid', 'executorRole or reviewerRole is required');
    for (const role of [input.executorRole, input.reviewerRole]) {
      if (role && role !== 'owner' && !ROLES.includes(role)) throw new CompanyError('invalid', `Invalid role ${role}`);
    }
    if (input.executorRole === ('owner' as string)) throw new CompanyError('invalid', 'owner cannot execute tasks');
    const idem = id('idempotency', HASH(`owner\0reassign\0${input.key}`));
    const digest = HASH(JSON.stringify({ taskId: input.taskId, executorRole: input.executorRole, reviewerRole: input.reviewerRole, note: input.note }));
    const prior = await this.db.select<IdempotencyRow>(idem);
    if (prior) {
      if (prior.payload_digest !== digest) throw new CompanyError('conflict', 'Idempotency key reused with different input');
      return view(prior.result);
    }
    const before = await this.db.select<TaskRow & { project?: RecordId }>(id('task', input.taskId));
    if (!before) throw new CompanyError('not_found', 'task not found');
    const executor = input.executorRole ?? before.executor_role, reviewer = input.reviewerRole ?? before.reviewer_role;
    assertRoleContract(await loadContract(this.db, before.project ? asId(before.project) : undefined), executor, before.discipline ?? undefined);
    const required = REQUIRED_TRACKS[executor];
    if (required !== undefined && before.discipline !== required) throw new CompanyError('invalid', `executorRole ${executor} requires discipline=${required}`);
    const evidence = `来源：${input.source}\n改派：执行 ${before.executor_role}→${executor}；验收 ${before.reviewer_role}→${reviewer}\n${input.note}`;
    const rows = await this.run(`BEGIN;
      LET $t = SELECT * FROM ONLY $task;
      IF $t = NONE { THROW 'task not found' };
      IF $t.version != $expected { THROW 'task version moved' };
      IF $t.state NOT IN ['blocked', 'ready'] OR $t.submitted_by != NONE { THROW 'task is not awaiting start' };
      IF $t.current_employee != NONE AND $t.lease_expires_at > time::unix(time::now()) { THROW 'task is not awaiting start: active lease' };
      LET $next = UPDATE ONLY $task SET executor_role = $executor, reviewer_role = $reviewer, version = $t.version + 1 RETURN AFTER;
      CREATE audit CONTENT { task: $task, actor: $actor, action: 'reassign', evidence: $evidence, version: $next.version, at: time::now() };
      LET $sequence = UPDATE ONLY company_meta:outbox_counter SET value += 1 RETURN AFTER;
      CREATE outbox CONTENT { task: $task, kind: 'reassigned', sequence: $sequence.value, payload: { executor: $executor, reviewer: $reviewer }, at: time::now() };
      CREATE ONLY $idem CONTENT { at: time::now(), payload_digest: $digest, result: $next };
      RETURN $next;
      COMMIT;`, { task: id('task', input.taskId), expected: before.version, executor, reviewer, evidence, actor: input.source, idem, digest });
    return view(rows.at(-2) as TaskRow);
  }

  /**
   * Owner-level retire (作废): the task becomes void, its holder is released and dependents that were only
   * waiting on it unlock. Closing a goal's final gate this way never closes the goal. Same guards as the
   * Owner retire: finished tasks and owner gates with live dependents are refused.
   */
  async retire(input: { taskId: TaskId; note: string; source: string; key: string }): Promise<TaskView> {
    requireText(input.note, 'note', 4, 4000);
    const idem = id('idempotency', HASH(`owner\0retire\0${input.key}`));
    const digest = HASH(JSON.stringify({ taskId: input.taskId, note: input.note }));
    const prior = await this.db.select<IdempotencyRow>(idem);
    if (prior) {
      if (prior.payload_digest !== digest) throw new CompanyError('conflict', 'Idempotency key reused with different input');
      return view(prior.result);
    }
    const before = await this.db.select<TaskRow>(id('task', input.taskId));
    if (!before) throw new CompanyError('not_found', 'task not found');
    if (before.state === 'void') return view(before);
    const evidence = `来源：${input.source}\n${input.note}\n[retire] 作废前 state=${before.state} blocked_to=${before.blocked_to ?? '-'} holder=${before.current_employee ?? '-'} version=${before.version}`;
    const rows = await this.run(`BEGIN;
      LET $t = SELECT * FROM ONLY $task;
      IF $t = NONE { THROW 'task not found' };
      IF $t.state IN ['done', 'void'] { THROW 'task is not awaiting: already terminal' };
      LET $next = UPDATE ONLY $task SET state = 'void', blocked_to = NONE, resume_role = NONE, resume_state = NONE,
        current_employee = NONE, delivery_id = NONE, lease_expires_at = NONE, version = $t.version + 1 RETURN AFTER;
      FOR $cid IN $descendants {
        UPDATE type::record('task', $cid) SET state = 'void', version += 1;
        CREATE audit CONTENT { task: type::record('task', $cid), actor: $actor, action: 'planned_voided',
          evidence: '父任务作废，计划任务级联作废', version: (SELECT VALUE version FROM ONLY type::record('task', $cid)), at: time::now() };
      };
      UPDATE employee SET active_task = NONE WHERE active_task = $task;
      CREATE audit CONTENT { task: $task, actor: $actor, action: 'retire', evidence: $evidence, version: $next.version, at: time::now() };
      LET $sequence = UPDATE ONLY company_meta:outbox_counter SET value += 1 RETURN AFTER;
      CREATE outbox CONTENT { task: $task, kind: 'retired', sequence: $sequence.value, payload: { state: 'void', retired_holder: $holder }, at: time::now() };
      CREATE ONLY $idem CONTENT { at: time::now(), payload_digest: $digest, result: $next };
      RETURN $next;
      COMMIT;`, { task: id('task', input.taskId), actor: input.source, evidence, holder: before.current_employee, idem, digest, descendants: await this.plannedDescendants(input.taskId) });
    return view(rows.at(-2) as TaskRow);
  }

  private async plannedDescendants(taskId: string): Promise<string[]> {
    const out: string[] = [];
    let frontier = [taskId];
    while (frontier.length) {
      const [rows] = await this.db.query<[Array<{ id: RecordId }>]>(
        'SELECT id FROM task WHERE parent INSIDE $frontier AND state = $state;', { frontier: frontier.map(t => id('task', t)), state: 'planned' });
      const next = (rows ?? []).map(row => String(row.id.id));
      out.push(...next);
      frontier = next;
    }
    return out;
  }

  async addDirection(input: { text: string; source: string; key: string }): Promise<void> {
    requireText(input.text, 'direction', 2, 20000);
    const record = id('direction', HASH(`direction\0${input.key}`).slice(0, 16));
    if (await this.db.select(record)) return;
    await this.db.query('CREATE $record CONTENT { text: $text, source: $source, at: time::now() };',
      { record, text: input.text.trim(), source: input.source });
  }

  async setPaused(paused: boolean): Promise<void> {
    await this.db.query('UPSERT company_meta:config SET paused=$paused, pause_version=(pause_version??0)+1;', { paused });
  }

  async brief(): Promise<CompanyBrief> {
    const [directions, config] = await this.db.query<[
      Array<{ text: string; source: string; at: unknown }>, Array<{ paused?: boolean }>,
    ]>(`SELECT text, source, at FROM direction ORDER BY at DESC LIMIT 10;
      SELECT paused FROM company_meta:config;`);
    return {
      directions: directions.map(d => ({ text: d.text, source: d.source, at: String(d.at) })),
      projects: await new ProjectStore(this.db).list(), paused: Boolean(config[0]?.paused),
    };
  }

  async raiseNotice(key: string, text: string): Promise<boolean> {
    const record = id('owner_notice', HASH(key).slice(0, 24));
    const existing = await this.db.select<{ resolved_at?: unknown; text: string }>(record);
    if (existing && !existing.resolved_at && existing.text === text) return false;
    await this.db.query('UPSERT $record CONTENT { key: $key, text: $text, at: time::now(), resolved_at: NONE };', { record, key, text });
    return !existing || Boolean(existing.resolved_at);
  }

  /**
   * Ends an open notice. With `audit`, the end is written to the task's audit stream in the same transaction, and only when
   * this call actually closed the notice, so repeated ends (ticks, restarts) write nothing further (SYS-DISP AC03).
   */
  async resolveNotice(key: string, audit?: { task: string; evidence: string }): Promise<void> {
    const record = id('owner_notice', HASH(key).slice(0, 24));
    if (!audit) {
      await this.db.query('UPDATE $record SET resolved_at = time::now() WHERE resolved_at = NONE;', { record });
      return;
    }
    await this.db.query(`BEGIN TRANSACTION;
      LET $closed = (UPDATE $record SET resolved_at = time::now() WHERE resolved_at = NONE RETURN AFTER);
      IF array::len($closed) > 0 { CREATE audit CONTENT { task: $task, actor: 'system:dispatcher', action: 'dispatch_unblocked', evidence: $evidence, at: time::now() } };
      COMMIT TRANSACTION;`, { record, task: id('task', audit.task), evidence: audit.evidence });
  }

  async openNotices(): Promise<OwnerNotice[]> {
    const [rows] = await this.db.query<[Array<{ key: string; text: string; at: unknown }>]>(
      'SELECT key, text, at FROM owner_notice WHERE resolved_at = NONE ORDER BY at;');
    return rows.map(r => ({ key: r.key, text: r.text, at: String(r.at) }));
  }

  async inbox(): Promise<OwnerInbox> {
    const [gates, questions, pending] = await this.db.query<[TaskRow[], TaskRow[], Array<{ count: number }>]>(
      `SELECT *, string::slice(context ?? '', 0, $ctx) AS context FROM task WHERE state = 'review' AND reviewer_role = 'owner' ORDER BY id;
      SELECT *, string::slice(context ?? '', 0, $ctx) AS context FROM task WHERE state = 'blocked' AND blocked_to = 'owner' ORDER BY id;
      SELECT count() FROM owner_command WHERE status IN ['pending', 'applying'] GROUP ALL;`,
      { ctx: LIST_CTX_CHARS });
    // One audit pass for every card instead of a round trip per task: the WSS channel
    // is ~50KB/s so per-task lookups turn a handful of gates into seconds of backlog.
    const ids = [...gates, ...questions].map(r => r.id);
    const [auditRows] = ids.length ? await this.db.query<[Array<{ task: RecordId; action: string; evidence?: string; at: unknown }>]>(
      `SELECT task, action, string::slice(evidence ?? '', 0, $ev) AS evidence, at FROM audit
       WHERE task IN $ids AND action IN ['submit', 'block', 'escalate'] ORDER BY at DESC;`,
      { ids, ev: GATE_EVIDENCE_CHARS }) : [[]];
    const latestBy = new Map<string, string | undefined>();
    for (const a of auditRows ?? []) {
      const key = `${asId(a.task)}|${a.action === 'submit' ? 'submit' : 'question'}`;
      if (!latestBy.has(key)) latestBy.set(key, a.evidence);
    }
    return {
      gates: gates.map(row => ({ task: view(row), submission: latestBy.get(`${asId(row.id)}|submit`) })),
      questions: questions.map(row => ({ task: view(row), question: latestBy.get(`${asId(row.id)}|question`) })),
      notices: await this.openNotices(),
      pendingCommands: pending[0]?.count ?? 0,
    };
  }

  async hasNotice(key: string): Promise<boolean> {
    return Boolean(await this.db.select(id('owner_notice', HASH(key).slice(0, 24))));
  }

  /** Non-terminal tasks that transitively depend on `root`; bounded so a pathological graph cannot stall the tick. */
  /** Non-terminal dependency edges, loaded once so BFS never pays a per-node round trip. */
  async blockLoops(taskId: TaskId): Promise<{ loops: number; reasons: string[] }> {
    const task = id('task', taskId);
    const [touched] = await this.db.query<[Array<{ at: unknown }>]>(
      "SELECT at FROM audit WHERE task = $task AND action IN ['owner_reply', 'escalate', 'manager_recovery', 'recovery_progress'] ORDER BY at DESC LIMIT 1;", { task });
    const [blocks] = await this.db.query<[Array<{ evidence?: string }>]>(
      "SELECT evidence, at FROM audit WHERE task = $task AND action = 'block' AND at > <datetime>$since ORDER BY at DESC;",
      { task, since: touched[0] ? String(touched[0].at) : '1970-01-01T00:00:00Z' });
    return { loops: blocks.length, reasons: blocks.slice(0, 3).map(b => (b.evidence ?? '').replace(/\s+/g, ' ').slice(0, 300)) };
  }

  /** Batch variant of blockLoops: two queries for the whole owner-blocked set instead of two per task. */
  async blockLoopStats(taskIds: TaskId[]): Promise<Map<string, { loops: number; reasons: string[] }>> {
    const ids = taskIds.map(t => id('task', t));
    const stats = new Map<string, { loops: number; reasons: string[] }>();
    if (!ids.length) return stats;
    const [touched, blocks] = await this.db.query<[Array<{ task: RecordId; at: unknown }>, Array<{ task: RecordId; evidence?: string; at: unknown }>]>(
      `SELECT task, at FROM audit WHERE task IN $ids AND action IN ['owner_reply', 'escalate', 'manager_recovery', 'recovery_progress'] ORDER BY at DESC;
       SELECT task, evidence, at FROM audit WHERE task IN $ids AND action = 'block' ORDER BY at DESC;`,
      { ids });
    const touchedAt = new Map<string, string>();
    for (const t of touched ?? []) { const k = asId(t.task); if (!touchedAt.has(k)) touchedAt.set(k, String(t.at)); }
    for (const b of blocks ?? []) {
      const k = asId(b.task);
      const since = touchedAt.get(k);
      if (since && String(b.at) <= since) continue;
      const s = stats.get(k) ?? { loops: 0, reasons: [] as string[] };
      s.loops += 1;
      if (s.reasons.length < 3) s.reasons.push((b.evidence ?? '').replace(/\s+/g, ' ').slice(0, 300));
      stats.set(k, s);
    }
    return stats;
  }

  /** Stops a task that keeps bouncing between employee and reviewer: it becomes an owner question with the recent reasons. */
  async escalateLooping(task: { id: TaskId; version: number }, loops: number, reasons: string[]): Promise<boolean> {
    const [lastBlock] = await this.db.query<[Array<{ recovery_reason?: string }>]>(
      "SELECT recovery_reason, at FROM audit WHERE task = $task AND action = 'block' ORDER BY at DESC LIMIT 1;", { task: id('task', task.id) });
    const evidence = `这个任务已在员工与老板之间往返 ${loops} 次（阻塞→老板处理→再阻塞）仍没有完成，系统不再自动循环。最近的阻塞原因：\n${reasons.map((r, i) => `${i + 1}. ${r}`).join('\n')}\n请给方向后回复（任务按你的回复继续），或让老板把它拆小/作废。`;
    try {
      await this.run(`BEGIN;
        LET $t = SELECT * FROM ONLY $task;
        IF $t = NONE OR $t.state != 'blocked' OR $t.blocked_to != 'owner' OR $t.version != $expected { THROW 'task is not blocked on owner' };
        LET $next = UPDATE ONLY $task SET blocked_to = 'owner', version = $t.version + 1 RETURN AFTER;
        CREATE audit CONTENT { task: $task, actor: 'system:loop-breaker', action: 'escalate', evidence: $evidence, version: $next.version, at: time::now() };
        LET $sequence = UPDATE ONLY company_meta:outbox_counter SET value += 1 RETURN AFTER;
        CREATE outbox CONTENT { task: $task, kind: 'escalated', sequence: $sequence.value, payload: { loops: $loops }, at: time::now() };
        COMMIT;`, { task: id('task', task.id), expected: task.version, evidence, loops });
      return true;
    } catch { return false; }
  }

  /** One bounded recovery handoff per source task. Classification changes routing, never the failure budget. */
  async waitingOnOwner(): Promise<WaitingItem[]> {
    const [rows] = await this.db.query<[Array<TaskRow & { goal_title?: string }>]>(
      `SELECT *, NONE AS context FROM task WHERE (state = 'review' AND reviewer_role = 'owner') OR (state = 'blocked' AND blocked_to = 'owner');`);
    if (!rows.length) return [];
    const [auditRows] = await this.db.query<[Array<{ task: RecordId; action: string; at: unknown }>]>(
      `SELECT task, action, at FROM audit WHERE task IN $ids AND action IN ['submit', 'block', 'escalate'] ORDER BY at DESC;`,
      { ids: rows.map(r => r.id) });
    // First row per (task, kind) in the DESC stream is the latest touch.
    const latestAt = new Map<string, unknown>();
    for (const a of auditRows ?? []) {
      const key = `${asId(a.task)}|${a.action === 'submit' ? 'gate' : 'question'}`;
      if (!latestAt.has(key)) latestAt.set(key, a.at);
    }
    return Promise.all(rows.map(async row => {
      const gate = row.state === 'review';
      const since = Date.parse(String(latestAt.get(`${asId(row.id)}|${gate ? 'gate' : 'question'}`) ?? (row as { created_at?: unknown }).created_at ?? new Date()));
      return { taskId: asId(row.id), version: row.version, kind: gate ? 'gate' as const : 'question' as const, title: row.title,
        sinceMs: since, downstream: await this.nonTerminalDescendants(asId(row.id)), tag: row.tag ?? undefined };
    }));
  }

  /** Non-terminal tasks transitively under this one in the parent chain. */
  private async nonTerminalDescendants(taskId: string): Promise<number> {
    let count = 0;
    let frontier = [taskId];
    while (frontier.length) {
      const [rows] = await this.db.query<[Array<{ id: RecordId }>]>(
        "SELECT id FROM task WHERE parent INSIDE $frontier AND state NOT IN ['done', 'void'];", { frontier: frontier.map(t => id('task', t)) });
      const next = (rows ?? []).map(row => String(row.id.id));
      count += next.length;
      frontier = next;
    }
    return count;
  }

  /** Everything the daily brief reports, read straight from the task service (no model involved). */
  /**
   * `dispatch` is the latest pass's blocked verdicts, the same list the roster and pulse show (SYS-DISP R1). The brief lists each
   * one; it does not count dispatch notices, which are a subset raised only once an item is material or has waited five minutes.
   */
  async briefData(nowMs: number, date: string, capacity: RoleCapacity[] = [], dispatch: DispatchVerdict[] = []): Promise<BriefData> {
    const sinceIso = new Date(nowMs - 86_400_000).toISOString();
    const waiting = (await this.waitingOnOwner()).map(item => ({ ...item, hours: (nowMs - item.sinceMs) / 3_600_000 }));
    const [ready, counts, health, quotas, opened, closed] = await this.db.query<[
      Array<{ id: RecordId; title: string }>,
      Array<{ action: string; mechanical?: boolean; n: number }>,
      Array<{ id: RecordId; state: string; last_error?: string }>, Array<{ id: RecordId; lowest_pct?: number }>,
      Array<{ n: number }>, Array<{ reason?: string; n: number }>,
    ]>(`SELECT id, title FROM task WHERE state = 'ready';
      SELECT action, string::starts_with(evidence ?? '', '【通道回滚】') AS mechanical, count() AS n FROM audit WHERE at > <datetime>$since AND action IN ['accept', 'owner_approve', 'return', 'owner_reject', 'retire'] GROUP BY action, mechanical;
      SELECT id, state, last_error FROM provider_health;
      SELECT id, lowest_pct FROM company_meta WHERE lowest_pct != NONE;
      SELECT count() AS n FROM employee WHERE role != NONE AND created_at > <datetime>$since GROUP ALL;
      SELECT retired_reason AS reason, count() AS n FROM employee WHERE retired = true AND retired_at > <datetime>$since GROUP BY retired_reason;`, { since: sinceIso });
    const stuck: BriefData['stuck'] = [];
    const readyIds = ready.map(r => r.id);
    const [readyAudits] = readyIds.length ? await this.db.query<[Array<{ task: RecordId; at: unknown }>]>(
      `SELECT task, at FROM audit WHERE task IN $ids
       AND action IN ['create', 'dependency_unlocked', 'return', 'release', 'revoke', 'resume'] ORDER BY at DESC;`,
      { ids: readyIds }) : [[]];
    const lastReadyAt = new Map<string, unknown>();
    for (const a of readyAudits ?? []) { const k = asId(a.task); if (!lastReadyAt.has(k)) lastReadyAt.set(k, a.at); }
    for (const task of ready) {
      const at = lastReadyAt.get(asId(task.id));
      const minutes = at ? (nowMs - Date.parse(String(at))) / 60_000 : 0;
      if (minutes >= 60) stuck.push({ taskId: asId(task.id), title: task.title, reason: `就绪 ${Math.round(minutes)} 分钟仍未被领走` });
    }
    // Blocked work whose parent already finished is orphaned: it can never be activated and waits for the owner.
    const [orphans] = await this.db.query<[Array<{ id: RecordId; title: string }>]>(
      "SELECT id, title FROM task WHERE state = 'blocked' AND parent.state = 'done';");
    for (const task of orphans ?? []) stuck.push({ taskId: asId(task.id), title: task.title, reason: '父任务已完成却仍 blocked' });
    const n = (...actions: string[]) => counts.filter(c => actions.includes(c.action) && !c.mechanical).reduce((sum, c) => sum + c.n, 0);
    const rolledBack = counts.filter(c => c.action === 'return' && c.mechanical).reduce((sum, c) => sum + c.n, 0);
    const resources = [
      ...health.filter(h => h.state !== 'healthy').map(h => `${asId(h.id)} ${h.state}${h.last_error ? `：${h.last_error.slice(0, 60)}` : ''}`),
      ...quotas.filter(q => (q.lowest_pct ?? 100) <= 2).map(q => `${asId(q.id).replace('quota_', '')} 额度剩余 ${q.lowest_pct}%`),
    ];
    return { date, waiting, stuck, last24h: { done: n('accept', 'owner_approve'), returned: n('return'), rolledBack, rejected: n('owner_reject'), retired: n('retire') },
      resources, capacity, dispatchBlocked: briefDispatch(dispatch),
      churn: { created: opened[0]?.n ?? 0, retired: closed.reduce((sum, c) => sum + c.n, 0), claimLost: closed.filter(c => c.reason === 'claim race lost').reduce((sum, c) => sum + c.n, 0) } };
  }

  /** Free-form owner instruction routed as an owner task; the owner decides how to act on it. */
  async instruct(input: { text: string; source: string; key: string }): Promise<{ taskId: string }> {
    requireText(input.text, 'instruction text', 2, 10000);
    const taskId = HASH(`instruct\0${input.key}`).slice(0, 16);
    const task = id('task', taskId);
    if (await this.db.select(task)) return { taskId };
    const title = `老板指示：${input.text.trim().split(/\r?\n/)[0].slice(0, 60)}`;
    await this.db.query(`CREATE ONLY $task CONTENT { title: $title, context: $context, kind: 'task',
      executor_role: 'owner', reviewer_role: 'product', state: 'ready',
      version: 1, fence: 0, resume_state: 'ready', created_at: time::now() };
      ${EMIT_CREATED('$task')}`, { task, title, context: `老板原话：\n${input.text.trim()}\n\n来源：${input.source}` });
    return { taskId };
  }

  /** Applies owner_command rows written by the CLI or directly into SurrealDB. Safe to run concurrently. */
  async applyPending(limit = 20): Promise<Array<{ id: string; kind: string; status: string; result?: string }>> {
    await this.db.query(`UPDATE owner_command SET status = 'pending'
      WHERE status = 'applying' AND claimed_at < time::now() - 5m;`);
    const [rows] = await this.db.query<[OwnerCommandRow[]]>(
      "SELECT * FROM owner_command WHERE status = 'pending' ORDER BY created_at LIMIT $limit;", { limit });
    const results = [];
    for (const row of rows) {
      const [claimed] = await this.db.query<[OwnerCommandRow[]]>(
        "UPDATE $id SET status = 'applying', claimed_at = time::now() WHERE status = 'pending' RETURN AFTER;", { id: row.id });
      if (!claimed?.length) continue;
      const key = `command:${asId(row.id)}`;
      const source = `owner:${row.source ?? 'db'}`;
      let status = 'applied', result = '';
      try {
        switch (row.kind) {
          case 'approve': case 'reject': case 'reply':
            if (!row.task) throw new CompanyError('invalid', 'task is required');
            result = `state=${(await this.decide({ taskId: row.task, decision: row.kind, note: row.text ?? '', source, key })).state}`;
            break;
          case 'direction': await this.addDirection({ text: row.text ?? '', source, key }); break;
          case 'instruct': result = `task=${(await this.instruct({ text: row.text ?? '', source, key })).taskId}`; break;
          case 'pause': case 'resume': await this.setPaused(row.kind === 'pause'); break;
          default: throw new CompanyError('invalid', 'unknown command kind');
        }
      } catch (error) {
        status = 'failed';
        result = error instanceof Error ? error.message : String(error);
      }
      await this.db.query('UPDATE $id SET status = $status, result = $result, applied_at = time::now();',
        { id: row.id, status, result });
      results.push({ id: asId(row.id), kind: row.kind, status, result });
    }
    return results;
  }

  private async run(query: string, vars: Record<string, unknown>): Promise<unknown[]> {
    const responses = await this.db.query<unknown[]>(query, vars).responses();
    const failure = responses.find(r => !r.success && !r.error.message.includes('not executed due to') && !r.error.message.startsWith('Cannot COMMIT'));
    if (failure && !failure.success) {
      const message = failure.error.message;
      if (/not found/i.test(message)) throw new CompanyError('not_found', message);
      if (/not awaiting|not waiting/i.test(message)) throw new CompanyError('conflict', message);
      throw new CompanyError('conflict', 'Owner operation conflicted; retry');
    }
    return responses.map(r => r.success ? r.result : undefined);
  }
}

