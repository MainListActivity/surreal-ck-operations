import { git, readCompanyRelease, type CompanyRelease } from './company-release.ts';
import { checkLearned, LaneNoteStore, laneOf } from './lane-notes.ts';
import { getRoute, listRoutes, CHAIN_LIMIT, type RouteRow } from './routes.ts';
import { OutboundMessageStore } from './outbound-messages.ts';
import type { DrillState } from './deploy-drill-service.ts';
import { validateDrillPlan } from './deploy-drill.ts';
import { authenticationLookup } from './diagnostics.ts';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { RecordId, type Surreal } from 'surrealdb';
import type { CompanyDatabase } from './database.ts';
import type { ActiveLease, ClaimResult, CompanyBrief, CompanyCore, CreateTask, Credential, DefView, EnsureDef, ProjectView, EmployeeScore, Evidence, HistoryEntry, LeaseProof, OpsScope, OutboxEvent, OwnerDecisionInput, Principal, RetireTask, ReviewerRole, Role, SessionRef, TaskId, TaskKind, TaskState, TaskView } from './contracts.ts';
import { OwnerDesk } from './owner.ts';
import { assertRoleContract, loadContract, type DisciplineContract } from './role-contract.ts';
import { ghCli, type GhRunner, type SubmitCheck } from './pr-gate.ts';
import { githubRepoSlug } from './external-actions.ts';
import type { SystemCheck } from './submit-checks.ts';
import { ProjectStore } from './projects.ts';
import { collectEvalState, summarizeModelEvidence, validateScores, writeScorecards, type ModelEvidence } from './scoring.ts';
import { readTaskCost, recordTaskCost, type TaskCost } from './task-cost.ts';
import { ITEM_BUDGET_BYTES, RESPONSE_BUDGET_BYTES, SEGMENT_DEFAULT_BYTES, SEGMENT_MAX_BYTES, answerBytes, dualBytes, echoTask, fitCount, longestFittingPrefix, openCursor, sealCursor, textSegment, textSegmentAnswer, utf8Bytes, worktreeRefsSegment, worktreeRefsSegmentAnswer, type TaskTextHead } from './response-budget.ts';
import { DEFAULT_PAGE_SIZE, TASK_STATES, parseContextInput, parseHistoryInput, parseReclaimInput, parseSummaryInput, parseTextInput, parseWorktreeInput, parseWorktreeRefsInput, queryDigest, type ContextParams } from './query-input.ts';
import {
  ACCEPTANCE_CRITERIA_VERSION, acceptanceError, acceptanceSubject, createGithubActionsAdapter, criteriaForLeg,
  acceptanceLegForSubject, acceptanceTargetAttempt, defaultAcceptanceCriteria, effectiveEnvironment, evaluateAcceptance, humanSignoffs, isLegacyAcceptance,
  isTrustedCodeDeliverable, loadAcceptanceEvidence, mergeAcceptanceCriteria,
  loadAcceptanceGate, recordAcceptanceEvidenceRow, validateAcceptanceCriteria,
  type AcceptanceActor, type AcceptanceSourceAdapter, type AcceptanceTaskRow, type HumanSignoff,
} from './acceptance.ts';
import type { AcceptanceCriterion, AcceptanceEvidenceInput, AcceptanceEvidenceRecord, AcceptanceGateInput, AcceptanceGateView, AcceptanceLeg, AcceptancePhase, AcceptanceStatusView } from './contracts.ts';
import { companyBlock, companyParts } from './company-context.ts';
import type { AdminSummary, CompanyPart, ContextView, HistoryPageView, PageInfo, ReferencesCut, TaskTextSegment, WorktreePageView, WorktreeRefsSegment } from './contracts.ts';
import { CLEANUP_BUDGET_MS, SnapshotStore, type SnapshotBuildStats, type SnapshotHeader, type SnapshotKind, type SnapshotLimits, untilAt } from './snapshot-store.ts';
import { arrivedAt } from './reply-clock.ts';
import { HANDOVER_ROWS, HANDOVER_OPS_ROWS } from './handover-window.ts';
import type { EmployeeDef, Workforce } from './workforce.ts';
import { FaultStore, type FaultCredential, type FaultReportResult, type FaultReserveResult } from './fault-store.ts';
import {
  DEFAULT_FAULT_BUDGET, budgetKey, classifyFault, faultEvidence, jitterFactorOf, type FaultBudgetLimits,
  type FaultDiagnostic, type FaultInput, type FaultPhase, type FaultRecord, type FaultRefund, type FaultTargetKind,
  type FlowStage,
} from './faults.ts';

/** The outcome of a fault report, as the core sees it: the classification plus what the budget decided. */
type FaultReportOutcome = FaultReportResult;
import type { PluginRuntimeView } from './contracts.ts';
import { PLUGIN_RUNTIME_ROLES } from './contracts.ts';

import { CompanyError } from './core-errors.ts';
import { hostIO } from './host-io.ts';
import { parseBrokerConfig } from './ops/config.ts';
import { assertEmployeeCiBlockAllowed, createCiBillingCheck, isCiBlockCause, refuseEmployeeCiBlock, type CiBillingCheck } from './github-ci-control.ts';
import { WorktreeRegistry, validateIntent, type RegistryOptions } from './dispatcher/worktree-registry.ts';
import { readProviderQuotas } from './dispatcher/quota-store.ts';
import { providerAdmission } from './provider-admission.ts';
import type { DispatchVerdict } from './dispatcher/dispatch-blocked.ts';
import type { WorkIntent, WorktreeAssignment, WorktreeView, WriteScopeHolder } from './contracts.ts';
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
const OPS_EVIDENCE_CHARS = 600;
const LIST_CONTEXT_CHARS = 1200;
const LIST_TASKS_LIMIT = 500;
/** A contributor dry-run answer is held to this many UTF-8 JSON bytes (24 KiB). The MCP result carries the JSON both as text and as
 *  structuredContent in this lane, so twice this figure stays inside the 48 KiB response budget (SYS01). */
const DRY_RUN_BYTE_BUDGET = 24 * 1024;
/** Newest audit rows read per task for the dry-run. Rows beyond what fits the budget are cut and marked (timelineTotal). */
const DRY_RUN_TIMELINE_ROWS = 200;
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
/** Query results may carry record ids as `task:⟨uuid⟩` (the fork's escaped rendering): strip the quoting so client-side uuids compare equal against server-side ids. */
const normalizedId = (value: unknown): string => {
  const raw = value instanceof RecordId ? String(value.id) : asId(value);
  return raw.startsWith('⟨') && raw.endsWith('⟩') ? raw.slice(1, -1) : raw;
};

/**
 * Activates planned children of an accepted task: same transaction, state planned → ready,
 * audit planned_activated per row. Requires $task and $actor in scope.
 */
export const ACTIVATE_PLANNED_SQL = `
  LET $planned_children = SELECT * FROM task WHERE parent = $task AND state = 'planned';
  UPDATE task SET state = 'ready', version += 1 WHERE parent = $task AND state = 'planned';
  FOR $child IN $planned_children {
    CREATE audit CONTENT { task: $child.id, actor: $actor, action: 'planned_activated',
      evidence: '父任务验收通过，计划任务转为就绪', version: $child.version + 1, at: time::now() };
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

export interface TaskRow {
  company_upgrade?: CompanyRelease;
  recovery_stopped?: boolean;
  id: RecordId;
  title: string;
  context: string;
  state: TaskState;
  executor_role: Role;
  reviewer_role: ReviewerRole;
  discipline?: string;
  /** The owner-edited requirement staged into task.md; separate from the legacy context prose. */
  requirement?: string;
  /** The owner-edited acceptance section staged into task.md. */
  acceptance_text?: string;
  version: number;
  submitted_by?: string;
  current_employee?: string;
  delivery_id?: string;
  lease_expires_at?: number;
  fence: number;
  blocked_to?: 'owner';
  resume_role?: string;
  resume_state?: TaskState;
  kind?: TaskKind;
  /** Task-level project override (registered project id). */
  project?: RecordId;
  /** Explicit code-repo binding (schema 017); workspace/dispatch routing only, never business project resolution. */
  code_repo_path?: string;
  model_tier?: 'fable' | 'opus' | 'sonnet' | 'haiku' | 'high' | 'medium' | 'low';
  model_route_until?:number;
  handover?: boolean;
  previous_employee?: string;
  /** Open dispatch-blocked episode (schemaless): the phase it blocks and when it began, unix seconds. */
  dispatch_blocked_phase?: string | null;
  dispatch_blocked_since?: number | null;
  progress_at?: number;
  /** Route type recorded at creation; drives routing, templates and next-chain expansion. */
  type?: string;
  /** Chain predecessor record. */
  parent?: RecordId;
  /** The submit audit id a proposal was created under. */
  proposed_in?: string;
  /** Optional grouping tag. */
  tag?: string;
  /** Unix seconds: a quota-caused block may not be re-announced to owner before this instant. */
  quota_resets_at?: number | null;
  evaluated_at?: string;
  model_eval_full_history?: boolean;
  eval_via?: string;
  eval_attempts?: number;
  owner_rerouted?: boolean;
  /** SYS02 acceptance fields (schema 026); every one is optional, so rows written before SYS02 stay valid. */
  acceptance_criteria?: AcceptanceCriterion[];
  acceptance_version?: number;
  acceptance_legacy?: boolean;
  acceptance_head?: string;
  acceptance_environment?: string;
  acceptance_attempt?: number;
  acceptance_chain?: string;
  created_at?: unknown;
  work_intent?: WorkIntent;
  worktree?: WorktreeAssignment;
  repo_path?: string;
  /** Screenplay-revision edge fields (schema 015). */
  revises?: RecordId;
  superseded_by?: RecordId;
  lineage?: RecordId;
  revision_no?: number;
}

/** policy 表的一行（snake_case），只在 core 内部出现；对外的形状是 PolicyRow。 */

/** Compact row for the complete active-lease lookup; keeps task context text out of the recovery path. */
interface ActiveLeaseRow {
  id: RecordId;
  state: TaskState;
  executor_role: Role;
  reviewer_role: ReviewerRole;
  submitted_by?: string;
  current_employee?: string;
  delivery_id?: string;
  lease_expires_at?: number;
  fence: number;
  version: number;
}
export interface IdempotencyRow { payload_digest: string; result: TaskRow }


export function view(row: TaskRow): TaskView {
  return {
    id: asId(row.id), title: row.title, context: row.context, state: row.state,
    requirement: row.requirement ?? undefined, acceptanceText: row.acceptance_text ?? undefined,
    executorRole: row.executor_role, reviewerRole: row.reviewer_role,
    discipline: row.discipline ?? undefined,
    kind: row.kind ?? 'task',
    type: row.type ?? undefined, parent: row.parent ? asId(row.parent) : undefined,
    proposedIn: row.proposed_in ?? undefined, tag: row.tag ?? undefined,
    projectOverlay: row.project ? asId(row.project) : undefined,
    codeRepoPath: row.code_repo_path ?? undefined,
    version: row.version,
    submittedBy: row.submitted_by, currentEmployee: row.current_employee,
    deliveryId: row.delivery_id,
    leaseExpiresAt: row.lease_expires_at ? new Date(row.lease_expires_at * 1000).toISOString() : undefined,
    fence: row.fence,
    blockedTo: row.blocked_to,
    companyUpgrade: row.company_upgrade ?? undefined,
    resumeState: row.state === 'blocked' ? row.resume_state : undefined,
    resumeRole: row.state === 'blocked' ? row.resume_role : undefined,
    handover: row.handover || undefined,
    previousEmployee: row.previous_employee,
    modelTier: row.model_tier,
    workIntent: row.work_intent, worktree: row.worktree,
    acceptanceCriteria: row.acceptance_criteria ?? undefined,
    acceptanceVersion: row.acceptance_version ?? undefined,
    acceptanceLegacy: row.acceptance_legacy ?? undefined,
    acceptanceHead: row.acceptance_head ?? undefined,
    acceptanceEnvironment: row.acceptance_environment ?? undefined,
    acceptanceAttempt: row.acceptance_attempt ?? undefined,
    acceptanceChain: row.acceptance_chain ?? undefined,
  };
}

/** Ops repo (agent home); mirrors the plugin/MCP wiring fallback for SCK_AGENT_CWD. */
const opsRepoPath = () => process.env.SCK_AGENT_CWD ?? '/Users/y/IdeaProjects/surreal-ck-operations';

/** Whether `text` names `repo` as a whole path (…/surreal-ck-operations, not …/surreal-ck-operations-four-tier). */
export function namesRepo(text: string, repo: string): boolean {
  for (let at = text.indexOf(repo); at >= 0; at = text.indexOf(repo, at + 1)) {
    if (!/[\w-]/.test(text[at + repo.length] ?? '')) return true;
  }
  return false;
}

/**
 * Canonical form for repo allowlisting and routing comparisons: resolve() first, then
 * realpath the nearest existing ancestor and re-append the remaining tail — a symlinked
 * parent can never smuggle a path outside the registered set.
 */
export function canonicalRepoPath(input: string): string {
  const io = hostIO();
  let probe = io.path.resolve(input);
  const tail: string[] = [];
  while (!io.fs.exists(probe)) { tail.unshift(io.path.basename(probe)); probe = io.path.dirname(probe); }
  const base = io.fs.realpath(probe);
  return tail.length ? io.path.join(base, ...tail) : base;
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

const isLeased = (row: { current_employee?: string; lease_expires_at?: number }) =>
  Boolean(row.current_employee) && (row.lease_expires_at ?? 0) > Math.floor(Date.now() / 1000);
/** Which projects' environments one reader may see in a company block (SYS01 M3). `key` names that view, so a stored listing is read only under the same one. */
interface EnvView { key: string; visible: (project: string) => boolean }
/** A project as a reader without environment access sees it: the identity fields as they are, the environments withheld. */
const withheldEnvs = (project: ProjectView): ProjectView => ({ ...project, envs: [], envsWithheld: true });
/** Same repository/goal identity rules as staffingPool; checked inside every lease/takeover transaction. */
const EMPLOYEE_WORKSPACE_SQL = (who: string, failure: string) => `
      IF ${who}.retired = true { THROW '${failure}: target employee is retired' };
      LET $scope = 'maintenance';
      IF ${who}.workspace_scope != NONE AND ${who}.workspace_scope != $scope { THROW '${failure}: workspace denied; target employee works in another workspace scope and can never be dispatched this task' };
      LET $home = $t.code_repo_path ?? $t.project.repo_path ?? $ops_repo;
      LET $employee_home = ${who}.workspace_repo ?? ${who}.workspace_cwd ?? $ops_repo;
      IF $home != NONE AND $employee_home != NONE AND $home != $employee_home { THROW '${failure}: target employee works in another repository and can never be dispatched this task' };
