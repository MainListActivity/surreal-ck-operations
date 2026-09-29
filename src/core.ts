import { createHash, randomUUID } from 'node:crypto';
import { RecordId } from 'surrealdb';
import type { CompanyDatabase } from './database.ts';
import type { ClaimResult, CompanyBrief, CompanyCore, CreateDelivery, CreateTask, Credential, GoalTier, ProjectView, EmployeeScore, Evidence, GoalView, HistoryEntry, LeaseProof, OutboxEvent, OwnerDecisionInput, Principal, ReviewerRole, Role, TaskId, TaskKind, TaskState, TaskView } from './contracts.ts';
import { OwnerDesk } from './owner.ts';
import { deliveryChain } from './flows.ts';
import { loadSecretKey, ProjectStore } from './projects.ts';
import { collectEvalState, validateScores, writeScorecards } from './scoring.ts';

import { CompanyError } from './core-errors.ts';
export { CompanyError };

export const ROLES: readonly Role[] = ['gm', 'product', 'engineering', 'ai-content', 'qa', 'cs', 'eval'];
const DEFAULT_LEASE_SECONDS = 600;
const HISTORY_LIMIT = 40;
const HISTORY_EVIDENCE_CHARS = 6000;
export const HASH = (value: string) => createHash('sha256').update(value).digest('hex');
export const id = (table: string, value: string) => new RecordId(table, value);
export const asId = (value: unknown): string => value instanceof RecordId ? String(value.id) : String(value).split(':').slice(1).join(':');

/**
 * Unlocks blocked children of $task whose dependencies are all done, and closes the goal
 * when its final owner acceptance gate is done. Requires $task and $actor in scope.
 */
