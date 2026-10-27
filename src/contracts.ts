/** v1 core/adapter boundary. The MCP adapter supplies an opaque credential on every call. */
import type { WaitHandoffCard, WaitMigrationCandidate } from './waits.ts';
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

// ---- SYS02: versioned structured acceptance and server-verified evidence. ----

/** One acceptance criterion kind: a machine fact the server verifies, or a named human sign-off. */
export type AcceptanceCriterionKind = 'machine' | 'human';
/** Where the criterion is verified. */
export type AcceptanceLayer = 'unit' | 'integration' | 'fork' | 'ci' | 'runtime' | 'manual';
/** What kind of evidence satisfies a criterion. */
export type AcceptanceEvidenceType = 'ci-run' | 'probe' | 'artifact' | 'review-signoff';
/** The risk the criterion covers; runtime/permission/packaging are the external checks a text claim cannot prove. */
export type AcceptanceRisk = 'code' | 'data' | 'external-timing' | 'permission' | 'packaging' | 'runtime';
/** Delivery leg a criterion applies to; absent on the criterion means every leg. */
export type AcceptanceLeg = 'implement' | 'release' | 'deploy' | 'goal' | 'owner';
/** The gate phase that evaluates a task. */
export type AcceptancePhase = 'submit' | 'accept' | 'release' | 'deploy' | 'owner' | 'goal';

/** A versioned acceptance criterion (SYS02 AC01). */
export interface AcceptanceCriterion {
  /** Unique within the task/delivery, e.g. AC-1. */
  id: string;
  kind: AcceptanceCriterionKind;
  required: boolean;
  layer: AcceptanceLayer;
  evidence: AcceptanceEvidenceType;
  /** What is verified, e.g. `ci`, `independent-review`, `qa-production`, `probe:running-channel`. */
  verify: string;
  description?: string;
  risk?: AcceptanceRisk;
  /** Legs this criterion applies to; absent = every leg of the delivery. */
  legs?: AcceptanceLeg[];
  /**
   * Required environment for this criterion's machine evidence, from the controlled task/AC declaration.
   * When present, evidence must carry exactly this environment; undefined is never a wildcard.
   */
  environment?: string;
}

/** Why one required criterion is not satisfied. */
export interface AcceptanceUnmet { acId: string; reason: string }

/** A server-verified evidence row (SYS02 AC02). It is written only from a trusted source or an authorized sign-off. */
export interface AcceptanceEvidenceRecord {
  id: string;
  taskId: TaskId;
  acId: string;
  kind: AcceptanceCriterionKind;
  /** PR head or deployed SHA the evidence is bound to. */
  sha: string;
  environment?: string;
  /** The submission attempt this evidence was collected for; a later attempt cannot reuse it. */
  attempt?: number;
  evidenceType: AcceptanceEvidenceType;
  source: Record<string, unknown>;
  verified: boolean;
  verifier: string;
  actor: string;
  at: string;
  criteriaVersion: number;
  taskVersion: number;
  digest: string;
}

/** The versioned gate record (company_meta:acceptance_gate). */
export interface AcceptanceGateView {
  version: number;
  enabled: boolean;
  enabledAt?: string;
  scope: string;
  criteriaVersion: number;
}

/** The unified evaluator's answer for one task and phase (SYS02 AC03). */
export interface AcceptanceVerdict {
  ok: boolean;
  phase: AcceptancePhase;
  gateEnabled: boolean;
  legacy: boolean;
  notApplicable: boolean;
  criteriaVersion: number;
  head?: string;
  /** The controlled environment and target attempt this verdict judged. */
  environment?: string;
  attempt?: number;
  criteria: AcceptanceCriterion[];
  evidence: AcceptanceEvidenceRecord[];
  unmet: AcceptanceUnmet[];
}

/** Arguments of record_acceptance_evidence (SYS02 AC02/AC04). */
export interface AcceptanceEvidenceInput {
  taskId: TaskId;
  acId: string;
  /** PR head or deployed SHA the evidence must match. */
  sha: string;
  environment?: string;
  source: {
    provider: 'github-actions';
    runUrl: string;
    artifactId?: string;
    probe?: { runId: string; jobId?: string; readAt: string; inProgress: boolean; observationHash: string; probeVersion?: string; producerRunId?: string; targetRunId?: string; targetJobId?: string; targetWorkflow?: string; targetStatus?: string; kind?: string; nodeVersion?: string; bundleHash?: string; annotationHash?: string; channel?: string; statusCreatedAt?: string };
  };
  idempotencyKey: string;
}

/** Read-only status for a reviewer: the gate, the criteria, the evidence and the current verdict. */
export interface AcceptanceStatusView { taskId: TaskId; gate: AcceptanceGateView; verdict: AcceptanceVerdict }

/** A versioned, reason-audited change of the gate (SYS02 AC06). Only gm may call it. */
export interface AcceptanceGateInput { enabled: boolean; reason: string; expectedVersion: number; idempotencyKey: string }

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

/**
 * Why a blocked task is waiting, derived from the row's authoritative facts (RW05/RW06). The owner and manager views read this
 * instead of guessing from transient fields: a review-phase wait names the reviewing role, never the execute phase; a fact the
 * row does not carry is `unknown`, not a default.
 */
export interface TaskWaiting {
  /** manager: blocked for a GM decision; owner: a boss gate; dependency: waiting on other tasks (a review wait is one of these). */
  kind: 'manager' | 'owner' | 'dependency';
  /** The phase restored when the wait ends (`unknown` when the row carries none). */
  resumeState: TaskState | 'unknown';
  /** For dependency waits: the role whose phase is awaited (review wait -> the reviewer role); `unknown` when no fact names it. */
  role: Role | 'owner' | 'unknown';
  /** How many prerequisites the row records. The ids themselves stay in the task's own `dependencies` field, which SYS01's
   *  per-item budget already truncates with an explicit flag; repeating them here would push a wide row past a page. */
  dependenciesCount: number;
}

/**
 * SYS05: a task's open typed wait. It is separate from `TaskWaiting` (which describes any blocked row): a wait
 * names its own condition, the role that owns it, the absolute instant it becomes due and the trusted source that
 * may release it. `expiresAt` is present only when a tool named a precise instant; `expiresSource=unknown` is not
 * a placeholder to be filled in by arithmetic.
 */
