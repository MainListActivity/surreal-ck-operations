/** v1 core/adapter boundary. The MCP adapter supplies an opaque credential on every call. */
/** 'eval' is a workforce-only judge role: it reads task history and writes scorecards, never claims tasks. */
export type Role = 'gm' | 'product' | 'engineering' | 'ai-content' | 'concept-design' | 'asset-production' | 'screenwriter' | 'qa' | 'cs' | 'eval';
/** 'void' is terminal: retired work never re-enters dispatch and counts as satisfied in dependency evaluation. */
export type TaskState = 'blocked' | 'ready' | 'doing' | 'review' | 'done' | 'void';
/** 'owner' is the human company owner; only owner decisions can accept an owner-reviewed gate. */
export type ReviewerRole = Role | 'owner';
/** release：上线申请，由运营（或 Jev）决定是否上线；deploy：合入部署，由 qa 在生产实测验收。 */
export type TaskKind = 'goal' | 'task' | 'gate' | 'release' | 'deploy';
/** quick：小开发任务，运营验收即结束；standard：经理拆解，老板终验；program：先做范围提案的大目标。 */
export type GoalTier = 'quick' | 'standard' | 'program';
export type EmployeeId = string;
export type TaskId = string;
export type DeliveryId = string;
export type Credential = string;

/** Managed authorization; supplied by task creation, never inferred from prose. */
export interface WorkIntent { kind: 'read' | 'code' | 'assets'; paths?: string[]; lane?: string }
export interface WorktreeAssignment {
  id: string; repo: string; project?: string; worktreePath: string;
  mode: 'shared' | 'exclusive' | 'protected'; branch?: string;
  intent: WorkIntent; discipline: string;
}
export interface WorktreeView extends Omit<WorktreeAssignment, 'intent' | 'discipline'> {
  createdAt: string; lastUsedAt: string; status: 'present' | 'missing' | 'drift';
  references: Array<{ taskId: string; employee: string; deliveryId: string; fence: number;
    intent: WorkIntent; state: 'active' | 'recovery' | 'released'; at: string }>;
  deletable: boolean; reasons: string[];
}

export interface Principal {
  employeeId: EmployeeId;
  role: Role;
  capabilities: readonly ('execute' | 'review' | 'manage')[];
  /** Discipline tracks of the employee's definition; empty/absent accepts every track. */
  tracks?: string[];
}

export interface TaskView {
  id: TaskId;
  title: string;
  context: string;
  state: TaskState;
  executorRole: Role;
  reviewerRole: ReviewerRole;
  /** Project-scoped discipline track (e.g. 编剧/分镜): only defs whose `tracks` list covers it may claim. */
  discipline?: string;
  kind: TaskKind;
  goalId?: string;
  /** Task-level project override (takes precedence over goal.project); undefined keeps the goal routing. */
  projectOverlay?: string;
  dependencies: TaskId[];
  version: number;
  submittedBy?: EmployeeId;
  currentEmployee?: EmployeeId;
  deliveryId?: DeliveryId;
  leaseExpiresAt?: string;
  fence: number;
  blockedTo?: 'gm' | 'owner';
  /** Set when the previous holder's lease was revoked; the next holder must read the handover history. */
  handover?: boolean;
  previousEmployee?: EmployeeId;
  workIntent?: WorkIntent;
  worktree?: WorktreeAssignment;
}

export interface HistoryEntry {
  action: string;
  actor: string;
  evidence?: string;
  version?: number;
  at: string;
}

export interface CreateTask {
  title: string;
  context: string;
  executorRole: Role;
  reviewerRole: ReviewerRole;
  /** Optional discipline track; when the task's project (override, else the goal's) defines a non-empty `disciplines` vocabulary the value must be in it. */
  discipline?: string;
  kind?: Exclude<TaskKind, 'goal'>;
  goalId?: string;
  /** Optional project override: registered project id only; takes precedence over goal.project for this task. */
  project?: string;
  dependencies?: TaskId[];
  idempotencyKey: string;
  workIntent?: WorkIntent;
}

