// SYS03：老板处置的原子认领、业务幂等与变更通知（blocking episode 的处置账本）。
//
// 设计要点（对应 AC01-AC04）：
//   * 每个 blocking episode（任务 + 阶段 + 阶段开始毫秒）最多一条 disposition_claim，id 由 episode 导出，
//     领取是一次 CAS：并发两个老板只有一个成功，另一个拿到 held_by_other / already_handled 与可读的结果；
//     租约失效只能经显式 takeover 按 episode_version 受控接手（AC01）。
//   * 决定写入（resume / defer / dependency / retire / repair）先按业务幂等键占位（与员工身份无关），
//     再走既有 core 状态机落库，最后 CAS 回执；幂等键唯一索引让 20 个并发请求只产生一项处置与一条修复链，
//     网络重放/换员工/重启读到同一结果（AC02、AC05）。
//   * 每次决定都通知「当前持有人」并落 holder_notice（notice_key 去重、delivered_at 补发），
//     任务实时视图用 disposition_status 读到最新决定（AC04）。
//   * 受控外部动作有独立记录与三态（requested / result_unknown / confirmed），带外变更只标 unknown_actor（AC03）。
//
// 回滚隔离（RB01）：本模块只写自己的四张表；旧版读不到它们即忽略，且处置动作本身沿旧版可见的
// 状态机（resume/defer/retire）落库并关闭旧版可见的 episode 信号（dispatch 的 gm-manager-action 行与
// manager-wake 行），所以旧版在同样的数据上不会误认领、误拉起。
import { createHash, randomUUID } from 'node:crypto';
import { RecordId } from 'surrealdb';
import type { CompanyDatabase } from './database.ts';
import { CompanyError } from './core-errors.ts';

const HASH = (value: string) => createHash('sha256').update(value).digest('hex');
const id = (table: string, value: string) => new RecordId(table, value);
const asId = (value: unknown): string => value instanceof RecordId ? String(value.id) : String(value).split(':').slice(1).join(':');

/** 处置的默认租约：足够一个老板读完 episode 并写入决定，超时可被受控接手。 */
export const DEFAULT_DISPOSITION_LEASE_SECONDS = 900;
/** 一个决定最多带来的通知条数（决定本身 + 撤租 + 接手）。 */
const MAX_NOTICES_PER_DECISION = 3;

export type DispositionPhase = 'execute' | 'review';
export type DispositionActionName = 'resume' | 'defer' | 'dependency' | 'retire' | 'repair';
export type DispositionClaimStatus = 'claimed' | 'decided';
export type DispositionNoticeKind = 'disposition_decided' | 'dependency_wait' | 'resumed' | 'claim_revoked'
  | 'claim_taken_over' | 'external_action' | 'external_action_unknown'
  // SYS-INT：老板对在途任务追加验收要求修订后的持有人通知（正文与审计在 core.taskAcceptanceAmend 写）。
  | 'acceptance_amended';

/**
 * episode 身份：任务 + 阶段 + 阶段开始毫秒。与调度器的 managerWakeKey / managerActionKey 同源，
 * 所以「提醒」与「处置」说的是同一个 episode，旧提醒不会被当成新 episode 重新拉起。
 */
export const dispositionEpisodeKey = (taskId: string, phase: DispositionPhase, sinceMs: number) => `${taskId}:${phase}:${sinceMs}`;

/**
 * 全局业务幂等键：默认由 episode + 动作导出，**不含员工身份**。因此同一 episode 的同一动作
 * 无论谁发起、重放多少次、中间换过员工，都落在同一条 disposition_action 上；显式传入的
 * businessKey 用于跨 episode 的业务操作（例如一次上线申请里的同一修复链）。
 */
export const dispositionBusinessKey = (episode: string, action: DispositionActionName, explicit?: string) => {
  const custom = explicit?.trim();
  return custom ? `custom\0${custom}` : `${episode}\0${action}`;
};

export const dispositionNoticeKey = (episode: string, kind: DispositionNoticeKind, version: number) => `${episode}\0${kind}\0${version}`;

/**
 * holder_notice 的记录 id 由 notice_key 导出：投递回执（markNotices）只拿到 noticeKey，所以任何写通知的
 * 路径（处置账本、老板验收修订）都必须用同一个派生，否则通知写进去却 ack 不到。
 */
export const holderNoticeId = (noticeKey: string): RecordId => id('holder_notice', HASH(noticeKey).slice(0, 24));

export interface DispositionClaimInput {
  taskId: string;
  phase: DispositionPhase;
  /** 阶段开始毫秒（task.dispatch_blocked_since * 1000，或 manager action 的 episode）。 */
  sinceMs: number;
  reason: string;
  leaseSeconds?: number;
  /** 受控接手：只对租约已失效的现存 claim 生效，且必须带 expectedEpisodeVersion。 */
  takeover?: boolean;
  expectedEpisodeVersion?: number;
}

export interface DispositionRepairInput {
  title: string;
  context: string;
  executorRole: string;
  reviewerRole: string;
  dependencies?: string[];
  discipline?: string;
  goalId?: string;
  /** Project override for the repair task; defaults to the source task's routing. */
  project?: string;
  /** Carried when the repair is itself a code delivery (kind 'code' requires the engineering role). */
  workIntent?: { kind: 'read' | 'code' | 'assets'; paths?: string[]; lane?: string };
}

export interface DispositionDecideInput {
  taskId: string;
  phase: DispositionPhase;
  sinceMs: number;
  claimToken: string;
  episodeVersion: number;
  action: DispositionActionName;
  /**
   * 任务版本的 CAS：决定写入必须带上读到的版本。
   * 字段名与其余工具（claim/submit/review 的 proof、resume_task、retire_task）一致，都是 `expectedVersion`；
   * SYS03 首版在这里写成 `expectedTaskVersion`，而 MCP 入参与 sidecar 透传的都是 `expectedVersion`，
   * 于是经通道过来的决定永远读不到版本、被当成非法入参拒掉（QA V1）。这里统一为 `expectedVersion`。
   */
  expectedVersion: number;
  text: string;
  /** action=defer/dependency：并入的依赖；action=repair：修复任务内容。 */
  dependencies?: string[];
  repair?: DispositionRepairInput;
  businessKey?: string;
  idempotencyKey: string;
}

export interface DispositionClaimView {
  episode: string;
  taskId: string;
  phase: DispositionPhase;
  episodeSince: number;
  episodeVersion: number;
  status: DispositionClaimStatus;
  holder?: string;
  holderRole?: string;
  leaseExpiresAt?: number;
  takenOverFrom?: string;
  /** 只回给持有人本人；其他人读到的是 undefined。 */
  token?: string;
  decision?: DispositionDecisionView;
}

export interface DispositionDecisionView {
  action: DispositionActionName | string;
  businessKey?: string;
  actor?: string;
  at?: string;
  taskVersion?: number;
  result?: Record<string, unknown>;
  repairTaskId?: string;
}

export type DispositionClaimOutcome =
  | { outcome: 'claimed'; claim: DispositionClaimView }
  | { outcome: 'renewed'; claim: DispositionClaimView }
  | { outcome: 'taken_over'; claim: DispositionClaimView; previousHolder?: string }
  | { outcome: 'held_by_other'; claim: DispositionClaimView }
  | { outcome: 'already_handled'; claim: DispositionClaimView; decision?: DispositionDecisionView };

export type DispositionDecideOutcome = {
  outcome: 'decided' | 'replayed' | 'in_progress';
  decision?: DispositionDecisionView;
  task?: Record<string, unknown>;
  repairTaskId?: string;
};

export interface DispositionStatusInput {
  taskId: string;
  phase?: DispositionPhase;
  sinceMs?: number;
}

export interface DispositionStatusView {
  taskId: string;
  /** 该任务有处置记录的最新 episode 快照；没有则为 undefined（提醒尚未被任何老板领取）。 */
  claim?: DispositionClaimView;
  /** 最新 episode 的处置历史（按 episode_since 倒序）。 */
  episodes: DispositionClaimView[];
  /** 当前是否仍存在打开的阻塞 episode（任务仍 blocked 且阶段一致）。 */
  openEpisode: boolean;
  holder?: string;
  undeliveredNotices: number;
}

export interface HolderNoticeView {
  id: string;
  noticeKey: string;
  episode: string;
  taskId: string;
  holder: string;
  kind: DispositionNoticeKind;
  text: string;
  payload: Record<string, unknown>;
  createdAt?: string;
  deliveredAt?: string;
  deliveries: number;
  lastError?: string;
}

export interface DispositionRepairResult {
  /** 新建的修复链任务。 */
  taskId: string;
  /** 原任务在本次决定后的版本与状态（修复决定通过让原任务等待修复链来结束原 episode）。 */
  sourceTaskVersion?: number;
  sourceState?: string;
}

/** 处置动作落到任务状态机上的实现（core 注入，复用既有 resume/defer/retire/create 路径）。 */
export interface DispositionApplier {
  resume(input: { taskId: string; text: string; idempotencyKey: string }): Promise<{ taskVersion: number; state: string }>;
  defer(input: { taskId: string; text: string; dependencies: string[]; expectedTaskVersion: number; idempotencyKey: string }): Promise<{ taskVersion: number; state: string }>;
  retire(input: { taskId: string; text: string; expectedTaskVersion: number; idempotencyKey: string }): Promise<{ taskVersion: number; state: string }>;
  repair(input: { repairKey: string; taskId: string; text: string; expectedTaskVersion: number; repair: DispositionRepairInput }): Promise<DispositionRepairResult>;
}

export interface ExternalActionTarget { provider: 'github'; repo: string; runId: string }

