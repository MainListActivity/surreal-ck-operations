import { randomUUID } from 'node:crypto';
import { RecordId } from 'surrealdb';
import type { CompanyDatabase } from './database.ts';
import { ROLES, type CompanyBrief, type GoalTier, type GoalView, type OwnerDecision, type Role, type TaskId, type TaskView } from './contracts.ts';
import { GOAL_TIERS, goalTemplate, isPipeline } from './flows.ts';
import { ProjectStore } from './projects.ts';
import type { BriefData, RoleCapacity, WaitingItem } from './owner-brief.ts';
import { asId, CompanyError, depUnsatisfiedFor, HASH, id, REQUIRED_TRACKS, requireText, RESOLVE_DEP_SQL, UNLOCK_CHILDREN_SQL, UNLOCK_SQL, view, type IdempotencyRow, type TaskRow } from './core.ts';
import { assertRoleContract, loadContract } from './role-contract.ts';
import type { DispatchVerdict } from './dispatcher/dispatch-blocked.ts';
import { dispatchBlockedList } from './dispatcher/dispatch-list.ts';
import { acceptanceError, acceptanceSubject, evaluateAcceptance, humanSignoffs, loadAcceptanceEvidence, loadAcceptanceGate, type AcceptanceTaskRow, type HumanSignoff } from './acceptance.ts';
import { WaitStore } from './wait-store.ts';
import { GoalGovernanceStore } from './goal-store.ts';
import type { GoalCard } from './goal-governance.ts';
import type { WaitHandoffCard } from './waits.ts';

export type OwnerCommandKind = 'goal' | 'approve' | 'reject' | 'reply' | 'direction' | 'instruct' | 'pause' | 'resume';
export interface OwnerCommandRow {
  id: RecordId;
  kind: OwnerCommandKind;
  text?: string;
  tier?: GoalTier;
  project?: string;
  pipeline?: string;
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
  /** SYS05: owner handoff cards; an unknown expiry stays unknown, and no secret-bearing link is copied here. */
  handoffs?: WaitHandoffCard[];
  /** SYS07: the same goal cards the console reads; top page only. */
  goals?: GoalCard[];
  pendingCommands: number;
}

// WSS to the production DB sustains only ~50KB/s: keep every routine response small
// or interactive RPCs queue behind multi-second transfers and hit the 30s daemon timeout.
const LIST_CTX_CHARS = 1200;
const GATE_EVIDENCE_CHARS = 8000;

interface GoalRow {
  id: RecordId;
  title: string;
  brief: string;
  state: GoalView['state'];
  tier?: GoalTier;
  project?: RecordId;
  pipeline?: string;
  /** Joined `project.repo_path` (triagePending only); not a stored column. */
  repo_path?: string;
  tasks: { intake?: RecordId; plan?: RecordId; manual?: RecordId; acceptance?: RecordId };
}

const goalView = (row: GoalRow): GoalView => ({
  id: asId(row.id), title: row.title, brief: row.brief, state: row.state, tier: row.tier,
  project: row.project ? asId(row.project) : undefined,
  pipeline: row.pipeline ?? undefined,
  repoPath: row.repo_path ?? undefined,
  tasks: Object.fromEntries(Object.entries(row.tasks ?? {}).filter(([, v]) => v).map(([k, v]) => [k, asId(v)])),
});

const EMIT_CREATED = (task: string) => `
  CREATE audit CONTENT { task: ${task}, actor: $source, action: 'create', version: 1, at: time::now() };
  LET $seq = UPDATE ONLY company_meta:outbox_counter SET value += 1 RETURN AFTER;
  CREATE outbox CONTENT { task: ${task}, kind: 'created', sequence: $seq.value, payload: { state: ${task}.state }, at: time::now() };`;

/** Owner-side operations. Used by the owner CLI, the dispatcher (owner_command table) and gm relay. */
/** The brief names this many blocked items; the rest are counted in `total` and said so, never dropped silently. */
const BRIEF_DISPATCH_ROWS = 12;

const briefDispatch = (verdicts: DispatchVerdict[]): BriefData['dispatchBlocked'] => {
  const list = dispatchBlockedList(verdicts, BRIEF_DISPATCH_ROWS);
  return { total: list.bound.total, rows: list.items };
};

export class OwnerDesk {
  private readonly goals: GoalGovernanceStore;
  constructor(private readonly database: CompanyDatabase) {
    this.goals = new GoalGovernanceStore(database.db);
  }
  private get db() { return this.database.db; }

