// Plain JSON shapes mirroring the company DB views. Kept self-contained: shared/ cannot import the repo.

export type GoalTier = "quick" | "standard" | "program";
export type TaskState = "blocked" | "ready" | "doing" | "review" | "done" | "void";
export type Role = "gm" | "product" | "engineering" | "ai-content" | "concept-design" | "asset-production" | "screenwriter" | "story-author" | "cinematography" | "qa" | "cs" | "eval";
export type TaskKind = "goal" | "task" | "gate" | "release" | "deploy";

export interface TaskView {
  id: string;
  title: string;
  context: string;
  state: TaskState;
  executorRole: Role;
  reviewerRole: Role | "owner";
  discipline?: string;
  kind: TaskKind;
  goalId?: string;
  dependencies: string[];
  version: number;
  submittedBy?: string;
  currentEmployee?: string;
  deliveryId?: string;
  leaseExpiresAt?: string;
  blockedTo?: "gm" | "owner";
  /** Blocked rows: the phase restored when the dependency wait ends. */
  resumeState?: TaskState;
  /** Blocked rows: the role recorded by the original block. */
  resumeRole?: string;
  /** Blocked rows: why the task waits (see src/contracts.ts TaskWaiting). */
  waiting?: { kind: "manager" | "owner" | "dependency"; resumeState: TaskState | "unknown"; role: string; dependenciesCount: number };
  previousEmployee?: string;
}

export interface GoalView {
  id: string;
  title: string;
  brief: string;
  state: "triage" | "active" | "done" | "cancelled";
  tier?: GoalTier;
  project?: string;
  tasks: { intake?: string; plan?: string; manual?: string; acceptance?: string };
}

export interface ProjectView {
  id: string;
  name: string;
  repoPath: string;
  defaultBranch: string;
  release: string;
  rollback?: string;
  redLines: string[];
  runbooks: string[];
  notes?: string;
  envs: Array<{ name: string; url?: string; healthUrl?: string; verify?: string }>;
}

export interface AuditEntry {
  action: string;
  actor: string;
  evidence?: string;
  version?: number;
  at: string;
}

export interface Inbox {
  gates: Array<{ task: TaskView; submission?: string }>;
  questions: Array<{ task: TaskView; question?: string }>;
  notices: Array<{ key: string; text: string; at: string }>;
  pendingCommands: number;
}

/**
 * 公司动态一页答「发生了什么」：谁在干什么、什么卡住了、为什么没人领、
 * 最近做完了什么、资源有没有异常。全部来自任务服务与调度器同一套判定。
 */
/** The lists of the pulse answer that carry a truncation marker (see the bounds field). */
export type PulseListName = "dispatchBlocked" | "goalBlockers" | "workflowWaits" | "ready" | "doing" | "stuck" | "waiting" | "recentDone" | "goals" | "resources";

