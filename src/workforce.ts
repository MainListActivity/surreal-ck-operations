import { FaultStore } from './fault-store.ts';
import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { RecordId } from 'surrealdb';
import type { CompanyDatabase } from './database.ts';
import type { IndependencePolicy, IndependenceStage, Principal, RetirementKind, Role, TaskId, TaskKind } from './contracts.ts';
import { managerActionKey } from './dispatcher/dispatch-blocked.ts';
import { asId, CompanyError, HASH, id, ROLES, UNLOCK_SQL, view, type TaskRow } from './core.ts';
import { LocalEnrollmentAdmin, revokedCredentialDigest } from './enrollment.ts';
import { collectEvalState, writeScorecards, type EvalState, type ScoredEmployee } from './scoring.ts';
import { readContributors, readContributionView, type ContributionFacts } from './contributors.ts';
import { readIndependenceScope, type IndependenceScope } from './independence.ts';
import { dispatchVerdict } from './policy.ts';
import { chainOfTaskRow, readEffectiveContract, readTaskPolicyRow, registeredDomainsOf } from './policy-store.ts';
import { gateCredentialChange } from './retirement.ts';
import { acceptanceSubject, evaluateAcceptance, loadAcceptanceEvidence, loadAcceptanceGate, type AcceptanceTaskRow } from './acceptance.ts';
import { DispositionLedger, dispositionEpisodeKey, type DispositionDecisionView, type DispositionPhase, type HolderNoticeView } from './disposition.ts';
import { WaitStore, type WaitRow } from './wait-store.ts';
import { STANDBY_BUDGET_SECONDS_DEFAULT } from './standby-relay-capability.ts';
import type { WaitHandoffCard } from './waits.ts';
/**
 * Root-level workforce and lease supervision for the local dispatcher and admin CLI.
 * Never hand this object to the MCP adapter.
 */
export const PROVIDERS = ['codex', 'grok', 'devin'] as const;
export type Provider = typeof PROVIDERS[number];

export interface EmployeeDef {
  id: string;
  role: Role;
  provider: string;
  model: string;
  thinking?: string;
  /**
   * Discipline tracks this def covers (e.g. 编剧/分镜). Empty or absent accepts every
   * discipline; a non-empty list only claims tasks whose `discipline` is in it.
   */
  tracks?: string[];
  enabled: boolean;
  maxInstances: number;
  priority: number;
  /** 派工权重：同岗位候选中按 weight × 绩效系数 加权随机选取；0 = 永不主动选中。 */
  weight: number;
  /**
   * false = this def ignores quota-based dispatch gating: it is dispatched even when the
   * subscription's remaining allowance is 0. Absent/true = limited (the default).
   */
  quotaLimited?: boolean;
  scored: number;
  avgScore?: number;
  errorStreak: number;
}

export interface EmployeeInst {
  id: string;
  role: Role;
  def?: string;
  provider?: string;
  model?: string;
  thinking?: string;
  paseoAgentId?: string;
  activeTask?: string;
  credentialFile?: string;
  /** Minted at spawnInst or re-issued by rotate(); held by the caller (plugin sidecar) only. */
  credential?: string;
  lastWakeAt?: number;
  idleSince?: number;
  runtimeSleepRequestedAt?: number;
  onboarded?: boolean;
  /** Directory of the Paseo workspace this instance runs in (project repo, or the ops repo when undefined). */
  cwd?: string;
  repoHome?: string;
  /** Goal-scoped Paseo workspace; absent on legacy employee workspaces. */
  workspaceScope?: string;
  /** Registered identity principal (schema 029), when one is registered: the only cross-employee identity link (SYS-DISP Q3). */
  principal?: string;
  /** How many times the dispatcher woke this session; used to rotate it before the context grows too large. */
  wakeCount?: number;
}

export interface ProviderHealth {
  provider: string;
  state: 'healthy' | 'exhausted';
  until?: number;
  failures: number;
  lastError?: string;
}

export interface CompanyConfig {
  paused: boolean;
  maxRunning: number;
  providerMax: Record<string, number>;
  pollSeconds: number;
  stallMinutes: number;
  redispatchMinutes: number;
  extendWithinSeconds: number;
  handoverChars: number;
  evalEnabled: boolean;
  /** auto: Jev 直评、低置信度升级 LLM 评审员；llm: 只走 LLM 评审员；jev: 只走 Jev（低置信度也记录）。 */
  evalEngine: 'auto' | 'llm' | 'jev';
  /** Jev 单题置信度下限，低于则升级 LLM 评审员（auto 模式）。 */
  jevMinConfidence: number;
  /** Jev 员工风险标记 noul 阈值，达到则给老板发提醒。 */
  jevFlagThreshold: number;
  /** 配置了 Jev 时，用 noul 决定系统提醒是否弹桌面通知（否则只进收件箱）。 */
  jevNotifyTriage: boolean;
  /** 配置了 Jev 时，由 Jev 做目标分级、上线决定和老板升级路由；拿不准交回经理/运营。 */
  jevDecisions: boolean;
  /** 上线申请：Jev「可以上线」概率达到该值且「触碰红线」概率不高于 1 - 该值时自动批准。 */
  jevReleaseThreshold: number;
  /** 升级给老板的问题：Jev「必须老板决定」概率低于该值时改派给经理。 */
  jevOwnerThreshold: number;
  /** 派工选择候选员工时采信 Jev 答案的最低置信度；低于则回退权重随机。 */
  jevPickConfidence: number;
  /** 订阅剩余额度（任一额度窗口或余额）低于该百分比时视为不可用，停止复用与新开；0 = 不熔断。 */
  quotaFloorPct: number;
  quotaWeeklyFloorPct: number;
  /** 订阅剩余额度低于该百分比但尚未触及下限时，给老板发一次“即将用尽”提醒；0 = 不提醒。 */
  quotaWarnPct: number;
  /** 实例派工达到该次数即退休换新会话，避免上下文无限膨胀；0 = 不按次数轮换。 */
  sessionMaxWakes: number;
  /** 按岗位覆盖 sessionMaxWakes（如 { engineering: 4 }）：会话少带几轮旧任务历史，换来更小的请求上下文。 */
  sessionMaxWakesByRole: Record<string, number>;
  /** 实例上一轮 input token 超过该值（千）即退休换新会话；0 = 不按上下文大小轮换。 */
  sessionMaxInputK: number;
  /** 连续观测为空闲的会话在此分钟数后回收；0 = 关闭。 */
  sessionIdleMinutes: number;
  /** quick 目标的完成任务在 Jev 低置信度时是否升级 LLM 评审员；默认 false，直接记录 Jev 评分。 */
  evalQuickLlm: boolean;
  /** 每日简报的本地发送时刻（0-23 点，之后第一个周期发送）；-1 = 关闭。 */
  ownerBriefHour: number;
  /** 同一任务在员工与经理之间 block→resume 往返达到该次数就不再自动循环，升级给老板；0 = 关闭。 */
  blockLoopLimit: number;
  /** 宿主机空闲内存低于该 MB 数时暂停一切派工（新开与唤醒）；0 = 关闭。 */
  minFreeMemMb: number;
  /** 宿主机磁盘空闲低于该 MB 数时暂停一切派工；0 = 关闭。 */
  minFreeDiskMb: number;
  /** 终态任务大文件回收（evidence/deliverables 生命周期）；false 只停自动回收，人工 admin reclaim-artifacts 仍可用。 */
  artifactReclaimEnabled: boolean;
  /** done 任务 evidence 终态后完整保留的天数。 */
  artifactEvidenceGraceDays: number;
  /** done 任务 deliverables 终态后完整保留的天数（老板可点的交付链接）。 */
  artifactDeliverableGraceDays: number;
  /** 空闲磁盘低于「下限 + 该值」MB 时提前按压力回收，免得撞上暂停派工的下限；0 = 只在撞下限时回收。 */
  artifactHeadroomMb: number;
  /** archive/ 冷归档批次的保留天数（按批次目录的最后修改时间计时）；0 = 不自动清理归档。 */
  archiveRetentionDays: number;
  /** 已不在册的员工实例，其 comm/ 目录保留的小时数；0 = 不自动清理。 */
  commDirGraceHours: number;
  /** 员工临时文件目录 scratch/<实例> 的保留小时数，按目录最后修改时间计时；0 = 不自动清理。 */
  scratchGraceHours: number;
  /** FV06 P0：standby 直派的待命预算（秒）；standby_until = min(notAfter, now + standbyBudgetSeconds)。缺省 ≤600。 */
  standbyBudgetSeconds: number;
}

export const DEFAULT_CONFIG: CompanyConfig = {
  paused: false, maxRunning: 4, providerMax: { codex: 3, grok: 2, devin: 2 },
  pollSeconds: 20, stallMinutes: 90, redispatchMinutes: 15, extendWithinSeconds: 300, handoverChars: 12000,
  evalEnabled: true, evalEngine: 'auto', jevMinConfidence: 0.7, jevFlagThreshold: 0.65, jevNotifyTriage: true,
  jevDecisions: true, jevReleaseThreshold: 0.8, jevOwnerThreshold: 0.3, jevPickConfidence: 0.5,
  quotaFloorPct: 8, quotaWeeklyFloorPct: 6, quotaWarnPct: 20, sessionMaxWakes: 12, sessionMaxWakesByRole: {}, sessionMaxInputK: 200, sessionIdleMinutes: 120, evalQuickLlm: false, ownerBriefHour: 9, blockLoopLimit: 5,
  minFreeMemMb: 2048, minFreeDiskMb: 10240,
  artifactReclaimEnabled: true, artifactEvidenceGraceDays: 3, artifactDeliverableGraceDays: 7, artifactHeadroomMb: 10240,
  archiveRetentionDays: 7, commDirGraceHours: 48, scratchGraceHours: 24,
  standbyBudgetSeconds: STANDBY_BUDGET_SECONDS_DEFAULT,
};

/** 有效派工权重 = 配置的 weight × 绩效系数（无评分记录时系数为 1；5 分约 1.7 倍，1 分约 0.33 倍）。 */
export const effectiveWeight = (def: EmployeeDef | undefined): number => {
  const base = Math.max(0, def?.weight ?? 10);
  const factor = def?.avgScore && def.avgScore > 0 ? Math.min(Math.max(def.avgScore / 3, 0.3), 2) : 1;
  return base * factor;
};

/** 加权随机排序（不放回），rand 注入便于测试；权重全为 0 时退化为均匀随机。 */
export function weightedOrder<T>(items: T[], weightOf: (item: T) => number, rand: () => number): T[] {
  const pool = [...items];
  const out: T[] = [];
  while (pool.length) {
    const weights = pool.map(i => Math.max(0, weightOf(i)));
    const total = weights.reduce((s, w) => s + w, 0);
    let r = rand() * (total || pool.length);
    let index = pool.length - 1;
    for (let i = 0; i < pool.length; i++) {
      r -= total > 0 ? weights[i] : 1;
      if (r < 0) { index = i; break; }
    }
    out.push(pool.splice(index, 1)[0]);
  }
  return out;
}

