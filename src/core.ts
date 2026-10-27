import { readCompanyRelease, type CompanyRelease } from './company-release.ts';
import { parseExecutionWindow, windowExpired, recoveryReasonSchema } from './task-recovery.ts';
import { workspaceScopeFor } from './goal-workspace-capability.ts';
import { authenticationLookup } from './diagnostics.ts';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { RecordId, type Surreal } from 'surrealdb';
import type { CompanyDatabase } from './database.ts';
import type { ActiveLease, ClaimResult, CompanyBrief, CompanyCore, CreateDelivery, CreateTask, Credential, DefView, DeferTaskUntil, TaskWaiting, EnsureDef, GoalAcceptancePreview, GoalAcceptanceRepair, GoalAcceptanceResult, GoalAcceptanceTask, GoalAcceptanceView, GoalTier, ProjectView, EmployeeScore, Evidence, GoalView, HistoryEntry, LeaseProof, OpsScope, OutboxEvent, ImplementerTakeover, IndependencePolicy, IndependenceStage, IndependenceCheckInput, IndependenceCheckView, IndependenceCheckPolicyView, OwnerDecisionInput, Principal, RetireTask, ReviewerRole, Role, SessionRef, TaskId, TaskKind, TaskState, TaskView, SetIndependence, SetIdentityPrincipal, IdentityPrincipalView, FaultStatusView, FaultBudgetView, FaultEpisodeView, FaultRepairView } from './contracts.ts';
import { OwnerDesk } from './owner.ts';
import { deliveryChain } from './flows.ts';
import { assertRoleContract, loadContract, type DisciplineContract } from './role-contract.ts';
import type { SubmitCheck } from './pr-gate.ts';
import { ProjectStore } from './projects.ts';
import { collectEvalState, summarizeModelEvidence, validateScores, writeScorecards, type ModelEvidence } from './scoring.ts';
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
import type { PolicyEffectiveInput, PolicyEffectiveView, PolicyEnforceInput, PolicyEnforceView, PolicyListInput, PolicyPlanInput, PolicyPlanPage, PolicyPlanView, PolicyRevoke, PolicySet, PolicyView, ReviewerRole as PolicyReviewerRole } from './contracts.ts';
import type { AdminSummary, CompanyPart, ContextView, HistoryPageView, PageInfo, ReferencesCut, TaskTextSegment, WorktreePageView, WorktreeRefsSegment } from './contracts.ts';
import type { QaObservationAuth, QaObservationGrant, QaObservationLoginView, QaObservationMeta, QaObservationReadInput, QaObservationReadView, QaObservationRevoke, QaObservationScopeView, QaObservationSessionView, QaObservationTextSegment, QaObservationTimelineView } from './contracts.ts';
import { CLEANUP_BUDGET_MS, SnapshotStore, type SnapshotBuildStats, type SnapshotHeader, type SnapshotKind, type SnapshotLimits, untilAt } from './snapshot-store.ts';
import { arrivedAt } from './reply-clock.ts';
import type { EmployeeDef, Workforce } from './workforce.ts';
import { CONTRIBUTION_MOVED, isContributionMoved, openLeaseOf, proposeImplementer, readAuditTimelineWindow, readContributionView, type ContributionView } from './contributors.ts';
import { checkIndependence, INDEPENDENCE_LIMITS, normalizeIndependence, policyFault, readEmployeePrincipals, readIndependenceSnapshot, refuseIfExcluded, type IndependenceIndex } from './independence.ts';
import {
  POLICY_DOMAINS, POLICY_ID_PATTERN, POLICY_SCOPES, POLICY_SOURCES, checkGateCreation, checkWriteAuthority, contractDiff,
  dispatchVerdict, domainOfPayload, domainPayload, normalizePayload, policyActiveAt, policyHash, renderContract, resolveEffective,
  checkToolScope, policyView as policyApiView, type EffectiveContract, type PolicyDomain, type PolicyRow, type PolicyScope, type PolicyScopeLink, type PolicyStatus, type PolicyVerdict,
} from './policy.ts';
import { chainOfTaskRow, policyRowView, policyScopeChain, readEffectiveContract, readPolicyEpoch, readPolicyRows, readTaskPolicyRow, registeredDomainsOf, scanInFlightTasks, type PolicyDbRow } from './policy-store.ts';
import { FaultStore, type FaultReportResult, type FaultReserveResult } from './fault-store.ts';
import {
  DEFAULT_FAULT_BUDGET, budgetKey, classifyFault, faultEvidence, jitterFactorOf, type FaultBudgetLimits,
  type FaultDiagnostic, type FaultInput, type FaultPhase, type FaultRecord, type FaultTargetKind, type FlowStage,
} from './faults.ts';
import { WaitStore, waitRecordOf, type WaitRow } from './wait-store.ts';
import { GoalGovernanceStore } from './goal-store.ts';
import type { GoalFinalGateRepairResult, GoalOutcomeView, GoalPageView, GoalScanQuery, GoalScanView, GoalFinalGatePreview } from './goal-store.ts';
import type { GoalCard, GoalEvidenceFact } from './goal-governance.ts';
import { segmentGoalMetrics, type GoalMetricsAnswer, type GoalMetricsView } from './goal-metrics.ts';
import {
  assertNonSensitive, isTimeZone, migrationPreview, normalizeWait, parseInstant, validateEvent, verifyWaitWebhook,
  waitEventKey, waitKeyOf, webhookPayload, type WaitEvent, type WaitHandoffCard, type WaitInput,
} from './waits.ts';
import type {
  GoalConsoleQuery, GoalEvidenceRecordInput, GoalFinalGatePreviewInput, GoalFinalGateRepairRequest,
  GoalFinalizeInput, GoalMetricsQuery, GoalOutcomeRegisterInput,
  TaskWaitView, WaitActionInput, WaitActionView, WaitEntryInput, WaitListView, WaitMigrationApplyInput,
  WaitMigrationPreviewView, WaitResolveInput, WaitResolveView,
} from './contracts.ts';

/** The outcome of a fault report, as the core sees it: the classification plus what the budget decided. */
type FaultReportOutcome = FaultReportResult;
import type { ContributorDryRunView, PluginRuntimeView } from './contracts.ts';
import { PLUGIN_RUNTIME_ROLES } from './contracts.ts';
import { QA_OBSERVATION_CODE_TTL_MS, QA_OBSERVATION_CONTEXT_INLINE_BYTES, QA_OBSERVATION_MAX_SUBJECTS, QA_OBSERVATION_MAX_TTL_MS, QA_OBSERVATION_MIN_TTL_MS, QA_OBSERVATION_TOKEN_TTL_MS, QA_OBSERVATION_WAIT_RELEASE_RESERVE_BYTES, QA_OBSERVATION_WAIT_ROOTS_LIMIT, fitGoalWaitSummary, qaDispatchFor, qaDispatchState, qaHash, qaId, qaScopeView, type QaObservationScopeRow, type QaObservationSessionRow } from './qa-observation.ts';

import { CompanyError } from './core-errors.ts';
import { DispositionLedger, type DispositionApplier, type DispositionClaimInput, type DispositionClaimOutcome, type DispositionClaimView, type DispositionDecideInput, type DispositionDecideOutcome, type DispositionPhase, type DispositionStatusInput, type DispositionStatusView, type ExternalActionRequestInput, type ExternalActionView, type HolderNoticeView, type ExternalActionGateway } from './disposition.ts';
import { createCompanyGithubGateway, githubRepoSlug } from './external-actions.ts';
import { validateExternalDependencies } from './input-bounds.ts';
import { WorktreeRegistry, validateIntent, type RegistryOptions } from './dispatcher/worktree-registry.ts';
import { goalRootBlockers, type DispatchVerdict, type GoalRootFacts, type GoalRootPeople, type GoalWorkflowWaitSummary } from './dispatcher/dispatch-blocked.ts';
import { readGoalWorkflowWaitSnapshot } from './dispatcher/goal-roots.ts';
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
  LET $children = SELECT * FROM task WHERE state = 'blocked' AND blocked_to = NONE AND wait_state != 'waiting' AND array::len(array::filter(dependencies ?? [], |$d| $d IN $task_chain)) > 0;
  FOR $child IN $children {
    ${RESOLVE_DEP_SQL('$child.dependencies', '$c_dep')}
    LET $remaining = SELECT * FROM task WHERE id IN $c_dep_resolved AND ${depUnsatisfiedFor('$child')};
    IF array::len($remaining) = 0 {
      LET $source_phase = $child.resume_state ?? 'ready';
      LET $manager = $child.dependency_continuation = 'manager';
      LET $restore_phase = IF $source_phase = 'review' THEN 'review' ELSE 'ready' END;
      LET $unlocked = UPDATE ONLY $child.id SET
        state = IF $manager THEN 'blocked' ELSE $restore_phase END, version += 1,
        blocked_to = IF $manager THEN 'gm' ELSE NONE END,
        resume_state = IF $manager THEN $source_phase ELSE NONE END,
        resume_role = IF $manager THEN $child.resume_role ELSE NONE END,
        dependency_continuation = NONE,
        current_employee = NONE, delivery_id = NONE, lease_expires_at = NONE;
      CREATE audit CONTENT { task: $child.id, actor: $actor, action: 'dependency_unlocked',
        evidence: '依赖全部完成，按原阻塞阶段恢复', version: $unlocked.version, at: time::now(),
        source_phase: $source_phase, restore_phase: $restore_phase,
        dependencies_before: $child.dependencies ?? [], dependencies_after: $child.dependencies ?? [] };
      LET $sequence = UPDATE ONLY company_meta:outbox_counter SET value += 1 RETURN AFTER;
      CREATE outbox CONTENT { task: $child.id, kind: 'dependency_unlocked', sequence: $sequence.value,
        payload: { state: $unlocked.state, source_phase: $source_phase, restore_phase: $restore_phase,
          dependencies: $child.dependencies ?? [], version: $unlocked.version }, at: time::now() };
    };
  };
