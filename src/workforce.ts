import { parseWorkHours, type WorkHours } from './work-hours.ts';
import { PROVIDER_FAILURE_WINDOW_SECONDS, type ProviderFailure } from './dispatcher/provider-failover.ts';
import type { SchedulingFact, SchedulingDecision } from './dispatcher/scheduling.ts';
import { dispatchFinalizationSql } from './dispatch-finalization.ts';
import { outboundRevisionSql } from './outbound-revision.ts';
import { FaultStore } from './fault-store.ts';
import { laneOf } from './lane-notes.ts';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { RecordId } from 'surrealdb';
import type { CompanyDatabase } from './database.ts';
import type { Principal, RetirementKind, Role, TaskId, TaskKind } from './contracts.ts';
import { ownerActionKey } from './dispatcher/dispatch-blocked.ts';
import { asId, CompanyError, HASH, id, ROLES, view, type TaskRow } from './core.ts';
import { LocalEnrollmentAdmin, revokedCredentialDigest } from './enrollment.ts';
import { gateCredentialChange } from './retirement.ts';
import { acceptanceSubject, evaluateAcceptance, loadAcceptanceEvidence, loadAcceptanceGate, type AcceptanceTaskRow } from './acceptance.ts';
/**
 * Root-level workforce and lease supervision for the local dispatcher and admin CLI.
 * Never hand this object to the employee-facing sidecar tools.
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
  /** 派工权重：同岗位候选中按 weight 加权随机选取；0 = 永不主动选中。 */
  weight: number;
  /**
   * false = this def ignores quota-based dispatch gating: it is dispatched even when the
   * subscription's remaining allowance is 0. Absent/true = limited (the default).
   */
  quotaLimited?: boolean;
  errorStreak: number;
  /** 停用原因（老板停用或连续会话异常自动停用）；只在停用时有。 */
  disabledReason?: string;
  /** 工作时间（见 work-hours.ts）；没有即全天可派。 */
  workHours?: WorkHours;
}

export interface ChainWorkspace { cwd: string; id: string }
export interface ChainRoot { id: string; title: string; workspaces: ChainWorkspace[] }

export interface EmployeeInst {
  id: string;
  role: Role;
  def?: string;
  provider?: string;
  model?: string;
  thinking?: string;
  paseoAgentId?: string;
  activeTask?: string;
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
  /** The Paseo container this session lives in; it stays open while the session is on the roster. */
  paseoWorkspace?: string;
  /** Registered identity principal (schema 029), when one is registered: the only cross-employee identity link (SYS-DISP Q3). */
  principal?: string;
  /** How many times the dispatcher woke this session; used to rotate it before the context grows too large. */
  wakeCount?: number;
  /** The lane, task and phase of this session's latest claim: what decides whether it may continue or has finished. */
  lane?: string;
  lastTask?: string;
  lastPhase?: 'execute' | 'review';
  /**
   * The one task this session was opened for (schema 060). A session serves only that task, so its model traffic
   * is attributed to it: a session for another task is never reused, and a session without one is never reused.
   */
  sessionTask?: string;
}

export interface SessionTaskFacts { states: Map<string, string> }

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
  /** 优先订阅：该 CLI 还有合格候选时其他供应商保留等待（factory_wait）；'' = 不设优先，全部按权重竞争。 */
  preferredProvider: string;
  pollSeconds: number;
  stallMinutes: number;
  redispatchMinutes: number;
  extendWithinSeconds: number;
  handoverChars: number;
  /** 配置了 Jev 时，用 noul 决定系统提醒是否弹桌面通知（否则只进收件箱）。 */
  jevNotifyTriage: boolean;
  /** 配置了 Jev 时，由 Jev 做目标分级、上线决定和老板升级路由；拿不准交回老板/运营。 */
  /** 上线申请：Jev「可以上线」概率达到该值且「触碰红线」概率不高于 1 - 该值时自动批准。 */
  /** 升级给老板的问题：Jev「必须老板决定」概率低于该值时改派给老板。 */
  /** 派工选择候选员工时采信 Jev 答案的最低置信度；低于则回退权重随机。 */
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
  /** oneshot：新任务开新会话，任务结束回收会话；reuse：复用空闲会话。切回 reuse 即回滚。 */
  sessionPolicy: 'reuse' | 'oneshot';
  /** 连续观测为空闲的会话在此分钟数后回收；0 = 关闭。 */
  sessionIdleMinutes: number;
  /** 每日简报的本地发送时刻（0-23 点，之后第一个周期发送）；-1 = 关闭。 */
  ownerBriefHour: number;
  /** 同一任务在员工与老板之间 block→resume 往返达到该次数就不再自动循环，升级给老板；0 = 关闭。 */
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
}

/** 供应商编号（CLI / 云端通道）的合法形状：preferred_provider 与 employee_def.provider 共用。 */
export const PROVIDER_ID = /^[a-z0-9][a-z0-9-]{1,40}$/;

/** preferred_provider 的合法取值：供应商编号，或 ""（不设优先）。admin config 与 owner 命令共用。 */
export function preferredProviderValue(raw: unknown): string {
  if (raw !== '' && (typeof raw !== 'string' || !PROVIDER_ID.test(raw)))
    throw new CompanyError('invalid', 'preferred_provider 必须是供应商编号（小写字母数字连字符）或 ""（不设优先）');
  return raw as string;
}

