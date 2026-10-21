/** v1 core/adapter boundary. The MCP adapter supplies an opaque credential on every call. */
/** 'eval' is a workforce-only judge role: it reads task history and writes scorecards, never claims tasks. */
export type Role = 'gm' | 'product' | 'engineering' | 'ai-content' | 'concept-design' | 'asset-production' | 'screenwriter' | 'story-author' | 'cinematography' | 'qa' | 'cs' | 'eval';
export const ROLES: readonly Role[] = ['gm', 'product', 'engineering', 'ai-content', 'concept-design', 'asset-production', 'screenwriter', 'story-author', 'cinematography', 'qa', 'cs', 'eval'];
/** 'void' is terminal: retired work never re-enters dispatch and counts as satisfied in dependency evaluation. */
export type TaskState = 'blocked' | 'ready' | 'doing' | 'review' | 'done' | 'void';
/** Trusted retirement type, set only by server-side callers (session rotation, scene archive, failures),
 * never taken from a free-text reason. rotation and archive end a session normally; failure and manual do not. */
export type RetirementKind = 'rotation' | 'archive' | 'failure' | 'manual';
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
  /** "<goal id>:<lane name>" when the tree belongs to a lane shared by every task of that lane. */
  lane?: string;
  intent: WorkIntent; discipline: string;
}
export interface WorktreeView extends Omit<WorktreeAssignment, 'intent' | 'discipline'> {
  createdAt: string; lastUsedAt: string; status: 'present' | 'missing' | 'drift';
  references: Array<{ taskId: string; employee: string; deliveryId: string; fence: number;
    intent: WorkIntent; state: 'active' | 'recovery' | 'released'; at: string }>;
  deletable: boolean; reasons: string[];
}

/** A writer or reader that holds a worktree, or an overlapping asset path, a new code claim must wait for. */
export interface WriteScopeHolder {
  /** The holder's task. Absent for a read session, which holds no task. */
  taskId?: string;
  employee: string;
  intent: WorkIntent['kind'];
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
  /**
   * Explicit code-repo binding (gm only): overrides the repo used for worktree allocation and
   * dispatch repoHome/cwd. Never affects business project resolution (claim.json.project,
   * opsScope, broker quotas) — that stays with projectOverlay/goal.project.
   */
  codeRepoPath?: string;
  dependencies: TaskId[];
  version: number;
  submittedBy?: EmployeeId;
  currentEmployee?: EmployeeId;
  deliveryId?: DeliveryId;
  leaseExpiresAt?: string;
  fence: number;
  blockedTo?: 'gm' | 'owner';
  /** Blocked rows: the phase to restore when the wait ends (ready/doing -> ready, review -> review). */
  resumeState?: TaskState;
  /** Blocked rows: the role recorded by the original block, kept for cross-role display and validation. */
  resumeRole?: string;
  /** Set when the previous holder's lease was revoked; the next holder must read the handover history. */
  handover?: boolean;
  previousEmployee?: EmployeeId;
  /** Bound code implementer (execute phase). Set at the first execute claim or by an explicit gm takeover. */
  implementer?: EmployeeId;
  workIntent?: WorkIntent;
  worktree?: WorktreeAssignment;
  /** Typed screenplay-revision edge: this draft is the legal next version of `revises`. */
  revises?: TaskId;
  /** Set on a superseded draft: points at the replacing version (chain tip has none). */
  supersededBy?: TaskId;
  /** Version-chain root shared by every draft of the same screenplay lineage. */
  lineage?: TaskId;
  /** 1-based version number inside the lineage (v1 has none until superseded). */
  revisionNo?: number;
  /**
   * Set on a write's echo (SYS01): the size and digest of the whole context, and whether `context` holds only its leading part.
   * A cut context continues at contextNextOffset in read_task_text, which verifies the text against contextSha256.
   */
  contextBytes?: number;
  contextSha256?: string;
  contextTruncated?: boolean;
  contextNextOffset?: number;
  /**
   * Set on a write's echo (SYS01 R3) and on a claim's task: each list that was cut to its leading part, with the whole count and
   * the SHA-256 of the whole JSON. read_task_text (field dependencies, workIntentPaths or worktreePaths) returns the whole list.
   */
  listsTruncated?: Partial<Record<'dependencies' | 'workIntentPaths' | 'worktreePaths', ListCut>>;
  /**
   * Set on a task echo (SYS01 R3): each text field other than the context that was cut to its leading part, with the size and the
   * SHA-256 of its whole value. The whole value is not readable through read_task_text.
   */
  fieldsTruncated?: Record<string, FieldCut>;
}