export interface ClaimResult {
  task: TaskView;
  deliveryId: DeliveryId;
  fence: number;
  leaseExpiresAt: string;
  /** Prior claims, checkpoints, returns, owner decisions and revocation handovers for this task. */
  history: HistoryEntry[];
  /** Earlier holders of this task with their Paseo session IDs; the successor can pull full transcripts. */
  predecessors?: SessionRef[];
  /** Project environment of the task's goal: where it ships, how to verify, red lines. Credentials are never part of it. */
  project?: ProjectView;
  worktree?: WorktreeAssignment;
}

/** Result of the ops broker gate; `project` is the id of the project the task's goal belongs to. */
export interface OpsScope {
  actor: Principal;
  taskId: TaskId;
  project: string;
}

export interface SessionRef {
  employee: string;
  agentId?: string;
  provider?: string;
  role?: string;
  retired?: boolean;
}

export interface ProjectView {
  id: string;
  name: string;
  repoPath: string;
  defaultBranch: string;
  release: string;
  rollback?: string;
  redLines: string[];
  /** Discipline tracks this project uses (e.g. 编剧/角色设计); non-empty means task.discipline is validated against it. */
  disciplines?: Array<{ name: string; description?: string }>;
  runbooks: string[];
  notes?: string;
  envs: Array<{ name: string; url?: string; healthUrl?: string; verify?: string; secrets: Array<{ name: string; roles: Role[] }> }>;
}

export interface CreateDelivery {
  goalId: string;
  title: string;
  /** What to build and the acceptance criteria qa verifies in production. */
  spec: string;
  /** Optional discipline track; carried by the implementation leg only, release/deploy legs stay untracked. */
  discipline?: string;
  /** Optional project override persisted on all three legs so the chain stays on one project. */
  project?: string;
  dependencies?: TaskId[];
  idempotencyKey: string;
}

/** gm only: re-point an execute-phase gm block at unmet dependencies instead of the manager. */
export interface DeferTaskUntil {
  taskId: TaskId;
  /** Dependencies to merge into the task's existing set (union, same goal, acyclic). */
  dependencies: TaskId[];
  /** Business reason for the wait; audited together with the before/after dependency snapshot. */
  text: string;
  idempotencyKey: string;
  /** Optimistic concurrency: refuse when the task version has moved. */
  expectedVersion?: number;
}

/** gm/product: retire a task to the terminal 'void' state; dependents stop waiting on it. */
export interface RetireTask {
  taskId: TaskId;
  /** Business reason for the retirement; audited together with the before-state snapshot. */
  text: string;
  idempotencyKey: string;
  /** Optimistic concurrency: refuse when the task version has moved. */
  expectedVersion?: number;
}

/** deliveryId + fence are mandatory for every write after claim. */
export interface LeaseProof {
  taskId: TaskId;
  deliveryId: DeliveryId;
  fence: number;
  expectedVersion: number;
}

export interface Evidence {
  text: string;
  idempotencyKey: string;
}