export const DEFAULT_CONFIG: CompanyConfig = {
  paused: false, maxRunning: 4, providerMax: { codex: 3, grok: 2, devin: 2 }, preferredProvider: 'factory-droid',
  pollSeconds: 20, stallMinutes: 90, redispatchMinutes: 15, extendWithinSeconds: 300, handoverChars: 12000,
  jevNotifyTriage: true,

  quotaFloorPct: 8, quotaWeeklyFloorPct: 6, quotaWarnPct: 20, sessionMaxWakes: 12, sessionMaxWakesByRole: {}, sessionMaxInputK: 200, sessionPolicy: 'reuse', sessionIdleMinutes: 120, ownerBriefHour: 9, blockLoopLimit: 5,
  minFreeMemMb: 2048, minFreeDiskMb: 10240,
  artifactReclaimEnabled: true, artifactEvidenceGraceDays: 3, artifactDeliverableGraceDays: 7, artifactHeadroomMb: 10240,
  archiveRetentionDays: 7, commDirGraceHours: 48, scratchGraceHours: 24,
};

/** 有效派工权重即配置的 weight（0 = 永不主动选中）。 */
export const effectiveWeight = (def: EmployeeDef | undefined): number => Math.max(0, def?.weight ?? 10);

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
  /** Open dispatch-blocked episode: the phase it blocks and when it began (unix seconds). */
  dispatchBlockedPhase?: string;
  dispatchBlockedSince?: number;
  leaseExpiresAt?: number;
  progressAt?: number;
  blockedTo?: 'owner';
  /** Blocked rows: phase restored when the dependency wait ends (review stays review; execute returns ready). */
  resumeState?: TaskRow['state'];
  /** Blocked rows: role recorded by the original block. */
  resumeRole?: string;
  /** Unix seconds; set by a quota-caused block, owner is not re-announced before it. */
  quotaResetsAt?: number;
  kind: string;
  title: string;
  ownerRerouted: boolean;
  /**
   * Effective code repo for dispatch (home grouping, spawn cwd/repoHome): the task's explicit
   * code_repo_path binding wins over the task project overlay, then the goal's project.
   * Undefined falls back to the ops repo.
   */
  repoPath?: string;
  /** Explicit code-repo binding (code_repo_path); informational — repoPath already resolves it. */
  codeRepoPath?: string;
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
    previousEmployee: row.previous_employee ?? undefined,
    dispatchBlockedPhase: row.dispatch_blocked_phase ?? undefined, dispatchBlockedSince: row.dispatch_blocked_since ?? undefined,
    leaseExpiresAt: row.lease_expires_at ?? undefined,
    progressAt: row.progress_at ?? undefined, blockedTo: row.blocked_to ?? undefined,
    resumeState: row.state === 'blocked' ? row.resume_state : undefined, resumeRole: row.state === 'blocked' ? row.resume_role : undefined,
    quotaResetsAt: row.quota_resets_at ?? undefined,
    kind: v.kind, title: v.title,
    ownerRerouted: row.owner_rerouted === true, repoPath: row.repo_path ?? undefined,
    codeRepoPath: row.code_repo_path ?? undefined };
};

const COOLDOWN_BASE = 30 * 60;
const COOLDOWN_MAX = 6 * 60 * 60;
export const capabilitiesFor = (role: Role): Principal['capabilities'] =>
  role === 'owner' || role === 'gm' || role === 'product' ? ['execute', 'review', 'manage'] : ['execute', 'review'];

/** One pending-wake attempt. It lives in the same schemaless dispatch table, keyed by task+phase+episode. */
export type ManagerWakeState = 'pending' | 'running' | 'finished' | 'unknown';

export interface PendingWakeInput {
  taskId: string;
  phase: 'execute' | 'review';
  /** Episode start in milliseconds (the same value ownerActionKey carries). */
  episode: number;
  reason: string;
  version: number;
  repo: string;
}