export interface Pulse {
  /** When this answer was built (request time). Live lists (doing, stuck, waiting, ...) read as of this instant. */
  at: string;
  /** When the dispatch conclusions were checked: the pass's snapshot. Dispatch lists and the ready queue are as of this instant. */
  dispatchAt?: string;
  paused: boolean;
  /** state=doing 的任务 */
  doing: Array<{ taskId: string; title: string; employee?: string; role: string; discipline?: string; goal?: string; sinceMin?: number }>;
  /** 就绪但还没被领走的任务；unclaimableReason 是 tick 对 execute 阶段的不可派原因（与公司通知同文） */
  ready: Array<{ taskId: string; title: string; role: string; discipline?: string; waitingMin: number; unclaimableReason?: string }>;
  /** 本轮 tick 判定派不出去的工作（execute 与 review 两阶段），与公司通知同源 */
  dispatchBlocked: DispatchBlockedView[];
  /** 每个目标的派工不可派结论根，沿用既有 dispatcher pass。 */
  goalBlockers: GoalRootBlockerView[];
  /** 独立采集的目标工作流等待根；不代表派工失败，时间与 dispatcherAt 分开。 */
  workflowWaits: Array<{ goalId?: string; taskId: string; title: string; workflowState: "ready" | "doing" | "review" | "blocked" | "done" | "void" | "unknown";
    kind: "dependency" | "manager" | "owner" | "active_lease" | "unknown"; basis: string;
    waitingForRole: string; nextTrigger: string; goalRootCount: number; impact?: number; dependencyPath?: Array<{ taskId: string; title: string }>;
    unknownReason?: string; dependencyPathTruncated?: boolean; people?: { implementer?: string; authors: string[]; reviewers: string[]; submitter?: string; submitCommit?: string; peopleOmitted?: number };
    peopleSource?: string; submitterSource?: string; submitCommitSource?: string; peopleCheckedAt?: string; submitCheckedAt?: string }>;
  workflowWaitSummary: { source: 'workflow-graph'; available: boolean; checkedAt?: string; totalRoots: number; truncated: boolean; reason?: string };
  /** 依赖全部完成却仍 blocked（需解锁）等异常卡滞 */
  stuck: Array<{ taskId: string; title: string; reason: string }>;
  /** 等老板拍板/回答（带已等时长与下游受阻数） */
  waiting: Array<{ taskId: string; kind: "gate" | "question"; title: string; goal?: string; hours: number; downstream: number }>;
  /** 最近完成（accept/owner_approve） */
  recentDone: Array<{ taskId: string; title: string; at: string; actor?: string }>;
  last24h: { done: number; returned: number; rolledBack: number; rejected: number; retired: number };
  /** 订阅健康/低额度异常行（正常时为空） */
  resources: string[];
  churn: { created: number; retired: number; claimLost: number };
  goals: Array<{ title: string; days: number }>;
  /** Truncation markers for every list above: how many items existed, and whether the answer left some out. */
  bounds: Record<PulseListName, ListBound>;
}

/** A bounded list's truncation marker. `total` is the count before the cap; `truncated` is true when `shown < total`. */
export interface ListBound {
  total: number;
  shown: number;
  truncated: boolean;
}

/** One regular file inside a task's evidenceDir (<serviceHome>/evidence/<taskId>). */
export interface TaskAttachment {
  name: string;
  relPath: string;
  sizeBytes: number;
  kind: "image" | "video" | "html" | "audio" | "other";
}

export interface Brief {
  directions: Array<{ text: string; source: string; at: string }>;
  goals: GoalView[];
  projects: ProjectView[];
  paused: boolean;
}

export interface ProviderUsageView {
  providerId: string;
  displayName: string;
  planLabel?: string | null;
  status: string;
  windows: Array<{ label: string; remainingPct?: number | null; resetsAt?: string | null; tone?: string }>;
  balances: Array<{ label: string; remaining?: number | null; limit?: number | null; unit?: string; tone?: string }>;
}

/** One candidate row in a staffing pool: an existing instance (reuse) or a def that could spawn. */
export interface StaffingEntryView {
  kind: "reuse" | "spawn";
  /** inst id for reuse, def id for spawn. */
  ref: string;
  /** effectiveWeight — the exact number weightedOrder picks by. */
  weight: number;
  /** Share of this candidate's weight among eligible candidates in the same pool (0..1). */
  share: number;
  eligible: boolean;
  reason?: string;
  /** Machine code behind `reason`, the same code the dispatch-blocked verdict groups by. */
  code?: string;
  model?: string;
}

/** The candidate pool for one role in one project, evaluated by the same staffingPool the tick uses. */
export interface StaffingPoolView {
  role: string;
  /** Repository path the pool is scoped to. */
  home: string;
  entries: StaffingEntryView[];
}

export interface ReviewStaffingPoolView extends StaffingPoolView {
  taskId: string;
  title: string;
  purpose: "review";
  status: "ready" | "blocked" | "history_unavailable";
}

/** The root blocker of one goal card: the verdict it names first, and the other blocked work behind the goal. */
export interface GoalRootBlockerView {
  goalId: string;
  taskId: string;
  title: string;
  phase: "execute" | "review";
  summary: string;
  feasible: boolean;
  since?: string;
  waitingMinutes: number;
  others: number;
  /** Blocked work of this goal, the root included: the 无法派工 count, shown apart from the normal waits (impact). */
  undispatchable: number;
  /** The root's workflow state (ready, doing or review), its eligible-candidate count, and when its conclusion was checked. */
  workflowState: "ready" | "doing" | "review";
  eligibleCount: number;
  checkedAt: string;
  /** Unfinished tasks waiting on this root, directly or through other tasks. */
  impact: number;
  dependencyPath: Array<{ taskId: string; title: string }>;
  /** People behind the root. `peopleOmitted` counts the names the row left out. */
  people: { implementer?: string; authors: string[]; reviewers: string[]; submitter?: string; submitCommit?: string; peopleOmitted?: number };
  reasons: DispatchReasonView[];
}