/** A list of a task echo that was cut: its whole count, and the SHA-256 of its whole JSON (SYS01 R3). */
export interface ListCut { count: number; sha256: string }

/** A text field of a task echo that was cut: the UTF-8 size of its whole value, and the SHA-256 of that value (SYS01 R3). */
export interface FieldCut { bytes: number; sha256: string }

export interface HistoryEntry {
  action: string;
  actor: string;
  /**
   * Evidence text. A complete answer carries it whole. A paged answer carries it whole too, unless the entry alone
   * cannot fit a page: then evidenceTruncated is true, and read_task_text continues at evidenceNextOffset (C3).
   */
  evidence?: string;
  version?: number;
  at: string;
  /** Audit row id, the handle read_task_text takes for the full evidence (SYS01). */
  auditId?: string;
  /** Size and digest of the full evidence, whether or not the text above is cut. */
  evidenceBytes?: number;
  evidenceSha256?: string;
  evidenceTruncated?: boolean;
  /** Byte offset where read_task_text continues the evidence; present only when evidenceTruncated is true. */
  evidenceNextOffset?: number;
}

/**
 * Paging metadata of a paged answer (SYS01). A complete (legacy) answer carries no page: it is the whole set or it is
 * refused as response_too_large. total is the stored listing's row count; snapshotAt is the database time it was read at.
 */
export interface PageInfo {
  pageSize: number;
  returned: number;
  hasMore: boolean;
  nextCursor?: string;
  total?: number;
  /** Database time the listing was read at. The listing reflects the database as it stood then. */
  snapshotAt?: string;
  budgetBytes: number;
}

/**
 * One part of the company block (get_context with scope company, SYS01 AC-A). The meta part carries `paused`. Each direction, goal
 * and project is one item: its JSON text is cut into parts of a page's size, in order. A reader joins the `json` of the parts of one
 * (section, key) item, checks the joined UTF-8 length against `totalBytes` and its SHA-256 against `sha256`, then parses it.
 */
export interface CompanyPart {
  section: 'meta' | 'directions' | 'goals' | 'projects';
  /** Stable within the listing: `company` for the meta part, `direction-<position>` for a direction, the id for a goal or project. */
  key: string;
  /** 0-based position of this part among the parts of its item. */
  part: number;
  /** How many parts the item has. */
  parts: number;
  /** Byte offset of this part in the item's JSON text. */
  offset: number;
  /** Byte length and SHA-256 (hex) of the whole item JSON text. */
  totalBytes: number;
  sha256: string;
  /** This part of the item's JSON text, cut on UTF-8 character boundaries. */
  json: string;
}

/**
 * get_context answer (SYS01). A task answer carries `tasks`, `companyIncluded` and `companyRead` (the arguments that read the company
 * block in pages). A company answer carries `scope: 'company'` and either `company` (complete) or `parts` with `page` (paged).
 */
export interface ContextView {
  principal: Principal;
  /** The company block: with includeCompany true on a task answer, or a complete scope-company answer. */
  company?: unknown;
  /** Whether a task answer carries the company block (AC-A: false unless includeCompany is true). */
  companyIncluded?: boolean;
  /** How to read the company block in pages: the get_context arguments that return it, one page at a time. */
  companyRead?: { scope: 'company'; pageSize: number };
  scope?: 'tasks' | 'company';
  section?: 'directions' | 'goals' | 'projects';
  parts?: CompanyPart[];
  tasks?: Array<Record<string, unknown>>;
  page?: PageInfo;
}

export interface HistoryPageView {
  history: HistoryEntry[];
  page: PageInfo;
}

export interface WorktreePageView {
  worktrees: Array<Record<string, unknown>>;
  page: PageInfo;
}

/**
 * What read_task_text reads. context and evidence are text. project is the project environment as JSON (holder or gm only),
 * and dependencies, workIntentPaths and worktreePaths are the task's lists as JSON arrays, so a claim echo that cut them can be
 * read back whole (SYS01 R3).
 */
export type TaskTextField = 'context' | 'evidence' | 'project' | 'dependencies' | 'workIntentPaths' | 'worktreePaths';