export interface OutboxEvent {
  id: string;
  sequence: number;
  kind: string;
  taskId: TaskId;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface CompanyCore {
  authenticate(credential: Credential): Promise<Principal>;
  listTasks(credential: Credential, state?: TaskState): Promise<TaskView[]>;
  getTask(credential: Credential, taskId: TaskId): Promise<TaskView>;
  createTask(credential: Credential, input: CreateTask): Promise<TaskView>;
  claim(credential: Credential, taskId: TaskId): Promise<ClaimResult>;
  /** Optional for old adapters; production cores expose authenticated inventory. `project` anchors a project-scoped workspace for task-less dispatches (goal triage); taskId wins when both are given. */
  readWorkspace?(credential: Credential, taskId?: TaskId, project?: string): Promise<WorktreeAssignment | undefined>;
  releaseWorkspace?(credential: Credential): Promise<void>;
  listWorktrees?(credential: Credential, taskId?: TaskId): Promise<WorktreeView[]>;
  /** GM: ownership reclaim or dry-run across registered repos (WT02). */
  reclaimWorktrees?(credential: Credential, input?: { dryRun?: boolean; repos?: string[] }): Promise<{
    scanId: string; removed: string[]; kept: Array<{ path: string; reason: string }>;
    branchesDeleted: string[]; branchesRetained: Array<{ branch: string; reason: string }>; audited: number;
  }>;
  listWorktreeAudits?(credential: Credential, limit?: number): Promise<Array<Record<string, unknown>>>;
  heartbeat(credential: Credential, proof: LeaseProof): Promise<ClaimResult>;
  checkpoint(credential: Credential, proof: LeaseProof, evidence: Evidence): Promise<TaskView>;
  submit(credential: Credential, proof: LeaseProof, evidence: Evidence): Promise<TaskView>;
  accept(credential: Credential, proof: LeaseProof, evidence: Evidence): Promise<TaskView>;
  returnTask(credential: Credential, proof: LeaseProof, evidence: Evidence): Promise<TaskView>;
  /**
   * Channel-side claim rollback (spawn/wake failure, workspace handoff): drops the holder's
   * lease without a reviewer verdict — a review task stays in review, a doing task returns to
   * ready, and the audit row is 'released', never 'return'. Optional: cores without it simply
   * let the lease expire, which already leaves review tasks claimable.
   */
  release?(credential: Credential, proof: LeaseProof, evidence: Evidence): Promise<TaskView>;
  block(credential: Credential, proof: LeaseProof, to: 'gm' | 'owner', evidence: Evidence): Promise<TaskView>;
  resume(credential: Credential, taskId: TaskId, evidence: Evidence): Promise<TaskView>;
  /** gm only: an execute-phase gm block becomes a dependency wait — stays blocked for the dispatcher, auto-resumes on the last dependency finishing. */
  deferTaskUntil(credential: Credential, input: DeferTaskUntil): Promise<TaskView>;
  /** gm/product: mark a task 'void' (terminal), release any lease on it, and unlock dependents that were waiting only on it. */
  retireTask(credential: Credential, input: RetireTask): Promise<TaskView>;
  listOutbox(credential: Credential, after?: string): Promise<OutboxEvent[]>;
  history(credential: Credential, taskId: TaskId): Promise<HistoryEntry[]>;
  companyBrief(credential: Credential): Promise<CompanyBrief>;
  /** gm relays an owner instruction received in a direct conversation; audited as gm-relayed. */
  relayGoal(credential: Credential, input: { text: string; ownerQuote: string; idempotencyKey: string; tier?: GoalTier; project?: string }): Promise<GoalView>;
  /** gm: pick the flow template for a goal waiting in triage. */
  triageGoal(credential: Credential, input: { goalId: string; tier: GoalTier; reason: string }): Promise<GoalView>;
  /** gm/product: one call creates 实现 → 上线申请 → 合入部署与生产实测 for a code change. */
  createDelivery(credential: Credential, input: CreateDelivery): Promise<TaskView[]>;
  /**
   * gm only: rebind a blocked task to a registered project (task-level override over goal.project).
   * Version-guarded, idempotent, fully audited; releases the stale worktree assignment through the
   * normal lifecycle (the physical tree itself is never deleted here).
   */
  taskProjectUpdate?(credential: Credential, input: { taskId: TaskId; project: string; expectedVersion: number; text: string; idempotencyKey: string }): Promise<TaskView>;
  /** manage (gm/product): list every employee_def row for workforce review. */
  listDefs(credential: Credential): Promise<DefView[]>;
  /** manage (gm/product): create or update an employee_def via the shared workforce writer; audited. */
  ensureDef(credential: Credential, input: EnsureDef): Promise<DefView>;
  /** manage (gm/product): replace only the project's disciplines vocabulary; audited. */
  updateProjectDisciplines(credential: Credential, input: { project: string; disciplines: Array<{ name: string; description?: string }> }): Promise<ProjectView>;
  /** Ops broker gate: the caller must hold the task's current lease and the task's goal must name a project. */
  opsScope(credential: Credential, taskId: TaskId): Promise<OpsScope>;
  /** Appends a secret-free `ops_*` record to the task's audit trail. Only `ops_call` rows stay out of handover history. */
  auditOps(scope: OpsScope, action: string, evidence: string): Promise<void>;
  /** How many `action` audit rows tasks of this project wrote in the last `windowSeconds`; backs broker quotas. */
  opsCount(project: string, action: string, windowSeconds: number): Promise<number>;
  relayOwnerDecision(credential: Credential, input: OwnerDecisionInput & { ownerQuote: string }): Promise<TaskView>;
  relayDirection(credential: Credential, input: { text: string; ownerQuote: string; idempotencyKey: string }): Promise<void>;
  /** eval role only: score every employee who participated in a finished task. Marks the task evaluated. */
  recordScore(credential: Credential, input: { taskId: TaskId; summary: string; scores: EmployeeScore[] }): Promise<{ recorded: number; participants: string[] }>;
}

/** Employee definition as returned by the manage tools (score internals stay server-side). */
export interface DefView {
  id: string;
  role: Role;
  provider: string;
  model: string;
  thinking?: string;
  tracks?: string[];
  enabled: boolean;
  maxInstances: number;
  priority: number;
  weight: number;
}

/**
 * def_ensure input. `tracks` sent as [] clears the track list, omitted leaves it untouched;
 * `enabled: false` disables the def (retire/track-revocation requests). `role` must be a
 * valid Role including eval; other omitted fields reuse the workforce upsert defaults.
 */
export interface EnsureDef {
  id: string;
  role: Role;
  provider: string;
  model: string;
  thinking?: string;
  tracks?: string[];
  maxInstances?: number;
  priority?: number;
  weight?: number;
  enabled?: boolean;
}

export interface EmployeeScore {
  employee: EmployeeId;
  quality: number;
  evidence: number;
  discipline: number;
  timeliness: number;
  overall: number;
  notes?: string;
}

/**
 * Provider model slots: "<provider>:<family>" → concrete model id.
 * The Paseo plugin refreshes this from providers.listModels; a def whose model
 * is "auto:<family>" resolves through this map, so upstream version bumps reach
 * new spawns without an edit. Literal model ids bypass the map (pinning).
 */
export type ModelSlots = Record<string, string>;

export interface ProviderQuota {
  provider: string;
  /** Human-readable remaining quota, e.g. "5h 窗口剩 41%（15:00 重置）；余额 $3.2/$10 credits"。 */
  summary: string;
  /** Lowest remaining percentage across all usage windows and balances (0-100); undefined when the provider reports no numbers. */
  lowestPct?: number;
  /** Lowest remaining percentage among short windows (e.g. session/5h) and balances. */
  sessionPct?: number;
  /** Lowest remaining percentage among long windows (week/month/billing cycle). */
  weeklyPct?: number;
  status?: string;
  fetchedAt?: string;
}

export type OwnerDecision = 'approve' | 'reject' | 'reply';
export interface OwnerDecisionInput {
  taskId: TaskId;
  decision: OwnerDecision;
  note: string;
  idempotencyKey: string;
}

export interface GoalView {
  id: string;
  title: string;
  brief: string;
  state: 'triage' | 'active' | 'done' | 'cancelled';
  tier?: GoalTier;
  project?: string;
  /** Repo of the linked project, joined by triagePending; anchors the gm triage session's workspace. */
  repoPath?: string;
  /** manual is the 运营验收 anchor; acceptance closes the goal (G3 for standard/program, 运营验收 for quick). */
  tasks: { intake?: TaskId; plan?: TaskId; manual?: TaskId; acceptance?: TaskId };
}

export interface CompanyBrief {
  directions: { text: string; source: string; at: string }[];
  goals: GoalView[];
  projects: ProjectView[];
  paused: boolean;
}

/** Administrative enrollment is deliberately outside the MCP adapter. */
export interface EnrollmentAdmin {
  enroll(employeeId: EmployeeId, role: Role, capabilities: Principal['capabilities']): Promise<Credential>;
  revoke(employeeId: EmployeeId): Promise<void>;
}