/** One dispatch-blocked conclusion from the latest tick, owner-facing. Same summary text as the notice for that episode. */
export interface DispatchBlockedView {
  taskId: string;
  goalId?: string;
  title: string;
  phase: "execute" | "review";
  /** The task's workflow state (ready, doing or review). The row itself is the dispatch status: it is blocked. */
  workflowState: "ready" | "doing" | "review";
  summary: string;
  /** When the conclusion was checked (ISO 8601). Eligible candidates at that check: zero for every row, stated explicitly. */
  checkedAt: string;
  eligibleCount: number;
  /** False when the block is material at once (owner decision needed, or candidate state unknown). */
  feasible: boolean;
  since?: string;
  waitingMinutes: number;
  reasons: DispatchReasonView[];
}

/** One effective reason in an owner-facing row. `candidatesOmitted` counts the candidates the row left out. */
export interface DispatchReasonView {
  code: string;
  text: string;
  candidates: string[];
  candidatesOmitted?: number;
  owner: "gm" | "owner" | "system";
  /** The source the code was read from, for example "contribution-audit". */
  basis: string;
  recovery: string;
  /** Structured recovery actions; `executable` is false when no operations tool performs the action. */
  actions: Array<{ authority: "gm" | "owner" | "system"; label: string; tool?: string; executable: boolean }>;
  nextTrigger: string;
}

export interface Roster {
  paused: boolean;
  /** The operations repo; pools whose home equals this render as the default project. */
  opsRepo: string;
  usage: ProviderUsageView[];
  defs: Array<{ id: string; role: string; provider: string; model: string; resolved?: string; thinking?: string; enabled: boolean; maxInstances: number; weight?: number; avgScore?: number; quotaLimited?: boolean }>;
  /** What the roster renders: the instance name, its def, and the tick's session status. */
  instances: Array<{ id: string; def?: string; agentStatus?: string }>;
  health: Array<{ provider: string; state: string; lastError?: string; until?: number }>;
  /** Live staffing preview per role+project — same function, same inputs as the dispatcher tick. */
  pools: StaffingPoolView[];
  reviewPools: ReviewStaffingPoolView[];
  /** Dispatch-blocked verdicts from the latest tick: the roster and the tick cannot disagree. */
  dispatchBlocked: DispatchBlockedView[];
  /** Truncation marker for every list above: how many items existed, and whether the answer left some out. */
  bounds: Record<"dispatchBlocked" | "reviewPools" | "pools" | "instances" | "defs" | "usage" | "health", ListBound>;
  /** When the tick last observed sessions; roster status is that observation, not a second read. */
  sessionsObservedAt?: string;
  /** When the pass's snapshot was taken: the pools, review previews and dispatch-blocked rows above are as of this instant. */
  dispatchAt?: string;
}

export interface ModelOption {
  id: string;
  label: string;
  isDefault?: boolean;
  thinkingOptions: Array<{ id: string; label: string; isDefault?: boolean }>;
}

export interface ProviderOption {
  id: string;
  label: string;
  status: string;
  families: Array<{ slot: string; resolvesTo: string }>;
  models: ModelOption[];
}

export interface ProviderOptionsResult {
  roles: string[];
  providers: ProviderOption[];
}

export interface PermissionRequest {
  agentId: string;
  title?: string;
  employeeId?: string;
  role?: string;
  request: { id: string; kind?: string; summary?: string; detail?: string };
}

/** Actual Magpie member order with facts from its latest successful Jev ranking. */
export interface ModelRankingTable {
  group: string; at?: string; rules?: string; scored: boolean;
  rows: Array<{
    model: string; pinned?: boolean; trends?: import("./model-trends.ts").ModelTrends; trendSource?: {available:boolean;collectedAt:string}; aaScore?: number; aaRank?: number; effort?: string;
    tokensPerSecond?: number; ttftMs?: number; stabilityPct?: number; stabilitySamples?: number;
    accounts: Array<{account: string; remainingPct?: number}>;
    performanceScore?: number; performanceSamples?: number;
    jevScore?: number; jevConfidence?: number;
  }>;
}