/**
 * QA D5：这条受控外部动作实际拿什么把 run 绑到前置任务上。`repo+branch` = 前置任务登记的仓库（GitHub slug 或能
 * 解析成 slug 的 remote）与 run 的仓库相同，并且分支名也相同；`branch_only` = 任务没有可比的仓库标识，只核对了
 * 分支名；`manager_exempt` = 调用者是老板（owner/product），按设计不做 run↔任务绑定核对。依据照实记进审计证据，
 * 绝不把只核对了分支（或根本没核对）说成核对了仓库。
 */
export type ExternalActionBinding = 'repo+branch' | 'branch_only' | 'manager_exempt';

export interface ExternalActionRequestInput {
  kind: 'ci-run-cancel';
  repo: string;
  runId: string;
  reason: string;
  /** 前置任务与版本：动作必须绑定它当时读到的任务版本（CAS）。 */
  prerequisiteTaskId?: string;
  prerequisiteVersion?: number;
  actionKey: string;
}

export interface ExternalActionView {
  actionKey: string;
  kind: string;
  provider: string;
  target: Record<string, unknown>;
  requestedBy?: string;
  reason: string;
  prerequisiteTaskId?: string;
  prerequisiteVersion?: number;
  state: 'requested' | 'result_unknown' | 'confirmed' | 'refused';
  attempts: number;
  attribution: 'internal_employee' | 'unknown_actor';
  externalAccount?: string;
  confirmedResult?: Record<string, unknown>;
  attributionEvidence?: string;
  createdAt?: string;
  updatedAt?: string;
  reconciledAt?: string;
}

/**
 * 受控外部动作的真实出口。生产实现只走 `gh`（环境里的共用登录，绝不冒认老板）；
 * 测试注入 fake 端点。`cancelRun` 结果未知时如实回 unknown，不许伪报成功。
 */
export interface ExternalActionGateway {
  /**
   * `context.replay` 为真表示这次调用是在我们已经为同一个 actionKey 发过一次请求之后的重放：网关这时**只读**运行状态，
   * 绝不重发取消请求（QA D3）。读到终态且结论是取消 = 我们自己那次请求生效（confirmed）；读到终态别的结论或运行不存在
   * = refused；读不到、或还没落定 = result_unknown（落定后按同一 key 再读一次才会变 confirmed）。
   * `context.claimRequest` 由账本提供，是「本次调用是否就是要真的发那次请求」的原子占位：返回 false 表示同 key 的
   * 另一条请求已经占了出口，于是本次一律不 POST、如实回 unknown（并发下最多只有一条请求到达 provider）。
   */
  cancelRun(target: ExternalActionTarget, context?: { replay?: boolean; claimRequest?: () => Promise<boolean> }): Promise<
    | { confirmed: true; runStatus?: string; externalAccount?: string; observed?: Record<string, unknown> }
    /** The provider gave a definite no (the run does not exist, or it is already terminal): recorded as refused. */
    | { refused: true; reason: string }
    /** The outcome cannot be judged (unreadable, request failed, not settled yet): recorded as result_unknown. */
    | { confirmed: false; error: string; observed?: Record<string, unknown> }>;
  observeRun(target: ExternalActionTarget): Promise<
    | { readable: true; exists: boolean; runStatus?: string; conclusion?: string; externalAccount?: string;
      /** The run's head branch: the caller binds a controlled action to the task's registered branch with it. */
      headBranch?: string; headSha?: string; attribution: 'unknown_actor' }
    | { readable: false; error: string }>;
}

type Row = Record<string, unknown>;

const text = (value: unknown): string => typeof value === 'string' ? value : '';
const num = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined;

function requireText(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== 'string' || value.trim().length < min || value.length > max) {
    throw new CompanyError('invalid', `Invalid ${field}`);
  }
  return value;
}

function requirePhase(value: unknown): DispositionPhase {
  if (value !== 'execute' && value !== 'review') throw new CompanyError('invalid', 'Invalid phase');
  return value;
}

function requireAction(value: unknown): DispositionActionName {
  if (!['resume', 'defer', 'dependency', 'retire', 'repair'].includes(String(value))) {
    throw new CompanyError('invalid', 'Invalid disposition action');
  }
  return value as DispositionActionName;
}

/** 老板处置账本。core（工具入口）与 workforce（调度器只读守卫 / 通知投递）各持一个实例，共用同一数据库。 */
export class DispositionLedger {
  constructor(private readonly database: CompanyDatabase) {}
  private get db() { return this.database.db; }

  private async now(): Promise<number> {
    const [[value]] = await this.db.query<[[number]]>('RETURN [time::unix(time::now())];');
    return Number(value);
  }

  private claimId(episode: string): RecordId {
    return id('disposition_claim', HASH(episode).slice(0, 24));
  }

  private actionId(businessKey: string): RecordId {
    return id('disposition_action', HASH(businessKey).slice(0, 24));
  }

  private noticeId(noticeKey: string): RecordId {
    return holderNoticeId(noticeKey);
  }

  private externalId(actionKey: string): RecordId {
    return id('external_action', HASH(actionKey).slice(0, 24));
  }

