/** v1 core/adapter boundary. The MCP adapter supplies an opaque credential on every call. */
/** 'eval' is a workforce-only judge role: it reads task history and writes scorecards, never claims tasks. */
/** 'owner' is the control-plane principal (no employee_def); 'gm' is a retired literal kept only so legacy enrollment fixtures can be mapped to owner. */
export type Role = 'gm' | 'owner' | 'product' | 'engineering' | 'ai-content' | 'concept-design' | 'asset-production' | 'screenwriter' | 'story-author' | 'cinematography' | 'qa' | 'cs' | 'eval';
export const ROLES: readonly Role[] = ['product', 'engineering', 'ai-content', 'concept-design', 'asset-production', 'screenwriter', 'story-author', 'cinematography', 'qa', 'cs', 'eval'];
/** 'void' is terminal: retired work never re-enters dispatch and counts as satisfied in dependency evaluation. */
export type TaskState = 'blocked' | 'ready' | 'doing' | 'review' | 'done' | 'void' | 'planned';
/** Trusted retirement type, set only by server-side callers (session rotation, scene archive, failures),
 * never taken from a free-text reason. rotation and archive end a session normally; failure and manual do not. */
export type RetirementKind = 'rotation' | 'archive' | 'failure' | 'manual';
/** 'owner' is the human company owner; only owner decisions can accept an owner-reviewed gate. */
export type ReviewerRole = Role | 'owner';
/** release：上线申请，由运营（或 Jev）决定是否上线；deploy：合入部署，由 qa 在生产实测验收。 */
export type TaskKind = 'goal' | 'task' | 'gate' | 'release' | 'deploy';
/** quick：单一需求，一个任务即可完成；standard：方向清楚的一个任务，需要更多步时老板加任务并用依赖串起来；program：方向性目标，老板按需求拆成多个任务并用依赖串起来。 */
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

/** A versioned, reason-audited change of the gate (SYS02 AC06). Only owner may call it. */
export interface AcceptanceGateInput { enabled: boolean; reason: string; expectedVersion: number; idempotencyKey: string }