/** One byte segment of a text read by read_task_text (SYS01). */
export interface TaskTextSegment {
  taskId: string;
  field: TaskTextField;
  auditId?: string;
  totalBytes: number;
  /** SHA-256 of the whole text, so a reader can verify a reassembly. */
  sha256: string;
  offset: number;
  bytes: number;
  nextOffset: number | null;
  text: string;
}

/** gm-only read-only summary (SYS01): counts at a cutoff, never task text. */
export interface AdminSummary {
  /** Database time of the read. Every count reflects the database as it stood then. */
  cutoffAt: string;
  /** Start of the audit window, [since, cutoffAt]. Declared even when the task counts ignore it. */
  since: string;
  goalId?: string;
  /** What each count covers. `since` limits only the audit counts; task counts are the state at cutoffAt. */
  scope: { tasks: string; audit: string };
  tasks: Record<string, number>;
  audit: Record<string, number>;
  outboxSequence: number;
  integrity: {
    /**
     * True only when the read was consistent (its two in-transaction reads agree), every row is grouped under a
     * known state, and each count matches the rows it covers. Otherwise false: retry the summary.
     */
    complete: boolean;
    method: string;
    taskRows: number;
    auditRows: number;
    checks: { taskCountsMatchRows: boolean; auditCountsMatchRows: boolean; statesKnown: boolean; repeatableRead: boolean };
    /** Present only when a task row carries a state outside the known set. */
    unknownStates?: string[];
  };
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
  /**
   * Controlled screenplay-revision edge (gm/product only): both drafts must be owner-reviewed
   * screenwriter tasks on the 编剧 track (kind=task) in the same goal and project; the target
   * must be the unapproved, unsuperseded chain tip whose latest submission drew a real owner
   * rejection. The service atomically voids the target (supersededBy pointer), inherits the
   * lineage, and lets the new draft start once its own normal dependencies are satisfied —
   * the edge never exempts other tasks or other dependencies.
   */
  revises?: TaskId;
}

export interface ClaimResult {
  task: TaskView;
  deliveryId: DeliveryId;
  fence: number;
  leaseExpiresAt: string;
  /**
   * Prior claims, checkpoints, returns, owner decisions and revocation handovers for this task, oldest first: the newest entries
   * that core read. historyCount is the number of entries the task holds in all; historyComplete is true only when history holds
   * every one of them. get_task_history pages the whole history (SYS01 R3).
   */
  history: HistoryEntry[];
  historyCount?: number;
  historyComplete?: boolean;
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
  disciplines?: Array<{ name: string; description?: string; roles?: Role[] }>;
  /** Default production line for goals of this project (software when unset). */
  pipeline?: string;
  runbooks: string[];
  notes?: string;
  envs: Array<{ name: string; url?: string; healthUrl?: string; verify?: string; secrets: Array<{ name: string; roles: Role[] }> }>;
  /**
   * Set on a company block read by someone who may not see the environments (SYS01 M3): `envs` is then empty, not the project's
   * list. The owner's console never sets it.
   */
  envsWithheld?: true;
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
  /** Worktree lane shared by the three legs; defaults to one fresh lane per delivery so parallel changes never share a tree. */
  lane?: string;
  dependencies?: TaskId[];
  idempotencyKey: string;
}

