import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { RecordId } from 'surrealdb';
import type { CompanyDatabase } from './database.ts';
import type { Principal, RetirementKind, Role, TaskId } from './contracts.ts';
import { asId, CompanyError, HASH, id, ROLES, UNLOCK_SQL, view, type TaskRow } from './core.ts';
import { LocalEnrollmentAdmin, revokedCredentialDigest } from './enrollment.ts';
import { collectEvalState, writeScorecards, type EvalState, type ScoredEmployee } from './scoring.ts';
import { readContributors, type ContributionFacts } from './contributors.ts';
import { gateCredentialChange } from './retirement.ts';

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
  onboarded?: boolean;
  /** Directory of the Paseo workspace this instance runs in (project repo, or the ops repo when undefined). */
  cwd?: string;
  repoHome?: string;
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
  /** 实例派工达到该次数即退休换新会话，避免上下文无限膨胀；0 = 不按次数轮换。 */
  sessionMaxWakes: number;
  /** 实例上一轮 input token 超过该值（千）即退休换新会话；0 = 不按上下文大小轮换。 */
  sessionMaxInputK: number;
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
}

export const DEFAULT_CONFIG: CompanyConfig = {
  paused: false, maxRunning: 4, providerMax: { codex: 3, grok: 2, devin: 2 },
  pollSeconds: 20, stallMinutes: 90, redispatchMinutes: 15, extendWithinSeconds: 300, handoverChars: 12000,
  evalEnabled: true, evalEngine: 'auto', jevMinConfidence: 0.7, jevFlagThreshold: 0.65, jevNotifyTriage: true,
  jevDecisions: true, jevReleaseThreshold: 0.8, jevOwnerThreshold: 0.3, jevPickConfidence: 0.5,
  quotaFloorPct: 8, quotaWeeklyFloorPct: 2, sessionMaxWakes: 12, sessionMaxInputK: 400, evalQuickLlm: false, ownerBriefHour: 9, blockLoopLimit: 5,
  minFreeMemMb: 2048, minFreeDiskMb: 10240,
  artifactReclaimEnabled: true, artifactEvidenceGraceDays: 3, artifactDeliverableGraceDays: 7, artifactHeadroomMb: 10240,
  archiveRetentionDays: 7, commDirGraceHours: 48,
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
  /** Open dispatch-blocked episode: the phase it blocks and when it began (unix seconds). */
  dispatchBlockedPhase?: string;
  dispatchBlockedSince?: number;
  leaseExpiresAt?: number;
  progressAt?: number;
  blockedTo?: 'gm' | 'owner';
  /** Unix seconds; set by a quota-caused block, gm is not re-announced before it. */
  quotaResetsAt?: number;
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
    previousEmployee: row.previous_employee ?? undefined, implementer: row.implementer ?? undefined,
    dispatchBlockedPhase: row.dispatch_blocked_phase ?? undefined, dispatchBlockedSince: row.dispatch_blocked_since ?? undefined,
    leaseExpiresAt: row.lease_expires_at ?? undefined,
    progressAt: row.progress_at ?? undefined, blockedTo: row.blocked_to ?? undefined,
    quotaResetsAt: row.quota_resets_at ?? undefined, kind: v.kind, title: v.title, goalId: v.goalId,
    evalAttempts: row.eval_attempts ?? 0, jevReleaseVersion: row.jev_release_version ?? undefined,
    jevRouteVersion: row.jev_route_version ?? undefined, ownerRerouted: row.owner_rerouted === true, repoPath: row.repo_path ?? undefined,
    codeRepoPath: row.code_repo_path ?? undefined, goalTier: row.goal_tier ?? undefined };
};

const COOLDOWN_BASE = 30 * 60;
const COOLDOWN_MAX = 6 * 60 * 60;
export const capabilitiesFor = (role: Role): Principal['capabilities'] =>
  role === 'eval' ? [] : role === 'gm' || role === 'product' ? ['execute', 'review', 'manage'] : ['execute', 'review'];