export interface TaskWaitView {
  waitKey: string;
  kind: 'time' | 'dependency' | 'upstream_repair' | 'customer_activation' | 'owner_handoff' | 'feedback';
  state: 'waiting' | 'released' | 'held' | 'expired' | 'cancelled' | 'superseded';
  ownerRole: string;
  source: 'time' | 'dependency' | 'webhook' | 'authorized_person' | 'owner';
  notBefore?: string;
  expiresAt?: string;
  expiresSource: 'exact' | 'unknown';
  nextCheckAt?: string;
  timezone?: string;
  version: number;
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
  /** SYS02: this task/delivery leg's versioned structured acceptance criteria. */
  acceptanceCriteria?: AcceptanceCriterion[];
  acceptanceVersion?: number;
  /** True for tasks created before the gate was enabled: they keep the old path and cannot fake a satisfied gate. */
  acceptanceLegacy?: boolean;
  /** The current PR head or deployed SHA machine evidence must match. */
  acceptanceHead?: string;
  acceptanceEnvironment?: string;
  acceptanceAttempt?: number;
  /** Groups the legs of one create_delivery chain. */
  acceptanceChain?: string;
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
  /** Blocked rows: why the task waits, in the same authoritative terms for every view (RW06 C3). */
  waiting?: TaskWaiting;
  /** SYS05: the open typed wait (time or trusted external event), when the task is waiting on one. */
  wait?: TaskWaitView;
  /** Set when the previous holder's lease was revoked; the next holder must read the handover history. */
  handover?: boolean;
  previousEmployee?: EmployeeId;
  /** Bound code implementer (execute phase). Set at the first execute claim or by an explicit gm takeover. */
  implementer?: EmployeeId;
  /** Independence policy (SYS-DISP IR01): contributors of the source tasks, and named employees, may not take or decide this task. */
  independence?: IndependencePolicy;
  modelTier?: 'fable' | 'opus' | 'sonnet' | 'haiku' | 'high' | 'medium' | 'low';
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
  /** 创建时的有效契约登记（SYS06 AC03）：策略版本与 hash，以及逐域契约本体。旧行没有它，语义是"无有效契约"。 */
  policyVersion?: number;
  policyHash?: string;
  policyContract?: EffectiveContract;
  /** 本租约的契约登记：策略变了以后两者不等，旧 claim 的写动作被拒（下一次相关动作前核版本）。 */
  leasePolicyVersion?: number;
  leasePolicyHash?: string;
  /** 被策略收权隔离的原因（可见状态：blocked，等待 GM），旧 release 也认得这个状态。 */
  policyBlockReason?: string;
}

/** A list of a task echo that was cut: its whole count, and the SHA-256 of its whole JSON (SYS01 R3). */
export interface ListCut { count: number; sha256: string }

/**
 * References cut from one worktree of a paged listing (SYS01 R1): the whole list's count and SHA-256, the filter the list was
 * read with, and the tool that reads the whole list. A reader never has to guess where the rest is.
 */
export interface ReferencesCut extends ListCut { includeReleased: boolean; tool: 'read_worktree_refs' }

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

/**
 * One byte segment of one worktree's references as JSON (SYS01 R1). It is the recovery entry a paged list_worktrees item names
 * when its references were cut: the same task/gm scope as the listing, the whole list's size and SHA-256, and a byte window
 * that reassembles exactly.
 */