  /**
   * 一次事务运行，把 THROW '…' 的消息映射成结构化拒绝。返回最后一条 RETURN 的值。
   * 与 workforce.runTxResult 同形（RETURN 在 COMMIT 之前，故取倒数第二条响应）。
   * 公司 fork 的事务准入偶发地拒绝并发事务（"Quota admission conflicted"）：这种失败整笔回滚、什么都没写，
   * 重试一次是安全的，也让并发领取/决定只看业务 CAS 的结论，而不是看服务器的准入排队。
   */
  private async run<T>(query: string, vars: Record<string, unknown>): Promise<T | undefined> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.runOnce<T>(query, vars);
      } catch (error) {
        if (attempt === 0 && /admission/i.test(String((error as Error)?.message ?? error))) continue;
        throw error;
      }
    }
  }

  private async runOnce<T>(query: string, vars: Record<string, unknown>): Promise<T | undefined> {
    const responses = await this.db.query<unknown[]>(query, vars).responses();
    const failures = responses.filter(response => !response.success);
    if (failures.length) {
      const cause = failures.map(response => response.error.message).find(message =>
        !message.includes('not executed due to') && !message.startsWith('Cannot COMMIT')) ?? 'disposition transaction failed';
      throw dispositionError(cause);
    }
    return responses.map(response => response.success ? response.result : undefined).at(-2) as T | undefined;
  }

  // ---------------------------------------------------------------- 认领

  async claim(actor: { employeeId: string; role: string }, input: DispositionClaimInput): Promise<DispositionClaimOutcome> {
    const phase = requirePhase(input.phase);
    requireText(input.taskId, 'taskId', 1, 200);
    requireText(input.reason, 'reason', 4, 2000);
    if (!Number.isSafeInteger(input.sinceMs) || input.sinceMs < 0) throw new CompanyError('invalid', 'Invalid episode start');
    const leaseSeconds = input.leaseSeconds ?? DEFAULT_DISPOSITION_LEASE_SECONDS;
    if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 30 || leaseSeconds > 86_400) throw new CompanyError('invalid', 'Invalid leaseSeconds');
    if (input.takeover === true && !Number.isSafeInteger(input.expectedEpisodeVersion)) {
      // 接手是破坏性操作（把另一个老板的租约换掉）：必须明示读到的 episode 版本，否则一律拒绝。
      throw new CompanyError('invalid', 'takeover requires expectedEpisodeVersion');
    }
    const episode = dispositionEpisodeKey(input.taskId, phase, input.sinceMs);
    const d = this.claimId(episode);
    const token = randomUUID();
    const existing = await this.db.select<Row>(d);
    if (existing && existing.status === 'decided' && input.takeover !== true) {
      return { outcome: 'already_handled', claim: this.claimView(existing, actor.employeeId, false), decision: this.decisionOf(existing) };
    }
    if (existing && existing.status === 'claimed' && !existing.holder && input.takeover !== true) {
      // 已被前持有人释放：空缺可直接领取。
      const taken = await this.run<Row>(`BEGIN;
        LET $c = SELECT * FROM ONLY $d;
        IF $c = NONE OR $c.status != 'claimed' OR $c.holder != NONE { THROW 'disposition claim moved' };
        LET $updated = UPDATE ONLY $d SET holder = $me, holder_role = $role, token = $d_token,
          lease_expires_at = $expires, taken_over_from = $previous, updated_at = time::now() RETURN AFTER;
        CREATE $audit CONTENT { task: $task_ref, actor: $actor_ref, action: 'disposition_claimed', evidence: $evidence, at: time::now() };
        RETURN $updated;
        COMMIT;`, this.claimVars(input, episode, d, actor, token, leaseSeconds, text(existing.holder) || undefined));
      if (taken) return { outcome: 'claimed', claim: this.claimView(taken, actor.employeeId, true) };
    }
    const created = await this.run<Row>(`BEGIN;
      LET $created = CREATE ONLY $d CONTENT {
        episode: $episode, task: $task_ref, phase: $phase, episode_since: $since, episode_version: 1,
        status: 'claimed', holder: $me, holder_role: $role, token: $d_token, lease_expires_at: $expires,
        taken_over_from: NONE, claimed_at: time::now(), updated_at: time::now(),
        decision_action: NONE, decision_business_key: NONE, decision_actor: NONE, decision_at: NONE,
        decision_task_version: NONE, decision_result: NONE };
      CREATE $audit CONTENT { task: $task_ref, actor: $actor_ref, action: 'disposition_claimed', evidence: $evidence, at: time::now() };
      RETURN $created;
      COMMIT;`, this.claimVars(input, episode, d, actor, token, leaseSeconds)).catch(async error => {
      // 并发对手先落地了这个 episode（或服务器以准入冲突拒绝了这次写入但对手已经建行）：读它，
      // 交给下面的分类逻辑给调用方一个可读结论；确实什么都没写才把错误抛回去。
      if (await this.db.select<Row>(d)) return undefined;
      throw error;
    });
    if (created) return { outcome: 'claimed', claim: this.claimView(created, actor.employeeId, true) };

    const row = await this.db.select<Row>(d);
    if (!row) throw new CompanyError('conflict', 'Disposition claim disappeared during the race');
    if (row.status === 'decided') {
      return { outcome: 'already_handled', claim: this.claimView(row, actor.employeeId, false), decision: this.decisionOf(row) };
    }
    const holder = text(row.holder) || undefined;
    const expires = num(row.lease_expires_at);
    if (holder === actor.employeeId) {
      // 自己续租：返回同一个 token，客户端不会因此拿到第二个处置权。
      const renewed = await this.run<Row>(`BEGIN;
        LET $updated = UPDATE ONLY $d SET lease_expires_at = $expires, updated_at = time::now()
          WHERE token = $d_token AND status = 'claimed' RETURN AFTER;
        RETURN $updated;
        COMMIT;`, { d, d_token: row.token, expires: (await this.now()) + leaseSeconds });
      return { outcome: 'renewed', claim: this.claimView(renewed ?? row, actor.employeeId, true) };
    }
    if (input.takeover === true) {
      const takenOverVersion = Number(row.episode_version);
      const takeoverNoticeKey = dispositionNoticeKey(episode, 'claim_taken_over', takenOverVersion);
      const taken = await this.run<Row>(`BEGIN;
        LET $c = SELECT * FROM ONLY $d;
        IF $c = NONE OR $c.status != 'claimed' OR $c.holder = NONE { THROW 'disposition claim moved' };
        IF $c.lease_expires_at > $now { THROW 'disposition claim leased by another' };
        IF $c.episode_version != $seen { THROW 'disposition claim moved' };
        LET $updated = UPDATE ONLY $d SET holder = $me, holder_role = $role, token = $d_token,
          lease_expires_at = $expires, taken_over_from = $previous, episode_version = $c.episode_version + 1,
          updated_at = time::now() RETURN AFTER;
        CREATE $audit CONTENT { task: $task_ref, actor: $actor_ref, action: 'disposition_taken_over',
          evidence: $evidence, at: time::now() };
        -- AC04/QA D9：被替换持有人的通知与接手**同事务**落库（同一 notice_key 的存在性检查保证只投递一次）。
        -- 事务之后再写通知的话，在「接手已提交、通知未写」之间崩溃就会让一次撤租对持有人永远不可见。
        IF $notice_holder != NONE {
          LET $n = SELECT * FROM ONLY $notice_id;
          IF $n = NONE {
            CREATE $notice_id CONTENT { notice_key: $notice_key, episode: $episode, task: $task_ref,
              holder: $notice_holder, kind: 'claim_taken_over', text: $notice_text, payload: $notice_payload,
              created_at: time::now(), delivered_at: NONE, deliveries: 0, last_attempt_at: NONE, last_error: NONE };
          };
        };
        RETURN $updated;
        COMMIT;`, { ...this.claimVars(input, episode, d, actor, token, leaseSeconds, holder),
        now: await this.now(), seen: input.expectedEpisodeVersion,
        // 通知的收件人用 undefined（绑定成 NONE）而不是 null：`holder` 字段是 TYPE string，NULL 会被拒。
        notice_holder: holder, notice_id: this.noticeId(takeoverNoticeKey), notice_key: takeoverNoticeKey,
        notice_text: `老板处置租约已被 ${actor.employeeId} 受控接手（原因：${input.reason}）`,
        notice_payload: { takenOverBy: actor.employeeId, episodeVersion: takenOverVersion + 1 } });
      if (taken) {
        return { outcome: 'taken_over', claim: this.claimView(taken, actor.employeeId, true), previousHolder: holder };
      }
      const after = await this.db.select<Row>(d);
      if (after && after.status === 'decided') return { outcome: 'already_handled', claim: this.claimView(after, actor.employeeId, false), decision: this.decisionOf(after) };
      throw new CompanyError('conflict', 'Disposition claim moved; re-read the episode and retry');
    }
    return { outcome: 'held_by_other', claim: this.claimView(row, actor.employeeId, false) };
  }

  private claimVars(input: DispositionClaimInput, episode: string, d: RecordId, actor: { employeeId: string; role: string },
    token: string, leaseSeconds: number, previous?: string): Record<string, unknown> {
    return {
      d, episode, task_ref: id('task', input.taskId), phase: requirePhase(input.phase), since: input.sinceMs,
      me: actor.employeeId, role: actor.role, d_token: token, expires: Math.floor(Date.now() / 1000) + leaseSeconds,
      previous, actor_ref: id('employee', actor.employeeId),
      audit: id('audit', randomUUID()),
      evidence: JSON.stringify({ episode, holder: actor.employeeId, role: actor.role, reason: input.reason, phase: input.phase }),
    };
  }

  /** 持有人主动撤租：episode 立刻回到可领取（不必等租约到期），并通知自己以外的观察者。 */
  async release(actor: { employeeId: string }, input: { taskId: string; phase: DispositionPhase; sinceMs: number; claimToken: string; reason: string }): Promise<DispositionClaimView> {
    const phase = requirePhase(input.phase);
    const episode = dispositionEpisodeKey(input.taskId, phase, input.sinceMs);
    const d = this.claimId(episode);
    const row = await this.run<Row>(`BEGIN;
      LET $c = SELECT * FROM ONLY $d;
      IF $c = NONE { THROW 'disposition claim missing' };
      IF $c.status = 'decided' { THROW 'disposition already handled' };
      IF $c.token != $d_token OR $c.holder != $me { THROW 'disposition claim held by another' };
      LET $updated = UPDATE ONLY $d SET holder = NONE, holder_role = NONE, lease_expires_at = NONE,
        episode_version = $c.episode_version + 1, updated_at = time::now() RETURN AFTER;
      CREATE $audit CONTENT { task: $task_ref, actor: $actor_ref, action: 'disposition_released',
        evidence: $evidence, at: time::now() };
      RETURN $updated;
      COMMIT;`, { d, d_token: input.claimToken, me: actor.employeeId, task_ref: id('task', input.taskId),
      audit: id('audit', randomUUID()),
      actor_ref: id('employee', actor.employeeId),
      evidence: JSON.stringify({ episode, holder: actor.employeeId, reason: input.reason }) });
    if (!row) throw new CompanyError('conflict', 'Disposition claim disappeared during release');
    // AC04：撤租也要有通知（claim_revoked），否则解除认领对任何人都不可见。收件人是**任务**的当前持有人——
    // outbox 的其它通知也都发给他，而这个变化改的正是他的任务视图；撤租者本人不需要通知自己。
    const taskRow = await this.db.select<Row>(id('task', input.taskId));
    const taskHolder = text(taskRow?.current_employee);
    const releasedVersion = num(row.episode_version);
    if (taskHolder && taskHolder !== actor.employeeId && releasedVersion !== undefined) {
      await this.noticeOrRecordFailure({
        episode, taskId: input.taskId, holder: taskHolder, kind: 'claim_revoked', version: releasedVersion,
        text: `${actor.employeeId} 已撤回对该阻塞 episode 的处置认领（原因：${input.reason}），episode 重新可被认领`,
        payload: { releasedBy: actor.employeeId, episodeVersion: releasedVersion },
      }, 'release_disposition');
    }
    return this.claimView(row, actor.employeeId, true);
  }

  // ---------------------------------------------------------------- 决定

  /**
   * 原子决定：占位（业务幂等键 + claim CAS + 任务版本 CAS）→ 走既有状态机 → 回执。
   * 失败点全在两侧：占位前崩溃什么也没发生；占位后崩溃，重放读到同一条 requested 记录并继续，
   * 状态机一侧由 idempotencyKey / repairKey 保证只落一次。
   */
  async decide(actor: { employeeId: string; role: string }, input: DispositionDecideInput, applier: DispositionApplier): Promise<DispositionDecideOutcome> {
    const phase = requirePhase(input.phase);
    const action = requireAction(input.action);
    requireText(input.taskId, 'taskId', 1, 200);
    requireText(input.claimToken, 'claimToken', 8, 200);
    if (!Number.isSafeInteger(input.episodeVersion) || input.episodeVersion < 1) throw new CompanyError('invalid', 'Invalid episodeVersion');
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) throw new CompanyError('invalid', 'Invalid expectedVersion');
    requireText(input.text, 'text', 4, 8000);
    requireText(input.idempotencyKey, 'idempotencyKey', 8, 200);
    const dependencies = action === 'defer' || action === 'dependency' ? [...new Set(input.dependencies ?? [])] : [];
    if ((action === 'defer' || action === 'dependency') && dependencies.length === 0) {
      throw new CompanyError('invalid', 'dependency/defer requires at least one dependency');
    }
    if (action === 'repair' && !input.repair) throw new CompanyError('invalid', 'repair requires the repair task content');
    if (action === 'repair') {
      requireText(input.repair!.title, 'repair.title', 3, 200);
      requireText(input.repair!.context, 'repair.context', 1, 20_000);
      // 修复链不能依赖它要修复的任务：原任务在本决定里改为等待修复链，反向依赖就是死锁。
      if ((input.repair!.dependencies ?? []).includes(input.taskId)) {
        throw new CompanyError('invalid', 'A repair chain cannot depend on the task it repairs');
      }
    }
    const episode = dispositionEpisodeKey(input.taskId, phase, input.sinceMs);
    const businessKey = dispositionBusinessKey(episode, action, input.businessKey);
    // 幂等摘要沿用历史的键名 expectedTaskVersion：已经按上一版落库的在飞 disposition_action 记录重放时
    // 摘要必须逐位相同，否则同一个业务操作会被判成「换了入参」而 conflict。改的只是入参字段名。
    const payload = {
      taskId: input.taskId, phase, sinceMs: input.sinceMs, action,
      expectedTaskVersion: input.expectedVersion, text: input.text,
      dependencies: [...dependencies].sort(), repair: input.repair ?? null,
    };
    const digest = HASH(JSON.stringify(payload));

    const prior = await this.db.select<Row>(this.actionId(businessKey));
    if (prior) {
      if (text(prior.payload_digest) !== digest) throw new CompanyError('conflict', 'Idempotency key reused with different input');
      // QA D1：重放与在飞答复都只对**当前认领的持有人**开放，而且要用它自己的 token。上一版这里只比业务键摘要，
      // 于是任何拿到泄露/过期 token 的员工都能读到别人的决定，还会得到 replayed 的「成功」答复。
      await this.assertReplayHolder(episode, actor, input.claimToken);
      if (prior.state === 'confirmed') return this.decideReplay(prior);
      // 同一业务键下未完成的处置：只有当前有效认领的持有人能接着做（原持有人，或租约失效后受控接手的新持有人）。
      // 接手者继续的是同一条 disposition_action，所以换员工 ID 不会建出第二条修复链、第二个决定。
      const claim = await this.db.select<Row>(this.claimId(episode));
      const live = Boolean(claim) && text(claim!.status) !== 'decided' && text(claim!.holder) === actor.employeeId
        && text(claim!.token) === input.claimToken && (num(claim!.lease_expires_at) ?? 0) > (await this.now());
      // 收件人取占位事务落下的快照（QA D8）：重放时任务可能已经被状态机改写（resume 会换掉 current_employee），
      // 现在重读任务读到的已经不是当初的持有人了。
      if (live) return this.applyAndConfirm(actor, input, applier, businessKey, episode, text(prior.holder_before) || undefined);
      return { outcome: 'in_progress', decision: await this.pendingDecision(prior) };
    }

    const claim = await this.db.select<Row>(this.claimId(episode));
    if (!claim) throw new CompanyError('conflict', 'No disposition claim for this episode; claim it first');
    if (claim.status === 'decided') {
      throw new CompanyError('conflict', 'Disposition already handled for this episode', false, this.decisionOf(claim));
    }

    const task = await this.db.select<Row>(id('task', input.taskId));
    if (!task) throw new CompanyError('not_found', 'Task not found');
    // 通知收件人的基准：状态机跑起来之前任务的持有人。占位事务里还会把这个值（与任务版本同一个事务）写进记录，
    // 供重放/接手用；这里这一份是本次调用自己用的，和上一版一样在状态机改写 current_employee 之前读到。
    const holderAtRequest = text(task.current_employee) || undefined;

    const reserved = await this.run<Row>(`BEGIN;
      LET $c = SELECT * FROM ONLY $claim;
      IF $c = NONE { THROW 'disposition claim missing' };
      IF $c.status = 'decided' { THROW 'disposition already handled' };
      IF $c.token != $d_token OR $c.holder != $me { THROW 'disposition claim held by another' };
      IF $c.episode_version != $episode_version { THROW 'disposition claim moved' };
      IF $c.lease_expires_at <= $now { THROW 'disposition claim lease expired' };
      LET $t = SELECT * FROM ONLY $task;
      IF $t = NONE { THROW 'task not found' };
      IF $t.version != $expected { THROW 'task version moved' };
      IF $action != 'repair' AND ($t.state != 'blocked') { THROW 'disposition episode not open' };
      CREATE ONLY $a CONTENT { business_key: $business_key, episode: $episode, task: $task, phase: $phase,
        action: $action, state: 'requested', payload_digest: $digest, request_token: $d_token,
        episode_version: $episode_version, requested_by: $me, attempts: 1,
        -- QA D8：请求时任务的持有人快照。它在状态机改写 current_employee **之前**读到（紧邻这次占位的一次任务读取，
        -- 而事务用 $t.version 做 CAS，所以快照对应的正是被占位的那个任务版本），重放/接手时用它当通知收件人。
        -- 绑 NONE 而不是 NULL：字段是 option<string>，NULL 会被拒绝（任务可能本来就没有持有人）。
        holder_before: $holder_before,
        task_version_before: $t.version, task_version_after: NONE, result: NONE, repair_task: NONE,
        created_at: time::now(), confirmed_at: NONE };
      CREATE $audit CONTENT { task: $task, actor: $me_ref, action: 'disposition_requested',
        evidence: $evidence, version: $t.version, at: time::now() };
      LET $sequence = UPDATE ONLY company_meta:outbox_counter SET value += 1 RETURN AFTER;
      CREATE $outbox CONTENT { task: $task, kind: 'disposition_requested', sequence: $sequence.value,
        payload: { episode: $episode, action: $action, business_key: $business_key }, at: time::now() };
      RETURN $a;
      COMMIT;`, {
      claim: this.claimId(episode), task: id('task', input.taskId), a: this.actionId(businessKey),
      d_token: input.claimToken, me: actor.employeeId, me_ref: id('employee', actor.employeeId),
      episode_version: input.episodeVersion, now: await this.now(), expected: input.expectedVersion,
      holder_before: holderAtRequest,
      action, business_key: businessKey, episode, phase, digest,
      audit: id('audit', randomUUID()), outbox: id('outbox', randomUUID()),
      evidence: JSON.stringify({ episode, action, businessKey, expectedTaskVersion: input.expectedVersion, claimToken: input.claimToken }),
    }).catch(async error => {
      // 并发对手已经占了同一个业务键（或服务器以准入冲突拒绝了这次写入但对手已经建行）：读它，
      // 决定是重放还是在飞；确实什么都没写才把错误抛回去。
      const raced = await this.db.select<Row>(this.actionId(businessKey));
      if (!raced) throw error;
      if (text(raced.payload_digest) === digest) {
        // 同一条业务操作只有当前持有人能读（QA D1）：并发里拿到别人 token 的调用在这里就被拒绝，而不是收到 replayed。
        await this.assertReplayHolder(episode, actor, input.claimToken);
        if (raced.state === 'confirmed') return this.decideReplay(raced);
      }
      return undefined;
    });
    if (!reserved) {
      const raced = await this.db.select<Row>(this.actionId(businessKey));
      if (raced && text(raced.payload_digest) === digest) {
        await this.assertReplayHolder(episode, actor, input.claimToken);
        if (raced.state === 'confirmed') return this.decideReplay(raced);
      }
      return { outcome: 'in_progress', decision: raced ? await this.pendingDecision(raced) : undefined };
    }
    // 收件人优先取占位事务里与任务版本同一个事务读到的快照（QA D8）；事务的返回值在并发分支下是结论而不是行，
    // 那时退回本次调用在状态机之前读到的那一份。
    const holderBefore = reserved !== undefined && 'holder_before' in reserved
      ? text(reserved.holder_before) || holderAtRequest : holderAtRequest;
    return this.applyAndConfirm(actor, { ...input, dependencies }, applier, businessKey, episode, holderBefore);
  }

  private async applyAndConfirm(actor: { employeeId: string; role: string }, input: DispositionDecideInput,
    applier: DispositionApplier, businessKey: string, episode: string, holderBefore?: string): Promise<DispositionDecideOutcome> {
    const action = requireAction(input.action);
    const idempotencyKey = `disposition:${businessKey}`;
    // 并发兄弟调用抢先把同一条处置确认掉时，这一路的两种收场都不是调用方的失败：确认事务可能 THROW
    // 'disposition already handled'，状态机一侧也可能因为对手已经推进了任务版本而 CAS 失败。同一条业务操作
    // 确实被做掉了，正确的答复是那份回执（QA B1：二十条并发决定里，持有人一侧必须条条可读）。
    // 只有记录仍然是 requested（没有兄弟赢）时，才把原来的错误如实抛出去。
    const recoverFromSibling = async (error: unknown): Promise<DispositionDecideOutcome> => {
      // 兄弟可能还在飞（它已经把这条业务操作做掉了，回执还在路上）：占位记录仍是 requested 时等一小会儿再看，
      // 短则几毫秒。等不到就说明确实没有兄弟成功，把原来的错误如实抛出去。
      for (let attempt = 0; attempt < 8; attempt++) {
        const raced = await this.db.select<Row>(this.actionId(businessKey));
        if (raced && text(raced.state) === 'confirmed') {
          await this.assertReplayHolder(episode, actor, input.claimToken);
          return this.decideReplay(raced);
        }
        if (!raced || text(raced.state) !== 'requested') break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw error;
    };
    let result: { taskVersion: number; state: string } | undefined;
    let repairTaskId: string | undefined;
    try {
      if (action === 'resume') {
        result = await applier.resume({ taskId: input.taskId, text: input.text, idempotencyKey });
      } else if (action === 'defer' || action === 'dependency') {
        result = await applier.defer({ taskId: input.taskId, text: input.text, dependencies: [...new Set(input.dependencies ?? [])],
          expectedTaskVersion: input.expectedVersion, idempotencyKey });
      } else if (action === 'retire') {
        result = await applier.retire({ taskId: input.taskId, text: input.text, expectedTaskVersion: input.expectedVersion, idempotencyKey });
      } else {
        const repaired = await applier.repair({ repairKey: businessKey, taskId: input.taskId, text: input.text,
          expectedTaskVersion: input.expectedVersion, repair: input.repair! });
        repairTaskId = repaired.taskId;
        const row = await this.db.select<Row>(id('task', input.taskId));
        result = { taskVersion: repaired.sourceTaskVersion ?? num(row?.version) ?? input.expectedVersion,
          state: repaired.sourceState ?? (text(row?.state) || 'blocked') };
      }
    } catch (error) {
      return await recoverFromSibling(error);
    }
    const holder = holderBefore ?? (text((await this.db.select<Row>(id('task', input.taskId)))?.current_employee) || undefined);
    const noticeKind = noticeKindFor(action);
    let confirmed: Row | undefined;
    try {
      confirmed = await this.run<Row>(`BEGIN;
      LET $c = SELECT * FROM ONLY $claim;
      IF $c = NONE { THROW 'disposition claim missing' };
      IF $c.status = 'decided' { THROW 'disposition already handled' };
      IF $c.token != $d_token OR $c.holder != $me { THROW 'disposition claim held by another' };
      IF $c.lease_expires_at <= $now { THROW 'disposition claim lease expired' };
      LET $a = UPDATE ONLY $action_row SET state = 'confirmed', task_version_after = $after,
        result = $result, repair_task = $repair_task, request_token = $d_token, confirmed_at = time::now()
        WHERE state = 'requested' RETURN AFTER;
      IF $a = NONE { THROW 'disposition action moved' };
      UPDATE ONLY $claim SET status = 'decided', decision_action = $action, decision_business_key = $business_key,
        decision_actor = $me, decision_at = time::now(), decision_task_version = $after,
        decision_result = $result, episode_version = $c.episode_version + 1, updated_at = time::now();
      UPDATE dispatch SET status = 'closed', closed_at = time::now(), resolution = $resolution
        WHERE purpose = 'gm-manager-action' AND task = $task_id AND status = 'open' AND phase = $phase AND episode = $episode_ms;
      UPDATE dispatch SET state = 'finished', resolution = $resolution, updated_at = time::unix(time::now())
        WHERE purpose = 'gm-manager-wake' AND task = $task_id AND phase = $phase AND episode = $episode_ms
          AND state IN ['pending', 'running', 'unknown'];
      CREATE $audit CONTENT { task: $task, actor: $me_ref, action: 'disposition_decided', evidence: $evidence,
        version: $after, at: time::now() };
      LET $sequence = UPDATE ONLY company_meta:outbox_counter SET value += 1 RETURN AFTER;
      CREATE $outbox CONTENT { task: $task, kind: 'disposition_decided', sequence: $sequence.value,
        payload: { episode: $episode, action: $action, business_key: $business_key, holder: $holder }, at: time::now() };
      -- AC04：持有人通知与决定同事务落库。分成两步写过的话，在这两步之间崩溃就会让一个已经确认的处置
      -- 永远不发通知（QA V3）；同一个 notice_key 的重复写入在这里被存在性检查挡掉，所以重放也不会重复投递。
      IF $notice_holder != NONE {
        LET $n1 = SELECT * FROM ONLY $notice_1;
        IF $n1 = NONE {
          CREATE $notice_1 CONTENT { notice_key: $notice_key_1, episode: $episode, task: $task, holder: $notice_holder,
            kind: $nkind_1, text: $ntext_1, payload: $npayload_1, created_at: time::now(), delivered_at: NONE,
            deliveries: 0, last_attempt_at: NONE, last_error: NONE };
        };
        IF $nkind_2 != NONE {
          LET $n2 = SELECT * FROM ONLY $notice_2;
          IF $n2 = NONE {
            CREATE $notice_2 CONTENT { notice_key: $notice_key_2, episode: $episode, task: $task, holder: $notice_holder,
              kind: $nkind_2, text: $ntext_2, payload: $npayload_2, created_at: time::now(), delivered_at: NONE,
              deliveries: 0, last_attempt_at: NONE, last_error: NONE };
          };
        };
      };
      RETURN $a;
      COMMIT;`, {
      action_row: this.actionId(businessKey), claim: this.claimId(episode), task: id('task', input.taskId),
      task_id: input.taskId, phase: requirePhase(input.phase), d_token: input.claimToken, now: await this.now(), after: result.taskVersion,
      episode_ms: input.sinceMs,
      result: { state: result.state, taskVersion: result.taskVersion, repairTaskId: repairTaskId ?? null },
      repair_task: repairTaskId ? id('task', repairTaskId) : undefined, me: actor.employeeId,
      me_ref: id('employee', actor.employeeId), action, business_key: businessKey, episode,
      holder: holder ?? null, resolution: `disposition:${action}`,
      audit: id('audit', randomUUID()), outbox: id('outbox', randomUUID()),
      notice_1: this.noticeId(dispositionNoticeKey(episode, noticeKind, result.taskVersion)),
      notice_key_1: dispositionNoticeKey(episode, noticeKind, result.taskVersion),
      nkind_1: noticeKind,
      // 通知的收件人用 undefined（绑定成 NONE）而不是 null：`holder` 字段是 TYPE string，NULL 会被拒。
      notice_holder: holder,
      ntext_1: `${action === 'dependency' ? 'defer' : action} 处置已生效：${input.text.slice(0, 400)}`,
      npayload_1: { action, businessKey, state: result.state, taskVersion: result.taskVersion, repairTaskId: repairTaskId ?? null },
      notice_2: this.noticeId(dispositionNoticeKey(episode, 'dependency_wait', result.taskVersion)),
      notice_key_2: dispositionNoticeKey(episode, 'dependency_wait', result.taskVersion),
      nkind_2: action === 'repair' && repairTaskId ? 'dependency_wait' : undefined,
      ntext_2: `已按处置建单修复链：${input.repair?.title ?? ''}`,
      npayload_2: { repairTaskId: repairTaskId ?? null, businessKey },
      evidence: JSON.stringify({ episode, action, businessKey, taskVersion: result.taskVersion, repairTaskId, holder }),
    });
    } catch (error) {
      // 确认事务被并发的同一处置抢先（'disposition already handled' / 'disposition action moved'）：状态机那一侧已经
      // 由对手完成，把它的回执读回来交给调用方，而不是把并发当成持有人的失败（QA B1）。
      return await recoverFromSibling(error);
    }
    if (!confirmed) {
      // 回执被并发的同一处置抢先落库：读它，而不是让调用方以为失败。状态机一侧本身就是幂等的。
      const raced = await this.db.select<Row>(this.actionId(businessKey));
      if (raced && text(raced.state) === 'confirmed') {
        await this.assertReplayHolder(episode, actor, input.claimToken);
        return this.decideReplay(raced);
      }
      throw new CompanyError('conflict', 'Disposition decision was overtaken before it could be recorded');
    }
    return { outcome: 'decided', decision: { action, businessKey, actor: actor.employeeId, at: new Date().toISOString(),
      taskVersion: result.taskVersion, result: { state: result.state }, repairTaskId }, repairTaskId };
  }

  /**
   * QA D1（AC02/AC05）：一条业务操作的重放/在飞答复只对**当前认领的持有人**开放，并且它必须交出自己那个 token。
   * 认领已被释放（holder = NONE）、已被别人接手、或交出的是泄露/过期的 token，一律 forbidden——重放读的是别人那次
   * 决定的内容，而「replayed」这个答复本身就是在说这条决定属于你。持有人的 token 在决定之后并不清空，所以同一持有人
   * 的重复请求仍然读到同一份回执。
   */
  private async assertReplayHolder(episode: string, actor: { employeeId: string }, claimToken: string): Promise<void> {
    const claim = await this.db.select<Row>(this.claimId(episode));
    const holder = text(claim?.holder);
    if (!claim || !holder || holder !== actor.employeeId || !claimToken || text(claim.token) !== claimToken) {
      // 只说「谁持有、谁在问」，不回显 token 本身。
      throw new CompanyError('forbidden',
        `Replaying a disposition requires the current claim holder with its own claim token (episode ${episode} is held by ${holder || 'nobody'}; ${actor.employeeId} asked)`);
    }
  }

  private async decideReplay(row: Row): Promise<DispositionDecideOutcome> {
    const result = (row.result ?? {}) as Record<string, unknown>;
    // 补发（AC04）：上一版把通知写在确认事务之后，所以历史行可能已经确认却没有通知；重放这条决定时按同一
    // notice_key 补一次。notice 本身按 noticeKey 去重，补发不会造成第二次投递。
    await this.backfillDecisionNotices(row, result).catch(() => undefined);
    return {
      outcome: 'replayed',
      decision: {
        action: text(row.action), businessKey: text(row.business_key), actor: text(row.requested_by) || undefined,
        at: row.confirmed_at === undefined ? undefined : String(row.confirmed_at),
        taskVersion: num(row.task_version_after), result,
        repairTaskId: text(result.repairTaskId) || undefined,
      },
      task: result,
      repairTaskId: text(result.repairTaskId) || undefined,
    };
  }

  /**
   * AC04 补发：上一版把持有人通知写在确认事务**之后**，所以历史行可能已经确认却没有通知。按同一 notice_key 再写
   * 一次是幂等的（不存在才建），因此重放一条决定既不会重复投递，也能把缺口补上。
   * QA D8：收件人是**请求这条决定时**任务的持有人——占位时（状态机改写 current_employee 之前）落下的 holder_before
   * 快照；claim.holder 只是历史行的兜底，因为决定之后状态机可能已经换掉了任务持有人，那时读 claim 得到的是另一个人。
   */
  private async backfillDecisionNotices(row: Row, result: Record<string, unknown>): Promise<void> {
    const episode = text(row.episode);
    const taskId = asId(row.task);
    const version = num(row.task_version_after);
    if (!episode || !taskId || version === undefined) return;
    const claim = await this.db.select<Row>(this.claimId(episode));
    const holder = text(row.holder_before) || text(claim?.holder);
    if (!holder) return;
    const action = requireAction(text(row.action));
    const repairTaskId = text(result.repairTaskId) || undefined;
    const base = { episode, taskId, holder, version };
    await this.notice({ ...base, kind: noticeKindFor(action),
      text: `${action === 'dependency' ? 'defer' : action} 处置已生效（补发）`,
      payload: { action, state: result.state, taskVersion: version, repairTaskId: repairTaskId ?? null, backfill: true } });
    if (action === 'repair' && repairTaskId) {
      await this.notice({ ...base, kind: 'dependency_wait', text: '已按处置建单修复链（补发）',
        payload: { repairTaskId, backfill: true } });
    }
  }

  /** 在飞的处置：给调用方一个「结果未知，按同一幂等键重试」的可读快照，而不是另起一项处置。 */
  private async pendingDecision(row: Row): Promise<DispositionDecisionView> {
    return {
      action: text(row.action), businessKey: text(row.business_key), actor: text(row.requested_by) || undefined,
      at: row.created_at === undefined ? undefined : String(row.created_at), taskVersion: num(row.task_version_before),
      result: { pending: true, state: text(row.state) },
    };
  }

  // ---------------------------------------------------------------- 只读

  async status(actor: { employeeId: string; role: string }, input: DispositionStatusInput): Promise<DispositionStatusView> {
    requireText(input.taskId, 'taskId', 1, 200);
    const [rows] = await this.db.query<[Row[]]>(
      'SELECT * FROM disposition_claim WHERE task = $task ORDER BY episode_since DESC LIMIT 50;', { task: id('task', input.taskId) });
    const own = actor.role === 'owner';
    const episodes = (rows ?? [])
      .filter(row => input.phase === undefined || text(row.phase) === input.phase)
      .filter(row => input.sinceMs === undefined || num(row.episode_since) === input.sinceMs)
      .map(row => this.claimView(row, actor.employeeId, own && text(row.holder) === actor.employeeId));
    const task = await this.db.select<Row>(id('task', input.taskId));
    const openEpisode = Boolean(task && text(task.state) === 'blocked' && task.dispatch_blocked_phase);
    const [counts] = await this.db.query<[Array<{ n: number }>]>(
      'SELECT count() AS n FROM holder_notice WHERE task = $task AND delivered_at = NONE GROUP ALL;', { task: id('task', input.taskId) });
    return {
      taskId: input.taskId,
      claim: episodes[0],
      episodes,
      openEpisode,
      holder: task ? text(task.current_employee) || undefined : undefined,
      undeliveredNotices: counts?.[0]?.n ?? 0,
    };
  }

  /** 调度器守卫：这个 episode 还该不该拉起新老板会话。只读。 */
  private claimView(row: Row, viewer: string, includeToken: boolean): DispositionClaimView {
    const holder = text(row.holder) || undefined;
    return {
      episode: text(row.episode),
      taskId: asId(row.task),
      phase: text(row.phase) === 'review' ? 'review' : 'execute',
      episodeSince: num(row.episode_since) ?? 0,
      episodeVersion: num(row.episode_version) ?? 1,
      status: text(row.status) === 'decided' ? 'decided' : 'claimed',
      holder,
      holderRole: text(row.holder_role) || undefined,
      leaseExpiresAt: num(row.lease_expires_at),
      takenOverFrom: text(row.taken_over_from) || undefined,
      token: includeToken && holder === viewer ? text(row.token) || undefined : undefined,
      decision: this.decisionOf(row),
    };
  }

  private decisionOf(row: Row): DispositionDecisionView | undefined {
    if (text(row.status) !== 'decided') return undefined;
    const result = (row.decision_result ?? undefined) as Record<string, unknown> | undefined;
    return {
      action: text(row.decision_action),
      businessKey: text(row.decision_business_key) || undefined,
      actor: text(row.decision_actor) || undefined,
      at: row.decision_at === undefined ? undefined : String(row.decision_at),
      taskVersion: num(row.decision_task_version),
      result,
      repairTaskId: text(result?.repairTaskId) || undefined,
    };
  }

  // ---------------------------------------------------------------- 通知

  async notice(input: { episode: string; taskId: string; holder: string; kind: DispositionNoticeKind; version: number;
    text: string; payload?: Record<string, unknown> }): Promise<HolderNoticeView | undefined> {
    const noticeKey = dispositionNoticeKey(input.episode, input.kind, input.version);
    const d = this.noticeId(noticeKey);
    const created = await this.run<Row>(`BEGIN;
      LET $n = CREATE ONLY $d CONTENT { notice_key: $notice_key, episode: $episode, task: $task, holder: $holder,
        kind: $kind, text: $text, payload: $payload, created_at: time::now(), delivered_at: NONE, deliveries: 0,
        last_attempt_at: NONE, last_error: NONE };
      RETURN $n;
      COMMIT;`, { d, notice_key: noticeKey, episode: input.episode, task: id('task', input.taskId), holder: input.holder,
      kind: input.kind, text: input.text, payload: input.payload ?? {} }).catch(error => {
      if (/already exists|duplicate/i.test(String((error as Error).message))) return undefined;
      throw error;
    });
    if (!created) return undefined;
    return this.noticeView(created);
  }

  /**
   * AC04：通知写失败绝不能回滚已经确认的状态变化，但也绝不能无声丢弃。失败时落一条审计行，让账本留下
   * 「这次变化本该通知谁、为什么没通知出去」，而不是在内存里 catch 掉了事（QA V3）。
   */
  private async noticeOrRecordFailure(input: { episode: string; taskId: string; holder: string; kind: DispositionNoticeKind;
    version: number; text: string; payload?: Record<string, unknown> }, note: string): Promise<HolderNoticeView | undefined> {
    try {
      return await this.notice(input);
    } catch (error) {
      const message = String((error as Error)?.message ?? error);
      const evidence = JSON.stringify({ noticeKind: input.kind,
        noticeKey: dispositionNoticeKey(input.episode, input.kind, input.version), holder: input.holder, note, error: message });
      await this.run(`BEGIN;
        CREATE $audit CONTENT { task: $task, actor: $me_ref, action: 'disposition_notice_failed',
          evidence: $evidence, at: time::now() };
        COMMIT;`, { audit: id('audit', randomUUID()), task: input.taskId ? id('task', input.taskId) : undefined,
        me_ref: id('employee', input.holder), evidence }).catch(() => undefined);
      return undefined;
    }
  }

  /** 未投递的通知（调度器每轮补发；插件重启/通道重连后同样从这里恢复）。 */
  async pendingNotices(limit = 50): Promise<HolderNoticeView[]> {
    const [rows] = await this.db.query<[Row[]]>(
      'SELECT * FROM holder_notice WHERE delivered_at = NONE ORDER BY created_at, notice_key LIMIT $limit;', { limit });
    return (rows ?? []).map(row => this.noticeView(row));
  }

  /** 一个员工自己的未投递通知（员工工具入口；不暴露别人的通知）。 */
  async noticesFor(employeeId: string, limit = 50): Promise<HolderNoticeView[]> {
    const [rows] = await this.db.query<[Row[]]>(
      'SELECT * FROM holder_notice WHERE holder = $holder AND delivered_at = NONE ORDER BY created_at, notice_key LIMIT $limit;',
      { holder: employeeId, limit });
    return (rows ?? []).map(row => this.noticeView(row));
  }

  /** 一个员工自己的通知（含已送达），只按 noticeKey 取：回执的归属校验用。已送达的通知被再次回执时，仍要能认出是本人的。 */
  async noticesByKey(employeeId: string, noticeKeys: string[]): Promise<HolderNoticeView[]> {
    const [rows] = await this.db.query<[Row[]]>(
      'SELECT * FROM holder_notice WHERE holder = $holder AND notice_key IN $keys;', { holder: employeeId, keys: noticeKeys });
    return (rows ?? []).map(row => this.noticeView(row));
  }

  /** 投递回执：失败只记 last_error / attempts，绝不回滚已经确认的审计或决定，也不把通知从待发队列里丢掉。 */
  async markNotices(ids: string[], outcome: { agent?: string; error?: string }): Promise<number> {
    let updated = 0;
    for (const noticeKey of ids) {
      const [row] = await this.db.query<[Row | undefined]>(`UPDATE ONLY $d SET deliveries = deliveries + 1,
        delivered_at = IF $error = NONE THEN time::now() ELSE delivered_at END,
        last_attempt_at = time::now(), last_error = $error RETURN AFTER;`,
      { d: this.noticeId(noticeKey), error: outcome.error });
      if (row) updated++;
    }
    return updated;
  }

  private noticeView(row: Row): HolderNoticeView {
    return {
      id: text(row.notice_key),
      noticeKey: text(row.notice_key),
      episode: text(row.episode),
      taskId: asId(row.task),
      holder: text(row.holder),
      kind: text(row.kind) as DispositionNoticeKind,
      text: text(row.text),
      payload: (row.payload ?? {}) as Record<string, unknown>,
      createdAt: row.created_at === undefined ? undefined : String(row.created_at),
      deliveredAt: row.delivered_at === undefined ? undefined : String(row.delivered_at),
      deliveries: num(row.deliveries) ?? 0,
      lastError: text(row.last_error) || undefined,
    };
  }

  // ---------------------------------------------------------------- 受控外部动作

  /**
   * 发起受控外部动作。三态：requested（占位，含前置任务版本与真实内部员工 ID）→ 网关返回确定结果则
   * confirmed；网关异常/不可判定则 result_unknown（按同一 actionKey 重试幂等，不会重复发起真实动作）。
   */
  async requestExternalAction(actor: { employeeId: string; role: string }, input: ExternalActionRequestInput,
    gateway: ExternalActionGateway,
    /** 授权关口把「它拿什么把这条 run 绑到前置任务上」交回来（QA D5），账本把它写进审计证据。 */
    authorize: (task: { taskId: string; version: number } | undefined, target: ExternalActionTarget,
      replay: boolean) => Promise<{ binding: ExternalActionBinding }>): Promise<ExternalActionView> {
    if (input.kind !== 'ci-run-cancel') throw new CompanyError('invalid', 'Invalid external action kind');
    requireText(input.repo, 'repo', 1, 200);
    requireText(input.runId, 'runId', 1, 100);
    // repo 与 runId 会被拼进 `gh api` 的请求路径，所以它们必须是 GitHub 的 owner/name 与十进制运行号，
    // 否则调用方能自己写路径（QA P4）。
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repo)) {
      throw new CompanyError('invalid', 'repo must be a GitHub owner/name slug');
    }
    if (!/^[0-9]{1,20}$/.test(input.runId)) throw new CompanyError('invalid', 'runId must be a decimal run number');
    requireText(input.reason, 'reason', 8, 2000);
    requireText(input.actionKey, 'actionKey', 8, 200);
    // 受控外部动作必须绑定它当时读到的任务与版本：记录里不能缺这一格，否则重放与事后归因都没有基准。
    if (input.prerequisiteTaskId === undefined) {
      throw new CompanyError('invalid', 'A controlled external action must name the prerequisite task and the version it was based on');
    }
    let prerequisiteVersion: number | undefined;
    let taskRow: Row | undefined;
    if (input.prerequisiteTaskId !== undefined) {
      requireText(input.prerequisiteTaskId, 'prerequisiteTaskId', 1, 200);
      if (!Number.isSafeInteger(input.prerequisiteVersion)) throw new CompanyError('invalid', 'prerequisiteVersion is required with prerequisiteTaskId');
      taskRow = await this.db.select<Row>(id('task', input.prerequisiteTaskId));
      if (!taskRow) throw new CompanyError('not_found', 'Prerequisite task not found');
      prerequisiteVersion = num(taskRow.version);
      if (prerequisiteVersion !== input.prerequisiteVersion) throw new CompanyError('conflict', 'Prerequisite task version moved');
    }
    const target: ExternalActionTarget = { provider: 'github', repo: input.repo, runId: input.runId };
    const key = this.externalId(input.actionKey);
    const existing = await this.db.select<Row>(key);
    // QA D2：一个 actionKey 只配同一个目标。上一版在 confirmed/refused 之后就直接把旧记录返回，于是「拿同一个 key
    // 去取消另一条 run」会读到旧 run 的结果、而被指向的那条 run 根本没被取消过——幂等的前提是目标真的相同。
    if (existing) {
      const recorded = (existing.target ?? {}) as Record<string, unknown>;
      const recordedTask = existing.prerequisite_task === undefined ? undefined : asId(existing.prerequisite_task);
      if (text(recorded.repo) !== input.repo || text(recorded.runId) !== input.runId || recordedTask !== input.prerequisiteTaskId) {
        throw new CompanyError('conflict',
          `Action key ${input.actionKey} is already recorded for ${text(recorded.repo)}#${text(recorded.runId)}; cancelling another run needs its own action key`);
      }
      if (text(existing.state) === 'confirmed') return this.externalViewOf(existing);
      if (text(existing.state) === 'refused') return this.externalViewOf(existing);
    }
    // 授权关口与任务本身同源（不扩大 老板 权限）：由注入的 authorize 判定调用者是否是该前置任务的当事人，
    // 并且把目标 run 交给它去核对绑定关系（run 必须属于这个前置任务的登记分支与仓库）。target 与是否已有记录
    // 都要在判定之前算好：重放时网关需要知道「这次不是第一次请求」才能把终态读回判成 confirmed 而不是 refused。
    const binding = await authorize(input.prerequisiteTaskId === undefined ? undefined : { taskId: input.prerequisiteTaskId, version: prerequisiteVersion! },
      target, existing !== undefined);
    const evidence = JSON.stringify({ actionKey: input.actionKey, kind: input.kind, target,
      requestedBy: actor.employeeId, prerequisiteVersion, binding: binding.binding });
    let row: Row | undefined = existing;
    if (!row) {
      const created = await this.run<Row>(`BEGIN;
        LET $row = CREATE ONLY $d CONTENT { action_key: $key, kind: $kind, provider: 'github', target: $target,
          requested_by: $me, reason: $reason, prerequisite_task: $task_ref, prerequisite_version: $task_version,
          state: 'requested', attempts: 1, request_token: $d_token, attribution: 'internal_employee',
          -- QA D3：真正的 provider 出口单独占位。占位在 POST 之前原子地翻成 true，所以「重放」与「第一次请求」
          -- 不是靠记录在不在来判断，而是靠那次出口有没有真的发出去；在占位前崩溃的行仍可由下一次请求补发。
          post_claimed: false,
          external_account: NONE, confirmed_result: NONE, attribution_evidence: NONE,
          created_at: time::now(), updated_at: time::now(), reconciled_at: NONE };
        CREATE $audit CONTENT { task: $task_ref, actor: $me_ref, action: 'external_action_requested',
          evidence: $evidence, at: time::now() };
        RETURN $row;
        COMMIT;`, {
        d: key, key: input.actionKey, kind: input.kind, target: { ...target },
        me: actor.employeeId, me_ref: id('employee', actor.employeeId), reason: input.reason,
        task_ref: input.prerequisiteTaskId ? id('task', input.prerequisiteTaskId) : undefined, task_version: prerequisiteVersion,
        audit: id('audit', randomUUID()),
        d_token: randomUUID(), evidence,
      }).catch(error => {
        if (/already exists|duplicate/i.test(String((error as Error).message))) return undefined;
        throw error;
      });
      // 并发对手先建了同一条记录：读它，继续走网关，让出口占位决定谁真的发那次请求（而不是在这里直接返回，
      // 否则对手要是正好在 POST 之前崩掉，这条动作就永远没人发）。
      row = created ?? (await this.db.select<Row>(key));
    }
    if (!row) throw new CompanyError('conflict', 'External action record disappeared during the race');
    // 重放 = 这条 key 的出口**已经**被占过一次（post_claimed），与「记录在不在」无关（QA D3）。
    // 本轮之前落下的行没有这个标记（NONE）：那时每次调用都可能真的 POST 过，所以保守地当成「已经发过」——
    // 宁可如实报 unknown 等 provider 落定，也绝不对同一条 run 发第二次取消请求。
    const replay = row.post_claimed !== false;
    if (existing) {
      // 同一 actionKey 下又发了一次请求：只加 attempts，不重复占用记录（出口由 post_claimed 单独标记）。
      await this.db.query('UPDATE ONLY $d SET attempts = attempts + 1, updated_at = time::now();', { d: key });
    }
    const observed = await gateway.cancelRun(target, {
      replay,
      // 出口占位：只有把 post_claimed 从「没发过」原子翻成「发过」的那一次调用才真的 POST。并发下拿到 false 的
      // 对手一律不 POST、如实回 unknown，于是同一个 actionKey 最多只有一次取消请求到达 provider（QA D2/AC05）。
      claimRequest: async () => {
        try {
          const responses = await this.db.query<unknown[]>(`UPDATE ONLY $d SET post_claimed = true, updated_at = time::now()
            WHERE post_claimed != true RETURN AFTER;`, { d: key }).responses();
          const updated = responses.filter(response => response.success).map(response => response.result).at(-1) as Row | undefined;
          return Boolean(updated);
        } catch { return false; }
      },
    }).catch(error => ({ confirmed: false as const, error: String((error as Error)?.message ?? error) }));
    return this.settleExternalAction(actor, input, target, observed, text(row.request_token), binding.binding);
  }

  private async settleExternalAction(actor: { employeeId: string }, input: ExternalActionRequestInput, target: ExternalActionTarget,
    observed: Awaited<ReturnType<ExternalActionGateway['cancelRun']>>, requestToken: string,
    binding: ExternalActionBinding): Promise<ExternalActionView> {
    const accepted = (observed as { confirmed?: boolean }).confirmed === true
      ? observed as { confirmed: true; runStatus?: string; externalAccount?: string; observed?: Record<string, unknown> }
      : undefined;
    // A definite provider refusal (no such run, already terminal) is its own state: it must not be recorded as an
    // unknown outcome that keeps a retry alive, and it must not be recorded as a success either.
    const denied = (observed as { refused?: boolean }).refused === true ? observed as { refused: true; reason: string } : undefined;
    const state = accepted ? 'confirmed' : denied ? 'refused' : 'result_unknown';
    const outcome = accepted
      ? { runStatus: accepted.runStatus ?? null, observed: accepted.observed ?? null, binding }
      : denied
        ? { refused: denied.reason, binding }
        // 未知结果也保留网关读回的事实：G4 那种「请求已发出、run 还没落定」的重放就是靠它可读地区别于「读失败」。
        : { error: (observed as { error?: string }).error ?? 'gateway gave no definite result',
            observed: (observed as { observed?: Record<string, unknown> }).observed ?? null, binding };
    const row = await this.run<Row>(`BEGIN;
      -- 终态（confirmed / refused）一旦落库就不再被别的结果盖掉：并发里抢不到出口的那条请求回的是 unknown，
      -- 让它盖掉另一条真实确认过的取消、或者把 provider 的明确拒绝改写成成功，都是在改写已经发生的事实。
      LET $updated = UPDATE ONLY $d SET state = $state, request_token = $d_token,
        confirmed_result = $result, external_account = $account,
        updated_at = time::now()
        WHERE request_token = $d_token AND (state = $state OR state NOT IN ['confirmed', 'refused']) RETURN AFTER;
      CREATE $audit CONTENT { task: $task_ref, actor: $me_ref, action: $audit_action, evidence: $evidence, at: time::now() };
      RETURN $updated;
      COMMIT;`, {
      d: this.externalId(input.actionKey), state, d_token: requestToken,
      result: outcome,
      account: accepted ? accepted.externalAccount : undefined,
      task_ref: input.prerequisiteTaskId ? id('task', input.prerequisiteTaskId) : undefined, me_ref: id('employee', actor.employeeId),
      audit_action: state === 'confirmed' ? 'external_action_confirmed' : state === 'refused' ? 'external_action_refused' : 'external_action_result_unknown',
      audit: id('audit', randomUUID()),
      evidence: JSON.stringify({ actionKey: input.actionKey, target, state, reason: input.reason, binding }),
    });
    const view = this.externalViewOf(row ?? (await this.db.select<Row>(this.externalId(input.actionKey))) ?? {});
    // 通知按**记录里实际的**状态发：终端状态没被这次未知结果改写时，就不能为一个已经不未知的动作再发一次「结果未知」。
    if (view.state === 'result_unknown' && view.requestedBy) {
      // 结果未知也要让持有人知道：外部动作没确认前不能默默丢失。
      await this.noticeOrRecordFailure({
        episode: `external:${view.actionKey}`, taskId: input.prerequisiteTaskId ?? '', holder: view.requestedBy,
        kind: 'external_action_unknown', version: view.attempts,
        text: `外部动作（${view.kind} ${input.repo}#${input.runId}）结果未知：${String((observed as { error?: string }).error ?? '网关未给出确定结果')}`,
        payload: { actionKey: view.actionKey, repo: input.repo, runId: input.runId },
      }, 'external_action_unknown');
    }
    return view;
  }

  /**
   * 只读对账：读 provider 侧真实状态，与我们记录的动作比。**任何我们没有请求过的带外变更都写成
   * attribution = unknown_actor**，绝不把共享 GitHub 账号记成内部员工或老板。
   */
  async reconcileExternalActions(actor: { employeeId: string }, input: { runs: Array<{ repo: string; runId: string }> },
    gateway: ExternalActionGateway): Promise<{ checked: number; unknownActor: ExternalActionView[]; confirmed: ExternalActionView[]; unreadable: string[] }> {
    const unknownActor: ExternalActionView[] = [];
    const confirmed: ExternalActionView[] = [];
    const unreadable: string[] = [];
    for (const run of input.runs) {
      requireText(run.repo, 'repo', 1, 200);
      requireText(run.runId, 'runId', 1, 100);
      // 与发起路径同一口径：repo/runId 直接进 `gh api` 的请求路径，先校验形状（QA P4）。
      if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(run.repo)) throw new CompanyError('invalid', 'repo must be a GitHub owner/name slug');
      if (!/^[0-9]{1,20}$/.test(run.runId)) throw new CompanyError('invalid', 'runId must be a decimal run number');
      const target: ExternalActionTarget = { provider: 'github', repo: run.repo, runId: run.runId };
      const observed = await gateway.observeRun(target).catch(error => ({ readable: false as const, error: String((error as Error)?.message ?? error) }));
      if (observed.readable !== true) { unreadable.push(`${run.repo}#${run.runId}: ${observed.error}`); continue; }
      const key = `reconcile:${run.repo}#${run.runId}:${observed.runStatus ?? 'unknown'}:${observed.conclusion ?? 'unknown'}`;
      const existing = await this.db.select<Row>(this.externalId(key));
      if (existing) { (text(existing.attribution) === 'unknown_actor' ? unknownActor : confirmed).push(this.externalViewOf(existing)); continue; }
      const row = await this.run<Row>(`BEGIN;
        LET $row = CREATE ONLY $d CONTENT { action_key: $key, kind: 'ci-run-cancel', provider: 'github', target: $target,
          requested_by: NONE, reason: $reason, prerequisite_task: NONE, prerequisite_version: NONE,
          state: 'confirmed', attempts: 1, request_token: $d_token, attribution: 'unknown_actor',
          external_account: $account, confirmed_result: $result, attribution_evidence: NONE,
          created_at: time::now(), updated_at: time::now(), reconciled_at: time::now() };
        CREATE $audit CONTENT { actor: $me_ref, action: 'external_action_reconciled', evidence: $evidence, at: time::now() };
        RETURN $row;
        COMMIT;`, {
        d: this.externalId(key), key, target: { ...target },
        reason: `带外状态对账（未发现内部请求记录）：runStatus=${observed.runStatus ?? 'unknown'} conclusion=${observed.conclusion ?? 'unknown'}`,
        d_token: randomUUID(), account: observed.externalAccount,
        result: { runStatus: observed.runStatus ?? null, conclusion: observed.conclusion ?? null, exists: observed.exists },
        me_ref: id('employee', actor.employeeId),
        audit: id('audit', randomUUID()),
        evidence: JSON.stringify({ run, observed, attribution: 'unknown_actor' }),
      }).catch(error => {
        // 只吞并发对手已经建行的重复：其它失败必须浮出来，否则对账会静默地什么都没记。
        if (/already exists|duplicate/i.test(String((error as Error).message))) return undefined;
        throw error;
      });
      if (row) unknownActor.push(this.externalViewOf(row));
    }
    return { checked: input.runs.length, unknownActor, confirmed, unreadable };
  }

  /** 事后归因：只把老板提供的证据挂上去，并为带外行写入真实的内部员工 ID。 */
  async attributeExternalAction(actor: { employeeId: string }, input: { actionKey: string; employeeId: string; evidence: string }): Promise<ExternalActionView> {
    requireText(input.actionKey, 'actionKey', 8, 200);
    requireText(input.employeeId, 'employeeId', 1, 200);
    requireText(input.evidence, 'evidence', 20, 4000);
    const employee = await this.db.select<Row>(id('employee', input.employeeId));
    if (!employee) throw new CompanyError('not_found', 'Employee not found');
    const row = await this.run<Row>(`BEGIN;
      LET $current = SELECT * FROM ONLY $d;
      IF $current = NONE { THROW 'external action not found' };
      -- QA D7：事后归因只针对**带外**记录（unknown_actor）。内部请求的 requested_by 是我们自己那次发起留下的
      -- 真实员工，让别人（哪怕 owner）改写它等于重写「谁要求取消了这条 run」——那是审计事实，不是可以改判的字段。
      IF $current.attribution != 'unknown_actor' { THROW 'external action already attributed' };
      LET $updated = UPDATE ONLY $d SET attribution = 'internal_employee', requested_by = $employee,
        attribution_evidence = $evidence, updated_at = time::now() RETURN AFTER;
      CREATE $audit CONTENT { actor: $me_ref, action: 'external_action_attributed', evidence: $audit_evidence, at: time::now() };
      RETURN $updated;
      COMMIT;`, { d: this.externalId(input.actionKey), employee: input.employeeId, evidence: input.evidence,
      me_ref: id('employee', actor.employeeId),
      audit: id('audit', randomUUID()),
      audit_evidence: JSON.stringify({ actionKey: input.actionKey, attributedTo: input.employeeId, evidence: input.evidence }) });
    if (!row) throw new CompanyError('not_found', 'External action not found');
    return this.externalViewOf(row);
  }

  async externalActions(input: { actionKey?: string; state?: string; limit?: number }): Promise<ExternalActionView[]> {
    const [rows] = await this.db.query<[Row[]]>(
      `SELECT * FROM external_action WHERE ($key = NONE OR action_key = $key) AND ($state = NONE OR state = $state)
        ORDER BY created_at DESC LIMIT $limit;`,
      { key: input.actionKey, state: input.state, limit: input.limit ?? 50 });
    return (rows ?? []).map(row => this.externalViewOf(row));
  }

  /** The record as the tool layers read it. Public because a non-manager's own-action listing is filtered in core. */
  externalViewOf(row: Row): ExternalActionView {
    if (!row || !Object.keys(row).length) throw new CompanyError('not_found', 'External action not found');
    return {
      actionKey: text(row.action_key),
      kind: text(row.kind),
      provider: text(row.provider),
      target: (row.target ?? {}) as Record<string, unknown>,
      requestedBy: text(row.requested_by) || undefined,
      reason: text(row.reason),
      prerequisiteTaskId: row.prerequisite_task ? asId(row.prerequisite_task) : undefined,
      prerequisiteVersion: num(row.prerequisite_version),
      state: text(row.state) as ExternalActionView['state'],
      attempts: num(row.attempts) ?? 1,
      attribution: text(row.attribution) === 'unknown_actor' ? 'unknown_actor' : 'internal_employee',
      externalAccount: text(row.external_account) || undefined,
      confirmedResult: (row.confirmed_result ?? undefined) as Record<string, unknown> | undefined,
      attributionEvidence: text(row.attribution_evidence) || undefined,
      createdAt: row.created_at === undefined ? undefined : String(row.created_at),
      updatedAt: row.updated_at === undefined ? undefined : String(row.updated_at),
      reconciledAt: row.reconciled_at === undefined ? undefined : String(row.reconciled_at),
    };
  }
}