/** SYS-INT: read-only preview of the versioned acceptance mapping for one legacy gated row. */
export interface WorkIntent { kind: 'read' | 'code' | 'assets'; paths?: string[]; lane?: string }
export interface WorktreeAssignment {
  id: string; repo: string; project?: string; worktreePath: string;
  mode: 'shared' | 'exclusive' | 'protected'; branch?: string;
  /** Legacy row column kept for compatibility; new code tasks always get their own task/<id8> branch. */
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
 */
export interface TaskView {
  companyUpgrade?: import('./company-release.ts').CompanyRelease;
  id: TaskId;
  title: string;
  context: string;
  /** Owner-edited requirement, staged verbatim as task.md's 需求 section. */
  requirement?: string;
  /** Owner-edited acceptance criteria, staged verbatim as task.md's 验收标准 section. */
  acceptanceText?: string;
  state: TaskState;
  executorRole: Role;
  reviewerRole: ReviewerRole;
  /** Project-scoped discipline track (e.g. 编剧/分镜): only defs whose `tracks` list covers it may claim. */
  discipline?: string;
  kind: TaskKind;
  /** Task-level project override (registered project id); undefined inherits the chain routing. */
  projectOverlay?: string;
  /**
   * Explicit code-repo binding (owner only): overrides the repo used for worktree allocation and
   * dispatch repoHome/cwd. Never affects business project resolution (claim.json.project,
   * opsScope, broker quotas) — that stays with projectOverlay/project.
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
  acceptanceChain?: string;
  version: number;
  submittedBy?: EmployeeId;
  currentEmployee?: EmployeeId;
  deliveryId?: DeliveryId;
  leaseExpiresAt?: string;
  fence: number;
  blockedTo?: 'owner';
  /** Blocked rows: the phase to restore when the wait ends (ready/doing -> ready, review -> review). */
  resumeState?: TaskState;
  /** Blocked rows: the role recorded by the original block, kept for cross-role display and validation. */
  resumeRole?: string;
  /** The route type this task was created under; routes record the executor/reviewer at creation. */
  type?: string;
  /** Chain predecessor: the task this one follows. A task with an unfinished parent stays 'planned'. */
  parent?: TaskId;
  /** The submit audit id whose `next` proposal created this task. */
  proposedIn?: string;
  /** Optional grouping tag (replaces goal grouping). */
  tag?: string;
  /** Set when the previous holder's lease was revoked; the next holder must read the handover history. */
  handover?: boolean;
  previousEmployee?: EmployeeId;
  modelTier?: 'fable' | 'opus' | 'sonnet' | 'haiku' | 'high' | 'medium' | 'low';
  workIntent?: WorkIntent;
  worktree?: WorktreeAssignment;
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
   * the SHA-256 of the whole JSON. read_task_text (field workIntentPaths or worktreePaths) returns the whole list.
   */
  listsTruncated?: Partial<Record<'workIntentPaths' | 'worktreePaths', ListCut>>;
  /**
   * Set on a task echo (SYS01 R3): each text field other than the context that was cut to its leading part, with the size and the
   * SHA-256 of its whole value. The whole value is not readable through read_task_text.
   */
  fieldsTruncated?: Record<string, FieldCut>;
  /** 创建时的有效契约登记（SYS06 AC03）：策略版本与 hash，以及逐域契约本体。旧行没有它，语义是"无有效契约"。 */
  /** 被策略收权隔离的原因（可见状态：blocked，等待 owner），旧 release 也认得这个状态。 */
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
 * One part of the company block (get_context with scope company, SYS01 AC-A). The meta part carries `paused`. Each direction
 * and project is one item: its JSON text is cut into parts of a page's size, in order. A reader joins the `json` of the parts of one
 * (section, key) item, checks the joined UTF-8 length against `totalBytes` and its SHA-256 against `sha256`, then parses it.
 */
export interface CompanyPart {
  section: 'meta' | 'directions' | 'projects';
  /** Stable within the listing: `company` for the meta part, `direction-<position>` for a direction, the id for a project. */
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
  section?: 'directions' | 'projects';
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
 * What read_task_text reads. context and evidence are text. project is the project environment as JSON (holder or owner only),
 * and workIntentPaths and worktreePaths are the task's lists as JSON arrays, so a claim echo that cut them can be
 * read back whole (SYS01 R3).
 */
export type TaskTextField = 'context' | 'evidence' | 'project' | 'workIntentPaths' | 'worktreePaths';

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
 * when its references were cut: the same task/owner scope as the listing, the whole list's size and SHA-256, and a byte window
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

/** owner-only read-only summary (SYS01): counts at a cutoff, never task text. */
export interface AdminSummary {
  /** Database time of the read. Every count reflects the database as it stood then. */
  cutoffAt: string;
  /** Start of the audit window, [since, cutoffAt]. Declared even when the task counts ignore it. */
  since: string;
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
  /** Route type: fills executor/reviewer (and optional next-chain expansion) when given. */
  type?: string;
  /** Chain predecessor: parent unfinished → the new task is 'planned'. */
  parent?: string;
  /** Owner-edited requirement staged as task.md's 需求 section. */
  requirement?: string;
  /** Owner-edited acceptance staged as task.md's 验收标准 section. */
  acceptanceText?: string;
  /** Hold the generated dispatch drafts for owner review before release. */
  hold?: boolean;
  /** The submit audit id a proposal was created under. */
  proposed_in?: string;
  /** Optional discipline track; when the task's project defines a non-empty `disciplines` vocabulary the value must be in it. */
  discipline?: string;
  kind?: Exclude<TaskKind, 'goal'>;
  /** Optional project override: registered project id only. */
  project?: string;
  /**
   * Optional code repository (ops repo or a registered project repo_path) the task's worktree is allocated in; the business
   * project is unchanged. Omitted: a code/release/deploy task whose context names the ops repo path, under a project with
   * another repo, is bound to the ops repo; otherwise the project's repo is used.
   */
  codeRepoPath?: string;
  tag?: string;
  /** SYS02: required for new code deliveries when the acceptance gate is enabled. */
  acceptanceCriteria?: AcceptanceCriterion[];
  /** SYS02: controlled environment declaration for this task (e.g. production); evidence must match it exactly. */
  acceptanceEnvironment?: string;
  idempotencyKey: string;
  modelTier?: 'fable' | 'opus' | 'sonnet' | 'haiku' | 'high' | 'medium' | 'low';
  workIntent?: WorkIntent;
  /**
   * Controlled screenplay-revision edge (product only): both drafts must be owner-reviewed
   * screenwriter tasks on the 编剧 track (kind=task) in the same project; the target
   * must be the unapproved, unsuperseded chain tip whose latest submission drew a real owner
   * rejection. The service atomically voids the target (supersededBy pointer), inherits the
   * lineage, and lets the new draft start once its own parent is satisfied —
   * the edge never exempts other tasks.
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
  /** This claim's lane and the notes.md text for it; read failure leaves both absent. */
  lane?: string;
  laneNotes?: string;
  /** Project environment of the task's goal: where it ships, how to verify, red lines. Credentials are never part of it. */
  project?: ProjectView;
  worktree?: WorktreeAssignment;
  /**
   * The effective policy contract this claim was granted under (SYS06 AC03). Rendered so the prompt carries exactly the current
   * contract; `history` on the policy itself stays queryable. Undeniable: the claim is refused before it is written if a
   * change since the read dropped the authorization.
   */
}

/** Result of the ops broker gate; `project` is the id of the project the task's goal belongs to. */
export interface OpsScope {
  actor: Principal;
  taskId: TaskId;
  project: string;
}

/** The restricted authorization a recovery read grant carries into one ops call. */
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

export interface RetireTask {
  taskId: TaskId;
  /** Business reason for the retirement; audited together with the before-state snapshot. */
  text: string;
  idempotencyKey: string;
  /** Optimistic concurrency: refuse when the task version has moved. */
  expectedVersion?: number;
}

/** The phase a policy applies to: taking and writing code (execute), or deciding a review. */
export interface LeaseProof {
  taskId: TaskId;
  deliveryId: DeliveryId;
  fence: number;
  expectedVersion: number;
}

export interface Evidence {
  /** Engineering company-system release/deploy only. Bound to this lease write and a reviewed main commit. */
  companyUpgrade?: { sha: string };
  text: string;
  idempotencyKey: string;
  /** SYS02: the head this submission is bound to; machine evidence must match it. */
  acceptance?: { sha?: string; environment?: string };
  /** Top-level shorthand for acceptance.sha (code deliverables may pass either). */
  sha?: string;
  /** Follow-up proposals, max 20: each creates a planned child typed through the route table. */
  next?: Array<{ type: string; title: string; requirement?: string; acceptance?: string }>;
  /** Lessons for this lane's long-term notes, max 5: they take effect only once the task is done. */
  learned?: string[];
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
 * SYS04: what the plugin process is actually running. Read-only, and read by product/qa only: it names the
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
export const PLUGIN_RUNTIME_ROLES: readonly Role[] = ['product', 'qa'];



/**
 * SYS05: typed wait entry. The employee hands over why it stops; the core normalizes, stores the progress and
 * releases the lease in one transaction. Times must carry an explicit offset.
 */
export interface CompanyCore {
  /** Read-only write-scope preflight for the dispatcher: the holders that would refuse an execute claim now (SYS-DISP R1). */
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
  /** owner: ownership reclaim or dry-run across registered repos (WT02). */
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
  block(credential: Credential, proof: LeaseProof, to: 'owner', evidence: Evidence, quotaResetsAt?: string): Promise<TaskView>;
  resume(credential: Credential, taskId: TaskId, evidence: Evidence): Promise<TaskView>;
  /** product: mark a task 'void' (terminal), release any lease on it, and release any planned children. */
  retireTask(credential: Credential, input: RetireTask): Promise<TaskView>;
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
  }): Promise<{ allowed: boolean; attempt: number; charged: boolean; reason?: string; message: string; evidence: Record<string, unknown>; refund?: FaultRefund } | undefined>;
  /**
   * SYS04 AC02: settle a successful attempt of a fault object. A call that works costs no recovery budget: the
   * reserved attempt is refunded and the recovery is over, so the next failure starts a fresh one.
   */
  settleFault?(scope: { taskId: TaskId; employeeId?: string }, input: { phase: FaultPhase; target?: FaultTargetKind }): Promise<void>;
  /**
   * Refund a reservation whose call never ran. Unlike `settleFault`, this restores only the reserved attempt and
   * keeps the earlier failure facts; a newer failure, stop, lift or success makes the refund a no-op.
   */
  refundFault?(scope: { taskId: TaskId; employeeId?: string }, input: {
    phase: FaultPhase; target?: FaultTargetKind; refund: FaultRefund;
  }): Promise<{ refunded: boolean }>;
  /**
   * SYS04: authorize a read of the plugin runtime diagnostics (product/qa only) and answer it from the
   * caller's own execution context.
   *
   * `sample` is invoked only after the caller is known to be allowed, so an unauthorized read produces no
   * diagnostic at all rather than a refused one that still touched the filesystem. The core cannot take the
   * sample itself: only the plugin host can state what it loaded.
   */
  pluginRuntimeDiagnostics?(credential: Credential, sample: () => PluginRuntimeView | Promise<PluginRuntimeView>): Promise<PluginRuntimeView>;