export interface WorktreeRefsSegment {
  /** The canonical path the listing returned. */
  worktreePath: string;
  /** The filter the whole list was read with: true lists released references too. */
  includeReleased: boolean;
  totalBytes: number;
  /** SHA-256 of the whole references text, so a reader can verify a reassembly. */
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
  /** SYS02: required for new code deliveries when the acceptance gate is enabled. */
  acceptanceCriteria?: AcceptanceCriterion[];
  /** SYS02: controlled environment declaration for this task (e.g. production); evidence must match it exactly. */
  acceptanceEnvironment?: string;
  idempotencyKey: string;
  modelTier?: 'fable' | 'opus' | 'sonnet' | 'haiku' | 'high' | 'medium' | 'low';
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

/**
 * A complete, credential-scoped lease still active on the server for the authenticated employee.
 * The sidecar uses this after a plugin reload instead of a list preview: lists are bounded and
 * hide the employee's own review rows, so a trailing review lease would otherwise vanish.
 */
export interface ActiveLease {
  taskId: TaskId;
  state: 'doing' | 'review';
  deliveryId: DeliveryId;
  fence: number;
  version: number;
  leaseExpiresAt: string;
  /** The role the holder acts under in this phase (executor for doing, reviewer for review). */
  role: Role;
  currentEmployee: EmployeeId;
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
  /**
   * The effective policy contract this claim was granted under (SYS06 AC03). Rendered so the prompt carries exactly the current
   * contract; `history` on the policy itself stays queryable. Undeniable: the claim is refused before it is written if a
   * change since the read dropped the authorization.
   */
  policy?: PolicyEffectiveView;
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
  /**
   * SYS02: versioned structured acceptance criteria for the delivery. Each criterion may name the legs it applies to;
   * a leg with no matching criterion gets that leg's default criteria. The gate is enforced only once enabled (AC06).
   */
  acceptanceCriteria?: AcceptanceCriterion[];
  /** SYS02: controlled environment declaration applied to every leg; evidence must match it exactly. */
  acceptanceEnvironment?: string;
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

/** The phase a policy applies to: taking and writing code (execute), or deciding a review. */
export type IndependenceStage = 'execute' | 'review';

/**
 * Which contributors of a source task count. `execute_handlers`: every execute-phase handler of the source (its authors, including a
 * claim that never submitted, and its implementer). `all_handlers`: those plus every reviewer of the source.
 */
export type IndependenceMode = 'execute_handlers' | 'all_handlers';

/** Who may not take or decide a task: the contributors of its source tasks and the employees a manager names (SYS-DISP IR01). */
export interface IndependencePolicy {
  /** Format version. Only 1 is understood; any other value fails closed. */
  schema: 1;
  /** Starts at 1 and rises by one with every accepted change. */
  revision: number;
  stages: IndependenceStage[];
  sources: TaskId[];
  mode: IndependenceMode;
  /** Employees named explicitly (for example a code author or QA). Only these employees and anyone sharing a registered identity principal with them are excluded (SYS-DISP Q3): a definition is a capacity template, never an identity, so its other employees stay independent. */
  excluded: EmployeeId[];
  reason: string;
  setBy: EmployeeId;
  setAt: string;
}

/**
 * A registered identity principal (SYS-DISP IR02/Q3): the explicit, manage-controlled link that makes several employeeIds one
 * person for independence purposes. This is the ONLY cross-employee identity key: a definition, provider, model, name or
 * directory never implies it, and an unregistered link is never recognized.
 */
export interface IdentityPrincipalView {
  id: string;
  /** Employees registered to this principal. */
  employees: EmployeeId[];
  /** Why these are one person (required, audited). */
  reason: string;
  setBy: EmployeeId;
  setAt: string;
}

/**
 * Candidate-level read-only preflight (SYS-DISP IR01): would this one employee be excluded by this one task's policy at this stage,
 * exactly as the claim/submit gate would refuse them? A read only: it never takes a lease, never advances a version and never writes
 * anything, so an already finished task stays readable — which is the tool's main use.
 */
export interface IndependenceCheckInput {
  taskId: TaskId;
  employeeId: EmployeeId;
  /** Stage to judge at; omit to infer it from the task's current phase (review while in review, execute otherwise). */
  stage?: IndependenceStage;
}

/**
 * The preflight answer. `clear` means the gate would admit the candidate at this stage; `conflict` means it would refuse (with the
 * same `via`/`source`/`matched`/`role`/`principal`/`auditRef` facts the refusal carries); `unverifiable` means the exclusion could not
 * be read and the gate fails closed, so it is NEVER a pass; `not_applicable` means the task has no policy (legacy behaviour).
 */
export type IndependenceVerdict = 'clear' | 'conflict' | 'unverifiable' | 'not_applicable';

/** The registered policy as the preflight echoes it, so QA can read the actual values back without a second source. */
export interface IndependenceCheckPolicyView {
  revision: number;
  stages: IndependenceStage[];
  mode: IndependenceMode;
  sources: TaskId[];
  excluded: EmployeeId[];
  setBy: EmployeeId;
  setAt: string;
}

/** One preflight reading: the verdict with the facts behind it, and the policy actually registered on the task. */
export interface IndependenceCheckView {
  taskId: TaskId;
  employeeId: EmployeeId;
  stage: IndependenceStage;
  verdict: IndependenceVerdict;
  via?: 'contributor' | 'explicit' | 'same_principal';
  /** Source task the match came from (a contributor match, or an identifier link to one). */
  source?: TaskId;
  matched?: EmployeeId;
  role?: 'author' | 'implementer' | 'reviewer';
  /** Registered principal that made the match, when the match came from an identity link. */
  principal?: string;
  /** The contribution audit row that proves the match, as the refusal's details.conflicts cites it. */
  auditRef?: string;
  reason: string;
  /** Present whenever the task has a policy; absent when there is none (verdict not_applicable). */
  policy?: IndependenceCheckPolicyView;
}

/** Manager write of a task's independence policy: creates the first one, or replaces it under a compare-and-set. */
export interface SetIndependence {
  taskId: TaskId;
  stages: IndependenceStage[];
  sources: TaskId[];
  mode: IndependenceMode;
  excluded?: EmployeeId[];
  reason: string;
  /** Compare-and-set: refuse when the task version has moved. */
  expectedVersion: number;
  idempotencyKey: string;
}

/** Manager write of an identity principal: register the link, or set its exact employee set, under a compare-and-set. */
export interface SetIdentityPrincipal {
  /** Existing principal to change; omit to register a new one. */
  principalId?: string;
  /** The complete employee set of the principal after the write (at least 1, at most 20). */
  employees: EmployeeId[];
  /** Why these are one person (required, audited). */
  reason: string;
  /** Compare-and-set on the principal row: refuse when it has moved. Omit for a new principal. */
  expectedVersion?: number;
  idempotencyKey: string;
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
  /** SYS02: the head this submission is bound to; machine evidence must match it. */
  acceptance?: { sha?: string; environment?: string };
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
 * SYS04: what the plugin process is actually running. Read-only, and read by gm/product/qa only: it names the
 * release the company service is loaded from, so it is an operator fact rather than a general employee read.
 *
 * The view is produced in the plugin host's own execution context (the face every employee channel reaches),
 * never from the MCP face's tree and never from the `active` symlink — a symlink names what the service
 * points at, which is the claim needing evidence rather than the evidence.
 */
export interface PluginRuntimeView {
  /** Which execution context produced this answer. `plugin-host` is the only accepted value. */
  context: 'plugin-host';
  /** When the sample was taken, ISO 8601 with a timezone offset. */
  collectedAt: string;
  process: { pid: number; nodeVersion: string; execPath: string; bunShim: boolean };
  loaded: {
    /**
     * How the directory was obtained. `registered-plugin-source` is the Paseo host's own plugin registry entry
     * (`paseo plugin ls --json`): the host bundles the server code and evaluates it without a module loader, so
     * there is no loaded file path to read; the registered source tree is content-bound instead.
     */
    basis: 'module-dir' | 'registered-plugin-source' | 'unavailable';
    selfPath: string | null;
    serverDir: string | null;
    vendorDir: string | null;
    vendorResolvedBy: 'vendor-child-of-server-dir' | 'unavailable';
  };
  /** The release proven from the loaded code's own path; `unavailable` when it could not be proven. */
  binding: { kind: 'plugin-server-dir' | 'unavailable'; path: string | null; reason?: string };
  /** The files whose content binds the answer. A file that could not be read is present with a null digest. */
  modules: Array<{ name: string; path: string | null; sha256: string | null; bytes: number | null }>;
  /** Paths the diagnostic deliberately did not read, so a reader can see the boundary. */
  notRead: string[];
}

/**
 * SYS04: the roles allowed to read the plugin runtime diagnostics.
 *
 * The role check is a core concern because that is where the authoritative identity lives; the sample itself
 * is taken by the plugin host, the only process that can state what it loaded. An unauthorized read must
 * produce no diagnostic at all — not a refused one that still touched the filesystem — so the check runs
 * before any sampling.
 */
export const PLUGIN_RUNTIME_ROLES: readonly Role[] = ['gm', 'product', 'qa'];

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


/** QA 受限只读取证（SYS-DISP 7454fc89）：GM 登记的范围视图。不携带任何凭证。 */
export interface QaObservationScopeView {
  id: string; goalId: string; deploymentTaskId: string; qaEmployee: string;
  leaseHolder: string; leaseFence: number; subjects: string[];
  status: 'active' | 'revoked'; expiresAt: string; version: number;
  reason: string; createdAt: string; revokedAt?: string; revokedReason?: string;
}
/** GM 登记 scope：绑定正在审的部署任务、同 goal、QA 实际复核租约 holder/fence、任务 allowlist、期限与理由。 */
export interface QaObservationGrant {
  goalId: string; deploymentTaskId: string; qaEmployee: string; leaseFence: number;
  subjects: string[]; expiresAt: string; reason: string; idempotencyKey: string;
}
export interface QaObservationRevoke { scopeId: string; expectedVersion: number; reason: string; idempotencyKey: string; }
/** 读接口的两种调用身份：员工本人的 sck 凭证，或浏览器受限会话令牌（都不是 owner token）。 */
export interface QaObservationAuth { credential?: Credential; token?: string; }
export interface QaObservationDispatchReason {
  code: string; text: string; candidates: string[]; owner: string; recovery: string;
  nextTrigger: string; basis: string; until?: string;
  /**
   * Structured recovery actions with their authority and tool (F1). Observations written before this field existed do not
   * carry it: the page shows the action as unknown rather than inventing one.
   */
  actions?: Array<{ authority: string; label: string; tool?: string; executable: boolean }>;
}

/**
 * The goal-level root blocker for a QA goal summary (F2). Built by the same server-side evaluator the owner pulse uses
 * (goalRootBlockers over the pass's verdicts); the QA channel never re-derives a parallel conclusion.
 * `factsAvailable` is false when the waiting graph / people could not be read: impact, dependencyPath and people are then
 * omitted (unknown), never reported as zero or empty-as-fact.
 */
export interface QaObservationGoalRoot {
  taskId: string; title: string; phase: 'execute' | 'review'; workflowState: 'ready' | 'doing' | 'review';
  summary: string; feasible: boolean; waitingMinutes: number; since?: string; checkedAt: string;
  eligibleCount: number; undispatchable: number; others: number;
  /** The notice key of the root verdict, so a QA can name the episode the owner was told about. */
  noticeKey?: string;
  factsAvailable: boolean;
  impact?: number;
  dependencyPath?: Array<{ taskId: string; title: string }>;
  people?: { implementer?: string; authors: string[]; reviewers: string[]; submitter?: string; submitCommit?: string; peopleOmitted?: number };
  reasons: QaObservationDispatchReason[];
  reasonsOmitted?: number;
}
export interface QaObservationGoalWaitRoot {
  goalId?: string;
  taskId: string;
  title: string;
  workflowState: 'ready' | 'doing' | 'review' | 'blocked' | 'done' | 'void' | 'unknown';
  kind: 'dependency' | 'manager' | 'owner' | 'active_lease' | 'unknown';
  basis: string;
  waitingForRole: string;
  nextTrigger: string;
  goalRootCount: number;
  impact?: number;
  dependencyPath?: Array<{ taskId: string; title: string }>;
  dependencyPathTruncated?: boolean;
  unknownReason?: string;
  people?: { implementer?: string; authors: string[]; reviewers: string[]; submitter?: string; submitCommit?: string; peopleOmitted?: number };
  peopleSource?: 'contributor-audit';
  submitterSource?: 'submit-audit';
  submitCommitSource?: 'submit-audit-evidence';
  peopleCheckedAt?: string;
  submitCheckedAt?: string;
}
export interface QaObservationGoalWaitSummary {
  source: 'workflow-graph';
  available: boolean;
  checkedAt?: string;
  totalRoots: number;
  shownRoots: number;
  truncated: boolean;
  /** true when the cut was made for the response byte budget, not only by the root limit: roots or paths were shortened. */
  budgetLimited?: boolean;
  reason?: string;
  roots: QaObservationGoalWaitRoot[];
}

export interface QaObservationDispatchVerdict {
  phase: 'execute' | 'review'; dispatchable: boolean; workflowState: string;
  eligibleCount: number; feasible: boolean; summary: string;
  reasons: QaObservationDispatchReason[]; checkedAt: string; since?: string; waitingMinutes: number;
}
export interface QaObservationDispatch {
  available: boolean; source: string; checkedAt?: string; reason?: string;
  /** true only when the stored pass is a complete observation; false means partial/unavailable, never a silent cut. */
  complete?: boolean;
  /** Counts of the pass before any storage decision; a reader can compare them with what it received. */
  originalVerdicts?: number; originalReasons?: number;
  /** The latest persistence attempt: the stored snapshot is stale when the last write failed. */
  attemptAt?: string; attemptOk?: boolean;
  verdicts?: QaObservationDispatchVerdict[];
}
export interface QaObservationMeta {
  checkedAt: string; dataSource: 'live'; instanceAt: string; runtimeRelease?: string;
  scope: QaObservationScopeView;
  completeness: { complete: boolean; taskRead?: boolean; contextIncluded?: boolean; timelinePaged?: boolean; dispatchComplete?: boolean };
}
export interface QaObservationReadInput { scopeId?: string; taskId?: string; goalId?: string; }
export interface QaObservationContribution {
  authors: string[]; reviewers: string[]; excluded: string[];
  unknown: Array<{ actor: string; action: string; at?: string; reason: string }>;
  implementer?: string; ambiguous: boolean;
}
export interface QaObservationReadView {
  meta: QaObservationMeta;
  task?: TaskView;
  contribution?: QaObservationContribution;
  dispatch?: QaObservationDispatch;
  goal?: { id: string; states: Record<string, number>; total: number; undispatchable?: number; checkedAt?: string;
    dispatchAvailable?: boolean; dispatchComplete?: boolean; dispatchSource?: string; dispatchReason?: string;
    dispatchCheckedAt?: string; dispatchAttemptAt?: string; dispatchAttemptOk?: boolean;
    /** Workflow waits are read from a separately timed, goal-scoped graph, not the dispatcher pass. */
    waits?: QaObservationGoalWaitSummary;
    /** F2: the goal's root blocker from the same evaluator the owner page reads, with impact and dependency path. */
    root?: QaObservationGoalRoot };
  contextOmitted?: boolean; contextBytes?: number; contextSha256?: string;
  contextRead?: { taskId: string; field: 'context'; offset: number };
}
export interface QaObservationTimelineView { meta: QaObservationMeta; history: HistoryEntry[]; page: PageInfo }
export interface QaObservationTextSegment {
  meta: QaObservationMeta; taskId: string; field: 'context' | 'evidence'; auditId?: string;
  totalBytes: number; sha256: string; offset: number; bytes: number; nextOffset: number | null; text: string;
}
export interface QaObservationSessionView { scope: QaObservationScopeView; code: string; expiresAt: string; /** The restricted read-only page path; the QA opens the preview LAN /q/ page. */ pagePath?: string; }
export interface QaObservationLoginView { scope: QaObservationScopeView; token: string; expiresAt: string; }

/**
 * SYS03: the manager-disposition ledger's wire shapes. They are declared once in src/disposition.ts (the module that
 * owns the episode claim, the business idempotency key and the notice/action records) and re-exported here so the tool
 * layers (MCP, sidecar) and the core interface share one definition instead of three drifting copies.
 */
export type {
  DispositionActionName, DispositionClaimInput, DispositionClaimOutcome, DispositionClaimView, DispositionDecideInput,
  DispositionDecideOutcome, DispositionDecisionView, DispositionNoticeKind, DispositionPhase, DispositionRepairInput,
  DispositionStatusInput, DispositionStatusView, ExternalActionRequestInput, ExternalActionView,
  ExternalActionTarget, HolderNoticeView,
} from './disposition.ts';
import type {
  DispositionClaimInput, DispositionClaimOutcome, DispositionClaimView, DispositionDecideInput, DispositionDecideOutcome,
  DispositionPhase, DispositionStatusInput, DispositionStatusView, ExternalActionRequestInput, ExternalActionView,
  HolderNoticeView,
} from './disposition.ts';

/**
 * SYS05: typed wait entry. The employee hands over why it stops; the core normalizes, stores the progress and
 * releases the lease in one transaction. Times must carry an explicit offset.
 */
export interface WaitEntryInput {
  kind: string;
  ownerRole?: string;
  reference?: string;
  referenceTaskId?: string;
  notBefore?: string;
  expiresAt?: string;
  nextCheckAt?: string;
  timezone?: string;
  completed?: string[];
  pendingAction?: string;
  handoffFile?: string;
  reason: string;
  summary?: string;
}
/** A trusted external event that would release a wait. `signature` is verified only for webhook sources. */
export interface WaitResolveInput {
  waitKey?: string;
  taskId?: string;
  source: string;
  provider?: string;
  account?: string;
  eventId?: string;
  at?: string | number;
  objectWaitId?: string;
  objectTaskId?: string;
  ownerQuote?: string;
  payloadDigest?: string;
  signature?: string;
  text: string;
  idempotencyKey: string;
}
export interface WaitResolveView {
  released: boolean;
  code: string;
  message: string;
  taskId?: string;
  waitKey?: string;
  /** The dedupe key the source event landed on, when it had one. */
  eventKey?: string;
}
export interface WaitActionInput {
  waitKey: string;
  expectedVersion: number;
  reason: string;
  idempotencyKey: string;
  /** Cancel: true only when the authorized caller states the blocker is gone. */
  resume?: boolean;
  /** Extend: the new absolute instants. */
  notBefore?: string;
  expiresAt?: string;
  nextCheckAt?: string;
}
export interface WaitActionView {
  ok: boolean;
  message: string;
  waitKey: string;
  taskId?: string;
  version?: number;
}
export interface WaitListView {
  waits: TaskWaitView[];
  total: number;
}
export interface WaitMigrationPreviewView {
  candidates: WaitMigrationCandidate[];
  /** Owner gates are never migrated automatically; the count says how many were held back. */
  ownerGatesBlocked: number;
  generatedAt: string;
}
/** SYS05: migrate exactly one legacy time-bounded task, under its version, after the dry-run. */
export interface WaitMigrationApplyInput {
  taskId: TaskId;
  expectedVersion: number;
  reason: string;
  idempotencyKey: string;
}

export interface CompanyCore {
  /** Read-only write-scope preflight for the dispatcher: the holders that would refuse an execute claim now (SYS-DISP R1). */
  writeScopeOf(taskId: TaskId, employeeId?: string): Promise<WriteScopeHolder[]>;
  authenticate(credential: Credential): Promise<Principal>;
  listTasks(credential: Credential, state?: TaskState): Promise<TaskView[]>;
  /**
   * Complete active leases (doing/review) held by the authenticated employee, with no list
   * preview, pagination, output budget or self-review row filter. Optional for old adapters;
   * a sidecar that needs to rebuild a lease after reload must fail closed without it.
   */
  activeLeases?(credential: Credential): Promise<ActiveLease[]>;
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
  /**
   * SYS05: enter a typed wait. Atomically stores the progress, releases the execution lease and takes the task out
   * of the dispatch queue until the condition is released. Optional for old adapters.
   */
  wait?(credential: Credential, proof: LeaseProof, evidence: Evidence, input: WaitEntryInput): Promise<TaskView>;
  /** SYS05: resolve a wait from a trust-checked external event (signed webhook, authorized manager, owner relay). */
  resolveWait?(credential: Credential, input: WaitResolveInput): Promise<WaitResolveView>;
  /** SYS05: cancel a wait under its version. Without `resume` the task stays blocked for the manager. */
  cancelWait?(credential: Credential, input: WaitActionInput): Promise<WaitActionView>;
  /** SYS05: extend/re-arm a wait under its version, with a reason. */
  extendWait?(credential: Credential, input: WaitActionInput): Promise<WaitActionView>;
  /** SYS05: read the waits of one task (or the open ones), gm/owner-side. */
  listWaits?(credential: Credential, input?: { taskId?: string; state?: string; limit?: number }): Promise<WaitListView>;
  /** SYS05: the owner handoff cards; unknown expiry stays unknown. */
  waitHandoffCards?(credential: Credential): Promise<WaitHandoffCard[]>;
  /** SYS05: read-only dry run for legacy tasks; never releases an owner gate. */
  waitMigrationPreview?(credential: Credential): Promise<WaitMigrationPreviewView>;
  /** SYS05: migrate one named legacy task into a wait; owner gates refused, version-locked, audited. */
  waitMigrationApply?(credential: Credential, input: WaitMigrationApplyInput): Promise<TaskView>;
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
  /** One byte segment of one worktree's references, as a cut listing item named it (SYS01 R1). Same scope as listWorktrees. */
  worktreeRefs?(credential: Credential, input: Record<string, unknown>): Promise<WorktreeRefsSegment>;
  taskText?(credential: Credential, input: Record<string, unknown>): Promise<TaskTextSegment>;
  adminSummary?(credential: Credential, input: Record<string, unknown>): Promise<AdminSummary>;
  /** gm (manage): record the code implementer of an execute-phase task; audited, idempotent, version-checked. */
  implementerTakeover?(credential: Credential, input: ImplementerTakeover): Promise<TaskView>;
  /** Manager (manage capability): write a task's independence policy. Optional for old adapters. */
  setIndependence?(credential: Credential, input: SetIndependence): Promise<TaskView>;
  /** Manager (manage capability): register an identity principal, or add/remove employees from it. Optional for old adapters. */
  setIdentityPrincipal?(credential: Credential, input: SetIdentityPrincipal): Promise<IdentityPrincipalView>;
  /**
   * gm and qa, read-only (SYS-DISP IR01-IR05): the verdict the independence gate would give for one employee on one task at one
   * stage. Writes nothing, so a done or void task stays readable. Optional for old adapters.
   */
  independenceCheck?(credential: Credential, input: IndependenceCheckInput): Promise<IndependenceCheckView>;
  /**
   * 有效策略层（SYS06 P1），manage 能力持有者（gm/product）：
   * 写入一版机器策略（显式替代、来源可核、同域冲突拒绝）、撤销、历史与当前有效视图查询、
   * 变更试算（dry-run 差异 + 受影响任务，只读）与执行隔离（把失去授权的在办任务置为可见的 blocked）。
   */
  policySet?(credential: Credential, input: PolicySet): Promise<PolicyView>;
  policyRevoke?(credential: Credential, input: PolicyRevoke): Promise<PolicyView>;
  policyList?(credential: Credential, input: PolicyListInput): Promise<PolicyView[]>;
  policyEffective?(credential: Credential, input: PolicyEffectiveInput): Promise<PolicyEffectiveView>;
  policyPlan?(credential: Credential, input: PolicyPlanInput): Promise<PolicyPlanView>;
  policyEnforce?(credential: Credential, input: PolicyEnforceInput): Promise<PolicyEnforceView>;
  /**
   * Ops broker 侧的受控工具/账号边界（SYS06 AC02 ③）：范围内生效的 tool_scope 决定允许清单与判定结果。
   * 判定与任务侧同源（policy.ts），别名规范形也与账户层一致；传了 tool 就返回该次调用的允许/拒绝结论。
   */
  policyToolScope?(project: string, input?: { tool?: string; alias?: string; toolNames?: readonly string[] }): Promise<{
    version: number; hash: string; allowedTools?: string[]; allowedAliases?: string[]; verdict: PolicyVerdict;
  }>;
  /**
   * SYS04 AC01/AC02: report one machine-classified failure and charge it against the recovery budget of the fault
   * object (task + controlled target + phase). The caller is the ops broker, which knows the phase, the identity
   * alias and the transport facts. The budget lives here, so it applies across holders, sessions and restarts.
   */
  reportFault?(scope: { taskId: TaskId; employeeId?: string }, input: {
    tool: string; phase: FaultPhase; stage?: FlowStage; errno?: string; status?: number; name?: string; alias?: string;
    elapsedMs?: number;
    target?: FaultTargetKind; environment?: string; message?: string; idempotent?: boolean; requestSent?: boolean;
    /** The attempt number the caller already reserved; the report must not charge it twice. */
    attempt?: number;
    /** False when the report only carries facts of a failure that was already charged. */
    charge?: boolean;
  }): Promise<{ allowed: boolean; message: string; evidence: Record<string, unknown> } | undefined>;
  /**
   * SYS04 AC02: reserve the next attempt of a fault object before the attempt runs. The reservation is spent
   * atomically, so the same operation cannot be retried past its budget by looping the tool, changing the session
   * or restarting — the server is the one that refuses.
   */
  reserveFault?(scope: { taskId: TaskId; employeeId?: string }, input: {
    phase: FaultPhase; target?: FaultTargetKind;
  }): Promise<{ allowed: boolean; attempt: number; charged: boolean; reason?: string; message: string; evidence: Record<string, unknown> } | undefined>;
  /**
   * SYS04 AC02: settle a successful attempt of a fault object. A call that works costs no recovery budget: the
   * reserved attempt is refunded and the recovery is over, so the next failure starts a fresh one.
   */
  settleFault?(scope: { taskId: TaskId; employeeId?: string }, input: { phase: FaultPhase; target?: FaultTargetKind }): Promise<void>;
  /**
   * Read-only fault diagnosis for one task: budget scopes, episodes, and any open repair chain. Secret-free.
   * Readable by the task holder, its reviewer, or gm — so a QA acceptance that hits a spent budget can see
   * nextAllowedAt / attempts / repairTaskId without guessing.
   */
  faultStatus?(credential: Credential, input: { taskId: TaskId }): Promise<FaultStatusView>;
  /**
   * gm only: lift a spent (or stopped) recovery budget for one incident of a task, after the cause is fixed
   * or a diagnosis has been recorded. Creates no new budget; resets the existing scope so the next attempt
   * starts a fresh recovery window. Audited.
   */
  faultLift?(credential: Credential, input: { taskId: TaskId; incident: string; reason: string; idempotencyKey: string }): Promise<FaultStatusView>;
  /**
   * Dispatcher-only: hand an execute-phase engineering task to a live engineer when the bound implementer's session is
   * gone for good (archived, missing, or a failure that cannot be restarted). Same compare-and-set write as the
   * manager's takeover, audited as `system:dispatcher`. Takes no credential and is never exposed as an agent tool.
   */
  systemImplementerTakeover?(input: { taskId: TaskId; toEmployee: EmployeeId; expectedVersion: number; reason: string }): Promise<TaskView>;  /** gm dry-run of the contributor derivation for up to 20 tasks; read-only (SYS-DISP AC05). */
  contributorDryRun?(credential: Credential, input: { taskIds: string[] }): Promise<ContributorDryRunView>;
  /**
   * SYS04: authorize a read of the plugin runtime diagnostics (gm/product/qa only) and answer it from the
   * caller's own execution context.
   *
   * `sample` is invoked only after the caller is known to be allowed, so an unauthorized read produces no
   * diagnostic at all rather than a refused one that still touched the filesystem. The core cannot take the
   * sample itself: only the plugin host can state what it loaded.
   */
  pluginRuntimeDiagnostics?(credential: Credential, sample: () => PluginRuntimeView | Promise<PluginRuntimeView>): Promise<PluginRuntimeView>;
  /** QA 受限只读取证（SYS-DISP 7454fc89）：GM 登记/撤销/查看范围；QA 换取一次性登录码与受限会话；只读读取。 */
  qaObservationGrant?(credential: Credential, input: QaObservationGrant): Promise<QaObservationScopeView>;
  qaObservationRevoke?(credential: Credential, input: QaObservationRevoke): Promise<QaObservationScopeView>;
  qaObservationStatus?(credential: Credential): Promise<QaObservationScopeView[]>;
  qaObservationSession?(credential: Credential, input: { scopeId?: string }): Promise<QaObservationSessionView>;
  qaObservationLogin?(code: string): Promise<QaObservationLoginView>;
  qaObservationRead?(auth: QaObservationAuth, input: QaObservationReadInput): Promise<QaObservationReadView>;
  qaObservationTimeline?(auth: QaObservationAuth, input: QaObservationReadInput & { pageSize?: number; cursor?: string }): Promise<QaObservationTimelineView>;
  qaObservationText?(auth: QaObservationAuth, input: { scopeId?: string; taskId: string; field: 'context' | 'evidence'; auditId?: string; offset?: number; limit?: number; expectSha256?: string }): Promise<QaObservationTextSegment>;
  /**
   * SYS03 AC01: claim one blocking episode's disposition. The episode is task+phase+start, keyed by a deterministic id, so
   * two managers claiming concurrently produce exactly one winner; the loser reads `already_handled` (with the decision) or
   * `held_by_other` (with the holder). An expired lease is taken over only with an explicit `takeover` and the episode
   * version the caller read. Optional for old adapters.
   */
  claimDisposition?(credential: Credential, input: DispositionClaimInput): Promise<DispositionClaimOutcome>;
  /** SYS03 AC01/AC04: hand a claim back before its lease expires (episode becomes claimable again); audited and notified. */
  releaseDisposition?(credential: Credential, input: { taskId: TaskId; phase: DispositionPhase; sinceMs: number; claimToken: string; reason: string }): Promise<DispositionClaimView>;
  /** SYS03 AC01/AC04 read-only: the episode's current claim and decision, plus the task's newest decided episodes. */
  dispositionStatus?(credential: Credential, input: DispositionStatusInput): Promise<DispositionStatusView>;
  /**
   * SYS03 AC02: one episode, one decision. resume/defer/dependency/retire/repair are recorded under an actor-independent
   * business idempotency key and a CAS on the claim token, the episode version and the task version; the task change, its
   * audit row and the notification outbox land in one transaction. Refused for a non-holder, an expired lease, a moved
   * version or an already handled episode.
   */
  decideDisposition?(credential: Credential, input: DispositionDecideInput): Promise<DispositionDecideOutcome>;
  /** SYS03 AC04: the caller's undelivered holder notices (persistent outbox); resend survives reconnect/restart. */
  dispositionNotices?(credential: Credential, input?: { ids?: string[] }): Promise<HolderNoticeView[]>;
  /** SYS03 AC04: delivery receipts. A failed delivery keeps the notice pending with its error; nothing is rolled back. */
  ackDispositionNotices?(credential: Credential, input: { ids: string[]; error?: string }): Promise<{ delivered: number }>;
  /**
   * SYS03 AC03: the controlled entry point for a system-side external action (today: cancel a CI run). Records the real
   * internal employee, the target run, the reason and the prerequisite task version; requested → result_unknown →
   * confirmed, retried idempotently under one actionKey. The shared provider account is never recorded as the owner.
   */
  cancelCiRun?(credential: Credential, input: ExternalActionRequestInput): Promise<ExternalActionView>;
  /** SYS03 AC03 read-only: reconcile provider-side run state against the action records; out-of-band changes become unknown_actor. */
  reconcileCiRuns?(credential: Credential, input: { runs: Array<{ repo: string; runId: string }> }): Promise<{ checked: number; unknownActor: ExternalActionView[]; confirmed: ExternalActionView[]; unreadable: string[] }>;
  /** SYS03 AC03: attach manager-supplied evidence to an unknown_actor record and name the real internal employee. */
  attributeCiRun?(credential: Credential, input: { actionKey: string; employeeId: string; evidence: string }): Promise<ExternalActionView>;
  /** SYS03 AC03 read-only: the recorded external actions. */
  listExternalActions?(credential: Credential, input?: { actionKey?: string; state?: string; limit?: number }): Promise<ExternalActionView[]>;

