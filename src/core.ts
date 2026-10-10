import { createHash, randomUUID } from 'node:crypto';
import { RecordId } from 'surrealdb';
import type { CompanyDatabase } from './database.ts';
import type { ClaimResult, CompanyBrief, CompanyCore, CreateDelivery, CreateTask, Credential, DefView, DeferTaskUntil, EnsureDef, GoalTier, ProjectView, EmployeeScore, Evidence, GoalView, HistoryEntry, LeaseProof, OpsScope, OutboxEvent, OwnerDecisionInput, Principal, RetireTask, ReviewerRole, Role, SessionRef, TaskId, TaskKind, TaskState, TaskView } from './contracts.ts';
import { OwnerDesk } from './owner.ts';
import { deliveryChain } from './flows.ts';
import { ProjectStore } from './projects.ts';
import { collectEvalState, validateScores, writeScorecards } from './scoring.ts';
import type { EmployeeDef, Workforce } from './workforce.ts';

import { CompanyError } from './core-errors.ts';
import { WorktreeRegistry, validateIntent, type RegistryOptions } from './dispatcher/worktree-registry.ts';
import type { WorkIntent, WorktreeAssignment, WorktreeView } from './contracts.ts';
export { CompanyError };

export const ROLES: readonly Role[] = ['gm', 'product', 'engineering', 'ai-content', 'concept-design', 'asset-production', 'screenwriter', 'qa', 'cs', 'eval'];
/**
 * 岗位→必配轨常量表：executorRole 在表内的任务必须带指定 discipline——createTask
 * 缺轨/错轨显式拒绝；claim/dispatch 双端要求任务轨等于必配轨且编制 tracks 显式含该轨
 * （这些岗位的空 tracks 不再视为全接）。当前仅编剧岗，未来同类岗位在此扩展。
 */
export const REQUIRED_TRACKS: Partial<Record<Role, string>> = { screenwriter: '编剧' };
const DEFAULT_LEASE_SECONDS = 600;
/** Checkpoints cost a full model round trip each; past this many per holder per task the holder should heartbeat/submit instead. */
const DEFAULT_CHECKPOINT_LIMIT = 6;
const HISTORY_LIMIT = 40;
const OPS_HISTORY_LIMIT = 15;
const HISTORY_EVIDENCE_CHARS = 6000;
const OPS_EVIDENCE_CHARS = 600;
export const HASH = (value: string) => createHash('sha256').update(value).digest('hex');
export const id = (table: string, value: string) => new RecordId(table, value);
export const asId = (value: unknown): string => value instanceof RecordId ? String(value.id) : String(value).split(':').slice(1).join(':');

/**
 * A dependency counts as satisfied when it is 'done', or when it is 'void' and not an
 * owner gate. Voiding an owner-reviewed task (prototype demo, acceptance gate) must not
 * stand in for the owner's approval, so dependents on it stay blocked. Exemption: a
 * dependent that is a goal anchor (member of its goal's anchors list) is rollup
 * bookkeeping, not gated work. For anchors every 'void' dependency counts as satisfied,
 * or retiring a gated task could never unblock the goal's acceptance anchor.
 */
const DEP_UNSATISFIED = `state != 'done' AND (state != 'void' OR reviewer_role = 'owner')`;
const depUnsatisfiedFor = (holder: string) =>
  `state != 'done' AND (state != 'void' OR (reviewer_role = 'owner' AND (${holder}.goal = NONE OR ${holder}.id NOT IN (${holder}.goal.anchors ?? []))))`;

/**
 * Unlocks blocked children of $task whose dependencies are all finished ('done' or 'void')
 * (retired tasks count as satisfied so downstream chains unblock on retire). Requires
 * $task and $actor in scope. Retire reuses this block without the goal-close below.
 */
const UNLOCK_CHILDREN_SQL = `
  LET $children = SELECT * FROM task WHERE state = 'blocked' AND blocked_to = NONE AND $task IN dependencies;
  FOR $child IN $children {
    LET $remaining = SELECT * FROM task WHERE id IN $child.dependencies AND ${depUnsatisfiedFor('$child')};
    IF array::len($remaining) = 0 {
      LET $unlocked = UPDATE ONLY $child.id SET state = 'ready', version += 1, resume_state = NONE;
      CREATE audit CONTENT { task: $child.id, actor: $actor, action: 'dependency_unlocked', version: $unlocked.version, at: time::now() };
      LET $sequence = UPDATE ONLY company_meta:outbox_counter SET value += 1 RETURN AFTER;
      CREATE outbox CONTENT { task: $child.id, kind: 'dependency_unlocked', sequence: $sequence.value, payload: { state: 'ready' }, at: time::now() };
    };
  };
`;

/**
 * Unlocks blocked children of $task whose dependencies are all finished, and closes the goal
 * when its final owner acceptance gate is done. Requires $task and $actor in scope.
 */
export const UNLOCK_SQL = `${UNLOCK_CHILDREN_SQL}
  UPDATE goal SET state = 'done', done_at = time::now() WHERE state = 'active' AND tasks.acceptance = $task;
`;

/**
 * Adds $task as a dependency of the goal's first unfinished anchor (manual, then final
 * acceptance) and re-blocks that anchor, dropping any lease on it. Requires $goal, $task.
 */
export const GOAL_ANCHOR_SQL = `
  IF $goal != NONE {
    LET $g = SELECT * FROM ONLY $goal;
    IF $g = NONE OR $g.state != 'active' { THROW 'goal not found or closed' };
    LET $open = array::filter($g.anchors, |$a| $a.state NOT IN ['done', 'void']);
    IF array::len($open) > 0 {
      LET $anchor = SELECT * FROM ONLY $open[0];
      UPDATE employee SET active_task = NONE WHERE active_task = $anchor.id;
      UPDATE ONLY $anchor.id SET dependencies += $task, state = 'blocked', blocked_to = NONE,
        resume_state = NONE, current_employee = NONE, delivery_id = NONE, lease_expires_at = NONE,
        version += 1;
    };
  };
`;


interface EmployeeRow {
  id: RecordId;
  role: Role;
  capabilities: Array<'execute' | 'review' | 'manage'>;
  credential_digest: string;
  credential_hash: string;
  revoked: boolean;
  retired?: boolean;
  active_task?: RecordId;
  tracks?: string[];
}

interface TaskRow {
  id: RecordId;
  title: string;
  context: string;
  state: TaskState;
  executor_role: Role;
  reviewer_role: ReviewerRole;
  discipline?: string;
  dependencies: RecordId[];
  version: number;
  submitted_by?: string;
  current_employee?: string;
  delivery_id?: string;
  lease_expires_at?: number;
  fence: number;
  blocked_to?: 'gm' | 'owner';
  resume_role?: string;
  resume_state?: TaskState;
  kind?: TaskKind;
  goal?: RecordId;
  handover?: boolean;
  previous_employee?: string;
  progress_at?: number;
  evaluated_at?: string;
  eval_via?: string;
  eval_attempts?: number;
  jev_release_version?: number;
  jev_route_version?: number;
  owner_rerouted?: boolean;
  work_intent?: WorkIntent;
  worktree?: WorktreeAssignment;
  repo_path?: string;
  goal_tier?: string;
}

export interface IdempotencyRow { payload_digest: string; result: TaskRow }
export type { TaskRow };

export function view(row: TaskRow): TaskView {
  return {
    id: asId(row.id), title: row.title, context: row.context, state: row.state,
    executorRole: row.executor_role, reviewerRole: row.reviewer_role,
    discipline: row.discipline ?? undefined,
    kind: row.kind ?? 'task', goalId: row.goal ? asId(row.goal) : undefined,
    dependencies: (row.dependencies ?? []).map(asId), version: row.version,
    submittedBy: row.submitted_by, currentEmployee: row.current_employee,
    deliveryId: row.delivery_id,
    leaseExpiresAt: row.lease_expires_at ? new Date(row.lease_expires_at * 1000).toISOString() : undefined,
    fence: row.fence,
    blockedTo: row.blocked_to,
    handover: row.handover || undefined,
    previousEmployee: row.previous_employee,
    workIntent: row.work_intent, worktree: row.worktree,
  };
}

export function requireText(value: string, name: string, min = 1, max = 10000): void {
  if (typeof value !== 'string' || value.trim().length < min || value.length > max) {
    throw new CompanyError('invalid', `Invalid ${name}`);
  }
}

