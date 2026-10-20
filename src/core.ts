import { createHash, randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { RecordId } from 'surrealdb';
import type { CompanyDatabase } from './database.ts';
import type { ClaimResult, CompanyBrief, CompanyCore, CreateDelivery, CreateTask, Credential, DefView, DeferTaskUntil, EnsureDef, GoalAcceptancePreview, GoalAcceptanceRepair, GoalAcceptanceResult, GoalAcceptanceTask, GoalAcceptanceView, GoalTier, ProjectView, EmployeeScore, Evidence, GoalView, HistoryEntry, LeaseProof, OpsScope, OutboxEvent, ImplementerTakeover, OwnerDecisionInput, Principal, RetireTask, ReviewerRole, Role, SessionRef, TaskId, TaskKind, TaskState, TaskView } from './contracts.ts';
import { OwnerDesk } from './owner.ts';
import { deliveryChain } from './flows.ts';
import { assertRoleContract, loadContract, type DisciplineContract } from './role-contract.ts';
import type { SubmitCheck } from './pr-gate.ts';
import { ProjectStore } from './projects.ts';
import { collectEvalState, validateScores, writeScorecards } from './scoring.ts';
import type { EmployeeDef, Workforce } from './workforce.ts';
import { readContributors } from './contributors.ts';

import { CompanyError } from './core-errors.ts';
import { WorktreeRegistry, validateIntent, type RegistryOptions } from './dispatcher/worktree-registry.ts';
import type { WorkIntent, WorktreeAssignment, WorktreeView } from './contracts.ts';
import { ROLES } from './contracts.ts';
export { CompanyError };

export { ROLES };
/**
 * 岗位→必配轨常量表：executorRole 在表内的任务必须带指定 discipline——createTask
 * 缺轨/错轨显式拒绝；claim/dispatch 双端要求任务轨等于必配轨且编制 tracks 显式含该轨
 * （这些岗位的空 tracks 不再视为全接）。编剧、故事作者、摄影摄像三类专属岗在此登记。
 */
export const REQUIRED_TRACKS: Partial<Record<Role, string>> = { screenwriter: '编剧', 'story-author': '原著', cinematography: '摄影' };
const DEFAULT_LEASE_SECONDS = 600;
/** Checkpoints cost a full model round trip each; past this many per holder per task the holder should heartbeat/submit instead. */
const DEFAULT_CHECKPOINT_LIMIT = 6;
const HISTORY_LIMIT = 40;
const OPS_HISTORY_LIMIT = 15;
const HISTORY_EVIDENCE_CHARS = 6000;
const OPS_EVIDENCE_CHARS = 600;
const LIST_CONTEXT_CHARS = 1200;
const LIST_TASKS_LIMIT = 500;
export const HASH = (value: string) => createHash('sha256').update(value).digest('hex');
export const id = (table: string, value: string) => new RecordId(table, value);

const QUOTA_RESET_MAX_MS = 14 * 24 * 3600_000;

/**
 * Parses a provider's quota reset instant reported by an employee into unix seconds. The text
 * must carry an explicit offset, because a bare clock time is ambiguous across the company's
 * timezone and the provider's.
 */
export function parseQuotaResetsAt(text: string, nowMs: number): number {
  if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(text.trim())) {
    throw new CompanyError('invalid', 'quotaResetsAt needs an explicit timezone offset, e.g. 2026-10-18T10:12:00-04:00');
  }
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) throw new CompanyError('invalid', 'quotaResetsAt is not a valid time');
  if (ms <= nowMs) throw new CompanyError('invalid', 'quotaResetsAt must be in the future');
  if (ms - nowMs > QUOTA_RESET_MAX_MS) throw new CompanyError('invalid', 'quotaResetsAt is more than 14 days away; check the timezone');
  return Math.floor(ms / 1000);
}
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
export const depUnsatisfiedFor = (holder: string) =>
  `state != 'done' AND (state != 'void' OR (reviewer_role = 'owner' AND (${holder}.goal = NONE OR ${holder}.id NOT IN (${holder}.goal.anchors ?? []))))`;

/**
 * Resolves a raw dependency id list through superseded_by chains: every superseded draft
 * maps to the tip of its shared `lineage` (superseded_by = NONE) in O(1) — bounded, no
 * traversal. Binds `${p}_resolved` to the resolved id set. Resolution rules:
 *  - un-superseded deps (superseded_by = NONE, including tips) resolve to themselves;
 *  - a superseded dep whose lineage has exactly the visible tip resolves to that tip;
 *  - corrupt data (superseded but missing lineage, or a lineage with no tip) resolves the
 *    dep to itself — the void+owner rule then keeps it conservatively blocked.
 * The unchanged satisfaction rule is applied to the resolved rows by the caller.
 */
export const RESOLVE_DEP_SQL = (deps: string, p: string) => `
  LET ${p}_lns = SELECT VALUE lineage FROM task WHERE id IN ${deps} AND superseded_by != NONE AND lineage != NONE;
  LET ${p}_ok = SELECT VALUE lineage FROM task WHERE lineage != NONE AND lineage IN ${p}_lns AND superseded_by = NONE;
  LET ${p}_resolved = array::distinct(array::concat(
    (SELECT VALUE id FROM task WHERE id IN ${deps} AND superseded_by = NONE),
    (SELECT VALUE id FROM task WHERE lineage != NONE AND lineage IN ${p}_ok AND superseded_by = NONE),
    (SELECT VALUE id FROM task WHERE id IN ${deps} AND superseded_by != NONE AND (lineage = NONE OR lineage NOT IN ${p}_ok))));
`;

/**
 * Unlocks blocked children of $task whose dependencies are all finished ('done' or 'void')
 * (retired tasks count as satisfied so downstream chains unblock on retire). Requires
 * $task and $actor in scope. Retire reuses this block without the goal-close below.
 * When the finished task is a screenplay-chain tip, dependents on ANY earlier version of
 * the same lineage are re-evaluated too — their dependency resolves through superseded_by
 * to the finished tip.
 */