`;

/**
 * Unlocks blocked children of $task whose dependencies are all finished. Goal closure is deliberately NOT a SQL
 * side effect of any accepted task: SYS07 re-evaluates the final gate and the outcome evidence in
 * GoalGovernanceStore.finalize, so a void gate, a superseded revision or a missing customer receipt can never
 * close a goal. Requires $task and $actor in scope.
 */
export const UNLOCK_SQL = UNLOCK_CHILDREN_SQL;

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

export interface TaskRow {
  company_upgrade?: CompanyRelease;
  recovery_stopped?: boolean;
  dependency_continuation?: 'execute' | 'manager';
  execution_window?: import('./task-recovery.ts').ExecutionWindow;
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
  model_tier?: 'fable' | 'opus' | 'sonnet' | 'haiku' | 'high' | 'medium' | 'low';
  model_route_until?:number;
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
  /** SYS05: the open typed wait (schemaless task fields, written only by WaitStore.enter). */
  wait_state?: 'waiting' | null;
  wait_kind?: string | null;
  wait_episode?: string | null;
  wait_not_before?: number | null;
  wait_expires_at?: number | null;
  wait_next_check_at?: number | null;
  wait_owner_role?: string | null;
  wait_source?: string | null;
  wait_version?: number | null;
  wait_entered_at?: unknown;
  evaluated_at?: string;
  model_eval_full_history?: boolean;
  eval_via?: string;
  eval_attempts?: number;
  jev_release_version?: number;
  jev_route_version?: number;
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
  goal_tier?: string;
  goal_title?: string;
  /** Screenplay-revision edge fields (schema 015): see RESOLVE_DEP_SQL. */
  revises?: RecordId;
  superseded_by?: RecordId;
  lineage?: RecordId;
  revision_no?: number;
  /** Independence policy (schema 023, SYS-DISP IR01): written only by setIndependence, read with the contribution facts. */
  independence?: IndependenceRow | null;
  /** Version this task was last checked against as a source of a dependent's gated write (schema 023). */
  independence_guard?: number | null;
  /** 有效策略层的契约登记（schema 034）：创建时与每次 claim 时写入，策略变了以后两者不等即拒绝继续写。 */
  policy_version?: number | null;
  policy_hash?: string | null;
  policy_contract?: EffectiveContract | null;
  lease_policy_version?: number | null;
  lease_policy_hash?: string | null;
  policy_block_reason?: string | null;
  /** 连接读法的投影（goal.project），只在带该投影的查询里出现。 */
  goal_project?: RecordId;
}

/** policy 表的一行（snake_case），只在 core 内部出现；对外的形状是 PolicyRow。 */

/** A stored policy: the API shape, with `setAt` as the driver returns it (a Date, or a string in tests). */
type IndependenceRow = Omit<IndependencePolicy, 'setAt'> & { setAt: Date | string };

/** Compact row for the complete active-lease lookup; keeps task context text out of the recovery path. */
interface ActiveLeaseRow {
  id: RecordId;
  state: TaskState;
  executor_role: Role;
  reviewer_role: ReviewerRole;
  submitted_by?: string;
  implementer?: string;
  current_employee?: string;
  delivery_id?: string;
  lease_expires_at?: number;
  fence: number;
  version: number;
}
export interface IdempotencyRow { payload_digest: string; result: TaskRow }

/** The policy as the API states it: `setAt` as an ISO timestamp, whatever the driver returned. */
function policyView(policy: IndependenceRow): IndependencePolicy {
  return { ...policy, setAt: policy.setAt instanceof Date ? policy.setAt.toISOString() : String(policy.setAt) };
}

/** A principal as the API states it, whatever the driver returned for `setAt`. */
function principalView(principalId: string, employees: readonly string[], reason: string, setBy: string,
  setAt: Date | string | undefined): IdentityPrincipalView {
  return { id: principalId, employees: [...employees], reason, setBy,
    setAt: setAt instanceof Date ? setAt.toISOString() : String(setAt ?? '') };
}

/**
 * Why a blocked row waits, in terms every view can show (RW06 C3 / RW05). The facts are the row's own: `blocked_to` names a
 * manager or owner gate; a dependency wait carries the phase to restore and, for a review wait, the reviewer role. A review-phase
 * wait never falls back to the execute role when `resume_role` is empty — it names the reviewer role, and a row with no phase
 * fact is `unknown` rather than an implied execute wait.
 */
export function waitingOf(row: Pick<TaskRow, 'state' | 'blocked_to' | 'resume_state' | 'resume_role' | 'reviewer_role' | 'executor_role' | 'dependencies'>): TaskWaiting | undefined {
  if (row.state !== 'blocked') return undefined;
  const resumeState = row.resume_state ?? 'unknown';
  const role: TaskWaiting['role'] = row.blocked_to === 'owner' ? 'owner'
    : row.resume_role ? (row.resume_role as Role)
      : resumeState === 'review' ? row.reviewer_role
        : (resumeState === 'ready' || resumeState === 'doing') ? row.executor_role
          : 'unknown';
  const kind: TaskWaiting['kind'] = row.blocked_to === 'gm' ? 'manager' : row.blocked_to === 'owner' ? 'owner' : 'dependency';
  return { kind, resumeState, role, dependenciesCount: (row.dependencies ?? []).length };
}

export function view(row: TaskRow): TaskView {
  return {
    id: asId(row.id), title: row.title, context: row.context, state: row.state,
    executionWindow: row.execution_window ?? undefined, dependencyContinuation: row.dependency_continuation ?? undefined,
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
    companyUpgrade: row.company_upgrade ?? undefined,
    resumeState: row.state === 'blocked' ? row.resume_state : undefined,
    resumeRole: row.state === 'blocked' ? row.resume_role : undefined,
    waiting: waitingOf(row),
    wait: row.wait_state === 'waiting' && row.wait_episode ? {
      waitKey: row.wait_episode,
      kind: (row.wait_kind ?? 'time') as NonNullable<TaskView['wait']>['kind'],
      state: 'waiting',
      ownerRole: row.wait_owner_role ?? 'unknown',
      source: (row.wait_source ?? 'time') as NonNullable<TaskView['wait']>['source'],
      ...(row.wait_not_before === undefined || row.wait_not_before === null ? {} : { notBefore: new Date(row.wait_not_before).toISOString() }),
      ...(row.wait_expires_at === undefined || row.wait_expires_at === null ? {} : { expiresAt: new Date(row.wait_expires_at).toISOString() }),
      expiresSource: row.wait_expires_at === undefined || row.wait_expires_at === null ? 'unknown' : 'exact',
      ...(row.wait_next_check_at === undefined || row.wait_next_check_at === null ? {} : { nextCheckAt: new Date(row.wait_next_check_at).toISOString() }),
      version: row.wait_version ?? 1,
    } : undefined,
    handover: row.handover || undefined,
    previousEmployee: row.previous_employee,
    implementer: row.implementer ?? undefined,
    independence: row.independence ? policyView(row.independence) : undefined,
    modelTier: row.model_tier,
    workIntent: row.work_intent, worktree: row.worktree,
    revises: row.revises ? asId(row.revises) : undefined,
    supersededBy: row.superseded_by ? asId(row.superseded_by) : undefined,
    lineage: row.lineage ? asId(row.lineage) : undefined,
    revisionNo: row.revision_no ?? undefined,
    acceptanceCriteria: row.acceptance_criteria ?? undefined,
    acceptanceVersion: row.acceptance_version ?? undefined,
    acceptanceLegacy: row.acceptance_legacy ?? undefined,
    acceptanceHead: row.acceptance_head ?? undefined,
    acceptanceEnvironment: row.acceptance_environment ?? undefined,
    acceptanceAttempt: row.acceptance_attempt ?? undefined,
    acceptanceChain: row.acceptance_chain ?? undefined,
    policyVersion: row.policy_version ?? undefined,
    policyHash: row.policy_hash ?? undefined,
    policyContract: row.policy_contract ?? undefined,
    leasePolicyVersion: row.lease_policy_version ?? undefined,
    leasePolicyHash: row.lease_policy_hash ?? undefined,
    policyBlockReason: row.policy_block_reason ?? undefined,
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
/** Which projects' environments one reader may see in a company block (SYS01 M3). `key` names that view, so a stored listing is read only under the same one. */
interface EnvView { key: string; visible: (project: string) => boolean }
/** A project as a reader without environment access sees it: the identity fields as they are, the environments withheld. */
const withheldEnvs = (project: ProjectView): ProjectView => ({ ...project, envs: [], envsWithheld: true });
const briefTask = (row: GoalAcceptanceTaskRow): GoalAcceptanceTask => ({
  id: asId(row.id), title: row.title, state: row.state, executorRole: row.executor_role, reviewerRole: row.reviewer_role,
  kind: row.kind ?? 'task', version: row.version, blockedTo: row.blocked_to ?? undefined,
  submitted: Boolean(row.submitted_by), leaseHolder: isLeased(row) ? row.current_employee : undefined,
  dependencies: (row.dependencies ?? []).map(asId).sort(),
});

/**
 * Source guard of a gated lease write (SYS-DISP IR03). Every source the gate read must still be at the version it was read at, or the
 * write is refused and the caller re-reads. The write also stamps each source: a concurrent authorship change on a source always bumps
 * its version in the same transaction, so the two conflict instead of one landing between the read and the other's commit.
 */
const INDEPENDENCE_GUARD_SQL = `FOR $g IN $indep_guards {
        IF (SELECT VALUE version FROM ONLY $g.task) != $g.version { THROW 'contribution history moved: independence source' };
        UPDATE ONLY $g.task SET independence_guard = $g.version;
      };`;

/** The gate one stage reads: the exclusion index and the source versions the write must be guarded by. */
interface IndependenceGate {
  taskId: string;
  index: IndependenceIndex;
  guards: Array<{ task: RecordId; version: number }>;
}

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
/**
 * A claim reads at most this many of its task's newest protocol entries and newest ops entries for the handover (SYS01 R3).
 * The whole history is counted, so a claim that read less says so: historyComplete is false and historyCount is the total.
 * The echo of the claim fits as many of the entries it was given as the budget allows; get_task_history pages the rest.
 */
const HANDOVER_ROWS = 60;
const HANDOVER_OPS_ROWS = 20;

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

export class SurrealCompanyCore implements CompanyCore {
  readonly leaseSeconds: number;
  readonly checkpointLimit: number;
  /** Optional pre-submit check of implementation deliveries; returns why the submission cannot go to review. */
  private readonly submitCheck?: SubmitCheck;
  /** SYS02: read-only source adapter that verifies CI runs, artifacts and probes; tests inject a deterministic one. */
  private readonly acceptanceAdapter: AcceptanceSourceAdapter;
  /** Test seam (SYS-DISP AC06): runs after a contribution view is read and before the lease transaction that checks it. */
  private readonly contributionReadHook?: (taskId: string) => Promise<void>;
private readonly independenceReadHook?: (taskId: string) => Promise<void>;
  private readonly companyReleaseRepo?:string;
  constructor(readonly database: CompanyDatabase, options?: { companyReleaseRepo?:string; leaseSeconds?: number; checkpointLimit?: number; workforce?: Workforce; worktrees?: RegistryOptions; submitCheck?: SubmitCheck; snapshots?: Partial<SnapshotLimits>; snapshotObserve?: (stats: SnapshotBuildStats) => void; contributionReadHook?: (taskId: string) => Promise<void>; independenceReadHook?: (taskId: string) => Promise<void>; acceptance?: { adapter?: AcceptanceSourceAdapter };
    externalActions?: { gateway?: ExternalActionGateway }; faults?: { limits?: FaultBudgetLimits; clock?: () => number };
    waits?: { clock?: () => number; webhookSecret?: string } }) {
    this.companyReleaseRepo=options?.companyReleaseRepo;
    this.submitCheck = options?.submitCheck;
    this.acceptanceAdapter = options?.acceptance?.adapter ?? createGithubActionsAdapter();
    // Same seam as the acceptance adapter: the controlled external exit is injectable so a test drives an isolated fake
    // endpoint instead of the network, while production always gets the company's authenticated gh CLI.
    this.externalActionsGateway = options?.externalActions?.gateway;

    this.contributionReadHook = options?.contributionReadHook;
    this.independenceReadHook = options?.independenceReadHook;
    const seconds = options?.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3600) {
      throw new CompanyError('invalid', 'Invalid lease duration');
    }
    this.leaseSeconds = seconds;
    this.checkpointLimit = options?.checkpointLimit ?? DEFAULT_CHECKPOINT_LIMIT;
    this.workforce = options?.workforce;
    this.owner = new OwnerDesk(database);
    this.dispositions = new DispositionLedger(database);
    this.projects = new ProjectStore(database.db);
    this.worktrees = options?.worktrees ? new WorktreeRegistry(database.db, options.worktrees) : undefined;
    this.snapshots = new SnapshotStore(database.db, options?.snapshots, { channel: database.buildChannel, releaseChannel: database.releaseChannel, observe: options?.snapshotObserve });
    // SYS04: the fault ledger (one episode per cause, one budget per fault object, one repair chain per incident).
    this.faults = new FaultStore(database.db);
    this.faultLimits = options?.faults?.limits ?? DEFAULT_FAULT_BUDGET;
    this.faultClock = options?.faults?.clock ?? Date.now;
    // SYS05: typed waits on time and trusted external events.
    this.waits = new WaitStore(database.db);
    this.waitClock = options?.waits?.clock ?? Date.now;
    this.waitWebhookSecret = options?.waits?.webhookSecret ?? process.env.SCK_WAIT_WEBHOOK_SECRET;
    // SYS07: goal outcome contract, final-gate invariants and read-only business metrics.
    this.goals = new GoalGovernanceStore(database.db);
  }
  readonly worktrees?: WorktreeRegistry;
  private readonly owner: OwnerDesk;
  /** SYS03: the manager-disposition ledger (episode claims, decisions, holder notices, controlled external actions). */
  private readonly dispositions: DispositionLedger;
  /** SYS03: the controlled external-action exit, absent in production (the gh CLI is built then). */
  private readonly externalActionsGateway?: ExternalActionGateway;
  /** SYS04: the fault ledger — structured faults, the persistent recovery budget and the repair chain. */
  private readonly faults: FaultStore;
  /** SYS04: the recovery budget limits applied to a fault object. */
  private readonly faultLimits: FaultBudgetLimits;
  /** SYS04: the clock the budget is measured against (tests inject a controlled one). */
  private readonly faultClock: () => number;
  /** SYS05: the wait ledger. */
  private readonly waits: WaitStore;
  /** SYS05: the clock waits are measured against (tests inject a controlled one). */
  private readonly waitClock: () => number;
  /** SYS05: the HMAC secret a webhook must sign with; absent means webhook events are refused, never trusted by default. */
  private readonly waitWebhookSecret?: string;
  private readonly goals: GoalGovernanceStore;
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
    const scoped = actor.role !== 'gm';
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
      `SELECT id, state, executor_role, reviewer_role, submitted_by, implementer,
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
      // A role change after the claim, or a review lease held by the submitter/implementer,
      // is contradictory state: never rebuild it as a usable local claim.
      if (role !== actor.role) return [];
      if (row.state === 'review' && (row.submitted_by === actor.employeeId || row.implementer === actor.employeeId)) return [];
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
    if (actor.role !== row.executor_role && actor.role !== row.reviewer_role && actor.role !== 'gm' && actor.role !== 'eval') {
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
            await Bun.sleep(10 * (attempt + 1));
            continue;
          }
          if (/conflict/i.test(cause)) throw new CompanyError('temporarily_unavailable', 'Database contention; retry request', true);
          // Goal acceptance guards THROW 'goal acceptance moved: …' when a preview basis drifted; that is a stale-snapshot conflict, not a generic failure.
          const moved = /goal acceptance moved: ([^'"\n]+)/i.exec(cause);
          if (moved) throw new CompanyError('conflict', `Goal acceptance moved: ${moved[1]!.trim()}; run goal_acceptance_preview again`);
          // Facts read before a lease transaction moved under it: the caller re-reads the contribution view and retries (SYS-DISP AC04).
          if (new RegExp(CONTRIBUTION_MOVED, 'i').test(cause)) throw new CompanyError('conflict', 'Task contribution history moved; retry the request');
          // Implementer takeover: 'moved' is a stale basis (CAS), 'invalid' is an ineligible target; both are checked before the generic denied/forbidden match.
          const qaScope = /qa observation (invalid|moved): ([^'"\n]+)/i.exec(cause);
          if (qaScope) throw new CompanyError(qaScope[1]!.toLowerCase() === 'moved' ? 'conflict' : 'invalid', `QA observation ${qaScope[1]!.toLowerCase()}: ${qaScope[2]!.trim()}`);
          const takeover = /implementer takeover (moved|invalid): ([^'"\n]+)/i.exec(cause);
          if (takeover) {
            const kind = takeover[1]!.toLowerCase();
            throw new CompanyError(kind === 'moved' ? 'conflict' : 'invalid', `Implementer takeover ${kind}: ${takeover[2]!.trim()}`);
          }
          // 有效策略层（SYS06）：epoch 或替代目标移动是 conflict，作用域/来源越权是 forbidden，其余（同域冲突、成环）按 conflict。
          const policyMoved = /policy (moved|conflict): ([^'"\n]+)/i.exec(cause);
          if (policyMoved) throw new CompanyError('conflict', `Policy ${policyMoved[1]!.toLowerCase()}: ${policyMoved[2]!.trim()}`);
          if (/policy denied/i.test(cause)) throw new CompanyError('forbidden', 'Policy write denied');
          if (/policy changed/i.test(cause)) {
            throw new CompanyError('conflict', '策略已变更：本次动作按的契约已过期，重新领取或按新契约办理（旧 claim 与旧提示不能继续授权写）');
          }
          // Independence policy writes: a moved version or a live lease is a conflict; a closed task is invalid; the actor is denied.
          const independence = /independence (moved|refused|invalid|denied): ([^'"\n]+)/i.exec(cause);
          if (independence) {
            const kind = independence[1]!.toLowerCase();
            throw new CompanyError(kind === 'denied' ? 'forbidden' : kind === 'invalid' ? 'invalid' : 'conflict', `Independence ${kind}: ${independence[2]!.trim()}`);
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

  /** A created task answers with its context bounded to the item budget (SYS01); the create itself is not affected. */
  async createTask(credential: Credential, input: CreateTask): Promise<TaskView> {
    return echoTask(await this.createTaskRecord(credential, input, { external: true }));
  }

  /**
   * `repairKey` (SYS03 AC02) switches the create's idempotency identity from the caller's employee to the business key,
   * so the repair chain a disposition builds exists exactly once no matter which manager, session or replay asked for it.
   */
  private async createTaskRecord(credential: Credential, input: CreateTask, options: { external?: boolean; acceptanceChain?: string; repairKey?: string } = {}): Promise<TaskView> {
    const actor = await this.authorized(credential, 'manage');
    if (!['gm', 'product'].includes(actor.role)) throw new CompanyError('forbidden', 'Task creation denied');
    // External create_task only: the raw list is bounded before de-duplication. Internal delivery
    // legs and automatic goal-anchor dependencies are deliberately not capped here; they must
    // retain the complete dependency set.
    if (options.external) validateExternalDependencies(input.dependencies);
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
    if (declaresEnvironment && leg !== 'deploy') {
      // Before the merge there is no deployment to verify, so an implement or release leg cannot carry an environment
      // requirement: the deploy leg is the one that runs against a real environment.
      throw new CompanyError('invalid',
        `acceptance environment requirements apply to the deploy leg only; this task is the ${leg} leg`);
    }
    const acceptanceEnvironment = effectiveEnvironment(acceptanceCriteria, input.acceptanceEnvironment);
    // 必配轨岗位（如 screenwriter）：任务必须带指定轨，缺轨/错轨显式拒绝，防止无轨任务落到专属编制。
    const requiredTrack = REQUIRED_TRACKS[input.executorRole];
    if (requiredTrack !== undefined && input.discipline !== requiredTrack) {
      throw new CompanyError('invalid', `executorRole ${input.executorRole} requires discipline=${requiredTrack}`);
    }
    if (input.modelTier !== undefined && !['fable','opus','sonnet','haiku','high','medium','low'].includes(input.modelTier)) throw new CompanyError('invalid', 'Invalid model tier');
    const kind = input.kind ?? 'task';
    if (!['task', 'gate', 'release', 'deploy'].includes(kind)) throw new CompanyError('invalid', 'Invalid task kind');
    // SYS06 AC02/AC03：机器策略在创建前判定（写权、老板关口），生效契约登记到任务上。判定只读 policy 表。
    const policyChain = this.policyChain({ goalId: input.goalId, projectId: input.project, includeTask: false });
    const { contract: policyContract, epoch: policyEpoch } = await this.effectiveContractFor(policyChain);
    const writeVerdict = checkWriteAuthority(policyContract, { role: input.executorRole, kind,
      ...(input.goalId ? { goalId: input.goalId } : {}), ...(input.workIntent ? { intent: input.workIntent } : {}) });
    if (!writeVerdict.ok) {
      throw new CompanyError(writeVerdict.code,
        `策略拒绝创建：${writeVerdict.reason}（policy v${policyContract.version} hash=${policyContract.hash.slice(0, 16)}）`);
    }
    const gateVerdict = checkGateCreation(policyContract, { leg, kind, executorRole: input.executorRole, reviewerRole: input.reviewerRole });
    if (!gateVerdict.ok) {
      throw new CompanyError(gateVerdict.code, `策略拒绝创建：${gateVerdict.reason}（policy v${policyContract.version}）`);
    }
    const policyGate = domainPayload(policyContract, 'gate');
    if (policyGate?.requiredCriteriaLegs.includes(leg) && trustedCode) {
      // 策略可以在全局验收闸门关闭时仍要求这条腿带基线验收条件：只加强，不放宽。
      acceptanceCriteria = mergeAcceptanceCriteria(leg, acceptanceCriteria);
    }
    const policyEvidence = `policy v${policyContract.version} hash=${policyContract.hash.slice(0, 16)} chain=${policyChain.map(link => `${link.scope}${link.scopeRef ? `:${link.scopeRef}` : ''}`).join('>')}`;
    if (input.goalId !== undefined) requireText(input.goalId, 'goal', 1, 100);
    const dependencies = [...new Set(input.dependencies ?? [])];
    if (input.revises !== undefined) return this.createRevision(actor, input, dependencies);
    const idem = options.repairKey === undefined
      ? this.idemId(actor.employeeId, 'create', input.idempotencyKey)
      : this.businessIdemId('create', options.repairKey);
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
discipline: input.discipline, work_intent: input.workIntent, model_tier: input.modelTier,
      acceptance_criteria: acceptanceCriteria,
      acceptance_version: acceptanceCriteria.length > 0 ? ACCEPTANCE_CRITERIA_VERSION : undefined,
      acceptance_chain: options.acceptanceChain,
      acceptance_environment: acceptanceEnvironment,
      // A task created while the gate is off is legacy: enabling later never retroactively gates it (SYS02 AC06).
      acceptance_legacy: !acceptanceGate.enabled,
      policy_version: policyContract.version, policy_hash: policyContract.hash, policy_contract: policyContract,
      policy_evidence: policyEvidence, expected_policy_epoch: policyEpoch,
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
        LET $epoch = (SELECT VALUE value FROM ONLY company_meta:policy_epoch) ?? 0;
        IF $epoch != $expected_policy_epoch { THROW 'policy moved: the effective contract moved since it was read; re-read policy_effective and retry' };
        LET $unfinished = SELECT VALUE id FROM task WHERE id IN $dep_resolved AND ${DEP_UNSATISFIED};
        LET $created = CREATE ONLY $task CONTENT {
          title: $title, context: $context, executor_role: $executor, reviewer_role: $reviewer,
          discipline: $discipline, work_intent: $work_intent, project: $project, model_tier: $model_tier,
          dependencies: $dependencies, state: IF array::len($unfinished) = 0 THEN 'ready' ELSE 'blocked' END,
          version: 1, fence: 0, submitted_by: NONE, current_employee: NONE,
          delivery_id: NONE, lease_expires_at: NONE, resume_role: NONE, resume_state: 'ready', blocked_to: NONE,
          kind: $kind, goal: $goal, created_at: time::now(),
          policy_version: $policy_version, policy_hash: $policy_hash, policy_contract: $policy_contract,
          ${acceptanceCriteria.length > 0 ? 'acceptance_criteria: $acceptance_criteria, acceptance_version: $acceptance_version,' : ''}
          acceptance_legacy: $acceptance_legacy, acceptance_head: NONE, acceptance_environment: $acceptance_environment,
          acceptance_attempt: 0${options.acceptanceChain !== undefined ? ', acceptance_chain: $acceptance_chain' : ''}
        };
        ${GOAL_ANCHOR_SQL}
        CREATE ONLY $audit CONTENT { task: $task, actor: $actor, action: 'create', version: 1, evidence: $policy_evidence, at: time::now() };
        LET $sequence = UPDATE ONLY company_meta:outbox_counter SET value += 1 RETURN AFTER;
        CREATE ONLY $outbox CONTENT { task: $task, kind: 'created', sequence: $sequence.value, payload: { state: $created.state }, at: time::now() };
        CREATE ONLY $idem CONTENT { at: time::now(), payload_digest: $digest, result: $created };
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
    const submitAt = lastSubmit?.[0]?.at;
    if (!submitAt) throw new CompanyError('conflict', 'revises target was never submitted');
    // Keep the database's nanosecond precision: JavaScript Date truncates two real,
    // ordered events in the same millisecond and used to reject a valid revision.
    const [rejectRows] = await this.db.query<[Array<{ id: RecordId; at: unknown }>]>(
      "SELECT id, at FROM audit WHERE task = $task AND action = 'owner_reject' AND at > $submitted ORDER BY at DESC LIMIT 1;",
      { task: id('task', targetId), submitted: submitAt });
    const reject = rejectRows?.[0];
    if (!reject) {
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
      discipline: input.discipline, work_intent: input.workIntent, model_tier: input.modelTier,
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
          discipline: $discipline, work_intent: $work_intent, project: $project, model_tier: $model_tier,
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
        CREATE ONLY $idem CONTENT { at: time::now(), payload_digest: $digest, result: $created };
        RETURN $created;
        COMMIT;`, vars);
      return view(row);
    } catch (error) {
      const replay = await this.replay(idem, digest);
      if (replay) return replay;
      throw error;
    }
  }

  private async checkExecutionWindow(taskId: string): Promise<void> {
    const row = await this.db.select<TaskRow>(id('task', taskId));
    if (row && row.state !== 'review' && windowExpired(row.execution_window))
      throw new CompanyError('invalid', 'Execution window expired; manager recovery required');
  }

  async claim(credential: Credential, taskId: TaskId): Promise<ClaimResult> {
    const actor = await this.authorized(credential);
    if (!this.worktrees) return this.claimLease(actor, taskId);
    const task = await this.getTask(credential, taskId);
    const employee = await this.db.select<{ workspace_scope?: string }>(id('employee', actor.employeeId));
    if (employee?.workspace_scope && employee.workspace_scope !== workspaceScopeFor(task.goalId)) {
      throw new CompanyError('forbidden', 'Task claim denied: conversation belongs to another goal');
    }
    const reviewing = task.state === 'review';
    if (!['ready', 'doing', 'review'].includes(task.state) ||
        !actor.capabilities.includes(reviewing ? 'review' : 'execute') ||
        actor.role !== (reviewing ? task.reviewerRole : task.executorRole) ||
        (reviewing && task.submittedBy === actor.employeeId) ||
        (task.discipline && actor.tracks?.length && !actor.tracks.includes(task.discipline))) {
      throw new CompanyError('forbidden', 'Task claim denied');
    }
    if (reviewing) {
      // A contributor of this task (an author, or its implementer) never reviews it: refused before a worktree is allocated.
      if ((await readContributionView(this.db, taskId)).facts.excluded.includes(actor.employeeId)) {
        throw new CompanyError('forbidden', 'Task claim denied: a contributor of this task cannot review it');
      }
    }
    if (!reviewing && task.executorRole === 'engineering') {
      // Engineering execute is bound to one implementer (contributors.ts): refuse before a worktree is allocated.
      const facts = (await readContributionView(this.db, taskId)).facts;
      if (facts.ambiguous) throw new CompanyError('forbidden', 'Task claim denied: implementer unresolved, manager takeover required');
      if (facts.implementer && facts.implementer !== actor.employeeId) throw new CompanyError('forbidden', 'Task claim denied: bound to another implementer');
    }
    // Independence (SYS-DISP IR03): refused before a worktree is allocated, exactly as the claim transaction would refuse it.
    await this.refuseIndependent(await this.independenceGate(taskId, task.independence, reviewing ? 'review' : 'execute'), actor.employeeId);
    // SYS06 AC02: a task whose effective contract no longer authorizes this work is refused before any worktree is allocated.
    // 复核相位同样要判：调度器已经按 policyBlocks 拦下 review 队列，员工直连 claim 不能给出相反结论。判定用**任务自身**
    // 的执行岗与意图（与调度器 policyDispatchVerdict 同源），不是评审岗位——被 blocked 的任务谁也领不走，也就不可能
    // 从评审缝拿到执行缝拒绝发的独占写树。
    {
      const policyRow = await this.taskRowWithProject(taskId);
      if (!policyRow) throw new CompanyError('not_found', 'Task not found');
      const { contract } = await this.effectiveContractFor(this.chainOfRow(policyRow));
      const verdict = dispatchVerdict({ state: policyRow.state, executorRole: task.executorRole, kind: task.kind,
        ...(task.goalId ? { goalId: task.goalId } : {}),
        ...(task.workIntent ? { workIntent: task.workIntent } : {}),
        ...(policyRow.policy_hash ? { policyHash: policyRow.policy_hash } : {}),
        ...(policyRow.policy_block_reason ? { policyBlockReason: policyRow.policy_block_reason } : {}),
        registeredDomains: registeredDomainsOf(policyRow) }, contract);
      if (verdict.verdict === 'blocked') {
        throw new CompanyError('forbidden', `策略拒绝领取：${verdict.reason}（policy v${contract.version} hash=${contract.hash.slice(0, 16)}）`);
      }
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

  /**
   * Read-only write-scope preflight for the dispatcher (SYS-DISP R1): the holders that would refuse an execute claim of this task
   * now, under the claim's own rules. Takes no repo lock and writes nothing; the claim stays the authority.
   */
  async writeScopeOf(taskId: TaskId, employeeId?: string): Promise<WriteScopeHolder[]> {
    if (!this.worktrees) return [];
    const row = await this.db.select<TaskRow>(id('task', taskId));
    if (!row) throw new CompanyError('not_found', 'Task not found');
    const task = view(row);
    const project = await this.taskProject(taskId);
    const { repo, list } = await this.worktrees.identity(task.codeRepoPath ?? project?.repoPath ?? this.worktrees.options.opsRepo);
    return this.worktrees.writeScope(repo, list, task, { employeeId: employeeId ?? '', role: task.executorRole });
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
    // Checked before the registry is consulted: a caller without a task and without gm is refused even when no registry exists (R8).
    if (!taskId && actor.role !== 'gm') throw new CompanyError('forbidden', 'Global worktree inventory requires gm');
    if (!this.worktrees) return [];
    if (taskId) {
      const task = await this.getTask(credential, taskId);
      const project = await this.taskProject(taskId);
      const { repo } = await this.worktrees.identity(task.codeRepoPath ?? project?.repoPath ?? this.worktrees.options.opsRepo);
      return this.worktrees.inventory(repo);
    }
    return this.worktrees.inventory();
  }

  /**
   * The independence gate of one stage (SYS-DISP IR03): the exclusion read now, and the source versions the write must be guarded by.
   * Undefined when the policy does not name this stage, so legacy tasks and ungated stages take no extra read. A policy this build cannot
   * enforce refuses here whatever its stages; a source that cannot be read or does not exist refuses too. Nothing is written.
   */
  private async independenceGate(taskId: string, policy: IndependencePolicy | undefined,
    stage: IndependenceStage | undefined): Promise<IndependenceGate | undefined> {
    if (!policy || !stage) return undefined;
    const fault = policyFault(policy);
    if (fault !== undefined) throw new CompanyError('forbidden', fault);
    if (!policy.stages.includes(stage)) return undefined;
    const snapshot = await readIndependenceSnapshot(this.db, policy, this.independenceReadHook);
    return { taskId, index: snapshot.index, guards: snapshot.sources.map(source => ({ task: id('task', source.taskId), version: source.version })) };
  }

  /** Refuses `employee` when the gate excludes them: `forbidden`, with the structured conflict in `details`. Writes nothing. */
  private async refuseIndependent(gate: IndependenceGate | undefined, employee: string): Promise<void> {
    if (!gate) return;
    const principal = (await readEmployeePrincipals(this.db, [employee])).get(employee);
    await refuseIfExcluded(this.db, gate.taskId, gate.index, employee, principal);
  }

  /**
   * Runs one lease transaction against fresh facts (SYS-DISP AC04, AC06). When the facts it was built from moved under it (another
   * authorship change landed first), the transaction is refused and this re-reads and tries again: a check that used stale facts is
   * never accepted. A stage the policy names is gated before the write: a contributor of a source is refused with the structured
   * conflict, and the write carries the source guards, so a source that moved since the read refuses it and the whole check runs
   * again (CONTRIBUTION_MOVED). Other stages and legacy tasks run exactly as before.
   */
  private async withContributionRetry<T>(taskId: string, actor: string, stageOf: (state?: string) => IndependenceStage | undefined,
    attempt: (contrib: ContributionView, gate?: IndependenceGate) => Promise<T>): Promise<T> {
    for (let round = 0; ; round++) {
      const contrib = await readContributionView(this.db, taskId);
      const gate = await this.independenceGate(taskId, contrib.policy, stageOf(contrib.state));
      await this.contributionReadHook?.(taskId);
      try {
        await this.refuseIndependent(gate, actor);
        return await attempt(contrib, gate);
      } catch (error) {
        if (round < 4 && isContributionMoved(error)) continue;
        throw error;
      }
    }
  }

  private async claimLease(actor: Principal, taskId: TaskId, worktree?: WorktreeAssignment): Promise<ClaimResult> {
    const task = id('task', taskId);
    // SYS06 AC02/AC03：派工/领取前的机器策略判定，并把本租约的生效契约登记下来（lease_policy_*）。
    // 复核相位同样要判：问的是"这条任务还在授权范围内吗"，所以用任务自身的执行岗与意图（与调度器同源），不是评审岗位；
    // 被 blocked 的任务连评审都领不走，评审缝就不会发出执行缝拒绝发的独占写树。
    const current = await this.taskRowWithProject(taskId);
    if (!current) throw new CompanyError('not_found', 'Task not found');
    const policyChain = this.chainOfRow(current);
    const { contract: policyContract, rows: policyRows, epoch: policyEpochAtClaim } = await this.effectiveContractFor(policyChain);
    {
      const currentTask = view(current);
      const verdict = dispatchVerdict({ state: current.state, executorRole: currentTask.executorRole, kind: currentTask.kind,
        ...(currentTask.goalId ? { goalId: currentTask.goalId } : {}),
        ...(currentTask.workIntent ? { workIntent: currentTask.workIntent } : {}),
        ...(current.policy_hash ? { policyHash: current.policy_hash } : {}),
        ...(current.policy_block_reason ? { policyBlockReason: current.policy_block_reason } : {}),
        registeredDomains: registeredDomainsOf(current) }, policyContract);
      if (verdict.verdict === 'blocked') {
        throw new CompanyError('forbidden',
          `策略拒绝领取：${verdict.reason}（policy v${policyContract.version} hash=${policyContract.hash.slice(0, 16)}）`);
      }
    }
    const row = await this.withContributionRetry(taskId, actor.employeeId, state => state === 'review' ? 'review' : 'execute',
      (contrib, gate) => this.txTask(`BEGIN;
      LET $now = time::unix(time::now());
      LET $who = SELECT * FROM ONLY $actor;
      LET $t = SELECT * FROM ONLY $task;
      IF $who = NONE OR $who.revoked = true OR $t = NONE { THROW 'not found or revoked' };
      IF $who.workspace_scope != NONE AND $who.workspace_scope != IF $t.goal = NONE THEN 'maintenance' ELSE <string>record::id($t.goal) END { THROW 'workspace goal denied' };
      IF $t.state = 'void' { THROW 'task retired' };
      IF $t.state NOT IN ['ready', 'review', 'doing'] { THROW 'task not claimable' };
      // SYS05：等待中的任务不占租约、不派工；到点前直接 claim 也拒绝（releaseDue 落库后才回到 ready/review）。
      IF $t.wait_state = 'waiting' { THROW 'task is waiting' };
      IF $t != NONE AND $t.version != $seen { THROW 'contribution history moved: retry' };
      LET $epoch = (SELECT VALUE value FROM ONLY company_meta:policy_epoch) ?? 0;
      IF $epoch != $expected_policy_epoch { THROW 'policy moved: the effective contract moved since the claim was read' };
      ${INDEPENDENCE_GUARD_SQL}
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
      LET $expired = $t.state != 'review' AND $t.execution_window != NONE AND <datetime>$t.execution_window.notAfter <= time::now();
      IF $expired {
        IF $t.current_employee != NONE AND $t.lease_expires_at > $now { THROW 'execution window expired under active lease' };
        LET $n = UPDATE ONLY $task SET state = 'blocked', blocked_to = 'gm', resume_state = $t.state, version += 1 RETURN AFTER;
        CREATE audit CONTENT { task: $task, actor: 'system:execution-window', action: 'block', version: $n.version,
          recovery_reason: 'stale_window', evidence: '执行窗口已过期；需经理安排真实重采样和独立批准，禁止延长旧证据', at: time::now() };
        LET $seq = UPDATE ONLY company_meta:outbox_counter SET value += 1 RETURN AFTER;
        CREATE outbox CONTENT { task: $task, kind: 'block', sequence: $seq.value, payload: { version: $n.version }, at: time::now() };
      } ELSE {
      IF $t.state != 'review' AND $t.recovery_stopped = true { THROW 'automatic recovery stopped' };
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
        lease_policy_version = $policy_version,
        lease_policy_hash = $policy_hash,
        policy_block_reason = IF $t.policy_block_reason != NONE THEN $t.policy_block_reason ELSE NONE END,
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
        // The first execute claim of an unbound engineering task makes this employee its implementer. That binding is the
        // record that they write the task's code, so it is kept as a contribution row: an implementer whose lease was later
        // revoked, or whose binding moved on to the next engineer, is still a real author and never reviews their own
        // delivery (SYS-DISP IR01/Q1: a claim-only holder is a demoted hand, but a bound implementer is not one).
        IF $t.state != 'review' AND $t.executor_role = 'engineering' AND $t.implementer = NONE {
          CREATE ONLY $bound_audit CONTENT { task: $task, actor: $actor, action: 'implementer_bound', phase: 'execute', version: $next.version, at: time::now() };
        };
        LET $sequence = UPDATE ONLY company_meta:outbox_counter SET value += 1 RETURN AFTER;
        CREATE ONLY $outbox CONTENT { task: $task, kind: 'claimed', sequence: $sequence.value, payload: { employee: $employee, fence: $next.fence }, at: time::now() };
      };
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
      excluded: contrib.facts.excluded, bound: contrib.facts.implementer ?? '', ambiguous: contrib.facts.ambiguous, seen: contrib.version ?? -1,
      indep_guards: gate?.guards ?? [], bound_audit: id('audit', randomUUID()),
      policy_version: policyContract.version, policy_hash: policyContract.hash, expected_policy_epoch: policyEpochAtClaim,
    }));
    const taskView = view(row);
    const project = await this.taskProject(taskId);
    const handover = await this.handoverHistory(taskId);
    if (row.state === 'blocked') throw new CompanyError('invalid', 'Execution window expired; manager recovery required');
    return { task: taskView, deliveryId: taskView.deliveryId!, fence: taskView.fence,
      leaseExpiresAt: taskView.leaseExpiresAt!, history: handover.history, historyComplete: handover.historyComplete, historyCount: handover.historyCount,
      predecessors: await this.predecessors(taskId, actor.employeeId),
      project, worktree: taskView.worktree,
      // 提示里只渲染当前有效契约（SYS06 AC03）：旧文本留在 policy 历史里，claim.json 拿到的是这一份。
      policy: this.policyEffectiveView(policyChain, policyContract, policyRows) };
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

  /**
   * Audit entries of one task, newest first, read in one consistent read with the database time. Routine ops_call
   * reads are not audit history and are left out of every history answer.
   */
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
    if (actor.role !== 'gm') {
      where.push('(executor_role = $myrole OR reviewer_role = $myrole)');
      vars.myrole = actor.role ?? '';
    }
    if (params.role) {
      where.push('(executor_role = $qrole OR reviewer_role = $qrole)');
      vars.qrole = params.role;
    }
    if (params.goalId) {
      where.push('goal = $goal');
      vars.goal = id('goal', params.goalId);
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
      guidance: 'narrow with state, goalId, role or since, or leave fields out',
      load: async db => {
        const { at, count, textBytes, rows } = await this.taskRowsAt(actor, params, limits.maxRows + 1, limits.maxBytes, db);
        if (count > limits.maxRows) throw tooLarge(`more than ${limits.maxRows} tasks match; narrow with state, goalId, role or since`);
        if (textBytes > limits.maxBytes) {
          throw tooLarge(`the matching tasks hold more than ${limits.maxBytes} bytes of text; narrow with state, goalId, role or since`);
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
        `read a long part with read_task_text: the context {"taskId":"${task.id}","field":"context","offset":0}, then offset = nextOffset with the expectSha256 of the first segment, until nextOffset is null (the whole text has sha256 ${HASH(task.context)}); a long dependency list {"taskId":"${task.id}","field":"dependencies","offset":0}; or leave a part out with fields${company ? `; or ${COMPANY_PAGED_HINT}` : ''}`);
    }
    if (!params.paged) {
      const guidance = 'retry with {"pageSize":25} and then {"cursor":"<page.nextCursor>"} until page.hasMore is false, or narrow with state, goalId, role or since';
      const { count, textBytes, rows } = await this.taskRowsAt(actor, params, COMPLETE_TASK_ROWS + 1, RESPONSE_BUDGET_BYTES);
      if (count > COMPLETE_TASK_ROWS) throw tooLarge(`more than ${COMPLETE_TASK_ROWS} tasks match; ${guidance}`);
      if (textBytes > RESPONSE_BUDGET_BYTES) {
        throw tooLarge(`the matching tasks hold ${textBytes} bytes of text, above the ${RESPONSE_BUDGET_BYTES}-byte budget; ${guidance}`);
      }
      const view: ContextView = { principal: actor, ...withCompany, tasks: rows.map(row => listItem(row, params.fields, false)) };
      return completeOrRefuse(view, `the working set (${rows.length} tasks)`, company ? `${guidance}; or ${COMPANY_PAGED_HINT}` : guidance);
    }
    const digest = queryDigest('context', {
      state: params.state ?? null, goalId: params.goalId ?? null, role: params.role ?? null, since: params.since ?? null, fields: params.fields ?? null, includeCompany: params.includeCompany,
    });
    return this.listingPage<Record<string, unknown>, ContextView>({
      actor, kind: 'context', digest, pageSize: params.pageSize, cursor: params.cursor, startedAt,
      create: started => this.contextListing(actor, params, digest, started),
      parse: body => JSON.parse(body) as Record<string, unknown>,
      respond: (tasks, page) => ({ principal: actor, ...withCompany, tasks: [...tasks], page }),
      envelopeGuidance: company ? `${COMPANY_PAGED_HINT}, which leaves the block out of every page` : 'narrow the query with state, goalId, role or since',
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
   * scopes it to that task's repository; a global read is gm only), and includeReleased must be the filter the listing item
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

  /** Re-checks, on every worktree read, what it needs: access to the task, or gm for the global inventory. */
  private async worktreeScope(credential: Credential, actor: Principal, taskId?: string): Promise<void> {
    if (taskId !== undefined) await this.getTask(credential, taskId as TaskId);
    else if (actor.role !== 'gm') throw new CompanyError('forbidden', 'Global worktree inventory requires gm');
  }

  /**
   * read_task_text (SYS01, R3): one byte segment of one text of a task. context and evidence are read as stored. project is the
   * task's project environment as JSON, read by its holder and gm only. dependencies, workIntentPaths and worktreePaths are the
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
      if (actor.role !== 'gm' && !holds) {
        throw new CompanyError('forbidden', 'the project environment is read by gm or the holder of a valid task lease');
      }
      const project = await this.taskProject(params.taskId as TaskId);
      if (!project) throw new CompanyError('not_found', 'the task has no project environment');
      text = JSON.stringify(project);
    } else {
      const lists = {
        dependencies: task.dependencies,
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
   * get_admin_summary (SYS01, C5, gm only): counts by state and by audit action in a window, with the cutoff time and the
   * outbox sequence. The counts are read twice inside one transaction. integrity.complete is true only when the two reads
   * agree and each count matches the rows it grouped. Nothing here carries task text.
   */
  async adminSummary(credential: Credential, input: Record<string, unknown> = {}): Promise<AdminSummary> {
    const actor = await this.authenticate(credential);
    if (actor.role !== 'gm') throw new CompanyError('forbidden', 'Only gm may read the company summary');
    const params = parseSummaryInput(input);
    const since = params.since ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const goal = params.goalId ? id('goal', params.goalId) : undefined;
    // One transaction. The cutoff is the database time at its start. Task counts are each task's state at that cutoff and
    // ignore since. Audit counts cover [since, cutoff]; with a goal, only the audit entries of that goal's tasks.
    const taskWhere = goal ? 'WHERE goal = $goal' : '';
    const auditWhere = goal ? 'task IN $goalTasks AND at >= <datetime>$since AND at <= $cutoff' : 'at >= <datetime>$since AND at <= $cutoff';
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
      ${goal ? 'LET $goalTasks = (SELECT VALUE id FROM task WHERE goal = $goal);' : ''}
      ${counts('')}
      ${counts('_again')}
      RETURN { read: {
        cutoff: <string>$cutoff, outbox: $outbox,
        states: $states, taskTotal: $taskTotal, actions: $actions, auditTotal: $auditTotal,
        again: { states: $states_again, taskTotal: $taskTotal_again, actions: $actions_again, auditTotal: $auditTotal_again },
      } };`, { since, ...(goal ? { goal } : {}) });
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
      cutoffAt: read.cutoff, since, ...(params.goalId ? { goalId: params.goalId } : {}),
      scope: {
        tasks: goal ? 'tasks of this goal, each in the state it holds at cutoffAt; since does not apply to them'
          : 'every task, each in the state it holds at cutoffAt; since does not apply to them',
        audit: goal ? "audit entries of this goal's tasks with at from since up to cutoffAt" : 'audit entries with at from since up to cutoffAt',
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
   * gm/product/qa only, read-only (SYS04): what the plugin process is actually running.
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
      throw new CompanyError('forbidden', 'Only gm, product or qa may read the plugin runtime diagnostics');
    }
    return await sample();
  }

  /**
   * gm only, read-only (SYS-DISP AC05): what the audit-derived contributors say about the given tasks, the implementer status
   * each one would have, and its timeline. Nothing is written: no lease, submitter, owner gate, history or implementer changes
   * here. Recording a suggested implementer is a separate step that needs owner authorization.
   */
  async contributorDryRun(credential: Credential, input: { taskIds: string[] }): Promise<ContributorDryRunView> {
    const actor = await this.authorized(credential);
    if (actor.role !== 'gm') throw new CompanyError('forbidden', 'Only gm may run the contributor dry-run');
    if (!Array.isArray(input.taskIds) || input.taskIds.length === 0 || input.taskIds.length > 20) {
      throw new CompanyError('invalid', 'taskIds must hold 1 to 20 task ids');
    }
    const rows: ContributorDryRunView['tasks'] = [];
    for (const taskId of input.taskIds) {
      requireText(taskId, 'taskId', 1, 200);
      const row = await this.db.select<TaskRow>(id('task', taskId));
      if (!row) {
        rows.push({ taskId, found: false });
        continue;
      }
      const { facts, version } = await readContributionView(this.db, taskId);
      const window = await readAuditTimelineWindow(this.db, taskId, DRY_RUN_TIMELINE_ROWS, openLeaseOf(row.current_employee, row.state));
      rows.push({
        found: true, title: row.title, state: row.state, version, executorRole: row.executor_role,
        reviewerRole: row.reviewer_role, currentEmployee: row.current_employee, lastSubmitter: row.submitted_by,
        ...proposeImplementer(taskId, facts, row.implementer ?? undefined),
        timeline: window.entries, timelineTotal: window.total,
      });
    }
    // The whole answer is held to DRY_RUN_BYTE_BUDGET: every task keeps its newest rows, and the number kept halves until the JSON fits.
    const answer = (keep: number): ContributorDryRunView => {
      const tasks = rows.map(task => {
        if (!task.timeline) return { ...task };
        const shown = Math.min(keep, task.timeline.length);
        return { ...task, timeline: task.timeline.slice(task.timeline.length - shown), timelineShown: shown,
          timelineTruncated: shown < (task.timelineTotal ?? shown) };
      });
      return { readOnly: true, checkedAt: new Date().toISOString(), budgetBytes: DRY_RUN_BYTE_BUDGET,
        truncated: tasks.some(task => task.timelineTruncated === true), tasks };
    };
    let keep = DRY_RUN_TIMELINE_ROWS;
    for (;;) {
      const view = answer(keep);
      if (keep === 0 || Buffer.byteLength(JSON.stringify(view), 'utf8') <= DRY_RUN_BYTE_BUDGET) return view;
      keep = Math.floor(keep / 2);
    }
  }

  /**
   * gm and qa, read-only (SYS-DISP IR01-IR05): the verdict the independence gate would give for one employee on one task at one
   * stage — the formal read-only preflight that the source-avoidance registrations prove their criteria with, replacing an exported
   * reply as evidence. The exclusion comes from the gate's own reader and index, so a reading cannot drift from what a claim or a
   * submit actually does, and nothing is written: no lease, version, audit row, outbox event or dispatch observation. A done or void
   * task stays readable, which is the tool's main use.
   *
   * A task without a policy is not_applicable (legacy behaviour unchanged). A source that cannot be read, an unreadable identity
   * table, or a policy this build cannot enforce is unverifiable — never clear, because the gate fails closed on exactly those. qa may
   * read it (independent review without manage); every other role is refused.
   */
  async independenceCheck(credential: Credential, input: IndependenceCheckInput): Promise<IndependenceCheckView> {
    const actor = await this.authorized(credential);
    if (actor.role !== 'gm' && actor.role !== 'qa') {
      throw new CompanyError('forbidden', 'Only a manager or qa may read the independence preflight');
    }
    requireText(input.taskId, 'taskId', 1, INDEPENDENCE_LIMITS.idChars);
    requireText(input.employeeId, 'employeeId', 1, INDEPENDENCE_LIMITS.idChars);
    if (input.stage !== undefined && input.stage !== 'execute' && input.stage !== 'review') {
      throw new CompanyError('invalid', 'stage must be execute or review');
    }
    const row = await this.db.select<TaskRow>(id('task', input.taskId));
    if (!row) throw new CompanyError('not_found', `Task not found: ${input.taskId}`);
    // The stage is inferred from the phase the task is in now, the way a claim reads it: review while in review, execute otherwise.
    const stage: IndependenceStage = input.stage ?? (row.state === 'review' ? 'review' : 'execute');
    const registered = row.independence ? policyView(row.independence) : undefined;
    if (registered === undefined) {
      return { taskId: input.taskId, employeeId: input.employeeId, stage, verdict: 'not_applicable',
        reason: 'the task has no independence policy, so the gate takes no independence read for it' };
    }
    // The policy echo is the registered value itself, so qa reads the real fields back instead of trusting a relayed reply.
    const policy: IndependenceCheckPolicyView = { revision: registered.revision, stages: registered.stages, mode: registered.mode,
      sources: registered.sources, excluded: registered.excluded, setBy: registered.setBy, setAt: registered.setAt };
    return { ...await checkIndependence(this.db, input.taskId, registered, stage, input.employeeId, this.independenceReadHook), policy };
  }

  /**
   * The company block as the credential's holder may read it. Projects keep their identity fields for everyone; their environments
   * (names, URLs and credential aliases with roles) are shown only to gm and to the holder of a valid lease on one of their tasks
   * (SYS01 M3). The owner's console reads the full block through OwnerDesk.brief, which is unchanged.
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

  /** Which project environments a reader may see: all for gm; otherwise those of the projects of tasks it holds under a valid lease. */
  private async envView(actor: Principal): Promise<EnvView> {
    if (actor.role === 'gm') return { key: 'all', visible: () => true };
    const [rows] = await this.db.query<[Array<{ project?: RecordId; goal_project?: RecordId }>]>(
      'SELECT project AS project, goal.project AS goal_project FROM task WHERE current_employee = $employee AND lease_expires_at > $now;',
      { employee: actor.employeeId, now: Math.floor(Date.now() / 1000) });
    const held = new Set((rows ?? []).flatMap(row => {
      const project = row.project ?? row.goal_project;
      return project ? [String(project.id)] : [];
    }));
    return { key: [...held].sort().join(','), visible: project => held.has(project) };
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
    // The caller's own dependency list is external input: bound the raw list before de-duplication,
    // exactly like create_task (51 duplicates must not collapse into one legal edge). The legs' internal
    // chain dependencies (leg N waits for leg N-1) are added below and stay complete.
    validateExternalDependencies(input.dependencies);
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
    // SYS02: the delivery carries one versioned criteria set; each leg gets the criteria that name it, or its defaults.
    const explicitCriteria = validateAcceptanceCriteria(input.acceptanceCriteria);
    const acceptanceGate = await loadAcceptanceGate(this.db);
    const acceptanceChain = HASH(`delivery\0${input.idempotencyKey}`).slice(0, 16);
    const legNames: AcceptanceLeg[] = ['implement', 'release', 'deploy'];
    // The legs are returned together: each echo gets an equal share of the item budget, so the whole answer fits (SYS01).
    const legLimit = Math.floor(ITEM_BUDGET_BYTES / specs.length);
    const lane = input.lane ?? `delivery-${HASH(input.idempotencyKey).slice(0, 8)}`;
    const created: TaskView[] = [];
    let dependencies = [...new Set(input.dependencies ?? [])];
    for (const [index, spec] of specs.entries()) {
      // The leg is echoed once, below, at its share of the budget: an echo here too would cut its lists twice (SYS01 R3).
      const legName = legNames[index] ?? 'implement';
      const matching = explicitCriteria.length > 0 ? criteriaForLeg(explicitCriteria, legName) : [];
      // Gate on: pass only the caller's matching criteria; createTaskRecord merges the unremovable baseline for this leg.
      // Gate off: preserve the old default-criteria behaviour.
      const acceptanceCriteria = acceptanceGate.enabled
        ? (matching.length > 0 ? matching : undefined)
        : (matching.length > 0 ? matching : defaultAcceptanceCriteria(legName));
      const task = await this.createTaskRecord(credential, {
        ...spec, goalId: input.goalId, dependencies, idempotencyKey: `${input.idempotencyKey}:delivery:${index}`,
        // Every leg persists the same project override so the chain stays on one project.
        project: input.project,
        // One delivery is one lane: every leg works in the same tree and branch, whoever claims it.
        workIntent: { kind: spec.kind === 'release' ? 'read' : 'code', lane },
        // Only the implementation leg carries the discipline track; release/deploy legs stay generic.
        discipline: index === 0 ? input.discipline : undefined,
        acceptanceCriteria,
        // N1: the environment requirement is a deploy-leg fact. The implement and release legs run against the PR head,
        // where no deployment exists yet, so they stay generic CI.
        acceptanceEnvironment: spec.kind === 'deploy' ? input.acceptanceEnvironment : undefined,
      }, { acceptanceChain });
      created.push(task);
      dependencies = [task.id];
    }
    return created.map(task => echoTask(task, legLimit));
  }

  /** SYS02: read the gate and the current verdict for one task (its holder, reviewer, or gm). */
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

  /** SYS02: gm read of the versioned gate record. */
  async acceptanceGate(credential: Credential): Promise<AcceptanceGateView> {
    const actor = await this.authorized(credential, 'manage');
    if (actor.role !== 'gm') throw new CompanyError('forbidden', 'Only gm may read the acceptance gate record');
    return loadAcceptanceGate(this.db);
  }

  /** SYS02 AC06: gm changes the gate with a version check and a reason audit; an executor can never self-approve it. */
  async setAcceptanceGate(credential: Credential, input: AcceptanceGateInput): Promise<AcceptanceGateView> {
    const actor = await this.authorized(credential, 'manage');
    if (actor.role !== 'gm') throw new CompanyError('forbidden', 'Only gm may change the acceptance gate');
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
    if (actor.role !== 'gm' && !holds) throw new CompanyError('forbidden', 'Acceptance evidence is recorded by the task holder or gm');
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

  // ---- 受控编制管理工具（manage = gm/product） ----
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
    // SYS05: an owner handoff wait parks the task outside the owner-gate fields (blocked_to = NONE), so the
    // ordinary owner.decide path cannot reach it. The boss's reply through this same relay is the typed event
    // that releases it, carrying the owner's own words; a model saying "the boss agreed" has no quote to pass.
    if (input.taskId && input.decision === 'reply') {
      const waiting = await this.waits.openOfTask(input.taskId).catch(() => undefined);
      if (waiting?.kind === 'owner_handoff') {
        await this.resolveOwnerWait(input.taskId, input.ownerQuote, input.idempotencyKey);
        const row = await this.db.select<TaskRow>(id('task', input.taskId));
        if (!row) throw new CompanyError('not_found', 'Task not found');
        return echoTask(view(row));
      }
    }
    const decided = await this.owner.decide({ ...input, source, key: `${source}:${input.idempotencyKey}`,
      note: `${input.note}\n老板原话：${input.ownerQuote}` });
    // SYS05: if a task is both an owner gate and an owner handoff, the same decision resolves the wait too.
    if (input.taskId) {
      await this.resolveOwnerWait(input.taskId, input.ownerQuote, input.idempotencyKey)
        .catch(error => { /* the decision itself must not be lost to a wait ledger error; the next tick can retry */
          void error; });
    }
    return echoTask(decided);
  }

  async relayDirection(credential: Credential, input: { text: string; ownerQuote: string; idempotencyKey: string }): Promise<void> {
    const source = await this.relayActor(credential, input.ownerQuote);
    await this.owner.addDirection({ text: input.text, source, key: `${source}:${input.idempotencyKey}` });
  }

  /** Lease writes answer with their task echoed within the budget (SYS01): the write is already committed, so its echo never fails it. */
  private async transition(
    credential: Credential, proof: LeaseProof, action: 'heartbeat' | 'checkpoint' | 'submit' | 'accept' | 'return' | 'block',
    evidence?: Evidence, to?: 'gm' | 'owner'
  ): Promise<TaskView> {
    return echoTask(await this.transitionRecord(credential, proof, action, evidence, to));
  }

  private async transitionRecord(
    credential: Credential, proof: LeaseProof, action: 'heartbeat' | 'checkpoint' | 'submit' | 'accept' | 'return' | 'block',
    evidence?: Evidence, to?: 'gm' | 'owner'
  ): Promise<TaskView> {
    const actor = await this.authorized(credential);
    if (!Number.isSafeInteger(proof.expectedVersion) || !Number.isSafeInteger(proof.fence) || proof.fence < 1) {
      throw new CompanyError('invalid', 'Invalid lease proof');
    }
    if (evidence) requireText(evidence.text, 'evidence', 20, 30000);
    if (evidence?.recoveryReason !== undefined && !recoveryReasonSchema.safeParse(evidence.recoveryReason).success) throw new CompanyError('invalid', 'Invalid recoveryReason');
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
      if (!(row.code_repo_path ?? project?.repoPath) || realpathSync((row.code_repo_path ?? project?.repoPath)!) !== realpathSync(repo)) throw new CompanyError('forbidden','此任务不是公司系统仓库的上线任务');
      companyUpgrade = await readCompanyRelease(repo,evidence.companyUpgrade.sha);
    }
    let prHead: string | undefined;
    // SYS06 AC03: 下一次相关动作前核版本。租约登记的契约 hash 与当前有效契约不一致时，这笔写被拒——
    // 旧 claim 与旧提示都不能授权继续写（心跳不算写动作，只续租约）。
    let policyHashNow: string | undefined;
    if (action !== 'heartbeat') {
      const policyRow = await this.taskRowWithProject(proof.taskId);
      if (!policyRow) throw new CompanyError('not_found', 'Task not found');
      policyHashNow = (await this.effectiveContractFor(this.chainOfRow(policyRow))).contract.hash;
    }
    if (action === 'submit' && evidence && this.submitCheck) {
      const row = await this.db.select<TaskRow>(id('task', proof.taskId));
      if (row?.executor_role === 'engineering' && row.kind === 'task') {
        const checked = await this.submitCheck({ branch: row.worktree?.branch, text: evidence.text }).catch(() => undefined);
        if (checked?.reason) throw new CompanyError('invalid', `提交被退回（未进入验收）：${checked.reason}`);
        // The PR gate's actual head is authoritative: a declared acceptance head cannot outlive a moved PR head (B2).
        prHead = checked?.head;
      }
    }
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
      IF $t != NONE AND $t.version != $seen { THROW 'contribution history moved: retry' };
      ${INDEPENDENCE_GUARD_SQL}
      IF !$heartbeat AND $t.lease_policy_hash != NONE AND $t.lease_policy_hash != $policy_hash {
        THROW 'policy changed: the effective contract moved since this lease was claimed; re-claim to continue'
      };
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
        ${UNLOCK_SQL}
      };
      IF !$heartbeat {
        CREATE ONLY $audit CONTENT { task: $task, actor: $actor, action: $action, evidence: $evidence, version: $next.version, at: time::now(), recovery_reason: $recovery_reason, phase: IF $t.state = 'review' THEN 'review' ELSE 'execute' END };
        LET $sequence = UPDATE ONLY company_meta:outbox_counter SET value += 1 RETURN AFTER;
        CREATE ONLY $outbox CONTENT { task: $task, kind: $action, sequence: $sequence.value, payload: { version: $next.version, state: $next.state }, at: time::now() };
      };
      ${idem ? 'CREATE ONLY $idem CONTENT { at: time::now(), payload_digest: $digest, result: $next };' : ''}
      RETURN $next;
      COMMIT;`;
    // Gated stages (SYS-DISP IR03): submit is an execute write; accept and return are review decisions. Other actions take no gate.
    const gatedStage: IndependenceStage | undefined = action === 'submit' ? 'execute' : action === 'accept' || action === 'return' ? 'review' : undefined;
    try {
      const row = await this.withContributionRetry(proof.taskId, actor.employeeId, () => gatedStage, (contrib, gate) => this.txTask(query, {
        actor: id('employee', actor.employeeId), employee: actor.employeeId,
        task: id('task', proof.taskId), delivery: proof.deliveryId,
        fence: proof.fence, expected: proof.expectedVersion, lease_seconds: this.leaseSeconds,
        ...flags, action, has_company_upgrade: companyUpgrade !== undefined, company_upgrade: companyUpgrade, recovery_reason: action === 'block' ? evidence?.recoveryReason : undefined, evidence: evidence?.text ?? '', to: to ?? '', checkpoint_limit: this.checkpointLimit,
        acceptance_head: acceptance?.head ?? null, acceptance_environment: acceptance?.environment ?? null,
        has_head: acceptance?.head !== undefined, has_environment: acceptance?.environment !== undefined,
        human_evidence: acceptance?.human ?? [],
        excluded: contrib.facts.excluded, bound: contrib.facts.implementer ?? '', ambiguous: contrib.facts.ambiguous, seen: contrib.version ?? -1,
        audit: id('audit', randomUUID()), outbox: id('outbox', randomUUID()), idem, digest,
        indep_guards: gate?.guards ?? [],
        policy_hash: policyHashNow ?? null,
      }));
      if (action === 'accept' && row.goal) await this.goalFinalizeSafe(asId(row.goal), `system:accept:${actor.employeeId}`, asId(row.id));
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
    return echoTask(await this.releaseRecord(credential, proof, evidence));
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
   *
   * SYS04 AC01/AC02: a block may carry the machine facts of the failure that caused it (`fault`). Those facts are
   * classified and grouped by fingerprint, and the attempt they describe is charged to the recovery budget of the
   * fault object here — not by the employee, and not by a later retry. Without a `fault`, the block is an ordinary
   * block: the employee blocked because it decided to, and no budget is spent.
   */
  async block(credential: Credential, proof: LeaseProof, to: 'gm' | 'owner', evidence: Evidence, quotaResetsAt?: string, fault?: FaultInput): Promise<TaskView> {
    const until = quotaResetsAt === undefined ? undefined : parseQuotaResetsAt(quotaResetsAt, Date.now());
    const actor = await this.authenticate(credential);
    // The fault is recorded before the state change, so a crash between the two leaves the attempt charged (the
    // attempt really happened) rather than a block that no budget accounts for.
    if (fault !== undefined) await this.reportTaskFault(actor.employeeId, proof.taskId, fault);
    const view = await this.transition(credential, proof, 'block', evidence, to);
    await this.recordQuotaGate(credential, proof.taskId, until);
    return view;
  }

  // ---------------------------------------------------------------- SYS05: typed waits

  /**
   * Enter a typed wait. The lease is released and the progress snapshot is stored in the same transaction; the task
   * leaves the dispatch queue with no employee or provider seat attached. Nothing about the condition is released
   * here, and the time condition replaces neither a dependency nor an owner approval.
   */
  async wait(credential: Credential, proof: LeaseProof, evidence: Evidence, input: WaitEntryInput): Promise<TaskView> {
    const actor = await this.authorized(credential);
    if (!Number.isSafeInteger(proof.expectedVersion) || !Number.isSafeInteger(proof.fence) || proof.fence < 1) {
      throw new CompanyError('invalid', 'Invalid lease proof');
    }
    requireText(evidence.text, 'evidence', 20, 30000);
    // SYS05 AC04: invitation material and credentials stay in the controlled handoff file, never in task evidence.
    assertNonSensitive(evidence.text, 'evidence');
    const row = await this.db.select<TaskRow>(id('task', proof.taskId));
    if (!row) throw new CompanyError('not_found', 'Task not found');
    if (row.state === 'void') throw new CompanyError('conflict', 'Task retired');
    if (!['doing', 'review'].includes(row.state)) throw new CompanyError('forbidden', 'Task not held');
    const idem = this.idemId(actor.employeeId, 'wait', evidence.idempotencyKey);
    const digest = HASH(JSON.stringify({ proof, evidence, input }));
    const replay = await this.replay(idem, digest);
    if (replay) return replay;
    const now = this.waitClock();
    const defaultOwner = input.kind === 'owner_handoff' ? 'owner'
      : (input.kind === 'dependency' || input.kind === 'upstream_repair') ? row.executor_role : 'gm';
    const normalized = normalizeWait({ ...input, ownerRole: input.ownerRole ?? defaultOwner } as WaitInput, {
      now, ownerRole: defaultOwner,
    });
    let releaseGraph: (() => Promise<void>) | undefined;
    try {
      if (normalized.referenceTaskId) {
        const reference = await this.db.select<TaskRow>(id('task', normalized.referenceTaskId));
        if (!reference) throw new CompanyError('not_found', 'referenceTaskId 指向的任务不存在');
        if (normalized.referenceTaskId === proof.taskId) throw new CompanyError('invalid', '任务不能等待自己');
        // The cycle check and the wait insert must be one critical section. A pre-check alone is a TOCTOU race:
        // two holders entering A->B and B->A at the same time each miss the other's uncommitted edge.
        releaseGraph = await this.waits.lockGraph(`employee:${actor.employeeId}:${randomUUID()}`);
        if (await this.waitWouldCycle(proof.taskId, normalized.referenceTaskId)) {
          throw new CompanyError('conflict', '等待引用会形成依赖环，已拒绝');
        }
        if (['done', 'void'].includes(reference.state)) {
          throw new CompanyError('conflict', 'referenceTaskId 指向的任务已经终态；不需要进入等待');
        }
      }
      // The progress snapshot is the last resumable thing the holder did, not a claim about the outside world.
      let summary = normalized.summary;
      if (!summary) {
        const [latest] = await this.db.query<[Array<{ evidence?: string }>]>(
          `SELECT evidence FROM audit WHERE task = $task AND action IN ['checkpoint', 'submit', 'wait']
           ORDER BY at DESC LIMIT 1;`, { task: id('task', proof.taskId) }).catch(() => [[]] as [Array<{ evidence?: string }>]);
        const text = latest?.[0]?.evidence ?? '';
        summary = text ? assertNonSensitive(text.slice(0, 800), 'progress summary') : undefined;
      }
      const waitKey = waitKeyOf(proof.taskId, randomUUID());
      const createdAt = this.waitClock();
      try {
        const updated = await this.waits.enter({
          taskId: proof.taskId, waitKey, normalized: {
            kind: normalized.kind, source: normalized.source, ownerRole: normalized.ownerRole,
            ...(normalized.reference === undefined ? {} : { reference: normalized.reference }),
            ...(normalized.referenceTaskId === undefined ? {} : { referenceTaskId: normalized.referenceTaskId }),
            ...(normalized.notBefore === undefined ? {} : { notBefore: normalized.notBefore }),
            ...(normalized.expiresAt === undefined ? {} : { expiresAt: normalized.expiresAt }),
            expiresSource: normalized.expiresSource,
            ...(normalized.nextCheckAt === undefined ? {} : { nextCheckAt: normalized.nextCheckAt }),
            ...(normalized.timezone === undefined ? {} : { timezone: normalized.timezone }),
            completed: normalized.completed,
            ...(normalized.pendingAction === undefined ? {} : { pendingAction: normalized.pendingAction }),
            ...(normalized.handoffFile === undefined ? {} : { handoffFile: normalized.handoffFile }),
            reason: normalized.reason,
          },
          progress: {
            employee: actor.employeeId, taskVersion: proof.expectedVersion, at: createdAt,
            ...(summary === undefined ? {} : { summary }),
          },
          resumeState: row.state === 'review' ? 'review' : 'ready',
          resumeRole: row.state === 'review' ? row.reviewer_role : row.executor_role,
          actor: actor.employeeId, employee: actor.employeeId,
          proof: { deliveryId: proof.deliveryId, fence: proof.fence, expectedVersion: proof.expectedVersion },
          now, evidence: evidence.text, idem: String(idem.id), digest,
          auditId: randomUUID(), outboxId: randomUUID(),
        });
        if (!updated) throw new CompanyError('temporarily_unavailable', '等待未落地，请重试', true);
        return view(updated);
      } catch (error) {
        const prior = await this.replay(idem, digest);
        if (prior) return prior;
        throw this.waitError(error);
      }
    } finally {
      await releaseGraph?.();
    }
  }

  /**
   * Resolve a wait from a trusted event. The public entry accepts an authorized manager or a signed webhook; the
   * owner path is not reachable here (only the owner relay calls `resolveOwnerWait`), so an employee saying it heard
   * back from the customer cannot release a real-person acknowledgement.
   */
  async resolveWait(credential: Credential, input: WaitResolveInput): Promise<WaitResolveView> {
    const actor = await this.authorized(credential);
    if (!input || typeof input.source !== 'string') throw new CompanyError('invalid', 'source is required');
    if (input.source === 'owner') {
      throw new CompanyError('forbidden', '老板决定只能由 owner relay 记录（record_owner_decision），员工不能自称收到老板回执');
    }
    requireText(input.text, 'evidence', 20, 30000);
    assertNonSensitive(input.text, 'evidence');
    const wait = await this.waitOfInput(input);
    if (!wait) throw new CompanyError('not_found', '没有找到这个等待（waitKey 或 taskId）');
    const now = this.waitClock();
    const verified = input.source === 'webhook' ? this.verifyWebhook(input, now) : false;
    if (input.source === 'authorized_person' || input.source === 'dependency') {
      if (actor.role !== 'gm') throw new CompanyError('forbidden', '只有经理（gm）可以以授权人身份确认等待事件');
    }
    if (input.source === 'webhook' && !verified) {
      if (!this.waitWebhookSecret) throw new CompanyError('not_configured', 'webhook 签名密钥未配置；未验证的事件不能解除等待');
      throw new CompanyError('forbidden', 'webhook 签名无效；事件未被接受');
    }
    const event = validateEvent(waitRecordOf(wait), input as never, now, { verified });
    const outcome = await this.waits.resolve({
      wait, event: event as WaitEvent, expectedVersion: wait.version, actor: `employee:${actor.employeeId}`,
      ownerApproved: false, now,
    });
    return {
      released: outcome.released, code: outcome.code, message: outcome.message,
      taskId: outcome.taskId, waitKey: wait.waitKey,
      ...(event.eventId ? { eventKey: waitEventKey(wait.waitKey, event) ?? '' } : {}),
    };
  }

  /**
   * The owner relay's resolution. It is deliberately not exposed as a tool: only `record_owner_decision` (which
   * carries the owner's own words and is audited as a relay) reaches it. It releases every open owner handoff of
   * that task, and nothing else.
   */
  private async resolveOwnerWait(taskId: TaskId, ownerQuote: string, idempotencyKey: string): Promise<void> {
    const row = await this.db.select<TaskRow>(id('task', taskId));
    if (!row) return;
    const waits = await this.waits.waitsOfTask(taskId);
    for (const wait of waits) {
      if (wait.kind !== 'owner_handoff' || wait.state !== 'waiting') continue;
      const now = this.waitClock();
      const event: WaitEvent = {
        source: 'owner', at: now, verified: true, objectWaitId: wait.waitKey, objectTaskId: taskId,
        eventId: `owner:${idempotencyKey}:${wait.waitKey}`,
        ownerQuote: assertNonSensitive(ownerQuote.slice(0, 2000), 'ownerQuote'),
      };
      await this.waits.resolve({
        wait, event, expectedVersion: wait.version, actor: 'owner-relay', ownerApproved: true, now,
      });
    }
  }

  /** Manager cancel: version-locked. Without `resume` the task stays blocked for a human, never silently schedulable. */
  async cancelWait(credential: Credential, input: WaitActionInput): Promise<WaitActionView> {
    const actor = await this.authorized(credential, 'manage');
    if (actor.role !== 'gm') throw new CompanyError('forbidden', '只有经理（gm）可以取消等待');
    if (!Number.isSafeInteger(input.expectedVersion)) throw new CompanyError('invalid', 'expectedVersion 必须是整数');
    const reason = String(input.reason ?? '').trim();
    if (reason.length < 10 || reason.length > 2000) throw new CompanyError('invalid', '取消理由需为 10-2000 字');
    assertNonSensitive(reason, 'reason');
    const result = await this.waits.cancel({
      waitKey: String(input.waitKey ?? ''), expectedVersion: input.expectedVersion, reason,
      actor: `employee:${actor.employeeId}`, resume: input.resume === true, now: this.waitClock(),
    });
    return { ok: result.cancelled, message: result.message, waitKey: String(input.waitKey ?? ''),
      ...(result.taskId === undefined ? {} : { taskId: result.taskId }) };
  }

  /** Manager extend/re-arm: version-locked and reasoned. A stale version cannot overwrite another manager's change. */
  async extendWait(credential: Credential, input: WaitActionInput): Promise<WaitActionView> {
    const actor = await this.authorized(credential, 'manage');
    if (actor.role !== 'gm') throw new CompanyError('forbidden', '只有经理（gm）可以延期等待');
    if (!Number.isSafeInteger(input.expectedVersion)) throw new CompanyError('invalid', 'expectedVersion 必须是整数');
    const reason = String(input.reason ?? '').trim();
    if (reason.length < 10 || reason.length > 2000) throw new CompanyError('invalid', '延期理由需为 10-2000 字');
    assertNonSensitive(reason, 'reason');
    const now = this.waitClock();
    const notBefore = input.notBefore === undefined ? undefined : parseInstant(input.notBefore, 'notBefore');
    const expiresAt = input.expiresAt === undefined ? undefined : parseInstant(input.expiresAt, 'expiresAt');
    const nextCheckAt = input.nextCheckAt === undefined ? undefined : parseInstant(input.nextCheckAt, 'nextCheckAt');
    if (notBefore !== undefined && notBefore < now) throw new CompanyError('invalid', '新的 notBefore 不能早于现在；取消请用 cancel_wait');
    if (expiresAt !== undefined && expiresAt <= now) throw new CompanyError('invalid', '新的 expiresAt 必须晚于现在');
    if (nextCheckAt !== undefined && nextCheckAt <= now) throw new CompanyError('invalid', '新的 nextCheckAt 必须晚于现在');
    const result = await this.waits.extend({
      waitKey: String(input.waitKey ?? ''), expectedVersion: input.expectedVersion, reason,
      actor: `employee:${actor.employeeId}`, now,
      ...(notBefore === undefined ? {} : { notBefore }),
      ...(expiresAt === undefined ? {} : { expiresAt }),
      ...(nextCheckAt === undefined ? {} : { nextCheckAt }),
    });
    return { ok: result.extended, message: result.message, waitKey: String(input.waitKey ?? ''),
      ...(result.version === undefined ? {} : { version: result.version }) };
  }

  /** Read waits. Every authenticated employee may read the internal wait facts; they carry no credentials. */
  async listWaits(credential: Credential, input: { taskId?: string; state?: string; limit?: number } = {}): Promise<WaitListView> {
    await this.authorized(credential);
    const waits = await this.waits.list({
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
      ...(input.state === undefined ? {} : { state: input.state as never }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    });
    return { waits: waits.map(wait => this.waitViewOf(wait)), total: waits.length };
  }

  /** The owner handoff cards. Owner/gm only; a card never contains the handoff file's content. */
  async waitHandoffCards(credential: Credential): Promise<WaitHandoffCard[]> {
    const actor = await this.authorized(credential);
    if (!['gm', 'product'].includes(actor.role)) throw new CompanyError('forbidden', '只有经理/运营可以读取老板交接卡');
    return this.waits.handoffCards(this.waitClock());
  }

  /** Read-only legacy migration preview. It never releases anything, and an owner gate is never a time wait. */
  async waitMigrationPreview(credential: Credential): Promise<WaitMigrationPreviewView> {
    const actor = await this.authorized(credential, 'manage');
    if (!['gm', 'product'].includes(actor.role)) throw new CompanyError('forbidden', '只有经理/运营可以做旧任务迁移预演');
    const [rows] = await this.db.query<[Array<{ id: unknown; state: string; blocked_to?: string; quota_resets_at?: number; wait_state?: string }>]>(
      `SELECT id, state, blocked_to, quota_resets_at, wait_state, created_at FROM task
       WHERE state IN ['blocked', 'ready', 'doing'] ORDER BY created_at LIMIT 200;`);
    const candidates = migrationPreview((rows ?? []).map(row => ({
      id: asId(row.id), state: row.state,
      ...(row.blocked_to === undefined ? {} : { blocked_to: row.blocked_to }),
      ...(row.quota_resets_at === undefined || row.quota_resets_at === null ? {} : { quota_resets_at: row.quota_resets_at }),
      ...(row.wait_state === undefined || row.wait_state === null ? {} : { wait_state: row.wait_state }),
    })), this.waitClock());
    return {
      candidates,
      ownerGatesBlocked: candidates.filter(candidate => candidate.reason === 'owner_gate').length,
      generatedAt: new Date(this.waitClock()).toISOString(),
    };
  }

  /**
   * Migrate exactly one legacy time-bounded task, after the dry run. The caller must name the task and the version
   * it read; an owner gate is refused, a task with no future time bound is refused, and the conversion is audited.
   * There is no batch entry point: a bulk release could walk past a gate whose real blocker is not time.
   */
  async waitMigrationApply(credential: Credential, input: WaitMigrationApplyInput): Promise<TaskView> {
    const actor = await this.authorized(credential, 'manage');
    if (actor.role !== 'gm') throw new CompanyError('forbidden', '只有经理（gm）可以迁移旧任务到等待');
    if (!Number.isSafeInteger(input.expectedVersion)) throw new CompanyError('invalid', 'expectedVersion 必须是整数');
    const reason = String(input.reason ?? '').trim();
    if (reason.length < 10 || reason.length > 2000) throw new CompanyError('invalid', '迁移理由需为 10-2000 字');
    assertNonSensitive(reason, 'reason');
    const row = await this.db.select<TaskRow>(id('task', input.taskId));
    if (!row) throw new CompanyError('not_found', 'Task not found');
    if (row.version !== input.expectedVersion) throw new CompanyError('conflict', 'Task version moved');
    if (row.reviewer_role === 'owner' || row.blocked_to === 'owner') {
      throw new CompanyError('forbidden', '老板关口不能批量迁移为时间等待；必须由老板本人决定');
    }
    const waitKey = waitKeyOf(input.taskId, randomUUID());
    try {
      const updated = await this.waits.migrateLegacy({
        taskId: input.taskId, waitKey, expectedVersion: input.expectedVersion, reason,
        actor: `employee:${actor.employeeId}`, now: this.waitClock(),
        auditId: randomUUID(), outboxId: randomUUID(),
      });
      if (!updated) throw new CompanyError('temporarily_unavailable', '迁移未落地，请重试', true);
      return view(updated);
    } catch (error) {
      throw this.waitError(error);
    }
  }

  /** The wait a resolve call names, by its waitKey or its task's open wait. */
  private async waitOfInput(input: WaitResolveInput): Promise<WaitRow | undefined> {
    // The event's own object id is a valid locator: a webhook that names the wait it is about has already said
    // which waiting object it addresses, so requiring a second copy of the same key would only cause omissions.
    const key = typeof input.waitKey === 'string' ? input.waitKey.trim()
      : typeof input.objectWaitId === 'string' ? input.objectWaitId.trim() : '';
    if (key) return this.waits.wait(key);
    const taskId = typeof input.taskId === 'string' ? input.taskId.trim() : '';
    if (taskId) return this.waits.openOfTask(taskId);
    return undefined;
  }

  /** Verify a webhook signature over the canonical typed payload. An absent secret is a refusal, never a pass. */
  private verifyWebhook(input: WaitResolveInput, now: number): boolean {
    if (!input.eventId || !input.provider) return false;
    const at = input.at === undefined ? now : parseInstant(input.at, 'at');
    const payload = webhookPayload({
      eventId: String(input.eventId), provider: String(input.provider), at,
      ...(input.objectWaitId === undefined ? {} : { objectWaitId: String(input.objectWaitId) }),
      ...(input.objectTaskId === undefined ? {} : { objectTaskId: String(input.objectTaskId) }),
    });
    return verifyWaitWebhook(this.waitWebhookSecret, payload, input.signature);
  }

  /** True when waiting on `reference` would close a cycle: the reference already (transitively) waits on this task. */
  private async waitWouldCycle(taskId: string, reference: string): Promise<boolean> {
    if (taskId === reference) return true;
    const seen = new Set<string>();
    const queue = [reference];
    while (queue.length && seen.size < 50) {
      const current = queue.shift()!;
      if (seen.has(current)) continue;
      seen.add(current);
      const [rows] = await this.db.query<[Array<{ dependencies?: unknown[] }>]>(
        'SELECT dependencies FROM $task;', { task: id('task', current) });
      const edges = new Set<string>();
      for (const dep of rows?.[0]?.dependencies ?? []) edges.add(asId(dep as never));
      // A task can wait through its own open wait row as well as through task.dependencies. Both are real edges:
      // otherwise A->B and B->A both look acyclic and neither can ever be released.
      const [waits] = await this.db.query<[Array<{ reference_task?: unknown }>]>(
        `SELECT reference_task FROM task_wait
         WHERE task = $task AND state IN ['waiting', 'held'] AND reference_task != NONE;`,
        { task: id('task', current) });
      for (const wait of waits ?? []) {
        const ref = wait.reference_task === undefined ? undefined : asId(wait.reference_task as never);
        if (ref) edges.add(ref);
      }
      for (const depId of edges) {
        if (depId === taskId) return true;
        if (!seen.has(depId)) queue.push(depId);
      }
    }
    return false;
  }

  private waitViewOf(wait: WaitRow): TaskWaitView {
    return {
      waitKey: wait.waitKey, kind: wait.kind, state: wait.state, ownerRole: wait.ownerRole,
      source: wait.source.kind,
      ...(wait.notBefore === undefined ? {} : { notBefore: new Date(wait.notBefore).toISOString() }),
      ...(wait.expiresAt === undefined ? {} : { expiresAt: new Date(wait.expiresAt).toISOString() }),
      expiresSource: wait.expiresSource,
      ...(wait.nextCheckAt === undefined ? {} : { nextCheckAt: new Date(wait.nextCheckAt).toISOString() }),
      ...(wait.timezone === undefined ? {} : { timezone: wait.timezone }),
      version: wait.version,
    };
  }

  /** The raw wait transaction errors, mapped onto the API's stable codes. */
  private waitError(error: unknown): CompanyError {
    if (error instanceof CompanyError) return error;
    const message = ((error as Error)?.message ?? '').trim();
    if (/wait graph lock busy/i.test(message)) return new CompanyError('conflict', '另一个等待正在写入，等待图锁未取得；请重试');
    if (/lease expired/i.test(message)) return new CompanyError('lease_expired', '租约已过期；重新领取后再进入等待');
    if (/stale lease or version/i.test(message)) return new CompanyError('conflict', '租约或任务版本已移动；旧 fence 的写入被拒绝');
    if (/already waiting/i.test(message)) return new CompanyError('conflict', '该任务已有进行中的等待');
    if (/owner gate cannot be migrated/i.test(message)) return new CompanyError('forbidden', '老板关口不能迁移为时间等待；必须由老板本人决定');
    if (/no future time bound/i.test(message)) return new CompanyError('invalid', '任务没有未来的时间边界（quota_resets_at 为空或已过去），不能迁移为时间等待');
    if (/not blocked for migration/i.test(message)) return new CompanyError('invalid', '任务不在 blocked 阶段；与迁移预演一致，只有 blocked 任务可以迁移');
    if (/still leased/i.test(message)) return new CompanyError('conflict', '任务仍被有效租约持有，不能迁移；先释放或等到租约结束');
    if (/version moved/i.test(message)) return new CompanyError('conflict', '任务版本已移动；重新读取后再迁移');
    if (/task not held/i.test(message)) return new CompanyError('forbidden', '任务不在执行/复核持有阶段，不能进入等待');
    if (/not found/i.test(message)) return new CompanyError('not_found', 'Task not found');
    if (/conflict/i.test(message)) return new CompanyError('conflict', message.slice(0, 300));
    return new CompanyError('temporarily_unavailable', `等待写入失败：${message.slice(0, 200)}`, true);
  }

  /**
   * Classify one failure and charge it against the recovery budget of the fault object.
   *
   * The fingerprint groups the same cause; the budget key binds the task, the controlled target and the phase, so
   * changing the holder, rewording the error or writing the alias differently does not reset it. The attempt is
   * spent before the caller runs it, so a caller that is refused does not run.
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
  }): Promise<{ allowed: boolean; attempt: number; charged: boolean; reason?: string; message: string; evidence: Record<string, unknown> } | undefined> {
    const controlledTarget = input.target ?? 'none';
    const now = this.faultClock();
    await this.checkExecutionWindow(scope.taskId);
    await this.liftRepairedFaults(scope.taskId, now);
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
   * Read-only diagnosis of a task's recovery budget. Readable by the task holder, its reviewer, or gm.
   * Secret-free: no upstream bodies, no credentials, no aliases beyond what the ledger already stored.
   */
  async faultStatus(credential: Credential, input: { taskId: TaskId }): Promise<FaultStatusView> {
    const actor = await this.authenticate(credential);
    const row = await this.db.select<TaskRow>(id('task', input.taskId));
    if (!row) throw new CompanyError('not_found', 'Task not found');
    const holds = row.current_employee === actor.employeeId && ['doing', 'review', 'blocked'].includes(row.state ?? '') &&
      (row.lease_expires_at ?? 0) > Date.now() / 1000;
    const reviews = actor.role === row.reviewer_role;
    if (actor.role !== 'gm' && !holds && !reviews) {
      throw new CompanyError('forbidden', 'Fault status is read by the task holder, its reviewer, or gm');
    }
    return this.faultStatusOf(input.taskId);
  }

  /**
   * gm only: lift a spent (or stopped) recovery budget for one incident of a task. Resets the existing scope so
   * the next attempt starts a fresh recovery window. Audited. Creates no new budget and never invents an incident.
   */
  async faultLift(credential: Credential, input: {
    taskId: TaskId; incident: string; reason: string; idempotencyKey: string;
  }): Promise<FaultStatusView> {
    const actor = await this.authorized(credential, 'manage');
    if (actor.role !== 'gm') throw new CompanyError('forbidden', 'Only gm may lift a spent recovery budget');
    requireText(input.reason, 'reason', 4, 2000);
    requireText(input.incident, 'incident', 1, 500);
    requireText(input.idempotencyKey, 'idempotencyKey', 1, 200);
    const row = await this.db.select<TaskRow>(id('task', input.taskId));
    if (!row) throw new CompanyError('not_found', 'Task not found');
    const episodes = await this.faults.episodesOfTask(input.taskId);
    const matching = episodes.filter(episode => episode.incident === input.incident);
    if (matching.length === 0) throw new CompanyError('not_found', `no fault episode for incident ${input.incident} on this task`);
    const liftable = matching.some(episode => episode.state === 'exhausted' || episode.state === 'stopped' || episode.state === 'opened' || episode.state === 'converged');
    if (!liftable) throw new CompanyError('conflict', `incident ${input.incident} is already resolved on this task`);
    const now = this.faultClock();
    await this.faults.liftRepair({ taskId: input.taskId, incident: input.incident, now, limits: this.faultLimits });
    await this.db.query(`CREATE audit CONTENT { task: $task, actor: $actor, action: 'fault_lift', evidence: $evidence, at: time::now() };`,
      { task: id('task', input.taskId), actor: id('employee', actor.employeeId),
        evidence: JSON.stringify({ incident: input.incident, reason: input.reason, idempotencyKey: input.idempotencyKey }).slice(0, 30000) });
    return this.faultStatusOf(input.taskId);
  }

  /** Assemble the secret-free diagnosis view of a task. */
  private async faultStatusOf(taskId: TaskId): Promise<FaultStatusView> {
    const now = this.faultClock();
    const budgets: FaultBudgetView[] = (await this.faults.scopesOfTask(taskId)).map(scope => ({
      key: scope.key, target: scope.target, phase: scope.phase,
      attempts: scope.attempts, maxAttempts: scope.maxAttempts, totalAttempts: scope.totalAttempts,
      deadline: scope.deadline, nextAllowedAt: scope.nextAllowedAt,
      failed: scope.failed, stopped: scope.stopped,
      ...(scope.lastErrno === undefined ? {} : { lastErrno: scope.lastErrno }),
      ...(scope.lastHop === undefined ? {} : { lastHop: scope.lastHop }),
      ...(scope.lastIncident === undefined ? {} : { lastIncident: scope.lastIncident }),
      ...(scope.stopReason === undefined ? {} : { stopReason: scope.stopReason }),
      ...(scope.stopDiagnostic === undefined ? {} : { stopDiagnostic: scope.stopDiagnostic }),
    }));
    const episodes: FaultEpisodeView[] = (await this.faults.episodesOfTask(taskId)).map(episode => ({
      episode: episode.episode, incident: episode.incident, fingerprint: episode.fingerprint,
      phase: episode.phase, state: episode.state, openedAt: episode.openedAt, updatedAt: episode.updatedAt,
      ...(episode.resolvedAt === undefined ? {} : { resolvedAt: episode.resolvedAt }),
    }));
    const seen = new Set<string>();
    const repairs: FaultRepairView[] = [];
    for (const episode of episodes) {
      if (seen.has(episode.incident)) continue;
      seen.add(episode.incident);
      const repair = await this.faults.repair(episode.incident);
      if (!repair) continue;
      repairs.push({
        incident: repair.incident, fingerprint: repair.fingerprint, state: repair.state,
        ...(repair.taskId === undefined ? {} : { taskId: repair.taskId }),
        ...(repair.sourceTaskId === undefined ? {} : { sourceTaskId: repair.sourceTaskId }),
        ...(repair.diagnostic === undefined ? {} : { diagnostic: repair.diagnostic }),
      });
    }
    return { taskId, now, budgets, episodes, repairs };
  }

  /**
   * A repair that is done lifts the fault it was made for (AC04): the source task may recover again, with a fresh
   * budget and a new stage. The repair task is the one the manager created for the incident.
   */
  private async liftRepairedFaults(taskId: TaskId, now: number): Promise<void> {
    const incidents = new Set((await this.faults.episodesOfTask(taskId))
      .filter(episode => episode.state === 'exhausted' || episode.state === 'stopped')
      .map(episode => episode.incident));
    for (const incident of incidents) {
      const repair = await this.faults.repair(incident);
      if (!repair?.taskId) continue;
      const repairTask = await this.db.select<{ state?: string }>(id('task', repair.taskId));
      if (repairTask?.state !== 'done') continue;
      await this.faults.liftRepair({ taskId, incident, now, limits: this.faultLimits });
    }
  }

  /**
   * The fault of a task whose recovery must not continue, if there is one: the budget is spent, or the cause
   * cannot be recovered at all. The task's own episodes are read; the newest one wins, because that is the cause
   * the manager has to deal with.
   */
  private async blockedFaultFor(taskId: TaskId): Promise<{ fingerprint: string; incident: string; diagnostic: FaultDiagnostic } | undefined> {
    const episodes = await this.faults.episodesOfTask(taskId);
    const stopped = episodes.find(episode => episode.state === 'exhausted' || episode.state === 'stopped');
    if (!stopped) return undefined;
    const repair = await this.faults.repair(stopped.incident);
    const diagnostic = repair?.diagnostic;
    if (!diagnostic) return undefined;
    return { fingerprint: stopped.fingerprint, incident: stopped.incident, diagnostic };
  }

  /**
   * The repair task of an exhausted fault. It is an ordinary engineering task with the structured diagnostic as
   * its context, created by the manager who is handling the source task, so it enters the normal queue with the
   * usual review rather than as an owner gate. The create carries a business key, so the chain exists exactly
   * once no matter how often the budget is exhausted.
   */
  private async createFaultRepairTask(credential: Credential, sourceTaskId: TaskId, incident: string, fingerprint: string, diagnostic: FaultDiagnostic): Promise<TaskId> {
    const source = await this.db.select<TaskRow>(id('task', sourceTaskId));
    const title = `故障修复 ${diagnostic.phase}/${diagnostic.hop} ${diagnostic.errno}`;
    const context = [
      'SYS04 故障修复任务：一次恢复预算耗尽后的唯一修复链。',
      `incident=${incident}`,
      `fingerprint=${fingerprint}`,
      `phase=${diagnostic.phase} hop=${diagnostic.hop} errno=${diagnostic.errno} httpClass=${diagnostic.httpClass} status=${diagnostic.status ?? '-'}`,
      `attempts=${diagnostic.attempts}/${diagnostic.maxAttempts} elapsedMs=${diagnostic.elapsedMs} retryability=${diagnostic.retryability}`,
      `diagnosis: ${diagnostic.guidance}`,
      `sourceTask=${sourceTaskId}`,
      source?.goal ? `goal=${asId(source.goal)}` : '',
    ].filter(Boolean).join('\n');
    const repairKey = `fault-repair:${incident}`;
    try {
      const view = await this.createTaskRecord(credential, {
        title,
        context,
        executorRole: 'engineering',
        reviewerRole: 'qa',
        ...(source?.goal ? { goalId: asId(source.goal) } : {}),
        workIntent: { kind: 'read' },
        idempotencyKey: repairKey,
      }, { repairKey });
      return view.id;
    } catch (error) {
      // The chain of this incident already exists — another source task exhausted the same cause at the same
      // time, or the ledger was cleaned up while the task was not. The repair is shared: link to it instead of
      // failing the resume of the second task.
      if (!(error instanceof CompanyError) || error.code !== 'conflict') throw error;
      const prior = await this.db.select<IdempotencyRow>(this.businessIdemId('create', repairKey));
      const existing = prior?.result?.id === undefined ? undefined : asId(prior.result.id);
      if (!existing) throw error;
      return existing;
    }
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

  /**
   * GM: run ownership reclaim (or dry-run) across registered repos. Uses the same lock and audit path as the dispatcher sweep.
   * Order: the credential, then the arguments (parseReclaimInput, SYS01 D3), then the gm role. The arguments come before the role,
   * as on MCP and the sidecar, so a malformed call gets the same invalid refusal from any caller. A bad argument never reaches
   * reclaimAll, so no tree is touched.
   */
  async reclaimWorktrees(credential: Credential, input?: { dryRun?: boolean; repos?: string[] }) {
    const actor = await this.authorized(credential);
    const params = parseReclaimInput(input);
    if (actor.role !== 'gm') throw new CompanyError('forbidden', 'Worktree reclaim requires gm');
    if (!this.worktrees) return { scanId: '', removed: [], kept: [], branchesDeleted: [], branchesRetained: [], audited: 0 };
    return this.worktrees.reclaimAll({ trigger: params.dryRun ? 'dry_run' : 'manual', dryRun: params.dryRun, repos: params.repos });
  }

  async listWorktreeAudits(credential: Credential, limit = 100) {
    const actor = await this.authorized(credential);
    if (actor.role !== 'gm') throw new CompanyError('forbidden', 'Worktree audit query requires gm');
    return this.worktrees?.listAudits(limit) ?? [];
  }

  private async validateExecutionWindow(taskId: string, raw: unknown) {
    const window = parseExecutionWindow(raw);
    if (windowExpired(window)) throw new CompanyError('invalid', 'Execution window expired; resample and independently approve a fresh candidate');
    const [facts] = await this.db.query<[Array<{ state: string; goal?: RecordId; digest?: string; expiry?: string }>]>(
      `SELECT state, goal, (SELECT VALUE digest FROM internal_ai_candidate WHERE task = $approval)[0] AS digest, (SELECT VALUE evidence_expires_at FROM internal_ai_candidate WHERE task = $approval)[0] AS expiry FROM $approval;`,
      { approval: id('task', window.approvalTask) });
    const task = await this.db.select<TaskRow>(id('task', taskId));
    const approved = facts?.[0];
    if (!task || !approved || approved.state !== 'done' || normalizedId(approved.goal) !== normalizedId(task.goal) ||
        approved.digest !== window.configurationDigest || approved.expiry !== window.evidenceExpiresAt || !(task.dependencies ?? []).some(d => asId(d) === window.approvalTask))
      throw new CompanyError('invalid', 'Execution window requires a completed independent approval dependency and matching candidate digest');
    return window;
  }

  async resume(credential: Credential, taskId: TaskId, evidence: Evidence): Promise<TaskView> {
    return echoTask(await this.resumeRecord(credential, taskId, evidence));
  }

  private async resumeRecord(credential: Credential, taskId: TaskId, evidence: Evidence,
    options: { businessScope?: boolean } = {}): Promise<TaskView> {
    const actor = await this.authorized(credential, 'manage');
    if (actor.role !== 'gm') throw new CompanyError('forbidden', 'Only gm can resume');
    requireText(evidence.text, 'evidence', 20, 30000);
    // SYS03 AC02/AC05（QA V4）：处置驱动的 resume 由业务键标识，而不是由「谁发的」标识。换一位经理接手同
    // 一个 episode 重放时，幂等身份必须与发起人无关，否则这里查不到记录、又会拿旧版本去撞任务版本 CAS 而卡住。
    const idem = options.businessScope
      ? this.businessIdemId('resume', evidence.idempotencyKey)
      : this.idemId(actor.employeeId, 'resume', evidence.idempotencyKey);
    const digest = HASH(JSON.stringify({ taskId, evidence }));
    const replay = await this.replay(idem, digest);
    if (replay) return replay;
    const before = await this.db.select<TaskRow>(id('task', taskId));
    if (!before) throw new CompanyError('not_found', 'Task not found');
    if (before.state === 'blocked' && before.wait_state === 'waiting') {
      throw new CompanyError('conflict', '任务在等待中；请先 cancel_wait（授权取消）或由受信事件解除，不能用 resume 跳过等待条件');
    }
    const executionWindow = evidence.executionWindow === undefined ? before.execution_window : await this.validateExecutionWindow(taskId, evidence.executionWindow);
    if (windowExpired(executionWindow)) throw new CompanyError('invalid', 'Execution window expired; defer for a fresh approval instead of resuming');
    if (before.state === 'blocked') {
      const target = before.resume_state ?? 'ready';
      if (!['ready', 'doing', 'review'].includes(target)) {
        throw new CompanyError('invalid', `Unknown resume phase: ${target}`);
      }
      if (target === 'review') await this.requireProvableReviewWait(id('task', taskId), before);
    }
    if (before.recovery_stopped && !(evidence.executionWindow && before.execution_window?.approvalTask !== executionWindow?.approvalTask)) throw new CompanyError('invalid', 'Automatic recovery stopped; add real prerequisites or a new independent approval before resuming');
    // SYS04 AC04: a resume may not walk past a fault whose recovery stopped — the budget is spent, or the cause
    // cannot be recovered at all. The task waits for the one repair chain of that incident instead; the manager is
    // not asked to approve the same failure again.
    await this.liftRepairedFaults(taskId, this.faultClock());
    const stopped = await this.blockedFaultFor(taskId);
    if (stopped) {
      const repairTaskId = await this.faults.ensureRepair({
        incident: stopped.incident, fingerprint: stopped.fingerprint, sourceTaskId: taskId,
        diagnostic: stopped.diagnostic, now: this.faultClock(),
        createTask: () => this.createFaultRepairTask(credential, taskId, stopped.incident, stopped.fingerprint, stopped.diagnostic),
      });
      const deferred = await this.deferTaskUntilRecord(credential, {
        taskId,
        dependencies: [repairTaskId],
        text: `恢复已停止（${stopped.diagnostic.phase}/${stopped.diagnostic.hop} ${stopped.diagnostic.errno}，${stopped.diagnostic.attempts}/${stopped.diagnostic.maxAttempts} 次）：已建唯一修复链 ${repairTaskId}，原任务等待该修复完成后再继续`,
        idempotencyKey: `fault-source:${taskId}:${repairTaskId}`,
        expectedVersion: before.version,
      }, { businessScope: true });
      return deferred;
    }
    try {
      const row = await this.txTask(`BEGIN;
        LET $who = SELECT * FROM ONLY $actor;
        LET $t = SELECT * FROM ONLY $task;
        IF $who.revoked = true OR $who.role != 'gm' OR $t = NONE OR $t.state != 'blocked' { THROW 'resume denied' };
        IF $t.version != $expected_version { THROW 'task version moved' };
        IF $t.recovery_stopped = true AND !$new_window { THROW 'automatic recovery stopped' };
        IF $t.wait_state = 'waiting' { THROW 'task is waiting: cancel or resolve the wait first' };
        IF $execution_window != NONE {
          IF <datetime>$execution_window.notAfter <= time::now() { THROW 'execution window expired' };
          LET $approval = type::record('task', $execution_window.approvalTask);
          LET $approved = SELECT * FROM ONLY $approval;
          LET $candidate = SELECT * FROM internal_ai_candidate WHERE task = $approval;
          IF $approved.state != 'done' OR $approval NOT IN $t.dependencies OR array::len($candidate) != 1 OR
            $candidate[0].digest != $execution_window.configurationDigest OR $candidate[0].evidence_expires_at != $execution_window.evidenceExpiresAt {
            THROW 'execution approval moved';
          };
        };
        ${RESOLVE_DEP_SQL('$t.dependencies', '$r_dep')}
        LET $remaining = SELECT * FROM task WHERE id IN $r_dep_resolved AND ${depUnsatisfiedFor('$t')};
        LET $source_phase = $t.resume_state ?? 'ready';
        LET $restore_phase = IF $source_phase = 'doing' THEN 'ready' ELSE $source_phase END;
        LET $next = UPDATE ONLY $task SET
          state = IF array::len($remaining) = 0 THEN $restore_phase ELSE 'blocked' END,
          resume_role = IF array::len($remaining) = 0 THEN NONE ELSE $t.resume_role END,
          resume_state = IF array::len($remaining) = 0 THEN NONE ELSE $t.resume_state END,
          blocked_to = NONE, dependency_continuation = NONE, execution_window = $execution_window,
          recovery_stopped = IF $new_window THEN NONE ELSE $t.recovery_stopped END,
          current_employee = NONE, delivery_id = NONE, lease_expires_at = NONE,
          version = $t.version + 1 RETURN AFTER;
        IF $new_window {
          CREATE audit CONTENT { task: $task, actor: $actor, action: 'recovery_progress', evidence: '绑定新独立批准及有效执行窗口', at: time::now() };
        };
        CREATE ONLY $audit CONTENT { task: $task, actor: $actor, action: 'resume', evidence: $evidence, version: $next.version, at: time::now(),
          source_phase: $source_phase, restore_phase: $restore_phase, result: $next.state };
        LET $sequence = UPDATE ONLY company_meta:outbox_counter SET value += 1 RETURN AFTER;
        CREATE ONLY $outbox CONTENT { task: $task, kind: 'resumed', sequence: $sequence.value,
          payload: { state: $next.state, source_phase: $source_phase, restore_phase: $restore_phase }, at: time::now() };
        CREATE ONLY $idem CONTENT { at: time::now(), payload_digest: $digest, result: $next };
        RETURN $next;
        COMMIT;`, {
        actor: id('employee', actor.employeeId), task: id('task', taskId), evidence: evidence.text, execution_window: executionWindow, expected_version: before.version, new_window: evidence.executionWindow !== undefined && before.execution_window?.approvalTask !== executionWindow?.approvalTask,
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
   * A review-phase wait is legal only when the row carries a real submitted review:
   * the submitter matches the latest submit audit, the submit snapshot is not newer than
   * the task, and the latest block is a review-phase block by the reviewer role. A
   * non-owner reviewer is required; owner gates, cross-role rows and unreadable/missing
   * history fail closed. Read-only.
   */
  private async requireProvableReviewWait(taskRef: RecordId, row: {
    reviewer_role: ReviewerRole; submitted_by?: string; resume_role?: string; version: number;
  }): Promise<void> {
    if (row.reviewer_role === 'owner') throw new CompanyError('invalid', 'review wait does not apply to owner review gates');
    if (!row.submitted_by) throw new CompanyError('invalid', 'review wait has no original submission');
    if (row.resume_role && row.resume_role !== row.reviewer_role) {
      throw new CompanyError('invalid', 'review wait role does not match the reviewer role');
    }
    const [subRows] = await this.db.query<[Array<{ id: RecordId; actor: unknown; version?: number; at: unknown }>]>(
      "SELECT id, actor, version, at FROM audit WHERE task = $task AND action = 'submit' ORDER BY at DESC LIMIT 1;", { task: taskRef });
    const submission = subRows?.[0];
    if (!submission || normalizedId(submission.actor) !== row.submitted_by) {
      throw new CompanyError('invalid', 'review wait lacks a matching original submission');
    }
    if (submission.version === undefined || submission.version > row.version) {
      throw new CompanyError('invalid', 'review submission snapshot is newer than the task');
    }
    const [blockRows] = await this.db.query<[Array<{ id: RecordId; actor: unknown; version?: number; at: unknown; phase?: string }>]>(
      "SELECT id, actor, version, at, phase FROM audit WHERE task = $task AND action = 'block' ORDER BY at DESC LIMIT 1;", { task: taskRef });
    const latestBlock = blockRows?.[0];
    if (!latestBlock || latestBlock.phase !== 'review') {
      throw new CompanyError('invalid', 'review block history is not provable');
    }
    const submittedAt = Date.parse(String(submission.at));
    const blockedAt = Date.parse(String(latestBlock.at));
    if (!Number.isFinite(submittedAt) || !Number.isFinite(blockedAt) || blockedAt <= submittedAt) {
      throw new CompanyError('invalid', 'review block history predates the original submission');
    }
    const blockActor = latestBlock.actor instanceof RecordId ? await this.db.select<EmployeeRow>(latestBlock.actor) : undefined;
    if (!blockActor || blockActor.role !== row.reviewer_role) {
      throw new CompanyError('invalid', 'review block actor does not match the reviewer role');
    }
  }

  /**
   * The dependency graph used by defer's cycle guard. Each raw dependency is
   * resolved through its superseded_by lineage tip before its dependencies are
   * considered, so a chain that only becomes cyclic after revision resolution is
   * still refused. Corrupt/missing lineage stays on the raw row (conservative).
   */
  private async dependencyGraph(ids: string[]): Promise<Map<string, string[]>> {
    const graph = new Map<string, string[]>();
    if (!ids.length) return graph;
    type Row = { id: RecordId; dependencies?: RecordId[]; superseded_by?: RecordId; lineage?: RecordId };
    const [rows] = await this.db.query<[Row[]]>(
      'SELECT id, dependencies, superseded_by, lineage FROM task WHERE id IN $ids;',
      { ids: ids.map(d => id('task', d)) });
    const all: Row[] = [...(rows ?? [])];
    const lineages = [...new Set(all.filter(row => row.superseded_by && row.lineage).map(row => normalizedId(row.lineage)))];
    const tips = new Map<string, string>();
    if (lineages.length) {
      const [tipRows] = await this.db.query<[Array<{ id: RecordId; lineage: RecordId }>]>(
        'SELECT id, lineage FROM task WHERE lineage IN $lineages AND superseded_by = NONE;',
        { lineages: lineages.map(lineage => id('task', lineage)) });
      for (const tip of tipRows ?? []) tips.set(normalizedId(tip.lineage), normalizedId(tip.id));
    }
    const present = new Set(all.map(row => normalizedId(row.id)));
    const missingTips = [...new Set([...tips.values()].filter(tip => !present.has(tip)))];
    if (missingTips.length) {
      const [tipRows] = await this.db.query<[Row[]]>(
        'SELECT id, dependencies, superseded_by, lineage FROM task WHERE id IN $ids;',
        { ids: missingTips.map(tip => id('task', tip)) });
      all.push(...(tipRows ?? []));
    }
    const byId = new Map(all.map(row => [normalizedId(row.id), row]));
    for (const row of all) {
      const rawId = normalizedId(row.id);
      const lineage = row.lineage ? normalizedId(row.lineage) : '';
      const tip = row.superseded_by && lineage ? tips.get(lineage) : undefined;
      const source = tip ? byId.get(tip) ?? row : row;
      graph.set(tip ?? rawId, (source.dependencies ?? []).map(normalizedId));
    }
    return graph;
  }

  /**
   * gm only: re-point a gm block at the dependency graph. Execute blocks keep their old
   * behaviour (wait blocked, restore ready). A normal non-owner review block — one backed
   * by a real submit and a reviewer block in the audit stream — may also be deferred: the
   * original submission, submitter, implementer and contributor facts stay untouched, and
   * the task returns to 'review' under a fresh claim when the last dependency finishes.
   * Owner gates, unprovable review history, live leases and closed goals are refused, not
   * guessed; with every dependency already done the target phase is restored immediately.
   */
  async deferTaskUntil(credential: Credential, input: DeferTaskUntil): Promise<TaskView> {
    return echoTask(await this.deferTaskUntilRecord(credential, input));
  }

  private async deferTaskUntilRecord(credential: Credential, input: DeferTaskUntil,
    options: { businessScope?: boolean } = {}): Promise<TaskView> {
    const actor = await this.authorized(credential, 'manage');
    if (actor.role !== 'gm') throw new CompanyError('forbidden', 'Only gm may defer blocked tasks');
    requireText(input.taskId, 'task', 1, 200);
    requireText(input.text, 'text', 20, 8000);
    requireText(input.idempotencyKey, 'idempotencyKey', 1, 200);
    if (input.expectedVersion !== undefined && !Number.isSafeInteger(input.expectedVersion)) {
      throw new CompanyError('invalid', 'Invalid expectedVersion');
    }
    if (input.continuation !== undefined && !['execute', 'manager'].includes(input.continuation)) throw new CompanyError('invalid', 'Invalid dependency continuation');
    const dependencies = [...new Set(input.dependencies ?? [])];
    if (!dependencies.length || dependencies.length > 20) {
      throw new CompanyError('invalid', 'defer requires 1-20 dependencies');
    }
    if (dependencies.includes(input.taskId)) throw new CompanyError('invalid', 'A task cannot wait on itself');
    // SYS03 AC02/AC05（QA V4）：处置驱动的 defer 幂等身份按业务键算，不掺发起人的员工 ID——接管者重放
    // 同一条决定时必须读到同一份结果，而不是撞上「任务版本已动」。
    const idem = options.businessScope
      ? this.businessIdemId('defer', input.idempotencyKey)
      : this.idemId(actor.employeeId, 'defer', input.idempotencyKey);
    const digest = HASH(JSON.stringify({ taskId: input.taskId, dependencies, text: input.text, expectedVersion: input.expectedVersion, continuation: input.continuation }));
    const replayed = await this.replay(idem, digest);
    if (replayed) return replayed;

    const depIds = dependencies.map(dep => id('task', dep));
    const taskRef = id('task', input.taskId);
    // Every defer mutates the dependency graph. A durable epoch, checked and advanced
    // inside the write transaction, serialises those mutations: a request built from an
    // older graph cannot commit a cycle after a concurrent defer has landed.
    const [epochRow] = await this.db.query<[{ value?: number } | undefined]>(
      'SELECT * FROM ONLY company_meta:defer_epoch;');
    const epochSeen = epochRow?.value ?? 0;

    // Fast-fail with a readable reason plus the audit snapshot; the transaction re-checks
    // every guard atomically, so a stale pre-read can never turn into a wrong write.
    type DeferredRow = {
      state: TaskState; blocked_to?: 'gm' | 'owner'; resume_state?: TaskState; resume_role?: string;
      submitted_by?: string; reviewer_role: ReviewerRole; current_employee?: string;
      lease_expires_at?: number; version: number; dependencies?: RecordId[]; goal?: RecordId; goal_state?: string; execution_window?: unknown;
    };
    // `FROM ONLY` yields the record itself (or NONE), not a list.
    const [before] = await this.db.query<[DeferredRow | undefined]>(
      'SELECT state, blocked_to, resume_state, resume_role, submitted_by, reviewer_role, current_employee, lease_expires_at, version, dependencies, goal, goal.state AS goal_state, execution_window FROM ONLY $task;',
      { task: taskRef });
    if (!before) throw new CompanyError('not_found', 'Task not found');
    if (before.state !== 'blocked' || before.blocked_to !== 'gm' || !['doing', 'ready', 'review'].includes(before.resume_state ?? '')) {
      throw new CompanyError('invalid', 'defer only applies to gm-blocked execute or normal review-phase tasks');
    }
    const phase = before.resume_state ?? 'ready';
    if (phase === 'review') await this.requireProvableReviewWait(taskRef, before);
    if (before.goal && before.goal_state !== 'active') throw new CompanyError('invalid', 'Task goal is not active');
    if (input.expectedVersion !== undefined && before.version !== input.expectedVersion) {
      throw new CompanyError('conflict', 'Task version moved');
    }
    const beforeDeps = (before.dependencies ?? []).map(normalizedId);
    const after = [...new Set([...beforeDeps, ...dependencies])];
    const evidence = `${input.text}\n[defer] 操作者=${actor.employeeId} 来源phase=${phase} 依赖 before=[${beforeDeps.join(', ')}] after=[${after.join(', ')}] 恢复阶段=${phase}`;

    const [depRows] = await this.db.query<[Array<{ id: RecordId; goal?: RecordId }>]>(
      'SELECT id, goal FROM task WHERE id IN $ids;', { ids: depIds });
    const depById = new Map((depRows ?? []).map(row => [normalizedId(row.id), row]));
    for (const dep of dependencies) {
      const row = depById.get(dep);
      if (!row) throw new CompanyError('not_found', `Dependency not found: ${dep}`);
      // normalizedId maps a missing goal to '' on both sides, so goal-less tasks pair with goal-less deps.
      if (normalizedId(row.goal) !== normalizedId(before.goal)) {
        throw new CompanyError('invalid', 'Dependencies must live in the same goal as the task');
      }
    }
    // The deferred task must not be reachable from its own new dependencies: walk the
    // resolved dependency closure of the proposed deps (superseded_by -> lineage tip)
    // and refuse a path back to the task.
    const seen = new Set(dependencies);
    let frontier = [...dependencies];
    for (let depth = 0; frontier.length && depth < 32; depth++) {
      const graph = await this.dependencyGraph(frontier);
      if (graph.has(input.taskId)) throw new CompanyError('invalid', 'Dependencies would create a cycle after revision resolution');
      const next = [...new Set([...graph.values()].flat())].filter(d => !seen.has(d));
      if (next.includes(input.taskId)) throw new CompanyError('invalid', 'Dependencies would create a cycle');
      for (const key of graph.keys()) seen.add(key);
      for (const n of next) seen.add(n);
      frontier = next;
    }

    const row = await this.txTask(`BEGIN;
      LET $who = SELECT * FROM ONLY $actor;
      LET $t = SELECT * FROM ONLY $task;
      IF $who = NONE OR $who.revoked = true OR $who.role != 'gm' OR $t = NONE { THROW 'defer denied' };
      IF $t.state != 'blocked' OR $t.blocked_to != 'gm' OR $t.resume_state NOT IN ['doing', 'ready', 'review'] { THROW 'defer denied: only gm-blocked execute or normal review-phase tasks can wait on dependencies' };
      IF $t.current_employee != NONE AND $t.lease_expires_at > time::unix(time::now()) { THROW 'defer denied: the task still holds an active lease' };
      IF $t.resume_state = 'review' {
        IF $t.reviewer_role = 'owner' OR $t.submitted_by = NONE { THROW 'defer denied: review block is not an ordinary submitted review' };
        IF $t.resume_role != NONE AND $t.resume_role != $t.reviewer_role { THROW 'defer denied: review block role mismatch' };
        LET $sub = SELECT * FROM audit WHERE task = $task AND action = 'submit' ORDER BY at DESC LIMIT 1;
        IF array::len($sub) = 0 { THROW 'defer denied: original submission missing' };
        IF $sub[0].actor != $submitted_ref OR $t.submitted_by != $submitted_by { THROW 'defer denied: original submission snapshot mismatch' };
        IF $sub[0].version = NONE OR $sub[0].version > $t.version { THROW 'defer denied: original submission snapshot is newer than the task' };
        LET $blk = SELECT * FROM audit WHERE task = $task AND action = 'block' ORDER BY at DESC LIMIT 1;
        IF array::len($blk) = 0 OR $blk[0].phase != 'review' { THROW 'defer denied: original review block is not provable' };
        IF $blk[0].at <= $sub[0].at { THROW 'defer denied: original review block predates the submission' };
        LET $blk_actor = SELECT * FROM ONLY $blk[0].actor;
        IF $blk_actor = NONE OR $blk_actor.role != $t.reviewer_role { THROW 'defer denied: review block actor role mismatch' };
      };
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
      LET $epoch = SELECT * FROM ONLY company_meta:defer_epoch;
      LET $epoch_value = $epoch.value ?? 0;
      IF $epoch_value != $epoch_seen { THROW 'defer graph moved: retry' };
      IF $epoch = NONE {
        CREATE ONLY company_meta:defer_epoch CONTENT { value: 1 };
      } ELSE {
        UPDATE ONLY company_meta:defer_epoch SET value = $epoch_value + 1;
      };
      LET $new_deps = array::complement($dependencies, $t.dependencies ?? []);
      ${RESOLVE_DEP_SQL('$new_deps', '$new_dep')}
      LET $new_unmet = SELECT VALUE id FROM task WHERE id IN $new_dep_resolved AND ${depUnsatisfiedFor('$t')};
      IF $t.recovery_stopped = true AND array::len($new_unmet) = 0 AND $continuation != 'manager' { THROW 'automatic recovery stopped: no new unmet prerequisite' };
      LET $m_phase = $t.resume_state ?? 'ready';
      LET $restore_phase = IF $m_phase = 'review' THEN 'review' ELSE 'ready' END;
      LET $manager = $continuation = 'manager';
      LET $next_resume_state = IF $manager OR (array::len($remaining) > 0 AND $m_phase = 'review') THEN $m_phase ELSE NONE END;
      LET $next = UPDATE ONLY $task SET
        dependencies = $merged,
        state = IF array::len($remaining) = 0 AND !$manager THEN $restore_phase ELSE 'blocked' END,
        blocked_to = IF array::len($remaining) = 0 AND $manager THEN 'gm' ELSE NONE END,
        dependency_continuation = IF array::len($remaining) > 0 THEN $continuation ELSE NONE END,
        resume_state = $next_resume_state,
        resume_role = NONE,
        current_employee = NONE, delivery_id = NONE, lease_expires_at = NONE,
        version = $t.version + 1 RETURN AFTER;
      IF array::len($new_unmet) > 0 {
        CREATE audit CONTENT { task: $task, actor: $actor, action: 'recovery_progress', evidence: '新增真实未完成前置，进入新恢复阶段', at: time::now() };
        UPDATE ONLY $task SET recovery_stopped = NONE;
      };
      CREATE ONLY $audit CONTENT { task: $task, actor: $actor, action: 'deferred', evidence: $evidence, version: $next.version, at: time::now(),
        source_phase: $m_phase, restore_phase: $restore_phase, dependencies_before: $before_refs,
        dependencies_after: $merged, result: $next.state, operator: $employee };
      LET $sequence = UPDATE ONLY company_meta:outbox_counter SET value += 1 RETURN AFTER;
      CREATE ONLY $outbox CONTENT { task: $task, kind: 'deferred', sequence: $sequence.value,
        payload: { state: $next.state, source_phase: $m_phase, restore_phase: $restore_phase,
          dependencies_before: $before_refs, dependencies_after: $merged, operator: $employee, added: $added }, at: time::now() };
      CREATE ONLY $idem CONTENT { at: time::now(), payload_digest: $digest, result: $next };
      RETURN $next;
      COMMIT;`, {
      actor: id('employee', actor.employeeId), employee: actor.employeeId, task: taskRef, expected: input.expectedVersion,
      continuation: input.continuation ?? (before.execution_window ? 'manager' : 'execute'), dependencies: depIds, evidence, added: dependencies.filter(dep => !beforeDeps.includes(dep)).length,
      before_refs: (before.dependencies ?? []).map(dep => id('task', normalizedId(dep))),
      submitted_ref: before.submitted_by ? id('employee', before.submitted_by) : undefined,
      submitted_by: before.submitted_by, epoch_seen: epochSeen,
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
    return echoTask(await this.retireTaskRecord(credential, input));
  }

  private async retireTaskRecord(credential: Credential, input: RetireTask,
    options: { businessScope?: boolean } = {}): Promise<TaskView> {
    const actor = await this.authorized(credential, 'manage');
    if (!['gm', 'product'].includes(actor.role)) throw new CompanyError('forbidden', 'Only gm or product may retire tasks');
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
        wait_state = NONE, wait_kind = NONE, wait_episode = NONE, wait_not_before = NONE,
        wait_expires_at = NONE, wait_next_check_at = NONE, wait_owner_role = NONE,
        wait_source = NONE, wait_version = NONE, wait_entered_at = NONE,
        version = $t.version + 1 RETURN AFTER;
      UPDATE task_wait SET state = 'cancelled', cancelled_reason = 'task retired', updated_at = time::now()
        WHERE task = $task AND state IN ['waiting', 'held', 'expired'];
      UPDATE employee SET active_task = NONE WHERE active_task = $task;
      ${UNLOCK_CHILDREN_SQL}
      CREATE ONLY $audit CONTENT { task: $task, actor: $actor, action: 'retire', evidence: $evidence, version: $next.version, at: time::now() };
      LET $sequence = UPDATE ONLY company_meta:outbox_counter SET value += 1 RETURN AFTER;
      CREATE ONLY $outbox CONTENT { task: $task, kind: 'retired', sequence: $sequence.value, payload: { state: 'void', retired_holder: $holder }, at: time::now() };
      CREATE ONLY $idem CONTENT { at: time::now(), payload_digest: $digest, result: $next };
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

  // ------------------------------------------------------------------ SYS03 经理处置账本
  // 经理对一个 blocking episode 的处置走这一组方法：先认领（episode 唯一、租约、版本），再带 CAS 与全局业务
  // 幂等键决定，最后由持久 outbox 通知当前持有人。授权与既有通道同源：角色与能力仍由本类判定，处置动作本身
  // 复用 resume/defer/retire/create 的既有状态机，不新增任何旁路写权。

  /**
   * The episode a task is currently blocked in must be the one being claimed: a manager may not claim, and therefore
   * decide, an episode the task is no longer in. A task carries its open episode as phase + start (unix seconds); a
   * task without one (never blocked, or already resumed) refuses every claim, which is how a late reminder to a
   * decided episode is turned away.
   */
  private async requireOpenEpisode(taskId: TaskId, phase: DispositionPhase, sinceMs: number): Promise<TaskRow> {
    const row = await this.db.select<TaskRow>(id('task', taskId));
    if (!row) throw new CompanyError('not_found', 'Task not found');
    if (row.state !== 'blocked') throw new CompanyError('conflict', 'The task is not blocked; there is no episode to dispose of');
    const openPhase = row.dispatch_blocked_phase === 'review' ? 'review' : row.dispatch_blocked_phase === 'execute' ? 'execute' : undefined;
    if (openPhase !== undefined && openPhase !== phase) {
      throw new CompanyError('conflict', `The open episode is in the ${openPhase} phase, not ${phase}`);
    }
    if (row.dispatch_blocked_since !== undefined && row.dispatch_blocked_since !== null) {
      const openSince = row.dispatch_blocked_since * 1000;
      // The task's open episode is newer than the one being claimed: this reminder is stale (the earlier episode is
      // already over), so the claim is refused instead of handing a manager a disposed episode.
      if (openSince > sinceMs) {
        throw new CompanyError('conflict', 'A newer episode has already started on this task; the reminder is stale');
      }
    }
    return row;
  }

  async claimDisposition(credential: Credential, input: DispositionClaimInput): Promise<DispositionClaimOutcome> {
    const actor = await this.authorized(credential, 'manage');
    if (!['gm', 'product'].includes(actor.role)) throw new CompanyError('forbidden', 'Manager disposition requires the gm or product role');
    await this.requireOpenEpisode(input.taskId, input.phase, input.sinceMs);
    return this.dispositions.claim(actor, input);
  }

  async releaseDisposition(credential: Credential,
    input: { taskId: TaskId; phase: DispositionPhase; sinceMs: number; claimToken: string; reason: string }): Promise<DispositionClaimView> {
    const actor = await this.authorized(credential, 'manage');
    if (!['gm', 'product'].includes(actor.role)) throw new CompanyError('forbidden', 'Manager disposition requires the gm or product role');
    return this.dispositions.release(actor, input);
  }

  async dispositionStatus(credential: Credential, input: DispositionStatusInput): Promise<DispositionStatusView> {
    const actor = await this.authorized(credential);
    // Managers read the episode's outcome (that is the whole point of a stale snapshot being repairable), and so does
    // anyone who is a party of the task; only the holder ever receives the claim token.
    const row = await this.db.select<TaskRow>(id('task', input.taskId));
    if (!row) throw new CompanyError('not_found', 'Task not found');
    const manager = actor.role === 'gm' || actor.role === 'product';
    if (!manager && actor.role !== row.executor_role && actor.role !== row.reviewer_role && row.current_employee !== actor.employeeId) {
      throw new CompanyError('forbidden', 'Task access denied');
    }
    return this.dispositions.status(actor, input);
  }

  /**
   * A decided episode needs a manager's decision to still be worth a session: the claim's role gate mirrors the action's
   * own gate (resume/defer/repair are gm work; retire is gm/product work), and the delegated record methods re-check it in
   * their transactions, so a claim never widens anyone's authority over the task.
   */
  async decideDisposition(credential: Credential, input: DispositionDecideInput): Promise<DispositionDecideOutcome> {
    const actor = await this.authorized(credential, 'manage');
    const manager = actor.role === 'gm' || actor.role === 'product';
    if (!manager) throw new CompanyError('forbidden', 'Manager disposition requires the gm or product role');
    if (input.action !== 'retire' && actor.role !== 'gm') throw new CompanyError('forbidden', 'Only gm may resume, defer, wait on dependencies or build a repair chain');
    return this.dispositions.decide(actor, input, this.dispositionApplier(credential));
  }

  async dispositionNotices(credential: Credential, input?: { ids?: string[] }): Promise<HolderNoticeView[]> {
    const actor = await this.authorized(credential);
    const pending = await this.dispositions.noticesFor(actor.employeeId);
    return input?.ids ? pending.filter(notice => input.ids!.includes(notice.noticeKey)) : pending;
  }

  async ackDispositionNotices(credential: Credential, input: { ids: string[]; error?: string }): Promise<{ delivered: number }> {
    const actor = await this.authorized(credential);
    if (!Array.isArray(input.ids) || input.ids.length === 0 || input.ids.length > 100) throw new CompanyError('invalid', 'ids must hold 1-100 notice keys');
    const mine = new Set((await this.dispositions.noticesFor(actor.employeeId, 200)).map(notice => notice.noticeKey));
    // Only the holder's own notices can be acknowledged: a leaked key must not let another employee mark anyone's notice delivered.
    const owned = input.ids.filter(key => mine.has(key));
    if (owned.length !== input.ids.length) throw new CompanyError('forbidden', 'Notices may only be acknowledged by their holder');
    return { delivered: await this.dispositions.markNotices(owned, { agent: actor.employeeId, error: input.error }) };
  }

  /**
   * The controlled external-action entry point for employees (AC03): the run may be cancelled by a manager, or by the
   * employee who holds, implemented or submitted the task the run belongs to — the same people the existing owner
   * channel already lets report on that task. Anyone outside that set is refused here, and the record keeps the real
   * internal employee id; the shared provider account is never recorded as a person.
   */
  async cancelCiRun(credential: Credential, input: ExternalActionRequestInput): Promise<ExternalActionView> {
    const actor = await this.authorized(credential);
    return this.dispositions.requestExternalAction(actor, input, this.externalActionGateway(),
      async (prerequisite, target) => {
      if (!prerequisite) throw new CompanyError('forbidden', 'Cancelling a CI run requires manager capability or the task the run belongs to');
      const task = await this.db.select<TaskRow>(id('task', prerequisite.taskId));
      if (!task) throw new CompanyError('not_found', 'Prerequisite task not found');
      // 当事人这一关只对非经理生效。
      if (actor.role !== 'gm' && actor.role !== 'product') {
        // 当事人只认「这个人跟这条任务有关系」：当前持有人、实现者、提交人。**不再**拿岗位与任务的执行岗/评审岗比对——
        // 那等于让任何一个同岗位员工对仓库里任何一条任务都成为当事人，于是任何 engineering 员工都能取消任意 run（QA V2）。
        const mine = task.current_employee === actor.employeeId || task.implementer === actor.employeeId ||
          task.submitted_by === actor.employeeId;
        if (!mine) throw new CompanyError('forbidden', 'Cancelling this CI run requires being a party of the task it belongs to');
      }
      // 经理（gm/product）按设计不受 run↔任务绑定约束：他们的取消权本来就是仓库级的应急动作，而记录里仍然有前置任务、
      // 前置版本与真实员工 ID。绑定核对是对**非经理当事人**的约束——防止任何员工把别人的 run 说成自己任务的 run。
      // 依据照实记成 manager_exempt，不假装核过绑定。
      if (actor.role === 'gm' || actor.role === 'product') return { binding: 'manager_exempt' as const };
      // 绑定核对：run 必须绑定到这条前置任务，head 分支要等于任务登记的树分支。任务没有登记分支时失败关闭——
      // 没有可核对的身份就不能声称这条 run 属于它（QA V2）。
      const branch = task.worktree?.branch;
      if (!branch) {
        throw new CompanyError('forbidden', 'Cancelling a CI run requires the prerequisite task to have a registered branch to bind the run to');
      }
      const observed = await this.externalActionGateway().observeRun(target);
      // QA D4：读得到、但 provider 说不存在这条 run 是一个**确定的**事实（不是「读不出来」），所以要放它走到网关，
      // 由网关落成 refused；只有真的读不出来（网络/权限）才是无法核对、必须在这里就拒绝的情形。
      if (observed.readable !== true) {
        const why = (observed as { error?: string }).error ?? 'the run is not readable';
        throw new CompanyError('forbidden', `The run ${target.repo}#${target.runId} could not be bound to task ${prerequisite.taskId}: ${why}`);
      }
      if (observed.exists === true && (observed.headBranch ?? '') !== branch) {
        throw new CompanyError('forbidden',
          `Run ${target.repo}#${target.runId} is on branch ${observed.headBranch ?? 'unknown'}, not the prerequisite task's registered branch ${branch}`);
      }
      // QA D5：仓库绑定。任务登记的仓库标识能比（GitHub slug，或能解析出 slug 的 remote）时必须与 run 的仓库相同；
      // 登记的是本地路径这类比不出 slug 的值时只按分支绑定，并把「依据是分支」如实写进审计证据，不谎称核过仓库。
      const declared = task.worktree?.repo ?? '';
      const declaredSlug = declared ? githubRepoSlug(declared) : undefined;
      if (declaredSlug && declaredSlug.toLowerCase() !== target.repo.toLowerCase()) {
        throw new CompanyError('forbidden',
          `Run ${target.repo}#${target.runId} is in repository ${target.repo}, not the prerequisite task's registered repository ${declaredSlug}`);
      }
      return { binding: declaredSlug ? 'repo+branch' as const : 'branch_only' as const };
    });
  }

  async reconcileCiRuns(credential: Credential, input: { runs: Array<{ repo: string; runId: string }> }) {
    // AC03/QA D6：对账是**写**账本的动作（它为带外变更建 unknown_actor 行），所以它和事后归因一样是经理的判断：
    // 普通员工不得用它往账本里写行。只读的那一面是 list_external_actions，不受影响。
    const actor = await this.authorized(credential, 'manage');
    if (actor.role !== 'gm' && actor.role !== 'product') {
      throw new CompanyError('forbidden', 'Reconciling external actions requires the gm or product role');
    }
    if (!Array.isArray(input.runs) || input.runs.length === 0 || input.runs.length > 50) throw new CompanyError('invalid', 'runs must hold 1-50 entries');
    return this.dispositions.reconcileExternalActions(actor, input, this.externalActionGateway());
  }

  async attributeCiRun(credential: Credential, input: { actionKey: string; employeeId: string; evidence: string }): Promise<ExternalActionView> {
    // Attribution is a manager judgement on a real person's record: gm only, and never a fabricated internal owner.
    const actor = await this.authorized(credential, 'manage');
    if (actor.role !== 'gm') throw new CompanyError('forbidden', 'Attributing an out-of-band external action requires gm');
    return this.dispositions.attributeExternalAction(actor, input);
  }

  async listExternalActions(credential: Credential, input?: { actionKey?: string; state?: string; limit?: number }): Promise<ExternalActionView[]> {
    const actor = await this.authorized(credential);
    if (actor.role !== 'gm' && actor.role !== 'product') {
      // A non-manager sees only the actions it requested itself, never other employees' records.
      const [rows] = await this.db.query<[Array<Record<string, unknown>>]>(
        'SELECT * FROM external_action WHERE requested_by = $me ORDER BY created_at DESC LIMIT $limit;',
        { me: actor.employeeId, limit: input?.limit ?? 20 });
      return rows.map(row => this.dispositions.externalViewOf(row));
    }
    return this.dispositions.externalActions(input ?? {});
  }

  /** The controlled external exit. One implementation today: the company's authenticated `gh` CLI, injected for tests. */
  private externalActionGateway(): ExternalActionGateway {
    return this.externalActionsGateway ?? createCompanyGithubGateway();
  }

  /**
   * The disposition applier: the ledger decides WHO and WHEN, the existing state machine decides HOW. Every call goes
   * through the same record methods the manager tools use (with the manager's own credential), so leases, fences,
   * owner gates, independence, audit and outbox behave exactly as they do on the direct tools — and the idempotency key
   * is derived from the disposition's business key, so a replay or an employee change reads the same row instead of
   * writing a second one.
   */
  private dispositionApplier(credential: Credential): DispositionApplier {
    const withKey = (text: string, businessKey: string) => `${text}\n[disposition] business_key=${businessKey}`;
    return {
      resume: async ({ taskId, text, idempotencyKey }) => {
        const row = await this.resumeRecord(credential, taskId, { text: withKey(text, idempotencyKey), idempotencyKey },
          { businessScope: true });
        return { taskVersion: row.version, state: row.state };
      },
      defer: async ({ taskId, text, dependencies, expectedTaskVersion, idempotencyKey }) => {
        const row = await this.deferTaskUntilRecord(credential, {
          taskId, dependencies, text: withKey(text, idempotencyKey), idempotencyKey, expectedVersion: expectedTaskVersion,
        }, { businessScope: true });
        return { taskVersion: row.version, state: row.state };
      },
      retire: async ({ taskId, text, expectedTaskVersion, idempotencyKey }) => {
        const row = await this.retireTaskRecord(credential, {
          taskId, text: withKey(text, idempotencyKey), idempotencyKey, expectedVersion: expectedTaskVersion,
        }, { businessScope: true });
        return { taskVersion: row.version, state: row.state };
      },
      repair: async ({ repairKey, taskId, text, expectedTaskVersion, repair }) => {
        const created = await this.createTaskRecord(credential, {
          title: repair.title,
          context: `${repair.context}\n\n[来源] episode 处置 ${repairKey}；原任务 ${taskId}；处置说明：${text}`,
          executorRole: repair.executorRole as Role,
          reviewerRole: repair.reviewerRole as ReviewerRole,
          dependencies: repair.dependencies,
          discipline: repair.discipline,
          goalId: repair.goalId,
          project: repair.project,
          workIntent: repair.workIntent,
          idempotencyKey: `disposition-repair:${repairKey}`,
        }, { repairKey });
        // 原任务在本决定里换一种等待：门禁解除，改为等修复链。这样原 episode 真的结束了——旧版（不认识处置账本）
        // 读到的也是一个"等待中"的任务，而不是一个还在门禁里的任务，回滚后不会再为它拉起经理（RB01）。
        // 只有仍挂在 gm 门禁上的原任务能这样改（defer 的既有前置条件）；owner 门禁、review 门禁或已终态的任务保持原样，
        // 决定结果如实记下它当时的状态，绝不假装改过。
        const [source] = await this.db.query<[{ state?: string; blocked_to?: string; version?: number } | undefined]>(
          'SELECT state, blocked_to, version FROM ONLY $t;', { t: id('task', taskId) });
        if (source?.state === 'blocked' && source.blocked_to === 'gm') {
          const deferred = await this.deferTaskUntilRecord(credential, {
            taskId,
            dependencies: [created.id],
            text: withKey(`已建修复链 ${created.id}，原任务改为等待该修复完成后再继续`, `source:${repairKey}`),
            idempotencyKey: `disposition-source:${repairKey}`,
            expectedVersion: expectedTaskVersion,
          }, { businessScope: true });
          return { taskId: created.id, sourceTaskVersion: deferred.version, sourceState: deferred.state };
        }
        return { taskId: created.id, sourceTaskVersion: source?.version, sourceState: source?.state };
      },
    };
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
        CREATE ONLY $idem CONTENT { at: time::now(), payload_digest: $digest, result: $result };
        RETURN $result;
        COMMIT;`, vars);
      return result;
    } catch (error) {
      const replayedAfterFailure = await this.replayStored<GoalAcceptanceResult>(idem, digest);
      if (replayedAfterFailure) return replayedAfterFailure;
      throw error;
    }
  }

  // ---------------------------------------------------------------- SYS07: goal governance / metrics

  private async requireGoalManager(credential: Credential): Promise<{ employeeId: string }> {
    const actor = await this.authorized(credential, 'manage');
    if (actor.role !== 'gm') throw new CompanyError('forbidden', '只有经理（gm）可以读写目标终验图与成果证据');
    return actor;
  }

  private async goalFinalizeSafe(goalId: string | undefined, actor: string, acceptedTaskId?: string): Promise<void> {
    if (!goalId) return;
    try {
      await this.goals.finalize(goalId, actor, acceptedTaskId);
    } catch (error) {
      console.warn(`goal finalize failed for ${goalId}: ${(error as Error).message}`);
    }
  }

  private async saveGoalIdem(idem: RecordId, digest: string, result: unknown): Promise<void> {
    await this.db.query('CREATE ONLY $idem CONTENT { at: time::now(), payload_digest: $digest, result: $result };',
      { idem, digest, result }).catch(() => undefined);
  }

  /** SYS07: one paged read-only goal console. */
  async goalConsole(credential: Credential, input: GoalConsoleQuery = {}): Promise<GoalPageView> {
    await this.requireGoalManager(credential);
    try {
      return await this.goals.page({
        ...(input.goalId ? { goalId: input.goalId } : {}),
        ...(input.includeClosed === undefined ? {} : { includeClosed: input.includeClosed }),
        ...(input.needsRepairOnly === undefined ? {} : { needsRepairOnly: input.needsRepairOnly }),
        ...(input.pageSize === undefined ? {} : { pageSize: input.pageSize }),
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      });
    } catch (error) {
      throw new CompanyError('invalid', (error as Error).message);
    }
  }

  /** SYS07: read-only dry-run over active, needs_repair and done goals; never changes a goal, task or owner decision. */
  async goalGovernanceScan(credential: Credential, input: GoalScanQuery = {}): Promise<GoalScanView> {
    await this.requireGoalManager(credential);
    try {
      return await this.goals.scan(input);
    } catch (error) {
      throw new CompanyError('invalid', (error as Error).message);
    }
  }

  /** SYS07: windowed metrics with explicit denominators, coverage and unknown cost. */
  async goalMetrics(credential: Credential, input: GoalMetricsQuery = {}): Promise<GoalMetricsAnswer> {
    await this.requireGoalManager(credential);
    const now = Date.now();
    const to = input.to ?? new Date(now).toISOString();
    const from = input.from ?? new Date(now - 30 * 86_400_000).toISOString();
    for (const [name, value] of [['from', from], ['to', to]] as const) {
      if (!/(Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) {
        throw new CompanyError('invalid', `${name} 必须是带时区偏移的绝对时刻`);
      }
    }
    const timezone = input.timezone ?? 'UTC';
    if (!isTimeZone(timezone)) throw new CompanyError('invalid', 'timezone 必须是 IANA 时区');
    try {
      const view = await this.goals.metrics({ from, to, timezone, explicit: input.from !== undefined || input.to !== undefined,
        ...(input.goalId ? { goalId: input.goalId } : {}) });
      // Small windows keep the existing whole view. A full answer over the response budget is never cut: the caller
      // gets a section index and reads each section (paging its lists) until it has the whole window.
      if (!input.section && answerBytes(view) <= RESPONSE_BUDGET_BYTES) return view;
      return segmentGoalMetrics(view, {
        ...(input.section ? { section: input.section } : {}),
        ...(input.pageSize !== undefined ? { pageSize: input.pageSize } : {}),
        ...(input.cursor ? { cursor: input.cursor } : {}),
        scope: `${from}\0${to}\0${timezone}\0${input.goalId ?? ''}`,
      });
    } catch (error) {
      throw new CompanyError('invalid', (error as Error).message);
    }
  }

  /** SYS07: register or replace a goal's outcome contract under a version CAS. */
  async goalOutcomeRegister(credential: Credential, input: GoalOutcomeRegisterInput): Promise<GoalOutcomeView> {
    const actor = await this.requireGoalManager(credential);
    requireText(input.goalId, 'goalId', 1, 100);
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
      throw new CompanyError('invalid', 'expectedVersion 必须是非负整数');
    }
    requireText(input.reason, 'reason', 10, 2000);
    assertNonSensitive(input.reason, 'reason');
    const idem = this.idemId(actor.employeeId, 'goal_outcome_register', input.idempotencyKey);
    const digest = HASH(JSON.stringify({ goalId: input.goalId, expectedVersion: input.expectedVersion,
      expected: input.expected, requiredEvidence: input.requiredEvidence, responsibleRole: input.responsibleRole,
      deadline: input.deadline, timezone: input.timezone, reason: input.reason }));
    const prior = await this.replayStored<GoalOutcomeView>(idem, digest);
    if (prior) return prior;
    let result: GoalOutcomeView;
    try {
      result = await this.goals.registerOutcome({
        goalId: input.goalId, expectedVersion: input.expectedVersion,
        outcome: {
          expected: input.expected, requiredEvidence: input.requiredEvidence, responsibleRole: input.responsibleRole,
          ...(input.deadline === undefined ? {} : { deadline: input.deadline }),
          ...(input.timezone === undefined ? {} : { timezone: input.timezone }), reason: input.reason,
        },
        actor: `employee:${actor.employeeId}`, source: actor.employeeId, reason: input.reason,
        auditId: randomUUID(), outboxId: randomUUID(),
      });
    } catch (error) {
      const message = (error as Error).message;
      if (/already registered|version moved|conflicted with another transaction|transaction conflict/i.test(message)) throw new CompanyError('conflict', message);
      if (/not available|not found/i.test(message)) throw new CompanyError('not_found', message);
      throw new CompanyError('invalid', message);
    }
    await this.saveGoalIdem(idem, digest, result);
    return result;
  }

  /** SYS07: one immutable outcome receipt from an authorized human/external source. */
  async goalEvidenceRecord(credential: Credential, input: GoalEvidenceRecordInput): Promise<GoalEvidenceFact> {
    const actor = await this.requireGoalManager(credential);
    requireText(input.goalId, 'goalId', 1, 100);
    requireText(input.reason, 'reason', 10, 2000);
    assertNonSensitive(input.reason, 'reason');
    const idem = this.idemId(actor.employeeId, 'goal_evidence_record', input.idempotencyKey);
    const digest = HASH(JSON.stringify({ goalId: input.goalId, kind: input.kind, summary: input.summary,
      source: input.source, confirmedBy: input.confirmedBy, evidenceType: input.evidenceType, at: input.at, taskId: input.taskId, reason: input.reason }));
    const prior = await this.replayStored<GoalEvidenceFact>(idem, digest);
    if (prior) return prior;
    let result: GoalEvidenceFact;
    try {
      result = await this.goals.recordEvidence({
        goalId: input.goalId,
        evidence: {
          kind: input.kind, summary: input.summary, source: input.source, confirmedBy: input.confirmedBy,
          evidenceType: input.evidenceType, ...(input.at === undefined ? {} : { at: input.at }),
          ...(input.taskId === undefined ? {} : { taskId: input.taskId }), reason: input.reason,
        },
        actor: `employee:${actor.employeeId}`, reason: input.reason, auditId: randomUUID(), outboxId: randomUUID(),
      });
    } catch (error) {
      const message = (error as Error).message;
      if (/already recorded|conflicted with another transaction|transaction conflict/i.test(message)) throw new CompanyError('conflict', message);
      if (/not found|not in this goal/i.test(message)) throw new CompanyError('not_found', message);
      throw new CompanyError('invalid', message);
    }
    await this.saveGoalIdem(idem, digest, result);
    return result;
  }

  /** SYS07: explicit re-evaluation after evidence/approval; marks done or needs_repair. */
  async goalFinalize(credential: Credential, input: GoalFinalizeInput): Promise<GoalCard> {
    const actor = await this.requireGoalManager(credential);
    requireText(input.goalId, 'goalId', 1, 100);
    try {
      return (await this.goals.finalize(input.goalId, `employee:${actor.employeeId}`)).card;
    } catch (error) {
      const message = (error as Error).message;
      if (/not found/i.test(message)) throw new CompanyError('not_found', message);
      throw new CompanyError('conflict', message);
    }
  }

  async goalFinalGatePreview(credential: Credential, input: GoalFinalGatePreviewInput): Promise<GoalFinalGatePreview> {
    await this.requireGoalManager(credential);
    requireText(input.goalId, 'goalId', 1, 100);
    try {
      return await this.goals.finalGatePreview({ goalId: input.goalId,
        ...(input.candidateTaskId === undefined ? {} : { candidateTaskId: input.candidateTaskId }) });
    } catch (error) {
      const message = (error as Error).message;
      if (/not found/i.test(message)) throw new CompanyError('not_found', message);
      throw new CompanyError('invalid', message);
    }
  }

  async goalFinalGateRepair(credential: Credential, input: GoalFinalGateRepairRequest): Promise<GoalFinalGateRepairResult> {
    const actor = await this.requireGoalManager(credential);
    requireText(input.goalId, 'goalId', 1, 100);
    requireText(input.candidateTaskId, 'candidateTaskId', 1, 200);
    requireText(input.reason, 'reason', 10, 2000);
    assertNonSensitive(input.reason, 'reason');
    if (!Number.isSafeInteger(input.expectedGoalVersion) || input.expectedGoalVersion < 0) {
      throw new CompanyError('invalid', 'expectedGoalVersion 必须是非负整数');
    }
    if (!/^[0-9a-f]{64}$/.test(input.snapshotHash)) throw new CompanyError('invalid', 'snapshotHash 必须来自预览');
    const idem = this.idemId(actor.employeeId, 'goal_final_gate_repair', input.idempotencyKey);
    const digest = HASH(JSON.stringify({ goalId: input.goalId, candidateTaskId: input.candidateTaskId,
      expectedOldTaskId: input.expectedOldTaskId, expectedGoalVersion: input.expectedGoalVersion,
      snapshotHash: input.snapshotHash, reason: input.reason }));
    const prior = await this.replayStored<GoalFinalGateRepairResult>(idem, digest);
    if (prior) return prior;
    let result: GoalFinalGateRepairResult;
    try {
      result = await this.goals.finalGateRepair({
        goalId: input.goalId, candidateTaskId: input.candidateTaskId,
        ...(input.expectedOldTaskId === undefined ? {} : { expectedOldTaskId: input.expectedOldTaskId }),
        expectedGoalVersion: input.expectedGoalVersion, snapshotHash: input.snapshotHash,
        reason: input.reason, actor: `employee:${actor.employeeId}`, idempotencyKey: input.idempotencyKey,
      });
    } catch (error) {
      const message = (error as Error).message;
      if (/moved|changed/i.test(message)) throw new CompanyError('conflict', message);
      throw new CompanyError('invalid', message);
    }
    await this.saveGoalIdem(idem, digest, result);
    return result;
  }

  /**
   * Manager write of a task's independence policy (SYS-DISP IR01). Manage capability only. Creates the first policy, or replaces the
   * current one under a compare-and-set on the task version. Refused while the task is leased, so a lease is never changed silently.
   * An accepted write bumps the revision and the version in one transaction with its audit row; the same key and payload replay.
   */
  // ---- 有效策略层（SYS06 P1）----
  // 判定只用 policy 表里的受限字段：提示词、context、任务标题都不是授权来源，改提示内容不改变允许/拒绝。
  // 写入只走 manage 能力持有者；老板来源的策略必须能对回一条已登记的老板方向（伪造引文被拒）。

  /** 策略作用域链：任务 → 目标 → 项目 → 公司，越靠前越具体，命中即覆盖更宽的域。 */
  // 读取与判定都在 policy-store.ts / policy.ts：调度器（workforce）读的是同一批行、同一份判定。
  private policyChain(input: { taskId?: string; goalId?: string; projectId?: string; includeTask?: boolean }): PolicyScopeLink[] {
    return policyScopeChain(input);
  }

  private chainOfRow(row: Pick<TaskRow, 'id' | 'goal' | 'project' | 'goal_project'>): PolicyScopeLink[] {
    return chainOfTaskRow(row);
  }

  private readPolicyRows(chain: readonly PolicyScopeLink[]): Promise<PolicyRow[]> {
    return readPolicyRows(this.db, chain);
  }

  /** 单行动态读法：带上 goal.project 投影，策略作用域链需要它。 */
  private async taskRowWithProject(taskId: string): Promise<(TaskRow & { goal_project?: RecordId }) | undefined> {
    return await readTaskPolicyRow(this.db, taskId) as (TaskRow & { goal_project?: RecordId }) | undefined;
  }

  private policyEpoch(): Promise<number> {
    return readPolicyEpoch(this.db);
  }

  private effectiveContractFor(chain: readonly PolicyScopeLink[]): Promise<{ contract: EffectiveContract; rows: PolicyRow[]; epoch: number }> {
    return readEffectiveContract(this.db, chain, Math.floor(Date.now() / 1000));
  }

  /** 契约视图 + 人读说明：到期与被替代的当前事实写在 notes 里，机器判定只看 domains。 */
  private policyEffectiveView(chain: Array<{ scope: PolicyScope; scopeRef?: string }>, contract: EffectiveContract, rows: PolicyRow[]): PolicyEffectiveView {
    const now = Math.floor(Date.now() / 1000);
    const notes: string[] = [];
    for (const row of rows) {
      if (row.status === 'revoked') notes.push(`${row.policyId} v${row.version} 已撤销（${row.revokeReason ?? '无原因'}），不再授权`);
      else if (row.supersededBy) notes.push(`${row.policyId} v${row.version} 已被替代，历史可查，不再授权`);
      else if (row.expiresAt !== undefined && row.expiresAt <= now) notes.push(`${row.policyId} v${row.version} 临时授权已于 ${new Date(row.expiresAt * 1000).toISOString()} 到期`);
      else if (row.effectiveAt > now) notes.push(`${row.policyId} v${row.version} 将于 ${new Date(row.effectiveAt * 1000).toISOString()} 生效`);
    }
    return { version: contract.version, hash: contract.hash, chain, domains: contract.domains, rendered: renderContract(contract), notes: [...new Set(notes)] };
  }

  /**
   * 提案校验（写入与试算共用）：作用域引用存在、来源可核、版本单调、替代关系显式且不越权/不成环、同域冲突必须显式替代。
   * 只读，写任何东西之前先把事实查清楚——迁移现有冲突配置时先列事实与候选，不自动决定优先级。
   */
  private async validatePolicyProposal(actor: Principal, input: PolicyPlanInput): Promise<{ chain: PolicyScopeLink[]; rows: PolicyRow[]; epoch: number; version: number; target?: PolicyRow }> {
    if (!['gm', 'product'].includes(actor.role)) throw new CompanyError('forbidden', 'Only a manager may write a machine policy');
    requireText(input.policyId, 'policyId', 3, 60);
    if (!POLICY_ID_PATTERN.test(input.policyId)) throw new CompanyError('invalid', 'policyId must be lowercase letters, digits, hyphen or underscore');
    if (!POLICY_SCOPES.includes(input.scope)) throw new CompanyError('invalid', `unknown policy scope: ${input.scope}`);
    if (!POLICY_DOMAINS.includes(input.domain)) throw new CompanyError('invalid', `unknown policy domain: ${input.domain}`);
    if (input.scope === 'company') {
      if (input.scopeRef !== undefined) throw new CompanyError('invalid', 'company scope carries no scopeRef');
    } else {
      requireText(input.scopeRef ?? '', 'scopeRef', 1, 200);
      if (input.scope === 'project' && !(await this.projects.get(input.scopeRef!))) {
        throw new CompanyError('not_found', `project ${input.scopeRef} not found`);
      }
      if (input.scope === 'goal' && !(await this.db.select(id('goal', input.scopeRef!)))) {
        throw new CompanyError('not_found', `goal ${input.scopeRef} not found`);
      }
      if (input.scope === 'task' && !(await this.db.select(id('task', input.scopeRef!)))) {
        throw new CompanyError('not_found', `task ${input.scopeRef} not found`);
      }
    }
    const payload = normalizePayload(input.payload);
    const domain = domainOfPayload(payload);
    if (domain !== input.domain) throw new CompanyError('invalid', `payload kind ${domain} does not match domain ${input.domain}`);
    if (!POLICY_SOURCES.includes(input.source)) throw new CompanyError('invalid', `unknown authorization source: ${input.source}`);
    if (input.source === 'owner') {
      if (actor.role !== 'gm') throw new CompanyError('forbidden', 'Only gm may transcribe an owner direction into a policy');
      requireText(input.ownerQuote ?? '', 'ownerQuote', 2, 4000);
      const [matched] = await this.db.query<[Array<{ id: RecordId }>]>(
        'SELECT id FROM direction WHERE string::contains(text, $quote) LIMIT 1;', { quote: input.ownerQuote });
      if (!matched?.length) throw new CompanyError('forbidden', 'ownerQuote 与任何已登记的老板方向都不匹配：伪造的引文不能作为授权来源');
    }
    const now = Math.floor(Date.now() / 1000);
    const effectiveAt = input.effectiveAt === undefined ? now : Math.floor(Date.parse(input.effectiveAt) / 1000);
    if (!Number.isFinite(effectiveAt)) throw new CompanyError('invalid', 'effectiveAt is not a valid time');
    const expiresAt = input.expiresAt === undefined ? undefined : Math.floor(Date.parse(input.expiresAt) / 1000);
    if (expiresAt !== undefined && !Number.isFinite(expiresAt)) throw new CompanyError('invalid', 'expiresAt is not a valid time');
    if (expiresAt !== undefined && expiresAt <= effectiveAt) throw new CompanyError('invalid', 'expiresAt must be after effectiveAt');
    if (input.supersedes === undefined && input.domain === 'write_authority' && payload.kind === 'write_authority' && payload.codeRoles.length === 0) {
      // 空的 codeRoles 是"冻结代码写权"的合法收紧，但必须显式说明原因，且只能由老板来源授权。
      if (input.source !== 'owner') throw new CompanyError('forbidden', 'Freezing all code writes requires an owner-sourced policy');
    }
    const chain = this.policyChain({ taskId: input.scope === 'task' ? input.scopeRef : undefined,
      goalId: input.scope === 'goal' ? input.scopeRef : undefined,
      projectId: input.scope === 'project' ? input.scopeRef : undefined, includeTask: input.scope === 'task' });
    const rows = await this.readPolicyRows(chain);
    const epoch = await this.policyEpoch();
    const versions = rows.filter(row => row.policyId === input.policyId).map(row => row.version);
    const version = (versions.length ? Math.max(...versions) : 0) + 1;
    let target: PolicyRow | undefined;
    if (input.supersedes !== undefined) {
      requireText(input.supersedes, 'supersedes', 1, 200);
      // 目标按 id 全局读：读不到才是 not_found；读到了但不在本次新版本的作用域链上，那是越权替代（forbidden），
      // 不能含糊成"找不到"——跨项目/跨目标的替代必须给出它自己的理由。
      const rawTarget = await this.db.select<PolicyDbRow>(id('policy', input.supersedes));
      if (!rawTarget) throw new CompanyError('not_found', 'supersedes target not found');
      target = policyRowView(rawTarget);
      if (target.domain !== domain) throw new CompanyError('conflict', `supersedes target governs ${target.domain}, not ${domain}`);
      const covered = chain.some(link => link.scope === target!.scope &&
        (link.scopeRef ?? '') === (target!.scopeRef ?? ''));
      if (!covered) throw new CompanyError('forbidden', 'cross-scope supersede refused: the target is outside this policy scope');
      if (target.status !== 'active' || target.supersededBy !== undefined) throw new CompanyError('conflict', 'supersedes target is no longer the active version');
      if (target.expiresAt !== undefined && target.expiresAt <= now) throw new CompanyError('conflict', 'supersedes target is an expired temporary policy');
      // 成环：目标的替代链上出现同一 policy id 的任何版本，说明谱系已经不是一条直线。
      const seen = new Set<string>([target.id]);
      let cursor = target.supersedes;
      for (let hop = 0; cursor !== undefined && hop < 64; hop++) {
        if (seen.has(cursor)) throw new CompanyError('conflict', 'policy supersede cycle detected');
        seen.add(cursor);
        const parent: PolicyRow | undefined = (await this.readPolicyRows(chain)).find(row => row.id === cursor);
        if (!parent) break;
        if (parent.policyId === input.policyId) throw new CompanyError('conflict', `policy supersede cycle: ${input.policyId} is already in the supersede chain`);
        cursor = parent.supersedes;
      }
    }
    const competing = rows.filter(row => row.domain === domain && row.scope === input.scope &&
      (row.scopeRef ?? '') === (input.scopeRef ?? '') && policyActiveAt(row, now) && row.id !== target?.id);
    if (competing.length) {
      throw new CompanyError('conflict',
        `an active ${domain} policy already governs ${input.scope}${input.scopeRef ? `:${input.scopeRef}` : ''} (${competing.map(row => `${row.policyId} v${row.version}`).join(', ')}); supersede it explicitly`);
    }
    return { chain, rows, epoch, version, target };
  }

  /** 写入一版机器策略：显式替代 + 同事务 CAS（epoch 与目标仍是活跃版本），历史只增不改。 */
  async policySet(credential: Credential, input: PolicySet): Promise<PolicyView> {
    const actor = await this.authorized(credential, 'manage');
    requireText(input.reason, 'reason', 2, 4000);
    const proposal: PolicyPlanInput = { policyId: input.policyId, scope: input.scope, scopeRef: input.scopeRef, domain: input.domain,
      payload: input.payload, supersedes: input.supersedes, effectiveAt: input.effectiveAt, expiresAt: input.expiresAt,
      source: input.source, ownerQuote: input.ownerQuote };
    // 幂等重放先于一切校验：同一个请求第二次来时，它引用的替代目标可能已经被它自己替代掉了，
    // 再走一遍校验就会把"重放"判成 conflict。摘要只覆盖调用方给的输入（版本号是读出来的派生状态，
    // 算进去会让重放因为版本已前进而失败）。
    const idem = this.idemId(actor.employeeId, 'policy_set', input.idempotencyKey);
    const digest = HASH(JSON.stringify(proposal));
    const prior = await this.replayPolicy(idem, digest);
    if (prior) return prior;
    const { epoch, version, target } = await this.validatePolicyProposal(actor, proposal);
    const payload = normalizePayload(input.payload);
    const domain = domainOfPayload(payload);
    const now = Math.floor(Date.now() / 1000);
    const effectiveAt = input.effectiveAt === undefined ? now : Math.floor(Date.parse(input.effectiveAt) / 1000);
    const expiresAt = input.expiresAt === undefined ? undefined : Math.floor(Date.parse(input.expiresAt) / 1000);
    const hash = policyHash({ policyId: input.policyId, version, scope: input.scope, scopeRef: input.scopeRef,
      domain, effectiveAt, expiresAt, payload });
    const policyId = randomUUID();
    const policy = id('policy', policyId);
    const evidence = `policy_set ${input.policyId} v${version} scope=${input.scope}${input.scopeRef ? `:${input.scopeRef}` : ''} domain=${domain} ` +
      `source=${input.source} supersedes=${target?.id ?? 'none'} hash=${hash.slice(0, 16)} epoch=${epoch} → ${epoch + 1}\n理由：${input.reason}`;
    // 可选字段用条件片段注入：SurrealDB 的 option<int> 不接受 NULL，option<record<policy>> 也不接受用 NULL 去
    // 取 ONLY（"Expected a single result output"）。没有替代目标时这两句根本不出现，语义上更贴近"没有这个字段"。
    const supersedeGuard = target ? `
          LET $t = SELECT * FROM ONLY $supersedes_arg;
          IF $t = NONE { THROW 'policy moved: supersede target not found' };
          IF $t.status != 'active' OR $t.superseded_by != NONE { THROW 'policy moved: supersede target is no longer the active version' };
          IF $t.domain != $domain { THROW 'policy conflict: supersede target governs another domain' };` : '';
    const competitorClause = target ? ' AND id != $supersedes_arg' : '';
    const supersedesField = target ? 'supersedes: $supersedes_arg,' : 'supersedes: NONE,';
    const expiresField = expiresAt === undefined ? '' : 'expires_at: $expires_at,';
    const closeOutTarget = target ? `UPDATE ONLY $supersedes_arg SET superseded_by = $policy, status = 'superseded';` : '';
    const vars = {
      actor: id('employee', actor.employeeId), policy, scope: input.scope, scope_ref: input.scopeRef ?? '',
      domain, effective_at: effectiveAt, version, hash,
      ...(expiresAt === undefined ? {} : { expires_at: expiresAt }),
      ...(target ? { supersedes_arg: id('policy', target.id) } : {}),
      authorization: { source: input.source, employeeId: actor.employeeId, at: now, ...(input.ownerQuote ? { ownerQuote: input.ownerQuote } : {}) },
      payload, policy_id: input.policyId, expected_epoch: epoch, evidence,
      idem, digest, audit: id('audit', randomUUID()),
    };
    try {
      const row = await this.txTask<PolicyDbRow>(`BEGIN;
        LET $who = SELECT * FROM ONLY $actor;
        IF $who = NONE OR $who.revoked = true OR 'manage' NOT IN $who.capabilities OR $who.role NOT IN ['gm', 'product'] { THROW 'policy denied: actor revoked or forbidden' };
        LET $epoch = (SELECT VALUE value FROM ONLY company_meta:policy_epoch) ?? 0;
        IF $epoch != $expected_epoch { THROW 'policy moved: the effective policy epoch moved since the proposal was read' };${supersedeGuard}
        LET $competing = SELECT VALUE id FROM policy WHERE domain = $domain AND scope = $scope
          AND (scope_ref ?? '') = $scope_ref AND status = 'active' AND superseded_by = NONE${competitorClause};
        IF array::len($competing) > 0 { THROW 'policy conflict: another active policy already governs this scope and domain' };
        LET $created = CREATE ONLY $policy CONTENT {
          policy_id: $policy_id, version: $version, scope: $scope, scope_ref: $scope_ref, domain: $domain,
          status: 'active', effective_at: $effective_at, ${expiresField}
          ${supersedesField} superseded_by: NONE, authorization: $authorization, payload: $payload,
          hash: $hash, created_by: $actor, created_at: time::now()
        };
        ${closeOutTarget}
        UPDATE ONLY company_meta:policy_epoch SET value = $epoch + 1;
        CREATE audit CONTENT { actor: $actor, action: 'policy_set', evidence: $evidence, at: time::now() };
        CREATE ONLY $idem CONTENT { at: time::now(), payload_digest: $digest, result: { id: $policy, version: $version } };
        RETURN $created;
        COMMIT;`, vars);
      return policyApiView(policyRowView(row));
    } catch (error) {
      const replay = await this.replayPolicy(idem, digest);
      if (replay) return replay;
      throw error;
    }
  }

  /**
   * 撤销一版当前有效的策略：紧急收权立即生效——epoch +1 后所有按旧契约登记的租约在下一次写动作前核版本时被拒。
   * 历史行仍在，只是不再是有效版本的授权依据。
   */
  async policyRevoke(credential: Credential, input: PolicyRevoke): Promise<PolicyView> {
    const actor = await this.authorized(credential, 'manage');
    if (!['gm', 'product'].includes(actor.role)) throw new CompanyError('forbidden', 'Only a manager may revoke a machine policy');
    requireText(input.policyId, 'policyId', 1, 200);
    requireText(input.reason, 'reason', 2, 4000);
    const idem = this.idemId(actor.employeeId, 'policy_revoke', input.idempotencyKey);
    const digest = HASH(JSON.stringify({ policyId: input.policyId, reason: input.reason }));
    const prior = await this.replayPolicy(idem, digest);
    if (prior) return prior;
    const current = (await this.db.select(id('policy', input.policyId))) as PolicyDbRow | undefined;
    if (!current) throw new CompanyError('not_found', 'Policy not found');
    if (current.status !== 'active') throw new CompanyError('conflict', 'Policy is not the active version');
    const evidence = `policy_revoke ${current.policy_id} v${current.version} by ${actor.employeeId}\n理由：${input.reason}`;
    try {
      const row = await this.txTask<PolicyDbRow>(`BEGIN;
        LET $who = SELECT * FROM ONLY $actor;
        IF $who = NONE OR $who.revoked = true OR 'manage' NOT IN $who.capabilities OR $who.role NOT IN ['gm', 'product'] { THROW 'policy denied: actor revoked or forbidden' };
        LET $t = SELECT * FROM ONLY $policy;
        IF $t = NONE { THROW 'policy not found' };
        IF $t.status != 'active' OR $t.superseded_by != NONE { THROW 'policy moved: not the active version' };
        LET $epoch = (SELECT VALUE value FROM ONLY company_meta:policy_epoch) ?? 0;
        LET $revoked = UPDATE ONLY $policy SET status = 'revoked', revoked_by = $actor, revoke_reason = $reason RETURN AFTER;
        UPDATE ONLY company_meta:policy_epoch SET value = $epoch + 1;
        CREATE audit CONTENT { actor: $actor, action: 'policy_revoke', evidence: $evidence, at: time::now() };
        CREATE ONLY $idem CONTENT { at: time::now(), payload_digest: $digest, result: { id: $policy, version: $t.version } };
        RETURN $revoked;
        COMMIT;`, {
        actor: id('employee', actor.employeeId), policy: id('policy', input.policyId), reason: input.reason,
        evidence, digest, idem,
      });
      return policyApiView(policyRowView(row));
    } catch (error) {
      const replay = await this.replayPolicy(idem, digest);
      if (replay) return replay;
      throw error;
    }
  }

  private async replayPolicy(ident: RecordId, digest: string): Promise<PolicyView | undefined> {
    const prior = await this.db.select<{ payload_digest: string; result: { id: RecordId } }>(ident);
    if (!prior) return undefined;
    if (prior.payload_digest !== digest) throw new CompanyError('conflict', 'Idempotency key reused with different input');
    const row = await this.db.select<PolicyDbRow>(prior.result.id);
    return row ? policyApiView(policyRowView(row)) : undefined;
  }

  /** 策略版本列表：默认只给当前有效（含各作用域链上生效的）版本；includeInactive 时连历史一起给。 */
  async policyList(credential: Credential, input: PolicyListInput): Promise<PolicyView[]> {
    const actor = await this.authorized(credential, 'manage');
    if (!['gm', 'product'].includes(actor.role)) throw new CompanyError('forbidden', 'Only a manager may read machine policies');
    const clauses: string[] = [];
    const vars: Record<string, unknown> = {};
    if (input.scope !== undefined) { clauses.push('scope = $scope'); vars.scope = input.scope; }
    if (input.scopeRef !== undefined) { clauses.push("(scope_ref ?? '') = $scope_ref"); vars.scope_ref = input.scopeRef; }
    if (input.domain !== undefined) { clauses.push('domain = $domain'); vars.domain = input.domain; }
    if (!input.includeInactive) clauses.push("status = 'active' AND superseded_by = NONE");
    const [rows] = await this.db.query<[PolicyDbRow[]]>(
      `SELECT * FROM policy${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY scope, domain, policy_id, version;`, vars);
    return (rows ?? []).map(row => policyApiView(policyRowView(row)));
  }

  /** 当前有效视图：给任务/项目/目标算出生效契约（含逐域渲染文本）；写不写策略都不影响它。 */
  async policyEffective(credential: Credential, input: PolicyEffectiveInput): Promise<PolicyEffectiveView> {
    const actor = await this.authorized(credential);
    let chain: Array<{ scope: PolicyScope; scopeRef?: string }>;
    if (input.taskId !== undefined) {
      const row = await this.db.select<TaskRow>(id('task', input.taskId));
      if (!row) throw new CompanyError('not_found', 'Task not found');
      if (actor.role !== row.executor_role && actor.role !== row.reviewer_role && !['gm', 'product', 'qa', 'eval'].includes(actor.role)) {
        throw new CompanyError('forbidden', 'Task policy access denied');
      }
      chain = this.chainOfRow(row);
    } else if (input.scopeChain !== undefined) {
      chain = input.scopeChain.map(link => ({ scope: link.scope, ...(link.scopeRef !== undefined ? { scopeRef: link.scopeRef } : {}) }));
    } else {
      if (!['gm', 'product'].includes(actor.role)) throw new CompanyError('forbidden', 'Only a manager may read a scope policy view');
      if (input.goal !== undefined && !(await this.db.select(id('goal', input.goal)))) throw new CompanyError('not_found', 'Goal not found');
      if (input.project !== undefined && !(await this.projects.get(input.project))) throw new CompanyError('not_found', 'Project not found');
      chain = this.policyChain({ goalId: input.goal, projectId: input.project, includeTask: false });
    }
    const { contract, rows } = await this.effectiveContractFor(chain);
    return this.policyEffectiveView(chain, contract, rows);
  }

  /** 变更试算：算出差量与受影响任务，写任何东西之前先给人看（只读）。 */
  async policyPlan(credential: Credential, input: PolicyPlanInput): Promise<PolicyPlanView> {
    const actor = await this.authorized(credential, 'manage');
    const plan = await this.computePolicyPlan(actor, input);
    return this.pagePolicyPlan(actor, input, plan);
  }

  /**
   * 试算的纯计算部分（只读、无分页）：契约 before/after、候选集扫描、全量受影响清单与 planHash。
   * policy_plan 的分页只是把这份全量清单裁成一页；planHash 始终覆盖全量，供翻页光标绑定与人工核对。
   * 它不是执行侧的 CAS：policy_enforce 不读 planHash，而是对每个点名任务按当时的有效契约重新判定。
   */
  private async computePolicyPlan(actor: Principal, input: PolicyPlanInput): Promise<Omit<PolicyPlanView, 'affectedTasks' | 'page'> & {
    affectedTasks: PolicyPlanView['affectedTasks']; scopeChain: PolicyPlanView['scopeChain'];
  }> {
    const { chain, target } = await this.validatePolicyProposal(actor, input);
    const payload = normalizePayload(input.payload);
    const domain = domainOfPayload(payload);
    const now = Math.floor(Date.now() / 1000);
    const effectiveAt = input.effectiveAt === undefined ? now : Math.floor(Date.parse(input.effectiveAt) / 1000);
    const expiresAt = input.expiresAt === undefined ? undefined : Math.floor(Date.parse(input.expiresAt) / 1000);
    const { contract: before, rows, epoch } = await this.effectiveContractFor(chain);
    const versions = rows.filter(row => row.policyId === input.policyId).map(row => row.version);
    const synthetic: PolicyRow = {
      id: 'policy:dry-run', policyId: input.policyId, version: (versions.length ? Math.max(...versions) : 0) + 1,
      scope: input.scope, scopeRef: input.scopeRef, domain, status: 'active', effectiveAt, expiresAt,
      supersedes: target?.id, authorization: { source: input.source, employeeId: actor.employeeId, at: now, ...(input.ownerQuote ? { ownerQuote: input.ownerQuote } : {}) },
      payload, hash: policyHash({ policyId: input.policyId, version: (versions.length ? Math.max(...versions) : 0) + 1,
        scope: input.scope, scopeRef: input.scopeRef, domain, effectiveAt, expiresAt, payload }), createdAt: now, createdBy: actor.employeeId,
    };
    const projected = rows.map(row => row.id === target?.id ? { ...row, status: 'superseded' as PolicyStatus, supersededBy: synthetic.id } : row);
    const after = resolveEffective([...projected, synthetic], chain, epoch + 1, now);
    // 候选集与派工/领取判定同源（R1）：判定侧对所有在办任务跑 dispatchVerdict，这里就不能按 policy_hash 预筛——
    // 上线前既存、没有策略登记的任务正是最需要被列出来的那批。分页读到底，读满上限时在视图里显式报告截断。
    const scan = await scanInFlightTasks<TaskRow & { goal_project?: RecordId }>(this.db);
    const affectedTasks: PolicyPlanView['affectedTasks'] = [];
    for (const row of scan.rows) {
      const task = view(row);
      const taskChain = this.chainOfRow(row);
      const next = resolveEffective([...projected, synthetic], taskChain, epoch + 1, now);
      if ((row.policy_hash ?? '') === next.hash) continue;
      // 与派工/领取同源：试算里的"失去授权"就是那次判定会拦下的情形（含域整体消失的到期/撤销）。
      const verdict = dispatchVerdict({ state: row.state, executorRole: task.executorRole, kind: task.kind,
        ...(task.goalId ? { goalId: task.goalId } : {}),
        ...(task.workIntent ? { workIntent: task.workIntent } : {}),
        ...(row.policy_hash ? { policyHash: row.policy_hash } : {}),
        ...(row.policy_block_reason ? { policyBlockReason: row.policy_block_reason } : {}),
        registeredDomains: registeredDomainsOf(row) }, next);
      affectedTasks.push({ id: task.id, title: task.title, state: task.state, currentEmployee: task.currentEmployee,
        fromHash: row.policy_hash ?? undefined, toHash: next.hash, losesAuthorization: verdict.verdict === 'blocked',
        ...(verdict.verdict === 'blocked' ? { reason: verdict.reason } : {}) });
    }
    const diff = contractDiff(before, after);
    const planHash = HASH(JSON.stringify({ epoch, after: after.hash, affected: affectedTasks.map(t => `${t.id}:${t.toHash}`).sort() }));
    return { scopeChain: chain, before, after, diff, affectedTasks, scanned: scan.scanned, scanLimit: scan.scanLimit,
      truncated: scan.truncated, planHash };
  }

  /**
   * 把全量试算裁成一页（SYS06 R1(b)）：受影响清单永远在 48 KiB 预算内返回，装不下就分页而不是整份拒绝。
   * 光标绑定调用者与同一份试算（planHash），所以翻页期间提案或 epoch 一旦变化就拒绝，不会把两版清单拼在一起。
   * 页面按真实序列化大小（answerBytes）裁，不按条数猜。
   */
  private async pagePolicyPlan(actor: Principal, input: Pick<PolicyPlanInput, 'pageSize' | 'cursor'>,
    plan: Awaited<ReturnType<SurrealCompanyCore['computePolicyPlan']>>): Promise<PolicyPlanView> {
    const all = plan.affectedTasks;
    const defaultPage = 40;
    const pageSize = input.pageSize === undefined ? defaultPage : Math.floor(input.pageSize);
    if (!Number.isFinite(pageSize) || pageSize < 1 || pageSize > 200) {
      throw new CompanyError('invalid', 'pageSize must be an integer between 1 and 200');
    }
    let offset = 0;
    const key = await this.cursorKey();
    if (input.cursor !== undefined) {
      const body = openCursor(input.cursor, key, Date.now());
      // 分开报：别人的光标是 forbidden；同一个调用者、但试算已经变了是 conflict（从第一页重跑才对——报 forbidden
      // 会让人以为是自己权限的问题）。判据是 planHash：它只覆盖 epoch、after 契约 hash 与受影响清单，
      // 所以与受影响清单无关的在办变化（例如某条无关任务新建或完成）不会让光标失效。
      if (body.k !== 'policy-plan' || body.c !== actor.employeeId) {
        throw new CompanyError('forbidden', 'cursor belongs to another caller or another listing; run the plan again');
      }
      if (body.q !== plan.planHash) {
        throw new CompanyError('conflict', 'the plan changed since this cursor was issued (the effective epoch or the affected list differ); run the plan again from its first page');
      }
      offset = body.seq;
    }
    const build = (kept: typeof all, start: number): PolicyPlanView => {
      const end = start + kept.length;
      const page: PolicyPlanPage = {
        pageSize, returned: kept.length, total: all.length, hasMore: end < all.length, budgetBytes: RESPONSE_BUDGET_BYTES,
        ...(end < all.length ? { nextCursor: sealCursor({ v: 1, k: 'policy-plan', c: actor.employeeId, q: plan.planHash, sid: 'plan', seq: end, exp: Date.now() + POLICY_PLAN_CURSOR_TTL_MS }, key) } : {}),
      };
      return { ...plan, affectedTasks: kept, page };
    };
    // pageSize 是上限：真正发送的一页还要按字节裁，保证 answerBytes 永远在预算内。
    const candidates = all.slice(offset, offset + pageSize);
    const fit = (kept: typeof all): number => fitCount(kept, subset => answerBytes(build([...subset], offset)), RESPONSE_BUDGET_BYTES);
    const keptCount = fit(candidates);
    if (keptCount === 0 && candidates.length > 0) {
      // 单条超预算：受影响清单没有收窄入参，这一条也补不了页——如实报它的字节数，让人知道是"这一条太大"。
      throw new CompanyError('invalid', `one affected task entry alone is ${answerBytes(build(candidates.slice(0, 1), offset))} bytes, over the ${RESPONSE_BUDGET_BYTES}-byte budget; a single entry cannot be paged, so no page can carry it`);
    }
    return build(candidates.slice(0, keptCount), offset);
  }

  /**
   * 执行隔离（RB01）：把已经不再被有效契约授权的在办任务置为可见的 blocked（等待 GM）并释放租约。
   * 这条路径是刻意选的：blocked+blocked_to=gm 是旧 release 也认得的隔离状态，回滚到旧版时它们不会被误派工，
   * 而只写新字段（旧版会忽略）会留下"旧版照派、新版拒领"的窗口。
   */
  async policyEnforce(credential: Credential, input: PolicyEnforceInput): Promise<PolicyEnforceView> {
    const actor = await this.authorized(credential, 'manage');
    if (!['gm', 'product'].includes(actor.role)) throw new CompanyError('forbidden', 'Only a manager may enforce a policy change');
    requireText(input.reason, 'reason', 2, 4000);
    if (!input.taskIds?.length) throw new CompanyError('invalid', 'policyEnforce needs the task ids it should isolate (from policy_plan)');
    if (input.taskIds.length > 200) throw new CompanyError('invalid', 'policyEnforce is limited to 200 tasks per call');
    const blocked: string[] = [], alreadyBlocked: string[] = [], absent: string[] = [];
    let audited = 0;
    for (const taskId of [...new Set(input.taskIds)]) {
      const row = await this.db.select<TaskRow>(id('task', taskId));
      if (!row) { absent.push(taskId); continue; }
      if (row.state === 'done' || row.state === 'void') { absent.push(taskId); continue; }
      const chain = this.chainOfRow(row);
      const { contract } = await this.effectiveContractFor(chain);
      const task = view(row);
      const verdict = dispatchVerdict({ state: row.state, executorRole: task.executorRole, kind: task.kind,
        ...(task.goalId ? { goalId: task.goalId } : {}),
        ...(task.workIntent ? { workIntent: task.workIntent } : {}),
        ...(row.policy_hash ? { policyHash: row.policy_hash } : {}),
        ...(row.policy_block_reason ? { policyBlockReason: row.policy_block_reason } : {}),
        registeredDomains: registeredDomainsOf(row) }, contract);
      if (verdict.verdict === 'clear') { absent.push(taskId); continue; }
      const reason = verdict.verdict === 'stale'
        ? `策略隔离：${row.policy_block_reason ?? '原授权已换版，需按新契约重新领取'}`
        : `策略收权隔离：${verdict.reason}`;
      const evidence = `policy_enforce task=${taskId} from=${row.policy_hash ?? 'none'} to=${contract.hash} 理由：${input.reason}`;
      try {
        const next = await this.txTask<TaskRow>(`BEGIN;
          LET $who = SELECT * FROM ONLY $actor;
          IF $who = NONE OR $who.revoked = true OR 'manage' NOT IN $who.capabilities { THROW 'policy denied: actor revoked or forbidden' };
          LET $t = SELECT * FROM ONLY $task;
          IF $t = NONE { THROW 'policy invalid: task not found' };
          IF $t.state IN ['done', 'void'] { THROW 'policy invalid: task is closed' };
          LET $next = UPDATE ONLY $task SET
            state = 'blocked', blocked_to = 'gm', resume_state = IF $t.state IN ['ready','doing','review'] THEN $t.state ELSE $t.resume_state END,
            resume_role = IF $t.state IN ['ready','doing','review'] THEN (IF $t.state = 'review' THEN $t.reviewer_role ELSE $t.executor_role END) ELSE $t.resume_role END,
            policy_block_reason = $reason, current_employee = NONE, delivery_id = NONE, lease_expires_at = NONE,
            version = $t.version + 1
            RETURN AFTER;
          UPDATE employee SET active_task = NONE WHERE active_task = $task;
          CREATE audit CONTENT { task: $task, actor: $actor, action: 'policy_blocked', evidence: $evidence, version: $next.version, at: time::now() };
          RETURN $next;
          COMMIT;`, {
          actor: id('employee', actor.employeeId), task: id('task', taskId), reason, evidence,
        });
        audited++;
        if (next.state === 'blocked' && row.policy_block_reason) alreadyBlocked.push(taskId); else blocked.push(taskId);
      } catch (error) {
        if (error instanceof CompanyError && error.code === 'invalid') { absent.push(taskId); continue; }
        throw error;
      }
    }
    return { blocked, alreadyBlocked, absent, audited };
  }

  /**
   * 给 ops broker 用的工具/别名边界：范围内生效的 tool_scope 决定允许清单，undefined 表示不设机器限制。
   * 判定本身复用 policy.ts 的 checkToolScope，broker 只负责把工具名与别名递进来——两边不会各判一套。
   */
  async policyToolScope(project: string, input?: { tool?: string; alias?: string; toolNames?: readonly string[] }): Promise<{
    version: number; hash: string; allowedTools?: string[]; allowedAliases?: string[]; verdict: PolicyVerdict;
  }> {
    const chain = this.policyChain({ projectId: project, includeTask: false });
    const { contract } = await this.effectiveContractFor(chain);
    const payload = domainPayload(contract, 'tool_scope');
    const verdict: PolicyVerdict = input?.tool === undefined ? { ok: true }
      : checkToolScope(contract, { tool: input.tool, alias: input.alias, toolNames: input.toolNames ?? [input.tool] });
    return { version: contract.version, hash: contract.hash,
      ...(payload ? { allowedTools: payload.allowedTools, allowedAliases: payload.allowedAliases } : {}), verdict };
  }

  /**
   * 调度器派工前的只读判定（SYS06 AC02）：任务在当前有效契约下是否仍可被派工。
   * 返回 blocked 时调度器按 policy_blocked 拦住候选；返回 stale 表示契约已变但仍授权——claim 会重新登记，
   * 不静默改变已批的艺术要求（本层不改验收条件与 context）。
   */
  async policyDispatchVerdict(taskId: TaskId): Promise<{ verdict: 'clear' | 'stale' | 'blocked'; reason?: string; hash?: string }> {
    const row = await this.db.select<TaskRow>(id('task', taskId));
    if (!row) throw new CompanyError('not_found', 'Task not found');
    if (row.state === 'done' || row.state === 'void') return { verdict: 'clear' };
    const chain = this.chainOfRow(row);
    const { contract } = await this.effectiveContractFor(chain);
    const task = view(row);
    // 判定复用 policy.ts 的 dispatchVerdict：调度器（workforce）走的是同一段，两边结论不会分叉。
    return dispatchVerdict({ state: row.state, executorRole: task.executorRole, kind: task.kind,
      ...(task.goalId ? { goalId: task.goalId } : {}),
      ...(task.workIntent ? { workIntent: task.workIntent } : {}),
      ...(row.policy_hash ? { policyHash: row.policy_hash } : {}),
      ...(row.policy_block_reason ? { policyBlockReason: row.policy_block_reason } : {}),
      registeredDomains: registeredDomainsOf(row) }, contract);
  }

  async setIndependence(credential: Credential, input: SetIndependence): Promise<TaskView> {
    const actor = await this.authorized(credential, 'manage');
    requireText(input.taskId, 'taskId', 1, 200);
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) throw new CompanyError('invalid', 'Invalid expectedVersion');
    const fields = normalizeIndependence({ taskId: input.taskId, stages: input.stages, sources: input.sources, mode: input.mode,
      excluded: input.excluded, reason: input.reason });
    const idem = this.idemId(actor.employeeId, 'independence_set', input.idempotencyKey);
    const digest = HASH(JSON.stringify({ taskId: input.taskId, ...fields, expectedVersion: input.expectedVersion }));
    const prior = await this.replay(idem, digest);
    if (prior) return prior;
    const current = await this.db.select<TaskRow>(id('task', input.taskId));
    if (!current) throw new CompanyError('not_found', 'Task not found');
    if (current.state === 'done' || current.state === 'void') throw new CompanyError('invalid', 'Independence invalid: task is closed');
    if (current.version !== input.expectedVersion) throw new CompanyError('conflict', 'Independence moved: task version changed; re-read and retry');
    if (current.current_employee && (current.lease_expires_at ?? 0) > Math.floor(Date.now() / 1000)) {
      throw new CompanyError('conflict', 'Independence refused: the task is leased; release it or wait for the lease to end');
    }
    for (const source of fields.sources) {
      if (!(await this.db.select<TaskRow>(id('task', source)))) throw new CompanyError('not_found', `Independence source not found: ${source}`);
    }
    for (const employee of fields.excluded) {
      if (!(await this.db.select<EmployeeRow>(id('employee', employee)))) throw new CompanyError('invalid', `Independence excluded employee not found: ${employee}`);
    }
    const revision = (current.independence?.revision ?? 0) + 1;
    const evidence = `${input.reason}\n[independence_set] task=${input.taskId} revision=${revision} stages=${fields.stages.join(',')} mode=${fields.mode} sources=${fields.sources.join(',') || 'none'} excluded=${fields.excluded.join(',') || 'none'} expectedVersion=${input.expectedVersion}`;
    const query = `BEGIN;
      LET $now = time::unix(time::now());
      LET $who = SELECT * FROM ONLY $actor;
      IF $who = NONE OR $who.revoked = true OR 'manage' NOT IN $who.capabilities { THROW 'independence denied: actor revoked or forbidden' };
      LET $t = SELECT * FROM ONLY $task;
      IF $t = NONE { THROW 'independence invalid: task not found' };
      IF $t.version != $expected { THROW 'independence moved: task version changed' };
      IF $t.state IN ['done', 'void'] { THROW 'independence invalid: task is closed' };
      IF $t.current_employee != NONE AND $t.lease_expires_at > $now { THROW 'independence refused: task is leased' };
      LET $next = UPDATE ONLY $task SET
        independence = { schema: 1, revision: $revision, stages: $stages, sources: $sources, mode: $mode, excluded: $excluded, reason: $reason, setBy: $employee, setAt: time::now() },
        version = $t.version + 1
        RETURN AFTER;
      CREATE ONLY $audit CONTENT { task: $task, actor: $actor, action: 'independence_set', evidence: $evidence, version: $next.version, at: time::now() };
      CREATE ONLY $idem CONTENT { at: time::now(), payload_digest: $digest, result: $next };
      RETURN $next;
      COMMIT;`;
    const vars = {
      actor: id('employee', actor.employeeId), employee: actor.employeeId, task: id('task', input.taskId), expected: input.expectedVersion,
      revision, stages: fields.stages, sources: fields.sources, mode: fields.mode, excluded: fields.excluded, reason: fields.reason,
      evidence, digest, idem, audit: id('audit', randomUUID()),
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
   * Manager write of an identity principal (SYS-DISP IR02/Q3): the explicit, manage-controlled link that makes several
   * employeeIds one person for independence purposes. This is the only cross-employee identity key — a definition, provider,
   * model, name or directory never implies it — so registering one is a deliberate, audited act with a required reason.
   * The write sets the principal's exact employee set under a compare-and-set on the principal row, is idempotent per
   * (key, payload), and refuses while any named employee holds a live lease: an identity is never changed under a running
   * task. Removing an employee leaves its history rows as they are (audit facts are never rewritten).
   */
  async setIdentityPrincipal(credential: Credential, input: SetIdentityPrincipal): Promise<IdentityPrincipalView> {
    const actor = await this.authorized(credential, 'manage');
    const employees = [...new Set((input.employees ?? []).filter((employee): employee is string => typeof employee === 'string'))];
    if (employees.length === 0) throw new CompanyError('invalid', 'Invalid principal: name at least one employee');
    if (employees.length > 20) throw new CompanyError('invalid', 'Invalid principal: at most 20 employees');
    for (const employee of employees) requireText(employee, 'employee', 1, 200);
    requireText(input.reason, 'reason', 8, 2000);
    if (input.principalId !== undefined) requireText(input.principalId, 'principalId', 1, 200);
    if (input.expectedVersion !== undefined && (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1)) {
      throw new CompanyError('invalid', 'Invalid expectedVersion');
    }
    const idem = this.idemId(actor.employeeId, 'identity_principal_set', input.idempotencyKey);
    const digest = HASH(JSON.stringify({ principalId: input.principalId ?? '', employees, reason: input.reason,
      expectedVersion: input.expectedVersion ?? 0 }));
    // A new principal gets its id before the transaction, so the idempotency row and the audit row name the same id.
    const principalId = input.principalId ?? `p_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const replayed = await this.replayPrincipal(idem, digest);
    if (replayed) return replayed;
    const existing = input.principalId === undefined ? undefined : await this.db.select<{ version?: number }>(id('principal', input.principalId));
    if (input.principalId !== undefined && !existing) throw new CompanyError('not_found', `Principal not found: ${input.principalId}`);
    const version = (existing?.version ?? 0) + 1;
    // An identity is never changed under a running task: no named employee may hold a live lease. `task.current_employee`
    // stores the plain employee id (see the lease readers), so this compares strings and reads the lease's own row.
    const [leased] = await this.db.query<[Array<{ current_employee?: string }>]>(
      'SELECT current_employee FROM task WHERE current_employee IN $ids AND lease_expires_at > time::unix(time::now());', { ids: employees });
    if ((leased ?? []).length > 0) {
      throw new CompanyError('conflict', `Principal refused: ${leased[0]!.current_employee} holds a live lease; release it or wait for the lease to end`);
    }
    for (const employee of employees) {
      const row = await this.db.select<EmployeeRow>(id('employee', employee));
      if (!row) throw new CompanyError('not_found', `Employee not found: ${employee}`);
    }
    const evidence = `${input.reason}\n[identity_principal_set] principal=${input.principalId ?? '(new)'} employees=${employees.join(',')} expectedVersion=${input.expectedVersion ?? 0}`;
    const query = `BEGIN;
      LET $now = time::unix(time::now());
      LET $who = SELECT * FROM ONLY $actor;
      IF $who = NONE OR $who.revoked = true OR 'manage' NOT IN $who.capabilities { THROW 'principal denied: actor revoked or forbidden' };
      LET $p = SELECT * FROM ONLY $principal;
      IF $p = NONE AND $existing { THROW 'principal not found' };
      IF $p != NONE AND $p.version != $expected { THROW 'principal moved: version changed' };
      FOR $e IN $employees {
        LET $row = SELECT * FROM ONLY $e;
        IF $row = NONE OR $row.revoked = true { THROW 'principal invalid: employee missing or revoked' };
        // The lease lives on the task row (current_employee); re-checked here so a lease granted between the read and this
        // write conflicts instead of silently re-identifying a running holder.
        LET $leased = SELECT VALUE current_employee FROM task WHERE current_employee IN $ids AND lease_expires_at > $now;
        IF array::len($leased) > 0 { THROW 'principal refused: employee is leased' };
      };
      LET $next = UPSERT ONLY $principal CONTENT { reason: $reason, employees: $employees, version: $version, created_at: time::now() } RETURN AFTER;
      FOR $e IN $employees { UPDATE ONLY $e SET principal = $principal; };
      CREATE ONLY $audit CONTENT { actor: $actor, action: 'identity_principal_set', evidence: $evidence, version: $version, at: time::now() };
      // The idempotent result stores the very timestamp the write returns, so a replay is byte-identical to the first call.
      CREATE ONLY $idem CONTENT { at: time::now(), payload_digest: $digest, result: { id: $principal, employees: $employees, reason: $reason, set_by: $employee, set_at: $next.created_at } };
      RETURN { created_at: $next.created_at, set_by: $employee };
      COMMIT;`;
    const vars = {
      actor: id('employee', actor.employeeId), employee: actor.employeeId, principal: id('principal', principalId),
      employees: employees.map(employee => id('employee', employee)),
      // task.current_employee stores the plain employee id (see the lease readers), so the guard compares strings.
      ids: employees,
      reason: input.reason, version, existing: input.principalId !== undefined, expected: input.expectedVersion ?? 0,
      evidence, digest, idem, audit: id('audit', randomUUID()),
    };
    try {
      const written = await this.txTask<{ created_at?: Date | string; set_by?: unknown }>(query, vars);
      return principalView(principalId, employees, input.reason,
        written.set_by instanceof RecordId ? asId(written.set_by) : String(written.set_by ?? actor.employeeId),
        written.created_at);
    } catch (error) {
      const replayedAfterFailure = await this.replayPrincipal(idem, digest);
      if (replayedAfterFailure) return replayedAfterFailure;
      throw error;
    }
  }

  /**
   * Idempotent replay of a principal write: the same key and payload returns the stored result verbatim (same principal id, same
   * setBy and setAt), and a different payload under that key conflicts. The stored row is the API view the first write returned.
   */
  private async replayPrincipal(ident: RecordId, payloadDigest: string): Promise<IdentityPrincipalView | undefined> {
    const prior = await this.db.select<IdempotencyRow & { result?: unknown }>(ident);
    if (!prior) return undefined;
    if (prior.payload_digest !== payloadDigest) throw new CompanyError('conflict', 'Idempotency key reused with different input');
    const result = prior.result as { id?: unknown; employees?: unknown[]; reason?: string; set_by?: string; set_at?: Date | string } | undefined;
    if (!result?.id) return undefined;
    // The driver hands record links back as RecordId values, so the stored view is normalized to the API's plain ids.
    const id = result.id instanceof RecordId ? asId(result.id) : String(result.id);
    const employees = (result.employees ?? []).map(value => value instanceof RecordId ? asId(value) : String(value));
    return principalView(id, employees, result.reason ?? '', result.set_by ?? '', result.set_at);
  }

  /**
   * gm only (manage): records the code implementer of an engineering task whose bound implementer cannot continue
   * (withdrawn, departed, durable quota or runtime failure). The task must be in execute phase: ready or doing, or blocked
   * with an execute resume state. A block raised in review resumes in review, so it is refused like any review-phase task. One compare-and-set
   * transaction re-checks every basis: the task version, the new implementer's role, execute capability and track,
   * and, when the new implementer is a current reviewer, a named replacement reviewer that is neither an author nor
   * the new implementer. A lease held by someone else is revoked in the same write (the fence moves, so the old
   * holder's proof is refused). Audit, outbox and the idempotency row land together. Authorship is never removed.
   * The target's employee record is written in the same transaction, so a concurrent retirement of the target conflicts
   * with this takeover instead of both succeeding (retirement.ts, Workforce.retire).
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
    const contrib = await readContributionView(this.db, input.taskId);
    const facts = contrib.facts;
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
      IF $t.version != $seen { THROW 'implementer takeover moved: contribution history changed' };
      IF $t.state NOT IN ['ready', 'doing'] AND ($t.state != 'blocked' OR $t.resume_state NOT IN ['ready', 'doing']) { THROW 'implementer takeover moved: task is not in execute phase' };
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
      UPDATE ONLY $target SET implementer_bound_at = time::now();
      CREATE ONLY $audit CONTENT { task: $task, actor: $actor, action: 'implementer_takeover', evidence: $evidence, version: $next.version, at: time::now() };
      // Being bound as the implementer is the record that this employee writes this task's code (SYS-DISP IR01/Q1: a real
      // implementer never reviews its own delivery, even after the binding moves on to the next engineer). The row carries the
      // new implementer as its actor in the execute phase, so the contribution derivation reads it as authorship rather than
      // treating a claim-only holder and a bound implementer alike.
      CREATE ONLY $bound CONTENT { task: $task, actor: $target, action: 'implementer_bound', phase: 'execute', evidence: $evidence, version: $next.version, at: time::now() };
      LET $sequence = UPDATE ONLY company_meta:outbox_counter SET value += 1 RETURN AFTER;
      CREATE ONLY $outbox CONTENT { task: $task, kind: 'implementer_takeover', sequence: $sequence.value, payload: { version: $next.version, implementer: $target_key }, at: time::now() };
      CREATE ONLY $idem CONTENT { at: time::now(), payload_digest: $digest, result: $next };
      RETURN $next;
      COMMIT;`;
    const vars = {
      actor: id('employee', actor.employeeId), task: id('task', input.taskId), expected: input.expectedVersion,
      target: id('employee', input.toEmployee), target_key: input.toEmployee,
      replacement: input.replacementReviewer ? id('employee', input.replacementReviewer) : undefined,
      excluded_ids: [...new Set([...facts.excluded, input.toEmployee])].map(employee => id('employee', employee)),
      seen: contrib.version ?? -1, evidence, digest, idem, audit: id('audit', randomUUID()),
      bound: id('audit', randomUUID()), outbox: id('outbox', randomUUID()),
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
   * Dispatcher-initiated implementer replacement. Called when the bound implementer's session is gone for good — the
   * employee left the roster, or its session is archived, quarantined or parked in a failure that cannot be restarted —
   * so the task can never be handed back, and the binding would keep every other engineer out forever. The write is the
   * same compare-and-set transaction as the manager's takeover (version, target role/capability/track, a lease held by
   * someone else is revoked, authorship is never removed); only the actor differs: the dispatcher acts on its own and
   * the audit row records `system:dispatcher`. No credential is involved, so this is never exposed as an agent tool.
   */
  async systemImplementerTakeover(input: { taskId: string; toEmployee: string; expectedVersion: number; reason: string }): Promise<TaskView> {
    requireText(input.taskId, 'taskId', 1, 200);
    requireText(input.toEmployee, 'toEmployee', 1, 200);
    requireText(input.reason, 'reason', 8, 2000);
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) throw new CompanyError('invalid', 'Invalid expectedVersion');
    const actor = 'system:dispatcher';
    const idem = this.idemId(actor, 'implementer_takeover', `auto:${input.taskId}:${input.expectedVersion}:${input.toEmployee}`);
    const digest = HASH(JSON.stringify({ taskId: input.taskId, toEmployee: input.toEmployee, expectedVersion: input.expectedVersion, reason: input.reason }));
    const prior = await this.replay(idem, digest);
    if (prior) return prior;
    const current = await this.db.select<TaskRow>(id('task', input.taskId));
    if (!current) throw new CompanyError('not_found', 'Task not found');
    if (current.executor_role !== 'engineering') {
      throw new CompanyError('invalid', 'implementer takeover invalid: only engineering tasks have a code implementer');
    }
    const contrib = await readContributionView(this.db, input.taskId);
    const facts = contrib.facts;
    if (input.toEmployee === facts.implementer) throw new CompanyError('invalid', 'implementer takeover invalid: employee is already the implementer');
    if (facts.excluded.includes(input.toEmployee)) throw new CompanyError('invalid', 'implementer takeover invalid: the successor is an author of this task');
    if (facts.reviewers.includes(input.toEmployee)) {
      throw new CompanyError('invalid', 'implementer takeover invalid: a current reviewer cannot become the implementer without a named replacement reviewer');
    }
    const evidence = `${input.reason}\n[implementer_takeover:auto] task=${input.taskId} from=${facts.implementer ?? 'none'} to=${input.toEmployee} expectedVersion=${input.expectedVersion}`;
    const query = `BEGIN;
      LET $now = time::unix(time::now());
      LET $t = SELECT * FROM ONLY $task;
      IF $t = NONE { THROW 'implementer takeover invalid: task not found' };
      IF $t.version != $expected { THROW 'implementer takeover moved: task version changed' };
      IF $t.version != $seen { THROW 'implementer takeover moved: contribution history changed' };
      IF $t.state NOT IN ['ready', 'doing'] AND ($t.state != 'blocked' OR $t.resume_state NOT IN ['ready', 'doing']) { THROW 'implementer takeover moved: task is not in execute phase' };
      LET $to = SELECT * FROM ONLY $target;
      IF $to = NONE OR $to.revoked = true OR 'execute' NOT IN $to.capabilities OR $to.role != $t.executor_role { THROW 'implementer takeover invalid: target employee cannot execute this task' };
      LET $to_tracks = $to.def.tracks ?? [];
      IF $t.discipline != NONE AND array::len($to_tracks) > 0 AND $t.discipline NOT IN $to_tracks { THROW 'implementer takeover invalid: target employee track does not cover the task' };
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
      UPDATE ONLY $target SET implementer_bound_at = time::now();
      CREATE ONLY $audit CONTENT { task: $task, actor: $actor, action: 'implementer_takeover', evidence: $evidence, version: $next.version, at: time::now() };
      // The same authorship record the manager's takeover writes (see implementerTakeover): the new implementer is the
      // person who writes this task's code and never reviews it.
      CREATE ONLY $bound CONTENT { task: $task, actor: $target, action: 'implementer_bound', phase: 'execute', evidence: $evidence, version: $next.version, at: time::now() };
      LET $sequence = UPDATE ONLY company_meta:outbox_counter SET value += 1 RETURN AFTER;
      CREATE ONLY $outbox CONTENT { task: $task, kind: 'implementer_takeover', sequence: $sequence.value, payload: { version: $next.version, implementer: $target_key, automatic: true }, at: time::now() };
      CREATE ONLY $idem CONTENT { at: time::now(), payload_digest: $digest, result: $next };
      RETURN $next;
      COMMIT;`;
    const vars = {
      task: id('task', input.taskId), expected: input.expectedVersion, target: id('employee', input.toEmployee),
      target_key: input.toEmployee, seen: contrib.version ?? -1, evidence, digest, idem, actor,
      audit: id('audit', randomUUID()), bound: id('audit', randomUUID()), outbox: id('outbox', randomUUID()),
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
    return echoTask(await this.taskProjectUpdateRecord(credential, input));
  }

  private async taskProjectUpdateRecord(credential: Credential, input: { taskId: TaskId; project: string; expectedVersion: number; text: string; idempotencyKey: string }): Promise<TaskView> {
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
    return echoTask(await this.bindTaskCodeRepoRecord(credential, input));
  }

  private async bindTaskCodeRepoRecord(credential: Credential, input: { taskId: TaskId; codeRepoPath: string; expectedVersion: number; text: string; idempotencyKey: string }): Promise<TaskView> {
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
        CREATE ONLY $idem CONTENT { at: time::now(), payload_digest: $digest, result: $next };
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
  async modelEvidence(credential: Credential, taskId: TaskId): Promise<ModelEvidence[]> {
    const actor = await this.authorized(credential);
    if (!['eval','gm'].includes(actor.role)) throw new CompanyError('forbidden','Only eval or gm may read model evaluation evidence');
    if (!await this.db.select(id('task', taskId))) throw new CompanyError('not_found', 'Task not found');
    // The same rows collectEvalState validates against, read alone: the full eval state rebuilt the whole timeline per call.
    const [rows] = await this.db.query<[NonNullable<Parameters<typeof summarizeModelEvidence>[0]>]>(
      "SELECT employee,model,fence,phase,<string>at AS at FROM model_execution WHERE task=$task AND completed=true AND status>=200 AND status<300 AND phase!='auxiliary' AND employee!=$actor;",
      { task: id('task', taskId), actor: actor.employeeId });
    return summarizeModelEvidence(rows ?? []);
  }

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
  // ---- QA 受限只读取证（SYS-DISP 7454fc89） ----
  // 一条独立的只读路径：GM 登记 scope，QA 用本人 sck 会话或浏览器受限会话读取 allowlist 内的任务；
  // 现有 getTask 的 executor/reviewer/gm/eval ACL 不变，scope 的部署任务复核租约一变即失败关闭。

  /** The named scope, or the QA employee's single active scope. Never another employee's scope. */
  private async qaScopeFor(employeeId: string, scopeId?: string): Promise<QaObservationScopeRow> {
    if (scopeId !== undefined) {
      requireText(scopeId, 'scopeId', 1, 200);
      const row = await this.db.select<QaObservationScopeRow>(id('qa_observation_scope', scopeId));
      if (!row) throw new CompanyError('not_found', 'QA observation scope not found');
      if (row.qa_employee !== employeeId) throw new CompanyError('forbidden', 'QA observation scope belongs to another employee');
      return row;
    }
    const [rows] = await this.db.query<[QaObservationScopeRow[]]>(
      "SELECT * FROM qa_observation_scope WHERE qa_employee = $me AND status = 'active' ORDER BY created_at DESC LIMIT 2;",
      { me: employeeId });
    const active = rows ?? [];
    if (active.length === 0) throw new CompanyError('forbidden', 'no active QA observation scope for this employee');
    if (active.length > 1) throw new CompanyError('invalid', 'more than one active QA observation scope; pass scopeId');
    return active[0]!;
  }

  /** A scope is usable only while its deployment task still carries the exact QA review lease it was granted on. */
  private async qaScopeUsable(scope: QaObservationScopeRow, employeeId: string): Promise<void> {
    if (scope.status !== 'active') throw new CompanyError('forbidden', 'QA observation scope is revoked');
    if (!(Date.parse(scope.expires_at) > Date.now())) throw new CompanyError('forbidden', 'QA observation scope expired');
    if (scope.qa_employee !== employeeId) throw new CompanyError('forbidden', 'QA observation scope belongs to another employee');
    const task = await this.db.select<TaskRow>(scope.deployment_task);
    if (!task) throw new CompanyError('forbidden', 'the deployment task of the QA observation scope no longer exists');
    const now = Math.floor(Date.now() / 1000);
    if (task.state !== 'review' || task.reviewer_role !== 'qa') throw new CompanyError('forbidden', 'the deployment task is no longer in QA review');
    if (task.current_employee !== scope.lease_holder || task.fence !== scope.lease_fence ||
        task.lease_expires_at === undefined || task.lease_expires_at <= now) {
      throw new CompanyError('forbidden', 'the QA review lease changed; the observation scope fails closed');
    }
    if (!task.goal || asId(task.goal) !== asId(scope.goal)) throw new CompanyError('forbidden', 'the deployment task left the scope goal');
  }

  /** Authenticate a QA read: an employee credential (qa role) or a browser-only restricted session token. */
  private async qaObservationAuth(auth: QaObservationAuth, scopeId?: string): Promise<{ scope: QaObservationScopeRow; employeeId: string }> {
    let employeeId: string;
    let sessionScope: string | undefined;
    if (auth.token !== undefined) {
      requireText(auth.token, 'token', 10, 500);
      const [rows] = await this.db.query<[QaObservationSessionRow[]]>(
        "SELECT * FROM qa_observation_session WHERE token_hash = $hash AND state = 'active' LIMIT 1;",
        { hash: qaHash(auth.token) });
      const session = rows?.[0];
      if (!session) throw new CompanyError('forbidden', 'QA observation session is invalid or expired');
      if (!session.expires_at || !(Date.parse(session.expires_at) > Date.now())) {
        throw new CompanyError('forbidden', 'QA observation session expired');
      }
      employeeId = session.qa_employee;
      sessionScope = qaId(session.scope);
    } else if (auth.credential !== undefined) {
      const actor = await this.authenticate(auth.credential);
      if (actor.role !== 'qa') throw new CompanyError('forbidden', 'QA observation reads require the qa role');
      employeeId = actor.employeeId;
    } else {
      throw new CompanyError('unauthorized', 'QA observation read requires a credential or a session token');
    }
    const scope = await this.qaScopeFor(employeeId, scopeId ?? sessionScope);
    if (sessionScope !== undefined && scopeId !== undefined && scopeId !== sessionScope) {
      throw new CompanyError('forbidden', 'the session is bound to another QA observation scope');
    }
    await this.qaScopeUsable(scope, employeeId);
    return { scope, employeeId };
  }

  /** GM (manage): register a time-bounded, task-allowlisted QA read scope on a live QA review lease. */
  async qaObservationGrant(credential: Credential, input: QaObservationGrant): Promise<QaObservationScopeView> {
    const actor = await this.authorized(credential, 'manage');
    if (actor.role !== 'gm') throw new CompanyError('forbidden', 'Only gm may grant a QA observation scope');
    requireText(input.goalId, 'goalId', 1, 100);
    requireText(input.deploymentTaskId, 'deploymentTaskId', 1, 200);
    requireText(input.qaEmployee, 'qaEmployee', 1, 200);
    if (!Number.isSafeInteger(input.leaseFence) || input.leaseFence < 1) throw new CompanyError('invalid', 'Invalid leaseFence');
    if (!Array.isArray(input.subjects) || input.subjects.length === 0 || input.subjects.length > QA_OBSERVATION_MAX_SUBJECTS) {
      throw new CompanyError('invalid', `subjects must be 1-${QA_OBSERVATION_MAX_SUBJECTS} task ids`);
    }
    for (const subject of input.subjects) requireText(subject, 'subject', 1, 200);
    requireText(input.reason, 'reason', 8, 2000);
    requireText(input.idempotencyKey, 'idempotencyKey', 8, 200);
    const expiresMs = Date.parse(input.expiresAt);
    if (!Number.isFinite(expiresMs) || expiresMs < Date.now() + QA_OBSERVATION_MIN_TTL_MS || expiresMs > Date.now() + QA_OBSERVATION_MAX_TTL_MS) {
      throw new CompanyError('invalid', 'expiresAt must be within 1 minute and 24 hours from now');
    }
    const expiresAt = new Date(expiresMs).toISOString();
    const subjects = [...new Set(input.subjects)];
    const scopeId = randomUUID();
    const scopeRecord = id('qa_observation_scope', scopeId);
    const idem = this.idemId(actor.employeeId, 'qa_observation_grant', input.idempotencyKey);
    const digest = HASH(JSON.stringify({ goalId: input.goalId, deploymentTaskId: input.deploymentTaskId, qaEmployee: input.qaEmployee,
      leaseFence: input.leaseFence, subjects, expiresAt, reason: input.reason }));
    const prior = await this.replayStored<QaObservationScopeRow>(idem, digest);
    if (prior) return qaScopeView(prior);
    const evidence = `${input.reason}\n[qa_observation_grant] scope=${scopeId} goal=${input.goalId} deployment=${input.deploymentTaskId} qa=${input.qaEmployee} leaseFence=${input.leaseFence} subjects=${subjects.join(',')} expiresAt=${expiresAt}`;
    const query = `BEGIN;
      LET $who = SELECT * FROM ONLY $actor;
      IF $who = NONE OR $who.revoked = true OR 'manage' NOT IN $who.capabilities OR $who.role != 'gm' { THROW 'actor revoked or forbidden' };
      LET $d = SELECT * FROM ONLY $deploy;
      IF $d = NONE { THROW 'qa observation invalid: deployment task not found' };
      IF $d.state != 'review' OR $d.reviewer_role != 'qa' { THROW 'qa observation invalid: deployment task is not in QA review' };
      IF $d.current_employee != $qa OR $d.fence != $fence { THROW 'qa observation invalid: QA review lease holder or fence does not match' };
      IF $d.lease_expires_at = NONE OR $d.lease_expires_at <= time::unix(time::now()) { THROW 'qa observation invalid: QA review lease is not live' };
      IF $d.goal != $goal { THROW 'qa observation invalid: deployment task is not in the scope goal' };
      IF $d.submitted_by = $qa OR $d.implementer = $qa { THROW 'qa observation invalid: the qa employee authored the deployment task' };
      LET $q = SELECT * FROM ONLY $qa_emp;
      IF $q = NONE OR $q.revoked = true OR $q.role != 'qa' OR 'review' NOT IN $q.capabilities { THROW 'qa observation invalid: qa employee is not an active reviewer' };
      FOR $s IN $subjects {
        LET $t = SELECT * FROM ONLY type::record('task', $s);
        IF $t = NONE { THROW 'qa observation invalid: subject task not found' };
        IF $t.goal != $goal { THROW 'qa observation invalid: subject task is not in the scope goal' };
        IF $t.submitted_by = $qa OR $t.implementer = $qa { THROW 'qa observation invalid: the qa employee authored a subject task' };
      };
      LET $scope = CREATE ONLY $scope_rec CONTENT { goal: $goal, deployment_task: $deploy, qa_employee: $qa, lease_holder: $qa,
        lease_fence: $fence, subjects: $subjects, status: 'active', expires_at: $expires, version: 1, reason: $reason,
        created_by: $actor, created_at: time::now() };
      CREATE ONLY $audit CONTENT { task: $deploy, actor: $actor, action: 'qa_observation_grant', evidence: $evidence, version: 1, at: time::now() };
      CREATE ONLY $idem CONTENT { at: time::now(), payload_digest: $digest, result: $scope };
      RETURN $scope;
      COMMIT;`;
    const vars = {
      actor: id('employee', actor.employeeId), deploy: id('task', input.deploymentTaskId), qa: input.qaEmployee,
      qa_emp: id('employee', input.qaEmployee), goal: id('goal', input.goalId), fence: input.leaseFence,
      subjects, expires: expiresAt, reason: input.reason, scope_rec: scopeRecord, evidence, digest, idem,
      audit: id('audit', randomUUID()),
    };
    try {
      return qaScopeView(await this.txTask<QaObservationScopeRow>(query, vars));
    } catch (error) {
      const replayed = await this.replayStored<QaObservationScopeRow>(idem, digest);
      if (replayed) return qaScopeView(replayed);
      throw error;
    }
  }

  /** GM (manage): revoke a scope with compare-and-set on its version. */
  async qaObservationRevoke(credential: Credential, input: QaObservationRevoke): Promise<QaObservationScopeView> {
    const actor = await this.authorized(credential, 'manage');
    if (actor.role !== 'gm') throw new CompanyError('forbidden', 'Only gm may revoke a QA observation scope');
    requireText(input.scopeId, 'scopeId', 1, 200);
    requireText(input.reason, 'reason', 8, 2000);
    requireText(input.idempotencyKey, 'idempotencyKey', 8, 200);
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) throw new CompanyError('invalid', 'Invalid expectedVersion');
    const idem = this.idemId(actor.employeeId, 'qa_observation_revoke', input.idempotencyKey);
    const digest = HASH(JSON.stringify({ scopeId: input.scopeId, expectedVersion: input.expectedVersion, reason: input.reason }));
    const prior = await this.replayStored<QaObservationScopeRow>(idem, digest);
    if (prior) return qaScopeView(prior);
    const evidence = `${input.reason}\n[qa_observation_revoke] scope=${input.scopeId} expectedVersion=${input.expectedVersion}`;
    const query = `BEGIN;
      LET $who = SELECT * FROM ONLY $actor;
      IF $who = NONE OR $who.revoked = true OR 'manage' NOT IN $who.capabilities OR $who.role != 'gm' { THROW 'actor revoked or forbidden' };
      LET $s = SELECT * FROM ONLY $scope;
      IF $s = NONE { THROW 'qa observation invalid: scope not found' };
      IF $s.version != $expected { THROW 'qa observation moved: scope version changed' };
      IF $s.status != 'active' { THROW 'qa observation moved: scope is not active' };
      LET $next = UPDATE ONLY $scope SET status = 'revoked', revoked_at = time::now(), revoked_by = $actor,
        revoked_reason = $reason, version = $s.version + 1 RETURN AFTER;
      CREATE ONLY $audit CONTENT { task: $s.deployment_task, actor: $actor, action: 'qa_observation_revoke', evidence: $evidence, version: $next.version, at: time::now() };
      CREATE ONLY $idem CONTENT { at: time::now(), payload_digest: $digest, result: $next };
      RETURN $next;
      COMMIT;`;
    const vars = { actor: id('employee', actor.employeeId), scope: id('qa_observation_scope', input.scopeId),
      expected: input.expectedVersion, reason: input.reason, evidence, digest, idem, audit: id('audit', randomUUID()) };
    try {
      return qaScopeView(await this.txTask<QaObservationScopeRow>(query, vars));
    } catch (error) {
      const replayed = await this.replayStored<QaObservationScopeRow>(idem, digest);
      if (replayed) return qaScopeView(replayed);
      throw error;
    }
  }

  /** GM sees every scope; a QA sees its own. No credentials or session hashes are returned. */
  async qaObservationStatus(credential: Credential): Promise<QaObservationScopeView[]> {
    const actor = await this.authorized(credential);
    if (actor.role === 'gm') {
      const [rows] = await this.db.query<[QaObservationScopeRow[]]>("SELECT * FROM qa_observation_scope ORDER BY created_at DESC LIMIT 50;");
      return (rows ?? []).map(qaScopeView);
    }
    if (actor.role !== 'qa') throw new CompanyError('forbidden', 'QA observation status is read by gm or qa');
    const [rows] = await this.db.query<[QaObservationScopeRow[]]>(
      "SELECT * FROM qa_observation_scope WHERE qa_employee = $me ORDER BY created_at DESC LIMIT 20;", { me: actor.employeeId });
    return (rows ?? []).map(qaScopeView);
  }

  /** QA (own credential): one-time login code for the company page. The code is stored as a hash and expires quickly. */
  async qaObservationSession(credential: Credential, input: { scopeId?: string }): Promise<QaObservationSessionView> {
    const actor = await this.authenticate(credential);
    if (actor.role !== 'qa') throw new CompanyError('forbidden', 'QA observation sessions require the qa role');
    const scope = await this.qaScopeFor(actor.employeeId, input.scopeId);
    await this.qaScopeUsable(scope, actor.employeeId);
    const code = randomBytes(24).toString('base64url');
    const expiresAt = new Date(Date.now() + QA_OBSERVATION_CODE_TTL_MS).toISOString();
    await this.db.query("CREATE $sess CONTENT { scope: $scope, qa_employee: $qa, code_hash: $hash, state: 'code', code_expires_at: $expires, created_at: time::now() };",
      { sess: id('qa_observation_session', randomUUID()), scope: scope.id, qa: actor.employeeId, hash: qaHash(code), expires: expiresAt });
    return { scope: qaScopeView(scope), code, expiresAt, pagePath: '/q/' };
  }

  /** The company page exchanges the one-time code for a browser-only restricted token. The code is consumed. */
  async qaObservationLogin(code: string): Promise<QaObservationLoginView> {
    requireText(code, 'code', 10, 500);
    const [rows] = await this.db.query<[QaObservationSessionRow[]]>(
      "SELECT * FROM qa_observation_session WHERE code_hash = $hash AND state = 'code' LIMIT 1;", { hash: qaHash(code) });
    const session = rows?.[0];
    if (!session) throw new CompanyError('forbidden', 'login code is invalid or already used');
    if (!(Date.parse(session.code_expires_at) > Date.now())) throw new CompanyError('forbidden', 'login code expired');
    const scope = await this.db.select<QaObservationScopeRow>(session.scope);
    if (!scope || scope.status !== 'active') throw new CompanyError('forbidden', 'QA observation scope is not active');
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + QA_OBSERVATION_TOKEN_TTL_MS).toISOString();
    await this.db.query("UPDATE ONLY $sess SET state = 'active', token_hash = $token_hash, expires_at = $expires, used_at = time::now();",
      { sess: session.id, token_hash: qaHash(token), expires: expiresAt });
    return { scope: qaScopeView(scope), token, expiresAt };
  }

  /** QA: full task state, contribution facts (unknown fail-closed), and the last dispatcher pass's verdicts. */
  async qaObservationRead(auth: QaObservationAuth, input: QaObservationReadInput): Promise<QaObservationReadView> {
    const { scope } = await this.qaObservationAuth(auth, input.scopeId);
    const [instanceAt, observation, attempt] = await Promise.all([
      this.dbNow(),
      this.db.select<Record<string, unknown>>(id('company_meta', 'dispatch_observation')),
      this.db.select<{ at?: string; ok?: boolean; error?: string }>(id('company_meta', 'dispatch_observation_status')),
    ]);
    const checkedAt = new Date().toISOString();
    const scopeView = qaScopeView(scope);
    const baseMeta: QaObservationMeta = { checkedAt, dataSource: 'live', instanceAt, scope: scopeView, completeness: { complete: true } };
    if (input.goalId !== undefined) {
      if (input.goalId !== asId(scope.goal)) throw new CompanyError('forbidden', 'the goal is outside the QA observation scope');
      const goalId = input.goalId;
      const [rows] = await this.db.query<[Array<{ state?: string | null; n: number }>]>(
        "SELECT state, count() AS n FROM task WHERE goal = $goal GROUP BY state;", { goal: scope.goal });
      const states: Record<string, number> = {};
      for (const row of rows ?? []) states[row.state == null ? 'unknown' : String(row.state)] = Number(row.n);
      const total = Object.values(states).reduce((sum, n) => sum + n, 0);
      const [goalTasks] = await this.db.query<[Array<{ id: RecordId }>]>("SELECT id FROM task WHERE goal = $goal;", { goal: scope.goal });
      const goalIds = new Set((goalTasks ?? []).map(row => asId(row.id)));
      const state = qaDispatchState(observation, attempt);
      const verdicts = (observation as { verdicts?: Array<{ taskId?: string; dispatchable?: boolean }> } | undefined)?.verdicts ?? [];
      const undispatchable = state.complete
        ? new Set(verdicts.filter(v => v.taskId && goalIds.has(v.taskId) && v.dispatchable === false).map(v => v.taskId)).size
        : undefined;
      // Workflow waits are a separately sampled, goal-scoped graph. They remain available when a dispatch pass is absent,
      // partial or stale, and never inherit the pass timestamp.
      const passVerdicts = (observation as { verdicts?: DispatchVerdict[] } | undefined)?.verdicts ?? [];
      const goalVerdicts = passVerdicts.filter(verdict => verdict.goalId === goalId && goalIds.has(verdict.taskId));
      const verdictRoot = goalRootBlockers(goalVerdicts)[0];
      let workflowSnapshot: Awaited<ReturnType<typeof readGoalWorkflowWaitSnapshot>> | undefined;
      let waits: GoalWorkflowWaitSummary;
      try {
        workflowSnapshot = await readGoalWorkflowWaitSnapshot(this.db, this.workforce, {
          goalId, roots: verdictRoot ? [verdictRoot.taskId] : [], limit: QA_OBSERVATION_WAIT_ROOTS_LIMIT,
          log: message => console.warn(message),
        });
        waits = workflowSnapshot.summary;
      } catch (error) {
        console.warn(`qa goal workflow wait facts failed: ${(error as Error).message}`);
        waits = { source: 'workflow-graph', available: false, totalRoots: 0, shownRoots: 0, truncated: false,
          reason: 'workflow graph could not be read', roots: [] };
      }
      // The exact same goal-root evaluator and graph facts serve dispatch blockers and workflow waits. Without workforce
      // contributor access, the legacy F1 root keeps its facts-unavailable semantics; the workflow wait graph remains readable.
      const facts: GoalRootFacts | undefined = verdictRoot && this.workforce && workflowSnapshot
        ? workflowSnapshot.facts : undefined;
      const rootBlocker = goalRootBlockers(goalVerdicts, facts)[0];
      const rootVerdict = verdictRoot
        ? goalVerdicts.find(verdict => verdict.taskId === verdictRoot.taskId && verdict.phase === verdictRoot.phase)
        : undefined;
      const reasons = rootBlocker?.reasons ?? [];
      // Revalidate after the graph and provenance reads so expiry, revocation or holder-fence changes during collection fail closed.
      await this.qaObservationAuth(auth, input.scopeId);
      const root = rootBlocker ? {
        taskId: rootBlocker.taskId, title: rootBlocker.title, phase: rootBlocker.phase,
        workflowState: rootBlocker.workflowState, summary: rootBlocker.summary, feasible: rootBlocker.feasible,
        waitingMinutes: rootBlocker.waitingMinutes, ...(rootBlocker.since ? { since: rootBlocker.since } : {}),
        checkedAt: rootBlocker.checkedAt, eligibleCount: rootBlocker.eligibleCount,
        undispatchable: rootBlocker.undispatchable, others: rootBlocker.others,
        ...(rootVerdict?.noticeKey ? { noticeKey: rootVerdict.noticeKey } : {}),
        factsAvailable: facts !== undefined,
        ...(facts !== undefined ? {
          impact: rootBlocker.impact, dependencyPath: rootBlocker.dependencyPath,
          people: { ...rootBlocker.people, authors: [...rootBlocker.people.authors], reviewers: [...rootBlocker.people.reviewers] },
        } : {}),
        reasons: reasons.slice(0, 20).map(reason => ({
          code: reason.code, text: reason.text, candidates: [...reason.candidates], owner: reason.owner,
          recovery: reason.recovery, nextTrigger: reason.nextTrigger, basis: reason.basis,
          ...(reason.until ? { until: reason.until } : {}),
          actions: reason.actions.map(action => ({ ...action })),
        })),
        ...(reasons.length > 20 ? { reasonsOmitted: reasons.length - 20 } : {}),
      } : undefined;
      // The waits ride on the one goal answer, and qa_observation_read has no paging input, so an over-budget answer would be
      // replaced whole by response_too_large on the relay and refused on MCP. Shrink waits against the measured answer instead,
      // leaving the release stamp its reserve, and say in the summary what was left out.
      const view = (fitted: GoalWorkflowWaitSummary): QaObservationReadView => ({ meta: { ...baseMeta, completeness: { ...baseMeta.completeness, dispatchComplete: state.complete } },
        goal: { id: goalId, states, total,
          ...(undispatchable !== undefined ? { undispatchable } : {}),
          dispatchAvailable: state.available, dispatchComplete: state.complete, dispatchSource: 'dispatcher-pass',
          ...(state.reason ? { dispatchReason: state.reason } : {}),
          ...(state.checkedAt ? { dispatchCheckedAt: state.checkedAt } : {}),
          ...(state.attemptAt ? { dispatchAttemptAt: state.attemptAt } : {}),
          ...(state.attemptOk !== undefined ? { dispatchAttemptOk: state.attemptOk } : {}),
          waits: fitted,
          ...(root ? { root } : {}),
        } });
      const trimmed: GoalWorkflowWaitSummary = waits.available ? { ...waits, roots: waits.roots.map(wait => {
        if (!wait.people) return wait;
        const authors = wait.people.authors.slice(0, 6);
        const reviewers = wait.people.reviewers.slice(0, 6);
        const peopleOmitted = wait.people.authors.length - authors.length + wait.people.reviewers.length - reviewers.length;
        return { ...wait, people: { ...wait.people, authors, reviewers, ...(peopleOmitted ? { peopleOmitted } : {}) } };
      }) } : waits;
      return view(fitGoalWaitSummary(trimmed, candidate => answerBytes(view(candidate)) <= RESPONSE_BUDGET_BYTES - QA_OBSERVATION_WAIT_RELEASE_RESERVE_BYTES));
    }
    if (input.taskId === undefined) throw new CompanyError('invalid', 'taskId or goalId is required');
    const taskId = input.taskId;
    if (!scope.subjects.includes(taskId)) throw new CompanyError('forbidden', 'the task is outside the QA observation scope');
    const row = await this.db.select<TaskRow>(id('task', taskId));
    if (!row) throw new CompanyError('not_found', 'Task not found');
    if (!row.goal || asId(row.goal) !== asId(scope.goal)) throw new CompanyError('forbidden', 'the task is not in the scope goal');
    const taskView = view(row);
    const facts = (await readContributionView(this.db, taskId)).facts;
    const dispatch = qaDispatchFor(observation, taskId, attempt);
    const context = row.context ?? '';
    const contextBytes = utf8Bytes(context);
    const inline = contextBytes <= QA_OBSERVATION_CONTEXT_INLINE_BYTES;
    const meta: QaObservationMeta = { ...baseMeta, completeness: { complete: true, taskRead: true, contextIncluded: inline,
      dispatchComplete: dispatch.available && dispatch.complete !== false } };
    return {
      meta,
      task: inline ? taskView : { ...taskView, context: '' },
      contribution: {
        authors: [...facts.authors], reviewers: [...facts.reviewers], excluded: [...facts.excluded],
        unknown: facts.unknown.map(entry => ({ actor: entry.actor, action: entry.action, ...(entry.at ? { at: entry.at } : {}), reason: entry.reason })),
        ...(facts.implementer ? { implementer: facts.implementer } : {}), ambiguous: facts.ambiguous,
      },
      dispatch,
      ...(inline ? {} : { contextOmitted: true, contextBytes, contextSha256: HASH(context), contextRead: { taskId, field: 'context' as const, offset: 0 } }),
    };
  }

  /** QA: one stored page of the allowlisted task's audit history (evidence cut per item, read whole with qa_observation_text). */
  async qaObservationTimeline(auth: QaObservationAuth, input: QaObservationReadInput & { pageSize?: number; cursor?: string }): Promise<QaObservationTimelineView> {
    const startedAt = arrivedAt();
    const { scope } = await this.qaObservationAuth(auth, input.scopeId);
    if (input.taskId === undefined) throw new CompanyError('invalid', 'taskId is required');
    if (!scope.subjects.includes(input.taskId)) throw new CompanyError('forbidden', 'the task is outside the QA observation scope');
    const params = parseHistoryInput({ ...input });
    const digest = queryDigest('qa-history', { scope: asId(scope.id), taskId: input.taskId });
    const scopeView = qaScopeView(scope);
    const taskId = input.taskId;
    return this.listingPage<HistoryEntry, QaObservationTimelineView>({
      actor: { employeeId: scope.qa_employee, role: 'qa', capabilities: [] }, kind: 'history', digest,
      pageSize: params.pageSize, cursor: params.cursor, startedAt,
      create: async started => {
        const { limits } = this.snapshots;
        return this.snapshots.build({
          owner: scope.qa_employee, kind: 'history', digest, role: 'qa', startedAt: started,
          guidance: 'read large evidence with qa_observation_text', emptyWhenNoRows: true,
          load: async db => {
            const { at, rows } = await this.historyRowsAt(taskId as TaskId, limits.maxRows + 1, db);
            if (rows.length > limits.maxRows) throw tooLarge(`task ${taskId} has more than ${limits.maxRows} audit entries; its history cannot be listed in one stored listing`);
            return { takenAt: at, bodies: rows.map(row => JSON.stringify(historyEntry(row, ITEM_BUDGET_BYTES))) };
          },
        });
      },
      parse: body => JSON.parse(body) as HistoryEntry,
      respond: (history, page) => ({
        meta: { checkedAt: page.snapshotAt ?? new Date().toISOString(), dataSource: 'live',
          instanceAt: page.snapshotAt ?? new Date().toISOString(), scope: scopeView,
          completeness: { complete: !page.hasMore, timelinePaged: true } },
        history: [...history].reverse(), page,
      }),
      envelopeGuidance: 'use a smaller pageSize',
      oversizeGuidance: entry => entry.auditId
        ? `history entry ${entry.auditId} is larger than a page can hold; read its evidence with qa_observation_text ${JSON.stringify({ taskId, field: 'evidence', auditId: entry.auditId, offset: 0 })}`
        : 'a history entry is larger than a page can hold; use a smaller pageSize',
    });
  }

  /** QA: one byte segment of the allowlisted task's context or audit evidence, with the digest for reassembly. */
  async qaObservationText(auth: QaObservationAuth, input: { scopeId?: string; taskId: string; field: 'context' | 'evidence'; auditId?: string; offset?: number; limit?: number; expectSha256?: string }): Promise<QaObservationTextSegment> {
    const { scope } = await this.qaObservationAuth(auth, input.scopeId);
    if (!scope.subjects.includes(input.taskId)) throw new CompanyError('forbidden', 'the task is outside the QA observation scope');
    if (input.field !== 'context' && input.field !== 'evidence') throw new CompanyError('invalid', 'field must be context or evidence');
    const offset = input.offset ?? 0;
    const limit = input.limit ?? SEGMENT_DEFAULT_BYTES;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000_000) throw new CompanyError('invalid', 'Invalid offset');
    if (!Number.isSafeInteger(limit) || limit < 4 || limit > SEGMENT_MAX_BYTES) throw new CompanyError('invalid', `limit must be 4-${SEGMENT_MAX_BYTES}`);
    if (input.expectSha256 !== undefined && !/^[0-9a-f]{64}$/.test(input.expectSha256)) throw new CompanyError('invalid', 'Invalid expectSha256');
    const row = await this.db.select<TaskRow>(id('task', input.taskId));
    if (!row) throw new CompanyError('not_found', 'Task not found');
    if (!row.goal || asId(row.goal) !== asId(scope.goal)) throw new CompanyError('forbidden', 'the task is not in the scope goal');
    let text: string;
    if (input.field === 'context') {
      text = row.context ?? '';
    } else {
      if (!input.auditId) throw new CompanyError('invalid', 'auditId is required to read evidence');
      const [rows] = await this.db.query<[Array<{ task?: RecordId; evidence?: string | null }>]>(
        "SELECT task, evidence FROM audit WHERE id = $aid AND action != 'ops_call';", { aid: id('audit', input.auditId) });
      const audit = rows?.[0];
      if (!audit || !audit.task || asId(audit.task) !== input.taskId) throw new CompanyError('not_found', 'evidence entry not found for this task');
      text = audit.evidence ?? '';
    }
    const sha256 = HASH(text);
    if (input.expectSha256 !== undefined && input.expectSha256 !== sha256) {
      throw new CompanyError('conflict', `the ${input.field} text changed: it is now ${utf8Bytes(text)} bytes with sha256 ${sha256}; read it again from offset 0`);
    }
    const head: TaskTextHead = { taskId: input.taskId, field: input.field, ...(input.auditId ? { auditId: input.auditId } : {}), sha256 };
    const segment = textSegment(text, offset, limit, head);
    const meta: QaObservationMeta = { checkedAt: new Date().toISOString(), dataSource: 'live', instanceAt: await this.dbNow(),
      scope: qaScopeView(scope), completeness: { complete: segment.next === null } };
    return { meta, ...textSegmentAnswer(head, segment), field: input.field };
  }

}