export interface SupervisedTask {
  row: TaskRow;
  id: TaskId;
  state: TaskRow['state'];
  version: number;
  executorRole: Role;
  reviewerRole: string;
  discipline?: string;
  currentEmployee?: string;
  submittedBy?: string;
  previousEmployee?: string;
  /** Explicit code implementer; derived implementers come from contributors (see contributors.ts). */
  implementer?: string;
  /** Independence policy (SYS-DISP IR01): the dispatcher reads its exclusion per pass (IR02). */
  independence?: IndependencePolicy;
  /** Open dispatch-blocked episode: the phase it blocks and when it began (unix seconds). */
  dispatchBlockedPhase?: string;
  dispatchBlockedSince?: number;
  leaseExpiresAt?: number;
  progressAt?: number;
  blockedTo?: 'gm' | 'owner';
  /** Blocked rows: phase restored when the dependency wait ends (review stays review; execute returns ready). */
  resumeState?: TaskRow['state'];
  /** Blocked rows: role recorded by the original block. */
  resumeRole?: string;
  /** Unix seconds; set by a quota-caused block, gm is not re-announced before it. */
  quotaResetsAt?: number;
  /** FV06 P0: unix seconds. A standby direct-assignment expires here: before it, the idle holder is woken and
   * stall/expire reclaim is waived; past it the task returns to the gm gate instead of the ready pool. */
  standbyUntil?: number;
  /** SYS05: set while a typed wait owns the task. A waiting task takes no employee, lease or provider seat. */
  waitState?: 'waiting';
  waitKind?: string;
  /** Unix milliseconds: the absolute instant the time condition becomes true. */
  waitNotBefore?: number;
  waitExpiresAt?: number;
  waitNextCheckAt?: number;
  waitOwnerRole?: string;
  waitSource?: string;
  waitKey?: string;
  kind: string;
  title: string;
  /** Goal this task belongs to; dispatch-blocked conclusions carry it so goal cards can show the root blocker. */
  goalId?: string;
  evalAttempts: number;
  jevReleaseVersion?: number;
  jevRouteVersion?: number;
  ownerRerouted: boolean;
  /**
   * Effective code repo for dispatch (home grouping, spawn cwd/repoHome): the task's explicit
   * code_repo_path binding wins over the task project overlay, then the goal's project.
   * Undefined falls back to the ops repo.
   */
  repoPath?: string;
  /** Explicit code-repo binding (code_repo_path); informational — repoPath already resolves it. */
  codeRepoPath?: string;
  /** Tier of the goal this task belongs to (quick/standard/program); undefined for standalone tasks. */
  goalTier?: string;
  goalTitle?: string;
}

/** What Jev reads for a release or escalation decision. */
export interface JudgeInput {
  title: string;
  context: string;
  submission?: string;
  question?: string;
  blockedBy?: string;
  project?: { id: string; name: string; release?: string; redLines: string[] };
}

const supervised = (row: TaskRow): SupervisedTask => {
  const v = view(row);
  return { row, id: v.id, state: v.state, version: v.version, executorRole: v.executorRole, reviewerRole: v.reviewerRole,
    discipline: v.discipline,
    currentEmployee: row.current_employee ?? undefined, submittedBy: row.submitted_by ?? undefined,
    previousEmployee: row.previous_employee ?? undefined, implementer: row.implementer ?? undefined, independence: v.independence,
    dispatchBlockedPhase: row.dispatch_blocked_phase ?? undefined, dispatchBlockedSince: row.dispatch_blocked_since ?? undefined,
    leaseExpiresAt: row.lease_expires_at ?? undefined,
    progressAt: row.progress_at ?? undefined, blockedTo: row.blocked_to ?? undefined,
    resumeState: row.state === 'blocked' ? row.resume_state : undefined, resumeRole: row.state === 'blocked' ? row.resume_role : undefined,
    quotaResetsAt: row.quota_resets_at ?? undefined, standbyUntil: row.standby_until ?? undefined,
    kind: v.kind, title: v.title, goalId: v.goalId,
    ...(row.wait_state === 'waiting' ? {
      waitState: 'waiting' as const,
      ...(row.wait_kind === undefined || row.wait_kind === null ? {} : { waitKind: row.wait_kind }),
      ...(row.wait_not_before === undefined || row.wait_not_before === null ? {} : { waitNotBefore: row.wait_not_before }),
      ...(row.wait_expires_at === undefined || row.wait_expires_at === null ? {} : { waitExpiresAt: row.wait_expires_at }),
      ...(row.wait_next_check_at === undefined || row.wait_next_check_at === null ? {} : { waitNextCheckAt: row.wait_next_check_at }),
      ...(row.wait_owner_role === undefined || row.wait_owner_role === null ? {} : { waitOwnerRole: row.wait_owner_role }),
      ...(row.wait_source === undefined || row.wait_source === null ? {} : { waitSource: row.wait_source }),
      ...(row.wait_episode === undefined || row.wait_episode === null ? {} : { waitKey: row.wait_episode }),
    } : {}),
    evalAttempts: row.eval_attempts ?? 0, jevReleaseVersion: row.jev_release_version ?? undefined,
    jevRouteVersion: row.jev_route_version ?? undefined, ownerRerouted: row.owner_rerouted === true, repoPath: row.repo_path ?? undefined,
    codeRepoPath: row.code_repo_path ?? undefined, goalTier: row.goal_tier ?? undefined, goalTitle: row.goal_title ?? undefined };
};

const COOLDOWN_BASE = 30 * 60;
const COOLDOWN_MAX = 6 * 60 * 60;
export const capabilitiesFor = (role: Role): Principal['capabilities'] =>
  role === 'eval' ? [] : role === 'gm' || role === 'product' ? ['execute', 'review', 'manage'] : ['execute', 'review'];

/** One manager todo to persist: task + phase + episode + reason identify it; the action is what the manager can do. */
export interface ManagerActionInput {
  taskId: string;
  phase: 'execute' | 'review';
  episode: number;
  reason: string;
  action: 'implementer_takeover';
  version: number;
  repo: string;
  implementer?: string;
}

export interface ManagerActionRow extends ManagerActionInput {
  key: string;
  status: 'open' | 'closed';
  createdAt?: string;
  closedAt?: string;
  resolution?: string;
}

/** One manager-wake attempt. It lives in the same schemaless dispatch table, keyed by task+phase+episode. */
export type ManagerWakeState = 'pending' | 'running' | 'finished' | 'unknown';

export interface ManagerWakeInput {
  taskId: string;
  phase: 'execute' | 'review';
  /** Episode start in milliseconds (the same value managerActionKey carries). */
  episode: number;
  reason: string;
  version: number;
  repo: string;
}

export interface ManagerWakeRow extends ManagerWakeInput {
  key: string;
  purpose: 'gm-manager-wake';
  state: ManagerWakeState;
  attempt: number;
  token: string;
  employee?: string;
  agent?: string;
  /** Unix seconds. */
  startedAt?: number;
  externalStartedAt?: number;
  lastCheckedAt?: number;
  lastStatus?: string;
  resolution?: string;
  updatedAt?: number;
}

/** The CAS token a dispatcher must present for every later write to this attempt. */
export interface ManagerWakeClaim {
  key: string;
  token: string;
  attempt: number;
  input: ManagerWakeInput;
}

/** Logical in-flight unit: task + phase + episode. Reason/version are fields, not part of the key. */
export const managerWakeKey = (taskId: string, phase: string, episode: number) => `${taskId}:${phase}:${episode}`;

/** A pending attempt with no external-start evidence is safe to release only after this conservative grace. */
export const MANAGER_WAKE_PENDING_GRACE_SECONDS = 120;
/** An observed idle turn is a definite end only after the external action has had this long to start. */
export const MANAGER_WAKE_TURN_GRACE_SECONDS = 60;

/** SYS03: the disposition facts the wake loop needs for one episode, read without any credential (dispatcher). */
export interface DispositionEpisodeFacts {
  episode: string;
  taskId: string;
  phase: DispositionPhase;
  sinceMs: number;
  status: 'claimed' | 'decided';
  holder?: string;
  leaseExpiresAt?: number;
  decision?: DispositionDecisionView;
}

/**
 * SYS04 AC04: the fault episode facts the dispatcher reads before it wakes a manager.
 *
 * `state` is the episode's own state: `opened` (one report, one notice), `converged` (further reports of the
 * same evidence), `exhausted` (the recovery budget is spent and the repair chain is the way out) and `resolved`
 * (the repair finished, so a later report may open a new stage). `notified` says whether the manager has
 * already been told about this cause.
 */
export interface FaultEpisodeFacts {
  updatedAt?: string;
  notifiedAt?: string;
  notifiedStageAt?: string;
  episode: string;
  fingerprint: string;
  incident: string;
  taskId: string;
  phase: string;
  state: 'opened' | 'converged' | 'exhausted' | 'stopped' | 'resolved';
  evidenceRevision: number;
  notified: boolean;
}

export class Workforce {
  private readonly enrollment: LocalEnrollmentAdmin;
  /** SYS03: the disposition ledger, read here for the dispatcher's pre-wake guard and for notice delivery. */
  private readonly dispositions: DispositionLedger;
  /** SYS05: the wait ledger, read by the dispatcher to release due conditions once per tick. */
  private readonly waits: WaitStore;
  /**
   * `retirementHook` is a test seam (SYS-DISP R1 race tests): it runs once the retirement decision has been read and before its
   * write, so a test can land a claim or takeover in exactly that window.
   */
  constructor(private readonly database: CompanyDatabase, private readonly credentialDir: string,
    private readonly retirementHook?: (employeeId: string) => Promise<void>) {
    this.enrollment = new LocalEnrollmentAdmin(database);
    this.dispositions = new DispositionLedger(database);
    this.waits = new WaitStore(database.db);
  }
  private get db() { return this.database.db; }
  private async now(): Promise<number> {
    const [[value]] = await this.db.query<[[number]]>('RETURN [time::unix(time::now())];');
    return value;
  }