export const UNLOCK_CHILDREN_SQL = `
  LET $done_row = SELECT * FROM ONLY $task;
  LET $task_chain = IF ($done_row.lineage ?? NONE) = NONE THEN [$task] ELSE (SELECT VALUE id FROM task WHERE lineage = $done_row.lineage) END;
  LET $children = SELECT * FROM task WHERE state = 'blocked' AND blocked_to = NONE AND array::len(array::filter(dependencies ?? [], |$d| $d IN $task_chain)) > 0;
  FOR $child IN $children {
    ${RESOLVE_DEP_SQL('$child.dependencies', '$c_dep')}
    LET $remaining = SELECT * FROM task WHERE id IN $c_dep_resolved AND ${depUnsatisfiedFor('$child')};
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
  /** Task-level project override (registered project id); NONE falls back to goal.project routing. */
  project?: RecordId;
  /** Explicit code-repo binding (schema 017); workspace/dispatch routing only, never business project resolution. */
  code_repo_path?: string;
  handover?: boolean;
  previous_employee?: string;
  /** Bound code implementer: set at the first execute claim or by an explicit gm takeover (schemaless). */
  implementer?: string;
  /** Open dispatch-blocked episode (schemaless): the phase it blocks and when it began, unix seconds. */
  dispatch_blocked_phase?: string | null;
  dispatch_blocked_since?: number | null;
  progress_at?: number;
  /** Unix seconds: a quota-caused block may not be re-announced to gm before this instant. */
  quota_resets_at?: number | null;
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
  /** Screenplay-revision edge fields (schema 015): see RESOLVE_DEP_SQL. */
  revises?: RecordId;
  superseded_by?: RecordId;
  lineage?: RecordId;
  revision_no?: number;
}

export interface IdempotencyRow { payload_digest: string; result: TaskRow }
export type { TaskRow };

export function view(row: TaskRow): TaskView {
  return {
    id: asId(row.id), title: row.title, context: row.context, state: row.state,
    executorRole: row.executor_role, reviewerRole: row.reviewer_role,
    discipline: row.discipline ?? undefined,
    kind: row.kind ?? 'task', goalId: row.goal ? asId(row.goal) : undefined,
    projectOverlay: row.project ? asId(row.project) : undefined,
    codeRepoPath: row.code_repo_path ?? undefined,
    dependencies: (row.dependencies ?? []).map(asId), version: row.version,
    submittedBy: row.submitted_by, currentEmployee: row.current_employee,
    deliveryId: row.delivery_id,
    leaseExpiresAt: row.lease_expires_at ? new Date(row.lease_expires_at * 1000).toISOString() : undefined,
    fence: row.fence,
    blockedTo: row.blocked_to,
    handover: row.handover || undefined,
    previousEmployee: row.previous_employee,
    implementer: row.implementer ?? undefined,
    workIntent: row.work_intent, worktree: row.worktree,
    revises: row.revises ? asId(row.revises) : undefined,
    supersededBy: row.superseded_by ? asId(row.superseded_by) : undefined,
    lineage: row.lineage ? asId(row.lineage) : undefined,
    revisionNo: row.revision_no ?? undefined,
  };
}

/** Ops repo (agent home); mirrors the plugin/MCP wiring fallback for SCK_AGENT_CWD. */
const opsRepoPath = () => process.env.SCK_AGENT_CWD ?? '/Users/y/IdeaProjects/surreal-ck-operations';

/**
 * Canonical form for repo allowlisting and routing comparisons: resolve() first, then
 * realpath the nearest existing ancestor and re-append the remaining tail — a symlinked
 * parent can never smuggle a path outside the registered set.
 */
export function canonicalRepoPath(input: string): string {
  let probe = resolve(input);
  const tail: string[] = [];
  while (!existsSync(probe)) { tail.unshift(basename(probe)); probe = dirname(probe); }
  const base = realpathSync(probe);
  return tail.length ? join(base, ...tail) : base;
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

/** Fields the acceptance repair reads from task rows; keeps context text out of the preview. */
const GOAL_ACCEPTANCE_TASK_FIELDS = 'id, title, state, executor_role, reviewer_role, kind, version, dependencies, blocked_to, submitted_by, current_employee, lease_expires_at, goal, project';
type GoalAcceptanceTaskRow = Pick<TaskRow, 'id' | 'title' | 'state' | 'executor_role' | 'reviewer_role' | 'kind' | 'version' | 'dependencies' | 'blocked_to' | 'submitted_by' | 'current_employee' | 'lease_expires_at' | 'goal' | 'project'>;
interface GoalAcceptanceGoalRow {
  id: RecordId; title: string; state: string; tier?: string; pipeline?: string; project?: RecordId;
  anchors?: RecordId[]; tasks?: { intake?: RecordId; plan?: RecordId; manual?: RecordId; acceptance?: RecordId };
}
interface GoalAcceptanceCheck { code: 'not_found' | 'invalid' | 'conflict' | 'forbidden'; message: string }
interface GoalAcceptanceState {
  view: GoalAcceptanceView; checks: GoalAcceptanceCheck[]; hash: string;
  candidate?: GoalAcceptanceTaskRow; oldId?: string; unfinishedIds: string[];
}
const isLeased = (row: { current_employee?: string; lease_expires_at?: number }) =>
  Boolean(row.current_employee) && (row.lease_expires_at ?? 0) > Math.floor(Date.now() / 1000);
const briefTask = (row: GoalAcceptanceTaskRow): GoalAcceptanceTask => ({
  id: asId(row.id), title: row.title, state: row.state, executorRole: row.executor_role, reviewerRole: row.reviewer_role,
  kind: row.kind ?? 'task', version: row.version, blockedTo: row.blocked_to ?? undefined,
  submitted: Boolean(row.submitted_by), leaseHolder: isLeased(row) ? row.current_employee : undefined,
  dependencies: (row.dependencies ?? []).map(asId).sort(),
});

export class SurrealCompanyCore implements CompanyCore {
  readonly leaseSeconds: number;
  readonly checkpointLimit: number;
  /** Optional pre-submit check of implementation deliveries; returns why the submission cannot go to review. */
  private readonly submitCheck?: SubmitCheck;
  constructor(readonly database: CompanyDatabase, options?: { leaseSeconds?: number; checkpointLimit?: number; workforce?: Workforce; worktrees?: RegistryOptions; submitCheck?: SubmitCheck }) {
    this.submitCheck = options?.submitCheck;
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
    // context holds ~77% of table bytes; list views get a preview (full text via getTask).
    // The single WSS channel sustains only ~50KB/s, so unbounded SELECT * stalls every
    // other query behind it for tens of seconds. get_context's contract is the
    // claimable/working set — terminal rows stay reachable through an explicit state.
    const scoped = actor.role !== 'gm';
    const [rows] = await this.db.query<[TaskRow[]]>(
      `SELECT *, string::slice(context ?? '', 0, $ctx) AS context FROM task
       WHERE ${state ? 'state = $state' : "state IN ['ready', 'doing', 'review', 'blocked']"}
         AND ($scoped = false OR executor_role = $role OR reviewer_role = $role)
       ORDER BY created_at DESC, id LIMIT $limit;`,
      { state, scoped, role: actor.role ?? '', ctx: LIST_CONTEXT_CHARS, limit: LIST_TASKS_LIMIT });
    return rows.filter(row => !(row.state === 'review' && row.submitted_by === actor.employeeId)).map(view);
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

  private async txTask<T = TaskRow>(query: string, vars: Record<string, unknown>): Promise<T> {
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
          // Goal acceptance guards THROW 'goal acceptance moved: …' when a preview basis drifted; that is a stale-snapshot conflict, not a generic failure.
          const moved = /goal acceptance moved: ([^'"\n]+)/i.exec(cause);
          if (moved) throw new CompanyError('conflict', `Goal acceptance moved: ${moved[1]!.trim()}; run goal_acceptance_preview again`);
          // Implementer takeover: 'moved' is a stale basis (CAS), 'invalid' is an ineligible target; both are checked before the generic denied/forbidden match.
          const takeover = /implementer takeover (moved|invalid): ([^'"\n]+)/i.exec(cause);
          if (takeover) {
            const kind = takeover[1]!.toLowerCase();
            throw new CompanyError(kind === 'moved' ? 'conflict' : 'invalid', `Implementer takeover ${kind}: ${takeover[2]!.trim()}`);
          }
          // The gm that repaired a goal acceptance reference is the candidate's author for four-eyes purposes: it may not review or accept that candidate.
          if (/goal acceptance repairer/i.test(cause)) throw new CompanyError('self_review', 'Repairing gm cannot review or accept the repaired goal candidate; another gm must');
          if (/self review/i.test(cause)) throw new CompanyError('self_review', 'Employee cannot review own delivery');
          if (/discipline track denied/i.test(cause)) throw new CompanyError('forbidden', 'Employee definition does not cover the task discipline');
          if (/leased by another|already has active task/i.test(cause)) throw new CompanyError('already_claimed', 'Task or employee already leased');
          if (/lease expired/i.test(cause)) throw new CompanyError('lease_expired', 'Lease expired');
          if (/denied|forbidden|revoked/i.test(cause)) throw new CompanyError('forbidden', 'Action forbidden');
          if (/checkpoint limit/i.test(cause)) throw new CompanyError('checkpoint_limit', 'Checkpoint limit reached');
          if (/task retired/i.test(cause)) throw new CompanyError('conflict', 'Task has been retired');
          if (/live owner-gate dependents/i.test(cause)) throw new CompanyError('conflict', 'Owner-gated task has live dependents; retire them first');
          if (/not a screenplay draft/i.test(cause)) throw new CompanyError('forbidden', 'Revision edge is limited to owner-reviewed screenplay drafts on the 编剧 track');
          if (/revises|superseded|supersede|revision lineage|real owner rejection/i.test(cause)) throw new CompanyError('conflict', 'Revision edge conflicted; refresh and retry');
          if (/already terminal/i.test(cause)) throw new CompanyError('conflict', 'Task already in a terminal state');
          if (/version moved/i.test(cause)) throw new CompanyError('conflict', 'Task version moved');
          if (/dependency not found|not found/i.test(cause)) throw new CompanyError('not_found', 'Referenced record not found');
          throw new CompanyError('conflict', 'Task changed or transaction conflicted');
        }
        const result = responses.map(response => response.success ? response.result : undefined);
        const row = result.at(-2) as T | undefined;
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
    if (input.project !== undefined) requireText(input.project, 'project', 1, 60);
    // Registered projects only: a typo must fail loudly, not silently fall back to goal routing.
    if (input.project !== undefined && !(await this.projects.get(input.project))) {
      throw new CompanyError('not_found', `project ${input.project} not found`);
    }
    const contract = await this.disciplineContract(input.goalId, input.project);
    if (input.discipline !== undefined) {
      requireText(input.discipline, 'discipline', 1, 60);
      if (contract && !contract.has(input.discipline)) {
        throw new CompanyError('invalid', `discipline must be in the project's tracks vocabulary: ${[...contract.keys()].join('、')}`);
      }
    }
    assertRoleContract(contract, input.executorRole, input.discipline);
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
    if (input.revises !== undefined) return this.createRevision(actor, input, dependencies);
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
      project: input.project ? id('project', input.project) : undefined,
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
        ${RESOLVE_DEP_SQL('$dependencies', '$dep')}
        LET $unfinished = SELECT VALUE id FROM task WHERE id IN $dep_resolved AND ${DEP_UNSATISFIED};
        LET $created = CREATE ONLY $task CONTENT {
          title: $title, context: $context, executor_role: $executor, reviewer_role: $reviewer,
          discipline: $discipline, work_intent: $work_intent, project: $project,
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

  /**
   * Controlled screenplay-revision edge (create_task with `revises`): gm/product replaces an
   * owner-rejected screenplay draft with its legal next version in one transaction — the old
   * draft voids with a superseded_by pointer, the new draft inherits the lineage and may start
   * once its own normal dependencies are satisfied. The edge is never a general approval
   * exemption: it only exists between two owner-reviewed screenwriter 编剧 drafts in the same
   * goal and project, the target must be the unapproved chain tip whose latest submission drew
   * a real owner_reject, and normal downstreams keep resolving to the chain tip.
   *
   * The checks below run twice: once here for readable fast-fail errors, once inside the
   * transaction where a concurrent approve/submit/claim/supersede can't slip past.
   */
  private async createRevision(actor: Principal, input: CreateTask, dependencies: string[]): Promise<TaskView> {
    const taskId = randomUUID();
    const idem = this.idemId(actor.employeeId, 'create', input.idempotencyKey);
    const digest = HASH(JSON.stringify({ ...input, dependencies }));
    // Idempotent replay comes first: a retried call must return the same revision even though
    // the old draft is already void, which the live checks below would reject.
    const prior = await this.replay(idem, digest);
    if (prior) return prior;
    requireText(input.revises!, 'revises', 1, 200);
    if (input.executorRole !== 'screenwriter' || input.reviewerRole !== 'owner' ||
        input.discipline !== REQUIRED_TRACKS.screenwriter || (input.kind ?? 'task') !== 'task') {
      throw new CompanyError('forbidden', 'revises is limited to owner-reviewed screenplay drafts on the 编剧 track');
    }
    // The caller writes the itemized revision points; the service stamps the lineage and the
    // real rejection audit reference itself so context can never fake the gate.
    requireText(input.context, 'context', 20, 20000);
    const targetId = input.revises!;
    if (dependencies.includes(targetId)) {
      throw new CompanyError('invalid', 'revises target must not also be a normal dependency');
    }
    type TargetRow = {
      id: RecordId; state: TaskState; executor_role: Role; reviewer_role: ReviewerRole;
      discipline?: string; kind?: TaskKind; goal?: RecordId; project?: RecordId;
      superseded_by?: RecordId; lineage?: RecordId; revision_no?: number;
    };
    const [target] = await this.db.query<[TargetRow | undefined]>(
      'SELECT id, state, executor_role, reviewer_role, discipline, kind, goal, project, superseded_by, lineage, revision_no FROM ONLY $task;',
      { task: id('task', targetId) });
    if (!target) throw new CompanyError('not_found', 'revises target not found');
    const isDraft = target.executor_role === 'screenwriter' && target.reviewer_role === 'owner'
      && target.discipline === REQUIRED_TRACKS.screenwriter && (target.kind ?? 'task') === 'task';
    if (!isDraft) throw new CompanyError('forbidden', 'revises target is not a screenplay draft');
    if (target.superseded_by) throw new CompanyError('conflict', 'revises target is already superseded');
    // review = newest submission still awaiting the owner; done = approved (an approved draft
    // may never be superseded — in-flight mass production keeps its authorized version).
    if (!['ready', 'doing', 'blocked'].includes(target.state)) {
      throw new CompanyError('conflict', 'revises target must be an unapproved draft not awaiting review');
    }
    if ((target.goal ? asId(target.goal) : undefined) !== input.goalId) {
      throw new CompanyError('invalid', 'revises target is in another goal');
    }
    if ((target.project ? asId(target.project) : undefined) !== input.project) {
      throw new CompanyError('invalid', 'revises target is in another project');
    }
    const lineageId = target.lineage ? asId(target.lineage) : targetId;
    // Normal dependencies must stay outside the revision lineage: a dep that resolves into
    // this chain would wait on the draft being created — a self-dependency.
    const [chainRows] = await this.db.query<[RecordId[]]>(
      'SELECT VALUE id FROM task WHERE lineage = $lineage OR id = $revises;',
      { lineage: id('task', lineageId), revises: id('task', targetId) });
    const chainIds = new Set((chainRows ?? []).map(asId));
    const lineageDep = dependencies.find(dep => chainIds.has(dep));
    if (lineageDep) throw new CompanyError('invalid', `dependency ${lineageDep} is inside the revision lineage`);
    // A real rejection means the draft's LATEST submission drew an owner_reject afterwards:
    // pre-seeded opinions, employee review returns, and older rejects followed by a new
    // pending submission do not count.
    const [lastSubmit] = await this.db.query<[Array<{ at: unknown }>]>(
      "SELECT at FROM audit WHERE task = $task AND action = 'submit' ORDER BY at DESC LIMIT 1;",
      { task: id('task', targetId) });
    const [rejectRows] = await this.db.query<[Array<{ id: RecordId; at: unknown }>]>(
      "SELECT id, at FROM audit WHERE task = $task AND action = 'owner_reject' ORDER BY at DESC LIMIT 1;",
      { task: id('task', targetId) });
    const submitAt = lastSubmit?.[0]?.at;
    const reject = rejectRows?.[0];
    if (!submitAt) throw new CompanyError('conflict', 'revises target was never submitted');
    if (!reject || !(new Date(String(reject.at)).getTime() > new Date(String(submitAt)).getTime())) {
      throw new CompanyError('conflict', 'revises target lacks a real owner rejection on its latest submission');
    }
    const nextNo = (target.revision_no ?? 1) + 1;
    const marker = new RegExp(`(?:^|[^0-9A-Za-z])(?:[vVrR]\\s*0*${nextNo}|第\\s*0*${nextNo}\\s*版)(?![0-9])`);
    if (!marker.test(input.title)) {
      throw new CompanyError('invalid', `revision title must carry the new version number v${nextNo}`);
    }
    const stamp = `\n\n—— 修订谱系（服务端记录）——\n上一版：task:${targetId}（v${nextNo - 1} → v${nextNo}）\n谱系：task:${lineageId}\n驳回审计：audit:${asId(reject.id)} @ ${String(reject.at)}`;

    const vars = {
      actor: id('employee', actor.employeeId), task: id('task', taskId),
      revises: id('task', targetId), lineage: id('task', lineageId), revision_no: nextNo,
      req_track: REQUIRED_TRACKS.screenwriter,
      idem, digest,
      audit: id('audit', randomUUID()), audit_sup: id('audit', randomUUID()),
      outbox: id('outbox', randomUUID()), outbox_sup: id('outbox', randomUUID()),
      title: input.title, context: input.context + stamp, executor: input.executorRole,
      reviewer: input.reviewerRole, dependencies: dependencies.map(dep => id('task', dep)),
      kind: 'task', goal: input.goalId ? id('goal', input.goalId) : undefined,
      project: input.project ? id('project', input.project) : undefined,
      discipline: input.discipline, work_intent: input.workIntent,
      sup_evidence: `被 task:${taskId} 取代（v${nextNo - 1} → v${nextNo}，谱系 task:${lineageId}）；驳回审计 audit:${asId(reject.id)}`,
      create_evidence: `修订自 task:${targetId}（v${nextNo - 1} → v${nextNo}）；驳回审计 audit:${asId(reject.id)}`,
    };
    try {
      const row = await this.txTask(`BEGIN;
        LET $who = SELECT * FROM ONLY $actor;
        IF $who = NONE OR $who.revoked = true OR 'manage' NOT IN $who.capabilities OR $who.role NOT IN ['gm', 'product'] { THROW 'actor revoked or forbidden' };
        LET $d = SELECT * FROM ONLY $revises;
        IF $d = NONE { THROW 'dependency not found' };
        IF $d.executor_role != 'screenwriter' OR $d.discipline != $req_track OR $d.reviewer_role != 'owner' OR ($d.kind ?? 'task') != 'task' { THROW 'revises target is not a screenplay draft' };
        IF $d.superseded_by != NONE { THROW 'revises target already superseded' };
        IF $d.state NOT IN ['ready', 'doing', 'blocked'] { THROW 'revises target not supersedeable' };
        IF ($d.goal ?? NONE) != ($goal ?? NONE) { THROW 'revises target in another goal' };
        IF ($d.project ?? NONE) != ($project ?? NONE) { THROW 'revises target in another project' };
        LET $last_submit = SELECT VALUE at FROM audit WHERE task = $revises AND action = 'submit' ORDER BY at DESC LIMIT 1;
        LET $reject = SELECT * FROM audit WHERE task = $revises AND action = 'owner_reject' ORDER BY at DESC LIMIT 1;
        IF array::len($last_submit) = 0 { THROW 'revises target has no submission' };
        IF array::len($reject) = 0 OR $reject[0].at <= $last_submit[0] { THROW 'revises target lacks real owner rejection' };
        LET $chain_ids = SELECT VALUE id FROM task WHERE lineage = $lineage OR id = $revises;
        IF array::len(array::filter($dependencies, |$x| $x IN $chain_ids)) > 0 { THROW 'dependency inside revision lineage' };
        FOR $dep IN $dependencies {
          LET $dd = SELECT * FROM ONLY $dep;
          IF $dd = NONE { THROW 'dependency not found' };
        };
        ${RESOLVE_DEP_SQL('$dependencies', '$dep')}
        LET $unfinished = SELECT VALUE id FROM task WHERE id IN $dep_resolved AND ${DEP_UNSATISFIED};
        LET $created = CREATE ONLY $task CONTENT {
          title: $title, context: $context, executor_role: $executor, reviewer_role: $reviewer,
          discipline: $discipline, work_intent: $work_intent, project: $project,
          dependencies: $dependencies, state: IF array::len($unfinished) = 0 THEN 'ready' ELSE 'blocked' END,
          version: 1, fence: 0, submitted_by: NONE, current_employee: NONE,
          delivery_id: NONE, lease_expires_at: NONE, resume_role: NONE, resume_state: 'ready', blocked_to: NONE,
          kind: $kind, goal: $goal, created_at: time::now(),
          revises: $revises, lineage: $lineage, revision_no: $revision_no
        };
        LET $old = UPDATE ONLY $revises SET
          state = 'void', superseded_by = $task, lineage = $lineage,
          blocked_to = NONE, resume_role = NONE, resume_state = NONE, handover = NONE,
          current_employee = NONE, delivery_id = NONE, lease_expires_at = NONE,
          version = $d.version + 1
          WHERE superseded_by = NONE AND state NOT IN ['done', 'void', 'review']
          RETURN AFTER;
        IF $old = NONE { THROW 'supersede race lost' };
        UPDATE employee SET active_task = NONE WHERE active_task = $revises;
        ${GOAL_ANCHOR_SQL}
        CREATE ONLY $audit_sup CONTENT { task: $revises, actor: $actor, action: 'superseded', evidence: $sup_evidence, version: $old.version, at: time::now() };
        LET $seq_sup = UPDATE ONLY company_meta:outbox_counter SET value += 1 RETURN AFTER;
        CREATE ONLY $outbox_sup CONTENT { task: $revises, kind: 'superseded', sequence: $seq_sup.value, payload: { state: 'void', superseded_by: $task, lineage: $lineage }, at: time::now() };
        CREATE ONLY $audit CONTENT { task: $task, actor: $actor, action: 'create', version: 1, evidence: $create_evidence, at: time::now() };
        LET $seq_new = UPDATE ONLY company_meta:outbox_counter SET value += 1 RETURN AFTER;
        CREATE ONLY $outbox CONTENT { task: $task, kind: 'created', sequence: $seq_new.value, payload: { state: $created.state, revises: $revises, lineage: $lineage, revision_no: $revision_no }, at: time::now() };
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
    if (!reviewing && task.executorRole === 'engineering') {
      // Engineering execute is bound to one implementer (contributors.ts): refuse before a worktree is allocated.
      const facts = await readContributors(this.db, taskId);
      if (facts.ambiguous) throw new CompanyError('forbidden', 'Task claim denied: implementer unresolved, manager takeover required');
      if (facts.implementer && facts.implementer !== actor.employeeId) throw new CompanyError('forbidden', 'Task claim denied: bound to another implementer');
    }
    const project = await this.taskProject(taskId);
    // Code-repo routing: an explicit binding wins over the business project repo; the
    // business `project` itself stays with taskProject for claim.json/opsScope.
    return this.worktrees.locked(task.codeRepoPath ?? project?.repoPath ?? this.worktrees.options.opsRepo, async (repo, list) => {
      // Re-read under the cross-process repo lock: the first allocation may have completed while waiting.
      const fresh = await this.getTask(credential, taskId);
      const [now] = await this.db.query<[number]>('RETURN time::unix(time::now());');
      if (fresh.currentEmployee && fresh.currentEmployee !== actor.employeeId && fresh.leaseExpiresAt && Date.parse(fresh.leaseExpiresAt) > now * 1000) throw new CompanyError('already_claimed', 'Task scene still leased');
      const holder = await this.db.select<EmployeeRow>(id('employee', actor.employeeId));
      if (holder?.active_task && asId(holder.active_task) !== taskId) {
        const active = await this.db.select<TaskRow>(holder.active_task);
        if (active?.current_employee === actor.employeeId && (active.lease_expires_at ?? 0) > now) throw new CompanyError('already_claimed', 'Employee still holds another task');
      }
      // Bound to a different repo: the tree's default branch/tag comes from the project that
      // actually owns that repo (or none for the ops repo), never from the business project.
      const allocProject = fresh.codeRepoPath ? await this.projectForRepo(repo) : project;
      const worktree = await this.worktrees!.allocate(repo, list, fresh, actor, allocProject);
      return this.claimLease(actor, taskId, worktree);
    });
  }

  async readWorkspace(credential: Credential, taskId?: TaskId, project?: string): Promise<WorktreeAssignment | undefined> {
    const actor = await this.authorized(credential);
    if (!['gm', 'eval'].includes(actor.role)) throw new CompanyError('forbidden', 'Non-lease workspace requires gm/eval');
    if (!this.worktrees) return undefined;
    const bound = taskId ? await this.getTask(credential, taskId) : undefined;
    const resolved = taskId ? await this.taskProject(taskId!) : project ? await this.projects.get(project) : undefined;
    const repo = bound?.codeRepoPath ?? resolved?.repoPath ?? this.worktrees.options.opsRepo;
    return this.worktrees.readWorkspace(repo, actor, bound?.codeRepoPath ? await this.projectForRepo(repo) : resolved);
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
      const task = await this.getTask(credential, taskId);
      const project = await this.taskProject(taskId);
      const { repo } = await this.worktrees.identity(task.codeRepoPath ?? project?.repoPath ?? this.worktrees.options.opsRepo);
      return this.worktrees.inventory(repo);
    }
    return this.worktrees.inventory();
  }

  private async claimLease(actor: Principal, taskId: TaskId, worktree?: WorktreeAssignment): Promise<ClaimResult> {
    const task = id('task', taskId);
    const facts = await readContributors(this.db, taskId);
    const row = await this.txTask(`BEGIN;
      LET $now = time::unix(time::now());
      LET $who = SELECT * FROM ONLY $actor;
      LET $t = SELECT * FROM ONLY $task;
      IF $who = NONE OR $who.revoked = true OR $t = NONE { THROW 'not found or revoked' };
      IF $t.state = 'void' { THROW 'task retired' };
      IF $t.state NOT IN ['ready', 'review', 'doing'] { THROW 'task not claimable' };
      IF $t.state = 'review' {
        IF $t.submitted_by = $employee OR ($excluded CONTAINS $employee) { THROW 'self review denied' };
        LET $repairs = SELECT VALUE count() FROM audit WHERE task = $task AND action = 'goal_acceptance_repair' AND actor = $actor GROUP ALL;
        IF ($repairs[0] ?? 0) > 0 { THROW 'goal acceptance repairer cannot review' };
        IF 'review' NOT IN $who.capabilities OR $t.reviewer_role != $who.role { THROW 'review denied' };
      } ELSE {
        IF 'execute' NOT IN $who.capabilities OR $t.executor_role != $who.role { THROW 'execute denied' };
        IF $t.executor_role = 'engineering' {
          LET $owner = IF $t.implementer != NONE THEN $t.implementer ELSE $bound END;
          IF $owner = '' AND $ambiguous { THROW 'execute denied: implementer unresolved, manager takeover required' };
          IF $owner != '' AND $owner != $employee { THROW 'execute denied: bound to another implementer' };
        };
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
        implementer = IF $t.state != 'review' AND $t.executor_role = 'engineering' AND $t.implementer = NONE THEN $employee ELSE $t.implementer END,
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
        CREATE ONLY $audit CONTENT { task: $task, actor: $actor, action: 'claim', version: $next.version, at: time::now(), phase: IF $t.state = 'review' THEN 'review' ELSE 'execute' END, evidence: IF $assignment != NONE THEN type::string($assignment) ELSE NONE END };
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
      excluded: facts.excluded, bound: facts.implementer ?? '', ambiguous: facts.ambiguous,
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
   * Discipline vocabulary for validating a new task's track: the explicitly given project's
   * vocabulary when the task carries a project override, else the goal's project's vocabulary
   * (a Set of track names when the project defines a non-empty `disciplines` list, else
   * undefined = free-form values allowed).
   */
  private disciplineContract(goalId?: string, projectId?: string): Promise<DisciplineContract | undefined> {
    return loadContract(this.db, goalId, projectId);
  }

  /**
   * Resolved project of a task: the task-level override when set (rebound or created with one),
   * otherwise the goal's project. This is the single project-resolution point for claim
   * workspaces, claim.json.project, worktree inventory and ops scoping.
   */
  private async taskProject(taskId: TaskId): Promise<ProjectView | undefined> {
    const [rows] = await this.db.query<[Array<{ project?: RecordId; goal_project?: RecordId }>]>(
      'SELECT project AS project, goal.project AS goal_project FROM $task;', { task: id('task', taskId) });
    const project = rows[0]?.project ?? rows[0]?.goal_project;
    return project ? this.projects.get(String(project.id)) : undefined;
  }

  /**
   * The registered project whose repo_path canonicalises to `repoPath` (allocation metadata:
   * default branch and tree tag), or undefined when the path is no project's repo (ops repo).
   */
  private async projectForRepo(repoPath: string): Promise<ProjectView | undefined> {
    const target = canonicalRepoPath(repoPath);
    for (const path of await this.projects.allRepoPaths()) {
      try {
        if (canonicalRepoPath(path) !== target) continue;
      } catch { continue; }
      const [rows] = await this.db.query<[Array<{ id: RecordId }>]>(
        'SELECT id FROM project WHERE repo_path = $path LIMIT 1;', { path });
      return rows?.[0] ? this.projects.get(asId(rows[0].id)) : undefined;
    }
    return undefined;
  }

  /** bind_task_code_repo allowlist: opsRepo plus every registered project repo_path, canonicalised. */
  private async allowedCodeRepos(): Promise<Set<string>> {
    const paths = [this.worktrees?.options.opsRepo ?? opsRepoPath(), ...(await this.projects.allRepoPaths())];
    const allowed = new Set<string>();
    for (const p of paths) {
      if (typeof p !== 'string' || !p.trim()) continue;
      try { allowed.add(canonicalRepoPath(p)); } catch { /* an unreadable path can never be a bind target */ }
    }
    return allowed;
  }

  private async readHistory(taskId: TaskId): Promise<HistoryEntry[]> {
    type Row = { action: string; actor: unknown; evidence?: string; version?: number; at: unknown };
    // Ops rows get their own window so a chatty broker session cannot push claims and checkpoints out of the
    // handover history; routine `ops_call` reads are never shown.
    const [protocol, ops] = await this.db.query<[Row[], Row[]]>(
      `SELECT action, actor, string::slice(evidence ?? '', 0, $ev_chars) AS evidence, version, at FROM audit WHERE task = $task AND !string::starts_with(action, 'ops_') ORDER BY at DESC LIMIT $limit;
       SELECT action, actor, string::slice(evidence ?? '', 0, $ev_chars) AS evidence, version, at FROM audit WHERE task = $task AND string::starts_with(action, 'ops_') AND action != 'ops_call' ORDER BY at DESC LIMIT $ops_limit;`,
      { task: id('task', taskId), limit: HISTORY_LIMIT, ops_limit: OPS_HISTORY_LIMIT, ev_chars: HISTORY_EVIDENCE_CHARS }
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

  async relayGoal(credential: Credential, input: { text: string; ownerQuote: string; idempotencyKey: string; tier?: GoalTier; project?: string; pipeline?: string }): Promise<GoalView> {
    const source = await this.relayActor(credential, input.ownerQuote);
    return this.owner.createGoal({ text: input.text, source, key: `${source}:${input.idempotencyKey}`,
      note: `老板原话：${input.ownerQuote}`, tier: input.tier, project: input.project, pipeline: input.pipeline });
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
    if (input.project !== undefined) requireText(input.project, 'project', 1, 60);
    if (input.discipline !== undefined) {
      requireText(input.discipline, 'discipline', 1, 60);
      const contract = await this.disciplineContract(input.goalId, input.project);
      if (contract && !contract.has(input.discipline)) {
        throw new CompanyError('invalid', `discipline must be in the project's tracks vocabulary: ${[...contract.keys()].join('、')}`);
      }
    }
    const specs = deliveryChain(input.title, input.spec);
    const lane = input.lane ?? `delivery-${HASH(input.idempotencyKey).slice(0, 8)}`;
    const created: TaskView[] = [];
    let dependencies = [...new Set(input.dependencies ?? [])];
    for (const [index, spec] of specs.entries()) {
      const task = await this.createTask(credential, {
        ...spec, goalId: input.goalId, dependencies, idempotencyKey: `${input.idempotencyKey}:delivery:${index}`,
        // Every leg persists the same project override so the chain stays on one project.
        project: input.project,
        // One delivery is one lane: every leg works in the same tree and branch, whoever claims it.
        workIntent: { kind: spec.kind === 'release' ? 'read' : 'code', lane },
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
    const [rows] = await this.db.query<[Array<{ current_employee?: string; state: TaskState; lease_expires_at?: number; project?: RecordId; goal_project?: RecordId }>]>(
      'SELECT current_employee, state, lease_expires_at, project AS project, goal.project AS goal_project FROM $task;', { task: id('task', taskId) });
    const task = rows[0];
    if (!task) throw new CompanyError('not_found', 'Task not found');
    if (task.current_employee !== actor.employeeId || !['doing', 'review'].includes(task.state) ||
      (task.lease_expires_at ?? 0) <= Date.now() / 1000) {
      throw new CompanyError('forbidden', 'Ops tools are only available to the current lease holder of the task');
    }
    // Task-level override wins, same resolution as claim/readWorkspace.
    const project = task.project ?? task.goal_project;
    if (!project) throw new CompanyError('invalid', 'Task goal has no project environment');
    return { actor, taskId, project: String(project.id) };
  }

  async auditOps(scope: OpsScope, action: string, evidence: string): Promise<void> {
    if (!/^ops_[a-z_]{1,40}$/.test(action)) throw new CompanyError('invalid', 'Invalid ops audit action');
    await this.db.query('CREATE audit CONTENT { task: $task, actor: $actor, action: $action, evidence: $evidence, at: time::now() };',
      { task: id('task', scope.taskId), actor: id('employee', scope.actor.employeeId), action, evidence: evidence.slice(0, OPS_EVIDENCE_CHARS) });
  }

  async opsCount(project: string, action: string, windowSeconds: number): Promise<number> {
    const [rows] = await this.db.query<[Array<{ n: number }>]>(
      'SELECT count() AS n FROM audit WHERE action = $action AND at > time::now() - <duration>$window AND (task.project ?? task.goal.project) = $project GROUP ALL;',
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
    if (action === 'submit' && evidence && this.submitCheck) {
      const row = await this.db.select<TaskRow>(id('task', proof.taskId));
      if (row?.executor_role === 'engineering' && row.kind === 'task') {
        const reason = await this.submitCheck({ branch: row.worktree?.branch, text: evidence.text }).catch(() => undefined);
        if (reason) throw new CompanyError('invalid', `提交被退回（未进入验收）：${reason}`);
      }
    }
    const facts = await readContributors(this.db, proof.taskId);
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
      IF $t.state = 'review' {
        LET $repairs = SELECT VALUE count() FROM audit WHERE task = $task AND action = 'goal_acceptance_repair' AND actor = $actor GROUP ALL;
        IF ($repairs[0] ?? 0) > 0 { THROW 'goal acceptance repairer cannot review' };
      };
      LET $owner = IF $t.implementer != NONE THEN $t.implementer ELSE $bound END;
      IF $submit OR (($heartbeat OR $checkpoint) AND $t.state != 'review') {
        IF 'execute' NOT IN $who.capabilities OR $t.state != 'doing' OR $t.executor_role != $who.role { THROW 'execute denied' };
        IF $t.executor_role = 'engineering' {
          IF $owner = '' AND $ambiguous { THROW 'execute denied: implementer unresolved, manager takeover required' };
          IF $owner != $employee { THROW 'execute denied: not the bound implementer' };
        };
      };
      IF ($heartbeat OR $checkpoint) AND $t.state = 'review' {
        IF $t.submitted_by = $employee OR ($excluded CONTAINS $employee) { THROW 'self review denied' };
        IF 'review' NOT IN $who.capabilities OR $t.reviewer_role != $who.role { THROW 'review denied' };
      };
      IF $accept OR $returning {
        IF $t.submitted_by = $employee OR ($excluded CONTAINS $employee) { THROW 'self review denied' };
        IF 'review' NOT IN $who.capabilities OR $t.state != 'review' OR $t.reviewer_role != $who.role { THROW 'review denied' };
      };
      IF $block {
        IF $t.state = 'review' {
          IF $t.submitted_by = $employee OR ($excluded CONTAINS $employee) { THROW 'self review denied' };
          IF 'review' NOT IN $who.capabilities OR $t.reviewer_role != $who.role { THROW 'block denied' };
        } ELSE {
          IF 'execute' NOT IN $who.capabilities OR $t.state != 'doing' OR $t.executor_role != $who.role { THROW 'block denied' };
          IF $t.executor_role = 'engineering' {
            IF $owner = '' AND $ambiguous { THROW 'block denied: implementer unresolved, manager takeover required' };
            IF $owner != $employee { THROW 'block denied: not the bound implementer' };
          };
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
        CREATE ONLY $audit CONTENT { task: $task, actor: $actor, action: $action, evidence: $evidence, version: $next.version, at: time::now(), phase: IF $t.state = 'review' THEN 'review' ELSE 'execute' END };
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
        excluded: facts.excluded, bound: facts.implementer ?? '', ambiguous: facts.ambiguous,
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
  async returnTask(credential: Credential, proof: LeaseProof, evidence: Evidence) {
    const task = await this.transition(credential, proof, 'return', evidence);
    // Same event point as accept: a return that leaves the scene with zero effective refs
    // reclaims it in place; a recovery ref keeps the scene for the next holder.
    if (task.worktree && this.worktrees) {
      await this.worktrees.reclaimEvent(task.worktree.id, 'return').catch(() => undefined);
    }
    return task;
  }
  /**
   * Channel-side claim rollback (spawn/wake failure, workspace handoff): the holder's lease is
   * dropped without a reviewer verdict — a review task stays in review awaiting a fresh claim,
   * a doing task returns to ready. The audit row is 'released' so a rollback never reads as a
   * reviewer return; handover markers from earlier holders are left untouched.
   */
  async release(credential: Credential, proof: LeaseProof, evidence: Evidence): Promise<TaskView> {
    const actor = await this.authorized(credential);
    if (!Number.isSafeInteger(proof.expectedVersion) || !Number.isSafeInteger(proof.fence) || proof.fence < 1) {
      throw new CompanyError('invalid', 'Invalid lease proof');
    }
    requireText(evidence.text, 'evidence', 20, 30000);
    const idem = this.idemId(actor.employeeId, 'released', evidence.idempotencyKey);
    const digest = HASH(JSON.stringify({ proof, evidence }));
    const prior = await this.replay(idem, digest);
    if (prior) return prior;
    const query = `BEGIN;
      LET $now = time::unix(time::now());
      LET $who = SELECT * FROM ONLY $actor;
      LET $t = SELECT * FROM ONLY $task;
      IF $who = NONE OR $who.revoked = true OR $t = NONE { THROW 'not found or revoked' };
      IF $t.state = 'void' { THROW 'task retired' };
      IF $t.lease_expires_at <= $now { THROW 'lease expired' };
      IF $t.current_employee != $employee OR $t.delivery_id != $delivery OR $t.fence != $fence OR $t.version != $expected { THROW 'stale lease or version' };
      IF $t.state NOT IN ['doing', 'review'] { THROW 'task not held' };
      LET $next = UPDATE ONLY $task SET
        state = IF $t.state = 'doing' THEN 'ready' ELSE $t.state END,
        current_employee = NONE, delivery_id = NONE, lease_expires_at = NONE,
        version = $t.version + 1 RETURN AFTER;
      UPDATE employee SET active_task = NONE WHERE id = $actor AND active_task = $task;
      CREATE ONLY $audit CONTENT { task: $task, actor: $actor, action: 'released', evidence: $evidence, version: $next.version, at: time::now(), phase: IF $t.state = 'review' THEN 'review' ELSE 'execute' END };
      LET $sequence = UPDATE ONLY company_meta:outbox_counter SET value += 1 RETURN AFTER;
      CREATE ONLY $outbox CONTENT { task: $task, kind: 'released', sequence: $sequence.value, payload: { version: $next.version, state: $next.state }, at: time::now() };
      CREATE ONLY $idem CONTENT { payload_digest: $digest, result: $next };
      RETURN $next;
      COMMIT;`;
    try {
      const row = await this.txTask(query, {
        actor: id('employee', actor.employeeId), employee: actor.employeeId,
        task: id('task', proof.taskId), delivery: proof.deliveryId,
        fence: proof.fence, expected: proof.expectedVersion, evidence: evidence.text,
        audit: id('audit', randomUUID()), outbox: id('outbox', randomUUID()), idem, digest,
      });
      const task = view(row);
      // Same event point as return: a released claim may have been the scene's last reference.
      // decideReclaim keeps anything still referenced (e.g. a review task awaiting a fresh
      // claim) or unsafe to delete; never block the rollback itself.
      if (task.worktree && this.worktrees) {
        await this.worktrees.reclaimEvent(task.worktree.id, 'release').catch(() => undefined);
      }
      return task;
    } catch (error) {
      const prior = await this.replay(idem, digest);
      if (prior) return prior;
      throw error;
    }
  }
  /**
   * `quotaResetsAt` is set only for a subscription quota or rate-limit block. The task then stays
   * quiet for gm until that instant, and the employee's provider leaves dispatch until then too.
   */
  async block(credential: Credential, proof: LeaseProof, to: 'gm' | 'owner', evidence: Evidence, quotaResetsAt?: string): Promise<TaskView> {
    const until = quotaResetsAt === undefined ? undefined : parseQuotaResetsAt(quotaResetsAt, Date.now());
    const view = await this.transition(credential, proof, 'block', evidence, to);
    await this.recordQuotaGate(credential, proof.taskId, until);
    return view;
  }

  private async recordQuotaGate(credential: Credential, taskId: TaskId, until: number | undefined): Promise<void> {
    if (until === undefined) {
      await this.db.query('UPDATE ONLY $task SET quota_resets_at = NONE;', { task: id('task', taskId) });
      return;
    }
    const actor = await this.authenticate(credential);
    const who = await this.db.select<{ provider?: string }>(id('employee', actor.employeeId));
    const provider = who?.provider;
    if (!provider) {
      await this.db.query('UPDATE ONLY $task SET quota_resets_at = $until;', { task: id('task', taskId), until });
      return;
    }
    await this.db.query(`BEGIN;
      UPDATE ONLY $task SET quota_resets_at = $until;
      UPSERT $health MERGE { state: 'exhausted', until: $until, last_error: $error, changed_at: time::now() };
      COMMIT;`, {
      task: id('task', taskId), until, health: id('provider_health', provider),
      error: 'quota reset reported by employee',
    });
  }

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
        ${RESOLVE_DEP_SQL('$t.dependencies', '$r_dep')}
        LET $remaining = SELECT * FROM task WHERE id IN $r_dep_resolved AND ${depUnsatisfiedFor('$t')};
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
      ${RESOLVE_DEP_SQL('$merged', '$m_dep')}
      LET $remaining = SELECT VALUE id FROM task WHERE id IN $m_dep_resolved AND ${depUnsatisfiedFor('$t')};
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
      // Dependents on ANY version of the task's screenplay lineage are live dependents of
      // the tip too — retiring the tip would strand them blocked with no revision possible.
      const rows = await this.db.query<[unknown, unknown, RecordId[]]>(`
        LET $r = SELECT * FROM ONLY $task;
        LET $chain = IF ($r.lineage ?? NONE) = NONE THEN [$task] ELSE (SELECT VALUE id FROM task WHERE lineage = $r.lineage) END;
        SELECT VALUE id FROM task WHERE array::len(array::filter(dependencies ?? [], |$d| $d IN $chain)) > 0
          AND state NOT IN [$done, $void] AND (goal = NONE OR id NOT IN (goal.anchors ?? []));`,
        { task: id('task', input.taskId), done: 'done', void: 'void' });
      if (rows[2].length > 0) {
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
        LET $retire_chain = IF ($t.lineage ?? NONE) = NONE THEN [$task] ELSE (SELECT VALUE id FROM task WHERE lineage = $t.lineage) END;
        LET $live_dependents = SELECT VALUE id FROM task WHERE array::len(array::filter(dependencies ?? [], |$d| $d IN $retire_chain)) > 0 AND state NOT IN ['done', 'void'] AND (goal = NONE OR id NOT IN (goal.anchors ?? []));
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
    const task = view(row);
    // Same event point as accept/return/release: a retire (void) is terminal, so its scene refs
    // release and an exclusive tree with no other effective refs dies here together with its
    // Paseo scene. Never block the retire itself on reclaim; durable audit and later event
    // points or sweeps retry any failure.
    if (task.worktree && this.worktrees) {
      await this.worktrees.reclaimEvent(task.worktree.id, 'retire').catch(() => undefined);
    }
    return task;
  }

  /**
   * Read-only dry-run of the acceptance reference repair (goal_acceptance_preview). Shows the live
   * manual/acceptance/anchors references, the unfinished goal work, the candidate checks and the
   * snapshot hash that goal_acceptance_repair must echo back. Writes nothing.
   */
  async goalAcceptancePreview(credential: Credential, input: GoalAcceptancePreview): Promise<GoalAcceptanceView> {
    const actor = await this.authorized(credential, 'manage');
    if (actor.role !== 'gm') throw new CompanyError('forbidden', 'Only gm may review goal acceptance references');
    requireText(input.goalId, 'goal', 1, 100);
    if (input.candidateTaskId !== undefined) requireText(input.candidateTaskId, 'candidateTaskId', 1, 200);
    return (await this.goalAcceptanceState(input.goalId, input.candidateTaskId)).view;
  }

  /**
   * gm only (manage): repoints a quick/software goal's manual/acceptance references and anchors from an
   * erroneously voided acceptance task to a blocked product→gm candidate that waits on all unfinished goal
   * work. Every basis the preview checks is re-verified inside one compare-and-set transaction (goal refs and
   * anchors, the void task, the candidate's version and state, the unfinished-work set), and the write lands
   * with audit, outbox and the idempotency row. The voided task keeps its state and history. The repair never
   * releases leases, never marks the goal done, and never treats a void as approval.
   */
  async goalAcceptanceRepair(credential: Credential, input: GoalAcceptanceRepair): Promise<GoalAcceptanceResult> {
    const actor = await this.authorized(credential, 'manage');
    if (actor.role !== 'gm') throw new CompanyError('forbidden', 'Only gm may repair goal acceptance references');
    requireText(input.goalId, 'goal', 1, 100);
    requireText(input.expectedOldTaskId, 'expectedOldTaskId', 1, 200);
    requireText(input.candidateTaskId, 'candidateTaskId', 1, 200);
    requireText(input.text, 'text', 4, 8000);
    if (typeof input.snapshotHash !== 'string' || !/^[0-9a-f]{64}$/.test(input.snapshotHash)) {
      throw new CompanyError('invalid', 'Invalid snapshotHash');
    }
    const idem = this.idemId(actor.employeeId, 'goal_acceptance_repair', input.idempotencyKey);
    const digest = HASH(JSON.stringify({ goalId: input.goalId, expectedOldTaskId: input.expectedOldTaskId,
      candidateTaskId: input.candidateTaskId, snapshotHash: input.snapshotHash, text: input.text }));
    const replayed = await this.replayStored<GoalAcceptanceResult>(idem, digest);
    if (replayed) return replayed;

    const state = await this.goalAcceptanceState(input.goalId, input.candidateTaskId, input.expectedOldTaskId);
    if (state.checks.length) {
      throw new CompanyError(state.checks[0]!.code, state.checks.map(check => check.message).join('; '));
    }
    if (state.hash !== input.snapshotHash) {
      throw new CompanyError('conflict', 'Goal acceptance snapshot moved; run goal_acceptance_preview again');
    }
    const candidate = state.candidate!;
    const oldId = state.oldId!;
    const result: GoalAcceptanceResult = {
      goalId: input.goalId, replacedTaskId: oldId, candidate: briefTask(candidate),
      anchors: [input.candidateTaskId], snapshotHash: state.hash, repairedAt: new Date().toISOString(),
    };
    const vars = {
      actor: id('employee', actor.employeeId), goal: id('goal', input.goalId), old: id('task', oldId),
      candidate: id('task', input.candidateTaskId), cand_version: candidate.version,
      expected_unfinished: state.unfinishedIds.map(taskId => id('task', taskId)),
      idem, digest, result,
      evidence: `${input.text}\n[goal_acceptance] goal=${input.goalId} replaced=${oldId} candidate=${input.candidateTaskId} snapshot=${state.hash}`,
      evidence_old: `替换为运营验收 task:${input.candidateTaskId}；goal=${input.goalId}；snapshot=${state.hash}`,
      audit: id('audit', randomUUID()), audit_old: id('audit', randomUUID()), outbox: id('outbox', randomUUID()),
      goal_key: input.goalId, old_key: oldId, candidate_key: input.candidateTaskId,
    };
    try {
      await this.txTask<GoalAcceptanceResult>(`BEGIN;
        LET $who = SELECT * FROM ONLY $actor;
        IF $who = NONE OR $who.revoked = true OR 'manage' NOT IN $who.capabilities OR $who.role != 'gm' { THROW 'actor revoked or forbidden' };
        LET $g = SELECT * FROM ONLY $goal;
        IF $g = NONE { THROW 'goal acceptance moved: goal not found' };
        IF $g.state != 'active' { THROW 'goal acceptance moved: goal is not active' };
        IF $g.tier != 'quick' OR ($g.pipeline ?? 'software') != 'software' { THROW 'goal acceptance moved: goal is not quick software' };
        IF $g.tasks.manual != $old OR $g.tasks.acceptance != $old { THROW 'goal acceptance moved: references changed' };
        IF array::len(array::filter($g.anchors ?? [], |$a| $a != $old)) > 0 { THROW 'goal acceptance moved: anchors changed' };
        LET $o = SELECT * FROM ONLY $old;
        IF $o = NONE OR $o.state != 'void' OR $o.reviewer_role = 'owner' { THROW 'goal acceptance moved: replaced task changed' };
        LET $c = SELECT * FROM ONLY $candidate;
        IF $c = NONE OR $c.version != $cand_version { THROW 'goal acceptance moved: candidate changed' };
        IF $c.state != 'blocked' OR $c.blocked_to != NONE OR $c.submitted_by != NONE OR ($c.current_employee != NONE AND $c.lease_expires_at > time::unix(time::now())) { THROW 'goal acceptance moved: candidate is not blocked and unleased' };
        LET $unfinished = SELECT VALUE id FROM task WHERE goal = $goal AND state NOT IN ['done', 'void'] AND id != $candidate;
        IF array::len($unfinished) != array::len($expected_unfinished) OR array::len(array::filter($unfinished, |$u| $u NOT IN $expected_unfinished)) > 0 { THROW 'goal acceptance moved: unfinished goal work changed' };
        IF array::len(array::filter($unfinished, |$u| $u NOT IN ($c.dependencies ?? []))) > 0 { THROW 'goal acceptance moved: candidate misses unfinished goal work' };
        LET $dependents = SELECT VALUE id FROM task WHERE state NOT IN ['done', 'void'] AND $candidate IN (dependencies ?? []);
        IF array::len($dependents) > 0 { THROW 'goal acceptance moved: candidate would form a cycle' };
        UPDATE ONLY $goal SET tasks.manual = $candidate, tasks.acceptance = $candidate, anchors = [$candidate];
        CREATE ONLY $audit CONTENT { task: $candidate, actor: $actor, action: 'goal_acceptance_repair', evidence: $evidence, version: $c.version, at: time::now() };
        CREATE ONLY $audit_old CONTENT { task: $old, actor: $actor, action: 'goal_acceptance_replaced', evidence: $evidence_old, version: $o.version, at: time::now() };
        LET $sequence = UPDATE ONLY company_meta:outbox_counter SET value += 1 RETURN AFTER;
        CREATE ONLY $outbox CONTENT { task: $candidate, kind: 'goal_acceptance_repaired', sequence: $sequence.value, payload: { goal: $goal_key, replaced: $old_key, candidate: $candidate_key }, at: time::now() };
        CREATE ONLY $idem CONTENT { payload_digest: $digest, result: $result };
        RETURN $result;
        COMMIT;`, vars);
      return result;
    } catch (error) {
      const replayedAfterFailure = await this.replayStored<GoalAcceptanceResult>(idem, digest);
      if (replayedAfterFailure) return replayedAfterFailure;
      throw error;
    }
  }

  /**
   * gm only (manage): records the code implementer of an engineering task whose bound implementer cannot continue
   * (withdrawn, departed, durable quota or runtime failure). The task must be in execute phase. One compare-and-set
   * transaction re-checks every basis: the task version, the new implementer's role, execute capability and track,
   * and, when the new implementer is a current reviewer, a named replacement reviewer that is neither an author nor
   * the new implementer. A lease held by someone else is revoked in the same write (the fence moves, so the old
   * holder's proof is refused). Audit, outbox and the idempotency row land together. Authorship is never removed.
   */
  async implementerTakeover(credential: Credential, input: ImplementerTakeover): Promise<TaskView> {
    const actor = await this.authorized(credential, 'manage');
    if (actor.role !== 'gm') throw new CompanyError('forbidden', 'Only gm may take over a task implementer');
    requireText(input.taskId, 'taskId', 1, 200);
    requireText(input.toEmployee, 'toEmployee', 1, 200);
    requireText(input.reason, 'reason', 8, 2000);
    if (input.replacementReviewer !== undefined) requireText(input.replacementReviewer, 'replacementReviewer', 1, 200);
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) throw new CompanyError('invalid', 'Invalid expectedVersion');
    const idem = this.idemId(actor.employeeId, 'implementer_takeover', input.idempotencyKey);
    const digest = HASH(JSON.stringify({ taskId: input.taskId, toEmployee: input.toEmployee,
      replacementReviewer: input.replacementReviewer ?? '', expectedVersion: input.expectedVersion, reason: input.reason }));
    const prior = await this.replay(idem, digest);
    if (prior) return prior;
    const current = await this.db.select<TaskRow>(id('task', input.taskId));
    if (!current) throw new CompanyError('not_found', 'Task not found');
    if (current.executor_role !== 'engineering') {
      throw new CompanyError('invalid', 'implementer takeover invalid: only engineering tasks have a code implementer');
    }
    const facts = await readContributors(this.db, input.taskId);
    if (input.toEmployee === facts.implementer) throw new CompanyError('invalid', 'implementer takeover invalid: employee is already the implementer');
    if (facts.reviewers.includes(input.toEmployee) && !input.replacementReviewer) {
      throw new CompanyError('invalid', 'implementer takeover invalid: a current reviewer becoming implementer needs a named independent replacement reviewer');
    }
    if (input.replacementReviewer && (input.replacementReviewer === input.toEmployee || facts.excluded.includes(input.replacementReviewer))) {
      throw new CompanyError('invalid', 'implementer takeover invalid: replacement reviewer must be independent of every author');
    }
    const evidence = `${input.reason}\n[implementer_takeover] task=${input.taskId} from=${facts.implementer ?? 'none'} to=${input.toEmployee} replacementReviewer=${input.replacementReviewer ?? 'none'} expectedVersion=${input.expectedVersion}`;
    const query = `BEGIN;
      LET $now = time::unix(time::now());
      LET $who = SELECT * FROM ONLY $actor;
      IF $who = NONE OR $who.revoked = true OR 'manage' NOT IN $who.capabilities OR $who.role != 'gm' { THROW 'actor revoked or forbidden' };
      LET $t = SELECT * FROM ONLY $task;
      IF $t = NONE { THROW 'implementer takeover invalid: task not found' };
      IF $t.version != $expected { THROW 'implementer takeover moved: task version changed' };
      IF $t.state NOT IN ['ready', 'doing', 'blocked'] { THROW 'implementer takeover moved: task is not in execute phase' };
      LET $to = SELECT * FROM ONLY $target;
      IF $to = NONE OR $to.revoked = true OR 'execute' NOT IN $to.capabilities OR $to.role != $t.executor_role { THROW 'implementer takeover invalid: target employee cannot execute this task' };
      LET $to_tracks = $to.def.tracks ?? [];
      IF $t.discipline != NONE AND array::len($to_tracks) > 0 AND $t.discipline NOT IN $to_tracks { THROW 'implementer takeover invalid: target employee track does not cover the task' };
      IF $replacement != NONE {
        LET $rep = SELECT * FROM ONLY $replacement;
        IF $rep = NONE OR $rep.revoked = true OR 'review' NOT IN $rep.capabilities OR $rep.role != $t.reviewer_role { THROW 'implementer takeover invalid: replacement reviewer cannot review this task' };
        IF $rep.id IN $excluded_ids { THROW 'implementer takeover invalid: replacement reviewer must be independent of every author' };
      };
      LET $holder = $t.current_employee;
      LET $next = UPDATE ONLY $task SET
        implementer = $target_key,
        current_employee = NONE,
        delivery_id = NONE,
        lease_expires_at = NONE,
        fence = IF $holder != NONE THEN $t.fence + 1 ELSE $t.fence END,
        version = $t.version + 1
        RETURN AFTER;
      IF $holder != NONE { UPDATE employee SET active_task = NONE WHERE active_task = $task };
      CREATE ONLY $audit CONTENT { task: $task, actor: $actor, action: 'implementer_takeover', evidence: $evidence, version: $next.version, at: time::now() };
      LET $sequence = UPDATE ONLY company_meta:outbox_counter SET value += 1 RETURN AFTER;
      CREATE ONLY $outbox CONTENT { task: $task, kind: 'implementer_takeover', sequence: $sequence.value, payload: { version: $next.version, implementer: $target_key }, at: time::now() };
      CREATE ONLY $idem CONTENT { payload_digest: $digest, result: $next };
      RETURN $next;
      COMMIT;`;
    const vars = {
      actor: id('employee', actor.employeeId), task: id('task', input.taskId), expected: input.expectedVersion,
      target: id('employee', input.toEmployee), target_key: input.toEmployee,
      replacement: input.replacementReviewer ? id('employee', input.replacementReviewer) : undefined,
      excluded_ids: [...new Set([...facts.excluded, input.toEmployee])].map(employee => id('employee', employee)),
      evidence, digest, idem, audit: id('audit', randomUUID()), outbox: id('outbox', randomUUID()),
    };
    try {
      return view(await this.txTask<TaskRow>(query, vars));
    } catch (error) {
      const replayedAfterFailure = await this.replay(idem, digest);
      if (replayedAfterFailure) return replayedAfterFailure;
      throw error;
    }
  }

  /**
   * Shared read path for the preview and the repair gate: loads the goal, its references, the unfinished
   * goal work and the candidate; evaluates every acceptance rule; and hashes the basis the repair compares
   * against. Reads only.
   */
  private async goalAcceptanceState(goalId: string, candidateTaskId?: string, expectedOldTaskId?: string): Promise<GoalAcceptanceState> {
    const goalRef = id('goal', goalId);
    const goal = await this.db.select<GoalAcceptanceGoalRow>(goalRef);
    if (!goal) throw new CompanyError('not_found', 'goal not found');
    const refs = goal.tasks ?? {};
    const manualId = refs.manual ? asId(refs.manual) : undefined;
    const acceptanceId = refs.acceptance ? asId(refs.acceptance) : undefined;
    const anchorIds = (goal.anchors ?? []).map(asId);
    const oldId = manualId ?? acceptanceId;
    const referenced = [...new Set([manualId, acceptanceId, ...anchorIds])].filter((x): x is string => Boolean(x));
    const [referencedRows] = await this.db.query<[GoalAcceptanceTaskRow[]]>(
      `SELECT ${GOAL_ACCEPTANCE_TASK_FIELDS} FROM task WHERE id IN $ids;`, { ids: referenced.map(x => id('task', x)) });
    const oldRow = oldId ? (referencedRows ?? []).find(row => asId(row.id) === oldId) : undefined;
    const [unfinishedRows] = await this.db.query<[GoalAcceptanceTaskRow[]]>(
      `SELECT ${GOAL_ACCEPTANCE_TASK_FIELDS} FROM task WHERE goal = $goal AND state NOT IN ['done', 'void'] ORDER BY id;`, { goal: goalRef });
    const [ownerRows] = await this.db.query<[Array<{ id: RecordId }>]>(
      "SELECT id FROM task WHERE goal = $goal AND reviewer_role = 'owner' AND state != 'done';", { goal: goalRef });
    const candidate = candidateTaskId ? await this.db.select<GoalAcceptanceTaskRow>(id('task', candidateTaskId)) : undefined;
    const candidateDeps = (candidate?.dependencies ?? []).map(asId);
    type DepRow = { id: RecordId; goal?: RecordId; state: TaskState; reviewer_role: ReviewerRole };
    const depRows = candidateDeps.length
      ? (await this.db.query<[DepRow[]]>('SELECT id, goal, state, reviewer_role FROM task WHERE id IN $deps;',
          { deps: candidateDeps.map(x => id('task', x)) }))[0] ?? []
      : [];
    const depById = new Map(depRows.map(row => [asId(row.id), row] as const));
    // A dependency path back to the candidate would make it wait on itself.
    let cycle = false;
    if (candidate && candidateTaskId && candidateDeps.length) {
      const seen = new Set<string>(candidateDeps);
      let frontier = candidateDeps;
      while (frontier.length && !cycle) {
        const [rows] = await this.db.query<[Array<{ dependencies?: RecordId[] }>]>(
          'SELECT dependencies FROM task WHERE id IN $ids;', { ids: frontier.map(x => id('task', x)) });
        const next = (rows ?? []).flatMap(row => (row.dependencies ?? []).map(asId));
        if (next.includes(candidateTaskId)) cycle = true;
        frontier = [...new Set(next)].filter(x => !seen.has(x));
        for (const x of frontier) seen.add(x);
      }
    }

    const unfinishedIds = unfinishedRows.map(row => asId(row.id)).filter(x => x !== candidateTaskId);
    const missing = candidate ? unfinishedIds.filter(x => !candidateDeps.includes(x)) : [];
    const checks: GoalAcceptanceCheck[] = [];
    const deny = (code: GoalAcceptanceCheck['code'], message: string) => { checks.push({ code, message }); };
    const pipeline = goal.pipeline ?? 'software';
    const project = goal.project ? asId(goal.project) : undefined;
    if (goal.state !== 'active') deny('conflict', `goal is ${goal.state}, not active`);
    if (goal.tier !== 'quick') deny('invalid', 'goal tier must be quick');
    if (pipeline !== 'software') deny('invalid', 'goal pipeline must be software');
    if (!oldId) deny('conflict', 'goal has no manual or acceptance reference');
    if (manualId !== acceptanceId) deny('conflict', 'manual and acceptance must reference the same task');
    if (expectedOldTaskId !== undefined && expectedOldTaskId !== oldId) deny('conflict', 'goal acceptance reference moved: expected task differs');
    if (oldId && !oldRow) deny('not_found', 'replaced acceptance task not found');
    if (oldRow) {
      if (oldRow.state !== 'void') deny('conflict', `replaced acceptance task must be void, found ${oldRow.state}`);
      if (oldRow.reviewer_role === 'owner') deny('invalid', 'owner-reviewed acceptance is not repaired by this tool');
    }
    if (anchorIds.some(anchor => anchor !== oldId)) deny('conflict', 'goal anchors name tasks other than the replaced acceptance');
    if (ownerRows.length) deny('invalid', 'goal has an owner acceptance gate; this repair does not apply');
    if (!candidateTaskId) deny('invalid', 'candidateTaskId is required');
    else if (!candidate) deny('not_found', 'candidate task not found');
    else {
      if (candidateTaskId === oldId) deny('invalid', 'candidate must differ from the replaced task');
      if (!candidate.goal || asId(candidate.goal) !== goalId) deny('invalid', 'candidate belongs to another goal');
      if ((candidate.project ? asId(candidate.project) : undefined) !== project) deny('invalid', 'candidate project must match the goal project');
      if ((candidate.kind ?? 'task') !== 'task') deny('invalid', 'candidate must be kind task');
      if (candidate.executor_role !== 'product' || candidate.reviewer_role !== 'gm') {
        deny('invalid', 'candidate must be executed by product and reviewed by gm');
      }
      if (candidate.state !== 'blocked') deny('conflict', `candidate must be blocked, found ${candidate.state}`);
      if (candidate.blocked_to) deny('conflict', 'candidate is blocked to gm or owner');
      if (candidate.submitted_by) deny('conflict', 'candidate already has a submission');
      if (isLeased(candidate)) deny('conflict', 'candidate holds an active lease');
      if (candidateDeps.includes(candidateTaskId)) deny('invalid', 'candidate must not depend on itself');
      for (const dep of candidateDeps) {
        const row = depById.get(dep);
        if (!row) deny('not_found', `candidate dependency ${dep} not found`);
        else if (!row.goal || asId(row.goal) !== goalId) deny('invalid', `candidate dependency ${dep} is outside the goal`);
        else if (row.reviewer_role === 'owner' && row.state !== 'done') deny('invalid', `candidate depends on unapproved owner gate ${dep}`);
      }
      if (missing.length) deny('invalid', `candidate does not depend on unfinished goal work: ${missing.join(', ')}`);
      if (cycle) deny('invalid', 'candidate would form a dependency cycle');
    }

    const hash = HASH(JSON.stringify({
      v: 1,
      goal: { id: goalId, state: goal.state, tier: goal.tier ?? null, pipeline, project: project ?? null,
        manual: manualId ?? null, acceptance: acceptanceId ?? null, anchors: [...anchorIds].sort() },
      replaced: oldRow ? { id: oldId, state: oldRow.state, executor: oldRow.executor_role, reviewer: oldRow.reviewer_role } : null,
      candidate: candidate && candidateTaskId ? { id: candidateTaskId, state: candidate.state, version: candidate.version,
        executor: candidate.executor_role, reviewer: candidate.reviewer_role, kind: candidate.kind ?? 'task',
        goal: candidate.goal ? asId(candidate.goal) : null, project: candidate.project ? asId(candidate.project) : null,
        blockedTo: candidate.blocked_to ?? null, submitted: Boolean(candidate.submitted_by), leased: isLeased(candidate),
        dependencies: [...candidateDeps].sort() } : null,
      unfinished: [...unfinishedIds].sort(),
      ownerGates: (ownerRows ?? []).map(row => asId(row.id)).sort(),
    }));
    const view: GoalAcceptanceView = {
      goal: {
        id: goalId, title: goal.title, state: goal.state as GoalView['state'], tier: goal.tier as GoalTier | undefined,
        pipeline, project,
        tasks: Object.fromEntries(Object.entries(refs).filter(([, ref]) => ref).map(([key, ref]) => [key, asId(ref!)])),
        anchors: anchorIds,
      },
      replaced: oldRow ? briefTask(oldRow) : undefined,
      unfinished: unfinishedRows.filter(row => asId(row.id) !== candidateTaskId).map(briefTask),
      candidate: candidate && candidateTaskId ? { ...briefTask(candidate), missing } : undefined,
      diff: {
        manual: { from: manualId, to: candidateTaskId ?? manualId },
        acceptance: { from: acceptanceId, to: candidateTaskId ?? acceptanceId },
        anchors: { from: anchorIds, to: candidateTaskId ? [candidateTaskId] : anchorIds },
      },
      violations: checks.map(check => ({ code: check.code, message: check.message })),
      ready: checks.length === 0,
      snapshot: { version: 1, hash },
    };
    return { view, checks, hash, candidate: candidate && candidateTaskId ? candidate : undefined, oldId, unfinishedIds };
  }

  private async replayStored<T>(ident: RecordId, payloadDigest: string): Promise<T | undefined> {
    const prior = await this.db.select<{ payload_digest: string; result: T }>(ident);
    if (!prior) return undefined;
    if (prior.payload_digest !== payloadDigest) throw new CompanyError('conflict', 'Idempotency key reused with different input');
    return prior.result;
  }

  /**
   * gm only: rebind a blocked task to a registered project (task-level override over goal.project).
   * The controlled unblock path for tasks stuck on the wrong repo: version-guarded, idempotent,
   * fully audited. Only stopped, un-leased, never-submitted blocked tasks qualify; owner-blocked
   * tasks are refused so a rebind can never bypass an owner gate. The stale worktree assignment
   * is cleared (worktree_ref turns 'released' through its own ref state logic — the physical
   * tree is left for the normal reclaim lifecycle, never deleted here), and the next legitimate
   * claim allocates a fresh task branch in the target repo.
   */
  async taskProjectUpdate(credential: Credential, input: { taskId: TaskId; project: string; expectedVersion: number; text: string; idempotencyKey: string }): Promise<TaskView> {
    const actor = await this.authorized(credential, 'manage');
    if (actor.role !== 'gm') throw new CompanyError('forbidden', 'Only gm may rebind task projects');
    requireText(input.taskId, 'task', 1, 200);
    requireText(input.project, 'project', 1, 60);
    requireText(input.text, 'evidence', 4, 4000);
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) throw new CompanyError('invalid', 'Invalid expectedVersion');
    // Registered projects only; a typo must fail loudly instead of silently unbinding.
    if (!(await this.projects.get(input.project))) throw new CompanyError('not_found', `project ${input.project} not found`);
    const idem = this.idemId(actor.employeeId, 'task_project_update', input.idempotencyKey);
    const digest = HASH(JSON.stringify({ taskId: input.taskId, project: input.project, expectedVersion: input.expectedVersion, text: input.text }));
    const replay = await this.replay(idem, digest);
    if (replay) return replay;
    try {
      const row = await this.txTask(`BEGIN;
        LET $t = SELECT * FROM ONLY $task;
        IF $t = NONE { THROW 'task not found' };
        IF $t.version != $expected { THROW 'task changed' };
        IF $t.state != 'blocked' { THROW 'rebind denied: only blocked tasks can be rebound' };
        IF $t.blocked_to = 'owner' { THROW 'rebind denied: owner blocked task' };
        IF $t.submitted_by != NONE { THROW 'rebind denied: task has submitted results' };
        IF $t.current_employee != NONE AND $t.lease_expires_at > time::unix(time::now()) { THROW 'rebind denied: active lease' };
        LET $next = UPDATE ONLY $task SET
          project = $project, worktree = NONE, current_employee = NONE, delivery_id = NONE,
          lease_expires_at = NONE, handover = NONE, version = $t.version + 1 RETURN AFTER;
        UPDATE employee SET active_task = NONE WHERE active_task = $task;
        CREATE ONLY $audit CONTENT { task: $task, actor: $actor, action: 'task_project_update', evidence: $evidence, version: $next.version, at: time::now() };
        LET $sequence = UPDATE ONLY company_meta:outbox_counter SET value += 1 RETURN AFTER;
        CREATE ONLY $outbox CONTENT { task: $task, kind: 'task_project_updated', sequence: $sequence.value, payload: { project: $project_id, version: $next.version }, at: time::now() };
        CREATE ONLY $idem CONTENT { payload_digest: $digest, result: $next };
        RETURN $next;
        COMMIT;`, {
        actor: id('employee', actor.employeeId), task: id('task', input.taskId),
        project: id('project', input.project), project_id: input.project,
        expected: input.expectedVersion, evidence: input.text,
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
   * gm only: bind an explicit code repository (code_repo_path) to a blocked execute-phase task.
   * Only workspace allocation, worktree registration and dispatch repoHome/cwd follow the
   * binding — the business project (taskProject → claim.json.project, opsScope, broker
   * quotas) is untouched, so a rebind can never smuggle another project's ops access.
   *
   * Allowed targets: the ops repo or a registered project repo_path, canonicalised —
   * symlink escapes, traversal segments and unregistered paths are refused before any write.
   * Only state=blocked tasks qualify: blocked_to='gm' and the formal dependency wait
   * (blocked_to=NONE, including defer_task_until's cleared-gm wait) both bind; owner gates
   * and review-phase blocks are refused, not guessed, as are live leases. The stale worktree
   * assignment clears through the same lifecycle as task_project_update: the ref releases,
   * uncommitted work in the old tree is preserved, and the tree itself is never deleted here.
   */
  async bindTaskCodeRepo(credential: Credential, input: { taskId: TaskId; codeRepoPath: string; expectedVersion: number; text: string; idempotencyKey: string }): Promise<TaskView> {
    const actor = await this.authorized(credential, 'manage');
    if (actor.role !== 'gm') throw new CompanyError('forbidden', 'Only gm may bind a task code repo');
    requireText(input.taskId, 'task', 1, 200);
    requireText(input.codeRepoPath, 'codeRepoPath', 1, 1000);
    requireText(input.text, 'evidence', 4, 4000);
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
      throw new CompanyError('invalid', 'Invalid expectedVersion');
    }
    if (!isAbsolute(input.codeRepoPath) || input.codeRepoPath.includes('\0') || input.codeRepoPath.split('/').includes('..')) {
      throw new CompanyError('invalid', 'codeRepoPath must be an absolute path without traversal');
    }
    const bound = canonicalRepoPath(input.codeRepoPath);
    const allowed = await this.allowedCodeRepos();
    if (!allowed.has(bound)) {
      throw new CompanyError('forbidden', 'codeRepoPath is not a registered project repo or the ops repo');
    }
    const before = await this.db.select<TaskRow>(id('task', input.taskId));
    if (!before) throw new CompanyError('not_found', 'Task not found');
    const idem = this.idemId(actor.employeeId, 'bind_task_code_repo', input.idempotencyKey);
    const digest = HASH(JSON.stringify({ taskId: input.taskId, codeRepoPath: bound, expectedVersion: input.expectedVersion, text: input.text }));
    const replay = await this.replay(idem, digest);
    if (replay) return replay;
    const evidence = `${input.text}\n[bind] code_repo_path: ${before.code_repo_path ?? '-'} -> ${bound}`;
    try {
      const row = await this.txTask(`BEGIN;
        LET $t = SELECT * FROM ONLY $task;
        IF $t = NONE { THROW 'task not found' };
        IF $t.version != $expected { THROW 'task version moved' };
        IF $repo NOT IN $allowed { THROW 'bind denied: repo not registered' };
        IF $t.state != 'blocked' { THROW 'bind denied: only blocked tasks can be rebound' };
        IF $t.blocked_to = 'owner' { THROW 'bind denied: owner blocked task' };
        IF $t.resume_state = 'review' { THROW 'bind denied: review-phase task' };
        IF $t.current_employee != NONE AND $t.lease_expires_at > time::unix(time::now()) { THROW 'bind denied: active lease' };
        LET $next = UPDATE ONLY $task SET
          code_repo_path = $repo, worktree = NONE, current_employee = NONE, delivery_id = NONE,
          lease_expires_at = NONE, handover = NONE, version = $t.version + 1 RETURN AFTER;
        UPDATE employee SET active_task = NONE WHERE active_task = $task;
        CREATE ONLY $audit CONTENT { task: $task, actor: $actor, action: 'bind_task_code_repo', evidence: $evidence, version: $next.version, at: time::now() };
        LET $sequence = UPDATE ONLY company_meta:outbox_counter SET value += 1 RETURN AFTER;
        CREATE ONLY $outbox CONTENT { task: $task, kind: 'code_repo_bound', sequence: $sequence.value,
          payload: { old_repo: $old_repo, new_repo: $repo, version: $next.version }, at: time::now() };
        CREATE ONLY $idem CONTENT { payload_digest: $digest, result: $next };
        RETURN $next;
        COMMIT;`, {
        actor: id('employee', actor.employeeId), task: id('task', input.taskId),
        repo: bound, allowed: [...allowed], old_repo: before.code_repo_path ?? null,
        expected: input.expectedVersion, evidence,
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