export class Workforce {
  private readonly enrollment: LocalEnrollmentAdmin;
  /**
   * `retirementHook` is a test seam (SYS-DISP R1 race tests): it runs once the retirement decision has been read and before its
   * write, so a test can land a claim or takeover in exactly that window.
   */
  constructor(private readonly database: CompanyDatabase, private readonly credentialDir: string,
    private readonly retirementHook?: (employeeId: string) => Promise<void>) {
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
      quotaWeeklyFloorPct: typeof row?.quota_weekly_floor_pct === 'number' ? row.quota_weekly_floor_pct : 2,
      sessionMaxWakes: typeof row?.session_max_wakes === 'number' ? row.session_max_wakes : 8,
      sessionMaxInputK: typeof row?.session_max_input_k === 'number' ? row.session_max_input_k : 150,
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
      blockLoopLimit: typeof row?.block_loop_limit === 'number' ? row.block_loop_limit : 5,
    };
  }

  // ---- employee definitions ----
  async upsertDef(defId: string, input: { role: Role; provider: string; model: string; thinking?: string; tracks?: string[]; maxInstances?: number; priority?: number; weight?: number; enabled?: boolean }): Promise<void> {
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
  }

  async defs(): Promise<EmployeeDef[]> {
    type Row = { id: RecordId; role: Role; provider: string; model: string; thinking?: string; tracks?: string[]; enabled: boolean;
      max_instances: number; priority: number; weight?: number; scored?: number; avg_score?: number; error_streak?: number };
    const [rows] = await this.db.query<[Row[]]>('SELECT * FROM employee_def ORDER BY weight DESC, priority, id;');
    return rows.map(r => ({ id: asId(r.id), role: r.role, provider: r.provider, model: r.model, thinking: r.thinking ?? undefined,
      tracks: r.tracks ?? undefined,
      enabled: r.enabled !== false, maxInstances: r.max_instances ?? 1, priority: r.priority ?? 100,
      weight: r.weight ?? 10, scored: r.scored ?? 0, avgScore: r.avg_score ?? undefined, errorStreak: r.error_streak ?? 0 }));
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
    type Row = { id: RecordId; role: Role; def?: RecordId; provider?: string; model?: string; thinking?: string;
      paseo_agent_id?: string; active_task?: RecordId; credential_file?: string; last_wake_at?: number;
      v3_onboarded?: boolean; workspace_cwd?: string; workspace_repo?: string; wake_count?: number };
    const [rows] = await this.db.query<[Row[]]>(
      'SELECT * FROM employee WHERE revoked != true AND retired != true AND (def != NONE OR paseo_agent_id != NONE) ORDER BY id;');
    return rows.map(r => ({ id: asId(r.id), role: r.role, def: r.def ? asId(r.def) : undefined, provider: r.provider,
      model: r.model, thinking: r.thinking, paseoAgentId: r.paseo_agent_id ?? undefined,
      activeTask: r.active_task ? asId(r.active_task) : undefined, credentialFile: r.credential_file, lastWakeAt: r.last_wake_at,
      onboarded: Boolean(r.v3_onboarded), cwd: r.workspace_cwd ?? undefined, repoHome: r.workspace_repo ?? undefined, wakeCount: r.wake_count ?? 0 }));
  }

  /** Creates an employee identity for a definition; the caller binds the Paseo agent once spawned.
   *  The credential is returned in memory only — file delivery is the caller's choice
   *  (writeCredentialFile for the legacy standalone dispatcher; plugin sidecar keeps it in RAM). */
  async spawnInst(def: EmployeeDef): Promise<EmployeeInst> {
    const employeeId = `${def.id}-${randomBytes(3).toString('hex')}`;
    const credential = await this.enrollment.enroll(employeeId, def.role, capabilitiesFor(def.role));
    await this.db.query(`UPDATE $e MERGE { def: $def, provider: $provider, model: $model, thinking: $thinking,
      retired: false, created_at: time::now() };`, {
      e: id('employee', employeeId), def: id('employee_def', def.id), provider: def.provider, model: def.model,
      thinking: def.thinking,
    });
    return { id: employeeId, role: def.role, def: def.id, provider: def.provider, model: def.model, thinking: def.thinking, credential };
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

  async bind(employeeId: string, input: { agentId: string; def?: string; provider?: string; model?: string; thinking?: string; credentialFile?: string; cwd?: string; repoHome?: string }): Promise<void> {
    const [rows] = await this.db.query<[unknown[]]>(`UPDATE $e MERGE {
      paseo_agent_id: $agent, def: $def ?? def, provider: $provider ?? provider, model: $model ?? model,
      thinking: $thinking ?? thinking, credential_file: $file ?? credential_file, workspace_cwd: $cwd ?? workspace_cwd, workspace_repo: $repo_home ?? workspace_repo, retired: false } RETURN AFTER;`, {
      e: id('employee', employeeId), agent: input.agentId, def: input.def ? id('employee_def', input.def) : undefined,
      provider: input.provider, model: input.model, thinking: input.thinking, file: input.credentialFile, cwd: input.cwd, repo_home: input.repoHome,
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
  async retire(employeeId: string, reason: string, kind: RetirementKind): Promise<void> {
    const [exists] = await this.db.query<[unknown]>('SELECT VALUE id FROM ONLY $e;', { e: id('employee', employeeId) });
    if (!exists) throw new CompanyError('not_found', 'Employee not found');
    await gateCredentialChange(this.db, employeeId, {
      operation: 'retire',
      statement: `UPDATE $employee SET retired_kind = IF retired = true THEN retired_kind ELSE $kind END,
        retired = true, retired_reason = $reason, retired_at = time::now(), revoked = true, credential_digest = $digest;`,
      vars: { kind, reason, digest: revokedCredentialDigest() },
    }, this.retirementHook);
  }

  async touchWake(employeeId: string): Promise<void> {
    await this.db.query('UPDATE $e SET last_wake_at = time::unix(time::now()), v3_onboarded = true, wake_count = (wake_count ?? 0) + 1;',
      { e: id('employee', employeeId) });
  }

  // ---- provider health ----
  async providerHealth(): Promise<Map<string, ProviderHealth>> {
    type Row = { id: RecordId; state: ProviderHealth['state']; until?: number; failures?: number; last_error?: string };
    const [rows] = await this.db.query<[Row[]]>('SELECT * FROM provider_health;');
    return new Map(rows.map(r => [asId(r.id), { provider: asId(r.id), state: r.state, until: r.until,
      failures: r.failures ?? 0, lastError: r.last_error }]));
  }

  async markExhausted(provider: string, error: string): Promise<ProviderHealth> {
    const current = (await this.providerHealth()).get(provider);
    const failures = (current?.failures ?? 0) + 1;
    const until = (await this.now()) + Math.min(COOLDOWN_BASE * 2 ** (failures - 1), COOLDOWN_MAX);
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
      `SELECT *, NONE AS context, code_repo_path ?? project.repo_path ?? goal.project.repo_path AS repo_path, goal.tier AS goal_tier
       FROM task WHERE state IN ['ready', 'doing', 'review', 'blocked'] ORDER BY created_at, id;`);
    return rows.map(supervised);
  }

  /** Metrics + timeline a judge needs to score a finished task (shared with the Jev dispatcher path). */
  async evalState(taskId: TaskId): Promise<EvalState> {
    return collectEvalState(this.db, taskId);
  }

  /** Authorship facts (authors, reviewers, implementer) from the audit stream: the review and execute gates. */
  async contributors(taskId: TaskId): Promise<ContributionFacts> {
    return readContributors(this.db, taskId);
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
    const responses = await this.db.query<unknown[]>(`BEGIN;
      LET $t = SELECT * FROM ONLY $task;
      IF $t = NONE OR $t.state != 'review' OR $t.current_employee != NONE OR $t.version != $version { THROW 'task changed' };
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
      IF $t = NONE OR $t.state != 'blocked' OR $t.blocked_to != 'owner' OR $t.version != $version { THROW 'task changed' };
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

  async serverNow(): Promise<number> { return this.now(); }
  newKey(): string { return randomUUID(); }
}