  listOutbox(credential: Credential, after?: string): Promise<OutboxEvent[]>;
  history(credential: Credential, taskId: TaskId): Promise<HistoryEntry[]>;
  companyBrief(credential: Credential): Promise<CompanyBrief>;
  /** gm relays an owner instruction received in a direct conversation; audited as gm-relayed. */
  relayGoal(credential: Credential, input: { text: string; ownerQuote: string; idempotencyKey: string; tier?: GoalTier; project?: string }): Promise<GoalView>;
  /** gm: pick the flow template for a goal waiting in triage. */
  triageGoal(credential: Credential, input: { goalId: string; tier: GoalTier; reason: string }): Promise<GoalView>;
  /** gm/product: one call creates 实现 → 上线申请 → 合入部署与生产实测 for a code change. */
  createDelivery(credential: Credential, input: CreateDelivery): Promise<TaskView[]>;
  /** SYS02: record server-verified machine evidence for one acceptance criterion. */
  recordAcceptanceEvidence?(credential: Credential, input: AcceptanceEvidenceInput): Promise<AcceptanceEvidenceRecord>;
  /** SYS02: read the gate and the current verdict for one task (its holder, reviewer, or gm). */
  acceptanceStatus?(credential: Credential, input: { taskId: TaskId }): Promise<AcceptanceStatusView>;
  /** SYS02: gm read of the versioned gate record. */
  acceptanceGate?(credential: Credential): Promise<AcceptanceGateView>;
  /** SYS02: gm versioned change of the gate; the reason and before/after are audited. */
  setAcceptanceGate?(credential: Credential, input: AcceptanceGateInput): Promise<AcceptanceGateView>;
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
  /** eval/gm only: each participant's actual models (executions, fences, phases, first/last) for modelScores. */
  modelEvidence?(credential: Credential, taskId: TaskId): Promise<Array<{employee:string;models:Array<{model:string;executions:number;fences:number[];phases:string[];first:string;last:string}>}>>;
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

export interface ModelAssessment { model: string; overall: number; notes?: string }

export interface EmployeeScore {
  modelScores?: ModelAssessment[];
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

// ---- 有效策略层（SYS06 P1）：版本化的机器策略、显式替代关系、当前有效契约 ----
// 类型定义在 src/policy.ts（受限 schema 与判定逻辑同处一文件，避免判定与字段漂移）；这里只做类型引用。
import type { EffectiveContract, EffectiveDomain, PolicyAuthorization, PolicyDomain, PolicyPayload, PolicyScope, PolicySource, PolicyStatus, PolicyVerdict } from './policy.ts';
import type { FaultDiagnostic, FaultPhase, FaultTargetKind, FlowStage } from './faults.ts';
export type { EffectiveContract, EffectiveDomain, PolicyAuthorization, PolicyDomain, PolicyPayload, PolicyScope, PolicySource, PolicyStatus, PolicyVerdict };

/** One budget scope of a task, as shown to a holder / reviewer / gm. Secret-free. */
export interface FaultBudgetView {
  key: string;
  target: string;
  phase: string;
  attempts: number;
  maxAttempts: number;
  totalAttempts: number;
  deadline: number;
  nextAllowedAt: number;
  failed: boolean;
  stopped: boolean;
  lastErrno?: string;
  lastHop?: string;
  lastIncident?: string;
  stopReason?: string;
  stopDiagnostic?: FaultDiagnostic;
}

/** One episode of a cause on a task. */
export interface FaultEpisodeView {
  episode: string;
  incident: string;
  fingerprint: string;
  phase: string;
  state: string;
  openedAt: string;
  updatedAt: string;
  resolvedAt?: string;
}

/** The open repair chain of an incident, when one exists. */
export interface FaultRepairView {
  incident: string;
  fingerprint: string;
  taskId?: string;
  sourceTaskId?: string;
  state: string;
  diagnostic?: FaultDiagnostic;
}

/** Read-only diagnosis of a task's recovery budget. Never carries credentials or upstream bodies. */
export interface FaultStatusView {
  taskId: TaskId;
  now: number;
  budgets: FaultBudgetView[];
  episodes: FaultEpisodeView[];
  repairs: FaultRepairView[];
}

/** 一版机器策略的登记内容（历史不可变：payload/hash 一版写定）。 */
export interface PolicyView {
  id: string;
  policyId: string;
  version: number;
  scope: PolicyScope;
  scopeRef?: string;
  domain: PolicyDomain;
  status: PolicyStatus;
  effectiveAt: string;
  expiresAt?: string;
  supersedes?: string;
  supersededBy?: string;
  /** 撤销留下的历史事实：谁撤的、为什么（历史不可变，撤销只关掉"当前生效"）。 */
  revokedBy?: string;
  revokeReason?: string;
  authorization: PolicyAuthorization;
  payload: PolicyPayload;
  hash: string;
  createdBy: EmployeeId;
  createdAt: string;
}

/**
 * 写入一版机器策略。授权来源只有老板转录（owner，须能对回一条已登记的老板方向）与经理/运营（manager）两种；
 * 同（作用域, 域）已有生效版本时必须显式 supersedes，否则拒绝——不允许"最新一条文本"静默覆盖。
 */
export interface PolicySet {
  policyId: string;
  scope: PolicyScope;
  scopeRef?: string;
  domain: PolicyDomain;
  payload: PolicyPayload;
  /** 被本版替代的版本（record id）；同域首次登记时省略。 */
  supersedes?: string;
  /** ISO 8601；缺省立即生效。 */
  effectiveAt?: string;
  /** ISO 8601；临时授权到期即自动退出有效视图，旧 claim 不能靠它继续写。 */
  expiresAt?: string;
  source: PolicySource;
  /** source=owner 时必须给出，且必须与已登记的老板方向一致；伪造的引文被拒绝。 */
  ownerQuote?: string;
  reason: string;
  idempotencyKey: string;
}

export interface PolicyRevoke {
  policyId: string;
  reason: string;
  idempotencyKey: string;
}

export interface PolicyListInput {
  scope?: PolicyScope;
  scopeRef?: string;
  domain?: PolicyDomain;
  /** true 时连被替代/被撤销的版本一起列出（历史查询）。 */
  includeInactive?: boolean;
}

export interface PolicyEffectiveInput {
  taskId?: TaskId;
  project?: string;
  goal?: string;
  /** 直接给作用域链的显式形式（dry-run 预览用）；给了 taskId/project/goal 时忽略。 */
  scopeChain?: Array<{ scope: PolicyScope; scopeRef?: string }>;
}

export interface PolicyEffectiveView {
  version: number;
  hash: string;
  chain: Array<{ scope: PolicyScope; scopeRef?: string }>;
  domains: EffectiveDomain[];
  /** 逐域渲染的当前有效契约；提示里只渲染这一段，历史文本留在 policy 表。 */
  rendered: string;
  /** 人读的必要说明（非机器契约）：到期与被替代的当前事实。 */
  notes: string[];
}

export interface PolicyPlanInput {
  policyId: string;
  scope: PolicyScope;
  scopeRef?: string;
  domain: PolicyDomain;
  payload: PolicyPayload;
  supersedes?: string;
  effectiveAt?: string;
  expiresAt?: string;
  source: PolicySource;
  ownerQuote?: string;
  /** 受影响清单的分页（SYS06 R1(b)）：不给就一页，装不下就明确提示怎么翻页；给了就只返回一页。 */
  pageSize?: number;
  /** 上一页 page.nextCursor。光标绑定同一份试算（同一调用者、同一提案、同一 planHash）。 */
  cursor?: string;
}

/**
 * policy_plan 一页的元数据（SYS06 R1(b)）：affectedTasks 只是 total 里的这一页，正文按真实序列化大小裁到 48 KiB 预算内。
 * 单条就超预算时没有可分页的余地（总数 1 也装不下），这时抛 invalid 并给出该条的字节数——不是 response_too_large，
 * 也不是"收窄查询"能解决的：受影响清单没有收窄入参。
 */
export interface PolicyPlanPage {
  pageSize: number;
  returned: number;
  total: number;
  hasMore: boolean;
  nextCursor?: string;
  budgetBytes: number;
}

/** 试算（dry-run）：算出契约差异与受影响任务，写任何东西之前先给人看。 */
export interface PolicyPlanView {
  scopeChain: Array<{ scope: PolicyScope; scopeRef?: string }>;
  before: EffectiveContract;
  after: EffectiveContract;
  diff: Array<{ domain: PolicyDomain; before: string; after: string; scope?: PolicyScope; scopeRef?: string }>;
  /** 受影响的任务：登记的契约 hash 与试算结果不同（含已在办的）。一页的内容见 page；planHash 覆盖全量。 */
  affectedTasks: Array<{ id: TaskId; title: string; state: TaskState; currentEmployee?: EmployeeId; fromHash?: string; toHash: string; losesAuthorization: boolean;
    /** 会拦下它的原因（与派工/领取的拒绝理由同源）；losesAuthorization=false 时省略。 */
    reason?: string }>;
  /** 候选集扫描的事实（SYS06 R1）：扫了多少在办任务、上限是多少。 */
  scanned: number;
  scanLimit: number;
  /** 扫描被上限截断（不止 200*50 条在办任务）；与 page 无关，是候选集本身不完整的显式信号。 */
  truncated: boolean;
  /** 受影响清单的分页：受影响总数、这一页与下一页光标。 */
  page: PolicyPlanPage;
  /**
   * 试算结果的指纹：覆盖生效 epoch、after 契约 hash 与全量受影响清单（与分页无关，翻页时不变）。
   * 它只用于翻页光标的绑定与人工核对——policy_enforce **不读它**：隔离时对每个**点名**任务按当时的有效契约重新判定，
   * 所以被点名的那批里，该隔离的会隔离、不该隔离的不会被误伤（判定结果变了就如实报 blocked/absent）。
   * 但 policy_enforce 只处理点名的 taskIds：试算之后**新出现**且失去授权的在办任务不在这一批里，不会被碰，
   * 执行前若在办清单可能已经变了，应先重跑 `policy_plan` 再按新清单隔离。
   */
  planHash: string;
}

/** 执行试算结果：对已失去授权的在办任务做可见隔离（置为等待 GM 的 blocked），旧 release 也认得这个状态，不会误派工。 */
export interface PolicyEnforceInput {
  taskIds?: TaskId[];
  reason: string;
  idempotencyKey: string;
}

export interface PolicyEnforceView {
  blocked: TaskId[];
  alreadyBlocked: TaskId[];
  absent: TaskId[];
  audited: number;
}