  async createGoal(input: { text: string; source: string; key: string; note?: string; tier?: GoalTier; project?: string; pipeline?: string }): Promise<GoalView> {
    requireText(input.text, 'goal text', 2, 20000);
    if (input.tier !== undefined && !GOAL_TIERS.includes(input.tier)) throw new CompanyError('invalid', 'Invalid goal tier');
    if (input.pipeline !== undefined && !isPipeline(input.pipeline)) throw new CompanyError('invalid', 'pipeline must be software, video or story');
    const goalId = HASH(`goal\0${input.key}`).slice(0, 16);
    const goal = id('goal', goalId);
    let row = await this.db.select<GoalRow>(goal);
    if (!row) {
      const project = input.project ? id('project', input.project) : undefined;
      if (project && !(await this.db.select(project))) throw new CompanyError('not_found', `project ${input.project} not found`);
      const title = input.text.trim().split(/\r?\n/)[0].slice(0, 60);
      // An explicit line wins; otherwise the project's default line; a goal with neither runs the software flow.
      const pipeline = input.pipeline ?? (project ? (await this.db.select<{ pipeline?: string }>(project))?.pipeline : undefined);
      try {
        await this.db.query(`CREATE ONLY $goal CONTENT { title: $title, brief: $brief, state: 'triage', source: $source, note: $note,
          project: $project, pipeline: $pipeline, tasks: {}, anchors: [], created_at: time::now() };`,
        { goal, title, brief: input.text.trim(), source: input.source, note: input.note ?? '', project, pipeline });
      } catch (error) {
        if (!(await this.db.select<GoalRow>(goal))) throw error;
      }
      row = (await this.db.select<GoalRow>(goal))!;
    }
    return input.tier && row.state === 'triage' ? this.triage(goalId, input.tier, `${input.source} 指定`) : goalView(row);
  }

  /** Instantiates the flow template of a goal waiting in triage. Idempotent: a triaged goal is returned as is. */
  async triage(goalId: string, tier: GoalTier, via: string): Promise<GoalView> {
    if (!GOAL_TIERS.includes(tier)) throw new CompanyError('invalid', 'Invalid goal tier');
    const goal = id('goal', goalId);
    const row = await this.db.select<GoalRow>(goal);
    if (!row) throw new CompanyError('not_found', 'goal not found');
    if (row.state !== 'triage') return goalView(row);
    const template = goalTemplate(tier, row.title, row.brief, goalId, isPipeline(row.pipeline) ? row.pipeline : 'software');
    const ids = Object.fromEntries(template.tasks.map(t => [t.ref, id('task', randomUUID())]));
    const vars: Record<string, unknown> = { goal, tier, via, source: `triage:${via}`.slice(0, 200) };
    const creates = template.tasks.map((t, i) => {
      vars[`t${i}`] = ids[t.ref];
      const specVars: Record<string, unknown> = { title: `[目标] ${row.title} · ${t.title}`, context: t.context, kind: t.kind,
        executor_role: t.executorRole, reviewer_role: t.reviewerRole, dependencies: t.deps.map(d => ids[d]) };
      // SYS02: the quick chain is a real code delivery; carry its versioned criteria. Absent on plan/manual/acceptance rows.
      if (t.acceptanceCriteria && t.acceptanceCriteria.length > 0) {
        specVars.acceptance_criteria = t.acceptanceCriteria;
        specVars.acceptance_version = 1;
      }
      vars[`spec${i}`] = specVars;
      return `CREATE ONLY $t${i} CONTENT { title: $spec${i}.title, context: $spec${i}.context, kind: $spec${i}.kind,
          executor_role: $spec${i}.executor_role, reviewer_role: $spec${i}.reviewer_role, dependencies: $spec${i}.dependencies,
          acceptance_criteria: $spec${i}.acceptance_criteria,
          acceptance_version: IF array::len($spec${i}.acceptance_criteria ?? []) > 0 THEN 1 ELSE NONE END,
          acceptance_legacy: false, acceptance_head: NONE, acceptance_environment: NONE, acceptance_attempt: 0,
          state: IF array::len($spec${i}.dependencies) = 0 THEN 'ready' ELSE 'blocked' END,
          version: 1, fence: 0, goal: $goal, resume_state: 'ready', created_at: time::now() };
        ${EMIT_CREATED(`$t${i}`)}`;
    });
    const refs = Object.fromEntries(Object.entries(template.refs).filter(([, ref]) => ref).map(([k, ref]) => [k, ids[ref!]]));
    vars.refs = refs;
    vars.anchors = template.anchors.map(ref => ids[ref]);
    await this.run(`BEGIN;
      LET $g = SELECT * FROM ONLY $goal;
      IF $g.state != 'triage' { THROW 'goal already triaged' };
      ${creates.join('\n')}
      UPDATE ONLY $goal SET state = 'active', tier = $tier, triage_via = $via, tasks = $refs, anchors = $anchors;
      COMMIT;`, vars).catch(async error => {
      const again = await this.db.select<GoalRow>(goal);
      if (again?.state !== 'triage') return [];
      throw error;
    });
    const after = (await this.db.select<GoalRow>(goal))!;
    // SYS07: every new goal starts with a structured outcome contract. It derives implementation/final-gate
    // evidence from the task graph; an operator can add customer activation/adoption requirements under a version
    // CAS. Existing goals are never rewritten by this default.
    await this.goals.registerOutcome({
      goalId, expectedVersion: 0,
      outcome: {
        expected: `${after.title}：${after.brief}`.slice(0, 4000),
        requiredEvidence: after.pipeline === 'video' || after.pipeline === 'story'
          ? ['implementation', 'owner_final']
          : tier === 'quick' ? ['implementation', 'final_acceptance'] : ['implementation', 'owner_final'],
        responsibleRole: 'gm',
        reason: '目标 triage 时登记的默认成果契约；可在版本 CAS 下补充客户激活/采纳证据',
      },
      actor: 'system:triage', source: `triage:${via}`, reason: '目标 triage 时登记默认成果契约',
      auditId: randomUUID(), outboxId: randomUUID(),
    }).catch(error => {
      if (!/already registered/i.test((error as Error).message)) {
        console.warn(`default goal outcome registration failed for ${goalId}: ${(error as Error).message}`);
      }
    });
    return goalView(after);
  }