function requireRole(role: string): asserts role is Role {
  if (!ROLES.includes(role as Role)) throw new CompanyError('invalid', 'Invalid role');
}

function requireReviewer(role: string): asserts role is ReviewerRole {
  if (role !== 'owner') requireRole(role);
}

export class SurrealCompanyCore implements CompanyCore {
  readonly leaseSeconds: number;
  readonly checkpointLimit: number;
  constructor(readonly database: CompanyDatabase, options?: { leaseSeconds?: number; checkpointLimit?: number; workforce?: Workforce; worktrees?: RegistryOptions }) {
    const seconds = options?.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3600) {
      throw new CompanyError('invalid', 'Invalid lease duration');
    }
    this.leaseSeconds = seconds;
    this.checkpointLimit = options?.checkpointLimit ?? DEFAULT_CHECKPOINT_LIMIT;
    this.workforce = options?.workforce;
    this.owner = new OwnerDesk(database);
    this.projects = new ProjectStore(database.db);
    this.worktrees = options?.worktrees ? new WorktreeRegistry(database.db, options.worktrees) : undefined;
  }
  readonly worktrees?: WorktreeRegistry;
  private readonly owner: OwnerDesk;
  private readonly projects: ProjectStore;
  /** Manage tools reuse the workforce writer; absent in processes that never wire one. */
  private readonly workforce?: Workforce;
  private get db() { return this.database.db; }

  async authenticate(credential: Credential): Promise<Principal> {
    if (typeof credential !== 'string' || !credential.startsWith('sck_') || credential.length > 200) {
      throw new CompanyError('unauthorized', 'Invalid credential');
    }
    const t0 = Date.now();
    const [rows] = await this.db.query<[EmployeeRow[]]>(
      'SELECT *, def.tracks AS tracks FROM employee WHERE credential_digest = $digest LIMIT 1;', { digest: HASH(credential) }
    );
    // credential_digest is a SHA-256 over a high-entropy random token; the argon2
    // re-verify added nothing (same row, same secret) and under launchd QoS a
    // memory-hard KDF is throttled ~500x — it was the 50s stall per request.
    console.log(`auth timing: query=${Date.now() - t0}ms`);
    const row = rows?.[0];
    // retired = the registered instance (Paseo agent binding) is gone; a credential
    // that outlives its instance is treated as leaked and dies with it.
    if (!row || row.revoked || row.retired) {
      throw new CompanyError('unauthorized', 'Invalid credential');
    }
    return { employeeId: asId(row.id), role: row.role, capabilities: row.capabilities, tracks: row.tracks ?? undefined };
  }

  private async authorized(credential: Credential, capability?: 'execute' | 'review' | 'manage'): Promise<Principal> {
    const actor = await this.authenticate(credential);
    if (capability && !actor.capabilities.includes(capability)) throw new CompanyError('forbidden', 'Capability denied');
    return actor;
  }

  async listTasks(credential: Credential, state?: TaskState): Promise<TaskView[]> {
    const actor = await this.authorized(credential);
    const [rows] = actor.role === 'gm'
      ? await this.db.query<[TaskRow[]]>('SELECT * FROM task ORDER BY id;')
      : await this.db.query<[TaskRow[]]>(
          'SELECT * FROM task WHERE executor_role = $role OR reviewer_role = $role ORDER BY id;', { role: actor.role }
        );
    return rows.filter(row => (!state || row.state === state) &&
      !(row.state === 'review' && row.submitted_by === actor.employeeId)).map(view);
  }

  async getTask(credential: Credential, taskId: TaskId): Promise<TaskView> {
    const actor = await this.authorized(credential);
    const row = await this.db.select<TaskRow>(id('task', taskId));
    if (!row) throw new CompanyError('not_found', 'Task not found');
    if (actor.role !== row.executor_role && actor.role !== row.reviewer_role && actor.role !== 'gm' && actor.role !== 'eval') {
      throw new CompanyError('forbidden', 'Task access denied');
    }
    return view(row);
  }

  private idemId(actor: string, action: string, key: string): RecordId {
    requireText(key, 'idempotency key', 8, 200);
    return id('idempotency', HASH(`${actor}\0${action}\0${key}`));
  }

  private async replay(ident: RecordId, payloadDigest: string): Promise<TaskView | undefined> {
    const prior = await this.db.select<IdempotencyRow>(ident);
    if (!prior) return undefined;
    if (prior.payload_digest !== payloadDigest) throw new CompanyError('conflict', 'Idempotency key reused with different input');
    return view(prior.result);
  }

  private async txTask(query: string, vars: Record<string, unknown>): Promise<TaskRow> {
    try {
      for (let attempt = 0; attempt < 5; attempt++) {
        const responses = await this.db.query<unknown[]>(query, vars).responses();
        const failures = responses.filter(response => !response.success);
        if (failures.length) {
          const cause = failures.map(response => response.error.message).find(message =>
            !message.includes('not executed due to') && !message.startsWith('Cannot COMMIT')) ?? '';
          if (/conflict/i.test(cause) && attempt < 4) {
            await Bun.sleep(10 * (attempt + 1));
            continue;
          }
          if (/conflict/i.test(cause)) throw new CompanyError('temporarily_unavailable', 'Database contention; retry request', true);
          if (/self review/i.test(cause)) throw new CompanyError('self_review', 'Employee cannot review own delivery');
          if (/discipline track denied/i.test(cause)) throw new CompanyError('forbidden', 'Employee definition does not cover the task discipline');
          if (/leased by another|already has active task/i.test(cause)) throw new CompanyError('already_claimed', 'Task or employee already leased');
          if (/lease expired/i.test(cause)) throw new CompanyError('lease_expired', 'Lease expired');
          if (/denied|forbidden|revoked/i.test(cause)) throw new CompanyError('forbidden', 'Action forbidden');
          if (/checkpoint limit/i.test(cause)) throw new CompanyError('checkpoint_limit', 'Checkpoint limit reached');
          if (/task retired/i.test(cause)) throw new CompanyError('conflict', 'Task has been retired');
          if (/live owner-gate dependents/i.test(cause)) throw new CompanyError('conflict', 'Owner-gated task has live dependents; retire them first');
          if (/already terminal/i.test(cause)) throw new CompanyError('conflict', 'Task already in a terminal state');
          if (/version moved/i.test(cause)) throw new CompanyError('conflict', 'Task version moved');
          if (/dependency not found|not found/i.test(cause)) throw new CompanyError('not_found', 'Referenced record not found');
          throw new CompanyError('conflict', 'Task changed or transaction conflicted');
        }
        const result = responses.map(response => response.success ? response.result : undefined);
        const row = result.at(-2) as TaskRow | undefined;
        if (!row) throw new CompanyError('conflict', 'Transaction returned no task');
        return row;
      }
      throw new CompanyError('conflict', 'Transaction retries exhausted');
    } catch (error) {
      if (error instanceof CompanyError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (/conflict|transaction|already exists|not allowed|failed to compute/i.test(message)) {
        throw new CompanyError('conflict', 'Task changed or transaction conflicted');
      }
      throw error;
    }
  }

  async createTask(credential: Credential, input: CreateTask): Promise<TaskView> {
    const actor = await this.authorized(credential, 'manage');
    if (!['gm', 'product'].includes(actor.role)) throw new CompanyError('forbidden', 'Task creation denied');
    requireText(input.title, 'title', 3, 200);
    requireText(input.context, 'context', 1, 20000);
    requireRole(input.executorRole);
    requireReviewer(input.reviewerRole);
    if (input.discipline !== undefined) {
      requireText(input.discipline, 'discipline', 1, 60);
      const vocab = await this.disciplineVocab(input.goalId);
      if (vocab && !vocab.has(input.discipline)) {
        throw new CompanyError('invalid', `discipline must be in the project's tracks vocabulary: ${[...vocab].join('、')}`);
      }
    }
    if (input.executorRole === 'eval' || input.reviewerRole === 'eval') {
      throw new CompanyError('invalid', 'eval is a workforce-only role and cannot take tasks');
    }
    validateIntent(input.workIntent);
    if (input.workIntent?.kind === 'code' && input.executorRole !== 'engineering') throw new CompanyError('invalid', 'Code writes require engineering');
    // 必配轨岗位（如 screenwriter）：任务必须带指定轨，缺轨/错轨显式拒绝，防止无轨任务落到专属编制。
    const requiredTrack = REQUIRED_TRACKS[input.executorRole];
    if (requiredTrack !== undefined && input.discipline !== requiredTrack) {
      throw new CompanyError('invalid', `executorRole ${input.executorRole} requires discipline=${requiredTrack}`);
    }
    const kind = input.kind ?? 'task';
    if (!['task', 'gate', 'release', 'deploy'].includes(kind)) throw new CompanyError('invalid', 'Invalid task kind');
    if (input.goalId !== undefined) requireText(input.goalId, 'goal', 1, 100);
    const dependencies = [...new Set(input.dependencies ?? [])];
    const idem = this.idemId(actor.employeeId, 'create', input.idempotencyKey);
    const digest = HASH(JSON.stringify({ ...input, dependencies }));
    const prior = await this.replay(idem, digest);
    if (prior) return prior;
    const taskId = randomUUID();
    const task = id('task', taskId);
    const vars = {
      actor: id('employee', actor.employeeId), task, idem, digest,
      audit: id('audit', randomUUID()), outbox: id('outbox', randomUUID()),
      title: input.title, context: input.context, executor: input.executorRole,
      reviewer: input.reviewerRole, dependencies: dependencies.map(dep => id('task', dep)),
      kind, goal: input.goalId ? id('goal', input.goalId) : undefined,
      discipline: input.discipline, work_intent: input.workIntent,
    };
    try {
      const row = await this.txTask(`BEGIN;
        LET $who = SELECT * FROM ONLY $actor;
        IF $who.revoked = true OR 'manage' NOT IN $who.capabilities OR $who.role NOT IN ['gm', 'product'] { THROW 'actor revoked or forbidden' };
        FOR $dep IN $dependencies {
          LET $d = SELECT * FROM ONLY $dep;
          IF $d = NONE { THROW 'dependency not found' };
        };
        LET $unfinished = SELECT VALUE id FROM task WHERE id IN $dependencies AND ${DEP_UNSATISFIED};
        LET $created = CREATE ONLY $task CONTENT {
          title: $title, context: $context, executor_role: $executor, reviewer_role: $reviewer,
          discipline: $discipline, work_intent: $work_intent,
          dependencies: $dependencies, state: IF array::len($unfinished) = 0 THEN 'ready' ELSE 'blocked' END,
          version: 1, fence: 0, submitted_by: NONE, current_employee: NONE,
          delivery_id: NONE, lease_expires_at: NONE, resume_role: NONE, resume_state: 'ready', blocked_to: NONE,
          kind: $kind, goal: $goal, created_at: time::now()
        };
        ${GOAL_ANCHOR_SQL}
        CREATE ONLY $audit CONTENT { task: $task, actor: $actor, action: 'create', version: 1, at: time::now() };
        LET $sequence = UPDATE ONLY company_meta:outbox_counter SET value += 1 RETURN AFTER;
        CREATE ONLY $outbox CONTENT { task: $task, kind: 'created', sequence: $sequence.value, payload: { state: $created.state }, at: time::now() };
        CREATE ONLY $idem CONTENT { payload_digest: $digest, result: $created };
        RETURN $created;
        COMMIT;`, vars);
      return view(row);
    } catch (error) {
      const replay = await this.replay(idem, digest);
      if (replay) return replay;
      throw error;
    }
  }

  async claim(credential: Credential, taskId: TaskId): Promise<ClaimResult> {
    const actor = await this.authorized(credential);
    if (!this.worktrees) return this.claimLease(actor, taskId);
    const task = await this.getTask(credential, taskId);
    const reviewing = task.state === 'review';
    if (!['ready', 'doing', 'review'].includes(task.state) ||
        !actor.capabilities.includes(reviewing ? 'review' : 'execute') ||
        actor.role !== (reviewing ? task.reviewerRole : task.executorRole) ||
        (reviewing && task.submittedBy === actor.employeeId) ||
        (task.discipline && actor.tracks?.length && !actor.tracks.includes(task.discipline))) {
      throw new CompanyError('forbidden', 'Task claim denied');
    }
    const project = await this.taskProject(taskId);
    return this.worktrees.locked(project?.repoPath ?? this.worktrees.options.opsRepo, async (repo, list) => {
      // Re-read under the cross-process repo lock: the first allocation may have completed while waiting.
      const fresh = await this.getTask(credential, taskId);
      const [now] = await this.db.query<[number]>('RETURN time::unix(time::now());');
      if (fresh.currentEmployee && fresh.currentEmployee !== actor.employeeId && fresh.leaseExpiresAt && Date.parse(fresh.leaseExpiresAt) > now * 1000) throw new CompanyError('already_claimed', 'Task scene still leased');
      const holder = await this.db.select<EmployeeRow>(id('employee', actor.employeeId));
      if (holder?.active_task && asId(holder.active_task) !== taskId) {
        const active = await this.db.select<TaskRow>(holder.active_task);
        if (active?.current_employee === actor.employeeId && (active.lease_expires_at ?? 0) > now) throw new CompanyError('already_claimed', 'Employee still holds another task');
      }
      const worktree = await this.worktrees!.allocate(repo, list, fresh, actor, project);
      return this.claimLease(actor, taskId, worktree);
    });
  }

  async readWorkspace(credential: Credential, taskId?: TaskId): Promise<WorktreeAssignment | undefined> {
    const actor = await this.authorized(credential);
    if (!['gm', 'eval'].includes(actor.role)) throw new CompanyError('forbidden', 'Non-lease workspace requires gm/eval');
    if (!this.worktrees) return undefined;
    if (taskId) await this.getTask(credential, taskId);
    const project = taskId ? await this.taskProject(taskId) : undefined;
    return this.worktrees.readWorkspace(project?.repoPath ?? this.worktrees.options.opsRepo, actor, project);
  }
  async releaseWorkspace(credential: Credential): Promise<void> {
    const actor = await this.authorized(credential);
    await this.worktrees?.releaseWorkspace(actor.employeeId);
  }

  async listWorktrees(credential: Credential, taskId?: TaskId): Promise<WorktreeView[]> {
    const actor = await this.authorized(credential);
    if (!this.worktrees) return [];
    if (!taskId && actor.role !== 'gm') throw new CompanyError('forbidden', 'Global worktree inventory requires gm');
    if (taskId) {
      await this.getTask(credential, taskId);
      const project = await this.taskProject(taskId);
      const { repo } = await this.worktrees.identity(project?.repoPath ?? this.worktrees.options.opsRepo);
      return this.worktrees.inventory(repo);
    }
    return this.worktrees.inventory();
  }

  private async claimLease(actor: Principal, taskId: TaskId, worktree?: WorktreeAssignment): Promise<ClaimResult> {
    const task = id('task', taskId);
    const row = await this.txTask(`BEGIN;
      LET $now = time::unix(time::now());
      LET $who = SELECT * FROM ONLY $actor;
      LET $t = SELECT * FROM ONLY $task;
      IF $who = NONE OR $who.revoked = true OR $t = NONE { THROW 'not found or revoked' };
      IF $t.state = 'void' { THROW 'task retired' };
      IF $t.state NOT IN ['ready', 'review', 'doing'] { THROW 'task not claimable' };
      IF $t.state = 'review' {
        IF $t.submitted_by = $employee { THROW 'self review denied' };
        IF 'review' NOT IN $who.capabilities OR $t.reviewer_role != $who.role { THROW 'review denied' };
      } ELSE {
        IF 'execute' NOT IN $who.capabilities OR $t.executor_role != $who.role { THROW 'execute denied' };
      };
      IF $t.current_employee != NONE AND $t.lease_expires_at > $now AND $t.current_employee != $employee { THROW 'leased by another employee' };
      LET $def_tracks = $who.def.tracks ?? [];
      IF $t.discipline != NONE AND array::len($def_tracks) > 0 AND $t.discipline NOT IN $def_tracks { THROW 'discipline track denied' };
      IF $has_req AND ($t.discipline != $req OR $req NOT IN $def_tracks) { THROW 'discipline track denied' };
      IF $who.active_task != NONE AND $who.active_task != $task {
        LET $active = SELECT * FROM ONLY $who.active_task;
        IF $active != NONE AND $active.lease_expires_at > $now AND $active.current_employee = $employee { THROW 'employee already has active task' };
      };
      LET $same = $t.current_employee = $employee AND $t.lease_expires_at > $now;
      LET $next = UPDATE ONLY $task SET
        state = IF $t.state = 'review' THEN 'review' ELSE 'doing' END,
        current_employee = $employee,
        delivery_id = IF $same THEN $t.delivery_id ELSE $delivery END,
        lease_expires_at = $now + $lease_seconds,
        progress_at = IF $same THEN $t.progress_at ELSE $now END,
        fence = IF $same THEN $t.fence ELSE $t.fence + 1 END,
        version = IF $same THEN $t.version ELSE $t.version + 1 END,
        worktree = IF $assignment != NONE THEN $assignment ELSE $t.worktree END
        RETURN AFTER;
      UPDATE ONLY $actor SET active_task = $task, workspace_read_active = false;
      IF $assignment != NONE {
        UPDATE ONLY $tree SET last_used_at = time::now();
        UPSERT ONLY $reference CONTENT { task: $task, tree: $tree, employee: $employee,
          delivery: $next.delivery_id, fence: $next.fence, intent: $assignment.intent, at: time::now() };
      };
      IF !$same {
        CREATE ONLY $audit CONTENT { task: $task, actor: $actor, action: 'claim', version: $next.version, at: time::now(), evidence: IF $assignment != NONE THEN type::string($assignment) ELSE NONE END };
        LET $sequence = UPDATE ONLY company_meta:outbox_counter SET value += 1 RETURN AFTER;
        CREATE ONLY $outbox CONTENT { task: $task, kind: 'claimed', sequence: $sequence.value, payload: { employee: $employee, fence: $next.fence }, at: time::now() };
      };
      RETURN $next;
      COMMIT;`, {
      actor: id('employee', actor.employeeId), employee: actor.employeeId, task,
      delivery: randomUUID(), lease_seconds: this.leaseSeconds,
      assignment: worktree, tree: worktree ? id('worktree', worktree.id) : undefined, reference: id('worktree_ref', taskId),
      audit: id('audit', randomUUID()), outbox: id('outbox', randomUUID()),
      // 必配轨岗位（screenwriter）：要求任务轨恰为必配轨且编制 tracks 显式覆盖——
      // 空 tracks、无 def 的员工与缺轨任务一律 forbidden（claim 端，派工端同规则过滤）。
      req: REQUIRED_TRACKS[actor.role] ?? null, has_req: REQUIRED_TRACKS[actor.role] !== undefined,
    });
    const taskView = view(row);
    const project = await this.taskProject(taskId);
    return { task: taskView, deliveryId: taskView.deliveryId!, fence: taskView.fence,
      leaseExpiresAt: taskView.leaseExpiresAt!, history: await this.readHistory(taskId),
      predecessors: await this.predecessors(taskId, actor.employeeId),
      project, worktree: taskView.worktree };
  }

  /**
   * Distinct employees that claimed this task before the current holder, in first-claim order.
   * Their Paseo session IDs let a successor read the full transcript (`paseo logs <agentId>`)
   * instead of relying on the truncated log tail stored in the handover packet.
   */
  private async predecessors(taskId: TaskId, exclude: string): Promise<SessionRef[]> {
    const [claims] = await this.db.query<[Array<{ actor?: unknown }>]>(
      `SELECT actor, at FROM audit WHERE task = $task AND action = 'claim' ORDER BY at ASC;`,
      { task: id('task', taskId) });
    const ids = [...new Set((claims ?? []).map(c => asId(c.actor)).filter(a => a && a !== exclude))];
    if (!ids.length) return [];
    const [rows] = await this.db.query<[Array<{ id: RecordId; paseo_agent_id?: string; provider?: string; role?: string; retired?: boolean }>]>(
      `SELECT id, paseo_agent_id, provider, role, retired FROM employee WHERE id IN $ids;`,
      { ids: ids.map(e => id('employee', e)) });
    const byId = new Map((rows ?? []).map(r => [asId(r.id), r]));
    return ids.slice(-6).map(emp => {
      const r = byId.get(emp);
      return { employee: emp, agentId: r?.paseo_agent_id ?? undefined, provider: r?.provider ?? undefined, role: r?.role ?? undefined, retired: r?.retired === true };
    });
  }

  /**
   * Discipline vocabulary of the goal's project: a Set of track names when the project
   * defines a non-empty `disciplines` list, else undefined (free-form values allowed).
   */
  private async disciplineVocab(goalId?: string): Promise<Set<string> | undefined> {
    if (!goalId) return undefined;
    const [rows] = await this.db.query<[Array<{ disciplines?: Array<{ name?: string }> }>]>(
      'SELECT project.disciplines AS disciplines FROM $goal;', { goal: id('goal', goalId) });
    const names = (rows[0]?.disciplines ?? []).map(d => d?.name).filter((n): n is string => typeof n === 'string' && n.length > 0);
    return names.length ? new Set(names) : undefined;
  }

  private async taskProject(taskId: TaskId): Promise<ProjectView | undefined> {
    const [rows] = await this.db.query<[Array<{ project?: RecordId }>]>(
      'SELECT goal.project AS project FROM $task;', { task: id('task', taskId) });
    const project = rows[0]?.project;
    return project ? this.projects.get(String(project.id)) : undefined;
  }

  private async readHistory(taskId: TaskId): Promise<HistoryEntry[]> {
    type Row = { action: string; actor: unknown; evidence?: string; version?: number; at: unknown };
    // Ops rows get their own window so a chatty broker session cannot push claims and checkpoints out of the
    // handover history; routine `ops_call` reads are never shown.
    const [protocol, ops] = await this.db.query<[Row[], Row[]]>(
      `SELECT action, actor, evidence, version, at FROM audit WHERE task = $task AND !string::starts_with(action, 'ops_') ORDER BY at DESC LIMIT $limit;
       SELECT action, actor, evidence, version, at FROM audit WHERE task = $task AND string::starts_with(action, 'ops_') AND action != 'ops_call' ORDER BY at DESC LIMIT $ops_limit;`,
      { task: id('task', taskId), limit: HISTORY_LIMIT, ops_limit: OPS_HISTORY_LIMIT }
    );
    const rows = [...protocol, ...ops].sort((a, b) => (String(a.at) < String(b.at) ? 1 : String(a.at) > String(b.at) ? -1 : 0));
    return rows.reverse().map(row => ({
      action: row.action,
      actor: row.actor instanceof RecordId ? asId(row.actor) : String(row.actor),
      evidence: row.evidence ? String(row.evidence).slice(0, HISTORY_EVIDENCE_CHARS) : undefined,
      version: row.version, at: String(row.at),
    }));
  }

  async history(credential: Credential, taskId: TaskId): Promise<HistoryEntry[]> {
    await this.getTask(credential, taskId);
    return this.readHistory(taskId);
  }

  async companyBrief(credential: Credential): Promise<CompanyBrief> {
    await this.authorized(credential);
    return this.owner.brief();
  }

  private async relayActor(credential: Credential, ownerQuote: string): Promise<string> {
    const actor = await this.authorized(credential, 'manage');
    if (actor.role !== 'gm') throw new CompanyError('forbidden', 'Only gm may relay owner instructions');
    requireText(ownerQuote, 'owner quote', 2, 4000);
    return `gm-relay:${actor.employeeId}`;
  }

  async relayGoal(credential: Credential, input: { text: string; ownerQuote: string; idempotencyKey: string; tier?: GoalTier; project?: string }): Promise<GoalView> {
    const source = await this.relayActor(credential, input.ownerQuote);
    return this.owner.createGoal({ text: input.text, source, key: `${source}:${input.idempotencyKey}`,
      note: `老板原话：${input.ownerQuote}`, tier: input.tier, project: input.project });
  }

  async triageGoal(credential: Credential, input: { goalId: string; tier: GoalTier; reason: string }): Promise<GoalView> {
    const actor = await this.authorized(credential, 'manage');
    if (actor.role !== 'gm') throw new CompanyError('forbidden', 'Only gm may triage goals');
    requireText(input.reason, 'reason', 4, 4000);
    return this.owner.triage(input.goalId, input.tier, `${actor.employeeId}：${input.reason}`);
  }

  async createDelivery(credential: Credential, input: CreateDelivery): Promise<TaskView[]> {
    requireText(input.goalId, 'goal', 1, 100);
    requireText(input.title, 'title', 3, 160);
    requireText(input.spec, 'spec', 20, 20000);
    if (input.discipline !== undefined) {
      requireText(input.discipline, 'discipline', 1, 60);
      const vocab = await this.disciplineVocab(input.goalId);
      if (vocab && !vocab.has(input.discipline)) {
        throw new CompanyError('invalid', `discipline must be in the project's tracks vocabulary: ${[...vocab].join('、')}`);
      }
    }
    const specs = deliveryChain(input.title, input.spec);
    const created: TaskView[] = [];
    let dependencies = [...new Set(input.dependencies ?? [])];
    for (const [index, spec] of specs.entries()) {
      const task = await this.createTask(credential, {
        ...spec, goalId: input.goalId, dependencies, idempotencyKey: `${input.idempotencyKey}:delivery:${index}`,
        // Only the implementation leg carries the discipline track; release/deploy legs stay generic.
        discipline: index === 0 ? input.discipline : undefined,
      });
      created.push(task);
      dependencies = [task.id];
    }
    return created;
  }

  // ---- 受控编制管理工具（manage = gm/product） ----
  // 员工侧唯一写编制/词表的入口；owner console 与 admin CLI 继续可用。每次写落一条 audit。

  private static defView(d: Pick<EmployeeDef, 'id' | 'role' | 'provider' | 'model' | 'thinking' | 'tracks' | 'enabled' | 'maxInstances' | 'priority' | 'weight'>): DefView {
    return { id: d.id, role: d.role, provider: d.provider, model: d.model, thinking: d.thinking,
      tracks: d.tracks, enabled: d.enabled, maxInstances: d.maxInstances, priority: d.priority, weight: d.weight };
  }

  private async auditManage(actor: Principal, action: 'def_ensure' | 'project_disciplines_update', summary: Record<string, unknown>): Promise<void> {
    await this.db.query(
      'CREATE audit CONTENT { actor: $actor, action: $action, evidence: $evidence, at: time::now() };',
      { actor: id('employee', actor.employeeId), action, evidence: JSON.stringify(summary).slice(0, OPS_EVIDENCE_CHARS) });
  }

  async listDefs(credential: Credential): Promise<DefView[]> {
    await this.authorized(credential, 'manage');
    type Row = { id: RecordId; role: Role; provider: string; model: string; thinking?: string; tracks?: string[];
      enabled?: boolean; max_instances?: number; priority?: number; weight?: number };
    const [rows] = await this.db.query<[Row[]]>('SELECT * FROM employee_def ORDER BY id;');
    return (rows ?? []).map(r => ({ id: asId(r.id), role: r.role, provider: r.provider, model: r.model,
      thinking: r.thinking ?? undefined, tracks: r.tracks ?? undefined, enabled: r.enabled !== false,
      maxInstances: r.max_instances ?? 1, priority: r.priority ?? 100, weight: r.weight ?? 10 }));
  }

  async ensureDef(credential: Credential, input: EnsureDef): Promise<DefView> {
    const actor = await this.authorized(credential, 'manage');
    requireText(input.id, 'def id', 1, 60);
    if (!this.workforce) throw new CompanyError('temporarily_unavailable', 'Workforce writer is not wired into this process', true);
    // upsertDef owns validation (id/provider shape, role enum, weight range) and the write;
    // tracks [] clears the list, undefined keeps it; enabled=false retires the def.
    await this.workforce.upsertDef(input.id, input);
    await this.auditManage(actor, 'def_ensure', { def: input.id, role: input.role, provider: input.provider,
      model: input.model, thinking: input.thinking, tracks: input.tracks, maxInstances: input.maxInstances,
      priority: input.priority, weight: input.weight, enabled: input.enabled });
    const def = (await this.workforce.defs()).find(d => d.id === input.id);
    if (!def) throw new CompanyError('conflict', 'Definition write did not land');
    return SurrealCompanyCore.defView(def);
  }

  async updateProjectDisciplines(credential: Credential, input: { project: string; disciplines: Array<{ name: string; description?: string }> }): Promise<ProjectView> {
    const actor = await this.authorized(credential, 'manage');
    // Only the vocabulary field is rewritten; every other project field is untouched.
    const view = await this.projects.setDisciplines(input.project, input.disciplines);
    await this.auditManage(actor, 'project_disciplines_update',
      { project: input.project, disciplines: (input.disciplines ?? []).map(d => d?.name) });
    return view;
  }

  async opsScope(credential: Credential, taskId: TaskId): Promise<OpsScope> {
    const actor = await this.authorized(credential);
    requireText(taskId, 'task', 1, 200);
    const [rows] = await this.db.query<[Array<{ current_employee?: string; state: TaskState; lease_expires_at?: number; project?: RecordId }>]>(
      'SELECT current_employee, state, lease_expires_at, goal.project AS project FROM $task;', { task: id('task', taskId) });
    const task = rows[0];
    if (!task) throw new CompanyError('not_found', 'Task not found');
    if (task.current_employee !== actor.employeeId || !['doing', 'review'].includes(task.state) ||
      (task.lease_expires_at ?? 0) <= Date.now() / 1000) {
      throw new CompanyError('forbidden', 'Ops tools are only available to the current lease holder of the task');
    }
    if (!task.project) throw new CompanyError('invalid', 'Task goal has no project environment');
    return { actor, taskId, project: String(task.project.id) };
  }

  async auditOps(scope: OpsScope, action: string, evidence: string): Promise<void> {
    if (!/^ops_[a-z_]{1,40}$/.test(action)) throw new CompanyError('invalid', 'Invalid ops audit action');
    await this.db.query('CREATE audit CONTENT { task: $task, actor: $actor, action: $action, evidence: $evidence, at: time::now() };',
      { task: id('task', scope.taskId), actor: id('employee', scope.actor.employeeId), action, evidence: evidence.slice(0, OPS_EVIDENCE_CHARS) });
  }

  async opsCount(project: string, action: string, windowSeconds: number): Promise<number> {
    const [rows] = await this.db.query<[Array<{ n: number }>]>(
      'SELECT count() AS n FROM audit WHERE action = $action AND at > time::now() - <duration>$window AND task.goal.project = $project GROUP ALL;',
      { action, project: id('project', project), window: `${Math.max(1, Math.floor(windowSeconds))}s` });
    return rows[0]?.n ?? 0;
  }

  async relayOwnerDecision(credential: Credential, input: OwnerDecisionInput & { ownerQuote: string }): Promise<TaskView> {
    const source = await this.relayActor(credential, input.ownerQuote);
    return this.owner.decide({ ...input, source, key: `${source}:${input.idempotencyKey}`,
      note: `${input.note}\n老板原话：${input.ownerQuote}` });
  }

  async relayDirection(credential: Credential, input: { text: string; ownerQuote: string; idempotencyKey: string }): Promise<void> {
    const source = await this.relayActor(credential, input.ownerQuote);
    await this.owner.addDirection({ text: input.text, source, key: `${source}:${input.idempotencyKey}` });
  }

  private async transition(
    credential: Credential, proof: LeaseProof, action: 'heartbeat' | 'checkpoint' | 'submit' | 'accept' | 'return' | 'block',
    evidence?: Evidence, to?: 'gm' | 'owner'
  ): Promise<TaskView> {
    const actor = await this.authorized(credential);
    if (!Number.isSafeInteger(proof.expectedVersion) || !Number.isSafeInteger(proof.fence) || proof.fence < 1) {
      throw new CompanyError('invalid', 'Invalid lease proof');
    }
    if (evidence) requireText(evidence.text, 'evidence', 20, 30000);
    const idem = evidence ? this.idemId(actor.employeeId, action, evidence.idempotencyKey) : undefined;
    const digest = evidence ? HASH(JSON.stringify({ proof, evidence, to })) : undefined;
    if (idem && digest) {
      const prior = await this.replay(idem, digest);
      if (prior) return prior;
    }
    const flags = {
      heartbeat: action === 'heartbeat', checkpoint: action === 'checkpoint',
      submit: action === 'submit', accept: action === 'accept', returning: action === 'return',
      block: action === 'block',
    };
    const actionRole = action === 'accept' || action === 'return' ? 'review' : 'execute';
    const query = `BEGIN;
      LET $now = time::unix(time::now());
      LET $who = SELECT * FROM ONLY $actor;
      LET $t = SELECT * FROM ONLY $task;
      IF $who = NONE OR $who.revoked = true OR $t = NONE { THROW 'not found or revoked' };
      IF $t.state = 'void' { THROW 'task retired' };
      IF $t.lease_expires_at <= $now { THROW 'lease expired' };
      IF $t.current_employee != $employee OR $t.delivery_id != $delivery OR $t.fence != $fence OR $t.version != $expected { THROW 'stale lease or version' };
      IF $submit OR (($heartbeat OR $checkpoint) AND $t.state != 'review') {
        IF 'execute' NOT IN $who.capabilities OR $t.state != 'doing' OR $t.executor_role != $who.role { THROW 'execute denied' };
      };
      IF ($heartbeat OR $checkpoint) AND $t.state = 'review' {
        IF $t.submitted_by = $employee { THROW 'self review denied' };
        IF 'review' NOT IN $who.capabilities OR $t.reviewer_role != $who.role { THROW 'review denied' };
      };
      IF $accept OR $returning {
        IF $t.submitted_by = $employee { THROW 'self review denied' };
        IF 'review' NOT IN $who.capabilities OR $t.state != 'review' OR $t.reviewer_role != $who.role { THROW 'review denied' };
      };
      IF $block {
        IF $t.state = 'review' {
          IF $t.submitted_by = $employee { THROW 'self review denied' };
          IF 'review' NOT IN $who.capabilities OR $t.reviewer_role != $who.role { THROW 'block denied' };
        } ELSE {
          IF 'execute' NOT IN $who.capabilities OR $t.state != 'doing' OR $t.executor_role != $who.role { THROW 'block denied' };
        };
      };
      IF $checkpoint AND $checkpoint_limit > 0 {
        LET $cpn = SELECT VALUE count() FROM audit WHERE task = $task AND action = 'checkpoint' AND actor = $actor GROUP ALL;
        IF ($cpn[0] ?? 0) >= $checkpoint_limit { THROW 'checkpoint limit reached' };
      };
      LET $next = UPDATE ONLY $task SET
        state = IF $submit { 'review' } ELSE IF $accept { 'done' } ELSE IF $returning { 'ready' } ELSE IF $block { 'blocked' } ELSE { $t.state },
        submitted_by = IF $submit THEN $employee ELSE $t.submitted_by END,
        current_employee = IF $heartbeat OR $checkpoint THEN $employee ELSE NONE END,
        delivery_id = IF $heartbeat OR $checkpoint THEN $delivery ELSE NONE END,
        lease_expires_at = IF $heartbeat OR $checkpoint THEN $now + $lease_seconds ELSE NONE END,
        resume_role = IF $block THEN $who.role ELSE $t.resume_role END,
        resume_state = IF $block THEN $t.state ELSE $t.resume_state END,
        blocked_to = IF $block THEN $to ELSE $t.blocked_to END,
        progress_at = IF $checkpoint THEN $now ELSE $t.progress_at END,
        handover = IF $heartbeat OR $checkpoint THEN $t.handover ELSE NONE END,
        previous_employee = IF $heartbeat OR $checkpoint THEN $t.previous_employee ELSE NONE END,
        accepted_by = IF $accept THEN $employee ELSE $t.accepted_by END,
        version = IF $heartbeat THEN $t.version ELSE $t.version + 1 END
        RETURN AFTER;
      IF !$heartbeat AND !$checkpoint { UPDATE ONLY $actor SET active_task = NONE };
      IF $accept {
        ${UNLOCK_SQL}
      };
      IF !$heartbeat {
        CREATE ONLY $audit CONTENT { task: $task, actor: $actor, action: $action, evidence: $evidence, version: $next.version, at: time::now() };
        LET $sequence = UPDATE ONLY company_meta:outbox_counter SET value += 1 RETURN AFTER;
        CREATE ONLY $outbox CONTENT { task: $task, kind: $action, sequence: $sequence.value, payload: { version: $next.version, state: $next.state }, at: time::now() };
      };
      ${idem ? 'CREATE ONLY $idem CONTENT { payload_digest: $digest, result: $next };' : ''}
      RETURN $next;
      COMMIT;`;
    try {
      const row = await this.txTask(query, {
        actor: id('employee', actor.employeeId), employee: actor.employeeId,
        task: id('task', proof.taskId), delivery: proof.deliveryId,
        fence: proof.fence, expected: proof.expectedVersion, lease_seconds: this.leaseSeconds,
        ...flags, action, evidence: evidence?.text ?? '', to: to ?? '', checkpoint_limit: this.checkpointLimit,
        audit: id('audit', randomUUID()), outbox: id('outbox', randomUUID()), idem, digest,
      });
      return view(row);
    } catch (error) {
      if (idem && digest) {
        const prior = await this.replay(idem, digest);
        if (prior) return prior;
      }
      throw error;
    }
  }

  async heartbeat(credential: Credential, proof: LeaseProof): Promise<ClaimResult> {
    const task = await this.transition(credential, proof, 'heartbeat');
    return { task, deliveryId: task.deliveryId!, fence: task.fence, leaseExpiresAt: task.leaseExpiresAt!, history: [] };
  }
  checkpoint(credential: Credential, proof: LeaseProof, evidence: Evidence) { return this.transition(credential, proof, 'checkpoint', evidence); }
  submit(credential: Credential, proof: LeaseProof, evidence: Evidence) { return this.transition(credential, proof, 'submit', evidence); }
  async accept(credential: Credential, proof: LeaseProof, evidence: Evidence) {
    const task = await this.transition(credential, proof, 'accept', evidence);
    // Event-triggered reclaim: exclusive scenes without effective refs are removed under the repo lock.
    // Failures stay in durable audit and the periodic sweep retries; never block accept on reclaim.
    if (task.state === 'done' && this.worktrees) {
      await this.worktrees.reclaimAfterTerminal(task, 'accept').catch(() => undefined);
    }
    return task;
  }
  returnTask(credential: Credential, proof: LeaseProof, evidence: Evidence) { return this.transition(credential, proof, 'return', evidence); }
  block(credential: Credential, proof: LeaseProof, to: 'gm' | 'owner', evidence: Evidence) { return this.transition(credential, proof, 'block', evidence, to); }

  /** GM: run ownership reclaim (or dry-run) across registered repos. Uses the same lock and audit path as the dispatcher sweep. */
  async reclaimWorktrees(credential: Credential, input?: { dryRun?: boolean; repos?: string[] }) {
    const actor = await this.authorized(credential);
    if (actor.role !== 'gm') throw new CompanyError('forbidden', 'Worktree reclaim requires gm');
    if (!this.worktrees) return { scanId: '', removed: [], kept: [], branchesDeleted: [], branchesRetained: [], audited: 0 };
    return this.worktrees.reclaimAll({ trigger: input?.dryRun ? 'dry_run' : 'manual', dryRun: input?.dryRun, repos: input?.repos });
  }

  async listWorktreeAudits(credential: Credential, limit = 100) {
    const actor = await this.authorized(credential);
    if (actor.role !== 'gm') throw new CompanyError('forbidden', 'Worktree audit query requires gm');
    return this.worktrees?.listAudits(limit) ?? [];
  }

  async resume(credential: Credential, taskId: TaskId, evidence: Evidence): Promise<TaskView> {
    const actor = await this.authorized(credential, 'manage');
    if (actor.role !== 'gm') throw new CompanyError('forbidden', 'Only gm can resume');
    requireText(evidence.text, 'evidence', 20, 30000);
    const idem = this.idemId(actor.employeeId, 'resume', evidence.idempotencyKey);
    const digest = HASH(JSON.stringify({ taskId, evidence }));
    const replay = await this.replay(idem, digest);
    if (replay) return replay;
    try {
      const row = await this.txTask(`BEGIN;
        LET $who = SELECT * FROM ONLY $actor;
        LET $t = SELECT * FROM ONLY $task;
        IF $who.revoked = true OR $who.role != 'gm' OR $t = NONE OR $t.state != 'blocked' { THROW 'resume denied' };
        LET $remaining = SELECT * FROM task WHERE id IN $t.dependencies AND ${depUnsatisfiedFor('$t')};
        LET $next = UPDATE ONLY $task SET
          state = IF array::len($remaining) = 0 THEN (IF $t.resume_state = 'doing' THEN 'ready' ELSE $t.resume_state END) ELSE 'blocked' END,
          resume_role = NONE, resume_state = NONE, blocked_to = NONE, version = $t.version + 1 RETURN AFTER;
        CREATE ONLY $audit CONTENT { task: $task, actor: $actor, action: 'resume', evidence: $evidence, version: $next.version, at: time::now() };
        LET $sequence = UPDATE ONLY company_meta:outbox_counter SET value += 1 RETURN AFTER;
        CREATE ONLY $outbox CONTENT { task: $task, kind: 'resumed', sequence: $sequence.value, payload: { state: $next.state }, at: time::now() };
        CREATE ONLY $idem CONTENT { payload_digest: $digest, result: $next };
        RETURN $next;
        COMMIT;`, {
        actor: id('employee', actor.employeeId), task: id('task', taskId), evidence: evidence.text,
        idem, digest, audit: id('audit', randomUUID()), outbox: id('outbox', randomUUID()),
      });
      return view(row);
    } catch (error) {
      const replayed = await this.replay(idem, digest);
      if (replayed) return replayed;
      throw error;
    }
  }

  /**
   * gm only: re-point an execute-phase gm block at the dependency graph. The task keeps
   * state 'blocked' — it never re-enters the dispatcher's gm-attention loop or the work
   * queues — but `blocked_to` clears, which is exactly what UNLOCK_SQL needs to flip it
   * 'ready' the moment the last dependency finishes. Owner gates, review blocks, live
   * leases and closed goals are refused, not guessed; with every dependency already done
   * the task resumes immediately under the same safe execute semantics as resume.
   */
  async deferTaskUntil(credential: Credential, input: DeferTaskUntil): Promise<TaskView> {
    const actor = await this.authorized(credential, 'manage');
    if (actor.role !== 'gm') throw new CompanyError('forbidden', 'Only gm may defer blocked tasks');
    requireText(input.taskId, 'task', 1, 200);
    requireText(input.text, 'text', 20, 8000);
    requireText(input.idempotencyKey, 'idempotencyKey', 1, 200);
    if (input.expectedVersion !== undefined && !Number.isSafeInteger(input.expectedVersion)) {
      throw new CompanyError('invalid', 'Invalid expectedVersion');
    }
    const dependencies = [...new Set(input.dependencies ?? [])];
    if (!dependencies.length || dependencies.length > 20) {
      throw new CompanyError('invalid', 'defer requires 1-20 dependencies');
    }
    if (dependencies.includes(input.taskId)) throw new CompanyError('invalid', 'A task cannot wait on itself');
    const idem = this.idemId(actor.employeeId, 'defer', input.idempotencyKey);
    const digest = HASH(JSON.stringify({ taskId: input.taskId, dependencies, text: input.text, expectedVersion: input.expectedVersion }));
    const replayed = await this.replay(idem, digest);
    if (replayed) return replayed;

    // Query results may carry record ids as `task:⟨uuid⟩` (the fork's escaped rendering):
    // strip the quoting so client-side uuids compare equal against server-side ids.
    const norm = (value: unknown): string => {
      const raw = value instanceof RecordId ? String(value.id) : asId(value);
      return raw.startsWith('⟨') && raw.endsWith('⟩') ? raw.slice(1, -1) : raw;
    };
    const depIds = dependencies.map(dep => id('task', dep));
    const taskRef = id('task', input.taskId);

    // Fast-fail with a readable reason plus the audit snapshot; the transaction re-checks
    // every guard atomically, so a stale pre-read can never turn into a wrong write.
    type DeferredRow = {
      state: TaskState; blocked_to?: 'gm' | 'owner'; resume_state?: TaskState; current_employee?: string;
      lease_expires_at?: number; version: number; dependencies?: RecordId[]; goal?: RecordId; goal_state?: string;
    };
    // `FROM ONLY` yields the record itself (or NONE), not a list.
    const [before] = await this.db.query<[DeferredRow | undefined]>('SELECT state, blocked_to, resume_state, current_employee, lease_expires_at, version, dependencies, goal, goal.state AS goal_state FROM ONLY $task;',
      { task: taskRef });
    if (!before) throw new CompanyError('not_found', 'Task not found');
    if (before.state !== 'blocked' || before.blocked_to !== 'gm' || !['doing', 'ready'].includes(before.resume_state ?? '')) {
      throw new CompanyError('invalid', 'defer only applies to gm-blocked execute-phase tasks');
    }
    if (before.goal && before.goal_state !== 'active') throw new CompanyError('invalid', 'Task goal is not active');
    if (input.expectedVersion !== undefined && before.version !== input.expectedVersion) {
      throw new CompanyError('conflict', 'Task version moved');
    }
    const beforeDeps = (before.dependencies ?? []).map(norm);
    const after = [...new Set([...beforeDeps, ...dependencies])];
    const phase = before.resume_state ?? 'ready';
    const evidence = `${input.text}\n[defer] 依赖 before=[${beforeDeps.join(', ')}] after=[${after.join(', ')}] 恢复阶段=${phase}`;

    const [depRows] = await this.db.query<[Array<{ id: RecordId; goal?: RecordId }>]>(
      'SELECT id, goal FROM task WHERE id IN $ids;', { ids: depIds });
    const depById = new Map((depRows ?? []).map(row => [norm(row.id), row]));
    for (const dep of dependencies) {
      const row = depById.get(dep);
      if (!row) throw new CompanyError('not_found', `Dependency not found: ${dep}`);
      // norm maps a missing goal to '' on both sides, so goal-less tasks pair with goal-less deps.
      if (norm(row.goal) !== norm(before.goal)) {
        throw new CompanyError('invalid', 'Dependencies must live in the same goal as the task');
      }
    }
    // The deferred task must not be reachable from its own new dependencies: walk the
    // dependency closure of the proposed deps and refuse a path back to the task.
    const seen = new Set(dependencies);
    let frontier = [...dependencies];
    for (let depth = 0; frontier.length && depth < 32; depth++) {
      const [closure] = await this.db.query<[Array<{ dependencies?: RecordId[] }>]>(
        'SELECT dependencies FROM task WHERE id IN $ids;', { ids: frontier.map(d => id('task', d)) });
      const next = [...new Set((closure ?? []).flatMap(row => (row.dependencies ?? []).map(norm)))].filter(d => !seen.has(d));
      if (next.includes(input.taskId)) throw new CompanyError('invalid', 'Dependencies would create a cycle');
      for (const n of next) seen.add(n);
      frontier = next;
    }

    const row = await this.txTask(`BEGIN;
      LET $who = SELECT * FROM ONLY $actor;
      LET $t = SELECT * FROM ONLY $task;
      IF $who = NONE OR $who.revoked = true OR $who.role != 'gm' OR $t = NONE { THROW 'defer denied' };
      IF $t.state != 'blocked' OR $t.blocked_to != 'gm' OR $t.resume_state NOT IN ['doing', 'ready'] { THROW 'defer denied: only execute-phase gm blocks can wait on dependencies' };
      IF $t.current_employee != NONE AND $t.lease_expires_at > time::unix(time::now()) { THROW 'defer denied: the task still holds an active lease' };
      LET $g = SELECT * FROM ONLY $t.goal;
      IF $g != NONE AND $g.state != 'active' { THROW 'goal is closed' };
      IF $expected != NONE AND $t.version != $expected { THROW 'task version moved' };
      FOR $dep IN $dependencies {
        LET $d = SELECT * FROM ONLY $dep;
        IF $d = NONE OR $d.goal != $t.goal { THROW 'defer denied: dependency missing or outside the task goal' };
      };
      LET $merged = array::distinct(array::concat($t.dependencies ?? [], $dependencies));
      LET $remaining = SELECT VALUE id FROM task WHERE id IN $merged AND ${depUnsatisfiedFor('$t')};
      LET $next = UPDATE ONLY $task SET
        dependencies = $merged,
        state = IF array::len($remaining) = 0 THEN 'ready' ELSE 'blocked' END,
        blocked_to = NONE, resume_role = NONE, resume_state = NONE,
        current_employee = NONE, delivery_id = NONE, lease_expires_at = NONE,
        version = $t.version + 1 RETURN AFTER;
      CREATE ONLY $audit CONTENT { task: $task, actor: $actor, action: 'deferred', evidence: $evidence, version: $next.version, at: time::now() };
      LET $sequence = UPDATE ONLY company_meta:outbox_counter SET value += 1 RETURN AFTER;
      CREATE ONLY $outbox CONTENT { task: $task, kind: 'deferred', sequence: $sequence.value, payload: { state: $next.state, added: $added }, at: time::now() };
      CREATE ONLY $idem CONTENT { payload_digest: $digest, result: $next };
      RETURN $next;
      COMMIT;`, {
      actor: id('employee', actor.employeeId), task: taskRef, expected: input.expectedVersion,
      dependencies: depIds, evidence, added: dependencies.filter(dep => !beforeDeps.includes(dep)).length,
      idem, digest, audit: id('audit', randomUUID()), outbox: id('outbox', randomUUID()),
    });
    return view(row);
  }

  /**
   * gm/product only: retire a task to the terminal 'void' state. Duplicate or obsolete work
   * (e.g. two managers decomposing the same goal into parallel chains) stops occupying the
   * graph: any live lease is released, the holder's active_task clears, and blocked
   * dependents re-evaluate with 'void' counted as satisfied, so a chain waiting only on the
   * retired task unlocks in the same transaction. Retiring an already-void task is a no-op
   * returning the current view; 'done' tasks refuse (their audit trail stands).
   */
  async retireTask(credential: Credential, input: RetireTask): Promise<TaskView> {
    const actor = await this.authorized(credential, 'manage');
    if (!['gm', 'product'].includes(actor.role)) throw new CompanyError('forbidden', 'Only gm or product may retire tasks');
    requireText(input.taskId, 'task', 1, 200);
    requireText(input.text, 'text', 4, 8000);
    requireText(input.idempotencyKey, 'idempotencyKey', 1, 200);
    if (input.expectedVersion !== undefined && !Number.isSafeInteger(input.expectedVersion)) {
      throw new CompanyError('invalid', 'Invalid expectedVersion');
    }
    const idem = this.idemId(actor.employeeId, 'retire', input.idempotencyKey);
    const digest = HASH(JSON.stringify({ taskId: input.taskId, text: input.text, expectedVersion: input.expectedVersion }));
    const replayed = await this.replay(idem, digest);
    if (replayed) return replayed;

    // Pre-read for a readable fast-fail and the audit snapshot; the transaction re-checks
    // every guard atomically, so a stale pre-read can never turn into a wrong write.
    const before = await this.db.select<TaskRow>(id('task', input.taskId));
    if (!before) throw new CompanyError('not_found', 'Task not found');
    if (before.state === 'done') throw new CompanyError('conflict', 'Cannot retire a finished task');
    if (input.expectedVersion !== undefined && before.version !== input.expectedVersion) {
      throw new CompanyError('conflict', 'Task version moved');
    }
    if (before.state === 'void') return view(before); // already terminal, idempotent no-op
    if (before.reviewer_role === 'owner') {
      // Goal anchors are rollup bookkeeping; they never block retiring the gate itself.
      const [liveDependents] = await this.db.query<[RecordId[]]>(
        'SELECT VALUE id FROM task WHERE $task IN dependencies AND state NOT IN [$done, $void] AND (goal = NONE OR id NOT IN (goal.anchors ?? []));',
        { task: id('task', input.taskId), done: 'done', void: 'void' });
      if (liveDependents.length > 0) {
        throw new CompanyError('conflict', 'Owner-gated task has live dependents; retire them first');
      }
    }

    const evidence = `${input.text}\n[retire] 作废前 state=${before.state}` +
      ` blocked_to=${before.blocked_to ?? '-'} holder=${before.current_employee ?? '-'} version=${before.version}`;

    let row: TaskRow;
    try {
      row = await this.txTask(`BEGIN;
      LET $who = SELECT * FROM ONLY $actor;
      LET $t = SELECT * FROM ONLY $task;
      IF $who = NONE OR $who.revoked = true OR 'manage' NOT IN $who.capabilities OR $who.role NOT IN ['gm', 'product'] { THROW 'retire denied' };
      IF $t = NONE { THROW 'task not found' };
      IF $t.state IN ['done', 'void'] { THROW 'task already terminal' };
      IF $expected != NONE AND $t.version != $expected { THROW 'task version moved' };
      IF $t.reviewer_role = 'owner' {
        LET $live_dependents = SELECT VALUE id FROM task WHERE $task IN dependencies AND state NOT IN ['done', 'void'] AND (goal = NONE OR id NOT IN (goal.anchors ?? []));
        IF array::len($live_dependents) > 0 { THROW 'retire refused: live owner-gate dependents' };
      };
      LET $next = UPDATE ONLY $task SET
        state = 'void', blocked_to = NONE, resume_role = NONE, resume_state = NONE,
        current_employee = NONE, delivery_id = NONE, lease_expires_at = NONE,
        version = $t.version + 1 RETURN AFTER;
      UPDATE employee SET active_task = NONE WHERE active_task = $task;
      ${UNLOCK_CHILDREN_SQL}
      CREATE ONLY $audit CONTENT { task: $task, actor: $actor, action: 'retire', evidence: $evidence, version: $next.version, at: time::now() };
      LET $sequence = UPDATE ONLY company_meta:outbox_counter SET value += 1 RETURN AFTER;
      CREATE ONLY $outbox CONTENT { task: $task, kind: 'retired', sequence: $sequence.value, payload: { state: 'void', retired_holder: $holder }, at: time::now() };
      CREATE ONLY $idem CONTENT { payload_digest: $digest, result: $next };
      RETURN $next;
      COMMIT;`, {
        actor: id('employee', actor.employeeId), task: id('task', input.taskId),
        expected: input.expectedVersion, evidence, holder: before.current_employee,
        idem, digest, audit: id('audit', randomUUID()), outbox: id('outbox', randomUUID()),
      });
    } catch (error) {
      const replayed = await this.replay(idem, digest);
      if (replayed) return replayed;
      throw error;
    }
    const retired = view(row);
    // Event-triggered reclaim: 'void' is terminal like 'done' — the scene's refs release and the
    // same three-layer teardown applies under the repo lock. Never block the retire on reclaim.
    if (this.worktrees) await this.worktrees.reclaimAfterTerminal(retired, 'retire').catch(() => undefined);
    return retired;
  }

  /**
   * eval role only: scores the employees who participated in a finished task.
   * Scorecards are idempotent per (task, employee); writing marks task.evaluated_at so the
   * dispatcher stops dispatching judges, and rolls the average into employee and employee_def.
   */
  async recordScore(credential: Credential, input: { taskId: TaskId; summary: string; scores: EmployeeScore[] }): Promise<{ recorded: number; participants: string[] }> {
    const actor = await this.authorized(credential);
    if (actor.role !== 'eval') throw new CompanyError('forbidden', 'Only eval employees may record scores');
    requireText(input.summary, 'summary', 1, 20000);
    if (!Array.isArray(input.scores) || input.scores.length > 50) throw new CompanyError('invalid', 'Invalid scores');
    const row = await this.db.select<TaskRow>(id('task', input.taskId));
    if (!row) throw new CompanyError('not_found', 'Task not found');
    if (row.state !== 'done') throw new CompanyError('conflict', 'Task is not finished');
    // Response timeouts can cut the reply after writes landed; retries must not
    // duplicate the evaluated audit/outbox events (scorecards themselves upsert).
    if (row.evaluated_at) return { recorded: 0, participants: [] };

    const state = await collectEvalState(this.db, input.taskId, actor.employeeId);
    const invalid = validateScores(state, input.scores);
    if (invalid) throw new CompanyError('invalid', invalid);
    for (const s of input.scores) if (s.notes !== undefined) requireText(s.notes, 'notes', 0, 4000);

    return writeScorecards(this.db, {
      taskId: input.taskId, summary: input.summary, judge: actor.employeeId, judgeKind: 'llm',
      scores: input.scores, state,
    });
  }

  async listOutbox(credential: Credential, after?: string): Promise<OutboxEvent[]> {
    const actor = await this.authorized(credential, 'manage');
    if (actor.role !== 'gm') throw new CompanyError('forbidden', 'Outbox access denied');
    type Row = { id: RecordId; sequence: number; kind: string; task: RecordId; payload: Record<string, unknown>; at: Date };
    let rows: Row[];
    if (after) {
      const cursor = await this.db.select<Row>(id('outbox', after));
      if (!cursor) throw new CompanyError('not_found', 'Outbox cursor not found');
      [rows] = await this.db.query<[Row[]]>(
        'SELECT * FROM outbox WHERE sequence > $sequence ORDER BY sequence LIMIT 1000;',
        { sequence: cursor.sequence }
      );
    } else {
      [rows] = await this.db.query<[Row[]]>('SELECT * FROM outbox ORDER BY sequence LIMIT 1000;');
    }
    return rows.map(row => ({ id: asId(row.id), sequence: row.sequence, kind: row.kind, taskId: asId(row.task),
      payload: row.payload, createdAt: String(row.at) }));
  }
}