  async config(): Promise<CompanyConfig> {
    const row = await this.db.select<Partial<Record<string, unknown>>>(new RecordId('company_meta', 'config'));
    const pick = <K extends keyof CompanyConfig>(key: K, snake: string) =>
      (row?.[snake] ?? row?.[key] ?? DEFAULT_CONFIG[key]) as CompanyConfig[K];
    return {
      paused: Boolean(row?.paused),
      maxRunning: pick('maxRunning', 'max_running'),
      providerMax: { ...DEFAULT_CONFIG.providerMax, ...(pick('providerMax', 'provider_max') as Record<string, number>) },
      pollSeconds: pick('pollSeconds', 'poll_seconds'),
      stallMinutes: pick('stallMinutes', 'stall_minutes'),
      redispatchMinutes: pick('redispatchMinutes', 'redispatch_minutes'),
      extendWithinSeconds: pick('extendWithinSeconds', 'extend_within_seconds'),
      handoverChars: pick('handoverChars', 'handover_chars'),
      evalEnabled: row?.eval_enabled !== false,
      evalEngine: (engine => (engine === 'llm' || engine === 'jev' ? engine : 'auto'))(String(row?.eval_engine ?? 'auto')),
      jevMinConfidence: typeof row?.jev_min_confidence === 'number' ? row.jev_min_confidence : 0.7,
      jevFlagThreshold: typeof row?.jev_flag_threshold === 'number' ? row.jev_flag_threshold : 0.65,
      jevNotifyTriage: row?.jev_notify_triage !== false,
      jevDecisions: row?.jev_decisions !== false,
      jevReleaseThreshold: typeof row?.jev_release_threshold === 'number' ? row.jev_release_threshold : 0.8,
      jevOwnerThreshold: typeof row?.jev_owner_threshold === 'number' ? row.jev_owner_threshold : 0.3,
      jevPickConfidence: typeof row?.jev_pick_confidence === 'number' ? row.jev_pick_confidence : 0.5,
      quotaFloorPct: typeof row?.quota_floor_pct === 'number' ? row.quota_floor_pct : 8,
      quotaWeeklyFloorPct: typeof row?.quota_weekly_floor_pct === 'number' ? row.quota_weekly_floor_pct : DEFAULT_CONFIG.quotaWeeklyFloorPct,
      quotaWarnPct: typeof row?.quota_warn_pct === 'number' ? row.quota_warn_pct : DEFAULT_CONFIG.quotaWarnPct,
      sessionMaxWakes: typeof row?.session_max_wakes === 'number' ? row.session_max_wakes : 8,
      sessionMaxWakesByRole: Object.fromEntries(Object.entries(row?.session_max_wakes_by_role && typeof row.session_max_wakes_by_role === 'object' ? row.session_max_wakes_by_role : {})
        .filter((e): e is [string, number] => typeof e[1] === 'number' && Number.isInteger(e[1]) && e[1] >= 0)),
      sessionIdleMinutes: typeof row?.session_idle_minutes === 'number' && Number.isFinite(row.session_idle_minutes) && row.session_idle_minutes >= 0 ? row.session_idle_minutes : DEFAULT_CONFIG.sessionIdleMinutes,
      sessionMaxInputK: typeof row?.session_max_input_k === 'number' ? row.session_max_input_k : DEFAULT_CONFIG.sessionMaxInputK,
      evalQuickLlm: row?.eval_quick_llm === true,
      ownerBriefHour: typeof row?.owner_brief_hour === 'number' ? row.owner_brief_hour : 9,
      minFreeMemMb: typeof row?.min_free_mem_mb === 'number' ? row.min_free_mem_mb : DEFAULT_CONFIG.minFreeMemMb,
      minFreeDiskMb: typeof row?.min_free_disk_mb === 'number' ? row.min_free_disk_mb : DEFAULT_CONFIG.minFreeDiskMb,
      artifactReclaimEnabled: row?.artifact_reclaim_enabled !== false,
      artifactEvidenceGraceDays: typeof row?.artifact_evidence_grace_days === 'number' ? row.artifact_evidence_grace_days : DEFAULT_CONFIG.artifactEvidenceGraceDays,
      artifactDeliverableGraceDays: typeof row?.artifact_deliverable_grace_days === 'number' ? row.artifact_deliverable_grace_days : DEFAULT_CONFIG.artifactDeliverableGraceDays,
      artifactHeadroomMb: typeof row?.artifact_headroom_mb === 'number' ? row.artifact_headroom_mb : DEFAULT_CONFIG.artifactHeadroomMb,
      archiveRetentionDays: typeof row?.archive_retention_days === 'number' ? row.archive_retention_days : DEFAULT_CONFIG.archiveRetentionDays,
      commDirGraceHours: typeof row?.comm_dir_grace_hours === 'number' ? row.comm_dir_grace_hours : DEFAULT_CONFIG.commDirGraceHours,
      scratchGraceHours: typeof row?.scratch_grace_hours === 'number' ? row.scratch_grace_hours : DEFAULT_CONFIG.scratchGraceHours,
      standbyBudgetSeconds: typeof row?.standby_budget_seconds === 'number' && row.standby_budget_seconds > 0
        ? row.standby_budget_seconds : STANDBY_BUDGET_SECONDS_DEFAULT,
      blockLoopLimit: typeof row?.block_loop_limit === 'number' ? row.block_loop_limit : 5,
    };
  }