export const UNLOCK_SQL = `
  LET $children = SELECT * FROM task WHERE state = 'blocked' AND blocked_to = NONE AND $task IN dependencies;
  FOR $child IN $children {
    LET $remaining = SELECT * FROM task WHERE id IN $child.dependencies AND state != 'done';
    IF array::len($remaining) = 0 {
      LET $unlocked = UPDATE ONLY $child.id SET state = 'ready', version += 1, resume_state = NONE;
      CREATE audit CONTENT { task: $child.id, actor: $actor, action: 'dependency_unlocked', version: $unlocked.version, at: time::now() };
      LET $sequence = UPDATE ONLY company_meta:outbox_counter SET value += 1 RETURN AFTER;
      CREATE outbox CONTENT { task: $child.id, kind: 'dependency_unlocked', sequence: $sequence.value, payload: { state: 'ready' }, at: time::now() };
    };
  };
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
    LET $open = array::filter($g.anchors, |$a| $a.state != 'done');
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
  active_task?: RecordId;
}

interface TaskRow {
  id: RecordId;
  title: string;
  context: string;
  state: TaskState;
  executor_role: Role;
  reviewer_role: Role;
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
}

export interface IdempotencyRow { payload_digest: string; result: TaskRow }
export type { TaskRow };

export function view(row: TaskRow): TaskView {
  return {
    id: asId(row.id), title: row.title, context: row.context, state: row.state,
    executorRole: row.executor_role, reviewerRole: row.reviewer_role,
    kind: row.kind ?? 'task', goalId: row.goal ? asId(row.goal) : undefined,
    dependencies: (row.dependencies ?? []).map(asId), version: row.version,
    submittedBy: row.submitted_by, currentEmployee: row.current_employee,
    deliveryId: row.delivery_id,
    leaseExpiresAt: row.lease_expires_at ? new Date(row.lease_expires_at * 1000).toISOString() : undefined,
    fence: row.fence,
    blockedTo: row.blocked_to,
    handover: row.handover || undefined,
    previousEmployee: row.previous_employee,
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
  constructor(readonly database: CompanyDatabase, options?: { leaseSeconds?: number }) {
    const seconds = options?.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3600) {
      throw new CompanyError('invalid', 'Invalid lease duration');
    }
    this.leaseSeconds = seconds;
    this.owner = new OwnerDesk(database);
    this.projects = new ProjectStore(database.db);
  }
  private readonly owner: OwnerDesk;
  private readonly projects: ProjectStore;
  private get db() { return this.database.db; }

  async authenticate(credential: Credential): Promise<Principal> {
    if (typeof credential !== 'string' || !credential.startsWith('sck_') || credential.length > 200) {
      throw new CompanyError('unauthorized', 'Invalid credential');
    }
    const [rows] = await this.db.query<[EmployeeRow[]]>(
      'SELECT * FROM employee WHERE credential_digest = $digest LIMIT 1;', { digest: HASH(credential) }
    );
    const row = rows?.[0];
    if (!row || row.revoked || !(await Bun.password.verify(credential, row.credential_hash))) {
      throw new CompanyError('unauthorized', 'Invalid credential');
    }
    return { employeeId: asId(row.id), role: row.role, capabilities: row.capabilities };
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
          if (/leased by another|already has active task/i.test(cause)) throw new CompanyError('already_claimed', 'Task or employee already leased');
          if (/lease expired/i.test(cause)) throw new CompanyError('lease_expired', 'Lease expired');
          if (/denied|forbidden|revoked/i.test(cause)) throw new CompanyError('forbidden', 'Action forbidden');
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
    if (input.executorRole === 'eval' || input.reviewerRole === 'eval') {
      throw new CompanyError('invalid', 'eval is a workforce-only role and cannot take tasks');
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
    };
    try {
      const row = await this.txTask(`BEGIN;
        LET $who = SELECT * FROM ONLY $actor;
        IF $who.revoked = true OR 'manage' NOT IN $who.capabilities OR $who.role NOT IN ['gm', 'product'] { THROW 'actor revoked or forbidden' };
        FOR $dep IN $dependencies {
          LET $d = SELECT * FROM ONLY $dep;
          IF $d = NONE { THROW 'dependency not found' };
        };
        LET $created = CREATE ONLY $task CONTENT {
          title: $title, context: $context, executor_role: $executor, reviewer_role: $reviewer,
          dependencies: $dependencies, state: IF array::len($dependencies) = 0 THEN 'ready' ELSE 'blocked' END,
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
    const task = id('task', taskId);
    const row = await this.txTask(`BEGIN;
      LET $now = time::unix(time::now());
      LET $who = SELECT * FROM ONLY $actor;
      LET $t = SELECT * FROM ONLY $task;
      IF $who = NONE OR $who.revoked = true OR $t = NONE { THROW 'not found or revoked' };
      IF $t.state NOT IN ['ready', 'review', 'doing'] { THROW 'task not claimable' };
      IF $t.state = 'review' {
        IF $t.submitted_by = $employee { THROW 'self review denied' };
        IF 'review' NOT IN $who.capabilities OR $t.reviewer_role != $who.role { THROW 'review denied' };
      } ELSE {
        IF 'execute' NOT IN $who.capabilities OR $t.executor_role != $who.role { THROW 'execute denied' };
      };
      IF $t.current_employee != NONE AND $t.lease_expires_at > $now AND $t.current_employee != $employee { THROW 'leased by another employee' };
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
        version = IF $same THEN $t.version ELSE $t.version + 1 END
        RETURN AFTER;
      UPDATE ONLY $actor SET active_task = $task;
      IF !$same {
        CREATE ONLY $audit CONTENT { task: $task, actor: $actor, action: 'claim', version: $next.version, at: time::now() };
        LET $sequence = UPDATE ONLY company_meta:outbox_counter SET value += 1 RETURN AFTER;
        CREATE ONLY $outbox CONTENT { task: $task, kind: 'claimed', sequence: $sequence.value, payload: { employee: $employee, fence: $next.fence }, at: time::now() };
      };
      RETURN $next;
      COMMIT;`, {
      actor: id('employee', actor.employeeId), employee: actor.employeeId, task,
      delivery: randomUUID(), lease_seconds: this.leaseSeconds,
      audit: id('audit', randomUUID()), outbox: id('outbox', randomUUID()),
    });
    const taskView = view(row);
    return { task: taskView, deliveryId: taskView.deliveryId!, fence: taskView.fence,
      leaseExpiresAt: taskView.leaseExpiresAt!, history: await this.readHistory(taskId),
      project: await this.taskProject(taskId) };
  }

  private async taskProject(taskId: TaskId): Promise<ProjectView | undefined> {
    const [rows] = await this.db.query<[Array<{ project?: RecordId }>]>(
      'SELECT goal.project AS project FROM $task;', { task: id('task', taskId) });
    const project = rows[0]?.project;
    return project ? this.projects.get(String(project.id)) : undefined;
  }

  private async readHistory(taskId: TaskId): Promise<HistoryEntry[]> {
    type Row = { action: string; actor: unknown; evidence?: string; version?: number; at: unknown };
    const [rows] = await this.db.query<[Row[]]>(
      'SELECT action, actor, evidence, version, at FROM audit WHERE task = $task ORDER BY at DESC LIMIT $limit;',
      { task: id('task', taskId), limit: HISTORY_LIMIT }
    );
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
    const specs = deliveryChain(input.title, input.spec);
    const created: TaskView[] = [];
    let dependencies = [...new Set(input.dependencies ?? [])];
    for (const [index, spec] of specs.entries()) {
      const task = await this.createTask(credential, {
        ...spec, goalId: input.goalId, dependencies, idempotencyKey: `${input.idempotencyKey}:delivery:${index}`,
      });
      created.push(task);
      dependencies = [task.id];
    }
    return created;
  }

  async putSecret(credential: Credential, input: { taskId: TaskId; env: string; name: string; value: string; roles?: Role[]; purpose?: string }): Promise<{ stored: string }> {
    const { actor, project } = await this.leaseProject(credential, input.taskId);
    if (actor.role === 'eval') throw new CompanyError('forbidden', 'eval may not store secrets');
    const roles = [...new Set(input.roles?.length ? input.roles : [actor.role, 'qa' as Role])];
    for (const role of roles) requireRole(role);
    await this.projects.setSecret({ project, env: input.env, name: input.name, value: input.value, roles, purpose: input.purpose }, loadSecretKey(true));
    await this.db.query("CREATE audit CONTENT { task: $task, actor: $actor, action: 'secret_write', evidence: $evidence, at: time::now() };",
      { task: id('task', input.taskId), actor: id('employee', actor.employeeId), evidence: `登记环境凭证 ${input.env}/${input.name}，可读岗位 ${roles.join(',')}（值不入库）` });
    return { stored: `${project}/${input.env}/${input.name}` };
  }

  private async leaseProject(credential: Credential, taskId: TaskId): Promise<{ actor: Principal; project: string }> {
    const actor = await this.authorized(credential);
    const [rows] = await this.db.query<[Array<{ current_employee?: string; state: TaskState; lease_expires_at?: number; project?: RecordId }>]>(
      'SELECT current_employee, state, lease_expires_at, goal.project AS project FROM $task;', { task: id('task', taskId) });
    const task = rows[0];
    if (!task) throw new CompanyError('not_found', 'Task not found');
    if (task.current_employee !== actor.employeeId || !['doing', 'review'].includes(task.state) ||
      (task.lease_expires_at ?? 0) <= Date.now() / 1000) {
      throw new CompanyError('forbidden', 'Secrets are only available to the current lease holder of the task');
    }
    if (!task.project) throw new CompanyError('invalid', 'Task goal has no project environment');
    return { actor, project: String(task.project.id) };
  }

  async getSecret(credential: Credential, input: { taskId: TaskId; env: string; name: string }): Promise<string> {
    const { actor, project } = await this.leaseProject(credential, input.taskId);
    const value = await this.projects.readSecret(project, input.env, input.name, actor.role, loadSecretKey());
    await this.db.query('CREATE audit CONTENT { task: $task, actor: $actor, action: \'secret_read\', evidence: $evidence, at: time::now() };',
      { task: id('task', input.taskId), actor: id('employee', actor.employeeId), evidence: `读取环境凭证 ${input.env}/${input.name}（值不入库）` });
    return value;
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
        ...flags, action, evidence: evidence?.text ?? '', to: to ?? '',
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
  accept(credential: Credential, proof: LeaseProof, evidence: Evidence) { return this.transition(credential, proof, 'accept', evidence); }
  returnTask(credential: Credential, proof: LeaseProof, evidence: Evidence) { return this.transition(credential, proof, 'return', evidence); }
  block(credential: Credential, proof: LeaseProof, to: 'gm' | 'owner', evidence: Evidence) { return this.transition(credential, proof, 'block', evidence, to); }

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
        LET $remaining = SELECT * FROM task WHERE id IN $t.dependencies AND state != 'done';
        LET $next = UPDATE ONLY $task SET
          state = IF array::len($remaining) = 0 THEN $t.resume_state ELSE 'blocked' END,
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