/** gm only: re-point a gm block — execute, or a provable normal non-owner review block — at unmet dependencies instead of the manager. */
export interface DeferTaskUntil {
  taskId: TaskId;
  /** Dependencies to merge into the task's existing set (union, same goal, acyclic after resolution). */
  dependencies: TaskId[];
  /** Business reason for the wait; audited together with the before/after dependency snapshot and the restore phase. */
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

/** gm (manage): record a new code implementer for an execute-phase task whose bound implementer cannot continue. */
export interface ImplementerTakeover {
  taskId: TaskId;
  /** Takes over code work; must hold the task's execute role and capability. */
  toEmployee: EmployeeId;
  /** Required when toEmployee is a current reviewer: a different, independent engineer that will review. */
  replacementReviewer?: EmployeeId;
  /** Compare-and-set: refuse when the task version has moved. */
  expectedVersion: number;
  /** Why the bound implementer is replaced; audited. */
  reason: string;
  idempotencyKey: string;
}

/** gm (manage): read-only dry-run of the acceptance reference repair for a quick/software goal. */
export interface GoalAcceptancePreview {
  goalId: string;
  /** Candidate 运营验收 task (kind task, product executor, gm reviewer) that would take over the references. */
  candidateTaskId?: TaskId;
}

/** gm (manage): commit the acceptance reference repair; compare-and-set on the preview snapshot. */
export interface GoalAcceptanceRepair {
  goalId: string;
  /** The voided task the goal's manual/acceptance references must still point at. */
  expectedOldTaskId: TaskId;
  candidateTaskId: TaskId;
  /** snapshot.hash from goal_acceptance_preview; any drift in the repair basis refuses the commit. */
  snapshotHash: string;
  /** Business reason, audited with the before and after references. */
  text: string;
  idempotencyKey: string;
}

export interface GoalAcceptanceTask {
  id: TaskId;
  title: string;
  state: TaskState;
  executorRole: Role;
  reviewerRole: ReviewerRole;
  kind: TaskKind;
  version: number;
  blockedTo?: 'gm' | 'owner';
  submitted: boolean;
  leaseHolder?: string;
  dependencies: TaskId[];
}

export interface GoalAcceptanceView {
  goal: {
    id: string; title: string; state: GoalView['state']; tier?: GoalTier; pipeline: string; project?: string;
    tasks: Record<string, string>; anchors: TaskId[];
  };
  /** The live manual/acceptance task the goal points at (expected to be void before a repair). */
  replaced?: GoalAcceptanceTask;
  /** Goal work that is neither done nor void; the candidate must depend on all of it. */
  unfinished: GoalAcceptanceTask[];
  candidate?: GoalAcceptanceTask & { missing: TaskId[] };
  diff: {
    manual: { from?: TaskId; to?: TaskId }; acceptance: { from?: TaskId; to?: TaskId };
    anchors: { from: TaskId[]; to: TaskId[] };
  };
  /** Every rule the repair would break; empty when the repair is ready. */
  violations: Array<{ code: string; message: string }>;
  ready: boolean;
  snapshot: { version: 1; hash: string };
}

export interface GoalAcceptanceResult {
  goalId: string;
  replacedTaskId: TaskId;
  candidate: GoalAcceptanceTask;
  anchors: TaskId[];
  snapshotHash: string;
  repairedAt: string;
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

/**
 * gm dry-run of the contributor derivation (SYS-DISP AC05): read-only. `timeline` is the task's audit stream, oldest first,
 * with the role each row plays. `status` and `suggestedImplementer` are advice; nothing here writes an implementer.
 */
export interface ContributorDryRunView {
  readOnly: true;
  checkedAt: string;
  /** UTF-8 JSON bytes the whole answer is held to (SYS-DISP, SYS01 budget). */
  budgetBytes: number;
  /** True when at least one task's timeline was cut to fit `budgetBytes`; the cut is marked per task. */
  truncated: boolean;
  tasks: Array<{
    taskId: string; found: boolean; title?: string; state?: TaskState; version?: number;
    executorRole?: string; reviewerRole?: string; currentEmployee?: string; lastSubmitter?: string;
    status?: 'bound' | 'proposal' | 'manager_decision' | 'fresh'; implementer?: string; suggestedImplementer?: string;
    authors?: string[]; reviewers?: string[]; excluded?: string[];
    unknown?: Array<{ actor: string; action: string; at?: string; reason: string }>; note?: string;
    /** The newest rows that fit, oldest first. `timelineTotal` counts every row of the task; `timelineShown` is how many are here. */
    timeline?: Array<{ at: string; version?: number; actor?: string; action: string; phase?: string; phaseSource?: string; role: string }>;
    timelineTotal?: number;
    timelineShown?: number;
    timelineTruncated?: boolean;
  }>;
}

export interface CompanyCore {
  /** Read-only write-scope preflight for the dispatcher: the holders that would refuse an execute claim now (SYS-DISP R1). */
  writeScopeOf(taskId: TaskId, employeeId?: string): Promise<WriteScopeHolder[]>;
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
  block(credential: Credential, proof: LeaseProof, to: 'gm' | 'owner', evidence: Evidence, quotaResetsAt?: string): Promise<TaskView>;
  resume(credential: Credential, taskId: TaskId, evidence: Evidence): Promise<TaskView>;
  /** gm only: a gm block becomes a dependency wait — stays blocked for the dispatcher; the last dependency restores ready (execute) or review (provable non-owner review block). */
  deferTaskUntil(credential: Credential, input: DeferTaskUntil): Promise<TaskView>;
  /** gm/product: mark a task 'void' (terminal), release any lease on it, and unlock dependents that were waiting only on it. */
  retireTask(credential: Credential, input: RetireTask): Promise<TaskView>;
  /** gm (manage): read-only dry-run of repointing a quick/software goal's acceptance reference; writes nothing. */
  goalAcceptancePreview?(credential: Credential, input: GoalAcceptancePreview): Promise<GoalAcceptanceView>;
  /** gm (manage): compare-and-set repair of a quick/software goal's acceptance reference; audited and idempotent. */
  goalAcceptanceRepair?(credential: Credential, input: GoalAcceptanceRepair): Promise<GoalAcceptanceResult>;
  /** SYS01 bounded reads: optional so older adapters still compile; the sidecar and MCP layers check for them. */
  contextView?(credential: Credential, input: Record<string, unknown>): Promise<ContextView>;
  historyView?(credential: Credential, taskId: TaskId, input: Record<string, unknown>): Promise<HistoryPageView>;
  worktreePage?(credential: Credential, input: Record<string, unknown>): Promise<WorktreePageView>;
  /** list_worktrees without pageSize or cursor: the pre-SYS01 array, in the same compact form as a page. */
  worktreeList?(credential: Credential, input: Record<string, unknown>): Promise<unknown[]>;
  taskText?(credential: Credential, input: Record<string, unknown>): Promise<TaskTextSegment>;
  adminSummary?(credential: Credential, input: Record<string, unknown>): Promise<AdminSummary>;
  /** gm (manage): record the code implementer of an execute-phase task; audited, idempotent, version-checked. */
  implementerTakeover?(credential: Credential, input: ImplementerTakeover): Promise<TaskView>;
  /**
   * Dispatcher-only: hand an execute-phase engineering task to a live engineer when the bound implementer's session is
   * gone for good (archived, missing, or a failure that cannot be restarted). Same compare-and-set write as the
   * manager's takeover, audited as `system:dispatcher`. Takes no credential and is never exposed as an agent tool.
   */
  systemImplementerTakeover?(input: { taskId: TaskId; toEmployee: EmployeeId; expectedVersion: number; reason: string }): Promise<TaskView>;
  /** gm dry-run of the contributor derivation for up to 20 tasks; read-only (SYS-DISP AC05). */
  contributorDryRun?(credential: Credential, input: { taskIds: string[] }): Promise<ContributorDryRunView>;
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
  /**
   * gm only: bind an explicit code repository (code_repo_path) to a blocked execute-phase task.
   * Workspace allocation and dispatch repoHome/cwd follow the binding; the business project
   * (taskProject → opsScope/claim.json.project) is untouched. Targets are limited to the ops
   * repo or a registered project repo_path, canonicalised (symlink/traversal escapes refused).
   * Version-guarded, idempotent, audited; releases the stale worktree assignment through the
   * normal lifecycle (the physical tree itself is never deleted here).
   */
  bindTaskCodeRepo?(credential: Credential, input: { taskId: TaskId; codeRepoPath: string; expectedVersion: number; text: string; idempotencyKey: string }): Promise<TaskView>;
  /** manage (gm/product): list every employee_def row for workforce review. */
  listDefs(credential: Credential): Promise<DefView[]>;
  /** manage (gm/product): create or update an employee_def via the shared workforce writer; audited. */
  ensureDef(credential: Credential, input: EnsureDef): Promise<DefView>;
  /** manage (gm/product): replace only the project's disciplines vocabulary; audited. */
  updateProjectDisciplines(credential: Credential, input: { project: string; disciplines: Array<{ name: string; description?: string; roles?: Role[] }> }): Promise<ProjectView>;
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
  quotaLimited?: boolean;
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
  /** false = dispatched even when the subscription's remaining allowance is 0. Absent keeps the stored value. */
  quotaLimited?: boolean;
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
  /** Upstream reset of the window that is closest to running out (ISO 8601), when the provider reports one. */
  resetsAt?: string;
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
  /** Production line template this goal runs (software / video / story). */
  pipeline?: string;
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