  async triagePending(): Promise<GoalView[]> {
    const [rows] = await this.db.query<[GoalRow[]]>("SELECT *, project.repo_path AS repo_path FROM goal WHERE state = 'triage' ORDER BY created_at;");
    return rows.map(goalView);
  }

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
      ${RESOLVE_DEP_SQL('$t.dependencies', '$od')}
      LET $remaining = SELECT * FROM task WHERE id IN $od_resolved AND ${depUnsatisfiedFor('$t')};
      LET $next = UPDATE ONLY $task SET
        state = IF $decision = 'approve' THEN 'done'
          ELSE IF $decision = 'reject' THEN 'ready'
          ELSE IF array::len($remaining) = 0 THEN ($t.resume_state ?? 'ready') ELSE 'blocked' END,
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
        ${UNLOCK_SQL}
      };
      CREATE ONLY $idem CONTENT { at: time::now(), payload_digest: $digest, result: $next };
      RETURN $next;
      COMMIT;`, {
      task: id('task', input.taskId), expected_version:input.expectedVersion, decision: input.decision, evidence, actor: input.source, idem, digest, human_evidence: humanEvidence,
    });
    const decided = rows.at(-2) as TaskRow;
    if (input.decision === 'approve' && decided.goal) {
      await this.goals.finalize(asId(decided.goal), `owner:${input.source}`, asId(decided.id)).catch(error => {
        console.warn(`goal finalize after owner approve failed: ${(error as Error).message}`);
      });
    }
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
      if (role && role !== 'owner' && (!ROLES.includes(role) || role === 'eval')) throw new CompanyError('invalid', `Invalid role ${role}`);
    }
    if (input.executorRole === ('owner' as string)) throw new CompanyError('invalid', 'owner cannot execute tasks');
    const idem = id('idempotency', HASH(`owner\0reassign\0${input.key}`));
    const digest = HASH(JSON.stringify({ taskId: input.taskId, executorRole: input.executorRole, reviewerRole: input.reviewerRole, note: input.note }));
    const prior = await this.db.select<IdempotencyRow>(idem);
    if (prior) {
      if (prior.payload_digest !== digest) throw new CompanyError('conflict', 'Idempotency key reused with different input');
      return view(prior.result);
    }
    const before = await this.db.select<TaskRow & { goal?: RecordId; project?: RecordId }>(id('task', input.taskId));
    if (!before) throw new CompanyError('not_found', 'task not found');
    const executor = input.executorRole ?? before.executor_role, reviewer = input.reviewerRole ?? before.reviewer_role;
    assertRoleContract(await loadContract(this.db, before.goal ? asId(before.goal) : undefined, before.project ? asId(before.project) : undefined), executor, before.discipline ?? undefined);
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
   * manager's retire: finished tasks and owner gates with live dependents are refused.
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
      IF $t.reviewer_role = 'owner' {
        LET $chain = IF ($t.lineage ?? NONE) = NONE THEN [$task] ELSE (SELECT VALUE id FROM task WHERE lineage = $t.lineage) END;
        LET $live = SELECT VALUE id FROM task WHERE array::len(array::filter(dependencies ?? [], |$d| $d IN $chain)) > 0 AND state NOT IN ['done', 'void'] AND (goal = NONE OR id NOT IN (goal.anchors ?? []));
        IF array::len($live) > 0 { THROW 'task is not awaiting: owner gate has live dependents' };
      };
      LET $next = UPDATE ONLY $task SET state = 'void', blocked_to = NONE, resume_role = NONE, resume_state = NONE,
        current_employee = NONE, delivery_id = NONE, lease_expires_at = NONE, version = $t.version + 1 RETURN AFTER;
      UPDATE employee SET active_task = NONE WHERE active_task = $task;
      ${UNLOCK_CHILDREN_SQL}
      CREATE audit CONTENT { task: $task, actor: $actor, action: 'retire', evidence: $evidence, version: $next.version, at: time::now() };
      LET $sequence = UPDATE ONLY company_meta:outbox_counter SET value += 1 RETURN AFTER;
      CREATE outbox CONTENT { task: $task, kind: 'retired', sequence: $sequence.value, payload: { state: 'void', retired_holder: $holder }, at: time::now() };
      CREATE ONLY $idem CONTENT { at: time::now(), payload_digest: $digest, result: $next };
      RETURN $next;
      COMMIT;`, { task: id('task', input.taskId), actor: input.source, evidence, holder: before.current_employee, idem, digest });
    return view(rows.at(-2) as TaskRow);
  }

  /** Re-evaluates the dependents of a finished task; the repair for work that stayed blocked after its dependencies completed. */
  async unlockDependents(input: { taskId: TaskId; source: string }): Promise<TaskId[]> {
    const task = id('task', input.taskId);
    const row = await this.db.select<TaskRow>(task);
    if (!row) throw new CompanyError('not_found', 'task not found');
    if (!['done', 'void'].includes(row.state)) throw new CompanyError('conflict', 'task is not awaiting: only finished tasks have dependents to unlock');
    const waiting = async () => (await this.db.query<[Array<{ id: RecordId }>]>("SELECT id FROM task WHERE state = 'blocked' AND blocked_to = NONE AND $task IN dependencies;", { task }))[0].map(r => asId(r.id));
    const before = await waiting();
    await this.run(`BEGIN; ${UNLOCK_CHILDREN_SQL} CREATE audit CONTENT { task: $task, actor: $actor, action: 'unlock_repair', evidence: $evidence, at: time::now() }; COMMIT;`,
      { task, actor: input.source, evidence: `来源：${input.source}\n补跑依赖解锁；原先等待的任务：${before.join(', ') || '无'}` });
    const after = new Set(await waiting());
    return before.filter(taskId => !after.has(taskId));
  }

  /** Cancels a goal: every unfinished task is retired (leaves first, so owner gates can go) and the goal is closed as cancelled. */
  async cancelGoal(input: { goalId: string; note: string; source: string; key: string }): Promise<{ retired: number; remaining: number }> {
    requireText(input.note, 'note', 4, 4000);
    const goal = id('goal', input.goalId);
    const row = await this.db.select<GoalRow>(goal);
    if (!row) throw new CompanyError('not_found', 'goal not found');
    let retired = 0, remaining = 0;
    for (let round = 0; round < 12; round++) {
      const [tasks] = await this.db.query<[Array<{ id: RecordId; dependencies?: RecordId[] }>]>("SELECT id, dependencies FROM task WHERE goal = $goal AND state NOT IN ['done', 'void'];", { goal });
      remaining = tasks.length;
      if (!tasks.length) break;
      const open = new Set(tasks.map(t => String(t.id)));
      const needed = new Set(tasks.flatMap(t => (t.dependencies ?? []).map(String)).filter(d => open.has(d)));
      const leaves = tasks.filter(t => !needed.has(String(t.id)));
      let progressed = false;
      for (const leaf of leaves.length ? leaves : tasks) {
        try { await this.retire({ taskId: asId(leaf.id), note: `取消目标：${input.note}`, source: input.source, key: `${input.key}:${asId(leaf.id)}` }); retired++; progressed = true; } catch { /* retried next round */ }
      }
      if (!progressed) break;
    }
    const [left] = await this.db.query<[Array<{ id: RecordId }>]>("SELECT id FROM task WHERE goal = $goal AND state NOT IN ['done', 'void'];", { goal });
    if (!left.length && row.state !== 'cancelled') await this.db.query("UPDATE $goal SET state = 'cancelled', cancelled_at = time::now(), note = $note;", { goal, note: `${input.source} 取消：${input.note}` });
    return { retired, remaining: left.length };
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
    const [directions, goals, config] = await this.db.query<[
      Array<{ text: string; source: string; at: unknown }>, GoalRow[], Array<{ paused?: boolean }>,
    ]>(`SELECT text, source, at FROM direction ORDER BY at DESC LIMIT 10;
      SELECT * FROM goal WHERE state IN ['triage', 'active', 'needs_repair'] ORDER BY created_at;
      SELECT paused FROM company_meta:config;`);
    const snapshot = await this.goals.cardsSnapshot({ states: ['triage', 'active', 'needs_repair'] })
      .catch(() => ({ cards: [] as GoalCard[], snapshotAt: new Date().toISOString() }));
    // The console shows every goal with an active blocker or repair gap (never hidden behind a quiet first page),
    // then fills to a display cap. goalCardCoverage states shown/total instead of pretending the list is complete.
    const active = snapshot.cards.filter(card => card.needsRepair || card.blockers.length > 0 || card.outcome.missing.length > 0);
    const goalCards = snapshot.cards.slice(0, Math.max(30, active.length));
    const goalCardCoverage = snapshot.cards.length ? {
      shown: goalCards.length, total: snapshot.cards.length, omitted: snapshot.cards.length - goalCards.length,
      snapshotAt: snapshot.snapshotAt, prioritized: true as const,
    } : undefined;
    return {
      directions: directions.map(d => ({ text: d.text, source: d.source, at: String(d.at) })),
      goals: goals.map(goalView), goalCards,
      ...(goalCardCoverage ? { goalCardCoverage } : {}),
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
      handoffs: await new WaitStore(this.db).handoffCards(Date.now()).catch(() => []),
      goals: await this.goals.page({ pageSize: 8 }).then(page => page.goals).catch(() => []),
      pendingCommands: pending[0]?.count ?? 0,
    };
  }

  async hasNotice(key: string): Promise<boolean> {
    return Boolean(await this.db.select(id('owner_notice', HASH(key).slice(0, 24))));
  }

  /** Non-terminal tasks that transitively depend on `root`; bounded so a pathological graph cannot stall the tick. */
  /** Non-terminal dependency edges, loaded once so BFS never pays a per-node round trip. */
  private async openGraph(): Promise<Map<string, string[]>> {
    const [rows] = await this.db.query<[Array<{ id: RecordId; dependencies?: RecordId[] }>]>(
      "SELECT id, dependencies FROM task WHERE state NOT IN ['done', 'void'];");
    const children = new Map<string, string[]>();
    for (const row of rows ?? []) {
      for (const dep of row.dependencies ?? []) {
        const key = asId(dep);
        const list = children.get(key);
        if (list) list.push(asId(row.id)); else children.set(key, [asId(row.id)]);
      }
    }
    return children;
  }

  private downstreamCount(root: string, children: Map<string, string[]>): number {
    const seen = new Set<string>(); let frontier = [root];
    for (let depth = 0; depth < 8 && frontier.length && seen.size < 200; depth++) {
      const next: string[] = [];
      for (const node of frontier) {
        for (const child of children.get(node) ?? []) {
          if (!seen.has(child)) { seen.add(child); next.push(child); }
        }
      }
      frontier = next;
    }
    return seen.size;
  }

  /** Employee-to-manager round trips of a task since the owner last touched it, with the latest reasons (newest first). */
  async blockLoops(taskId: TaskId): Promise<{ loops: number; reasons: string[] }> {
    const task = id('task', taskId);
    const [touched] = await this.db.query<[Array<{ at: unknown }>]>(
      "SELECT at FROM audit WHERE task = $task AND action IN ['owner_reply', 'escalate', 'manager_recovery', 'recovery_progress'] ORDER BY at DESC LIMIT 1;", { task });
    const [blocks] = await this.db.query<[Array<{ evidence?: string }>]>(
      "SELECT evidence, at FROM audit WHERE task = $task AND action = 'block' AND at > <datetime>$since ORDER BY at DESC;",
      { task, since: touched[0] ? String(touched[0].at) : '1970-01-01T00:00:00Z' });
    return { loops: blocks.length, reasons: blocks.slice(0, 3).map(b => (b.evidence ?? '').replace(/\s+/g, ' ').slice(0, 300)) };
  }

  /** Batch variant of blockLoops: two queries for the whole gm-blocked set instead of two per task. */
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

  /** Stops a task that keeps bouncing between employee and manager: it becomes an owner question with the recent reasons. */
  async escalateLooping(task: { id: TaskId; version: number }, loops: number, reasons: string[]): Promise<boolean> {
    const [lastBlock] = await this.db.query<[Array<{ recovery_reason?: string }>]>(
      "SELECT recovery_reason, at FROM audit WHERE task = $task AND action = 'block' ORDER BY at DESC LIMIT 1;", { task: id('task', task.id) });
    if (['stale_window', 'missing_prerequisite', 'infrastructure'].includes(lastBlock?.[0]?.recovery_reason ?? '')) {
      return this.recoverLooping(task, loops, reasons);
    }
    const evidence = `这个任务已在员工与经理之间往返 ${loops} 次（阻塞→经理处理→再阻塞）仍没有完成，系统不再自动循环。最近的阻塞原因：\n${reasons.map((r, i) => `${i + 1}. ${r}`).join('\n')}\n请给方向后回复（任务按你的回复继续），或让经理把它拆小/作废。`;
    try {
      await this.run(`BEGIN;
        LET $t = SELECT * FROM ONLY $task;
        IF $t = NONE OR $t.state != 'blocked' OR $t.blocked_to != 'gm' OR $t.version != $expected { THROW 'task is not blocked on gm' };
        LET $next = UPDATE ONLY $task SET blocked_to = 'owner', version = $t.version + 1 RETURN AFTER;
        CREATE audit CONTENT { task: $task, actor: 'system:loop-breaker', action: 'escalate', evidence: $evidence, version: $next.version, at: time::now() };
        LET $sequence = UPDATE ONLY company_meta:outbox_counter SET value += 1 RETURN AFTER;
        CREATE outbox CONTENT { task: $task, kind: 'escalated', sequence: $sequence.value, payload: { loops: $loops }, at: time::now() };
        COMMIT;`, { task: id('task', task.id), expected: task.version, evidence, loops });
      return true;
    } catch { return false; }
  }

  /** One bounded recovery handoff per source task. Classification changes routing, never the failure budget. */
  private async recoverLooping(task: { id: TaskId; version: number }, loops: number, reasons: string[]): Promise<boolean> {
    const recovery = id('task', `recovery-${HASH(task.id).slice(0, 24)}`);
    try {
      await this.run(`BEGIN;
        LET $t = SELECT * FROM ONLY $task;
        IF $t.state != 'blocked' OR $t.blocked_to != 'gm' OR $t.version != $expected { THROW 'task moved' };
        LET $existing = SELECT * FROM ONLY $recovery;
        IF $existing = NONE {
          CREATE ONLY $recovery CONTENT { title: '恢复任务：' + $t.title,
            context: $context, executor_role: 'gm', reviewer_role: 'product', kind: 'task',
            goal: $t.goal, project: $t.project, code_repo_path: $t.code_repo_path,
            state: 'ready', version: 1, fence: 0, dependencies: [], work_intent: { kind: 'read' },
            recovery_source: $task, created_at: time::now() };
          UPDATE ONLY $task SET dependencies = array::distinct(array::append(dependencies ?? [], $recovery)),
            blocked_to = NONE, dependency_continuation = 'manager', version += 1;
          CREATE audit CONTENT { task: $recovery, actor: 'system:loop-breaker', action: 'create', evidence: $context, version: 1, at: time::now() };
          CREATE audit CONTENT { task: $task, actor: 'system:loop-breaker', action: 'manager_recovery',
            evidence: '系统阻塞已交经理恢复任务；完成后先交经理接续，不直接派员工', recovery_task: $recovery, at: time::now() };
          LET $seq = UPDATE ONLY company_meta:outbox_counter SET value += 1 RETURN AFTER;
          CREATE outbox CONTENT { task: $recovery, kind: 'created', sequence: $seq.value, payload: {}, at: time::now() };
        } ELSE {
          IF $t.recovery_stopped != true {
            UPDATE ONLY $task SET recovery_stopped = true, version += 1;
            CREATE audit CONTENT { task: $task, actor: 'system:loop-breaker', action: 'recovery_stopped',
              evidence: '同一任务的恢复交付后再次达到循环上限；停止自动重派，由经理检查恢复方案；不重建恢复链、不自动升级老板', at: time::now() };
          };
        };
        COMMIT;`, { task: id('task', task.id), recovery, expected: task.version,
          context: `源任务 ${task.id} 已阻塞 ${loops} 次。请补齐结构化前置依赖；必要时真实重采样并交不同员工独立批准，再恢复源任务。不得续期旧证据、放宽目标红线、增加预算或绕过独立验收。恢复任务完成仅表示处置安排已落实，不代表源业务完成。最近原因：${reasons.join(' / ')}` });
      return true;
    } catch { return false; }
  }

  /** Gates and questions waiting on the owner, with how long they have waited and what they hold up. */
  async waitingOnOwner(): Promise<WaitingItem[]> {
    const [rows] = await this.db.query<[Array<TaskRow & { goal_title?: string }>]>(
      `SELECT *, NONE AS context, goal.title AS goal_title FROM task WHERE (state = 'review' AND reviewer_role = 'owner') OR (state = 'blocked' AND blocked_to = 'owner');`);
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
    const children = await this.openGraph();
    return rows.map(row => {
      const gate = row.state === 'review';
      const since = Date.parse(String(latestAt.get(`${asId(row.id)}|${gate ? 'gate' : 'question'}`) ?? (row as { created_at?: unknown }).created_at ?? new Date()));
      return { taskId: asId(row.id), version: row.version, kind: gate ? 'gate' as const : 'question' as const, title: row.title,
        goal: row.goal_title ?? undefined, sinceMs: since, downstream: this.downstreamCount(asId(row.id), children) };
    });
  }

  /** Everything the daily brief reports, read straight from the task service (no model involved). */
  /**
   * `dispatch` is the latest pass's blocked verdicts, the same list the roster and pulse show (SYS-DISP R1). The brief lists each
   * one; it does not count dispatch notices, which are a subset raised only once an item is material or has waited five minutes.
   */
  async briefData(nowMs: number, date: string, capacity: RoleCapacity[] = [], dispatch: DispatchVerdict[] = []): Promise<BriefData> {
    const sinceIso = new Date(nowMs - 86_400_000).toISOString();
    const waiting = (await this.waitingOnOwner()).map(item => ({ ...item, hours: (nowMs - item.sinceMs) / 3_600_000 }));
    const [blocked, ready, counts, goals, health, quotas, opened, closed] = await this.db.query<[
      Array<{ id: RecordId; title: string; dependencies?: RecordId[] }>, Array<{ id: RecordId; title: string }>,
      Array<{ action: string; mechanical?: boolean; n: number }>, Array<{ id: RecordId; title: string; created_at: unknown }>,
      Array<{ id: RecordId; state: string; last_error?: string }>, Array<{ id: RecordId; lowest_pct?: number }>,
      Array<{ n: number }>, Array<{ reason?: string; n: number }>,
    ]>(`SELECT id, title, dependencies FROM task WHERE state = 'blocked' AND blocked_to = NONE AND array::len(dependencies ?? []) > 0;
      SELECT id, title FROM task WHERE state = 'ready';
      SELECT action, string::starts_with(evidence ?? '', '【通道回滚】') AS mechanical, count() AS n FROM audit WHERE at > <datetime>$since AND action IN ['accept', 'owner_approve', 'return', 'owner_reject', 'retire'] GROUP BY action, mechanical;
      SELECT id, title, created_at FROM goal WHERE state IN ['active', 'needs_repair'] ORDER BY created_at;
      SELECT id, state, last_error FROM provider_health;
      SELECT id, lowest_pct FROM company_meta WHERE lowest_pct != NONE;
      SELECT count() AS n FROM employee WHERE role != NONE AND created_at > <datetime>$since GROUP ALL;
      SELECT retired_reason AS reason, count() AS n FROM employee WHERE retired = true AND retired_at > <datetime>$since GROUP BY retired_reason;`, { since: sinceIso });
    const stuck: BriefData['stuck'] = [];
    // One pass over all open dependency rows, then membership tests in memory —
    // per-task SELECTs turn a brief into hundreds of round trips on the thin WSS pipe.
    const allDeps = [...new Set(blocked.flatMap(t => t.dependencies ?? []))];
    const [openDeps] = allDeps.length ? await this.db.query<[Array<{ id: RecordId }>]>(
      "SELECT id FROM task WHERE id IN $deps AND state != 'done' AND (state != 'void' OR reviewer_role = 'owner');", { deps: allDeps }) : [[]];
    const openDepIds = new Set((openDeps ?? []).map(r => asId(r.id)));
    for (const task of blocked) {
      if (!(task.dependencies ?? []).some(d => openDepIds.has(asId(d))))
        stuck.push({ taskId: asId(task.id), title: task.title, reason: '依赖都已完成，却仍是 blocked（需要解锁）' });
    }
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
    const n = (...actions: string[]) => counts.filter(c => actions.includes(c.action) && !c.mechanical).reduce((sum, c) => sum + c.n, 0);
    const rolledBack = counts.filter(c => c.action === 'return' && c.mechanical).reduce((sum, c) => sum + c.n, 0);
    const resources = [
      ...health.filter(h => h.state !== 'healthy').map(h => `${asId(h.id)} ${h.state}${h.last_error ? `：${h.last_error.slice(0, 60)}` : ''}`),
      ...quotas.filter(q => (q.lowest_pct ?? 100) <= 2).map(q => `${asId(q.id).replace('quota_', '')} 额度剩余 ${q.lowest_pct}%`),
    ];
    // The daily brief reads one activity-ordered snapshot, not the first console page: a goal behind page one
    // (the active SYS07 goal was card 27) is still named when it has a blocker or needs repair.
    const snapshot = await this.goals.cardsSnapshot({ states: ['active', 'needs_repair'] })
      .catch(() => ({ cards: [] as GoalCard[], snapshotAt: new Date().toISOString() }));
    const cardsById = new Map(snapshot.cards.map(card => [card.goalId, card]));
    return { date, waiting, stuck, last24h: { done: n('accept', 'owner_approve'), returned: n('return'), rolledBack, rejected: n('owner_reject'), retired: n('retire') },
      goals: goals.map(g => {
        const card = cardsById.get(asId(g.id));
        return { title: g.title, days: Math.max(0, Math.floor((nowMs - Date.parse(String(g.created_at))) / 86_400_000)),
          ...(card ? { id: card.goalId, needsRepair: card.needsRepair, deadline: card.deadline,
            blockers: card.blockers, ...(card.blockersOmitted ? { blockersOmitted: card.blockersOmitted } : {}),
            finalGate: card.finalGate, missingEvidence: card.outcome.missing, taskTotal: card.taskTotal } : {}) };
      }),
      resources, capacity, dispatchBlocked: briefDispatch(dispatch),
      churn: { created: opened[0]?.n ?? 0, retired: closed.reduce((sum, c) => sum + c.n, 0), claimLost: closed.filter(c => c.reason === 'claim race lost').reduce((sum, c) => sum + c.n, 0) } };
  }

  /** Free-form owner instruction routed to the manager as a gm task; gm decides how to act on it. */
  async instruct(input: { text: string; source: string; key: string }): Promise<{ taskId: string }> {
    requireText(input.text, 'instruction text', 2, 10000);
    const taskId = HASH(`instruct\0${input.key}`).slice(0, 16);
    const task = id('task', taskId);
    if (await this.db.select(task)) return { taskId };
    const title = `老板指示：${input.text.trim().split(/\r?\n/)[0].slice(0, 60)}`;
    await this.db.query(`CREATE ONLY $task CONTENT { title: $title, context: $context, kind: 'task',
      executor_role: 'gm', reviewer_role: 'product', dependencies: [], state: 'ready',
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
          case 'goal': result = `goal=${(await this.createGoal({ text: row.text ?? '', source, key, tier: row.tier, project: row.project, pipeline: row.pipeline })).id}`; break;
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