`;

// ---- Bounded reads (SYS01). Every response, complete or paged, fits the 48 KiB budget measured as serialized
// UTF-8. A complete answer is returned whole or refused (C2, C3); a paged answer reads a stored listing (C4). ----
// Items of a page keep their whole text unless that item alone cannot fit a page (ITEM_BUDGET_BYTES); then it is cut and flagged.
// A complete answer is never cut: it is returned whole or refused as response_too_large.
/**
 * A complete answer reads at most this many rows before it is refused. Each task or audit item serializes to well over
 * 100 bytes, so one more row than this could not fit the budget anyway.
 */
const COMPLETE_TASK_ROWS = 500;
const COMPLETE_HISTORY_ROWS = 1000;
/** How long a policy_plan cursor stays valid (SYS06 R1(b)): long enough to walk the pages of one plan, short enough that a stale plan is rerun. */
const POLICY_PLAN_CURSOR_TTL_MS = 30 * 60_000;

type AuditHistoryRow = { id: RecordId; action: string; actor: unknown; evidence?: string | null; version?: number; cat: string };
interface WorktreeCompact { worktreePath: string; releasedReferences: number; referencesTruncated?: ReferencesCut; [key: string]: unknown }

const tooLarge = (message: string) => new CompanyError('response_too_large', message);
/** The arguments that read the company block in pages, named in every task answer (SYS01 AC-A). */
const COMPANY_READ = { scope: 'company' as const, pageSize: DEFAULT_PAGE_SIZE };
/** Guidance when a task answer that carries the company block is too large: leave the block out, and read it on its own. */
const COMPANY_PAGED_HINT = 'pass includeCompany false, and read the company block in pages with {"scope":"company","pageSize":25}';
/** A complete answer: returned whole when it fits the budget as it is sent (answerBytes), refused otherwise. Never cut. */
function completeOrRefuse<T>(value: T, what: string, guidance: string): T {
  const bytes = answerBytes(value);
  if (bytes > RESPONSE_BUDGET_BYTES) throw tooLarge(`${what} is ${bytes} bytes, above the ${RESPONSE_BUDGET_BYTES}-byte budget; ${guidance}`);
  return value;
}

/**
 * Compact references, sorted by path so that listings are stable. Released references are counted, and listed only when asked.
 * A paged listing passes `itemBudget`: a worktree whose whole entry cannot fit a page keeps the longest prefix of its
 * references that does, and is flagged with the whole list's count and SHA-256 (SYS01 R1). read_worktree_refs reads the rest
 * in byte segments. A complete (legacy) list never passes a budget: it stays whole, or is refused.
 */
function compactWorktrees(all: readonly WorktreeView[], includeReleased?: boolean, itemBudget?: number): WorktreeCompact[] {
  return [...all]
    .sort((a, b) => (a.worktreePath < b.worktreePath ? -1 : a.worktreePath > b.worktreePath ? 1 : 0))
    .map(worktree => {
      const references = includeReleased ? worktree.references : worktree.references.filter(reference => reference.state !== 'released');
      const releasedReferences = worktree.references.filter(reference => reference.state === 'released').length;
      const item: WorktreeCompact = { ...worktree, references, releasedReferences };
      if (itemBudget === undefined || references.length === 0 || dualBytes(item) <= itemBudget) return item;
      const cut: ReferencesCut = { count: references.length, sha256: HASH(JSON.stringify(references)), includeReleased: includeReleased === true, tool: 'read_worktree_refs' };
      const bounded = (kept: readonly WorktreeView['references'][number][]): WorktreeCompact => ({ ...item, references: kept, referencesTruncated: cut });
      const kept = fitCount(references, subset => dualBytes(bounded(subset)), itemBudget);
      return bounded(references.slice(0, kept));
    });
}

const pick = (value: Record<string, unknown>, fields?: readonly string[]): Record<string, unknown> =>
  fields ? Object.fromEntries(fields.filter(field => field in value).map(field => [field, value[field]])) : value;

/**
 * A list item: the task as the caller projects it, with the size and digest of its whole context. The item is whole unless
 * `cutLong` is set and the item alone cannot fit a page (ITEM_BUDGET_BYTES, in dual bytes: the item is in the answer's text and in
 * its JSON). Then it is echoed as a write echo is (echoTask): its lists are cut to their share and flagged (listsTruncated), and
 * its context takes the room that is left, cut and flagged (contextTruncated, contextNextOffset). A goal's acceptance task depends
 * on every task of the goal, so its dependency list alone can exceed a page; cutting only the context could never deliver it (SYS01).
 * read_task_text returns any cut list or context whole. A complete answer never cuts.
 */
function listItem(row: TaskRow, fields: readonly string[] | undefined, cutLong: boolean): Record<string, unknown> {
  const task = view(row);
  const body: Record<string, unknown> = {
    ...pick({ ...task }, fields), contextBytes: utf8Bytes(task.context), contextSha256: HASH(task.context), contextTruncated: false,
  };
  if (!cutLong || typeof body.context !== 'string' || dualBytes(body) <= ITEM_BUDGET_BYTES) return body;
  return echoTask(body as unknown as TaskView, ITEM_BUDGET_BYTES) as unknown as Record<string, unknown>;
}

/** A task read by id, whole: the full context, with its size and digest so that a reassembly can be verified. */
function detailTaskView(task: TaskView, fields?: readonly string[]): Record<string, unknown> {
  return { ...pick({ ...task }, fields), contextBytes: utf8Bytes(task.context), contextSha256: HASH(task.context) };
}

/**
 * One audit entry. The evidence is whole unless `limit` (the entry's own size in dual bytes, see dualBytes) would be exceeded;
 * then the longest prefix that fits is kept and flagged, and evidenceNextOffset tells read_task_text where to continue. The size
 * and digest always describe the full text, so the reassembly can be checked.
 */
function historyEntry(row: AuditHistoryRow, limit?: number): HistoryEntry {
  const head = {
    auditId: asId(row.id), action: row.action, actor: row.actor instanceof RecordId ? asId(row.actor) : String(row.actor),
    version: row.version, at: row.cat,
  };
  if (!row.evidence) return head;
  const full = row.evidence;
  const total = utf8Bytes(full);
  const entry = (text: string, cut: boolean): HistoryEntry => ({
    ...head, evidence: text, evidenceBytes: total, evidenceSha256: HASH(full), evidenceTruncated: cut,
    ...(cut ? { evidenceNextOffset: utf8Bytes(text) } : {}),
  });
  if (limit === undefined || dualBytes(entry(full, false)) <= limit) return entry(full, false);
  return entry(longestFittingPrefix(full, text => dualBytes(entry(text, true)) <= limit), true);
}

/** The workflow runs found for one submitted sha: each is verified by the acceptance adapter before evidence lands. */
export type AcceptanceRunLister = (slug: string, sha: string, run?: GhRunner) => Promise<string[]>;
const defaultRunLister: AcceptanceRunLister = async (slug, sha, run = ghCli) => {
  // The same gh invocation family pr-gate/github-ci-control use: read-only `gh api` against the Actions runs API.
  const out = await run(['api', `repos/${slug}/actions/runs?head_sha=${sha}&status=completed&per_page=10`, '--jq',
    '.workflow_runs[] | select(.conclusion == "success") | .html_url']);
  return out.split(/\r?\n/).map(line => line.trim()).filter(line => /^https:\/\/github\.com\//.test(line)).slice(0, 5);
};

export class SurrealCompanyCore implements CompanyCore {
  readonly leaseSeconds: number;
  readonly checkpointLimit: number;
  /** Optional pre-submit check of implementation deliveries; returns why the submission cannot go to review. */
  private readonly submitCheck?: SubmitCheck;
  private readonly systemCheck?: SystemCheck;
  /** SYS02: read-only source adapter that verifies CI runs, artifacts and probes; tests inject a deterministic one. */
  private readonly acceptanceAdapter: AcceptanceSourceAdapter;
  /** Resolves the GitHub Actions run urls of one head in one repository slug; tests inject a deterministic one. */
  private readonly acceptanceRuns: AcceptanceRunLister;
  private readonly ciBillingCheck: CiBillingCheck;
  /** Test seam (SYS-DISP AC06): runs after a contribution view is read and before the lease transaction that checks it. */
  private readonly contributionReadHook?: (taskId: string) => Promise<void>;
  private readonly companyReleaseRepo?:string;
  private readonly drillLaunch?: (home: string, repo: string, plan: { runId: string; root: string }) => number;
  constructor(readonly database: CompanyDatabase, options?: { companyReleaseRepo?:string; leaseSeconds?: number; checkpointLimit?: number; workforce?: Workforce; worktrees?: RegistryOptions; submitCheck?: SubmitCheck; systemCheck?: SystemCheck; ciBillingCheck?: CiBillingCheck; snapshots?: Partial<SnapshotLimits>; snapshotObserve?: (stats: SnapshotBuildStats) => void; contributionReadHook?: (taskId: string) => Promise<void>; acceptance?: { adapter?: AcceptanceSourceAdapter; runs?: AcceptanceRunLister };
    faults?: { limits?: FaultBudgetLimits; clock?: () => number };
    /** Test seam only: replaces the detached drill launch so a gate can assert the guards without a real run. */
    drillLaunch?: (home: string, repo: string, plan: { runId: string; root: string }) => number }) {
    this.companyReleaseRepo=options?.companyReleaseRepo;
    this.drillLaunch = options?.drillLaunch;
    this.submitCheck = options?.submitCheck;
    this.systemCheck = options?.systemCheck;
    this.acceptanceAdapter = options?.acceptance?.adapter ?? createGithubActionsAdapter();
    this.acceptanceRuns = options?.acceptance?.runs ?? defaultRunLister;
    this.ciBillingCheck = options?.ciBillingCheck ?? createCiBillingCheck();
    this.contributionReadHook = options?.contributionReadHook;
    const seconds = options?.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3600) {
      throw new CompanyError('invalid', 'Invalid lease duration');
    }
    this.leaseSeconds = seconds;
    this.checkpointLimit = options?.checkpointLimit ?? DEFAULT_CHECKPOINT_LIMIT;
    this.workforce = options?.workforce;
    // The company-system repo the upgrade gate compares against: a quick goal without a project binds its code legs to it at triage.
    this.owner = new OwnerDesk(database, options?.companyReleaseRepo ?? options?.worktrees?.opsRepo);
    this.projects = new ProjectStore(database.db);
    this.worktrees = options?.worktrees ? new WorktreeRegistry(database.db, options.worktrees) : undefined;
    this.snapshots = new SnapshotStore(database.db, options?.snapshots, { channel: database.buildChannel, releaseChannel: database.releaseChannel, observe: options?.snapshotObserve });
    // SYS04: the fault ledger (one episode per cause, one budget per fault object, one repair chain per incident).
    this.faults = new FaultStore(database.db);
    this.faultLimits = options?.faults?.limits ?? DEFAULT_FAULT_BUDGET;
    this.faultClock = options?.faults?.clock ?? Date.now;
  }
  readonly worktrees?: WorktreeRegistry;
  private readonly owner: OwnerDesk;
  /** SYS04: the fault ledger — structured faults, the persistent recovery budget and the repair chain. */
  private readonly faults: FaultStore;
  /** SYS04: the recovery budget limits applied to a fault object. */
  private readonly faultLimits: FaultBudgetLimits;
  /** SYS04: the clock the budget is measured against (tests inject a controlled one). */
  private readonly faultClock: () => number;
  private readonly projects: ProjectStore;
  /** Stored listings behind the paged reads (C4). */
  private readonly snapshots: SnapshotStore;
  /** Manage tools reuse the workforce writer; absent in processes that never wire one. */
  private readonly workforce?: Workforce;
  private get db() { return this.database.db; }

  async authenticate(credential: Credential): Promise<Principal> {
    if (typeof credential !== 'string' || !credential.startsWith('sck_') || credential.length > 200) {
      throw new CompanyError('unauthorized', 'Invalid credential');
    }
    const [rows] = await authenticationLookup(() => HASH(credential), digest => this.db.query<[EmployeeRow[]]>(
      'SELECT *, def.tracks AS tracks FROM employee WHERE credential_digest = $digest LIMIT 1;', { digest }
    ));
    // credential_digest is a SHA-256 over a high-entropy random token; the argon2
    // re-verify added nothing (same row, same secret) and under launchd QoS a
    // memory-hard KDF is throttled ~500x — it was the 50s stall per request.
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
    const scoped = actor.role !== 'owner';
    const [rows] = await this.db.query<[TaskRow[]]>(
      `SELECT *, string::slice(context ?? '', 0, $ctx) AS context FROM task
       WHERE ${state ? 'state = $state' : "state IN ['ready', 'doing', 'review', 'blocked']"}
         AND ($scoped = false OR executor_role = $role OR reviewer_role = $role)
       ORDER BY created_at DESC, id LIMIT $limit;`,
      { state, scoped, role: actor.role ?? '', ctx: LIST_CONTEXT_CHARS, limit: LIST_TASKS_LIMIT });
    return rows.filter(row => !(row.state === 'review' && row.submitted_by === actor.employeeId)).map(view);
  }

  /**
   * Complete server-side truth for the current employee's live leases, doing and review.
   * Deliberately not listTasks: that view is capped, previews task text, and hides rows the
   * employee submitted, so a review lease at the back of the list would be lost on reload.
   */
  async activeLeases(credential: Credential): Promise<ActiveLease[]> {
    const actor = await this.authorized(credential);
    const [rows] = await this.db.query<[ActiveLeaseRow[]]>(
      `SELECT id, state, executor_role, reviewer_role, submitted_by,
              current_employee, delivery_id, lease_expires_at, fence, version
         FROM task
        WHERE current_employee = $employee
          AND state IN ['doing', 'review']
          AND delivery_id != NONE
          AND lease_expires_at != NONE
          AND lease_expires_at > time::unix(time::now());`,
      { employee: actor.employeeId });
    return (rows ?? []).flatMap(row => {
      if (row.state !== 'doing' && row.state !== 'review') return [];
      const role = row.state === 'review' ? row.reviewer_role : row.executor_role;
      // A role change after the claim, or a review lease held by the submitter,
      // is contradictory state: never rebuild it as a usable local claim.
      if (role !== actor.role) return [];
      if (row.state === 'review' && row.submitted_by === actor.employeeId) return [];
      if (!row.delivery_id || !row.lease_expires_at || !Number.isSafeInteger(row.fence) || row.fence < 1 ||
          !Number.isSafeInteger(row.version)) return [];
      return [{
        taskId: asId(row.id), state: row.state, deliveryId: row.delivery_id,
        fence: row.fence, version: row.version,
        leaseExpiresAt: new Date(row.lease_expires_at * 1000).toISOString(),
        role: role as Role, currentEmployee: actor.employeeId,
      }];
    });
  }

  async getTask(credential: Credential, taskId: TaskId): Promise<TaskView> {
    const actor = await this.authorized(credential);
    const row = await this.db.select<TaskRow>(id('task', taskId));
    if (!row) throw new CompanyError('not_found', 'Task not found');
    if (actor.role !== row.executor_role && actor.role !== row.reviewer_role && actor.role !== 'owner' && actor.role !== 'eval') {
      throw new CompanyError('forbidden', 'Task access denied');
    }
    return view(row);
  }

  private idemId(actor: string, action: string, key: string): RecordId {
    requireText(key, 'idempotency key', 8, 200);
    return id('idempotency', HASH(`${actor}\0${action}\0${key}`));
  }

  /**
   * SYS03 AC02: a business-level idempotency identity, derived from the business key alone — no employee in the key.
   * The actor-scoped idemId above answers "did THIS employee already send this?"; a repair chain or a disposition must
   * answer "has this business operation already happened?", because a swapped employee, a restarted service or a
   * replayed request would otherwise create a second one.
   */
  private businessIdemId(action: string, key: string): RecordId {
    requireText(key, 'business idempotency key', 8, 200);
    return id('idempotency', HASH(`business\0${action}\0${key}`));
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
            await new Promise(done => setTimeout(done, 10 * (attempt + 1)));
            continue;
          }
          if (/conflict/i.test(cause)) throw new CompanyError('temporarily_unavailable', 'Database contention; retry request', true);
          if (/self review/i.test(cause)) throw new CompanyError('self_review', 'Employee cannot review own delivery');
          if (/discipline track denied/i.test(cause)) throw new CompanyError('forbidden', 'Employee definition does not cover the task discipline');
          if (/employee runtime is suspending/i.test(cause)) throw new CompanyError('conflict', 'Employee runtime is suspending; retry after closure');
          if (/leased by another|already has active task/i.test(cause)) throw new CompanyError('already_claimed', 'Task or employee already leased');
          if (/lease expired/i.test(cause)) throw new CompanyError('lease_expired', 'Lease expired');
          if (/denied|forbidden|revoked/i.test(cause)) throw new CompanyError('forbidden', 'Action forbidden');
          if (/checkpoint limit/i.test(cause)) throw new CompanyError('checkpoint_limit', 'Checkpoint limit reached');
          if (/task retired/i.test(cause)) throw new CompanyError('conflict', 'Task has been retired');
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

  /** A created task answers with its context bounded to the item budget (SYS01); the create itself is not affected. */
  async createTask(credential: Credential, input: CreateTask): Promise<TaskView> {
    return echoTask(await this.createTaskRecord(credential, input, { external: true }));
  }

  /**
   * `repairKey` (SYS03 AC02) switches the create's idempotency identity from the caller's employee to the business key,
   * so the repair chain a disposition builds exists exactly once no matter which actor, session or replay asked for it.
   */
  private async createTaskRecord(credential: Credential, input: CreateTask, options: { external?: boolean; acceptanceChain?: string; repairKey?: string; route?: RouteRow } = {}): Promise<TaskView> {
    const actor = await this.authorized(credential, 'manage');
    if (actor.role !== 'owner') throw new CompanyError('forbidden', 'Task creation denied');
    const route = options.route ?? (input.type ? await getRoute(this.db, input.type) : undefined);
    if (input.type && !route?.enabled) throw new CompanyError('invalid', `route type ${input.type} is missing or disabled`);
    if (route) {
      input = { ...input, executorRole: route.executor_role, reviewerRole: route.reviewer_role };
    }
    // External create_task only: the raw list is bounded before de-duplication. Internal delivery
    // route-expanded chain children are deliberately not capped here; they must
    // retain the complete dependency set.
    requireText(input.title, 'title', 3, 200);
    requireText(input.context, 'context', 1, 20000);
    requireRole(input.executorRole);
    requireReviewer(input.reviewerRole);
    if (input.project !== undefined) requireText(input.project, 'project', 1, 60);
    // Registered projects only: a typo must fail loudly, not silently fall back to goal routing.
    if (input.project !== undefined && !(await this.projects.get(input.project))) {
      throw new CompanyError('not_found', `project ${input.project} not found`);
    }
    const contract = await this.disciplineContract(input.project);
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
    // SYS02 AC01: new code deliveries need structured criteria while the gate is enabled. Old rows stay valid because the
    // gate record is versioned and the evaluator marks pre-enablement rows legacy (AC06).
    let acceptanceCriteria = validateAcceptanceCriteria(input.acceptanceCriteria);
    const acceptanceGate = await loadAcceptanceGate(this.db);
    const trustedCode = isTrustedCodeDeliverable({ kind: input.kind ?? 'task', workIntent: input.workIntent });
    const leg = acceptanceLegForSubject({ kind: input.kind ?? 'task', workIntent: input.workIntent });
    if (acceptanceGate.enabled && trustedCode) {
      // The server baseline is unremovable: custom criteria only supplement it (SYS02 C1).
      acceptanceCriteria = mergeAcceptanceCriteria(leg, acceptanceCriteria);
    }
    // N1: the environment requirement is a controlled creation-time declaration, either the task value or the single
    // environment named by its criteria. An executor cannot introduce or relabel it at submit time.
    const declaresEnvironment = input.acceptanceEnvironment !== undefined ||
      acceptanceCriteria.some(criterion => criterion.environment !== undefined);
    if (declaresEnvironment && !trustedCode) {
      throw new CompanyError('invalid', 'acceptance environment requirements apply to code delivery tasks only');
    }
    const acceptanceEnvironment = effectiveEnvironment(acceptanceCriteria, input.acceptanceEnvironment);
    // 必配轨岗位（如 screenwriter）：任务必须带指定轨，缺轨/错轨显式拒绝，防止无轨任务落到专属编制。
    const requiredTrack = REQUIRED_TRACKS[input.executorRole];
    if (requiredTrack !== undefined && input.discipline !== requiredTrack) {
      throw new CompanyError('invalid', `executorRole ${input.executorRole} requires discipline=${requiredTrack}`);
    }
    if (input.modelTier !== undefined && !['fable','opus','sonnet','haiku','high','medium','low'].includes(input.modelTier)) throw new CompanyError('invalid', 'Invalid model tier');
    const kind = input.kind ?? 'task';
    if (kind !== 'task') throw new CompanyError('invalid', 'Invalid task kind');
    if ((input as { goalId?: unknown }).goalId !== undefined) throw new CompanyError('invalid', 'goalId is retired; use tag');
    if ((input as { dependencies?: unknown }).dependencies !== undefined) throw new CompanyError('invalid', 'dependencies are retired; use parent');
    if (input.revises !== undefined) throw new CompanyError('invalid', 'revises is retired');
    const codeRepoPath = await this.creationCodeRepo(input, kind);
    const idem = options.repairKey === undefined
      ? this.idemId(actor.employeeId, 'create', input.idempotencyKey)
      : this.businessIdemId('create', options.repairKey);
    const digest = HASH(JSON.stringify(input));
    const prior = await this.replay(idem, digest);
    if (prior) return prior;
    const taskId = randomUUID();
    const task = id('task', taskId);
    const vars = {
      actor: id('employee', actor.employeeId), task, idem, digest,
      audit: id('audit', randomUUID()), outbox: id('outbox', randomUUID()),
      title: input.title, context: input.context, executor: input.executorRole,
      reviewer: input.reviewerRole, tag: input.tag,
      type: input.type, parent: input.parent ? id('task', input.parent) : undefined,
      proposed_in: input.proposed_in,
      requirement: input.requirement, acceptance_text: input.acceptanceText,
      kind, project: input.project ? id('project', input.project) : undefined,
      discipline: input.discipline, work_intent: input.workIntent, model_tier: input.modelTier,
      acceptance_criteria: acceptanceCriteria,
      acceptance_version: acceptanceCriteria.length > 0 ? ACCEPTANCE_CRITERIA_VERSION : undefined,
      acceptance_chain: options.acceptanceChain,
      acceptance_environment: acceptanceEnvironment,
      // A task created while the gate is off is legacy: enabling later never retroactively gates it (SYS02 AC06).
      acceptance_legacy: !acceptanceGate.enabled,
      code_repo_path: codeRepoPath,
    };
    try {
      const row = await this.txTask(`BEGIN;
        LET $who = SELECT * FROM ONLY $actor;
        IF $who.revoked = true OR 'manage' NOT IN $who.capabilities OR $who.role != 'owner' { THROW 'actor revoked or forbidden' };
        LET $parent_state = IF $parent != NONE THEN (SELECT VALUE state FROM ONLY $parent) ELSE NONE END;
        LET $created = CREATE ONLY $task CONTENT {
          title: $title, context: $context, executor_role: $executor, reviewer_role: $reviewer,
          discipline: $discipline, work_intent: $work_intent, project: $project, model_tier: $model_tier,
          tag: $tag, type: $type, parent: $parent, proposed_in: $proposed_in,
          requirement: $requirement, acceptance_text: $acceptance_text,
          state: IF $parent != NONE AND $parent_state != 'done' THEN 'planned' ELSE 'ready' END,
          version: 1, fence: 0, submitted_by: NONE, current_employee: NONE,
          delivery_id: NONE, lease_expires_at: NONE, resume_role: NONE, resume_state: 'ready', blocked_to: NONE,
          kind: $kind, created_at: time::now(), code_repo_path: $code_repo_path,
          ${acceptanceCriteria.length > 0 ? 'acceptance_criteria: $acceptance_criteria, acceptance_version: $acceptance_version,' : ''}
          acceptance_legacy: $acceptance_legacy, acceptance_head: NONE, acceptance_environment: $acceptance_environment,
          acceptance_attempt: 0${options.acceptanceChain !== undefined ? ', acceptance_chain: $acceptance_chain' : ''}
        };
        CREATE ONLY $audit CONTENT { task: $task, actor: $actor, action: 'create', version: 1, at: time::now() };
        LET $sequence = UPDATE ONLY company_meta:outbox_counter SET value += 1 RETURN AFTER;
        CREATE ONLY $outbox CONTENT { task: $task, kind: 'created', sequence: $sequence.value, payload: { state: $created.state }, at: time::now() };
        CREATE ONLY $idem CONTENT { at: time::now(), payload_digest: $digest, result: $created };
        RETURN $created;
        COMMIT;`, vars);
      const taskView = view(row);
      if (route || input.type) {
        const store = new OutboundMessageStore(this.db);
        const code = route?.code === true;
        const drafts = await store.createTaskDrafts(taskView.id, taskView.executorRole, taskView.reviewerRole, code,
          { execute: route?.execute_body, review: route?.review_body });
        const hold = input.hold ?? route?.hold;
        if (hold) {
          for (const draft of drafts) {
            await this.db.query('UPDATE $m SET hold = true;', { m: new RecordId('outbound_message', draft.id) });
          }
        }
      }
      if (route?.next) await this.expandRouteChain(credential, taskView, route, input, options);
      return taskView;
    } catch (error) {
      const replay = await this.replay(idem, digest);
      if (replay) return replay;
      throw error;
    }
  }

  /**
   * Route chain expansion: from `route.next`, create up to CHAIN_LIMIT planned successors. Each child
   * inherits title (`${title} · ${label}`), requirement and acceptance, points parent at the previous
   * task, and gets its own execute/review drafts. The walk stops on a missing/disabled route or a cycle.
   */
  private async expandRouteChain(credential: Credential, root: TaskView, route: RouteRow, input: CreateTask,
    options: { external?: boolean; acceptanceChain?: string; repairKey?: string } = {}): Promise<void> {
    let cursor: RouteRow | undefined = route;
    let parent: TaskView = root;
    const seen = new Set<string>([root.type ?? input.type ?? '']);
    for (let step = 0; step < CHAIN_LIMIT && cursor?.next; step++) {
      const nextType = cursor.next;
      if (seen.has(nextType)) break;
      seen.add(nextType);
      const next = await getRoute(this.db, nextType);
      if (!next?.enabled) break;
      const child = await this.createTaskRecord(credential, {
        title: `${input.title} · ${next.label}`, context: input.context,
        executorRole: next.executor_role, reviewerRole: next.reviewer_role,
        type: nextType, parent: parent.id,
        requirement: input.requirement, acceptanceText: input.acceptanceText,
        project: input.project, codeRepoPath: input.codeRepoPath, tag: input.tag,
        workIntent: input.workIntent, discipline: input.discipline, modelTier: input.modelTier,
        hold: input.hold ?? next.hold,
        idempotencyKey: `${input.idempotencyKey}:chain:${nextType}`,
      }, { ...options, route: next });
      parent = child;
      cursor = next;
    }
  }

  /**
   * One submit-`next` proposal: a planned child under the submitted task, typed through the route table,
   * its execute/review drafts created immediately. proposed_in records the submit audit that proposed it,
   * which is what a later return uses to void exactly this submission's proposals.
   */
  private async createProposal(parent: TaskView, proposal: { type: string; title: string; requirement?: string; acceptance?: string }, submitAuditId: string): Promise<TaskView> {
    const route = await getRoute(this.db, proposal.type);
    if (!route?.enabled) throw new CompanyError('invalid', `proposal type ${proposal.type} is missing or disabled`);
    const taskId = randomUUID();
    const [rows] = await this.db.query<[TaskRow]>(
      `CREATE ONLY $task CONTENT { title: $title, context: $context, requirement: $requirement, acceptance_text: $acceptance,
        type: $type, parent: $parent, proposed_in: $proposed_in, executor_role: $ex, reviewer_role: $rev,
        state: 'planned', kind: 'task', version: 1, fence: 0, created_at: time::now() } RETURN AFTER;`,
      { task: id('task', taskId), title: proposal.title, context: proposal.requirement ?? '',
        requirement: proposal.requirement, acceptance: proposal.acceptance,
        type: proposal.type, parent: id('task', parent.id), proposed_in: submitAuditId,
        ex: route.executor_role, rev: route.reviewer_role });
    const child = view(rows!);
    await new OutboundMessageStore(this.db).createTaskDrafts(child.id, child.executorRole, child.reviewerRole, route.code === true,
      { execute: route.execute_body, review: route.review_body });
    return child;
  }

  /** Every planned descendant of a task, breadth-first: voiding a task cascades through the whole planned subtree. */
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
    if (!['owner', 'eval'].includes(actor.role)) throw new CompanyError('forbidden', 'Non-lease workspace requires owner/eval');
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
    // Checked before the registry is consulted: a caller without a task and without owner is refused even when no registry exists (R8).
    if (!taskId && actor.role !== 'owner') throw new CompanyError('forbidden', 'Global worktree inventory requires owner');
    if (!this.worktrees) return [];
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
    const row = await this.txTask(`BEGIN;
      LET $now = time::unix(time::now());
      LET $who = SELECT * FROM ONLY $actor;
      LET $t = SELECT * FROM ONLY $task;
      IF $who = NONE OR $who.revoked = true OR $t = NONE { THROW 'not found or revoked' };
      ${EMPLOYEE_WORKSPACE_SQL('$who', 'execute denied')}
      IF $t.state = 'void' { THROW 'task retired' };
      IF $t.state NOT IN ['ready', 'review', 'doing'] { THROW 'task not claimable' };
      IF $t.state = 'review' {
        LET $prior_submitters = SELECT VALUE <string>record::id(actor) FROM audit WHERE task = $task AND action IN ['submit', 'owner_submit'];
        IF $t.submitted_by = $employee OR $prior_submitters CONTAINS $employee { THROW 'self review denied' };
        IF 'review' NOT IN $who.capabilities OR $t.reviewer_role != $who.role { THROW 'review denied' };
      } ELSE {
        IF 'execute' NOT IN $who.capabilities OR $t.executor_role != $who.role { THROW 'execute denied' };
      };
      IF $t.current_employee != NONE AND $t.lease_expires_at > $now AND $t.current_employee != $employee { THROW 'leased by another employee' };
      LET $def_tracks = $who.def.tracks ?? [];
      IF $t.discipline != NONE AND array::len($def_tracks) > 0 AND $t.discipline NOT IN $def_tracks { THROW 'discipline track denied' };
      IF $has_req AND ($t.discipline != $req OR $req NOT IN $def_tracks) { THROW 'discipline track denied' };
      IF ($who.runtime_sleep_until ?? 0) > time::unix(time::now()) { THROW 'employee runtime is suspending'; };
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
      UPDATE ONLY $actor SET active_task = $task, workspace_read_active = false, last_task = $task,
        last_phase = IF $t.state = 'review' THEN 'review' ELSE 'execute' END,
        lane = string::concat(IF $t.project != NONE THEN <string>record::id($t.project) ELSE 'company' END, ':', $who.role);
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
      RETURN SELECT * FROM ONLY $task;
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
    const handover = await this.handoverHistory(taskId);
    const lane = laneOf(project?.id, actor.role);
    const laneNotes = await new LaneNoteStore(this.db).render(lane).catch(() => undefined);
    return { task: taskView, deliveryId: taskView.deliveryId!, fence: taskView.fence, lane, laneNotes,
      leaseExpiresAt: taskView.leaseExpiresAt!, history: handover.history, historyComplete: handover.historyComplete, historyCount: handover.historyCount,
      predecessors: await this.predecessors(taskId, actor.employeeId),
      project, worktree: taskView.worktree };
  }

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
  private disciplineContract(projectId?: string): Promise<DisciplineContract | undefined> {
    return loadContract(this.db, projectId);
  }

  /**
   * Resolved project of a task: the task-level override when set (rebound or created with one),
   * otherwise the goal's project. This is the single project-resolution point for claim
   * workspaces, claim.json.project, worktree inventory and ops scoping.
   */
  private async taskProject(taskId: TaskId): Promise<ProjectView | undefined> {
    const [rows] = await this.db.query<[Array<{ project?: RecordId }>]>(
      'SELECT project FROM $task;', { task: id('task', taskId) });
    return rows[0]?.project ? this.projects.get(String(rows[0].project.id)) : undefined;
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

  /**
   * Submit-time system checks (type errors, version metadata, tool wiring) on an engineering code submit to the ops repo.
   * The release task that carries a quick chain's code leg is checked the same way; read-intent legs are not.
   * A failure refuses the submit before review: the author keeps the lease and fixes it, no reviewer is dispatched. Each
   * refusal is audited as submit_check_failed, which scoring counts against the author. A check that cannot run lets
   * the submit through; the reviewer still checks.
   */
  private async refuseFailedSystemChecks(proof: LeaseProof, employeeId: string): Promise<void> {
    const row = await this.db.select<TaskRow>(id('task', proof.taskId));
    if (!row || row.executor_role !== 'engineering' || row.work_intent?.kind !== 'code') return;
    if (!['task', 'release'].includes(row.kind ?? 'task')) return;
    if (row.current_employee !== employeeId || row.fence !== proof.fence) return;
    const tree = row.worktree;
    if (!tree?.worktreePath) return;
    try {
      if (canonicalRepoPath(tree.repo) !== canonicalRepoPath(this.worktrees?.options.opsRepo ?? opsRepoPath())) return;
    } catch { return; }
    const problems = await this.systemCheck!({ worktreePath: tree.worktreePath, ...(tree.branch ? { branch: tree.branch } : {}) }).catch(() => []);
    if (!problems.length) return;
    const text = problems.join('\n');
    await this.db.query("CREATE audit CONTENT { task: $task, actor: $actor, action: 'submit_check_failed', version: $version, evidence: $text, at: time::now() };",
      { task: id('task', proof.taskId), actor: id('employee', employeeId), version: row.version, text }).catch(() => {});
    throw new CompanyError('invalid', `提交被退回（未进入验收，系统检查未通过）：\n${text}\n修复后重新 submit；租约仍在你手上。`);
  }

  /**
   * The code repository a new task is bound to at creation, so its first claim already lands in the right tree instead of
   * the business project's repo (the wrong-repo block → bind_task_code_repo → re-dispatch loop). An explicit codeRepoPath
   * must be on the bind allowlist. Without one, a task that writes code (code intent, release or deploy leg) whose
   * project repo is not the ops repo, and whose context names the ops repo's absolute path, is bound to the ops repo:
   * that is how operators already state "the code is in operations, the business project stays". Anything else keeps
   * project routing (undefined).
   */
  private async creationCodeRepo(input: Pick<CreateTask, 'codeRepoPath' | 'context' | 'project' | 'workIntent'>, kind: TaskKind): Promise<string | undefined> {
    if (input.codeRepoPath !== undefined) {
      requireText(input.codeRepoPath, 'codeRepoPath', 1, 1000);
      if (!input.codeRepoPath.startsWith('/') || input.codeRepoPath.includes('\0') || input.codeRepoPath.split('/').includes('..')) {
        throw new CompanyError('invalid', 'codeRepoPath must be an absolute path without traversal');
      }
      const bound = canonicalRepoPath(input.codeRepoPath);
      if (!(await this.allowedCodeRepos()).has(bound)) throw new CompanyError('forbidden', 'codeRepoPath is not a registered project repo or the ops repo');
      return bound;
    }
    const writes = kind === 'release' || kind === 'deploy' || input.workIntent?.kind === 'code';
    if (!writes) return undefined;
    const ops = this.worktrees?.options.opsRepo ?? opsRepoPath();
    if (!namesRepo(input.context, ops)) return undefined;
    const project = input.project ? await this.projects.get(input.project) : undefined;
    if (!project?.repoPath) return undefined;
    let opsCanon: string, projectCanon: string;
    try { opsCanon = canonicalRepoPath(ops); projectCanon = canonicalRepoPath(project.repoPath); } catch (error) {
      // Without an execution host the local layout is unknown: refuse, never route the task to the project repo by guess.
      if (error instanceof CompanyError && error.code === 'unavailable') throw error;
      return undefined;
    }
    return opsCanon === projectCanon ? undefined : opsCanon;
  }

  private async historyRowsAt(taskId: TaskId, limit: number, db?: Surreal): Promise<{ at: string; rows: AuditHistoryRow[] }> {
    return this.consistentRead<{ at: string; rows: AuditHistoryRow[] }>(`LET $at = <string>time::now();
      LET $rows = (SELECT id, action, actor, evidence, version, at, <string>at AS cat FROM audit
        WHERE task = $task AND action != 'ops_call' ORDER BY at DESC, id DESC LIMIT $limit);
      RETURN { read: { at: $at, rows: $rows } };`, { task: id('task', taskId), limit }, db);
  }

  /**
   * The handover window of a claim (SYS01 R3): the newest HANDOVER_ROWS protocol entries and the newest HANDOVER_OPS_ROWS ops
   * entries, oldest first, each whole. historyCount is the task's entry count in all, read in the same transaction as the
   * window, and historyComplete is true only when every entry was read. A claim has committed when its answer is built, so the
   * window is bounded, never refused: the echo (echoClaim) keeps the entries its response can hold, and get_task_history
   * pages the rest.
   */
  private async handoverHistory(taskId: TaskId): Promise<{ history: HistoryEntry[]; historyComplete: boolean; historyCount: number }> {
    // Ops rows get their own window so a chatty broker session cannot push claims and checkpoints out of the handover.
    const read = await this.consistentRead<{ protocol: AuditHistoryRow[]; ops: AuditHistoryRow[]; count: number | null }>(`LET $protocol = (SELECT id, action, actor, evidence, version, at, <string>at AS cat FROM audit
        WHERE task = $task AND !string::starts_with(action, 'ops_') ORDER BY at DESC, id DESC LIMIT $limit);
      LET $ops = (SELECT id, action, actor, evidence, version, at, <string>at AS cat FROM audit
        WHERE task = $task AND string::starts_with(action, 'ops_') AND action != 'ops_call' ORDER BY at DESC, id DESC LIMIT $ops_limit);
      LET $counted = (SELECT count() AS n FROM audit WHERE task = $task AND action != 'ops_call' GROUP ALL);
      RETURN { read: { protocol: $protocol, ops: $ops, count: $counted[0].n ?? 0 } };`,
    { task: id('task', taskId), limit: HANDOVER_ROWS + 1, ops_limit: HANDOVER_OPS_ROWS + 1 });
    const rows = [...read.protocol.slice(0, HANDOVER_ROWS), ...read.ops.slice(0, HANDOVER_OPS_ROWS)]
      .sort((a, b) => (a.cat < b.cat ? 1 : a.cat > b.cat ? -1 : 0));
    const historyCount = Number(read.count ?? 0);
    const history = rows.map(row => historyEntry(row)).reverse();
    const complete = read.protocol.length <= HANDOVER_ROWS && read.ops.length <= HANDOVER_OPS_ROWS && rows.length === historyCount;
    return { history, historyComplete: complete, historyCount };
  }

  /** get_task_history without pageSize or cursor (C2): the complete history, oldest first, or a refusal when it does not fit. */
  async history(credential: Credential, taskId: TaskId): Promise<HistoryEntry[]> {
    await this.getTask(credential, taskId);
    const { rows } = await this.historyRowsAt(taskId, COMPLETE_HISTORY_ROWS + 1);
    if (rows.length > COMPLETE_HISTORY_ROWS) {
      throw tooLarge(`task ${taskId} has more than ${COMPLETE_HISTORY_ROWS} audit entries; read them with get_task_history, pageSize and page.nextCursor`);
    }
    const entries = rows.map(row => historyEntry(row)).reverse();
    return completeOrRefuse(entries, `the history of task ${taskId} (${entries.length} entries)`,
      'retry with {"pageSize":10} and then {"cursor":"<page.nextCursor>"} until page.hasMore is false; read the evidence of one large entry with read_task_text {"taskId","field":"evidence","auditId","offset":0}, then offset = nextOffset with the expectSha256 of the first segment');
  }

  /** The cursor secret read once per process: the row never changes, and one round trip per page was pure fixed cost. */
  private cursorKeyCache?: Buffer;

  /** Per-key cursor secret: one row in company_meta, created on first use and never returned to callers. */
  private async cursorKey(): Promise<Buffer> {
    if (this.cursorKeyCache) return this.cursorKeyCache;
    const record = id('company_meta', 'cursor_key');
    const existing = await this.db.select<{ key?: string }>(record);
    if (existing?.key) return (this.cursorKeyCache = Buffer.from(existing.key, 'base64url'));
    const key = randomBytes(32);
    try {
      await this.db.query('CREATE ONLY $record CONTENT { key: $key, created_at: time::now() };', { record, key: key.toString('base64url') });
      return (this.cursorKeyCache = key);
    } catch {
      const again = await this.db.select<{ key?: string }>(record);
      if (!again?.key) throw new CompanyError('temporarily_unavailable', 'cursor key unavailable; retry the read', true);
      return (this.cursorKeyCache = Buffer.from(again.key, 'base64url'));
    }
  }

  /** Database clock now: the time a listing is stamped with. */
  private async dbNow(): Promise<string> {
    const [now] = await this.db.query<[string]>('RETURN <string>time::now();');
    return now;
  }

  /**
   * Runs `statements`, which end in RETURN { read: … }, inside one BEGIN…COMMIT and returns that value, so every row and
   * time in it comes from one database state. A failed statement is retryable.
   */
  private async consistentRead<T>(statements: string, vars: Record<string, unknown>, db: Surreal = this.db): Promise<T> {
    let responses;
    try {
      responses = await db.query<unknown[]>(`BEGIN TRANSACTION;\n${statements}\nCOMMIT TRANSACTION;`, vars).responses();
    } catch {
      throw new CompanyError('temporarily_unavailable', 'read did not complete; retry', true);
    }
    const found = responses.every(response => response.success)
      ? responses.map(response => response.result).find((value): value is { read: T } => typeof value === 'object' && value !== null && 'read' in value)
      : undefined;
    if (!found) throw new CompanyError('temporarily_unavailable', 'read did not complete; retry', true);
    return found.read;
  }

  /**
   * Task rows for the context queries: the filters, the default states and the role scope, newest first, in one consistent
   * read. The read counts the matches and the UTF-8 bytes of their context first (bytes::len, the size the listing stores), and
   * the whole rows are read only when that total is within `cap`, so a read that will be refused never loads the text.
   */
  private async taskRowsAt(actor: Principal, params: ContextParams, limit: number, cap: number, db?: Surreal):
    Promise<{ at: string; count: number; textBytes: number; rows: TaskRow[] }> {
    const where: string[] = [
      params.state ? 'state = $state' : "state IN ['ready', 'doing', 'review', 'blocked']",
      "NOT (state = 'review' AND submitted_by = $me)",
    ];
    const vars: Record<string, unknown> = { cap, limit, me: actor.employeeId };
    if (params.state) vars.state = params.state;
    if (actor.role !== 'owner') {
      where.push('(executor_role = $myrole OR reviewer_role = $myrole)');
      vars.myrole = actor.role ?? '';
    }
    if (params.role) {
      where.push('(executor_role = $qrole OR reviewer_role = $qrole)');
      vars.qrole = params.role;
    }
    if (params.tag) {
      where.push('tag = $tag');
      vars.tag = params.tag;
    }
    if (params.since) {
      where.push('created_at >= <datetime>$since');
      vars.since = params.since;
    }
    const read = await this.consistentRead<{ at: string; count: number; textBytes: number; rows?: TaskRow[] | null }>(`LET $at = <string>time::now();
      LET $probe = (SELECT id, created_at, bytes::len(<bytes>(context ?? '')) AS textBytes FROM task WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT $limit);
      LET $n = array::len($probe);
      LET $total = IF $n = 0 THEN 0 ELSE math::sum($probe.textBytes) END;
      LET $full = IF $n = 0 OR $total > $cap THEN [] ELSE (SELECT * FROM task WHERE id IN $probe.id ORDER BY created_at DESC, id DESC) END;
      RETURN { read: { at: $at, count: $n, textBytes: $total, rows: array::flatten([$full]) } };`, vars, db);
    const count = Number(read.count ?? 0);
    const textBytes = Number(read.textBytes ?? 0);
    // The query wraps the rows in array::flatten: a lone match comes back as one object, not as a one-element array.
    const rows = read.rows ?? [];
    // Within the cap every match is loaded. A short load would drop tasks silently, so it is refused as retryable instead.
    if (textBytes <= cap && rows.length !== count) {
      throw new CompanyError('temporarily_unavailable', 'task listing read did not complete; retry', true);
    }
    return { at: read.at, count, textBytes, rows };
  }

  /** The instant (epoch milliseconds) by which a listing call must have answered: its build deadline and the cleanup budget, from its start. */
  private replyAt(startedAt: number): number {
    return startedAt + this.snapshots.limits.buildDeadlineMs + CLEANUP_BUDGET_MS;
  }

  /** `work` answers by `at`, or the caller gets a recoverable temporarily_unavailable. A stalled read is left to finish on its own. */
  private async bounded<T>(work: Promise<T>, at: number): Promise<T> {
    const value = await untilAt(work, at);
    if (value === undefined) throw new CompanyError('temporarily_unavailable', 'the database did not answer in time; retry shortly', true);
    return value as T;
  }

  /**
   * Stores the working set as a context listing. Its membership and its projection are fixed by one read, which runs on the
   * build channel inside the build deadline (SYS01 AC-D): the main connection stays free for control requests meanwhile.
   */
  private async contextListing(actor: Principal, params: ContextParams, digest: string, startedAt: number): Promise<{ header: SnapshotHeader; bodies: readonly string[] } | { empty: true }> {
    const { limits } = this.snapshots;
    const header = await this.snapshots.build({
      owner: actor.employeeId, kind: 'context', digest, role: actor.role ?? '', startedAt,
      guidance: 'narrow with state, tag, role or since, or leave fields out',
      load: async db => {
        const { at, count, textBytes, rows } = await this.taskRowsAt(actor, params, limits.maxRows + 1, limits.maxBytes, db);
        if (count > limits.maxRows) throw tooLarge(`more than ${limits.maxRows} tasks match; narrow with state, tag, role or since`);
        if (textBytes > limits.maxBytes) {
          throw tooLarge(`the matching tasks hold more than ${limits.maxBytes} bytes of text; narrow with state, tag, role or since`);
        }
        return { takenAt: at, bodies: rows.map(row => JSON.stringify(listItem(row, params.fields, true))) };
      },
      emptyWhenNoRows: true, returnRows: true,
    });
    if ('empty' in header) return header;
    return { header, bodies: header.bodies };
  }

  /**
   * One page of a stored listing (C4). The first page (no cursor) stores the listing through `create`; a later page
   * resumes after the cursor's position. Every page re-checks the caller, the kind, the query and the role. The page
   * holds as many of the next rows as fit the budget, and its cursor continues after the last row it delivered.
   */
  private async listingPage<T, R>(args: {
    actor: Principal; kind: SnapshotKind; digest: string; pageSize: number; cursor?: string;
    /** When the tool call started: every wait of this page, the build and the reads included, ends by replyAt(startedAt). */
    startedAt: number;
    /** The refusal for a cursor that no longer matches the caller's access (for example a project-environment view that changed). */
    mismatch?: string;
    /**
     * `{ empty: true }` when the read matched nothing: the page is answered without storing a listing (SYS01 AC02). A listing that
     * already holds its rows in memory returns them too, so its first page needs no read-back round trip.
     */
    create: (startedAt: number) => Promise<SnapshotHeader | { empty: true } | { header: SnapshotHeader; bodies: readonly string[] }>;
    parse: (body: string) => T;
    respond: (items: readonly T[], page: PageInfo) => R;
    /** What the caller can change when the page envelope alone is over the budget (for example includeCompany). */
    envelopeGuidance: string;
    /** Guidance when one row cannot fit a page even after its own cut: name a real entry that reads the rest. */
    oversizeGuidance?: (item: T) => string;
  }): Promise<R> {
    const { actor, kind, digest, pageSize } = args;
    const replyAt = this.replyAt(args.startedAt);
    const key = await this.bounded(this.cursorKey(), replyAt);
    let sid: string;
    let after: number;
    let stored: string | undefined;
    let built: { header: SnapshotHeader; bodies: readonly string[] } | undefined;
    if (args.cursor === undefined) {
      const created = await args.create(args.startedAt);
      if ('empty' in created) {
        // Nothing matched: answer the empty page without a stored listing (SYS01 AC02 production return).
        const page: PageInfo = {
          pageSize, returned: 0, hasMore: false, total: 0, snapshotAt: new Date().toISOString(), budgetBytes: RESPONSE_BUDGET_BYTES,
        };
        return completeOrRefuse(args.respond([], page), 'this page', args.envelopeGuidance);
      }
      const header = 'header' in created ? created.header : created;
      if ('bodies' in created) built = { header, bodies: created.bodies };
      stored = header.id;
      sid = stored;
      after = 0;
    } else {
      const body = openCursor(args.cursor, key, Date.now());
      if (body.k !== kind || body.c !== actor.employeeId || body.q !== digest) {
        throw new CompanyError('forbidden', args.mismatch ?? 'cursor belongs to another caller or another query');
      }
      sid = body.sid;
      after = body.seq;
    }
    // A listing this call stored is released in the background whenever the call does not return its page: the caller has no time
    // left to wait for the release, and a release that fails is left for the sweep. Nothing stored stays reserved for its TTL.
    const releaseStored = (): void => { if (stored !== undefined) void this.snapshots.release(stored).catch(() => undefined); };
    try {
      // A first page is answered from the rows the build just read: reading them back would cost another round trip and carry the
      // same page over the link twice (SYS01 AC02 production return). Every later page reads the stored listing.
      let header: SnapshotHeader;
      let rows: Array<{ seq: number; body: string }>;
      if (built) {
        header = built.header;
        rows = built.bodies.slice(0, pageSize).map((body, index) => ({ seq: index + 1, body }));
      } else {
        const read = await untilAt(this.snapshots.read({
          id: sid, owner: actor.employeeId, kind, digest, role: actor.role ?? '', after, limit: pageSize,
        }), replyAt);
        if (read === undefined) {
          throw new CompanyError('temporarily_unavailable', 'the listing page was not read in time; narrow the query or retry shortly', true);
        }
        ({ header, rows } = read);
      }
      const items = rows.map(row => ({ seq: row.seq, value: args.parse(row.body) }));
      const build = (kept: ReadonlyArray<{ seq: number; value: T }>): R => {
        const last = kept.at(-1)?.seq ?? after;
        const hasMore = last < header.rows;
        const page: PageInfo = {
          pageSize, returned: kept.length, hasMore, total: header.rows, snapshotAt: header.takenAt, budgetBytes: RESPONSE_BUDGET_BYTES,
          ...(hasMore ? { nextCursor: sealCursor({ v: 1, k: kind, c: actor.employeeId, q: digest, sid, seq: last, exp: header.expiresMs }, key) } : {}),
        };
        return args.respond(kept.map(item => item.value), page);
      };
      const bare = answerBytes(build([]));
      if (bare > RESPONSE_BUDGET_BYTES) {
        throw tooLarge(`the page envelope alone is ${bare} bytes, above the ${RESPONSE_BUDGET_BYTES}-byte budget; ${args.envelopeGuidance}`);
      }
      const kept = fitCount(items, subset => answerBytes(build(subset as ReadonlyArray<{ seq: number; value: T }>)), RESPONSE_BUDGET_BYTES);
      if (kept === 0 && items.length > 0) {
        const first = items[0]!.value;
        throw tooLarge(args.oversizeGuidance?.(first) ?? 'one entry of this listing is larger than a page can hold; read it with read_task_text, or narrow the fields');
      }
      return completeOrRefuse(build(items.slice(0, kept)), 'this page', args.envelopeGuidance);
    } catch (error) {
      releaseStored();
      throw error;
    }
  }

  /**
   * get_context (SYS01, C2 to C4). Without pageSize or cursor the answer is complete: the working set, or one task with its
   * whole context. It is refused as response_too_large when it does not fit the budget. With pageSize or cursor it is one
   * page of a stored listing; a task read by id is never paged and takes no cursor.
   */
  async contextView(credential: Credential, input: Record<string, unknown> = {}): Promise<ContextView> {
    const startedAt = arrivedAt();
    const actor = await this.authenticate(credential);
    const params = parseContextInput(input);
    if (params.scope === 'company') return this.companyContextView(credential, actor, params, startedAt);
    // A task answer carries the company block only when includeCompany is true (AC-A). Every task answer says whether it does, and how
    // the block is read in pages, so the directions are always one call away.
    const company = params.includeCompany ? await this.bounded(this.companyBrief(credential), this.replyAt(startedAt)) : undefined;
    const withCompany = { ...(company ? { company } : {}), companyIncluded: company !== undefined, companyRead: COMPANY_READ };
    if (params.taskId !== undefined) {
      if (params.cursor !== undefined) throw new CompanyError('invalid', 'a cursor pages a listing; one task is read without it');
      const task = await this.getTask(credential, params.taskId as TaskId);
      const view: ContextView = {
        principal: actor, ...withCompany, tasks: [detailTaskView(task, params.fields)],
        ...(params.paged ? { page: { pageSize: params.pageSize, returned: 1, hasMore: false, total: 1, budgetBytes: RESPONSE_BUDGET_BYTES } } : {}),
      };
      return completeOrRefuse(view, `task ${task.id}`,
        `read a long part with read_task_text: the context {"taskId":"${task.id}","field":"context","offset":0}, then offset = nextOffset with the expectSha256 of the first segment, until nextOffset is null (the whole text has sha256 ${HASH(task.context)}); or leave a part out with fields${company ? `; or ${COMPANY_PAGED_HINT}` : ''}`);
    }
    if (!params.paged) {
      const guidance = 'retry with {"pageSize":25} and then {"cursor":"<page.nextCursor>"} until page.hasMore is false, or narrow with state, tag, role or since';
      const { count, textBytes, rows } = await this.taskRowsAt(actor, params, COMPLETE_TASK_ROWS + 1, RESPONSE_BUDGET_BYTES);
      if (count > COMPLETE_TASK_ROWS) throw tooLarge(`more than ${COMPLETE_TASK_ROWS} tasks match; ${guidance}`);
      if (textBytes > RESPONSE_BUDGET_BYTES) {
        throw tooLarge(`the matching tasks hold ${textBytes} bytes of text, above the ${RESPONSE_BUDGET_BYTES}-byte budget; ${guidance}`);
      }
      const view: ContextView = { principal: actor, ...withCompany, tasks: rows.map(row => listItem(row, params.fields, false)) };
      return completeOrRefuse(view, `the working set (${rows.length} tasks)`, company ? `${guidance}; or ${COMPANY_PAGED_HINT}` : guidance);
    }
    const digest = queryDigest('context', {
      state: params.state ?? null, tag: params.tag ?? null, role: params.role ?? null, since: params.since ?? null, fields: params.fields ?? null, includeCompany: params.includeCompany,
    });
    return this.listingPage<Record<string, unknown>, ContextView>({
      actor, kind: 'context', digest, pageSize: params.pageSize, cursor: params.cursor, startedAt,
      create: started => this.contextListing(actor, params, digest, started),
      parse: body => JSON.parse(body) as Record<string, unknown>,
      respond: (tasks, page) => ({ principal: actor, ...withCompany, tasks: [...tasks], page }),
      envelopeGuidance: company ? `${COMPANY_PAGED_HINT}, which leaves the block out of every page` : 'narrow the query with state, tag, role or since',
      oversizeGuidance: item => `task ${String(item.id)} is larger than a page can hold; read its context with read_task_text ${JSON.stringify({ taskId: String(item.id), field: 'context', offset: 0 })}, or narrow the fields with fields`,
    });
  }

  /**
   * get_context with scope company (SYS01 AC-A): the company block, complete or in stored pages. Without paging the block, or the one
   * section named, is returned whole or refused. With paging it is one page of parts (company-context.ts): every part of every item
   * is listed exactly once, in a stable order, and a part carries its item's length and SHA-256 so the reader can check the join.
   */
  private async companyContextView(credential: Credential, actor: Principal, params: ContextParams, startedAt: number): Promise<ContextView> {
    const section = params.section;
    const named = section === undefined ? {} : { section };
    const replyAt = this.replyAt(startedAt);
    // The block and the listing digest are built from the same view of the project environments (SYS01 M3), so a stored listing
    // is read only by the reader and under the access it was taken with.
    const view = await this.bounded(this.envView(actor), replyAt);
    if (!params.paged) {
      const brief = await this.bounded(this.companyBriefAs(view), replyAt);
      const answer: ContextView = { principal: actor, scope: 'company', ...named, company: companyBlock(brief, section) };
      return completeOrRefuse(answer, 'the company block',
        'read it in pages: {"scope":"company","pageSize":25}, then {"scope":"company","pageSize":25,"cursor":"<page.nextCursor>"} until page.hasMore is false; or one section with "section"');
    }
    const digest = queryDigest('company', { section: section ?? null, envs: view.key });
    return this.listingPage<CompanyPart, ContextView>({
      actor, kind: 'context', digest, pageSize: params.pageSize, cursor: params.cursor, startedAt,
      mismatch: 'cursor belongs to another caller or query, or was taken under other access to project environments; start the listing again without cursor',
      // The block is read only when a listing is made: a cursor page reads the stored listing and never the block.
      create: async started => {
        const brief = await this.bounded(this.companyBriefAs(view), this.replyAt(started));
        const takenAt = new Date().toISOString();
        return this.snapshots.create({
          owner: actor.employeeId, kind: 'context', digest, role: actor.role ?? '', takenAt, startedAt: started,
          bodies: companyParts(brief, section).map(part => JSON.stringify(part)),
          // The company block narrows by section and pages, never by the task filters: the guidance a refusal hands back says so (SYS01 B9).
          guidance: 'read it in pages: {"scope":"company","pageSize":25}, or one section with "section"',
        });
      },
      parse: body => JSON.parse(body) as CompanyPart,
      respond: (parts, page) => ({ principal: actor, scope: 'company', ...named, parts: [...parts], page }),
      envelopeGuidance: 'use a smaller pageSize',
      oversizeGuidance: () => 'one part of the company block is larger than a page can hold; use a smaller pageSize or one section with "section"',
    });
  }

  /**
   * get_task_history with pageSize or cursor (SYS01, C4): one page of the task's stored history. Pages run newest first;
   * the entries within a page are returned oldest first. Evidence that cannot fit a page is cut and flagged, and
   * read_task_text gives the rest.
   */
  async historyView(credential: Credential, taskId: TaskId, input: Record<string, unknown> = {}): Promise<HistoryPageView> {
    const startedAt = arrivedAt();
    const actor = await this.authenticate(credential);
    await this.getTask(credential, taskId);
    const params = parseHistoryInput(input);
    const digest = queryDigest('history', { taskId });
    return this.listingPage<HistoryEntry, HistoryPageView>({
      actor, kind: 'history', digest, pageSize: params.pageSize, cursor: params.cursor, startedAt,
      create: started => {
        const { limits } = this.snapshots;
        return this.snapshots.build({
          owner: actor.employeeId, kind: 'history', digest, role: actor.role ?? '', startedAt: started,
          guidance: 'read the evidence of large entries with read_task_text', emptyWhenNoRows: true,
          load: async db => {
            const { at, rows } = await this.historyRowsAt(taskId, limits.maxRows + 1, db);
            if (rows.length > limits.maxRows) {
              throw tooLarge(`task ${taskId} has more than ${limits.maxRows} audit entries; its history cannot be listed in one stored listing`);
            }
            return { takenAt: at, bodies: rows.map(row => JSON.stringify(historyEntry(row, ITEM_BUDGET_BYTES))) };
          },
        });
      },
      parse: body => JSON.parse(body) as HistoryEntry,
      respond: (history, page) => ({ history: [...history].reverse(), page }),
      envelopeGuidance: 'use a smaller pageSize',
      oversizeGuidance: entry => entry.auditId
        ? `history entry ${entry.auditId} is larger than a page can hold; read its evidence with read_task_text ${JSON.stringify({ taskId: String(taskId), field: 'evidence', auditId: entry.auditId, offset: 0 })}`
        : 'a history entry is larger than a page can hold; use a smaller pageSize',
    });
  }

  /**
   * list_worktrees with pageSize or cursor (SYS01, C1 and C4): one page of a stored inventory. References are compact:
   * released ones are counted, and listed only with includeReleased. Rows are sorted by path. Every call re-checks access.
   */
  async worktreePage(credential: Credential, input: Record<string, unknown> = {}): Promise<WorktreePageView> {
    const actor = await this.authenticate(credential);
    const params = parseWorktreeInput(input);
    await this.worktreeScope(credential, actor, params.taskId);
    const digest = queryDigest('worktrees', { taskId: params.taskId ?? null, includeReleased: params.includeReleased });
    const startedAt = arrivedAt();
    return this.listingPage<Record<string, unknown>, WorktreePageView>({
      actor, kind: 'worktrees', digest, pageSize: params.pageSize, cursor: params.cursor, startedAt,
      create: async started => {
        const replyAt = this.replyAt(started);
        const takenAt = await this.bounded(this.dbNow(), replyAt);
        const inventory = compactWorktrees(await this.bounded(this.listWorktrees(credential, params.taskId as TaskId | undefined), replyAt), params.includeReleased, ITEM_BUDGET_BYTES);
        if (inventory.length > this.snapshots.limits.maxRows) {
          throw tooLarge(`${inventory.length} worktrees are registered, above the ${this.snapshots.limits.maxRows}-row listing limit`);
        }
        return this.snapshots.create({
          owner: actor.employeeId, kind: 'worktrees', digest, role: actor.role ?? '', takenAt, startedAt: started,
          bodies: inventory.map(item => JSON.stringify(item)), guidance: 'narrow with taskId', emptyWhenNoRows: true,
        });
      },
      parse: body => JSON.parse(body) as Record<string, unknown>,
      respond: (worktrees, page) => ({ worktrees: [...worktrees], page }),
      envelopeGuidance: 'use a smaller pageSize, or narrow with taskId',
      oversizeGuidance: item => `worktree ${String(item.worktreePath)} is larger than a page can hold even with its references cut; start the listing again without cursor, or read its references with read_worktree_refs ${JSON.stringify({ ...(params.taskId ? { taskId: params.taskId } : {}), worktreePath: String(item.worktreePath), includeReleased: params.includeReleased, offset: 0 })}`,
    });
  }

  /**
   * list_worktrees without pageSize or cursor (C1): the complete compact inventory as one array, in the same form as a
   * page. It is refused as response_too_large when it does not fit the budget; it is never cut.
   */
  async worktreeList(credential: Credential, input: Record<string, unknown> = {}): Promise<WorktreeCompact[]> {
    await this.authenticate(credential);
    const params = parseWorktreeInput(input);
    const list = compactWorktrees(await this.listWorktrees(credential, params.taskId as TaskId | undefined), params.includeReleased);
    return completeOrRefuse(list, `the worktree inventory (${list.length} worktrees)`,
      'read it with list_worktrees, pageSize and page.nextCursor, or pass taskId to narrow it; a worktree whose references are cut in a page is read whole with read_worktree_refs');
  }

  /**
   * read_worktree_refs (SYS01 R1): one byte segment of one worktree's references as JSON, the recovery entry a paged listing
   * item names when its references were cut. The worktree is looked up under the same scope as list_worktrees (a task id
   * scopes it to that task's repository; a global read is owner only), and includeReleased must be the filter the listing item
   * reports, so the digest the item carries covers exactly this text. Segments never split a character and reassemble
   * exactly; sha256 covers the whole text, and a segment past offset 0 pins the digest it started with.
   */
  async worktreeRefs(credential: Credential, input: Record<string, unknown>): Promise<WorktreeRefsSegment> {
    const actor = await this.authenticate(credential);
    const params = parseWorktreeRefsInput(input);
    await this.worktreeScope(credential, actor, params.taskId);
    const inventory = await this.listWorktrees(credential, params.taskId as TaskId | undefined);
    const worktree = inventory.find(item => item.worktreePath === params.worktreePath);
    if (!worktree) throw new CompanyError('not_found', 'worktree not found in the scope of this call');
    const references = params.includeReleased
      ? worktree.references
      : worktree.references.filter(reference => reference.state !== 'released');
    const text = JSON.stringify(references);
    const sha256 = HASH(text);
    // A reassembly pins the digest it started with. A list that changed since is refused, never mixed in.
    if (params.expectSha256 !== undefined && params.expectSha256 !== sha256) {
      throw new CompanyError('conflict', `the references changed: they are now ${utf8Bytes(text)} bytes with sha256 ${sha256}; read them again from offset 0, with the same includeReleased as the listing`);
    }
    const head = { worktreePath: worktree.worktreePath, includeReleased: params.includeReleased, sha256 };
    return worktreeRefsSegmentAnswer(head, worktreeRefsSegment(text, params.offset, params.limit, head));
  }

  /** Re-checks, on every worktree read, what it needs: access to the task, or owner for the global inventory. */
  private async worktreeScope(credential: Credential, actor: Principal, taskId?: string): Promise<void> {
    if (taskId !== undefined) await this.getTask(credential, taskId as TaskId);
    else if (actor.role !== 'owner') throw new CompanyError('forbidden', 'Global worktree inventory requires owner');
  }

  /**
   * read_task_text (SYS01, R3): one byte segment of one text of a task. context and evidence are read as stored. project is the
   * task's project environment as JSON, read by its holder and owner only. workIntentPaths and worktreePaths are the
   * task's lists as JSON arrays, the form a claim echo cuts them from. Segments never split a character and reassemble exactly;
   * sha256 covers the whole text, so a reader can verify it.
   */
  async taskText(credential: Credential, input: Record<string, unknown>): Promise<TaskTextSegment> {
    const params = parseTextInput(input);
    const task = await this.getTask(credential, params.taskId as TaskId);
    let text: string;
    if (params.field === 'context') {
      const row = await this.db.select<TaskRow>(id('task', params.taskId));
      text = row?.context ?? '';
    } else if (params.field === 'evidence') {
      if (!params.auditId) throw new CompanyError('invalid', 'auditId is required to read evidence');
      // Routine ops_call rows are not audit history, so no history answer names them and they are not readable here either.
      const [rows] = await this.db.query<[Array<{ task?: RecordId; evidence?: string | null }>]>(
        "SELECT task, evidence FROM audit WHERE id = $aid AND action != 'ops_call';", { aid: id('audit', params.auditId) });
      const row = rows?.[0];
      if (!row || !row.task || asId(row.task) !== params.taskId) throw new CompanyError('not_found', 'evidence entry not found for this task');
      text = row.evidence ?? '';
    } else if (params.field === 'project') {
      const actor = await this.authenticate(credential);
      // The holder reads it only while the lease is valid, the same rule as the company block (SYS01 M3).
      const holds = task.currentEmployee === actor.employeeId && Date.parse(task.leaseExpiresAt ?? '') > Date.now();
      if (actor.role !== 'owner' && !holds) {
        throw new CompanyError('forbidden', 'the project environment is read by owner or the holder of a valid task lease');
      }
      const project = await this.taskProject(params.taskId as TaskId);
      if (!project) throw new CompanyError('not_found', 'the task has no project environment');
      text = JSON.stringify(project);
    } else {
      const lists = {
        workIntentPaths: task.workIntent?.paths ?? [],
        worktreePaths: task.worktree?.intent?.paths ?? [],
      };
      text = JSON.stringify(lists[params.field]);
    }
    const sha256 = HASH(text);
    // A reassembly pins the digest of the text it started with. A text that changed since is refused, never mixed in.
    if (params.expectSha256 !== undefined && params.expectSha256 !== sha256) {
      throw new CompanyError('conflict', `the ${params.field} text changed: it is now ${utf8Bytes(text)} bytes with sha256 ${sha256}; read it again from offset 0`);
    }
    // Sized by the serialized answer, so escaped control characters and quotes cannot push it past the budget (F2).
    const head = { taskId: params.taskId, field: params.field, ...(params.auditId ? { auditId: params.auditId } : {}), sha256 };
    return textSegmentAnswer(head, textSegment(text, params.offset, params.limit, head));
  }

  /**
   * get_admin_summary (SYS01, C5, owner only): counts by state and by audit action in a window, with the cutoff time and the
   * outbox sequence. The counts are read twice inside one transaction. integrity.complete is true only when the two reads
   * agree and each count matches the rows it grouped. Nothing here carries task text.
   */
  async adminSummary(credential: Credential, input: Record<string, unknown> = {}): Promise<AdminSummary> {
    const actor = await this.authenticate(credential);
    if (actor.role !== 'owner') throw new CompanyError('forbidden', 'Only owner may read the company summary');
    const params = parseSummaryInput(input);
    const since = params.since ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    // One transaction. The cutoff is the database time at its start. Task counts are each task's state at that cutoff and
    // ignore since. Audit counts cover [since, cutoff].
    const taskWhere = params.tag ? 'WHERE tag = $tag' : '';
    const auditWhere = params.tag
      ? 'at >= <datetime>$since AND at <= $cutoff AND task IN (SELECT VALUE id FROM task WHERE tag = $tag)'
      : 'at >= <datetime>$since AND at <= $cutoff';
    const counts = (n: string) => `LET $states${n} = (SELECT state, count() AS n FROM task ${taskWhere} GROUP BY state);
      LET $taskTotal${n} = (SELECT count() AS n FROM task ${taskWhere} GROUP ALL)[0].n;
      LET $actions${n} = (SELECT action, count() AS n FROM audit WHERE ${auditWhere} GROUP BY action);
      LET $auditTotal${n} = (SELECT count() AS n FROM audit WHERE ${auditWhere} GROUP ALL)[0].n;`;
    type Counts = {
      states?: Array<{ state?: string | null; n: number }>; taskTotal?: number | null;
      actions?: Array<{ action?: string | null; n: number }>; auditTotal?: number | null;
    };
    type SummaryRead = Counts & { cutoff: string; outbox?: number | null; again?: Counts };
    const read = await this.consistentRead<SummaryRead>(`LET $cutoff = time::now();
      LET $outbox = (SELECT VALUE value FROM company_meta:outbox_counter)[0];
      ${counts('')}
      ${counts('_again')}
      RETURN { read: {
        cutoff: <string>$cutoff, outbox: $outbox,
        states: $states, taskTotal: $taskTotal, actions: $actions, auditTotal: $auditTotal,
        again: { states: $states_again, taskTotal: $taskTotal_again, actions: $actions_again, auditTotal: $auditTotal_again },
      } };`, { since, tag: params.tag ?? null });
    // Both reads are compared in one canonical order, so a difference in row order alone is not reported as a change.
    const canonical = (c: Counts) => JSON.stringify([
      [...(c.states ?? [])].map(row => [String(row.state ?? null), Number(row.n)]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      Number(c.taskTotal ?? 0),
      [...(c.actions ?? [])].map(row => [String(row.action ?? null), Number(row.n)]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      Number(c.auditTotal ?? 0),
    ]);
    const repeatableRead = canonical(read) === canonical(read.again ?? {});
    const tasks: Record<string, number> = {};
    for (const row of read.states ?? []) {
      const key = row.state == null ? 'unknown' : String(row.state);
      tasks[key] = (tasks[key] ?? 0) + Number(row.n);
    }
    const audit: Record<string, number> = {};
    for (const row of read.actions ?? []) {
      const key = row.action == null ? 'unknown' : String(row.action);
      audit[key] = (audit[key] ?? 0) + Number(row.n);
    }
    const taskRows = Object.values(tasks).reduce((sum, n) => sum + n, 0);
    const auditRows = Object.values(audit).reduce((sum, n) => sum + n, 0);
    const unknownStates = Object.keys(tasks).filter(state => !TASK_STATES.includes(state as TaskState));
    const checks = {
      taskCountsMatchRows: taskRows === Number(read.taskTotal ?? 0),
      auditCountsMatchRows: auditRows === Number(read.auditTotal ?? 0),
      statesKnown: unknownStates.length === 0,
      repeatableRead,
    };
    return {
      cutoffAt: read.cutoff, since,
      scope: {
        tasks: params.tag ? `tag ${params.tag} 的任务，各处于 cutoffAt 时的状态；since does not apply to them` : 'every task, each in the state it holds at cutoffAt; since does not apply to them',
        audit: params.tag ? 'audit entries of this tag with at from since up to cutoffAt' : 'audit entries with at from since up to cutoffAt',
      },
      tasks, audit, outboxSequence: Number(read.outbox ?? 0),
      integrity: {
        complete: Object.values(checks).every(Boolean),
        method: 'one BEGIN…COMMIT transaction: cutoff, outbox sequence and counts read together; counts read twice must agree (repeatableRead), and each count must match the rows it grouped; task counts ignore since, audit counts cover [since, cutoffAt]',
        taskRows, auditRows, checks, ...(unknownStates.length ? { unknownStates } : {}),
      },
    };
  }

  /**
   * owner/product/qa only, read-only (SYS04): what the plugin process is actually running.
   *
   * The core cannot take the sample itself — only the plugin host can state which release it loaded, and the
   * plugin host is the face every employee channel reaches. So the core owns the authorization and the caller
   * owns the sampling, in that order: `sample` runs only after the caller is known to be allowed, so an
   * unauthorized read produces no diagnostic at all rather than a refused one that still touched the
   * filesystem.
   */
  async pluginRuntimeDiagnostics(credential: Credential, sample: () => PluginRuntimeView | Promise<PluginRuntimeView>): Promise<PluginRuntimeView> {
    const actor = await this.authorized(credential);
    if (!PLUGIN_RUNTIME_ROLES.includes(actor.role)) {
      throw new CompanyError('forbidden', 'Only owner, product or qa may read the plugin runtime diagnostics');
    }
    return await sample();
  }

  /**
   * owner only, read-only: what the audit-derived contributors say about the given tasks (authors, claim-only
   * hands, submitters). Nothing is written here.
   */
  async companyBrief(credential: Credential): Promise<CompanyBrief> {
    const actor = await this.authorized(credential);
    return this.companyBriefAs(await this.envView(actor));
  }

  private async companyBriefAs(view: EnvView): Promise<CompanyBrief> {
    const brief = await this.owner.brief();
    // SYS07 goal cards are a console/daily-brief read with their own paged endpoint. They are not part of the
    // company block: keeping them here would let 20 goals' blockers and source ids break the SYS01 response budget.
    const base: CompanyBrief = { ...brief, projects: brief.projects.map(project => (view.visible(project.id) ? project : withheldEnvs(project))) };
    delete (base as { goalCards?: unknown }).goalCards;
    return base;
  }

  /** Which project environments a reader may see: all for owner; otherwise those of the projects of tasks it holds under a valid lease. */
  private async envView(actor: Principal): Promise<EnvView> {
    if (actor.role === 'owner') return { key: 'all', visible: () => true };
    const [rows] = await this.db.query<[Array<{ project?: RecordId }>]>(
      'SELECT project AS project FROM task WHERE current_employee = $employee AND lease_expires_at > $now;',
      { employee: actor.employeeId, now: Math.floor(Date.now() / 1000) });
    const held = new Set((rows ?? []).flatMap(row => {
      const project = row.project;
      return project ? [String(project.id)] : [];
    }));
    return { key: [...held].sort().join(','), visible: project => held.has(project) };
  }

  private async relayActor(credential: Credential, ownerQuote: string): Promise<string> {
    const actor = await this.authorized(credential, 'manage');
    if (actor.role !== 'owner') throw new CompanyError('forbidden', 'Only owner may relay owner instructions');
    requireText(ownerQuote, 'owner quote', 2, 4000);
    return `gm-relay:${actor.employeeId}`;
  }

  async acceptanceStatus(credential: Credential, input: { taskId: TaskId }): Promise<AcceptanceStatusView> {
    const actor = await this.authenticate(credential);
    await this.getTask(credential, input.taskId);
    const row = await this.db.select<TaskRow>(id('task', input.taskId));
    if (!row) throw new CompanyError('not_found', 'Task not found');
    const gate = await loadAcceptanceGate(this.db);
    const phase: AcceptancePhase = row.state === 'review' ? (row.reviewer_role === 'owner' ? 'owner' : 'accept') : 'submit';
    // A task still being worked is preparing its next submission; review/done read the attempt that is already submitted.
    const attempt = acceptanceTargetAttempt(row);
    const verdict = evaluateAcceptance({
      subject: acceptanceSubject(row, undefined, { attempt }), evidence: await loadAcceptanceEvidence(this.db, input.taskId), phase,
      actor: { employeeId: actor.employeeId, role: actor.role ?? '', human: true }, gate,
    });
    return { taskId: input.taskId, gate, verdict };
  }

  /** SYS-INT: read-only versioned acceptance-mapping preview for one task. The holder, reviewer or owner may read it; it never writes. */
  async deployDrillRun(credential: Credential, input: { taskId: string; runId: string; baseSha: string; candidateSha: string; idempotencyKey: string }): Promise<{ runId: string; pid: number; root: string }> {
    const actor = await this.authenticate(credential);
    if (actor.role !== 'engineering' && actor.role !== 'owner') throw new CompanyError('forbidden', 'Only engineering or owner may run a deploy drill');
    const row = await this.db.select<{ current_employee?: string; state: string }>(id('task', input.taskId));
    if (!row) throw new CompanyError('not_found', 'Task not found');
    if (row.current_employee !== actor.employeeId && actor.role !== 'owner') throw new CompanyError('forbidden', 'Only the task holder may run a drill for this task');
    const io = hostIO();
    const home = process.env.SCK_SERVICE_HOME ?? io.path.join(io.os.homeDir(), 'Library', 'Application Support', 'SurrealCKCompany');
    const repo = this.companyReleaseRepo ?? this.worktrees?.options.opsRepo ?? process.env.SCK_AGENT_CWD ?? '/Users/y/IdeaProjects/surreal-ck-operations';
    const host = io.drill.host(home, repo);
    const plan = await validateDrillPlan(input, host.ctx);
    await this.db.query('CREATE audit CONTENT {task:$task,actor:$actor,action:"deploy_drill_run",evidence:$evidence,at:time::now()};',
      { task: input.taskId, actor: actor.employeeId, evidence: `runId ${input.runId} base ${input.baseSha} candidate ${input.candidateSha} root ${plan.root}` });
    const pid = (this.drillLaunch ?? io.drill.start)(home, repo, plan);
    return { runId: input.runId, pid, root: plan.root };
  }

  /** SYS-INT: read one drill's state and stage records; the task holder, owner, qa or product may read. */
  async deployDrillStatus(credential: Credential, input: { runId: string }): Promise<{ state?: DrillState; stages?: string[] }> {
    const actor = await this.authenticate(credential);
    if (!['engineering', 'owner', 'qa', 'product'].includes(actor.role ?? '')) throw new CompanyError('forbidden', 'Not allowed to read drill status');
    const io = hostIO();
    const home = process.env.SCK_SERVICE_HOME ?? io.path.join(io.os.homeDir(), 'Library', 'Application Support', 'SurrealCKCompany');
    return io.drill.status(home, input.runId);
  }

  /** SYS02: owner read of the versioned gate record. */
  async acceptanceGate(credential: Credential): Promise<AcceptanceGateView> {
    const actor = await this.authorized(credential, 'manage');
    if (actor.role !== 'owner') throw new CompanyError('forbidden', 'Only owner may read the acceptance gate record');
    return loadAcceptanceGate(this.db);
  }

  /** SYS02 AC06: owner changes the gate with a version check and a reason audit; an executor can never self-approve it. */
  async setAcceptanceGate(credential: Credential, input: AcceptanceGateInput): Promise<AcceptanceGateView> {
    const actor = await this.authorized(credential, 'manage');
    if (actor.role !== 'owner') throw new CompanyError('forbidden', 'Only owner may change the acceptance gate');
    requireText(input.reason, 'reason', 4, 2000);
    const current = await loadAcceptanceGate(this.db);
    const next: AcceptanceGateView = {
      ...current, version: current.version + 1, enabled: input.enabled,
      ...(input.enabled && !current.enabled ? { enabledAt: new Date().toISOString() } : {}),
    };
    try {
      await this.db.query(`BEGIN;
        LET $gate = SELECT * FROM ONLY company_meta:acceptance_gate;
        IF $gate = NONE OR $gate.version != $expected { THROW 'acceptance gate moved' };
        UPDATE ONLY company_meta:acceptance_gate SET version = $version, enabled = $enabled,
          enabled_at = $enabled_at, scope = $scope, criteria_version = $criteria;
        CREATE audit CONTENT { actor: $actor, action: 'acceptance_gate', evidence: $evidence, at: time::now() };
        COMMIT;`, {
        // The CAS compares the caller's expected version to the stored one, never the version this call just read.
        expected: input.expectedVersion, version: next.version, enabled: next.enabled, enabled_at: next.enabledAt ?? null,
        scope: next.scope, criteria: next.criteriaVersion, actor: id('employee', actor.employeeId),
        evidence: JSON.stringify({ before: current, after: next, reason: input.reason }),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/acceptance gate moved|failed transaction/i.test(message)) throw new CompanyError('conflict', 'The acceptance gate moved; read it again');
      throw error;
    }
    return next;
  }

  /** SYS02 AC02: the source adapter, not the model, decides whether a machine criterion is satisfied. */
  async recordAcceptanceEvidence(credential: Credential, input: AcceptanceEvidenceInput): Promise<AcceptanceEvidenceRecord> {
    const actor = await this.authenticate(credential);
    const row = await this.db.select<TaskRow>(id('task', input.taskId));
    if (!row) throw new CompanyError('not_found', 'Task not found');
    if (input.source?.provider !== 'github-actions') throw new CompanyError('invalid', 'acceptance evidence source must be github-actions');
    const holds = row.current_employee === actor.employeeId && ['doing', 'review'].includes(row.state) &&
      (row.lease_expires_at ?? 0) > Date.now() / 1000;
    if (actor.role !== 'owner' && !holds) throw new CompanyError('forbidden', 'Acceptance evidence is recorded by the task holder or owner');
    const criteria = validateAcceptanceCriteria(row.acceptance_criteria);
    const criterion = criteria.find(item => item.id === input.acId);
    if (!criterion) throw new CompanyError('not_found', `acceptance criterion ${input.acId} not found on this task`);
    if (criterion.kind !== 'machine') throw new CompanyError('invalid', `${input.acId} is a human criterion; it is signed at independent review`);
    if (criterion.evidence === 'probe' && (!input.source.probe || !input.source.artifactId)) throw new CompanyError('invalid', `${input.acId}: a probe requires the CI artifact that carries its record and the record itself`);
    if (criterion.evidence === 'artifact' && !input.source.artifactId) throw new CompanyError('invalid', `${input.acId} requires an artifactId`);
    const gate = await loadAcceptanceGate(this.db);
    // N1: the expected environment comes from the controlled task/AC declaration, never from the caller's label. The
    // adapter must return that same verified environment (GitHub deployments for the run/head) or the row is refused.
    const declaredEnvironment = effectiveEnvironment(criteria, row.acceptance_environment);
    if (criterion.environment !== undefined && criterion.environment !== declaredEnvironment) {
      throw new CompanyError('invalid', `${input.acId}: criterion environment ${criterion.environment} is not the declared environment ${declaredEnvironment ?? 'none'}`);
    }
    if (input.environment !== undefined && input.environment !== declaredEnvironment) {
      throw new CompanyError('invalid', `acceptance evidence environment ${input.environment} is not the declared environment ${declaredEnvironment ?? 'none'}`);
    }
    // N2: evidence targets the attempt the task is heading for: the next submission while the work is in progress, the
    // submitted one afterwards. The status read and the evaluator use the same rule.
    const targetAttempt = acceptanceTargetAttempt(row);
    const verified = await this.acceptanceAdapter.verify({
      provider: input.source.provider, runUrl: input.source.runUrl, artifactId: input.source.artifactId,
      sha: input.sha, environment: declaredEnvironment, probe: input.source.probe,
      verify: criterion.verify, risk: criterion.risk,
    });
    if (!verified.ok) {
      await this.db.query(`CREATE audit CONTENT { task: $task, actor: $actor, action: 'acceptance_evidence_rejected', evidence: $evidence, at: time::now() };`,
        { task: id('task', input.taskId), actor: id('employee', actor.employeeId),
          evidence: JSON.stringify({ acId: input.acId, sha: input.sha, reason: verified.reason }).slice(0, 30000) });
      throw new CompanyError('invalid', `acceptance evidence rejected: ${verified.reason}`);
    }
    if (verified.environment !== declaredEnvironment) {
      throw new CompanyError('invalid', `acceptance evidence environment ${verified.environment ?? 'unknown'} is not the declared environment ${declaredEnvironment ?? 'none'}`);
    }
    const evidence = await recordAcceptanceEvidenceRow(this.db, {
      taskId: input.taskId, acId: input.acId, kind: 'machine', sha: input.sha, environment: verified.environment,
      evidenceType: criterion.evidence, source: verified.source, verifier: 'github-actions', actor: actor.employeeId,
      at: verified.at, criteriaVersion: gate.criteriaVersion, taskVersion: row.version, attempt: targetAttempt,
    });
    await this.db.query(`CREATE audit CONTENT { task: $task, actor: $actor, action: 'acceptance_evidence', evidence: $evidence, at: time::now() };`,
      { task: id('task', input.taskId), actor: id('employee', actor.employeeId),
        evidence: JSON.stringify({ acId: input.acId, sha: input.sha, evidenceType: criterion.evidence, environment: verified.environment, attempt: targetAttempt, digest: evidence.digest }) });
    return evidence;
  }

  /** The GitHub slug of the task's code repository: explicit code_repo_path remote first, then the project's repo. */
  private async acceptanceRepoSlug(row: TaskRow): Promise<string | undefined> {
    const paths = [row.code_repo_path];
    if (!paths[0] && row.project) {
      const project = await this.db.select<{ repo_path?: string }>(row.project as RecordId);
      paths.push(project?.repo_path);
    }
    for (const path of paths) {
      if (!path) continue;
      const slug = githubRepoSlug(path) ?? githubRepoSlug(await git(path, ['config', '--get', 'remote.origin.url']).catch(() => ''));
      if (slug) return slug;
    }
    return undefined;
  }

  // ---- 受控编制管理工具（manage = owner/product） ----
  // 员工侧唯一写编制/词表的入口；owner console 与 admin CLI 继续可用。每次写落一条 audit。

  private static defView(d: Pick<EmployeeDef, 'id' | 'role' | 'provider' | 'model' | 'thinking' | 'tracks' | 'enabled' | 'maxInstances' | 'priority' | 'weight' | 'quotaLimited'>): DefView {
    return { id: d.id, role: d.role, provider: d.provider, model: d.model, thinking: d.thinking,
      tracks: d.tracks, enabled: d.enabled, maxInstances: d.maxInstances, priority: d.priority, weight: d.weight,
      quotaLimited: d.quotaLimited };
  }

  private async auditManage(actor: Principal, action: 'def_ensure' | 'project_disciplines_update', summary: Record<string, unknown>): Promise<void> {
    await this.db.query(
      'CREATE audit CONTENT { actor: $actor, action: $action, evidence: $evidence, at: time::now() };',
      { actor: id('employee', actor.employeeId), action, evidence: JSON.stringify(summary).slice(0, OPS_EVIDENCE_CHARS) });
  }

  async listDefs(credential: Credential): Promise<DefView[]> {
    await this.authorized(credential, 'manage');
    type Row = { id: RecordId; role: Role; provider: string; model: string; thinking?: string; tracks?: string[];
      enabled?: boolean; max_instances?: number; priority?: number; weight?: number; quota_limited?: boolean };
    const [rows] = await this.db.query<[Row[]]>('SELECT * FROM employee_def ORDER BY id;');
    return (rows ?? []).map(r => ({ id: asId(r.id), role: r.role, provider: r.provider, model: r.model,
      thinking: r.thinking ?? undefined, tracks: r.tracks ?? undefined, enabled: r.enabled !== false,
      maxInstances: r.max_instances ?? 1, priority: r.priority ?? 100, weight: r.weight ?? 10,
      quotaLimited: r.quota_limited === false ? false : undefined }));
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
      priority: input.priority, weight: input.weight, enabled: input.enabled, quotaLimited: input.quotaLimited });
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
    // The answer is the project as this caller may read it (SYS01 M3): a manage holder without a lease on it gets no environments.
    const visible = await this.envView(actor);
    return visible.visible(view.id) ? view : withheldEnvs(view);
  }

  async opsScope(credential: Credential, taskId: TaskId, proof?: { grantId: string; grantFence: number }): Promise<OpsScope> {
    const actor = await this.authorized(credential);
    requireText(taskId, 'task', 1, 200);
    const [rows] = await this.db.query<[Array<{ current_employee?: string; state: TaskState; lease_expires_at?: number; project?: RecordId }>]>(
      'SELECT current_employee, state, lease_expires_at, project FROM $task;', { task: id('task', taskId) });
    const task = rows[0];
    if (!task) throw new CompanyError('not_found', 'Task not found');
    const project = task.project;
    if (!project) throw new CompanyError('invalid', 'Task has no project environment');
    if (task.current_employee !== actor.employeeId || !['doing', 'review'].includes(task.state) ||
      (task.lease_expires_at ?? 0) <= Date.now() / 1000) {
      throw new CompanyError('forbidden', 'Ops tools are only available to the current lease holder of the task');
    }
    return { actor, taskId, project: String(project.id) };
  }

  async auditOps(scope: OpsScope, action: string, evidence: string): Promise<void> {
    if (!/^ops_[a-z_]{1,40}$/.test(action)) throw new CompanyError('invalid', 'Invalid ops audit action');
    await this.db.query('CREATE audit CONTENT { task: $task, actor: $actor, action: $action, evidence: $evidence, at: time::now() };',
      { task: id('task', scope.taskId), actor: id('employee', scope.actor.employeeId), action, evidence: evidence.slice(0, OPS_EVIDENCE_CHARS) });
  }

  async opsCount(project: string, action: string, windowSeconds: number): Promise<number> {
    const [rows] = await this.db.query<[Array<{ n: number }>]>(
      'SELECT count() AS n FROM audit WHERE action = $action AND at > time::now() - <duration>$window AND task.project = $project GROUP ALL;',
      { action, project: id('project', project), window: `${Math.max(1, Math.floor(windowSeconds))}s` });
    return rows[0]?.n ?? 0;
  }

  async relayOwnerDecision(credential: Credential, input: OwnerDecisionInput & { ownerQuote: string }): Promise<TaskView> {
    const source = await this.relayActor(credential, input.ownerQuote);
    const decided = await this.owner.decide({ ...input, source, key: `${source}:${input.idempotencyKey}`,
      note: `${input.note}\n老板原话：${input.ownerQuote}` });
    return echoTask(decided);
  }

  async relayDirection(credential: Credential, input: { text: string; ownerQuote: string; idempotencyKey: string }): Promise<void> {
    const source = await this.relayActor(credential, input.ownerQuote);
    await this.owner.addDirection({ text: input.text, source, key: `${source}:${input.idempotencyKey}` });
  }

  /** Lease writes answer with their task echoed within the budget (SYS01): the write is already committed, so its echo never fails it. */
  private async transition(
    credential: Credential, proof: LeaseProof, action: 'heartbeat' | 'checkpoint' | 'submit' | 'accept' | 'return' | 'block',
    evidence?: Evidence, to?: 'owner'
  ): Promise<TaskView> {
    return echoTask(await this.transitionRecord(credential, proof, action, evidence, to));
  }

  private async transitionRecord(
    credential: Credential, proof: LeaseProof, action: 'heartbeat' | 'checkpoint' | 'submit' | 'accept' | 'return' | 'block',
    evidence?: Evidence, to?: 'owner'
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
    let companyUpgrade: CompanyRelease | undefined;
    if (evidence?.companyUpgrade !== undefined) {
      const row = await this.db.select<TaskRow>(id('task', proof.taskId));
      if (!row || actor.role !== 'engineering' || row.state !== 'doing' || !['release','deploy'].includes(row.kind ?? '') ||
          !['submit','block'].includes(action) || row.current_employee !== actor.employeeId || row.delivery_id !== proof.deliveryId ||
          row.fence !== proof.fence || row.version !== proof.expectedVersion || (row.lease_expires_at ?? 0) <= Date.now()/1000)
        throw new CompanyError('forbidden','只有当前工程租约可以登记公司系统上线版本');
      const repo = this.companyReleaseRepo ?? this.worktrees?.options.opsRepo ?? process.env.SCK_AGENT_CWD ?? '/Users/y/IdeaProjects/surreal-ck-operations';
      const project = await this.taskProject(proof.taskId);
      if (!(row.code_repo_path ?? project?.repoPath) || hostIO().fs.realpath((row.code_repo_path ?? project?.repoPath)!) !== hostIO().fs.realpath(repo)) throw new CompanyError('forbidden','此任务不是公司系统仓库的上线任务');
      companyUpgrade = await readCompanyRelease(repo,evidence.companyUpgrade.sha);
    }
    let prHead: string | undefined;
    if (action === 'submit' && evidence?.sha && !evidence.acceptance?.sha) {
      evidence = { ...evidence, acceptance: { ...(evidence.acceptance ?? {}), sha: evidence.sha } };
    }
    if (action === 'submit' && evidence?.next !== undefined) {
      if (!Array.isArray(evidence.next) || evidence.next.length === 0 || evidence.next.length > 20) {
        throw new CompanyError('invalid', 'next must be a non-empty list of at most 20 proposals');
      }
      for (const proposal of evidence.next) {
        const route = await getRoute(this.db, proposal.type);
        if (!route?.enabled) throw new CompanyError('invalid', `proposal type ${proposal.type} is missing or disabled`);
      }
    }
    const noteAction = action === 'submit' || action === 'accept' || action === 'return';
    const learned = noteAction && evidence?.learned !== undefined ? checkLearned(evidence.learned) : undefined;
    if (action === 'submit' && evidence && this.submitCheck) {
      const row = await this.db.select<TaskRow>(id('task', proof.taskId));
      if (row?.executor_role === 'engineering' && row.kind === 'task') {
        const checked = await this.submitCheck({ branch: row.worktree?.branch, text: evidence.text }).catch(() => undefined);
        if (checked?.reason) throw new CompanyError('invalid', `提交被退回（未进入验收）：${checked.reason}`);
        // The PR gate's actual head is authoritative: a declared acceptance head cannot outlive a moved PR head (B2).
        prHead = checked?.head;
      }
    }
    if (action === 'submit' && evidence && this.systemCheck) await this.refuseFailedSystemChecks(proof, actor.employeeId);
    // SYS02 AC03: submit and independent accept call the same evaluator. submit binds the new head; accept signs the human
    // criteria in the transaction that moves the task to done. Missing/untrusted/old-head evidence is refused here.
    let acceptance: { head?: string; environment?: string; human: HumanSignoff[] } | undefined;
    if (action === 'submit' || action === 'accept') {
      const row = await this.db.select<TaskRow>(id('task', proof.taskId));
      if (!row) throw new CompanyError('not_found', 'Task not found');
      const gate = await loadAcceptanceGate(this.db);
      const evidenceRows = await loadAcceptanceEvidence(this.db, proof.taskId);
      const criteria = validateAcceptanceCriteria(row.acceptance_criteria);
      const declaredEnvironment = effectiveEnvironment(criteria, row.acceptance_environment);
      const attempt = action === 'submit' ? (row.acceptance_attempt ?? 0) + 1 : (row.acceptance_attempt ?? 0);
      const gateSubject = acceptanceSubject(row, undefined, { environment: declaredEnvironment, attempt });
      const legacy = isLegacyAcceptance(gateSubject, gate);
      const declared = action === 'submit' ? evidence?.acceptance?.sha : undefined;
      if (action === 'submit' && prHead !== undefined) {
        // The PR gate's actual head is authoritative. A declared head that contradicts it is always refused; a missing
        // declared head is refused only while the gate is on for a non-legacy row. With the gate off, or on a legacy row,
        // the old path is kept: a submit that merely names its PR must not be turned away for a head it never declared.
        if (declared !== undefined && declared !== prHead) {
          throw new CompanyError('conflict', `the submitted acceptance head ${declared} is not the PR head ${prHead}; update the acceptance evidence to the current head`);
        }
        if (declared === undefined && gate.enabled && !legacy) {
          throw new CompanyError('conflict', `the submitted acceptance head is missing; the PR head is ${prHead}; update the acceptance evidence to the current head`);
        }
      }
      const head = action === 'submit' ? (prHead ?? declared) : row.acceptance_head;
      const submittedEnvironment = action === 'submit' ? evidence?.acceptance?.environment : undefined;
      const subject = acceptanceSubject(row, head, { environment: declaredEnvironment, attempt });
      // N1: submit uses this submission's target environment, checked against the controlled declaration. Accept uses the
      // persisted value. Undefined only matches undefined: it is a generic CI fact, never a wildcard for production.
      if (action === 'submit' && !legacy && submittedEnvironment !== declaredEnvironment) {
        throw new CompanyError('invalid',
          `the submitted acceptance environment ${submittedEnvironment ?? 'is missing'} is not the declared environment ${declaredEnvironment ?? 'none'}`);
      }
      // 软件线：按 sha 自动验收证据 — a submitted sha names one or more GitHub Actions runs in the task's code
      // repository. A successful completed run verifies every required machine criterion and records the evidence
      // before the evaluator reads it; no successful run rejects the submit with the reason (retry after CI lands).
      if (action === 'submit' && head !== undefined && criteria.some(c => c.kind === 'machine' && c.required !== false)) {
        const needed = criteria.filter(c => c.kind === 'machine' && c.required !== false &&
          !evidenceRows.some(e => e.acId === c.id && e.sha === head && e.attempt === attempt));
        if (needed.length) {
          const slug = await this.acceptanceRepoSlug(row).catch(() => undefined);
          if (!slug) {
            throw new CompanyError('invalid', `submit sha ${head}: the task's code repository has no GitHub remote; record the acceptance evidence with record_acceptance_evidence or fix the remote`);
          }
          let urls: string[] = [];
          try { urls = await this.acceptanceRuns(slug, head); } catch (error) {
            throw new CompanyError('invalid', `submit sha ${head}: GitHub run lookup failed (${(error as Error).message}); retry after the CI run completes`);
          }
          if (!urls.length) {
            throw new CompanyError('invalid', `submit sha ${head}: no successful completed GitHub Actions run found for this sha in ${slug}; retry after CI completes successfully`);
          }
          let covered = 0; const reasons: string[] = [];
          for (const criterion of needed) {
            let recorded = false;
            for (const runUrl of urls) {
              const verified = await this.acceptanceAdapter.verify({
                provider: 'github-actions', runUrl, sha: head, environment: declaredEnvironment,
                verify: criterion.verify, risk: criterion.risk });
              if (!verified.ok) { reasons.push(`${criterion.id}@${runUrl}: ${verified.reason}`); continue; }
              if (verified.environment !== declaredEnvironment) { reasons.push(`${criterion.id}@${runUrl}: environment ${verified.environment ?? 'unknown'} is not the declared environment ${declaredEnvironment ?? 'none'}`); continue; }
              const gate2 = await loadAcceptanceGate(this.db);
              const rec = await recordAcceptanceEvidenceRow(this.db, {
                taskId: proof.taskId, acId: criterion.id, kind: 'machine', sha: head, environment: verified.environment,
                evidenceType: criterion.evidence, source: verified.source, verifier: 'github-actions', actor: actor.employeeId,
                at: verified.at, criteriaVersion: gate2.criteriaVersion, taskVersion: row.version, attempt });
              await this.db.query(`CREATE audit CONTENT { task: $task, actor: $actor, action: 'acceptance_evidence', evidence: $evidence, at: time::now() };`,
                { task: id('task', proof.taskId), actor: id('employee', actor.employeeId),
                  evidence: JSON.stringify({ acId: criterion.id, sha: head, evidenceType: criterion.evidence, environment: verified.environment, attempt, digest: rec.digest, auto: true }) });
              recorded = true; covered++; break;
            }
            if (!recorded) {
              throw new CompanyError('invalid',
                `submit sha ${head}: no successful run verifies machine criterion ${criterion.id} (${reasons[0] ?? 'no successful completed GitHub Actions run'}); retry after the CI run completes`);
            }
          }
          void covered;
          evidenceRows.splice(0, evidenceRows.length, ...(await loadAcceptanceEvidence(this.db, proof.taskId)));
        }
      }
      const verdict = evaluateAcceptance({
        subject, evidence: evidenceRows,
        phase: action === 'submit' ? 'submit' : 'accept',
        actor: { employeeId: actor.employeeId, role: actor.role ?? '', human: true }, gate,
      });
      if (!verdict.ok) throw acceptanceError(verdict);
      const persistedEnvironment = action === 'submit'
        ? (legacy ? (submittedEnvironment ?? declaredEnvironment) : declaredEnvironment)
        : (row.acceptance_environment ?? declaredEnvironment);
      acceptance = {
        ...(head !== undefined ? { head } : {}),
        ...(persistedEnvironment !== undefined ? { environment: persistedEnvironment } : {}),
        human: action === 'accept' ? humanSignoffs(verdict, proof.taskId, actor.employeeId, row.acceptance_attempt ?? 0) : [],
      };
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
      LET $excluded = SELECT VALUE <string>record::id(actor) FROM audit WHERE task = $task AND action IN ['submit', 'owner_submit'];
      IF $submit OR (($heartbeat OR $checkpoint) AND $t.state != 'review') {
        IF 'execute' NOT IN $who.capabilities OR $t.state != 'doing' OR $t.executor_role != $who.role { THROW 'execute denied' };
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
        };
      };
      IF $checkpoint AND $checkpoint_limit > 0 {
        LET $cpn = SELECT VALUE count() FROM audit WHERE task = $task AND action = 'checkpoint' AND actor = $actor GROUP ALL;
        IF ($cpn[0] ?? 0) >= $checkpoint_limit { THROW 'checkpoint limit reached' };
      };
      LET $next = UPDATE ONLY $task SET
        company_upgrade = IF $has_company_upgrade THEN $company_upgrade ELSE $t.company_upgrade END,
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
        acceptance_head = IF $submit AND $has_head THEN $acceptance_head ELSE $t.acceptance_head END,
        acceptance_environment = IF $submit THEN (IF $has_environment THEN $acceptance_environment ELSE NONE END) ELSE $t.acceptance_environment END,
        acceptance_attempt = IF $submit THEN ($t.acceptance_attempt ?? 0) + 1 ELSE $t.acceptance_attempt END,
        version = IF $heartbeat THEN $t.version ELSE $t.version + 1 END
        RETURN AFTER;
      IF !$heartbeat AND !$checkpoint { UPDATE ONLY $actor SET active_task = NONE };
      IF $accept {
        FOR $e IN $human_evidence {
          CREATE acceptance_evidence CONTENT {
            task: $task, ac_id: $e.acId, kind: 'human', sha: $e.sha, environment: $t.acceptance_environment,
            attempt: $e.attempt,
            evidence_type: 'review-signoff', source: { provider: 'reviewer' }, verified: true, verifier: 'reviewer',
            actor: $employee, at: time::now(), criteria_version: $e.criteriaVersion, task_version: $next.version, digest: $e.digest
          };
        };
        ${ACTIVATE_PLANNED_SQL}
      };
      IF $returning {
        UPDATE lane_note SET state = 'removed', updated_at = time::now() WHERE source_task = $task AND state = 'proposed' AND phase = 'execute';
        LET $sid = SELECT VALUE <string>record::id(id) FROM audit WHERE task = $task AND action = 'submit' ORDER BY at DESC LIMIT 1;
        LET $proposal_rows = SELECT * FROM task WHERE parent = $task AND proposed_in IN ($sid ?? []) AND state = 'planned';
        UPDATE task SET state = 'void', version += 1 WHERE parent = $task AND proposed_in IN ($sid ?? []) AND state = 'planned';
        FOR $c IN $proposal_rows {
          CREATE audit CONTENT { task: $c.id, actor: $actor, action: 'proposal_voided',
            evidence: '提交被退回，提议任务作废', version: $c.version + 1, at: time::now() };
        };
      };
      IF !$heartbeat {
        CREATE ONLY $audit CONTENT { task: $task, actor: $actor, action: $action, evidence: $evidence, version: $next.version, at: time::now(), recovery_reason: $recovery_reason, phase: IF $t.state = 'review' THEN 'review' ELSE 'execute' END };
        LET $sequence = UPDATE ONLY company_meta:outbox_counter SET value += 1 RETURN AFTER;
        CREATE ONLY $outbox CONTENT { task: $task, kind: $action, sequence: $sequence.value, payload: { version: $next.version, state: $next.state }, at: time::now() };
      };
      ${idem ? 'CREATE ONLY $idem CONTENT { at: time::now(), payload_digest: $digest, result: $next };' : ''}
      RETURN $next;
      COMMIT;`;
    const auditId = id('audit', randomUUID());
    try {
      const row = await this.txTask(query, {
        actor: id('employee', actor.employeeId), employee: actor.employeeId,
        task: id('task', proof.taskId), delivery: proof.deliveryId,
        fence: proof.fence, expected: proof.expectedVersion, lease_seconds: this.leaseSeconds,
        ...flags, action, has_company_upgrade: companyUpgrade !== undefined, company_upgrade: companyUpgrade, recovery_reason: undefined, evidence: evidence?.text ?? '', to: to ?? '', checkpoint_limit: this.checkpointLimit,
        acceptance_head: acceptance?.head ?? null, acceptance_environment: acceptance?.environment ?? null,
        has_head: acceptance?.head !== undefined, has_environment: acceptance?.environment !== undefined,
        human_evidence: acceptance?.human ?? [],
        audit: auditId, outbox: id('outbox', randomUUID()), idem, digest,
      });
      const done = view(row);
      if (action === 'submit' && evidence?.next?.length) {
        for (const proposal of evidence.next) {
          await this.createProposal(done, proposal, String(auditId.id));
        }
      }
      // The transition is already committed: a note that cannot be stored must not fail the delivery it rode on.
      if (learned) {
        await new LaneNoteStore(this.db).propose(laneOf((await this.taskProject(proof.taskId))?.id, actor.role), proof.taskId,
          action === 'submit' ? 'execute' : 'review', learned, actor.employeeId, String(auditId.id))
          .catch(error => console.warn(`lane notes for ${proof.taskId} not stored: ${(error as Error).message}`));
      }
      return done;
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
    const task = await this.releaseRecord(credential, proof, evidence);
    return echoTask(task);
  }

  private async releaseRecord(credential: Credential, proof: LeaseProof, evidence: Evidence): Promise<TaskView> {
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
      CREATE ONLY $idem CONTENT { at: time::now(), payload_digest: $digest, result: $next };
      RETURN $next;
      COMMIT;`;
    const auditId = id('audit', randomUUID());
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
   * quiet for owner until that instant, and the employee's provider leaves dispatch until then too.
   *
   * SYS04 AC01/AC02: a block may carry the machine facts of the failure that caused it (`fault`). Those facts are
   * classified and grouped by fingerprint, and the attempt they describe is charged to the recovery budget of the
   * fault object here — not by the employee, and not by a later retry. Without a `fault`, the block is an ordinary
   * block: the employee blocked because it decided to, and no budget is spent.
   */
  async block(credential: Credential, proof: LeaseProof, to: 'owner', evidence: Evidence, quotaResetsAt?: string, fault?: FaultInput): Promise<TaskView> {
    const until = quotaResetsAt === undefined ? undefined : parseQuotaResetsAt(quotaResetsAt, Date.now());
    const actor = await this.authenticate(credential);
    // A structured upgrade is an install request, validated against main and the current lease by transition.
    // Every ordinary block is checked before recording faults, quota gates, audit or changing the task/lease.
    if (evidence.companyUpgrade === undefined) await this.assertCiBlockAllowed(proof, actor.employeeId, [evidence.text]);
    // The fault is recorded before the state change, so a crash between the two leaves the attempt charged (the
    // attempt really happened) rather than a block that no budget accounts for.
    if (fault !== undefined) await this.reportTaskFault(actor.employeeId, proof.taskId, fault);
    const view = await this.transition(credential, proof, 'block', evidence, to);
    await this.recordQuotaGate(credential, proof.taskId, until);
    return view;
  }

  // ---------------------------------------------------------------- SYS05: typed waits

  private async assertCiBlockAllowed(proof: LeaseProof, employeeId: string, causes: string[], background: string[] = [], row?: TaskRow): Promise<void> {
    assertEmployeeCiBlockAllowed(...causes);
    if (!isCiBlockCause(causes)) return;
    const taskId = proof.taskId;
    const task = row ?? await this.db.select<TaskRow>(id('task',taskId));
    // Do not expose source references, or spend GitHub reads, for a foreign/stale lease. The transition owns its error.
    if (!task || task.current_employee !== employeeId || task.delivery_id !== proof.deliveryId ||
        task.fence !== proof.fence || task.version !== proof.expectedVersion || (task.lease_expires_at ?? 0) <= Date.now()/1000) return;
    if (!task?.acceptance_criteria?.some(ac => ac.required && ac.kind === 'machine' && ac.evidence === 'ci-run')) return;
    // Read the task's own sources, not just the employee's latest wording. The CI adapter decides from GitHub.
    const [history] = await this.db.query<[Array<{evidence?: string}>]>(
      "SELECT at,string::slice(evidence ?? '',0,10000) AS evidence FROM audit WHERE task=$task AND action IN ['checkpoint','submit','block','acceptance_evidence'] ORDER BY at DESC LIMIT 5;",
      {task:id('task',taskId)});
    const opsRepo = this.companyReleaseRepo ?? this.worktrees?.options.opsRepo ?? process.env.SCK_AGENT_CWD ?? '/Users/y/IdeaProjects/surreal-ck-operations';
    const repo = task.code_repo_path ?? (task.context?.includes(opsRepo) ? opsRepo : task.worktree?.repo);
    const source = await this.ciBillingCheck({head:task.acceptance_head,repo,
      text:[...causes,...background,...(history ?? []).map(item => item.evidence ?? ''),task.context ?? ''].join('\n')});
    if (source) refuseEmployeeCiBlock(source);
  }

  /**
   * Enter a typed wait. The lease is released and the progress snapshot is stored in the same transaction; the task
   * leaves the dispatch queue with no employee or provider seat attached. Nothing about the condition is released
   * here, and the time condition replaces neither a dependency nor an owner approval.
   */
  private async reportTaskFault(holder: string, taskId: TaskId, input: FaultInput): Promise<FaultReportOutcome> {
    const fault: FaultRecord = classifyFault(input);
    const controlledTarget = input.target ?? 'none';
    const now = this.faultClock();
    const result = await this.faults.report({
      taskId, fault, target: controlledTarget, now, limits: this.faultLimits, holder,
      // The jitter belongs to the budget scope, so every attempt of one scope waits the same reproducible amount.
      jitterFactor: jitterFactorOf(budgetKey(taskId, controlledTarget, input.phase)),
      // A block reports the machine facts of a failure the broker already charged: the cause is recorded, the
      // attempt is not charged twice.
      charge: false,
    });
    return { ...result, fault };
  }

  /**
   * Reserve the next attempt of a fault object before the attempt runs (AC02).
   *
   * This is the half that makes the budget real. The caller asks "may I try this operation once more?", the
   * budget is spent atomically, and only then does the caller run the operation. A caller that loops the same tool
   * — in one session, in a new session, or after a restart — therefore runs out of budget instead of out of
   * patience, and the server is the one that says no.
   *
   * The reservation is keyed by task + controlled target + phase, so it survives a holder change, a rewording of
   * the error and a different spelling of the identity alias.
   */
  async reserveFault(scope: { taskId: TaskId; employeeId?: string }, input: {
    phase: FaultPhase; target?: FaultTargetKind;
  }): Promise<{ allowed: boolean; attempt: number; charged: boolean; reason?: string; message: string; evidence: Record<string, unknown>; refund?: FaultRefund } | undefined> {
    const controlledTarget = input.target ?? 'none';
    const now = this.faultClock();
    // SYS04 AC02: the attempt runs inside the lease, so it may not outlive the lock. The lease window caps the
    // recovery deadline; the budget itself stays persisted, so a re-claimed lease keeps the same counters.
    const task = await this.db.select<{ lease_expires_at?: number }>(id('task', scope.taskId));
    // The lease window is stored in unix seconds; the budget clock is in milliseconds.
    const leaseExpiresAt = task?.lease_expires_at === undefined || task?.lease_expires_at === null
      ? undefined : task.lease_expires_at * 1000;
    const result = await this.faults.reserve({
      taskId: scope.taskId, target: controlledTarget, phase: input.phase, now, limits: this.faultLimits,
      ...(scope.employeeId === undefined ? {} : { holder: scope.employeeId }),
      ...(leaseExpiresAt === undefined || leaseExpiresAt === null ? {} : { leaseExpiresAt }),
      jitterFactor: jitterFactorOf(budgetKey(scope.taskId, controlledTarget, input.phase)),
    });
    if (result.allowed) {
      return {
        allowed: true, attempt: result.attempt, charged: result.charged, message: '',
        evidence: { phase: input.phase, target: controlledTarget, attempt: result.attempt, charged: result.charged },
        ...(result.refund === undefined ? {} : { refund: result.refund }),
      };
    }
    return {
      allowed: false, attempt: result.attempt, charged: false, reason: result.reason,
      message: this.faultRefusalMessage(input.phase, result.reason, result.nextAllowedAt, result.diagnostic),
      evidence: { phase: input.phase, target: controlledTarget, attempt: result.attempt, decision: result.reason ?? 'not_retryable' },
    };
  }

  /** The refusal text of a budget decision. It says what to do next, in fixed words, and never quotes the upstream. */
  private faultRefusalMessage(phase: FaultPhase, reason: string | undefined, nextAllowedAt: number | undefined,
    diagnostic: FaultDiagnostic | undefined): string {
    const text = reason === 'attempts_exhausted'
      ? 'the recovery budget for this operation is spent'
      : reason === 'deadline_passed'
        ? 'the recovery deadline for this operation has passed'
        : reason === 'min_interval'
          ? `the next attempt is allowed after ${new Date(nextAllowedAt ?? 0).toISOString()}`
          : reason === 'lease_expired'
            ? 'the task lease ended before the next attempt; claim the task again to continue'
            : 'this failure is not retryable';
    const guidance = diagnostic?.guidance
      ?? 'Read the failure facts and fix the cause before repeating the call.';
    return `operation refused (${phase}): ${text}. ${guidance}`;
  }

  /**
   * Settle a successful attempt of a fault object (AC02).
   *
   * A call that works costs no recovery budget: the reserved attempt is refunded and the recovery is over, so the
   * next failure starts a fresh one with a fresh deadline. The cumulative count stays in the ledger for the audit.
   */
  async settleFault(scope: { taskId: TaskId; employeeId?: string }, input: { phase: FaultPhase; target?: FaultTargetKind }): Promise<void> {
    const key = budgetKey(scope.taskId, input.target ?? 'none', input.phase);
    await this.faults.settle(key, this.faultClock());
  }

  /**
   * Refund a reservation whose call never ran (for example a chain/budget refusal before the upstream call).
   *
   * This is deliberately not `settleFault`: a real success clears the recovery, while a refund only undoes the
   * attempt this reservation charged. The store's CAS keeps the earlier failure facts and refuses to overwrite a
   * newer failure, stop, lift or success that landed in between.
   */
  async refundFault(scope: { taskId: TaskId; employeeId?: string }, input: {
    phase: FaultPhase; target?: FaultTargetKind; refund: FaultRefund;
  }): Promise<{ refunded: boolean }> {
    const key = budgetKey(scope.taskId, input.target ?? 'none', input.phase);
    if (input.refund.key !== key || input.refund.taskId !== scope.taskId) {
      throw new CompanyError('invalid', 'refund does not belong to this fault object');
    }
    return { refunded: await this.faults.refund(input.refund) === 'refunded' };
  }

  /**
   * Report one failure from the ops broker and record it against the fault object.
   *
   * The broker is the place where the machine facts of a failure are known (the phase, the identity alias, the
   * transport errno, the HTTP status), so it is where the fault is classified. The core owns the budget, so the
   * same rules apply no matter which employee, session or process made the call.
   *
   * A failure that is not retryable (a 403, a rejected password, a revoked permission, an invalid input) stops the
   * recovery at once and says what to fix. It is never retried for the employee, and it is never reported as a
   * network problem.
   */
  async reportFault(scope: { taskId: TaskId; employeeId?: string }, input: {
    tool: string; phase: FaultPhase; stage?: FlowStage; errno?: string; status?: number; name?: string; alias?: string; elapsedMs?: number;
    target?: FaultTargetKind; environment?: string; message?: string; idempotent?: boolean; requestSent?: boolean;
    /** The attempt number the caller already reserved; the report must not charge it twice. */
    attempt?: number;
    /** False when the report only carries facts of a failure that was already charged. */
    charge?: boolean;
  }): Promise<{ allowed: boolean; message: string; evidence: Record<string, unknown> } | undefined> {
    const fault = classifyFault({
      phase: input.phase,
      ...(input.errno === undefined ? {} : { errno: input.errno }),
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.stage === undefined ? {} : { stage: input.stage }),
      elapsedMs: input.elapsedMs ?? 0,
      ...(input.alias === undefined ? {} : { identityAlias: input.alias }),
      ...(input.target === undefined ? {} : { target: input.target }),
      ...(input.environment === undefined ? {} : { environment: input.environment }),
      ...(input.idempotent === undefined ? {} : { idempotent: input.idempotent }),
      ...(input.requestSent === undefined ? {} : { requestSent: input.requestSent }),
    });
    const now = this.faultClock();
    const result = await this.faults.report({
      taskId: scope.taskId, fault, target: input.target ?? 'none', now, limits: this.faultLimits,
      ...(scope.employeeId === undefined ? {} : { holder: scope.employeeId }),
      jitterFactor: jitterFactorOf(budgetKey(scope.taskId, input.target ?? 'none', fault.phase)),
      ...(input.attempt === undefined ? {} : { attempt: input.attempt }),
      ...(input.charge === undefined ? {} : { charge: input.charge }),
    });
    if (result.decision.allowed) {
      return { allowed: true, message: '', evidence: faultEvidence(fault) };
    }
    // The refusal says what to do next, in fixed words: the diagnosis never quotes the upstream message.
    return {
      allowed: false,
      message: this.faultRefusalMessage(fault.phase, result.decision.reason, result.decision.nextAllowedAt, result.diagnostic),
      evidence: { ...faultEvidence(fault), decision: result.decision.reason ?? 'not_retryable' },
    };
  }

  /**
   * Read-only diagnosis of a task's recovery budget. Readable by the task holder, its reviewer, or owner.
   * Secret-free: no upstream bodies, no credentials, no aliases beyond what the ledger already stored.
   */
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

  /**
   * owner: run ownership reclaim (or dry-run) across registered repos. Uses the same lock and audit path as the dispatcher sweep.
   * Order: the credential, then the arguments (parseReclaimInput, SYS01 D3), then the owner role. The arguments come before the role,
   * as on MCP and the sidecar, so a malformed call gets the same invalid refusal from any caller. A bad argument never reaches
   * reclaimAll, so no tree is touched.
   */
  async reclaimWorktrees(credential: Credential, input?: { dryRun?: boolean; repos?: string[] }) {
    const actor = await this.authorized(credential);
    const params = parseReclaimInput(input);
    if (actor.role !== 'owner') throw new CompanyError('forbidden', 'Worktree reclaim requires owner');
    if (!this.worktrees) return { scanId: '', removed: [], kept: [], branchesDeleted: [], branchesRetained: [], audited: 0 };
    return this.worktrees.reclaimAll({ trigger: params.dryRun ? 'dry_run' : 'manual', dryRun: params.dryRun, repos: params.repos });
  }

  async listWorktreeAudits(credential: Credential, limit = 100) {
    const actor = await this.authorized(credential);
    if (actor.role !== 'owner') throw new CompanyError('forbidden', 'Worktree audit query requires owner');
    return this.worktrees?.listAudits(limit) ?? [];
  }



  async resume(credential: Credential, taskId: TaskId, evidence: Evidence): Promise<TaskView> {
    return echoTask(await this.resumeRecord(credential, taskId, evidence));
  }

  private async resumeRecord(credential: Credential, taskId: TaskId, evidence: Evidence,
    options: { businessScope?: boolean } = {}): Promise<TaskView> {
    const actor = await this.authorized(credential, 'manage');
    if (actor.role !== 'owner') throw new CompanyError('forbidden', 'Only owner can resume');
    requireText(evidence.text, 'evidence', 20, 30000);
    const idem = options.businessScope
      ? this.businessIdemId('resume', evidence.idempotencyKey)
      : this.idemId(actor.employeeId, 'resume', evidence.idempotencyKey);
    const digest = HASH(JSON.stringify({ taskId, evidence }));
    const replay = await this.replay(idem, digest);
    if (replay) return replay;
    const before = await this.db.select<TaskRow>(id('task', taskId));
    if (!before) throw new CompanyError('not_found', 'Task not found');
    try {
      const row = await this.txTask(`BEGIN;
        LET $who = SELECT * FROM ONLY $actor;
        LET $t = SELECT * FROM ONLY $task;
        IF $who.revoked = true OR $who.role != 'owner' OR $t = NONE OR $t.state != 'blocked' { THROW 'resume denied' };
        IF $t.version != $expected_version { THROW 'task version moved' };
        LET $restore_phase = $t.resume_state ?? 'ready';
        LET $next = UPDATE ONLY $task SET
          state = IF $restore_phase = 'doing' THEN 'ready' ELSE $restore_phase END,
          resume_role = NONE, resume_state = NONE, blocked_to = NONE,
          version += 1 RETURN AFTER;
        CREATE ONLY $audit CONTENT { task: $task, actor: $actor, action: 'resume', evidence: $evidence, version: $next.version, at: time::now(),
          result: $next.state };
        LET $sequence = UPDATE ONLY company_meta:outbox_counter SET value += 1 RETURN AFTER;
        CREATE ONLY $outbox CONTENT { task: $task, kind: 'resumed', sequence: $sequence.value,
          payload: { state: $next.state }, at: time::now() };
        CREATE ONLY $idem CONTENT { at: time::now(), payload_digest: $digest, result: $next };
        RETURN $next;
        COMMIT;`, {
        actor: id('employee', actor.employeeId), task: id('task', taskId), evidence: evidence.text,
        expected_version: before.version,
        audit: id('audit', randomUUID()), outbox: id('outbox', randomUUID()),
        idem, digest,
      });
      return view(row);
    } catch (error) {
      const replayed = await this.replay(idem, digest);
      if (replayed) return replayed;
      throw error;
    }
  }
  /**
   * owner/product only: retire a task to the terminal 'void' state. Duplicate or obsolete work
   * (e.g. two owners decomposing the same work into parallel chains) stops occupying the
   * graph: any live lease is released, the holder's active_task clears, and blocked
   * dependents re-evaluate with 'void' counted as satisfied, so a chain waiting only on the
   * retired task unlocks in the same transaction. Retiring an already-void task is a no-op
   * returning the current view; 'done' tasks refuse (their audit trail stands).
   */
  async retireTask(credential: Credential, input: RetireTask): Promise<TaskView> {
    return echoTask(await this.retireTaskRecord(credential, input));
  }

  private async retireTaskRecord(credential: Credential, input: RetireTask,
    options: { businessScope?: boolean } = {}): Promise<TaskView> {
    const actor = await this.authorized(credential, 'manage');
    if (actor.role !== 'owner') throw new CompanyError('forbidden', 'Only the owner may retire tasks');
    requireText(input.taskId, 'task', 1, 200);
    requireText(input.text, 'text', 4, 8000);
    requireText(input.idempotencyKey, 'idempotencyKey', 1, 200);
    if (input.expectedVersion !== undefined && !Number.isSafeInteger(input.expectedVersion)) {
      throw new CompanyError('invalid', 'Invalid expectedVersion');
    }
    // SYS03 AC02/AC05（QA V4）：处置驱动的 retire 幂等身份按业务键算，理由同 resume/defer。
    const idem = options.businessScope
      ? this.businessIdemId('retire', input.idempotencyKey)
      : this.idemId(actor.employeeId, 'retire', input.idempotencyKey);
    const digest = HASH(JSON.stringify({ taskId: input.taskId, text: input.text, expectedVersion: input.expectedVersion }));
    const replayed = await this.replay(idem, digest);
    if (replayed) return replayed;

    // Pre-read for a readable fast-fail and the audit snapshot; the transaction re-checks
    // every guard atomically, so a stale pre-read can never turn into a wrong write.
    const before = await this.db.select<TaskRow>(id('task', input.taskId));
    const descendants = await this.plannedDescendants(input.taskId);
    if (!before) throw new CompanyError('not_found', 'Task not found');
    if (before.state === 'done') throw new CompanyError('conflict', 'Cannot retire a finished task');
    if (input.expectedVersion !== undefined && before.version !== input.expectedVersion) {
      throw new CompanyError('conflict', 'Task version moved');
    }
    if (before.state === 'void') return view(before); // already terminal, idempotent no-op

    const evidence = `${input.text}\n[retire] 作废前 state=${before.state}` +
      ` blocked_to=${before.blocked_to ?? '-'} holder=${before.current_employee ?? '-'} version=${before.version}`;

    let row: TaskRow;
    try {
      row = await this.txTask(`BEGIN;
      LET $who = SELECT * FROM ONLY $actor;
      LET $t = SELECT * FROM ONLY $task;
      IF $who = NONE OR $who.revoked = true OR 'manage' NOT IN $who.capabilities OR $who.role != 'owner' { THROW 'retire denied' };
      IF $t = NONE { THROW 'task not found' };
      IF $t.state IN ['done', 'void'] { THROW 'task already terminal' };
      IF $expected != NONE AND $t.version != $expected { THROW 'task version moved' };
      LET $next = UPDATE ONLY $task SET
        state = 'void', blocked_to = NONE, resume_role = NONE, resume_state = NONE,
        current_employee = NONE, delivery_id = NONE, lease_expires_at = NONE,
        version = $t.version + 1 RETURN AFTER;
      FOR $cid IN $descendants {
        UPDATE type::record('task', $cid) SET state = 'void', version += 1;
        CREATE audit CONTENT { task: type::record('task', $cid), actor: $actor, action: 'planned_voided',
          evidence: '父任务作废，计划任务级联作废', version: (SELECT VALUE version FROM ONLY type::record('task', $cid)), at: time::now() };
      };
      UPDATE employee SET active_task = NONE WHERE active_task = $task;
      CREATE ONLY $audit CONTENT { task: $task, actor: $actor, action: 'retire', evidence: $evidence, version: $next.version, at: time::now() };
      LET $sequence = UPDATE ONLY company_meta:outbox_counter SET value += 1 RETURN AFTER;
      CREATE ONLY $outbox CONTENT { task: $task, kind: 'retired', sequence: $sequence.value, payload: { state: 'void', retired_holder: $holder }, at: time::now() };
      CREATE ONLY $idem CONTENT { at: time::now(), payload_digest: $digest, result: $next };
      RETURN $next;
      COMMIT;`, {
        actor: id('employee', actor.employeeId), task: id('task', input.taskId),
        expected: input.expectedVersion, evidence, holder: before.current_employee,
        descendants,
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

  // ------------------------------------------------------------------ SYS03 老板处置账本
  // 老板对一个 blocking episode 的处置走这一组方法：先认领（episode 唯一、租约、版本），再带 CAS 与全局业务
  // 幂等键决定，最后由持久 outbox 通知当前持有人。授权与既有通道同源：角色与能力仍由本类判定，处置动作本身
  // 复用 resume/defer/retire/create 的既有状态机，不新增任何旁路写权。

  /**
   * The episode a task is currently blocked in must be the one being claimed: the owner may not claim, and therefore
   * decide, an episode the task is no longer in. A task carries its open episode as phase + start (unix seconds); a
   * task without one (never blocked, or already resumed) refuses every claim, which is how a late reminder to a
   * decided episode is turned away.
   */
  async taskProjectUpdate(credential: Credential, input: { taskId: TaskId; project: string; expectedVersion: number; text: string; idempotencyKey: string }): Promise<TaskView> {
    return echoTask(await this.taskProjectUpdateRecord(credential, input));
  }

  private async taskProjectUpdateRecord(credential: Credential, input: { taskId: TaskId; project: string; expectedVersion: number; text: string; idempotencyKey: string }): Promise<TaskView> {
    const actor = await this.authorized(credential, 'manage');
    if (actor.role !== 'owner') throw new CompanyError('forbidden', 'Only owner may rebind task projects');
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
        CREATE ONLY $idem CONTENT { at: time::now(), payload_digest: $digest, result: $next };
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
   * owner only: turn a blocked read-only engineering task into a code task in place (read → code, optional lane), instead of
   * retiring it and creating a sibling code task. Allowed on the same execute-phase blocks bind_task_code_repo accepts
   * (owner gates, review-phase blocks and live leases refuse); kind=task only, so the release leg stays a read leg.
   * Write authority is re-judged under the task's own policy chain, the implement-leg baseline criteria are merged when
   * the acceptance gate is on, and the read assignment is cleared so the next claim allocates an exclusive code tree.
   */
  async modelEvidence(credential: Credential, taskId: TaskId): Promise<ModelEvidence[]> {
    const actor = await this.authorized(credential);
    if (!['eval','owner'].includes(actor.role)) throw new CompanyError('forbidden','Only eval or owner may read model evaluation evidence');
    if (!await this.db.select(id('task', taskId))) throw new CompanyError('not_found', 'Task not found');
    // The same rows collectEvalState validates against, read alone: the full eval state rebuilt the whole timeline per call.
    const [rows] = await this.db.query<[NonNullable<Parameters<typeof summarizeModelEvidence>[0]>]>(
      "SELECT employee,model,fence,phase,<string>at AS at FROM model_execution WHERE task=$task AND completed=true AND status>=200 AND status<300 AND phase!='auxiliary' AND employee!=$actor;",
      { task: id('task', taskId), actor: actor.employeeId });
    return summarizeModelEvidence(rows ?? []);
  }

  async taskCost(credential: Credential, taskId: TaskId): Promise<TaskCost | { taskId: TaskId; available: false; reason: string }> {
    const actor = await this.authorized(credential);
    if (!['eval', 'owner'].includes(actor.role)) throw new CompanyError('forbidden', 'Only eval or owner may read task cost');
    requireText(taskId, 'task', 1, 200);
    const row = await this.db.select<TaskRow>(id('task', taskId));
    if (!row) throw new CompanyError('not_found', 'Task not found');
    const cost = await readTaskCost(this.db, taskId) ?? (row.state === 'done' ? await recordTaskCost(this.db, taskId) : undefined);
    return cost ?? { taskId, available: false, reason: row.state === 'done' ? '没有该任务的租约模型请求记录，或 Magpie 用量暂不可读' : '任务未完成，完成后结算成本' };
  }

  async recordScore(credential: Credential, input: { taskId: TaskId; summary: string; scores: EmployeeScore[]; complexity?: number }): Promise<{ recorded: number; participants: string[] }> {
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

    if (input.complexity !== undefined && (!Number.isFinite(input.complexity) || input.complexity < 1 || input.complexity > 5)) {
      throw new CompanyError('invalid', 'complexity must be 1-5');
    }
    return writeScorecards(this.db, {
      taskId: input.taskId, summary: input.summary, judge: actor.employeeId, judgeKind: 'llm',
      scores: input.scores, state, ...(input.complexity !== undefined ? { complexity: input.complexity } : {}),
    });
  }

  async listOutbox(credential: Credential, after?: string): Promise<OutboxEvent[]> {
    const actor = await this.authorized(credential, 'manage');
    if (actor.role !== 'owner') throw new CompanyError('forbidden', 'Outbox access denied');
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