function noticeKindFor(action: DispositionActionName): DispositionNoticeKind {
  if (action === 'resume') return 'resumed';
  if (action === 'defer' || action === 'dependency') return 'dependency_wait';
  return 'disposition_decided';
}


/** THROW 消息 → 结构化拒绝。与 core.txTask 的口径一致：拒绝在副作用之前，原因可读。 */
function dispositionError(cause: string): CompanyError {
  if (/disposition claim missing/i.test(cause)) return new CompanyError('conflict', 'No disposition claim for this episode; claim it first');
  if (/disposition already handled/i.test(cause)) return new CompanyError('conflict', 'Disposition already handled for this episode');
  if (/disposition claim held by another/i.test(cause)) return new CompanyError('forbidden', 'Disposition claim held by another manager');
  if (/disposition claim leased by another/i.test(cause)) return new CompanyError('already_claimed', 'Disposition claim is leased by another manager');
  if (/disposition claim lease expired/i.test(cause)) return new CompanyError('lease_expired', 'Disposition claim lease expired; take it over with expectedEpisodeVersion');
  if (/disposition claim moved/i.test(cause)) return new CompanyError('conflict', 'Disposition claim moved; re-read the episode and retry');
  if (/disposition episode not open/i.test(cause)) return new CompanyError('conflict', 'The blocking episode is no longer open; a stale reminder cannot be decided');
  if (/disposition action moved/i.test(cause)) return new CompanyError('conflict', 'Disposition action moved; retry with the same idempotency key');
  if (/external action not found/i.test(cause)) return new CompanyError('not_found', 'External action not found');
  if (/external action already attributed/i.test(cause)) {
    return new CompanyError('conflict', 'External action already carries an internal attribution; an out-of-band record is the only one that can be attributed');
  }
  if (/task version moved/i.test(cause)) return new CompanyError('conflict', 'Task version moved');
  if (/task not found/i.test(cause)) return new CompanyError('not_found', 'Task not found');
  if (/already exists|duplicate/i.test(cause)) return new CompanyError('conflict', 'Record already exists');
  return new CompanyError('conflict', `Disposition transaction conflicted: ${cause.slice(0, 200)}`);
}

export { MAX_NOTICES_PER_DECISION };