export interface PendingWakeRow extends PendingWakeInput {
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
export interface PendingWakeClaim {
  key: string;
  token: string;
  attempt: number;
  input: PendingWakeInput;
}

/** Logical in-flight unit: task + phase + episode. Reason/version are fields, not part of the key. */
export const managerWakeKey = (taskId: string, phase: string, episode: number) => `${taskId}:${phase}:${episode}`;

/** A pending attempt with no external-start evidence is safe to release only after this conservative grace. */
export const MANAGER_WAKE_PENDING_GRACE_SECONDS = 120;
/** An observed idle turn is a definite end only after the external action has had this long to start. */
export const MANAGER_WAKE_TURN_GRACE_SECONDS = 60;

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
  /**
   * `retirementHook` is a test seam (SYS-DISP R1 race tests): it runs once the retirement decision has been read and before its
   * write, so a test can land a claim or takeover in exactly that window.
   */
  constructor(private readonly database: CompanyDatabase,
    private readonly retirementHook?: (employeeId: string) => Promise<void>,
    private readonly runner?: { id: string; adoptLegacy?: boolean }) {
    this.enrollment = new LocalEnrollmentAdmin(database);
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
      preferredProvider: pick('preferredProvider', 'preferred_provider'),
      pollSeconds: pick('pollSeconds', 'poll_seconds'),
      stallMinutes: pick('stallMinutes', 'stall_minutes'),
      redispatchMinutes: pick('redispatchMinutes', 'redispatch_minutes'),
      extendWithinSeconds: pick('extendWithinSeconds', 'extend_within_seconds'),
      handoverChars: pick('handoverChars', 'handover_chars'),
      jevNotifyTriage: row?.jev_notify_triage !== false,
      quotaFloorPct: typeof row?.quota_floor_pct === 'number' ? row.quota_floor_pct : 8,
      quotaWeeklyFloorPct: typeof row?.quota_weekly_floor_pct === 'number' ? row.quota_weekly_floor_pct : DEFAULT_CONFIG.quotaWeeklyFloorPct,
      quotaWarnPct: typeof row?.quota_warn_pct === 'number' ? row.quota_warn_pct : DEFAULT_CONFIG.quotaWarnPct,
      sessionMaxWakes: typeof row?.session_max_wakes === 'number' ? row.session_max_wakes : 8,
      sessionMaxWakesByRole: Object.fromEntries(Object.entries(row?.session_max_wakes_by_role && typeof row.session_max_wakes_by_role === 'object' ? row.session_max_wakes_by_role : {})
        .filter((e): e is [string, number] => typeof e[1] === 'number' && Number.isInteger(e[1]) && e[1] >= 0)),
      sessionIdleMinutes: typeof row?.session_idle_minutes === 'number' && Number.isFinite(row.session_idle_minutes) && row.session_idle_minutes >= 0 ? row.session_idle_minutes : DEFAULT_CONFIG.sessionIdleMinutes,
      sessionMaxInputK: typeof row?.session_max_input_k === 'number' ? row.session_max_input_k : DEFAULT_CONFIG.sessionMaxInputK,
      sessionPolicy: row?.session_policy === 'oneshot' ? 'oneshot' : 'reuse',
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
      blockLoopLimit: typeof row?.block_loop_limit === 'number' ? row.block_loop_limit : 5,
    };
  }

  // ---- employee definitions ----
  async upsertDef(defId: string, input: { role: Role; provider: string; model: string; thinking?: string; tracks?: string[]; maxInstances?: number; priority?: number; weight?: number; enabled?: boolean; quotaLimited?: boolean; workHours?: WorkHours | null }): Promise<void> {
    if (!/^[a-z0-9][a-z0-9-]{2,40}$/.test(defId)) throw new CompanyError('invalid', 'Invalid def ID');
    if (!ROLES.includes(input.role)) throw new CompanyError('invalid', 'Invalid role');
    if (!PROVIDER_ID.test(input.provider)) throw new CompanyError('invalid', 'Invalid provider');
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
    // 工作时间同样单独写：不提即保持，null 清除（回到全天）。
    if (input.workHours === null) await this.db.query('UPDATE $def SET work_hours = NONE;', { def: id('employee_def', defId) });
    else if (input.workHours !== undefined) {
      await this.db.query('UPDATE $def SET work_hours = $hours;', { def: id('employee_def', defId), hours: input.workHours });
    }
  }

  /**
   * Every configured def, unfiltered. company.ts wraps `defs()` with runner/provider-route scoping for
   * dispatch; owner surfaces (def.list, def.ensure, admin) must see the whole roster, so they call this.
   */
  async allDefs(): Promise<EmployeeDef[]> {
    type Row = { id: RecordId; role: Role; provider: string; model: string; thinking?: string; tracks?: string[]; enabled: boolean;
      max_instances: number; priority: number; weight?: number; quota_limited?: boolean; error_streak?: number; disabled_reason?: string; work_hours?: unknown };
    const [rows] = await this.db.query<[Row[]]>('SELECT * FROM employee_def ORDER BY weight DESC, priority, id;');
    return rows.map(r => ({ id: asId(r.id), role: r.role, provider: r.provider, model: r.model, thinking: r.thinking ?? undefined,
      tracks: r.tracks ?? undefined,
      enabled: r.enabled !== false, maxInstances: r.max_instances ?? 1, priority: r.priority ?? 100,
      weight: r.weight ?? 10, quotaLimited: r.quota_limited === false ? false : undefined,
      errorStreak: r.error_streak ?? 0,
      ...(r.enabled === false && typeof r.disabled_reason === 'string' && r.disabled_reason ? { disabledReason: r.disabled_reason } : {}),
      ...(parseWorkHours(r.work_hours) ? { workHours: parseWorkHours(r.work_hours) } : {}) }));
  }

  /** Dispatch-scoped view: overridden by company.ts with runner/route filtering. Defaults to the full roster. */
  async defs(): Promise<EmployeeDef[]> { return this.allDefs(); }

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
      paseo_agent_id?: string; active_task?: RecordId; last_wake_at?: number; idle_since?: number; runtime_sleep_requested_at?: number;
      v3_onboarded?: boolean; workspace_cwd?: string; workspace_repo?: string; workspace_scope?: string; paseo_workspace?: string; wake_count?: number; lane?: string; last_task?: RecordId; last_phase?: 'execute' | 'review'; session_task?: string };
    const [rows] = await this.db.query<[Row[]]>(
      `SELECT * FROM employee WHERE revoked != true AND retired != true AND (def != NONE OR paseo_agent_id != NONE)${this.runner ? ' AND (runner_id = $runner OR ($legacy AND runner_id = NONE))' : ''} ORDER BY id;`,
      this.runner ? { runner: this.runner.id, legacy: this.runner.adoptLegacy === true } : {});
    return rows.map(r => ({ id: asId(r.id), role: r.role, def: r.def ? asId(r.def) : undefined, provider: r.provider,
      model: r.model, thinking: r.thinking, paseoAgentId: r.paseo_agent_id ?? undefined,
      activeTask: r.active_task ? asId(r.active_task) : undefined, lastWakeAt: r.last_wake_at, idleSince: r.idle_since, runtimeSleepRequestedAt: r.runtime_sleep_requested_at,
      onboarded: Boolean(r.v3_onboarded), cwd: r.workspace_cwd ?? undefined, repoHome: r.workspace_repo ?? undefined, workspaceScope: r.workspace_scope ?? undefined, paseoWorkspace: r.paseo_workspace ?? undefined, wakeCount: r.wake_count ?? 0,
      principal: r.principal ? asId(r.principal) : undefined,
      lane: r.lane ?? undefined, lastTask: r.last_task ? asId(r.last_task) : undefined, lastPhase: r.last_phase ?? undefined,
      sessionTask: r.session_task ?? undefined }));
  }

  /** What decides whether a session has finished: the states of its tasks. A follow-up task starts its own session. */
  async sessionTaskFacts(taskIds: string[]): Promise<SessionTaskFacts> {
    const ids = taskIds.map(task => id('task', task));
    const [tasks] = await this.db.query<[Array<{ id: RecordId; state: string }>]>('SELECT id, state FROM task WHERE id IN $ids;', { ids });
    return { states: new Map((tasks ?? []).map(task => [asId(task.id), task.state])) };
  }

  /** The root of a task's chain: the goal its sessions are grouped under. */
  async chainRoot(taskId: string): Promise<ChainRoot> {
    let cursor: RecordId = id('task', taskId) as RecordId;
    const seen = new Set<string>();
    for (;;) {
      const [rows] = await this.db.query<[Array<{ title?: string; parent?: RecordId; paseo_workspaces?: ChainWorkspace[] }>]>(
        'SELECT title, parent, paseo_workspaces FROM $task;', { task: cursor });
      const row = rows?.[0];
      if (!row) throw new CompanyError('not_found', 'Task not found');
      seen.add(asId(cursor));
      if (!row.parent || seen.has(asId(row.parent))) return { id: asId(cursor), title: row.title ?? '', workspaces: row.paseo_workspaces ?? [] };
      cursor = row.parent;
    }
  }

  async saveChainWorkspaces(rootId: string, workspaces: ChainWorkspace[]): Promise<void> {
    await this.db.query(workspaces.length ? 'UPDATE $task SET paseo_workspaces = $workspaces;' : 'UPDATE $task UNSET paseo_workspaces;',
      { task: id('task', rootId), workspaces });
  }

  /** Chains with a Paseo container and nothing left to do. */
  async finishedChains(): Promise<ChainRoot[]> {
    const [roots] = await this.db.query<[Array<{ id: RecordId; title?: string; paseo_workspaces: ChainWorkspace[] }>]>(
      'SELECT id, title, paseo_workspaces FROM task WHERE paseo_workspaces != NONE;');
    const finished: ChainRoot[] = [];
    for (const root of roots ?? []) {
      let frontier = [root.id], open = false;
      const seen = new Set<string>();
      while (frontier.length && !open) {
        const [rows] = await this.db.query<[Array<{ id: RecordId; state: string }>]>(
          'SELECT id, state FROM task WHERE id IN $ids OR parent IN $ids;', { ids: frontier });
        open = (rows ?? []).some(row => !['done', 'void'].includes(row.state));
        for (const row of frontier) seen.add(asId(row));
        frontier = (rows ?? []).map(row => row.id).filter(row => !seen.has(asId(row)));
      }
      if (!open) finished.push({ id: asId(root.id), title: root.title ?? '', workspaces: root.paseo_workspaces });
    }
    return finished;
  }

  /** Creates an employee identity for a definition; the caller binds the Paseo agent once spawned.
   *  The credential is returned in memory only (the plugin sidecar holds it in RAM). */
  /** `sessionTask` is written before the session is opened: model traffic is attributed by it from the first request. */
  async spawnInst(def: EmployeeDef, repoHome?: string, workspaceScope?: string, sessionTask?: string): Promise<EmployeeInst> {
    const employeeId = `${def.id}-${randomBytes(3).toString('hex')}`;
    const credential = await this.enrollment.enroll(employeeId, def.role, capabilitiesFor(def.role));
    await this.db.query(`UPDATE $e MERGE { def: $def, provider: $provider, model: $model, thinking: $thinking,
      retired: false, runner_id: $runner, workspace_repo: $repo_home, workspace_scope: $scope, session_task: $session_task, created_at: time::now() };`, {
      e: id('employee', employeeId), def: id('employee_def', def.id), provider: def.provider, model: def.model,
      thinking: def.thinking, repo_home: repoHome, scope: workspaceScope, session_task: sessionTask, runner: this.runner?.id,
    });
    return { repoHome, workspaceScope, id: employeeId, role: def.role, def: def.id, provider: def.provider, model: def.model, thinking: def.thinking, credential, sessionTask };
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

  async bind(employeeId: string, input: { agentId: string; def?: string; provider?: string; model?: string; thinking?: string; cwd?: string; repoHome?: string; workspaceScope?: string; paseoWorkspace?: string }): Promise<void> {
    const [rows] = await this.db.query<[unknown[]]>(`UPDATE $e MERGE {
      paseo_agent_id: $agent, def: $def ?? def, provider: $provider ?? provider, model: $model ?? model,
      thinking: $thinking ?? thinking, workspace_cwd: $cwd ?? workspace_cwd, workspace_repo: $repo_home ?? workspace_repo, workspace_scope: $scope ?? workspace_scope, paseo_workspace: $paseo_workspace ?? paseo_workspace, retired: false } RETURN AFTER;`, {
      e: id('employee', employeeId), agent: input.agentId, def: input.def ? id('employee_def', input.def) : undefined,
      provider: input.provider, model: input.model, thinking: input.thinking, cwd: input.cwd, repo_home: input.repoHome, scope: input.workspaceScope, paseo_workspace: input.paseoWorkspace,
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
        IF array::len($wakes) > 0 { THROW 'idle retirement protected by pending wake' };
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

  /** Atomically fence task + employee before an external call; request identity is caller-owned. */
  async beginDispatchAttempt(input: { request: string; employee: string; task?: string; kind: 'send' | 'spawn'; agent?: string;
    delivery?: string; fence?: number; message?: string; bodyHash: string; body: string; messageRevision?: string; activationRequired?: boolean;
    binding?: { cwd: string; repoHome: string; model: string; workspaceScope?: string; paseoWorkspace?: string } }): Promise<string> {
    if (!input.task || !input.delivery || !input.fence || !input.message) throw new Error('dispatch requires lease and message identity');
    const { body, ...snapshot } = input;
    await this.db.query(`BEGIN;
      LET $t = SELECT * FROM ONLY $task;
      LET $e = SELECT * FROM ONLY $employee;
      IF $t = NONE OR $e = NONE OR $e.retired = true OR $e.revoked = true { THROW 'dispatch actor unavailable' };
      IF $t.current_employee != $key OR $t.delivery_id != $delivery OR $t.fence != $fence OR $t.lease_expires_at <= time::unix(time::now()) { THROW 'dispatch lease changed' };
      IF $t.dispatch_attempt != NONE OR $e.dispatch_attempt != NONE { THROW 'dispatch already isolated' };
      LET $msg = SELECT * FROM ONLY $message;
      IF $msg = NONE OR $msg.task != $task OR $msg.state = 'sent' OR $msg.hold = true OR $msg.dispatch_attempt != NONE { THROW 'dispatch message changed' };
      IF $input.messageRevision != NONE AND ${outboundRevisionSql('$msg.')} != $input.messageRevision { THROW 'dispatch message revision changed' };
      CREATE $attempt CONTENT $input;
      UPDATE ONLY $message SET dispatch_attempt = $attempt, dispatch_body = $body;
      UPDATE ONLY $task SET dispatch_attempt = $attempt;
      UPDATE ONLY $employee SET dispatch_attempt = $attempt;
      COMMIT;`, { task: id('task', input.task), employee: id('employee', input.employee), key: input.employee,
      delivery: input.delivery, fence: input.fence, attempt: id('dispatch_attempt', input.request),
      message: id('outbound_message', input.message), body,
      input: { ...snapshot, state: 'pending', revision: 0, created_at: new Date() } });
    return input.request;
  }

  /** Agent identity is a session receipt, not proof of receipt of this exact prompt. */
  async acknowledgeDispatchAttempt(attempt: string, agent: string): Promise<void> {
    await this.db.query(`BEGIN;
      LET $a = SELECT * FROM ONLY $attempt;
      IF $a = NONE OR $a.state != 'pending' OR $a.revision != 0 OR ($a.agent != NONE AND $a.agent != $agent) { THROW 'dispatch receipt conflict' };
      UPDATE ONLY $attempt SET agent = $agent, revision = $a.revision + 1, acknowledged_at = time::now();
      COMMIT;`, { attempt: id('dispatch_attempt', attempt), agent });
  }

  /** Persist the activation boundary and establish identity while all barriers remain held. */
  async prepareDispatchActivation(attempt: string, agent: string): Promise<void> {
    await this.db.query(`BEGIN;
      LET $a = SELECT * FROM ONLY $attempt;
      LET $task = type::record('task', $a.task);
      LET $employee = type::record('employee', $a.employee);
      LET $t = SELECT * FROM ONLY $task;
      LET $e = SELECT * FROM ONLY $employee;
      IF $a.state != 'pending' OR $a.revision != 1 OR $a.agent != $agent OR $a.activationRequired != true OR $a.activation_state != NONE { THROW 'dispatch activation conflict' };
      IF $t.dispatch_attempt != $attempt OR $e.dispatch_attempt != $attempt OR $e.retired = true OR $e.revoked = true OR ($e.paseo_agent_id != NONE AND $e.paseo_agent_id != $agent) { THROW 'dispatch activation generation changed' };
      IF $t.current_employee != $a.employee OR $t.delivery_id != $a.delivery OR $t.fence != $a.fence { THROW 'dispatch activation lease changed' };
      UPDATE ONLY $employee SET paseo_agent_id = $agent,
        workspace_cwd = $a.binding.cwd ?? workspace_cwd, workspace_repo = $a.binding.repoHome ?? workspace_repo,
        workspace_scope = $a.binding.workspaceScope ?? workspace_scope, paseo_workspace = $a.binding.paseoWorkspace ?? paseo_workspace,
        model = $a.binding.model ?? model;
      UPDATE ONLY $task SET lease_expires_at = math::max([$t.lease_expires_at ?? 0, time::unix(time::now()) + 600]);
      UPDATE ONLY $attempt SET activation_state = 'calling', activation_at = time::now();
      COMMIT;`, { attempt: id('dispatch_attempt', attempt), agent });
  }

  async confirmDispatchActivation(attempt: string, agent: string): Promise<void> {
    await this.db.query(`BEGIN;
      LET $a = SELECT * FROM ONLY $attempt;
      IF $a.state != 'pending' OR $a.agent != $agent OR $a.activation_state != 'calling' { THROW 'dispatch activation receipt conflict' };
      UPDATE ONLY $attempt SET activation_state = 'activated';
      COMMIT;`, { attempt: id('dispatch_attempt', attempt), agent });
  }

  /** The only dispatch finalizer: all database side effects and barrier removal share one CAS. */
  async finishDispatchAttempt(attempt: string, agent: string): Promise<void> {
    await this.db.query(`BEGIN; ${dispatchFinalizationSql} COMMIT;`, { attempt: id('dispatch_attempt', attempt), agent });
  }

  async pendingDispatchAttempts(): Promise<Array<{ id: string; employee: string; task?: string; kind: string; agent?: string; revision?: number; result_confirmed?: boolean; activationRequired?: boolean; activation_state?: string }>> {
    const [rows] = await this.db.query<[Array<{ id: RecordId; employee: string; task?: string; kind: string; agent?: string; revision?: number; result_confirmed?: boolean; activationRequired?: boolean; activation_state?: string }>]>(
      "SELECT * FROM dispatch_attempt WHERE state = 'pending';");
    return rows.map(row => ({ ...row, id: asId(row.id) }));
  }

  /** Restore only a known receipt under the same lease proof. Never sends or clears uncertainty. */
  async recoverDispatchBindings(): Promise<string[]> {
    const errors: string[] = [];
    for (const attempt of await this.pendingDispatchAttempts()) {
      try {
        if (attempt.agent && (attempt.revision === 1 || attempt.result_confirmed) && (!attempt.activationRequired || attempt.activation_state === 'activated' || attempt.result_confirmed)) {
          await this.finishDispatchAttempt(attempt.id, attempt.agent);
          continue;
        }
        if (attempt.result_confirmed) { errors.push(`${attempt.id}: result confirmed; runtime agent receipt missing`); continue; }
        await this.db.query(`BEGIN;
        LET $a = SELECT * FROM ONLY $attempt;
        LET $task = type::record('task', $a.task);
        LET $employee = type::record('employee', $a.employee);
        LET $t = SELECT * FROM ONLY $task;
        LET $e = SELECT * FROM ONLY $employee;
        IF $a.state != 'pending' OR $t.dispatch_attempt != $attempt OR $e.dispatch_attempt != $attempt { THROW 'dispatch recovery moved' };
        IF $e.retired = true OR $e.revoked = true OR ($a.agent != NONE AND $e.paseo_agent_id != NONE AND $e.paseo_agent_id != $a.agent) { THROW 'dispatch recovery actor changed' };
        IF $t.current_employee != $a.employee OR $t.delivery_id != $a.delivery OR $t.fence != $a.fence OR $t.state NOT IN ['doing', 'review'] { THROW 'dispatch recovery lease changed' };
        IF $a.agent != NONE { UPDATE ONLY $employee SET paseo_agent_id = $a.agent,
          workspace_cwd = $a.binding.cwd ?? workspace_cwd, workspace_repo = $a.binding.repoHome ?? workspace_repo,
          workspace_scope = $a.binding.workspaceScope ?? workspace_scope, paseo_workspace = $a.binding.paseoWorkspace ?? paseo_workspace,
          model = $a.binding.model ?? model; };
        UPDATE ONLY $task SET lease_expires_at = math::max([$t.lease_expires_at ?? 0, time::unix(time::now()) + 300]);
        COMMIT;`, { attempt: id('dispatch_attempt', attempt.id) });
      } catch (error) { errors.push(`${attempt.id}: ${(error as Error).message}`); }
    }
    return errors;
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

  /** A terminal provider rejection may charge only the exact current allocation, once.
   * Persist before release; a failed write keeps the allocation isolated and retryable. */
  async recordProviderFailure(employee: string, proof: { taskId: string; deliveryId: string; fence: number }, cause: ProviderFailure['cause']): Promise<void> {
    await this.db.query(`BEGIN TRANSACTION;
      LET $t = SELECT * FROM ONLY $task;
      LET $now = time::unix(time::now());
      IF array::len(($t.provider_failures ?? [])[WHERE delivery=$delivery]) = 0 {
      IF $t.current_employee != $employee OR $t.delivery_id != $delivery OR $t.fence != $fence
        OR $t.state NOT IN ['doing','review'] { THROW 'provider_failure_stale_allocation'; };
      LET $e = SELECT * FROM ONLY $emp;
      IF $e.provider = NONE { THROW 'provider_failure_missing_provider'; };
      LET $recent = SELECT * FROM ($t.provider_failures ?? []) WHERE at > $now - $window;
      IF array::len($recent[WHERE delivery=$delivery]) = 0 {
        UPDATE $task SET provider_failures = array::append($recent, {
          delivery: $delivery, phase: $t.state, provider: $e.provider, cause: $cause, at: $now
        });
      };
      };
      COMMIT TRANSACTION;`, { task: id('task',proof.taskId), emp:id('employee',employee), employee,
      delivery:proof.deliveryId, fence:proof.fence, cause, window: PROVIDER_FAILURE_WINDOW_SECONDS }).retry();
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
       FROM task WHERE state IN ['ready', 'doing', 'review', 'blocked']${this.runner ? ' AND (current_employee = NONE OR current_employee IN (SELECT VALUE record::id(id) FROM employee WHERE runner_id = $runner OR ($legacy AND runner_id = NONE)))' : ''} ORDER BY created_at, id;`,
      this.runner ? { runner: this.runner.id, legacy: this.runner.adoptLegacy === true } : {});
    return rows.map(supervised);
  }


  

  


  

  

  

  

  /** Persists or clears a task's open dispatch-blocked episode (phase and start, unix seconds). */
  async setDispatchBlock(taskId: TaskId, phase: string | undefined, since?: number): Promise<void> {
    await this.db.query('UPDATE $task SET dispatch_blocked_phase = $phase, dispatch_blocked_since = $since;',
      { task: id('task', taskId), phase: phase ?? null, since: since ?? null });
  }

  /**
   * Author/handler history for review exclusion: `excluded` = prior submitters (hard rule),
   * `hands` = execute claimants that never submitted (demoted weight, still eligible).
   */
  async contributors(taskId: TaskId): Promise<{ excluded: string[]; hands: string[]; checkedAt?: string }> {
    const [rows] = await this.db.query<[Array<{ actor?: RecordId | string; action: string }>]>(
      `SELECT actor, action FROM audit WHERE task = $task AND action IN ['submit', 'claim', 'owner_submit'];`,
      { task: id('task', taskId) });
    const excluded = new Set<string>();
    const hands = new Set<string>();
    for (const row of rows ?? []) {
      const actor = typeof row.actor === 'string' ? row.actor : row.actor ? String(row.actor.id) : '';
      if (!actor) continue;
      if (row.action === 'submit' || row.action === 'owner_submit') { excluded.add(actor); hands.delete(actor); }
      else if (row.action === 'claim' && !excluded.has(actor)) hands.add(actor);
    }
    return { excluded: [...excluded], hands: [...hands] };
  }

  /** When each ready task last became ready (unix milliseconds), read in one query. Tasks with no such audit row are absent. */
  async readySince(taskIds: readonly string[]): Promise<Map<string, number>> {
    const since = new Map<string, number>();
    if (taskIds.length === 0) return since;
    const [rows] = await this.db.query<[Array<{ task: unknown; at: unknown }>]>(
      `SELECT task, at FROM audit WHERE task IN $ids
       AND action IN ['create', 'dependency_unlocked', 'submit', 'owner_submit', 'return', 'release', 'revoke', 'resume'] ORDER BY at DESC;`,
      { ids: taskIds.map(taskId => id('task', taskId)) });
    for (const row of rows ?? []) {
      const key = asId(row.task);
      if (!since.has(key) && row.at !== undefined && row.at !== null) since.set(key, Date.parse(String(row.at)));
    }
    return since;
  }

  /** Membership is taken from the execution ledger, never an agent-supplied task tag.
   * Approval is immutable; editing a new draft cannot reprioritize the approved scope. */
  async schedulingFacts(taskIds: readonly string[]): Promise<Map<string, SchedulingFact>> {
    if (!taskIds.length) return new Map();
    const [since, [runs]] = await Promise.all([
      this.readySince(taskIds),
      this.db.query<[Array<{ requirement: string; revision: number; tasks: string[] }>]>(
        'SELECT requirement, revision, tasks FROM requirement_execution WHERE tasks CONTAINSANY $tasks;', { tasks: [...taskIds] }),
    ]);
    const facts = new Map<string, SchedulingFact>([...since].map(([task, readyAt]) => [task, { readyAt }]));
    const keys = [...new Set(runs.filter(r => typeof r.requirement === 'string' && Number.isInteger(r.revision))
      .map(r => `${r.requirement}:${r.revision}`))];
    if (!keys.length) return facts;
    const [approvals] = await this.db.query<[Array<{ id: RecordId; snapshot: string }>]>(
      'SELECT id, snapshot FROM requirement_approval WHERE id IN $ids;', { ids: keys.map(key => id('requirement_approval', key)) });
    const approved = new Map(approvals.map(a => [asId(a.id), a.snapshot]));
    const wanted = new Set(taskIds), ambiguous = new Set<string>();
    for (const run of runs) {
      let snapshot: { requirement?: string; revision?: number; content?: { priority?: number } };
      try { snapshot = JSON.parse(approved.get(`${run.requirement}:${run.revision}`) ?? 'null'); } catch { continue; }
      const priority = snapshot?.content?.priority;
      if (snapshot?.requirement !== run.requirement || snapshot?.revision !== run.revision
        || !Number.isInteger(priority) || priority! < 0 || priority! > 3) continue;
      for (const task of run.tasks) {
        if (!wanted.has(task) || ambiguous.has(task)) continue;
        if (facts.get(task)?.requirement) { facts.set(task, { readyAt: since.get(task) }); ambiguous.add(task); continue; }
        facts.set(task, { readyAt: since.get(task), priority, requirement: run.requirement, revision: run.revision });
      }
    }
    return facts;
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


  

  

  async extendLease(taskId: TaskId, employeeId: string, seconds: number,
    proof?: { deliveryId: string; fence: number }): Promise<boolean> {
    const [rows] = await this.db.query<[unknown[]]>(`UPDATE $task SET lease_expires_at = math::max([lease_expires_at ?? 0, time::unix(time::now()) + $seconds])
      WHERE current_employee = $employee AND delivery_id != NONE
      ${proof ? "AND delivery_id = $delivery AND fence = $fence AND state IN ['doing', 'review']" : ''} RETURN AFTER;`,
      { task: id('task', taskId), employee: employeeId, seconds, delivery: proof?.deliveryId, fence: proof?.fence });
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
      IF $t.dispatch_attempt != NONE { THROW 'dispatch outcome uncertain' };
      LET $next = UPDATE ONLY $task SET
        state = IF $t.state = 'doing' THEN 'ready' ELSE $t.state END,
        current_employee = NONE, delivery_id = NONE, lease_expires_at = NONE,
        handover = true, previous_employee = $employee, version = $t.version + 1 RETURN AFTER;
      UPDATE employee SET active_task = NONE WHERE active_task = $task;
      CREATE audit CONTENT { task: $task, actor: $actor, action: 'revoked', evidence: $evidence, version: $next.version, at: time::now() };
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
  async recordDispatch(taskId: string, version: number, purpose: string, employee: string, scheduling?: SchedulingDecision): Promise<void> {
    await this.db.query('UPSERT $d CONTENT { task: $task, version: $version, purpose: $purpose, employee: $employee, scheduling: $scheduling, at: time::unix(time::now()) };',
      { d: this.dispatchId(taskId, version, purpose), task: taskId, version, purpose, employee, scheduling });
  }

  

  

  

  /**
   * SYS04 AC04: the fault episodes of the given tasks, newest first per task.
   *
   * The dispatcher reads this before it wakes anyone, so a cause that is already on the owner's desk (or
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


  



  



  // ---- pending wake ownership (MR02) ----
  // The owner-action row is the todo. A separate dispatch row is the in-flight attempt, keyed by
  // task+phase+episode, so a reason/version change never starts a second wake while the first 老板 is
  // still processing. Every transition is CAS'd by token+attempt; old callbacks cannot release a new claim.
  private managerWakeId(taskId: string, phase: string, episode: number) {
    return id('dispatch', HASH(`gm-manager-wake\0${taskId}\0${phase}\0${episode}`).slice(0, 24));
  }

  private wakeRow(row: WakeDbRow): PendingWakeRow {
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
  wakeClaim(row: PendingWakeRow): PendingWakeClaim {
    return { key: row.key, token: row.token, attempt: row.attempt, input: {
      taskId: row.taskId, phase: row.phase, episode: row.episode, reason: row.reason, version: row.version, repo: row.repo,
    } };
  }

  /**
   * Acquire the only in-flight permission for task+phase+episode. Missing rows are created; a finished
   * row starts the next attempt; pending/running/unknown rows refuse. The write is a single CAS
   * transaction, so concurrent dispatchers and restarts can only produce one winner.
   */
  async acquirePendingWake(input: PendingWakeInput, token: string = randomUUID()): Promise<PendingWakeClaim | undefined> {
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

  /** Mark the attempt as externally started / running and bind the 老板 employee and (when known) Paseo agent. */
  async markPendingWakeRunning(claim: PendingWakeClaim, employee: string, agent?: string): Promise<boolean> {
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
        IF $seat != NONE AND ($seat.revoked = true OR $seat.retired = true) { THROW 'wake employee retired' };
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
  async finishManagerWake(claim: PendingWakeClaim, state: 'finished' | 'unknown', resolution: string, lastStatus?: string): Promise<boolean> {
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
  async openPendingWakes(): Promise<PendingWakeRow[]> {
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
        !message.includes('not executed due to') && !message.startsWith('Cannot COMMIT')) ?? 'pending wake transaction failed';
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