  listOutbox(credential: Credential, after?: string): Promise<OutboxEvent[]>;
  history(credential: Credential, taskId: TaskId): Promise<HistoryEntry[]>;
  companyBrief(credential: Credential): Promise<CompanyBrief>;
  /** SYS02: record server-verified machine evidence for one acceptance criterion. */
  recordAcceptanceEvidence?(credential: Credential, input: AcceptanceEvidenceInput): Promise<AcceptanceEvidenceRecord>;
  /** SYS02: read the gate and the current verdict for one task (its holder, reviewer, or owner). */
  acceptanceStatus?(credential: Credential, input: { taskId: TaskId }): Promise<AcceptanceStatusView>;
  /** SYS-INT: start one controlled non-production deploy drill (task holder or owner; audited, host-executed). */
  deployDrillRun?(credential: Credential, input: { taskId: TaskId; runId: string; baseSha: string; candidateSha: string; idempotencyKey: string }): Promise<{ runId: string; pid: number; root: string }>;
  /** SYS-INT: read one deploy drill's state and structured stage records. */
  deployDrillStatus?(credential: Credential, input: { runId: string }): Promise<{ state?: { runId: string; status: string; phase?: string; error?: string }; stages?: string[] }>;
  /** SYS02: owner read of the versioned gate record. */
  acceptanceGate?(credential: Credential): Promise<AcceptanceGateView>;
  /** SYS02: owner versioned change of the gate; the reason and before/after are audited. */
  setAcceptanceGate?(credential: Credential, input: AcceptanceGateInput): Promise<AcceptanceGateView>;
  /**
   * owner only: rebind a blocked task to a registered project (task-level override over goal.project).
   * Version-guarded, idempotent, fully audited; releases the stale worktree assignment through the
   * normal lifecycle (the physical tree itself is never deleted here).
   */
  taskProjectUpdate?(credential: Credential, input: { taskId: TaskId; project: string; expectedVersion: number; text: string; idempotencyKey: string }): Promise<TaskView>;
  /** manage (product): list every employee_def row for workforce review. */
  listDefs(credential: Credential): Promise<DefView[]>;
  /** manage (product): create or update an employee_def via the shared workforce writer; audited. */
  ensureDef(credential: Credential, input: EnsureDef): Promise<DefView>;
  /** manage (product): replace only the project's disciplines vocabulary; audited. */
  updateProjectDisciplines(credential: Credential, input: { project: string; disciplines: Array<{ name: string; description?: string; roles?: Role[] }> }): Promise<ProjectView>;
  /** Ops broker gate: the caller must hold the task's current lease and the task's goal must name a project. */
  opsScope(credential: Credential, taskId: TaskId, proof?: { grantId: string; grantFence: number }): Promise<OpsScope>;
  /** Appends a secret-free `ops_*` record to the task's audit trail. Only `ops_call` rows stay out of handover history. */
  auditOps(scope: OpsScope, action: string, evidence: string): Promise<void>;
  /** How many `action` audit rows tasks of this project wrote in the last `windowSeconds`; backs broker quotas. */
  opsCount(project: string, action: string, windowSeconds: number): Promise<number>;
  relayOwnerDecision(credential: Credential, input: OwnerDecisionInput & { ownerQuote: string }): Promise<TaskView>;
  relayDirection(credential: Credential, input: { text: string; ownerQuote: string; idempotencyKey: string }): Promise<void>;
  /** eval role only: score every employee who participated in a finished task. Marks the task evaluated. */
  /** eval/owner only: each participant's actual models (executions, fences, phases, first/last) for modelScores. */
  modelEvidence?(credential: Credential, taskId: TaskId): Promise<Array<{employee:string;models:Array<{model:string;executions:number;fences:number[];phases:string[];first:string;last:string}>}>>;
  recordScore(credential: Credential, input: { taskId: TaskId; summary: string; scores: EmployeeScore[]; complexity?: number }): Promise<{ recorded: number; participants: string[] }>;
  /** eval/product: what a task consumed (tokens, USD, model time, elapsed) from Magpie, computed on first read. */
  taskCost?(credential: Credential, taskId: TaskId): Promise<import('./task-cost.ts').TaskCost | { taskId: TaskId; available: false; reason: string }>;
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

export interface CompanyBrief {
  directions: { text: string; source: string; at: string }[];
  projects: ProjectView[];
  paused: boolean;
}

/** Administrative enrollment is deliberately outside the MCP adapter. */
export interface EnrollmentAdmin {
  enroll(employeeId: EmployeeId, role: Role, capabilities: Principal['capabilities']): Promise<Credential>;
  revoke(employeeId: EmployeeId): Promise<void>;
}

import type { FaultDiagnostic, FaultPhase, FaultRefund, FaultTargetKind, FlowStage } from './faults.ts';

/** One budget scope of a task, as shown to a holder / reviewer / owner. Secret-free. */