  // ---- employee definitions ----
  async upsertDef(defId: string, input: { role: Role; provider: string; model: string; thinking?: string; tracks?: string[]; maxInstances?: number; priority?: number; weight?: number; enabled?: boolean; quotaLimited?: boolean }): Promise<void> {
    if (!/^[a-z0-9][a-z0-9-]{2,40}$/.test(defId)) throw new CompanyError('invalid', 'Invalid def ID');
    if (!ROLES.includes(input.role)) throw new CompanyError('invalid', 'Invalid role');
    if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(input.provider)) throw new CompanyError('invalid', 'Invalid provider');
    if (input.weight !== undefined && (!Number.isInteger(input.weight) || input.weight < 0 || input.weight > 1000)) {
      throw new CompanyError('invalid', 'Invalid weight');
    }
    await this.db.query(`UPSERT $def MERGE {
      role: $role, provider: $provider, model: $model, thinking: $thinking,
      max_instances: $max, priority: $priority, weight: $weight, enabled: $enabled };`, {
      def: id('employee_def', defId), role: input.role, provider: input.provider, model: input.model,
      thinking: input.thinking, max: input.maxInstances ?? 1, priority: input.priority ?? 100,
      weight: input.weight ?? 10, enabled: input.enabled ?? true,
    });
    // Tracks are written separately so an upsert without the field keeps the stored list;
    // pass [] to clear (a def then accepts every discipline again).
    if (input.tracks !== undefined) {
      await this.db.query('UPDATE $def SET tracks = $tracks;', { def: id('employee_def', defId), tracks: input.tracks });
    }
    // Written separately like tracks: an upsert that does not mention the flag keeps the stored
    // value, so editing other fields can never silently re-apply the quota limit.
    if (input.quotaLimited !== undefined) {
      await this.db.query('UPDATE $def SET quota_limited = $q;', { def: id('employee_def', defId), q: input.quotaLimited });
    }
  }

  async defs(): Promise<EmployeeDef[]> {
    type Row = { id: RecordId; role: Role; provider: string; model: string; thinking?: string; tracks?: string[]; enabled: boolean;
      max_instances: number; priority: number; weight?: number; quota_limited?: boolean; scored?: number; avg_score?: number; error_streak?: number };
    const [rows] = await this.db.query<[Row[]]>('SELECT * FROM employee_def ORDER BY weight DESC, priority, id;');
    return rows.map(r => ({ id: asId(r.id), role: r.role, provider: r.provider, model: r.model, thinking: r.thinking ?? undefined,
      tracks: r.tracks ?? undefined,
      enabled: r.enabled !== false, maxInstances: r.max_instances ?? 1, priority: r.priority ?? 100,
      weight: r.weight ?? 10, quotaLimited: r.quota_limited === false ? false : undefined,
      scored: r.scored ?? 0, avgScore: r.avg_score ?? undefined, errorStreak: r.error_streak ?? 0 }));
  }

  async defFailure(defId: string): Promise<number> {
    const [[row]] = await this.db.query<[[{ error_streak: number }]]>(
      'UPDATE $def SET error_streak = (error_streak ?? 0) + 1 RETURN error_streak;', { def: id('employee_def', defId) });
    return row?.error_streak ?? 0;
  }
  async defHealthy(defId: string): Promise<void> {
    await this.db.query('UPDATE $def SET error_streak = 0 WHERE error_streak > 0;', { def: id('employee_def', defId) });
  }
  async disableDef(defId: string, reason: string): Promise<void> {
    await this.db.query('UPDATE $def SET enabled = false, disabled_reason = $reason, disabled_at = time::now();',
      { def: id('employee_def', defId), reason });
  }

  // ---- employee instances ----
  async insts(): Promise<EmployeeInst[]> {
    type Row = { id: RecordId; role: Role; def?: RecordId; principal?: RecordId; provider?: string; model?: string; thinking?: string;
      paseo_agent_id?: string; active_task?: RecordId; credential_file?: string; last_wake_at?: number; idle_since?: number; runtime_sleep_requested_at?: number;
      v3_onboarded?: boolean; workspace_cwd?: string; workspace_repo?: string; workspace_scope?: string; wake_count?: number };
    const [rows] = await this.db.query<[Row[]]>(
      'SELECT * FROM employee WHERE revoked != true AND retired != true AND (def != NONE OR paseo_agent_id != NONE) ORDER BY id;');
    return rows.map(r => ({ id: asId(r.id), role: r.role, def: r.def ? asId(r.def) : undefined, provider: r.provider,
      model: r.model, thinking: r.thinking, paseoAgentId: r.paseo_agent_id ?? undefined,
      activeTask: r.active_task ? asId(r.active_task) : undefined, credentialFile: r.credential_file, lastWakeAt: r.last_wake_at, idleSince: r.idle_since, runtimeSleepRequestedAt: r.runtime_sleep_requested_at,
      onboarded: Boolean(r.v3_onboarded), cwd: r.workspace_cwd ?? undefined, repoHome: r.workspace_repo ?? undefined, workspaceScope: r.workspace_scope ?? undefined, wakeCount: r.wake_count ?? 0,
      principal: r.principal ? asId(r.principal) : undefined }));
  }

  /** Creates an employee identity for a definition; the caller binds the Paseo agent once spawned.
   *  The credential is returned in memory only — file delivery is the caller's choice
   *  (writeCredentialFile for the legacy standalone dispatcher; plugin sidecar keeps it in RAM). */
  async spawnInst(def: EmployeeDef, repoHome?: string, workspaceScope?: string): Promise<EmployeeInst> {
    const employeeId = `${def.id}-${randomBytes(3).toString('hex')}`;
    const credential = await this.enrollment.enroll(employeeId, def.role, capabilitiesFor(def.role));
    await this.db.query(`UPDATE $e MERGE { def: $def, provider: $provider, model: $model, thinking: $thinking,
      retired: false, workspace_repo: $repo_home, workspace_scope: $scope, created_at: time::now() };`, {
      e: id('employee', employeeId), def: id('employee_def', def.id), provider: def.provider, model: def.model,
      thinking: def.thinking, repo_home: repoHome, scope: workspaceScope,
    });
    return { repoHome, workspaceScope, id: employeeId, role: def.role, def: def.id, provider: def.provider, model: def.model, thinking: def.thinking, credential };
  }

  /** Legacy agent delivery: write the credential to a 600 file the agent's env can point at. */
  writeCredentialFile(inst: EmployeeInst, credential: string): string {
    mkdirSync(this.credentialDir, { recursive: true, mode: 0o700 });
    const credentialFile = join(this.credentialDir, `${inst.id}.token`);
    const fd = openSync(credentialFile, 'wx', 0o600);
    try { writeSync(fd, credential); } finally { closeSync(fd); }
    return credentialFile;
  }

  /** Re-issues the instance credential and returns it; the old one dies with the digest swap. */
  async rotate(employeeId: string): Promise<string> {
    const token = `sck_${randomBytes(32).toString('base64url')}`;
    const [rows] = await this.db.query<[unknown[]]>(
      'UPDATE $e SET credential_digest = $digest WHERE revoked != true AND retired != true RETURN AFTER;', {
      e: id('employee', employeeId),
      digest: createHash('sha256').update(token).digest('hex'),
    });
    if (!rows?.length) throw new CompanyError('unauthorized', 'Employee retired or revoked');
    return token;
  }

  async bind(employeeId: string, input: { agentId: string; def?: string; provider?: string; model?: string; thinking?: string; credentialFile?: string; cwd?: string; repoHome?: string; workspaceScope?: string }): Promise<void> {
    const [rows] = await this.db.query<[unknown[]]>(`UPDATE $e MERGE {
      paseo_agent_id: $agent, def: $def ?? def, provider: $provider ?? provider, model: $model ?? model,
      thinking: $thinking ?? thinking, credential_file: $file ?? credential_file, workspace_cwd: $cwd ?? workspace_cwd, workspace_repo: $repo_home ?? workspace_repo, workspace_scope: $scope ?? workspace_scope, retired: false } RETURN AFTER;`, {
      e: id('employee', employeeId), agent: input.agentId, def: input.def ? id('employee_def', input.def) : undefined,
      provider: input.provider, model: input.model, thinking: input.thinking, file: input.credentialFile, cwd: input.cwd, repo_home: input.repoHome, scope: input.workspaceScope,
    });
    if (!rows?.length) throw new CompanyError('not_found', 'Employee not found');
  }

  /**
   * Retires an instance and revokes its credential, so a crashed session cannot act again. The retirement gate is the one boundary
   * every retirement and credential revocation passes (see gateCredentialChange in retirement.ts): admin CLI, dispatcher and scene
   * cleaner. An employee who still holds a lease or is bound to unfinished work is refused with RETIRE_REFUSED before any write. An
   * accepted retirement is one transaction that re-derives the employee's unfinished relations and writes only if they are the ones
   * the decision saw. The kind is recorded by the first retirement only: a later one cannot turn a non-normal retirement into a
   * normal one.
   */
  async retire(employeeId: string, reason: string, kind: RetirementKind, idle?: EmployeeInst): Promise<void> {
    const [exists] = await this.db.query<[unknown]>('SELECT VALUE id FROM ONLY $e;', { e: id('employee', employeeId) });
    if (!exists) throw new CompanyError('not_found', 'Employee not found');
    await gateCredentialChange(this.db, employeeId, {
      operation: 'retire',
      statement: `IF $idle_guard = true {
        LET $observed = SELECT * FROM ONLY $employee;
        IF ($observed.idle_since ?? NONE) != $idle_since OR ($observed.last_wake_at ?? NONE) != $last_wake OR $observed.paseo_agent_id != $agent { THROW 'idle retirement moved' };
        LET $wakes = SELECT VALUE id FROM dispatch WHERE purpose = 'gm-manager-wake' AND state IN ['pending', 'running', 'unknown'] AND (employee = $key OR agent = $agent);
        IF array::len($wakes) > 0 { THROW 'idle retirement protected by manager wake' };
      };
      UPDATE $employee SET retired_kind = IF retired = true THEN retired_kind ELSE $kind END,
        retired = true, retired_reason = $reason, retired_at = time::now(), revoked = true, credential_digest = $digest;`,
      vars: { kind, reason, digest: revokedCredentialDigest(), idle_guard: !!idle, idle_since: idle?.idleSince, last_wake: idle?.lastWakeAt, agent: idle?.paseoAgentId },
    }, this.retirementHook);
  }

  /** A turn can start and finish between polls; its lifecycle event invalidates any old idle timer. */
  async clearIdleForAgent(agentId: string): Promise<void> {
    await this.db.query('UPDATE employee SET idle_since = NONE WHERE paseo_agent_id = $agent AND retired != true;', { agent: agentId });
  }

  async observeSessionIdle(observations: Array<{ id: string; since?: number; lastWakeAt?: number; previousIdleSince?: number }>): Promise<void> {
    if (!observations.length) return;
    await this.db.query(`FOR $o IN $observations {
      UPDATE employee SET idle_since = $o.since WHERE id = $o.employee AND retired != true AND (last_wake_at ?? NONE) = $o.last_wake AND ($o.guard != true OR (idle_since ?? NONE) = $o.previous);
    };`, { observations: observations.map(o => ({ employee: id('employee', o.id), since: o.since, last_wake: o.lastWakeAt, guard: Object.hasOwn(o,"previousIdleSince"), previous: o.previousIdleSince })) });
  }

  /** A short claim barrier while the native runtime closes; no credential or identity is revoked. */
  async reserveRuntimeSleep(inst: EmployeeInst, now: number): Promise<boolean> {
    if (inst.idleSince === undefined || now - inst.idleSince < 3600) return false;
    const result = await this.runTxResult<boolean>(`BEGIN;
      LET $e = SELECT * FROM ONLY $employee;
      LET $held = SELECT VALUE id FROM task WHERE current_employee = $key AND state IN ['ready','doing','review','blocked'];
      LET $wakes = SELECT VALUE id FROM dispatch WHERE purpose = 'gm-manager-wake' AND state IN ['pending','running','unknown'] AND (employee = $key OR agent = $agent);
      LET $safe = $e != NONE AND $e.retired != true AND $e.revoked != true AND ($e.active_task ?? NONE) = NONE
        AND $e.paseo_agent_id = $agent AND $e.idle_since = $since AND ($e.last_wake_at ?? NONE) = $last_wake
        AND ($e.runtime_sleep_until ?? 0) <= $now AND array::len($held) = 0 AND array::len($wakes) = 0;
      IF $safe { UPDATE ONLY $employee SET runtime_sleep_until = $now + 120, runtime_sleep_requested_at = $now; };
      RETURN $safe;
      COMMIT;`, { employee: id('employee',inst.id), key: inst.id, agent: inst.paseoAgentId, since: inst.idleSince, last_wake: inst.lastWakeAt, now });
    return result === true;
  }

  /** Rechecked after MCP initialization, immediately before sending a destructive runtime operation. */
  async confirmRuntimeSleep(inst: EmployeeInst, requestedAt: number): Promise<boolean> {
    const [safe] = await this.db.query<[boolean]>(`RETURN (SELECT VALUE count() FROM employee WHERE id=$e
      AND runtime_sleep_requested_at=$requested AND runtime_sleep_until > time::unix(time::now()) + 30
      AND (active_task ?? NONE)=NONE AND idle_since=$since AND (last_wake_at ?? NONE)=$wake
      AND paseo_agent_id=$agent AND retired!=true AND revoked!=true GROUP ALL)[0] = 1;`,
      {e:id('employee',inst.id),requested:requestedAt,since:inst.idleSince,wake:inst.lastWakeAt,agent:inst.paseoAgentId});
    return safe===true;
  }

  async releaseRuntimeSleep(employeeId: string, now: number): Promise<void> {
    await this.db.query('UPDATE $e SET runtime_sleep_until = NONE WHERE runtime_sleep_requested_at = $now;',
      {e: id('employee',employeeId), now});
  }

  async retireIdle(inst: EmployeeInst): Promise<void> {
    if (inst.idleSince === undefined) throw new CompanyError('retire_refused', 'Missing idle observation');
    await this.retire(inst.id, '连续观测空闲超过配置时长，正常回收会话', 'rotation', inst);
  }

  async touchWake(employeeId: string): Promise<void> {
    await this.db.query('UPDATE $e SET last_wake_at = time::unix(time::now()), idle_since = NONE, runtime_sleep_requested_at = NONE, v3_onboarded = true, wake_count = (wake_count ?? 0) + 1;',
      { e: id('employee', employeeId) });
  }

  /** Refund only the rejected wake, once per stable Paseo turn id, including after a plugin restart. */
  async refundQuotaWake(employeeId: string, turnId: string): Promise<void> {
    const key = createHash('sha256').update(`${employeeId}\0${turnId}`).digest('hex');
    await this.db.query(`BEGIN;
      LET $prior = SELECT * FROM ONLY $marker;
      IF $prior = NONE {
        UPDATE $e SET wake_count = math::max([0, (wake_count ?? 0) - 1]);
        CREATE ONLY $marker CONTENT { employee: $employee, at: time::now() };
      };
      COMMIT;`, { e: id('employee', employeeId), employee: employeeId, marker: id('company_meta', `infra_refund_${key}`) });
  }

  // ---- provider health ----
  async providerHealth(): Promise<Map<string, ProviderHealth>> {
    type Row = { id: RecordId; state: ProviderHealth['state']; until?: number; failures?: number; last_error?: string };
    const [rows] = await this.db.query<[Row[]]>('SELECT * FROM provider_health;');
    return new Map(rows.map(r => [asId(r.id), { provider: asId(r.id), state: r.state, until: r.until,
      failures: r.failures ?? 0, lastError: r.last_error }]));
  }

  /**
   * Cools a provider down after a quota failure. `resetsAt` (unix seconds) is the upstream reset
   * time when something actually knows it (magpie reports it per window); the exponential backoff
   * still applies as a floor so a stale or wrong upstream time cannot shorten the cooldown.
   */
  async markExhausted(provider: string, error: string, resetsAt?: number): Promise<ProviderHealth> {
    const current = (await this.providerHealth()).get(provider);
    const failures = (current?.failures ?? 0) + 1;
    const backoff = (await this.now()) + Math.min(COOLDOWN_BASE * 2 ** (failures - 1), COOLDOWN_MAX);
    const until = resetsAt !== undefined && resetsAt > backoff ? resetsAt : backoff;
    await this.db.query(`UPSERT $p CONTENT { state: 'exhausted', until: $until, failures: $failures,
      last_error: $error, changed_at: time::now() };`, { p: id('provider_health', provider), until, failures, error: error.slice(0, 500) });
    return { provider, state: 'exhausted', until, failures, lastError: error };
  }

  async markHealthy(provider: string): Promise<void> {
    await this.db.query(`UPSERT $p CONTENT { state: 'healthy', failures: 0, changed_at: time::now() };`,
      { p: id('provider_health', provider) });
  }

  // ---- lease supervision ----
  async tasks(): Promise<SupervisedTask[]> {
    // context is ~77% of table bytes and dispatch never reads it; over a ~50KB/s WSS
    // channel carrying it would stall every other query behind megabytes of backlog.
    const [rows] = await this.db.query<[TaskRow[]]>(
      `SELECT *, NONE AS context, code_repo_path ?? project.repo_path ?? goal.project.repo_path AS repo_path, goal.tier AS goal_tier, goal.title AS goal_title
       FROM task WHERE state IN ['ready', 'doing', 'review', 'blocked'] ORDER BY created_at, id;`);
    return rows.map(supervised);
  }

  /**
   * FV06: grants the dispatcher may wake their named employee for. Read-only and bounded: only an unexpired
   * grant whose source task is still done. The sidecar re-checks every one of these before binding.
   */
  async activeRecoveryGrants(nowMs: number): Promise<Array<{
    id: string; employeeId: string; taskId: string; alias: string; paths: string[]; expiresAt: string; state: string;
  }>> {
    const [rows] = await this.db.query<[Array<{ id: RecordId; employee: RecordId; source_task: RecordId; alias: string;
      paths: string[]; expires_at: unknown; state: string }>]>(
      `SELECT id, employee, source_task, alias, paths, expires_at, state FROM recovery_read_grant
        WHERE state IN ['issued', 'bound', 'running'] AND expires_at > time::now()
        ORDER BY created_at;`);
    const out = [];
    for (const row of rows) {
      const source = await this.db.select<{ state?: string }>(row.source_task);
      if (source?.state !== 'done') continue;
      const expiresAt = row.expires_at instanceof Date ? row.expires_at.toISOString() : String(row.expires_at);
      if (Date.parse(expiresAt) <= nowMs) continue;
      out.push({ id: asId(row.id), employeeId: asId(row.employee), taskId: asId(row.source_task),
        alias: row.alias, paths: [...row.paths], expiresAt, state: row.state });
    }
    return out;
  }

  /**
   * SYS05: release the wait conditions that are true now. A time wait releases once (the store's compare-and-set
   * makes twenty ticks one release); a dependency wait releases when its reference task is done or void; nothing
   * is released past an unfinished dependency or an owner gate. Waits whose precise expiry passed first become
   * `expired` and are not auto-released.
   */
  async releaseDueWaits(nowMs: number): Promise<{
    released: Array<{ waitKey: string; taskId: string }>;
    held: Array<{ waitKey: string; taskId: string; reason: string }>;
    expired: Array<{ waitKey: string; taskId: string }>;
  }> {
    const expired = await this.waits.markExpired(nowMs);
    const due = await this.waits.releaseDue(nowMs);
    return { released: due.released, held: due.held, expired: [...expired, ...due.expired] };
  }

  /** SYS05: owner handoff cards for the inbox and the dispatcher's deduped reminders. */
  async waitHandoffCards(nowMs: number): Promise<WaitHandoffCard[]> {
    return this.waits.handoffCards(nowMs);
  }

  /** SYS05: waits whose next human check is due. Raises a look-at-it reminder; releases nothing. */
  async dueWaitChecks(nowMs: number): Promise<WaitRow[]> {
    return this.waits.dueChecks(nowMs);
  }

  /** SYS05: expired waits that still need an explicit cancel/extend decision. */
  async expiredWaitChecks(): Promise<WaitRow[]> {
    return this.waits.expiredChecks();
  }

  /** SYS05: the waits of one task, newest first (used by the owner relay and by tests). */
  async taskWaits(taskId: string): Promise<WaitRow[]> {
    return this.waits.waitsOfTask(taskId);
  }

  /** Metrics + timeline a judge needs to score a finished task (shared with the Jev dispatcher path). */
  async requireFullModelEvaluation(taskId: TaskId): Promise<void> {    await this.db.query("UPDATE $task SET model_eval_full_history=true WHERE state='done';",{task:id('task',taskId)});
  }

  async evalState(taskId: TaskId): Promise<EvalState> {
    return collectEvalState(this.db, taskId);
  }

  /**
   * The exclusion a task's independence policy names at one stage (SYS-DISP IR02): undefined when the policy does not name the stage.
   * An unreadable source comes back as unverifiable, so the pool blocks it rather than reading it as clear.
   */
  async independenceScope(policy: IndependencePolicy | undefined, stage: IndependenceStage): Promise<IndependenceScope | undefined> {
    return readIndependenceScope(this.db, policy, stage);
  }

  /**
   * The task's verdict under the effective policy contract (SYS06 AC02/RB01): the dispatch-time half of the same judgement the
   * claim path and the ops broker read. It reads the same `policy` rows through policy-store.ts and decides with the same
   * policy.ts, so a task this returns `blocked` for can never be dispatched to anyone — and never becomes "busy" instead.
   */
  async policyDispatchVerdict(taskId: TaskId): Promise<{ verdict: 'clear' | 'stale' | 'blocked'; reason?: string; hash?: string } | undefined> {
    const row = await readTaskPolicyRow(this.db, taskId);
    if (!row) return undefined;
    const chain = chainOfTaskRow(row);
    const { contract } = await readEffectiveContract(this.db, chain, Math.floor(Date.now() / 1000));
    return dispatchVerdict({ state: row.state, executorRole: row.executor_role as Role,
      kind: (row.kind ?? 'task') as TaskKind,
      ...(row.goal ? { goalId: asId(row.goal) } : {}),
      ...(row.work_intent ? { workIntent: row.work_intent } : {}),
      ...(row.policy_hash ? { policyHash: row.policy_hash } : {}),
      ...(row.policy_block_reason ? { policyBlockReason: row.policy_block_reason } : {}),
      registeredDomains: registeredDomainsOf(row) }, contract);
  }

  /** Authorship facts (authors, reviewers, implementer) from the audit stream: the review and execute gates. */
  async contributors(taskId: TaskId): Promise<ContributionFacts & { checkedAt?: string }> {
    const view = await readContributionView(this.db, taskId);
    return { ...view.facts, checkedAt: view.checkedAt };
  }

  /** Persists or clears a task's open dispatch-blocked episode (phase and start, unix seconds). */
  async setDispatchBlock(taskId: TaskId, phase: string | undefined, since?: number): Promise<void> {
    await this.db.query('UPDATE $task SET dispatch_blocked_phase = $phase, dispatch_blocked_since = $since;',
      { task: id('task', taskId), phase: phase ?? null, since: since ?? null });
  }

  /** When each ready task last became ready (unix milliseconds), read in one query. Tasks with no such audit row are absent. */
  async readySince(taskIds: readonly string[]): Promise<Map<string, number>> {
    const since = new Map<string, number>();
    if (taskIds.length === 0) return since;
    const [rows] = await this.db.query<[Array<{ task: unknown; at: unknown }>]>(
      `SELECT task, at FROM audit WHERE task IN $ids
       AND action IN ['create', 'dependency_unlocked', 'return', 'release', 'revoke', 'resume'] ORDER BY at DESC;`,
      { ids: taskIds.map(taskId => id('task', taskId)) });
    for (const row of rows ?? []) {
      const key = asId(row.task);
      if (!since.has(key) && row.at !== undefined && row.at !== null) since.set(key, Date.parse(String(row.at)));
    }
    return since;
  }

  /** Record a Jev-produced evaluation: scorecards + evaluated_at + audit/outbox + rolling averages. */
  async recordJevEvaluation(
    taskId: TaskId, judge: string, summary: string,
    scores: ScoredEmployee[], state: EvalState, topPerformer?: string,
  ): Promise<{ recorded: number; participants: string[] }> {
    return writeScorecards(this.db, { taskId, summary, judge, judgeKind: 'jev', scores, state, topPerformer });
  }

  /** Count one Jev attempt so repeated API failures fall back to the LLM judge path. */
  async bumpEvalAttempt(taskId: TaskId): Promise<number> {
    const [row] = await this.db.query<[{ eval_attempts?: number }]>(
      'UPDATE ONLY $t SET eval_attempts = (eval_attempts ?? 0) + 1 RETURN AFTER;', { t: new RecordId('task', taskId) });
    return row?.eval_attempts ?? 1;
  }

  /** Done tasks not yet performance-evaluated, oldest first. */
  async pendingEvaluations(limit = 3): Promise<SupervisedTask[]> {
    const [rows] = await this.db.query<[TaskRow[]]>(
      "SELECT *, goal.tier AS goal_tier FROM task WHERE state = 'done' AND evaluated_at = NONE ORDER BY created_at, id LIMIT $limit;", { limit });
    return rows.map(supervised);
  }

  /** Extends a live holder's lease without changing version, fence or delivery. */
  async projectRepos(): Promise<string[]> {
    const [rows] = await this.db.query<[Array<{ repo_path: string }>]>('SELECT repo_path FROM project;');
    return rows.map(r => r.repo_path);
  }

  async doneTaskIds(): Promise<string[]> {
    const [rows] = await this.db.query<[RecordId[]]>("SELECT VALUE id FROM task WHERE state = 'done';");
    return rows.map(asId);
  }

  async judgeInput(taskId: TaskId): Promise<JudgeInput> {
    const task = id('task', taskId);
    const [rows, submits, blocks] = await this.db.query<[
      Array<{ title: string; context: string; resume_role?: string; project_overlay?: RecordId; goal_project?: { id: RecordId; name: string; release?: string; red_lines?: string[] } }>,
      Array<{ evidence?: string }>, Array<{ evidence?: string }>,
    ]>(`SELECT title, context, resume_role, project.id AS project_overlay, goal.project.* AS goal_project FROM $task;
      SELECT evidence, at FROM audit WHERE task = $task AND action = 'submit' ORDER BY at DESC LIMIT 1;
      SELECT evidence, at FROM audit WHERE task = $task AND action = 'block' ORDER BY at DESC LIMIT 1;`, { task });
    const row = rows[0];
    if (!row) throw new CompanyError('not_found', 'task not found');
    // Task-level override wins: Jev judges the release against the project the task now routes to.
    const overlayId = row.project_overlay ? asId(row.project_overlay) : undefined;
    let project: JudgeInput['project'];
    if (overlayId) {
      const [prows] = await this.db.query<[Array<{ name: string; release?: string; red_lines?: string[] }>]>(
        'SELECT name, release, red_lines FROM $project;', { project: id('project', overlayId) });
      project = { id: overlayId, name: prows[0]?.name ?? overlayId, release: prows[0]?.release, redLines: prows[0]?.red_lines ?? [] };
    } else if (row.goal_project?.id) {
      project = { id: asId(row.goal_project.id), name: row.goal_project.name, release: row.goal_project.release, redLines: row.goal_project.red_lines ?? [] };
    }
    return { title: row.title, context: row.context.slice(0, 8000), submission: submits[0]?.evidence?.slice(0, 12000),
      question: blocks[0]?.evidence?.slice(0, 8000), blockedBy: row.resume_role, project };
  }

  /** Records that Jev looked at this task version without deciding; the advice lands in history for the human-like reviewer. */
  async jevAdvice(taskId: TaskId, field: 'jev_release_version' | 'jev_route_version', version: number, advice: string): Promise<void> {
    await this.db.query(`UPDATE $task SET ${field} = $version WHERE version = $version;
      CREATE audit CONTENT { task: $task, actor: 'jev', action: 'jev_advice', evidence: $advice, version: $version, at: time::now() };`,
    { task: id('task', taskId), version, advice });
  }

  /** Jev approves a release request nobody is reviewing yet: done + dependency unlock, audited as jev. */
  async jevAccept(taskId: TaskId, version: number, evidence: string): Promise<boolean> {
    // SYS02 AC03/AC05: Jev is a machine actor. It may approve a release only when the unified evaluator passes and no
    // required human criterion exists; an unmet gate leaves the release to product and records exactly why.
    const taskRow = await this.db.select<AcceptanceTaskRow>(id('task', taskId));
    if (!taskRow) return false;
    const gate = await loadAcceptanceGate(this.db);
    const verdict = evaluateAcceptance({
      subject: acceptanceSubject(taskRow), evidence: await loadAcceptanceEvidence(this.db, taskId),
      phase: 'release', actor: { employeeId: 'jev', role: 'product', human: false }, gate,
    });
    if (!verdict.ok) {
      await this.db.query(`CREATE audit CONTENT { task: $task, actor: 'jev', action: 'jev_acceptance_blocked', evidence: $evidence, at: time::now() };`,
        { task: id('task', taskId), evidence: JSON.stringify({ version, unmet: verdict.unmet }).slice(0, 30000) });
      return false;
    }
    const responses = await this.db.query<unknown[]>(`BEGIN;
      LET $t = SELECT * FROM ONLY $task;
      IF $t = NONE OR $t.state != 'review' OR $t.current_employee != NONE OR $t.version != $version OR $t.company_upgrade != NONE { THROW 'task changed' };
      LET $next = UPDATE ONLY $task SET state = 'done', accepted_by = 'jev', jev_release_version = $version,
        delivery_id = NONE, lease_expires_at = NONE, version = $t.version + 1 RETURN AFTER;
      CREATE audit CONTENT { task: $task, actor: $actor, action: 'accept', evidence: $evidence, version: $next.version, at: time::now() };
      LET $sequence = UPDATE ONLY company_meta:outbox_counter SET value += 1 RETURN AFTER;
      CREATE outbox CONTENT { task: $task, kind: 'accepted', sequence: $sequence.value, payload: { state: 'done', by: 'jev' }, at: time::now() };
      ${UNLOCK_SQL}
      COMMIT;`, { task: id('task', taskId), version, evidence, actor: 'jev' }).responses();
    return responses.every(r => r.success);
  }

  /** Moves an owner question that does not need the owner to the gm queue (once per task). */
  async rerouteToGm(taskId: TaskId, version: number, evidence: string): Promise<boolean> {
    const responses = await this.db.query<unknown[]>(`BEGIN;
      LET $t = SELECT * FROM ONLY $task;
      IF $t = NONE OR $t.state != 'blocked' OR $t.blocked_to != 'owner' OR $t.version != $version OR $t.company_upgrade != NONE { THROW 'task changed' };
      LET $next = UPDATE ONLY $task SET blocked_to = 'gm', owner_rerouted = true, jev_route_version = $version,
        version = $t.version + 1 RETURN AFTER;
      CREATE audit CONTENT { task: $task, actor: 'jev', action: 'jev_reroute', evidence: $evidence, version: $next.version, at: time::now() };
      LET $sequence = UPDATE ONLY company_meta:outbox_counter SET value += 1 RETURN AFTER;
      CREATE outbox CONTENT { task: $task, kind: 'rerouted', sequence: $sequence.value, payload: { to: 'gm' }, at: time::now() };
      COMMIT;`, { task: id('task', taskId), version, evidence }).responses();
    return responses.every(r => r.success);
  }

  async extendLease(taskId: TaskId, employeeId: string, seconds: number): Promise<boolean> {
    const [rows] = await this.db.query<[unknown[]]>(`UPDATE $task SET lease_expires_at = time::unix(time::now()) + $seconds
      WHERE current_employee = $employee AND delivery_id != NONE RETURN AFTER;`,
      { task: id('task', taskId), employee: employeeId, seconds });
    return Boolean(rows?.length);
  }

  /**
   * Revokes the holder's lease. Execution returns to ready (review stays review) with a handover flag.
   * The cleared delivery ID invalidates every later write from the old session; the next claim bumps the fence.
   */
  async revokeLease(taskId: TaskId, employeeId: string, reason: string, handover: string, actor = 'dispatcher'): Promise<boolean> {
    const evidence = `原因：${reason}\n\n${handover}`.slice(0, 30000);
    const responses = await this.db.query<unknown[]>(`BEGIN;
      LET $t = SELECT * FROM ONLY $task;
      IF $t = NONE OR $t.current_employee != $employee { THROW 'lease changed' };
      LET $next = UPDATE ONLY $task SET
        state = IF $t.state = 'doing' THEN 'ready' ELSE $t.state END,
        current_employee = NONE, delivery_id = NONE, lease_expires_at = NONE,
        // FV06：收回即待命阶段结束，旧标记不得管辖下一位持有人的租约。
        standby_until = NONE,
        handover = true, previous_employee = $employee, version = $t.version + 1 RETURN AFTER;
      UPDATE employee SET active_task = NONE WHERE active_task = $task;
      CREATE audit CONTENT { task: $task, actor: $actor, action: 'revoked', evidence: $evidence, version: $next.version, at: time::now() };
      LET $sequence = UPDATE ONLY company_meta:outbox_counter SET value += 1 RETURN AFTER;
      CREATE outbox CONTENT { task: $task, kind: 'revoked', sequence: $sequence.value, payload: { employee: $employee, state: $next.state }, at: time::now() };
      COMMIT;`, { task: id('task', taskId), employee: employeeId, evidence, actor }).responses();
    return responses.every(r => r.success);
  }

  /**
   * 终止在途执行：撤掉当前持有人的租约（doing→ready），任务本身保留等下一位员工。
   * 老板侧「临时终止某个任务」的语义就是撤租约而不是作废——作废用 OwnerDesk.retire。
   */
  async revokeTaskLease(taskId: TaskId, reason: string, handover: string, actor: string): Promise<{ ok: boolean; employee?: string }> {
    const task = await this.db.select<{ current_employee?: string }>(id('task', taskId));
    if (!task?.current_employee) return { ok: false };
    const ok = await this.revokeLease(taskId, task.current_employee, reason, handover, actor);
    return { ok, employee: ok ? task.current_employee : undefined };
  }

  /**
   * FV06 P0：standby 待命超时收回。与 revokeLease 的 doing→ready 不同，这里任务回经理关口而不是
   * ready 池：blocked + blocked_to='gm'、resume_state='doing'（经理可换人重新 standby，普通 resume
   * 则按既有守卫恢复 ready 派工）、租约与 delivery 清空、standby_until 清除。旧持有人的一切写入随
   * delivery 清空失效；audit 单独记 standby_timeout，便于与普通收回区分。
   */
  async standbyTimeout(taskId: TaskId, employeeId: string, reason: string, handover: string, actor = 'dispatcher'): Promise<boolean> {
    const evidence = `原因：${reason}\n\n${handover}`.slice(0, 30000);
    const responses = await this.db.query<unknown[]>(`BEGIN;
      LET $t = SELECT * FROM ONLY $task;
      // state='doing' 门（FV06 复验）：待命超时只对「仍有待命标记的直派租约」成立。submit 后的复核相位、
      // 收回后的 ready、标记已清除的普通租约，都不得被写成 blocked + resume_state=doing。
      IF $t = NONE OR $t.current_employee != $employee OR $t.state != 'doing' OR $t.standby_until = NONE { THROW 'lease changed' };
      LET $next = UPDATE ONLY $task SET
        state = 'blocked', blocked_to = 'gm', resume_state = 'doing',
        current_employee = NONE, delivery_id = NONE, lease_expires_at = NONE, standby_until = NONE,
        handover = true, previous_employee = $employee, version = $t.version + 1 RETURN AFTER;
      UPDATE employee SET active_task = NONE WHERE active_task = $task;
      CREATE audit CONTENT { task: $task, actor: $actor, action: 'standby_timeout', evidence: $evidence, version: $next.version, at: time::now() };
      LET $sequence = UPDATE ONLY company_meta:outbox_counter SET value += 1 RETURN AFTER;
      CREATE outbox CONTENT { task: $task, kind: 'revoked', sequence: $sequence.value, payload: { employee: $employee, state: 'blocked', reason: 'standby_timeout' }, at: time::now() };
      COMMIT;`, { task: id('task', taskId), employee: employeeId, evidence, actor }).responses();
    return responses.every(r => r.success);
  }

  // ---- dispatch bookkeeping ----
  private dispatchId(taskId: string, version: number, purpose: string) {
    return id('dispatch', HASH(`${taskId}\0${version}\0${purpose}`).slice(0, 24));
  }
  async lastDispatch(taskId: string, version: number, purpose: string): Promise<{ employee: string; at: number } | undefined> {
    const row = await this.db.select<{ employee: string; at: number }>(this.dispatchId(taskId, version, purpose));
    return row ?? undefined;
  }
  /** Batch lookup of dispatch rows keyed "taskId:version" — one query instead of a select per blocked task. */
  async lastDispatches(taskIds: string[], purpose: string): Promise<Map<string, { employee: string; at: number }>> {
    const out = new Map<string, { employee: string; at: number }>();
    if (!taskIds.length) return out;
    const [rows] = await this.db.query<[Array<{ task: string; version: number; employee: string; at: number }>]>(
      'SELECT task, version, employee, at FROM dispatch WHERE task IN $ids AND purpose = $purpose;',
      { ids: taskIds, purpose });
    for (const r of rows ?? []) out.set(`${r.task}:${r.version}`, { employee: r.employee, at: r.at });
    return out;
  }
  async recordDispatch(taskId: string, version: number, purpose: string, employee: string): Promise<void> {
    await this.db.query('UPSERT $d CONTENT { task: $task, version: $version, purpose: $purpose, employee: $employee, at: time::unix(time::now()) };',
      { d: this.dispatchId(taskId, version, purpose), task: taskId, version, purpose, employee });
  }

  /** Durably records one manager todo. The deterministic id (task+phase+episode+reason) makes repeated ticks idempotent. */
  async openManagerAction(input: ManagerActionInput): Promise<boolean> {
    const key = managerActionKey(input.taskId, input.phase, input.episode, input.reason);
    const record = id('dispatch', HASH(key).slice(0, 24));
    const existing = await this.db.select<{ status?: string }>(record);
    if (existing?.status === 'open') return false;
    const audit = id('audit', randomUUID());
    const evidence = JSON.stringify({ ...input, key });
    await this.db.query(`BEGIN;
      UPSERT $d CONTENT { key: $key, task: $task, version: $version, purpose: 'gm-manager-action', employee: '',
        phase: $phase, episode: $episode, reason: $reason, action: $action, repo: $repo, implementer: $implementer,
        status: 'open', created_at: time::now() };
      CREATE $audit CONTENT { task: $task_ref, actor: 'system:dispatcher', action: 'manager_action', evidence: $evidence, at: time::now() };
      COMMIT;`, {
      d: record, key, task: input.taskId, task_ref: id('task', input.taskId), version: input.version,
      phase: input.phase, episode: input.episode, reason: input.reason, action: input.action,
      repo: input.repo, implementer: input.implementer ?? null, audit, evidence,
    });
    return true;
  }

  /** Open manager todos, restored across dispatcher restarts from the dispatch bookkeeping table. */
  async openManagerActions(): Promise<ManagerActionRow[]> {
    type Row = { id: RecordId; key?: string; task?: string; version?: number; phase?: string; episode?: number; reason?: string;
      action?: string; repo?: string; implementer?: string; status?: string; created_at?: unknown };
    const [rows] = await this.db.query<[Row[]]>(`SELECT * FROM dispatch WHERE purpose = 'gm-manager-action' AND status = 'open' ORDER BY created_at;`);
    return (rows ?? []).map(row => ({
      key: row.key ?? String(row.id).replace(/^dispatch:/, ''), taskId: String(row.task ?? ''), version: row.version ?? 0,
      phase: row.phase === 'review' ? 'review' : 'execute', episode: row.episode ?? 0, reason: row.reason ?? '',
      action: 'implementer_takeover' as const, repo: row.repo ?? '', implementer: row.implementer ?? undefined,
      status: 'open' as const, createdAt: row.created_at === undefined ? undefined : String(row.created_at),
    }));
  }

  /** Closes one manager todo without deleting its dispatch row or the open/close audit history. */
  async closeManagerAction(action: ManagerActionRow, resolution: string): Promise<void> {
    const record = id('dispatch', HASH(action.key).slice(0, 24));
    const audit = id('audit', randomUUID());
    const evidence = JSON.stringify({ task: action.taskId, phase: action.phase, episode: action.episode,
      reason: action.reason, action: action.action, resolution });
    await this.db.query(`BEGIN;
      LET $row = SELECT * FROM ONLY $d;
      IF $row.status = 'open' {
        UPDATE ONLY $d SET status = 'closed', closed_at = time::now(), resolution = $resolution;
        CREATE $audit CONTENT { task: $task_ref, actor: 'system:dispatcher', action: 'manager_action_closed', evidence: $evidence, at: time::now() };
      };
      COMMIT;`, { d: record, task_ref: id('task', action.taskId), resolution, audit, evidence });
  }

  // ---- SYS03 disposition ledger (dispatcher-facing, read-only + the two resolution writes) ----

  /**
   * SYS03 AC01: the disposition state a wake loop is about to act on, read in ONE query (exact ids, no per-task round
   * trip — the dispatcher runs on a single ~50KB/s channel). Read-only.
   *
   * `byTask` is the fallback for a manager gate whose persisted episode start the dispatcher itself clears every pass:
   * a blocked-to-gm task is not a work-queue item, so `endStaleEpisodes` drops its `dispatch_blocked_since`. Without
   * this fallback the same reminder would present a different episode every tick. It is the newest claim of the task,
   * and the wake loop may only use it for an IN-FLIGHT claim: a decided row belongs to an episode that is already over,
   * so it must never suppress a wake for the episode the task has formed since (see the SYS03 guard in dispatcher.ts).
   */
  async dispositionFacts(input: { episodes: readonly string[]; tasks: readonly string[] }): Promise<{
    byEpisode: Map<string, DispositionEpisodeFacts>; byTask: Map<string, DispositionEpisodeFacts> }> {
    const byEpisode = new Map<string, DispositionEpisodeFacts>();
    const byTask = new Map<string, DispositionEpisodeFacts>();
    const episodes = [...new Set(input.episodes.filter(episode => episode.length > 0))];
    const tasks = [...new Set(input.tasks.filter(taskId => taskId.length > 0))];
    if (!episodes.length && !tasks.length) return { byEpisode, byTask };
    type Row = { episode?: string; task?: unknown; phase?: string; episode_since?: number; status?: string; holder?: string;
      lease_expires_at?: number; decision_action?: string; decision_business_key?: string; decision_actor?: string;
      decision_at?: unknown; decision_task_version?: number; decision_result?: Record<string, unknown> };
    const [rows] = await this.db.query<[Row[]]>('SELECT * FROM disposition_claim WHERE episode IN $episodes OR task IN $tasks;',
      { episodes, tasks: tasks.map(taskId => id('task', taskId)) });
    for (const row of rows ?? []) {
      const facts = this.dispositionFactsOf(row);
      if (!facts) continue;
      if (episodes.includes(facts.episode)) byEpisode.set(facts.episode, facts);
      const known = byTask.get(facts.taskId);
      if (!known || known.sinceMs < facts.sinceMs) byTask.set(facts.taskId, facts);
    }
    return { byEpisode, byTask };
  }

  /**
   * SYS04 AC04: the fault episodes of the given tasks, newest first per task.
   *
   * The dispatcher reads this before it wakes a manager, so a cause that is already on the manager's desk (or
   * whose budget is spent) does not produce a second wake. The read is a single query: an unreadable ledger is
   * reported as undefined, and the caller then fails closed for the pass.
   */
  async faultEpisodes(input: { tasks: readonly string[] }): Promise<{ byTask: Map<string, FaultEpisodeFacts[]>; blockedAt?: Map<string, number> } | undefined> {
    const byTask = new Map<string, FaultEpisodeFacts[]>();
    const tasks = [...new Set(input.tasks.filter(taskId => taskId.length > 0))];
    if (!tasks.length) return { byTask };
    type Row = { episode?: string; fingerprint?: string; incident?: string; task?: unknown; phase?: string;
      state?: string; evidence_revision?: number; notified?: boolean; updated_at?: unknown; notified_at?: unknown; notified_stage_at?: unknown };
    const [rows] = await this.db.query<[Row[]]>(
      'SELECT * FROM fault_episode WHERE task IN $tasks ORDER BY updated_at DESC;',
      { tasks: tasks.map(taskId => id('task', taskId)) });
    for (const row of rows ?? []) {
      const episode = row.episode ?? '';
      if (!episode) continue;
      const taskId = asId(row.task);
      const facts: FaultEpisodeFacts = {
        episode,
        fingerprint: row.fingerprint ?? '',
        incident: row.incident ?? '',
        taskId,
        phase: row.phase ?? '',
        state: (row.state === 'converged' || row.state === 'exhausted' || row.state === 'stopped' || row.state === 'resolved'
          ? row.state : 'opened'),
        evidenceRevision: row.evidence_revision ?? 0,
        updatedAt: row.updated_at ? String(row.updated_at) : undefined,
        notifiedAt: row.notified_at ? String(row.notified_at) : undefined,
        notifiedStageAt: row.notified_stage_at ? String(row.notified_stage_at) : undefined,
        notified: row.notified ?? false,
      };
      const list = byTask.get(taskId);
      if (list) list.push(facts); else byTask.set(taskId, [facts]);
    }
    const [boundaries] = await this.db.query<[Array<{ task: unknown; at: unknown }>]>(
      `SELECT task, at FROM audit WHERE task IN $tasks AND action IN ['resume', 'deferred', 'dependency_unlocked', 'manager_recovery'] ORDER BY at DESC;`,
      { tasks: tasks.map(taskId => id('task', taskId)) });
    const blockedAt = new Map<string, number>();
    for (const b of boundaries ?? []) if (!blockedAt.has(asId(b.task))) blockedAt.set(asId(b.task), Date.parse(String(b.at)));
    return { byTask, blockedAt };
  }

  /**
   * SYS04 AC04: record that the manager was told about one fault episode.
   *
   * One episode, one notice: the flag is set when the wake goes out, so ten identical reports of the same cause
   * leave the manager with one episode to act on. A second call is a no-op.
   */
  async markFaultEpisodeNotified(episode: string, stageStartedAt?: number): Promise<boolean> {
    return new FaultStore(this.db).markNotified(episode, stageStartedAt);
  }

  private dispositionFactsOf(row: { episode?: string; task?: unknown; phase?: string; episode_since?: number; status?: string;
    holder?: string; lease_expires_at?: number; decision_action?: string; decision_business_key?: string; decision_actor?: string;
    decision_at?: unknown; decision_task_version?: number; decision_result?: Record<string, unknown> }): DispositionEpisodeFacts | undefined {
    const episode = row.episode ?? '';
    if (!episode) return undefined;
    const result = row.decision_result ?? undefined;
    return {
      episode,
      taskId: asId(row.task),
      phase: row.phase === 'review' ? 'review' : 'execute',
      sinceMs: row.episode_since ?? 0,
      status: row.status === 'decided' ? 'decided' : 'claimed',
      holder: row.holder || undefined,
      leaseExpiresAt: typeof row.lease_expires_at === 'number' ? row.lease_expires_at : undefined,
      decision: row.status === 'decided'
        ? { action: row.decision_action ?? '', businessKey: row.decision_business_key || undefined,
          actor: row.decision_actor || undefined, at: row.decision_at === undefined ? undefined : String(row.decision_at),
          taskVersion: row.decision_task_version, result, repairTaskId: (result?.repairTaskId as string | undefined) ?? undefined }
        : undefined,
    };
  }

  /** The episode key the wake loop and the ledger agree on: task + phase + episode start in milliseconds. */
  episodeKey(taskId: string, phase: DispositionPhase, episodeMs: number): string {
    return dispositionEpisodeKey(taskId, phase, episodeMs);
  }

  /**
   * SYS03 AC01/AC04: a decided episode is resolved, so its leftover manager todo and any in-flight manager wake are
   * closed with the decision as the resolution. Called by the wake loop before it would start another session for that
   * episode, so a handled episode never produces a second GM session — not in this pass, and not after a restart,
   * because the closed rows are the same durable bookkeeping the next dispatcher reads.
   */
  async resolveDecidedEpisode(input: { taskId: string; phase: DispositionPhase; episodeMs: number; resolution: string }): Promise<number> {
    const todos = (await this.openManagerActions())
      .filter(row => row.taskId === input.taskId && row.phase === input.phase && row.episode === input.episodeMs);
    let closed = 0;
    for (const todo of todos) {
      await this.closeManagerAction(todo, input.resolution);
      closed++;
    }
    const wakes = await this.finishManagerWakesForTask(input.taskId, input.resolution);
    return closed + wakes;
  }

  /** SYS03 AC04: holder notices still waiting for delivery, oldest first (resend after reconnect or plugin restart). */
  async pendingHolderNotices(limit = 25): Promise<HolderNoticeView[]> {
    return this.dispositions.pendingNotices(limit);
  }

  /** SYS03 AC04: a delivery receipt. A failed attempt is recorded on the notice and keeps it pending — never lost. */
  async markHolderNotices(ids: string[], outcome: { agent?: string; error?: string }): Promise<number> {
    return this.dispositions.markNotices(ids, outcome);
  }

  // ---- manager wake ownership (MR02) ----
  // The manager action row is the todo. A separate dispatch row is the in-flight attempt, keyed by
  // task+phase+episode, so a reason/version change never starts a second wake while the first GM is
  // still processing. Every transition is CAS'd by token+attempt; old callbacks cannot release a new claim.
  private managerWakeId(taskId: string, phase: string, episode: number) {
    return id('dispatch', HASH(`gm-manager-wake\0${taskId}\0${phase}\0${episode}`).slice(0, 24));
  }

  private wakeRow(row: WakeDbRow): ManagerWakeRow {
    const phase = row.phase === 'review' ? 'review' : 'execute';
    const episode = row.episode ?? 0;
    return {
      key: row.key ?? managerWakeKey(String(row.task ?? ''), phase, episode),
      taskId: String(row.task ?? ''), phase, episode,
      reason: row.reason ?? '', version: row.version ?? 0, repo: row.repo ?? '',
      purpose: 'gm-manager-wake', state: row.state ?? 'finished', attempt: row.attempt ?? 0, token: row.token ?? '',
      employee: row.employee ?? undefined, agent: row.agent ?? undefined,
      startedAt: row.started_at ?? undefined, externalStartedAt: row.external_started_at ?? undefined,
      lastCheckedAt: row.last_checked_at ?? undefined, lastStatus: row.last_status ?? undefined,
      resolution: row.resolution ?? undefined, updatedAt: row.updated_at ?? undefined,
    };
  }

  /** The CAS token for a row read from the database. */
  wakeClaim(row: ManagerWakeRow): ManagerWakeClaim {
    return { key: row.key, token: row.token, attempt: row.attempt, input: {
      taskId: row.taskId, phase: row.phase, episode: row.episode, reason: row.reason, version: row.version, repo: row.repo,
    } };
  }

  /**
   * Acquire the only in-flight permission for task+phase+episode. Missing rows are created; a finished
   * row starts the next attempt; pending/running/unknown rows refuse. The write is a single CAS
   * transaction, so concurrent dispatchers and restarts can only produce one winner.
   */
  async acquireManagerWake(input: ManagerWakeInput, token: string = randomUUID()): Promise<ManagerWakeClaim | undefined> {
    const key = managerWakeKey(input.taskId, input.phase, input.episode);
    const d = this.managerWakeId(input.taskId, input.phase, input.episode);
    const evidence = JSON.stringify({ ...input, key, token, attempt: 1 });
    try {
      const created = await this.runTxResult<WakeDbRow>(`BEGIN;
        LET $created = CREATE ONLY $d CONTENT { key: $key, task: $task, phase: $phase, episode: $episode,
          purpose: 'gm-manager-wake', state: 'pending', attempt: 1, token: $wake_token, version: $version,
          reason: $reason, repo: $repo, employee: NONE, agent: NONE,
          started_at: time::unix(time::now()), external_started_at: NONE, last_checked_at: NONE,
          last_status: NONE, resolution: NONE, updated_at: time::unix(time::now()), at: time::unix(time::now()) };
        CREATE $audit CONTENT { task: $task_ref, actor: 'system:dispatcher', action: 'manager_wake_acquired',
          evidence: $evidence, at: time::now() };
        RETURN $created;
        COMMIT;`, { d, key, task: input.taskId, task_ref: id('task', input.taskId), phase: input.phase,
        episode: input.episode, wake_token: token, version: input.version, reason: input.reason, repo: input.repo,
        audit: id('audit', randomUUID()), evidence });
      if (created) return { key, token, attempt: 1, input };
    } catch (error) {
      // A concurrent creator won the unique record id; read its row below.
      if (!/already exists|duplicate/i.test(String((error as Error).message))) throw error;
    }
    const row = await this.db.select<WakeDbRow>(d);
    if (!row || (row.state ?? 'finished') !== 'finished') return undefined;
    const attempt = (row.attempt ?? 0) + 1;
    const updated = await this.runTxResult<WakeDbRow>(`BEGIN;
      LET $updated = UPDATE ONLY $d SET state = 'pending', attempt = $attempt, token = $wake_token,
        version = $version, reason = $reason, repo = $repo, employee = NONE, agent = NONE,
        started_at = time::unix(time::now()), external_started_at = NONE, last_checked_at = NONE,
        last_status = NONE, resolution = NONE, updated_at = time::unix(time::now()), at = time::unix(time::now())
        WHERE state = 'finished' RETURN AFTER;
      IF $updated != NONE {
        CREATE $audit CONTENT { task: $task_ref, actor: 'system:dispatcher', action: 'manager_wake_acquired',
          evidence: $evidence, at: time::now() };
      };
      RETURN $updated;
      COMMIT;`, { d, key, task: input.taskId, task_ref: id('task', input.taskId), phase: input.phase,
      episode: input.episode, wake_token: token, attempt, version: input.version, reason: input.reason, repo: input.repo,
      audit: id('audit', randomUUID()), evidence: JSON.stringify({ ...input, key, token, attempt }) });
    if (!updated) return undefined;
    return { key, token, attempt, input };
  }

  /** Mark the attempt as externally started / running and bind the GM employee and (when known) Paseo agent. */
  async markManagerWakeRunning(claim: ManagerWakeClaim, employee: string, agent?: string): Promise<boolean> {
    const d = this.managerWakeId(claim.input.taskId, claim.input.phase, claim.input.episode);
    const updated = await this.runTxResult<WakeDbRow>(`BEGIN;
      LET $worker = SELECT * FROM ONLY $employee_record;
      LET $old = SELECT * FROM ONLY $d;
      LET $updated = UPDATE ONLY $d SET state = 'running', employee = $employee, agent = $agent,
        external_started_at = IF external_started_at = NONE THEN time::unix(time::now()) ELSE external_started_at END,
        last_checked_at = time::unix(time::now()), updated_at = time::unix(time::now()), at = time::unix(time::now())
        WHERE ($worker.runtime_sleep_until ?? 0) <= time::unix(time::now()) AND token = $wake_token AND attempt = $attempt AND state IN ['pending', 'running', 'unknown'] RETURN AFTER;
      IF $updated != NONE {
        LET $seat = SELECT * FROM ONLY $employee_record;
        IF $seat != NONE AND ($seat.revoked = true OR $seat.retired = true) { THROW 'manager employee retired' };
        IF $seat != NONE { UPDATE $employee_record SET idle_since = NONE; };
      };
      IF $updated != NONE AND ($old.state ?? '') != 'running' {
        CREATE $audit CONTENT { task: $task_ref, actor: 'system:dispatcher', action: 'manager_wake_started',
          evidence: $evidence, at: time::now() };
      };
      RETURN $updated;
      COMMIT;`, { d, task_ref: id('task', claim.input.taskId), wake_token: claim.token, attempt: claim.attempt,
      employee, employee_record: id('employee', employee), agent: agent ?? null, audit: id('audit', randomUUID()),
      evidence: JSON.stringify({ key: claim.key, token: claim.token, attempt: claim.attempt, employee, agent }) });
    return Boolean(updated);
  }

  /** CAS the attempt to finished (retryable) or unknown (fail closed, never re-woken as if idle). */
  async finishManagerWake(claim: ManagerWakeClaim, state: 'finished' | 'unknown', resolution: string, lastStatus?: string): Promise<boolean> {
    const d = this.managerWakeId(claim.input.taskId, claim.input.phase, claim.input.episode);
    const action = state === 'unknown' ? 'manager_wake_unknown' : 'manager_wake_finished';
    const repeatGuard = state === 'unknown' ? " AND (state != 'unknown' OR last_status != $last_status)" : '';
    const updated = await this.runTxResult<WakeDbRow>(`BEGIN;
      LET $updated = UPDATE ONLY $d SET state = $state, resolution = $resolution, last_status = $last_status,
        last_checked_at = time::unix(time::now()), updated_at = time::unix(time::now()), at = time::unix(time::now())
        WHERE token = $wake_token AND attempt = $attempt AND state IN ['pending', 'running', 'unknown']${repeatGuard} RETURN AFTER;
      IF $updated != NONE {
        CREATE $audit CONTENT { task: $task_ref, actor: 'system:dispatcher', action: $action,
          evidence: $evidence, at: time::now() };
      };
      RETURN $updated;
      COMMIT;`, { d, task_ref: id('task', claim.input.taskId), wake_token: claim.token, attempt: claim.attempt,
      state, resolution, last_status: lastStatus ?? null, action, audit: id('audit', randomUUID()),
      evidence: JSON.stringify({ key: claim.key, token: claim.token, attempt: claim.attempt, state, resolution, lastStatus }) });
    return Boolean(updated);
  }

  /** Active attempts restored after a restart. */
  async openManagerWakes(): Promise<ManagerWakeRow[]> {
    const [rows] = await this.db.query<[WakeDbRow[]]>(
      `SELECT * FROM dispatch WHERE purpose = 'gm-manager-wake' AND state IN ['pending', 'running', 'unknown'] ORDER BY started_at;`);
    return (rows ?? []).map(row => this.wakeRow(row));
  }

  /** Close all active attempts for a task whose work left the execute queue. Reason changes do not call this. */
  async finishManagerWakesForTask(taskId: string, resolution: string): Promise<number> {
    const [rows] = await this.db.query<[WakeDbRow[]]>(
      `SELECT * FROM dispatch WHERE purpose = 'gm-manager-wake' AND task = $task AND state IN ['pending', 'running', 'unknown'];`,
      { task: taskId });
    let closed = 0;
    for (const raw of rows ?? []) {
      const row = this.wakeRow(raw);
      if (await this.finishManagerWake(this.wakeClaim(row), 'finished', resolution, row.lastStatus)) closed++;
    }
    return closed;
  }

  private async runTxResult<T>(query: string, vars: Record<string, unknown>): Promise<T | undefined> {
    const responses = await this.db.query<unknown[]>(query, vars).responses();
    const failures = responses.filter(response => !response.success);
    if (failures.length) {
      const cause = failures.map(response => response.error.message).find(message =>
        !message.includes('not executed due to') && !message.startsWith('Cannot COMMIT')) ?? 'manager wake transaction failed';
      throw new Error(cause);
    }
    return responses.map(response => response.success ? response.result : undefined).at(-2) as T | undefined;
  }

  async serverNow(): Promise<number> { return this.now(); }
  newKey(): string { return randomUUID(); }
}

interface WakeDbRow {
  id?: RecordId; key?: string; task?: string; phase?: string; episode?: number; purpose?: string;
  state?: ManagerWakeState; attempt?: number; token?: string; version?: number; reason?: string; repo?: string;
  employee?: string; agent?: string; started_at?: number; external_started_at?: number; last_checked_at?: number;
  last_status?: string; resolution?: string; updated_at?: number; at?: number;
}
