/**
 * Dispatch-blocked evaluator: one server-side conclusion for why a task cannot be dispatched in its phase.
 * The tick, the manager notices, the roster and task cards, and the daily brief all read this result, so
 * they cannot disagree. Pure on purpose: callers pass the staffing entries and global gates they already
 * computed. `entries` undefined without a global gate means the candidate state could not be read (unknown,
 * never "busy").
 *
 * A task with zero eligible candidates is never dispatchable. Every effective reason code is reported with
 * the candidates it applies to, so an early coarse reason (busy, quota) cannot hide author recusal.
 * Pass-wide gates (pause, budget, resources, concurrency cap) are reported alone: candidates are not read
 * while one applies, because the tick returns before it looks at them.
 */

import type { WriteScopeHolder } from '../contracts.ts';

/** execute: the implementer writes code. review: an independent reviewer accepts or returns. */
export type DispatchPhase = 'execute' | 'review';

/**
 * The workflow state of the work item the conclusion is about: the task's own state (what the workflow says), kept apart from the
 * dispatch status (`dispatchable`, what the pass decided). An execute item is `ready`, or `doing` when its holder is gone; a review
 * item is `review`.
 */
export type WorkflowState = 'ready' | 'doing' | 'review';

/** Stable machine codes. The text is for owners; codes drive grouping, notices and auto-clear. */
export type BlockCode =
  | 'paused' | 'budget' | 'resources' | 'max_running'
  | 'implementer_mismatch' | 'implementer_unresolved' | 'implementer_unavailable' | 'implementer_quota' | 'author_recusal' | 'independence_conflict' | 'no_candidate'  | 'session_busy' | 'held' | 'assigned' | 'credential_file' | 'track_mismatch' | 'model_slot'
  | 'quota' | 'probe_busy' | 'provider_capacity' | 'seat_full' | 'def_disabled' | 'wake_failed' | 'unknown' | 'review_capacity'
  | 'write_scope';

/** One staffing entry, reduced to what the evaluator reads. `key` is the employee id or `spawn:<def>`. */
export interface EvaluatedEntry {
  key: string;
  eligible: boolean;
  code?: BlockCode;
  /** Recovery time of a quota block, ISO 8601. Undefined when no time can be proven: the verdict then says it is unknown. */
  until?: string;
  /** The owner-facing detail of this candidate's block (the seat count, the cooldown), when the block has one. */
  reason?: string;
}

/**
 * A gate that applies to the whole pass (paused, budget, resources, concurrency cap), or to the candidates it names. A write
 * scope held by another writer names that writer; the default is the whole pass.
 */
export interface GlobalBlock {
  code: BlockCode;
  text: string;
  candidates?: readonly string[];
}

/** Who may take a recovery action: the manager (gm, with the manage capability) or the owner. */
export type RecoveryAuthority = 'gm' | 'owner' | 'system';

/**
 * One way out of a block. `tool` names the operations tool that performs it (sck call <tool>). `executable` is false when no
 * tool performs it: the owner or manager acts outside the system and reports back.
 */
export interface RecoveryAction {
  authority: RecoveryAuthority;
  label: string;
  tool?: string;
  executable: boolean;
}

export interface DispatchReason {
  code: BlockCode;
  text: string;
  candidates: string[];
  owner: RecoveryAuthority;
  recovery: string;
  nextTrigger: string;
  /** The source the code was read from, so a reader can tell which fact the conclusion rests on (for example "contribution-audit"). */
  basis: string;
  /** Structured recovery actions with their authority; the text in `recovery` says the same in words. */
  actions: RecoveryAction[];
  /** Recovery time of a quota reason, ISO 8601. Absent when unknown: the text then says 恢复时间未知, and no time is invented. */
  until?: string;
}

export interface DispatchVerdict {
  noticeKey: string;
  taskId: string;
  goalId?: string;
  title: string;
  phase: DispatchPhase;
  role: string;
  home: string;
  dispatchable: boolean;
  /** The task's workflow state (see WorkflowState). Dispatch status is `dispatchable`, never this. */
  workflowState: WorkflowState;
  eligibleCount: number;
  /** Every effective reason; empty only when the task is dispatchable. */
  reasons: DispatchReason[];
  /**
   * False when the block is material at once: no candidate can become eligible without an owner decision (e.g. no
   * independent reviewer), or the candidate state is unknown (nobody can tell whether the work is merely busy).
   */
  feasible: boolean;
  checkedAt: string;
  since?: string;
  waitingMinutes: number;
  /** Stable one-line conclusion: no volatile numbers, so a repeated tick yields the same text. */
  summary: string;
}

export interface EvaluateInput {
  taskId: string;
  goalId?: string;
  title: string;
  phase: DispatchPhase;
  role: string;
  home: string;
  /** undefined without a global gate: the candidate state could not be read (unknown). */
  entries?: readonly EvaluatedEntry[];
  globalBlocks?: readonly GlobalBlock[];
  /** Episode start, unix milliseconds. Defaults to checkedAt (a fresh episode). */
  since?: number;
  /** The task's workflow state; defaults from the phase (execute is ready, review is review). */
  workflowState?: WorkflowState;
  /** Same-role employees of other repositories that this pool left out: named in the summary of a block, never a reason of their own. */
  otherRepo?: number;
  /** Evaluation time, unix milliseconds. */
  checkedAt: number;
}

/** Codes that only an owner edit (task, roster, pool) can change; waiting never clears them. */
const PERMANENT: ReadonlySet<BlockCode> = new Set<BlockCode>([
  'author_recusal', 'independence_conflict', 'implementer_mismatch', 'implementer_unresolved', 'implementer_quota', 'track_mismatch',  'credential_file', 'def_disabled', 'no_candidate', 'review_capacity',
]);

/** Owner-facing text per code. The staffing pool and the evaluator both read this table. */
export const BLOCK_TEXT: Record<BlockCode, string> = {
  paused: '全局暂停派工',
  budget: '订阅额度耗尽或限流',
  resources: '宿主机资源低于水位',
  max_running: '全局在办会话已达上限，等待空位',
  implementer_mismatch: '任务已绑定实现负责人，其他人不能接手代码',
  implementer_unresolved: '多个作者且无实现负责人，需经理指定',
  implementer_unavailable: '实现人会话已失效，系统自动改派在岗工程员工',
  implementer_quota: '实现人订阅额度持续不可用，需等待恢复或经理接手',
  author_recusal: '本任务作者（写过或提交过）不能复核',
  independence_conflict: '来源任务的经手人或经理指定回避的员工不能接手或复核，且暂无其它合格候选',
  no_candidate: '该岗位与仓库下没有任何编制或员工',
  session_busy: '会话占用中或异常',
  held: '持有在办任务',
  assigned: '本轮已分配',
  credential_file: '凭证文件实例不可接新任务',
  track_mismatch: '岗位轨不匹配',
  model_slot: '模型槽位未解析或已漂移',
  quota: '订阅额度或健康冷却中',
  provider_capacity: '订阅并发已满',
  seat_full: '编制席位已满',
  def_disabled: '编制已停用',
  wake_failed: '派工未能唤醒或创建会话，下一轮重试',
  unknown: '状态或贡献者历史读取失败，不能判定（不视为忙），恢复后自动重判',
  review_capacity: '后续独立复核缺合格人选：合格复核人不能同时实现，且无合规空余席位',
  write_scope: '同线或重叠目录的在办写者占用了工作树，代码写权须等待',
  probe_busy: '单次探测会话占用中（冷却已过，探测结束前不派其他会话）',
};

const OWNER: Record<BlockCode, RecoveryAuthority> = {
  paused: 'gm', budget: 'owner', resources: 'gm', max_running: 'gm',
  implementer_mismatch: 'gm', implementer_unresolved: 'gm', implementer_unavailable: 'system', implementer_quota: 'gm', author_recusal: 'gm', independence_conflict: 'gm', no_candidate: 'gm',  session_busy: 'gm', held: 'gm', assigned: 'gm', credential_file: 'gm', track_mismatch: 'gm', model_slot: 'gm',
  quota: 'owner', provider_capacity: 'gm', seat_full: 'gm', def_disabled: 'gm', wake_failed: 'gm', unknown: 'gm',
  review_capacity: 'gm',
  write_scope: 'gm', probe_busy: 'gm',
};

const RECOVERY: Record<BlockCode, string> = {
  paused: '经理解除全局暂停',
  budget: '老板充值，或等待额度恢复',
  resources: '清理宿主机磁盘或等待水位恢复',
  max_running: '等待在办会话结束，或经理调高 max_running',
  implementer_mismatch: '等待绑定的实现负责人可用，或经理用 implementer_takeover 显式接手',
  implementer_unresolved: '经理用 implementer_takeover 记录实现负责人',
  implementer_unavailable: '系统自动改派，无需经理；暂无候选时等候选人空闲后自动重试',
  implementer_quota: '等待额度恢复，或经理用 implementer_takeover 接手',
  author_recusal: '经理增补独立复核人选（编制扩容或新员工），不能由作者自验',
  independence_conflict: '经理增补独立候选人选（编制扩容或新员工），来源经手人不能接手或复核',
  no_candidate: '经理为该岗位或仓库增加编制或员工',
  session_busy: '等待在办任务完成或租约到期',
  held: '等待在办任务完成或租约到期',
  assigned: '下一轮派工自动处理',
  credential_file: '等待该实例退役，新实例接任务',
  track_mismatch: '经理调整编制轨或任务轨',
  model_slot: '等待模型槽位刷新，或经理检查订阅',
  quota: '等待订阅额度或健康恢复；老板可充值',
  provider_capacity: '等待在办任务释放该订阅并发',
  seat_full: '经理扩编（maxInstances）或等待席位释放',
  def_disabled: '经理重新启用编制或更换编制',
  wake_failed: '检查 Paseo 会话与插件日志，下一轮自动重试',
  unknown: '检查 Paseo 插件、运行时日志与审计读取，恢复后自动重判',
  review_capacity: '经理为复核岗位增补编制或员工；不能由作者自验，也不能让实现人兼任本任务复核',
  write_scope: '等待同线或重叠目录的在办写者结束，或经理拆线',
  probe_busy: '等待单次探测会话结束，探测结果决定恢复或再次冷却',
};

const NEXT: Record<BlockCode, string> = {
  paused: '全局暂停解除',
  budget: '额度恢复或老板充值',
  resources: '宿主机水位恢复',
  max_running: '在办会话数低于上限',
  implementer_mismatch: '绑定实现负责人可派工，或经理接手',
  implementer_unresolved: '经理记录实现负责人',
  implementer_unavailable: '出现可派候选，系统自动改派',
  implementer_quota: '额度恢复或经理接手',
  author_recusal: '出现独立候选人选',
  independence_conflict: '出现独立于来源任务的合格候选人选',
  no_candidate: '新增编制或员工',
  session_busy: '候选会话空闲',
  held: '在办租约结束或任务完成',
  assigned: '下一轮派工',
  credential_file: '实例退役',
  track_mismatch: '编制轨或任务轨调整',
  model_slot: '模型槽位解析',
  quota: '订阅额度或健康恢复',
  provider_capacity: '订阅并发释放',
  seat_full: '编制席位释放或扩编',
  def_disabled: '编制重新启用',
  wake_failed: '下一轮唤醒成功',
  unknown: '状态与审计读取恢复',
  review_capacity: '出现不同于实现人的合格复核人选，或复核岗位有合规空余席位',
  write_scope: '同线或重叠目录的在办写者结束，或经理拆线',
  probe_busy: '探测会话结束',
};

/** The source each code is read from. Stable strings: the roster, the cards and the brief show them as they are. */
const BASIS: Record<BlockCode, string> = {
  paused: 'tick:global-gate', budget: 'tick:global-gate', resources: 'tick:global-gate', max_running: 'tick:global-gate',
  implementer_mismatch: 'contribution-audit', implementer_unresolved: 'contribution-audit', implementer_unavailable: 'tick:session-status', implementer_quota: 'tick:provider-health', author_recusal: 'contribution-audit',
  independence_conflict: 'contribution-audit',  no_candidate: 'tick:staffing-pool', session_busy: 'paseo:session-status', held: 'tick:staffing-pool', assigned: 'tick:staffing-pool',
  credential_file: 'tick:staffing-pool', track_mismatch: 'tick:staffing-pool', model_slot: 'tick:model-slots',
  quota: 'tick:quota-rows', provider_capacity: 'tick:quota-rows', seat_full: 'tick:staffing-pool',
  def_disabled: 'tick:workforce-defs', wake_failed: 'tick:wake', unknown: 'read:state-or-audit',
  review_capacity: 'tick:review-capacity',
  write_scope: 'tick:worktree-scope', probe_busy: 'tick:provider-health',
};

/** Recovery actions per code. Only the ones with a tool are executable; the rest name who must act outside the system. */
const ACTIONS: Record<BlockCode, RecoveryAction[]> = {
  paused: [{ authority: 'gm', label: '经理解除全局暂停', executable: false }],
  budget: [{ authority: 'owner', label: '老板充值，或等待额度恢复', executable: false }],
  resources: [{ authority: 'gm', label: '清理宿主机磁盘或等待水位恢复', executable: false }],
  max_running: [{ authority: 'gm', label: '等待在办会话结束，或经理调高 max_running', executable: false }],
  implementer_mismatch: [{ authority: 'gm', label: '经理用 implementer_takeover 显式接手', tool: 'implementer_takeover', executable: true }],
  implementer_unresolved: [{ authority: 'gm', label: '经理用 implementer_takeover 记录实现负责人', tool: 'implementer_takeover', executable: true }],
  implementer_unavailable: [
    { authority: 'system', label: '系统自动改派在岗工程员工', executable: false },
    { authority: 'gm', label: '经理也可先核对贡献者再指定负责人（系统同步重试）', tool: 'implementer_takeover', executable: true },
  ],
  implementer_quota: [{ authority: 'gm', label: '经理用 implementer_takeover 接手，或等待额度恢复', tool: 'implementer_takeover', executable: true }],
  author_recusal: [{ authority: 'gm', label: '经理用 def_ensure 增补独立复核编制，或新增员工', tool: 'def_ensure', executable: true }],
  independence_conflict: [{ authority: 'gm', label: '经理用 def_ensure 增补独立编制，或新增员工（来源经手人不能接手）', tool: 'def_ensure', executable: true }],
  no_candidate: [{ authority: 'gm', label: '经理用 def_ensure 为该岗位与仓库增加编制', tool: 'def_ensure', executable: true }],
  session_busy: [{ authority: 'gm', label: '等待在办任务完成或租约到期', executable: false }],
  held: [{ authority: 'gm', label: '等待在办任务完成或租约到期', executable: false }],
  assigned: [{ authority: 'gm', label: '下一轮派工自动处理', executable: false }],
  credential_file: [{ authority: 'gm', label: '等待该实例退役，新实例接任务', executable: false }],
  track_mismatch: [{ authority: 'gm', label: '经理用 def_ensure 调整编制轨', tool: 'def_ensure', executable: true }],
  model_slot: [{ authority: 'gm', label: '等待模型槽位刷新，或经理检查订阅', executable: false }],
  quota: [{ authority: 'owner', label: '老板充值，或等待额度与健康恢复', executable: false }],
  provider_capacity: [{ authority: 'gm', label: '等待在办任务释放该订阅并发', executable: false }],
  seat_full: [{ authority: 'gm', label: '经理用 def_ensure 调高 maxInstances 扩编', tool: 'def_ensure', executable: true }],
  def_disabled: [{ authority: 'gm', label: '经理用 def_ensure 重新启用编制', tool: 'def_ensure', executable: true }],
  wake_failed: [{ authority: 'gm', label: '检查 Paseo 会话与插件日志，下一轮自动重试', executable: false }],
  unknown: [{ authority: 'gm', label: '检查 Paseo 插件、运行时日志与审计读取，恢复后自动重判', executable: false }],
  review_capacity: [{ authority: 'gm', label: '经理用 def_ensure 为复核岗位与仓库增加编制（不新增订阅）', tool: 'def_ensure', executable: true }],
  write_scope: [{ authority: 'gm', label: '等待同线或重叠目录的在办写者结束，或经理拆线', executable: false }],
  probe_busy: [{ authority: 'gm', label: '等待单次探测会话结束', executable: false }],
};

const PHASE_LABEL: Record<DispatchPhase, string> = { execute: '执行', review: '复核' };

const iso = (ms: number) => new Date(ms).toISOString();

/** A pass-wide gate with its owner-facing text. */
export const globalBlock = (code: BlockCode): GlobalBlock => ({ code, text: BLOCK_TEXT[code] });

/** A reviewer pool entry as the review plan reads it: a reuse candidate, or a spawnable def, for the reviewer role and home. */
export interface ReviewPoolEntry {
  key: string;
  kind: 'reuse' | 'spawn';
  eligible: boolean;
  code?: BlockCode;
}

/** The independent review an execute claim needs. `reserve` is the one reuse reviewer kept for the task: logical only, no lease. */
export interface ReviewPlan {
  feasible: boolean;
  /** Reuse candidates that fit the reviewer role, home, track and def, whatever their capacity this minute. Sorted. */
  legal: string[];
  spareSeat: boolean;
  reserve?: string;
}

/** Capacity states that do not make a reviewer illegal: they clear when the seat frees up or the state reads again. */
const CAPACITY: ReadonlySet<BlockCode> = new Set<BlockCode>(['session_busy', 'held', 'assigned', 'quota', 'probe_busy', 'provider_capacity', 'unknown']);

/**
 * SYS-DISP AC05 (R1): whether the independent review after an execute claim has a legal path. Authors never count, and neither
 * does a reviewer whose role, home, track or def rules out new work (those need an owner or manager edit). A legal reuse
 * reviewer or a spare seat (a reviewer def with room for a new instance, even when its provider is in quota or at its
 * concurrency cap) keeps the path open. With no spare seat, one legal reviewer is reserved: the execute pool must not pick it,
 * so the task keeps a reviewer who is not its implementer. Nothing here creates a lease.
 */
export function reviewPlanOf(pool: readonly ReviewPoolEntry[]): ReviewPlan {
  const legalEntries = pool.filter(entry => entry.kind === 'reuse' && (entry.eligible || (entry.code !== undefined && CAPACITY.has(entry.code))));
  const legal = legalEntries.map(entry => entry.key).sort();
  const spareSeat = pool.some(entry => entry.kind === 'spawn' && (entry.eligible || entry.code === 'quota' || entry.code === 'provider_capacity'));
  const eligibleNow = legalEntries.filter(entry => entry.eligible).map(entry => entry.key).sort();
  const reserve = !spareSeat && legal.length > 0 ? (eligibleNow[0] ?? legal[0]) : undefined;
  return { feasible: legal.length > 0 || spareSeat, legal, spareSeat, reserve };
}

/** The owner-facing name of a write-scope holder: a writer names its task by the first eight characters of the id. */
export function holderLabel(holder: WriteScopeHolder): string {
  if (holder.intent === 'read') return `读取会话 · ${holder.employee}`;
  return holder.taskId ? `任务 ${holder.taskId.slice(0, 8)} · ${holder.employee}` : `写者会话 · ${holder.employee}`;
}

/**
 * Recovery time of a quota group: the earliest known time. A candidate without a provable time could recover at any moment,
 * so one unknown candidate makes the whole group unknown rather than yielding the earliest known time.
 */
function quotaUntil(list: readonly EvaluatedEntry[]): string | undefined {
  if (list.length === 0 || list.some(entry => entry.until === undefined)) return undefined;
  return list.map(entry => entry.until!).sort((a, b) => Date.parse(a) - Date.parse(b))[0];
}

/** The repository a verdict is about, by its name: the last segment of its home path. */
export const repoName = (home: string) => home.split('/').filter(Boolean).pop() ?? home;

/** Stable key for one manager-action episode: task, phase, episode start (ms) and reason. */
export function managerActionKey(taskId: string, phase: string, since: number, reason: string): string {
  return `${taskId}:${phase}:${since}:${reason}`;
}

/** The distinct owner-facing reasons of a group's candidates, sorted, so a repeated tick reads the same. */
const detailsOf = (list: readonly EvaluatedEntry[]): string =>
  [...new Set(list.map(entry => entry.reason).filter((r): r is string => r !== undefined))].sort().join('；');

/**
 * Owner-facing text of one reason. Quota, seat and independence reasons read their candidates, so the verdict states the facts it
 * rests on: an independence conflict names its source task and excluded employee, and an unreadable source names itself.
 */
function reasonText(code: BlockCode, list: readonly EvaluatedEntry[], until: string | undefined, home: string): string {
  if (code === 'quota') return `${BLOCK_TEXT.quota}，${until ? `恢复时间 ${until}` : '恢复时间未知'}`;
  if (code === 'implementer_quota') return `${BLOCK_TEXT.implementer_quota}，${until ? `恢复时间 ${until}` : '恢复时间未知'}`;
  if (code === 'seat_full') return detailsOf(list) || `${BLOCK_TEXT.seat_full}（仓库 ${repoName(home)}）`;
  if (code === 'independence_conflict' || code === 'unknown') return detailsOf(list) || BLOCK_TEXT[code];  return BLOCK_TEXT[code];
}

/** Evaluates one task phase. Pure: the same inputs always produce the same verdict and summary text. */
export function evaluateDispatch(input: EvaluateInput): DispatchVerdict {
  const globals = input.globalBlocks ?? [];
  const entries = input.entries;
  const eligibleCount = entries ? entries.filter(entry => entry.eligible).length : 0;
  const grouped = new Map<BlockCode, string[]>();
  const addCandidate = (code: BlockCode, candidate: string) => {
    const list = grouped.get(code) ?? [];
    if (!list.includes(candidate)) list.push(candidate);
    grouped.set(code, list);
  };
  if (globals.length === 0) {
    if (entries === undefined) addCandidate('unknown', '*');
    else if (entries.length === 0) addCandidate('no_candidate', '*');
    for (const entry of entries ?? []) {
      if (!entry.eligible) addCandidate(entry.code ?? 'unknown', entry.key);
    }
  }
  for (const gate of globals) for (const candidate of gate.candidates ?? ['*']) addCandidate(gate.code, candidate);
  const dispatchable = globals.length === 0 && entries !== undefined && eligibleCount > 0;
  // Candidate details come from the pool only when no pass-wide gate applies: the tick returns before it reads them.
  const pool = globals.length === 0 ? entries ?? [] : [];
  const reasons: DispatchReason[] = dispatchable ? [] : [...grouped.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([code, candidates]) => {
      const list = pool.filter(entry => !entry.eligible && (entry.code ?? 'unknown') === code);
      const until = code === 'quota' || code === 'implementer_quota' ? quotaUntil(list) : undefined;
      return {
        code,
        text: reasonText(code, list, until, input.home),
        candidates: candidates.sort(),
        owner: OWNER[code],
        recovery: RECOVERY[code],
        nextTrigger: NEXT[code],
        basis: BASIS[code],
        actions: ACTIONS[code].map(action => ({ ...action })),
        ...(until ? { until } : {}),
      };
    });
  // Pass-wide gates clear by themselves. A candidate list holding only owner-decision codes never does, and neither does an
  // unknown state: nobody can tell whether it will, so it is material at once.
  const materialCode = (code: BlockCode = 'unknown') => code === 'unknown' || PERMANENT.has(code);
  const feasible = dispatchable || (globals.length > 0
    ? globals.every(gate => !materialCode(gate.code))
    : entries !== undefined && entries.some(entry => !entry.eligible && !materialCode(entry.code)));
  const phase = PHASE_LABEL[input.phase];
  // The repository filter is a hard scope, not a reason: other-repo employees are named, never waited on.
  const outside = input.otherRepo ? `；另有 ${input.otherRepo} 名同岗位员工属其他仓库，不参与本仓库派工` : '';
  const summary = dispatchable
    ? `${input.title}：${phase}可派工`
    : `${input.title}：${phase}无法派工（${reasons.map(reason => reason.text).join('；') || '原因未知'}${outside}）`;
  const since = input.since ?? input.checkedAt;
  return {
    noticeKey: `dispatch-blocked:${input.taskId}:${input.phase}`,
    taskId: input.taskId, goalId: input.goalId, title: input.title, phase: input.phase, role: input.role, home: input.home,
    dispatchable, eligibleCount, reasons, feasible,
    workflowState: input.workflowState ?? (input.phase === 'execute' ? 'ready' : 'review'),
    checkedAt: iso(input.checkedAt),
    since: dispatchable ? undefined : iso(since),
    waitingMinutes: dispatchable ? 0 : Math.max(0, Math.floor((input.checkedAt - since) / 60_000)),
    summary,
  };
}

/** Owner-facing notice text. Built from stable fields only, so repeated ticks update nothing. */
export function dispatchNoticeText(verdict: DispatchVerdict): string {
  const reasons = verdict.reasons.map(reason =>
    `${reason.text}（${reason.candidates.filter(c => c !== '*').join('、') || '全局'}）`).join('；');
  const next = verdict.reasons.map(reason => reason.nextTrigger).filter((v, i, all) => all.indexOf(v) === i).join('；');
  const recovery = verdict.reasons.map(reason => `${reason.owner === 'gm' ? 'gm' : reason.owner === 'system' ? '系统' : '老板'}：${reason.recovery}`).join('；');
  return `${verdict.summary}。自 ${verdict.since ?? verdict.checkedAt} 起等待。原因：${reasons}。下一触发：${next || '待定'}。处理：${recovery}。`;
}

/** Who a goal root is attached to: the bound implementer, the authors and reviewers from the contribution history, and the last submit. */
export interface GoalRootPeople {
  implementer?: string;
  authors: string[];
  reviewers: string[];
  submitter?: string;
  /** The commit the last submit evidence names, when it names one. Free text in the evidence, not a structured field. */
  submitCommit?: string;
}

/** Facts a goal card names beyond the verdicts: the waiting graph of unfinished goal work, titles, and each root's people. */
export interface GoalWorkflowTaskFact {
  taskId: string;
  goalId?: string;
  title: string;
  state: string;
  dependencies: readonly string[];
  blockedTo?: string;
  resumeState?: string;
  executorRole?: string;
  reviewerRole?: string;
  currentEmployee?: string;
  leaseExpiresAt?: number;
  hiddenDependencies?: number;
  goalAnchor?: boolean;
}

export interface GoalRootFacts {
  /** Goal task ids and their dependency edges. Completed rows are retained to prove an edge is satisfied. */
  dependencies: ReadonlyMap<string, readonly string[]>;
  titles: ReadonlyMap<string, string>;
  people: ReadonlyMap<string, GoalRootPeople>;
  /** Authoritative workflow state used to distinguish normal waits, gates and live leases. */
  tasks?: ReadonlyMap<string, GoalWorkflowTaskFact>;
  /** Database time sampled with the workflow graph, separate from any dispatcher pass time. */
  collectedAt?: string;
}

export type GoalWorkflowWaitKind = 'dependency' | 'manager' | 'owner' | 'active_lease' | 'unknown';
export type GoalWorkflowState = 'ready' | 'doing' | 'review' | 'blocked' | 'done' | 'void' | 'unknown';
export interface GoalWorkflowWaitRoot {
  goalId?: string;
  taskId: string;
  title: string;
  workflowState: GoalWorkflowState;
  kind: GoalWorkflowWaitKind;
  basis: string;
  waitingForRole: string;
  nextTrigger: string;
  goalRootCount: number;
  impact?: number;
  dependencyPath?: Array<{ taskId: string; title: string }>;
  dependencyPathTruncated?: boolean;
  unknownReason?: string;
  people?: GoalRootPeople & { peopleOmitted?: number };
  peopleSource?: 'contributor-audit';
  submitterSource?: 'submit-audit';
  submitCommitSource?: 'submit-audit-evidence';
  peopleCheckedAt?: string;
  submitCheckedAt?: string;
}
export interface GoalWorkflowWaitSummary {
  source: 'workflow-graph';
  available: boolean;
  checkedAt?: string;
  totalRoots: number;
  shownRoots: number;
  truncated: boolean;
  reason?: string;
  roots: GoalWorkflowWaitRoot[];
}

/** A goal card's root blocker: the verdict the card names first, and how much work waits behind it. */
export interface GoalRootBlocker {
  goalId: string;
  taskId: string;
  title: string;
  phase: DispatchPhase;
  summary: string;
  /** False when the block is material at once (see DispatchVerdict.feasible). */
  feasible: boolean;
  waitingMinutes: number;
  since?: string;
  /** Blocked work of this goal in the pass, the root included: the 无法派工 count, shown apart from the normal waits (impact). */
  undispatchable: number;
  /** Other blocked work behind the same goal, from this pass's verdicts. */
  others: number;
  /** The root's workflow state, eligible-candidate count and the instant its conclusion was checked (its own checkedAt). */
  workflowState: WorkflowState;
  eligibleCount: number;
  checkedAt: string;
  /** Unfinished tasks waiting on this root, directly or through other tasks: the "影响 N 项后续" count. */
  impact: number;
  /** The longest waiting chain from the root: the root first, then each task that waits on the one before it. Bounded. */
  dependencyPath: Array<{ taskId: string; title: string }>;
  people: GoalRootPeople;
  reasons: DispatchReason[];
}

const NO_PEOPLE: GoalRootPeople = { authors: [], reviewers: [] };
const PATH_LIMIT = 8;

/** The commit a submit evidence text names: the last 7 to 40 hex digits after 提交 or commit. Undefined when it names none. */
export function submitCommitOf(evidence: string): string | undefined {
  const named = [...evidence.matchAll(/(?:提交|commit)\D{0,12}?\b([0-9a-f]{7,40})\b/gi)];
  return named.at(-1)?.[1]?.toLowerCase();
}

/** Unfinished tasks that wait on `root` through dependency edges (count), and the longest such chain from the root. */
function waitingBehind(root: string, facts?: GoalRootFacts): { count: number; path: string[] } {
  if (!facts) return { count: 0, path: [root] };
  const waiters = new Map<string, string[]>();
  for (const [task, deps] of facts.dependencies) {
    for (const dep of deps) waiters.set(dep, [...(waiters.get(dep) ?? []), task]);
  }
  const depth = new Map<string, number>([[root, 0]]);
  const parent = new Map<string, string>();
  const queue = [root];
  let deepest = root;
  for (let i = 0; i < queue.length; i++) {
    const current = queue[i]!;
    for (const next of [...(waiters.get(current) ?? [])].sort()) {
      if (depth.has(next)) continue;
      depth.set(next, depth.get(current)! + 1);
      parent.set(next, current);
      queue.push(next);
      const d = depth.get(next)!;
      if (d > depth.get(deepest)! || (d === depth.get(deepest)! && next < deepest)) deepest = next;
    }
  }
  const path = [deepest];
  while (path[0] !== root && parent.has(path[0]!)) path.unshift(parent.get(path[0]!)!);
  return { count: queue.length - 1, path: path.slice(0, PATH_LIMIT) };
}


const KNOWN_WORKFLOW_STATES = new Set(['ready', 'doing', 'review', 'blocked', 'done', 'void']);
const TERMINAL_STATES = new Set(['done', 'void']);
const rootWaitRank: Record<GoalWorkflowWaitKind, number> = { manager: 0, owner: 1, active_lease: 2, dependency: 3, unknown: 4 };

/**
 * Derives normal workflow waits from one goal graph. Dependency edges are followed only inside `facts.tasks`; absent targets,
 * inconsistent blocked rows, unknown states and cycles produce an explicit unknown root with no invented impact or path.
 */
export function goalWorkflowWaitRoots(facts: GoalRootFacts, limit = 20): GoalWorkflowWaitSummary {
  const tasks = facts.tasks;
  if (!tasks || !facts.collectedAt) return { source: 'workflow-graph', available: false, totalRoots: 0, shownRoots: 0, truncated: false,
    reason: 'workflow graph or its collection time is unavailable', roots: [] };
  const nodes = new Map(tasks);
  const cycles = new Set<string>();
  const cycleRoot = new Map<string, string>();
  const active = new Map<string, number>();
  const visited = new Set<string>();
  const visit = (taskId: string) => {
    if (visited.has(taskId)) return;
    visited.add(taskId);
    active.set(taskId, active.size);
    const task = nodes.get(taskId)!;
    for (const dependency of [...task.dependencies].sort()) {
      const dep = nodes.get(dependency);
      if (!dep || dep.goalId !== task.goalId) continue;
      if (active.has(dependency)) {
        const cycleStart = active.get(dependency)!;
        const members = [...active].filter(([, index]) => index >= cycleStart).map(([id]) => id);
        const representative = [...members].sort()[0]!;
        for (const id of members) { cycles.add(id); cycleRoot.set(id, representative); }
      } else visit(dependency);
    }
    active.delete(taskId);
  };
  for (const taskId of [...nodes.keys()].sort()) visit(taskId);

  type Candidate = { id: string; kind: GoalWorkflowWaitKind; reason?: string };
  const candidates = new Map<string, Candidate>();
  const add = (candidate: Candidate) => {
    const prior = candidates.get(candidate.id);
    if (!prior || rootWaitRank[candidate.kind] < rootWaitRank[prior.kind] ||
        (rootWaitRank[candidate.kind] === rootWaitRank[prior.kind] && (candidate.reason ?? '').localeCompare(prior.reason ?? '') < 0)) {
      candidates.set(candidate.id, candidate);
    }
  };
  const unknown = (taskId: string, reason: string): Candidate => ({ id: taskId, kind: 'unknown', reason });
  const resolveWait = (taskId: string, waiterId?: string): Candidate[] => {
    const task = nodes.get(taskId);
    const waiter = waiterId ? nodes.get(waiterId) : undefined;
    if (!task) return [unknown(waiterId ?? taskId, '依赖记录缺失或不在当前目标可见范围')];
    if (waiter && task.goalId !== waiter.goalId) return [unknown(waiter.taskId, '依赖不在当前目标范围')];
    if (!KNOWN_WORKFLOW_STATES.has(task.state)) return [unknown(taskId, '工作流状态未知')];
    if (cycles.has(taskId)) return [unknown(cycleRoot.get(taskId) ?? taskId, '依赖关系存在循环')];
    if (task.state === 'blocked') {
      if (task.blockedTo === 'gm') return [{ id: taskId, kind: 'manager' }];
      if (task.blockedTo === 'owner') return [{ id: taskId, kind: 'owner' }];
      if (task.blockedTo !== undefined && task.blockedTo !== '') return [unknown(taskId, '阻塞处理岗位未知')];
      if ((task.hiddenDependencies ?? 0) > 0) return [unknown(taskId, '存在当前目标不可见范围的依赖')];
      if (task.dependencies.length === 0) return [unknown(taskId, 'blocked 任务没有可核实的阻塞依赖')];
      const roots: Candidate[] = [];
      for (const dependency of [...task.dependencies].sort()) {
        const dep = nodes.get(dependency);
        if (!dep) { roots.push(unknown(taskId, '依赖记录缺失或不在当前目标可见范围')); continue; }
        if (dep.goalId !== task.goalId) { roots.push(unknown(taskId, '依赖不在当前目标范围')); continue; }
        if (!KNOWN_WORKFLOW_STATES.has(dep.state)) { roots.push(unknown(taskId, '依赖任务状态未知')); continue; }
        // Core dependency semantics: a void owner gate is satisfied only for a goal-anchor waiter.
        if (dep.state === 'done' || (dep.state === 'void' && (dep.reviewerRole !== 'owner' || task.goalAnchor))) continue;
        if (dep.state === 'void' && dep.reviewerRole === 'owner') {
          roots.push(unknown(taskId, '非目标锚点仍依赖已作废的老板关口'));
          continue;
        }
        roots.push(...resolveWait(dependency, taskId));
      }
      return roots.length ? roots : [unknown(taskId, 'blocked 任务的依赖均已完成，工作流状态不一致')];
    }
    if (task.blockedTo !== undefined && task.blockedTo !== '') return [unknown(taskId, '非 blocked 任务带有阻塞处理岗位')];
    if (TERMINAL_STATES.has(task.state)) return [];
    if (task.state === 'review' && task.reviewerRole === 'owner') return [{ id: taskId, kind: 'owner' }];
    if (task.currentEmployee) {
      const collected = Date.parse(facts.collectedAt!);
      const leaseUntil = (task.leaseExpiresAt ?? 0) * 1000;
      if (Number.isFinite(collected) && leaseUntil > collected) return [{ id: taskId, kind: 'active_lease' }];
      return [unknown(taskId, '存在持有人记录，但租约已过期或租约时点不可核实')];
    }
    return [{ id: taskId, kind: 'dependency' }];
  };

  for (const task of [...nodes.values()].sort((a, b) => a.taskId.localeCompare(b.taskId))) {
    if (!KNOWN_WORKFLOW_STATES.has(task.state)) add(unknown(task.taskId, '工作流状态未知'));
    else if (task.state === 'blocked') for (const candidate of resolveWait(task.taskId)) add(candidate);
  }

  const waiters = new Map<string, string[]>();
  for (const task of nodes.values()) {
    for (const dependency of [...task.dependencies].sort()) {
      const dep = nodes.get(dependency);
      if (dep?.goalId === task.goalId) waiters.set(dependency, [...(waiters.get(dependency) ?? []), task.taskId]);
    }
  }
  const roots = [...candidates.values()].map(candidate => {
    const task = nodes.get(candidate.id);
    const base: GoalWorkflowWaitRoot = {
      ...(task?.goalId ? { goalId: task.goalId } : {}), taskId: candidate.id,
      title: task?.title ?? candidate.id,
      workflowState: task && KNOWN_WORKFLOW_STATES.has(task.state) ? task.state as GoalWorkflowState : 'unknown',
      kind: candidate.kind,
      basis: candidate.kind === 'manager' ? 'task.blocked_to=gm' : candidate.kind === 'owner' ? 'task.blocked_to=owner or reviewer_role=owner'
        : candidate.kind === 'active_lease' ? 'task.current_employee + task.lease_expires_at'
          : candidate.kind === 'dependency' ? 'task.dependencies' : 'workflow-graph',
      waitingForRole: candidate.kind === 'manager' ? 'gm' : candidate.kind === 'owner' ? 'owner'
        : candidate.kind === 'unknown' ? 'unknown'
          : (task?.state === 'review' || (task?.state === 'blocked' && task.resumeState === 'review')
            ? task.reviewerRole ?? 'unknown' : task?.executorRole ?? 'unknown'),
      nextTrigger: candidate.kind === 'manager' ? '经理解除阻塞后恢复'
        : candidate.kind === 'owner' ? '老板处理关口后恢复'
          : candidate.kind === 'active_lease' ? '持有人完成当前任务或租约到期后重新判定'
            : candidate.kind === 'dependency' ? '依赖任务完成、撤销或恢复后重新判定'
              : '工作流依赖图恢复一致后重新判定',
      goalRootCount: 0,
      ...(candidate.reason ? { unknownReason: candidate.reason } : {}),
    };
    if (candidate.kind === 'unknown') return base;
    const depth = new Map<string, number>([[candidate.id, 0]]);
    const parent = new Map<string, string>();
    const queue = [candidate.id];
    let deepest = candidate.id;
    let incomplete = false;
    for (let i = 0; i < queue.length; i++) {
      const current = queue[i]!;
      for (const next of [...(waiters.get(current) ?? [])].sort()) {
        const child = nodes.get(next)!;
        if (depth.has(next)) continue;
        if (!KNOWN_WORKFLOW_STATES.has(child.state) || child.hiddenDependencies || cycles.has(next)) { incomplete = true; continue; }
        if (child.state !== 'blocked') continue;
        depth.set(next, depth.get(current)! + 1); parent.set(next, current); queue.push(next);
        if (depth.get(next)! > depth.get(deepest)! || (depth.get(next) === depth.get(deepest) && next < deepest)) deepest = next;
      }
    }
    if (incomplete) return { ...base, unknownReason: '影响路径包含未知状态、不可见依赖或循环，无法核实影响数与路径' };
    const path = [deepest];
    while (path[0] !== candidate.id && parent.has(path[0]!)) path.unshift(parent.get(path[0]!)!);
    return { ...base, impact: queue.length - 1, dependencyPath: path.slice(0, PATH_LIMIT).map(id => ({ taskId: id, title: nodes.get(id)?.title ?? id })),
      ...(path.length > PATH_LIMIT ? { dependencyPathTruncated: true } : {}) };
  });
  roots.sort((a, b) => (a.goalId ?? '').localeCompare(b.goalId ?? '') || rootWaitRank[a.kind] - rootWaitRank[b.kind]
    || (b.impact ?? -1) - (a.impact ?? -1) || a.taskId.localeCompare(b.taskId));
  const perGoal = new Map<string, number>();
  for (const root of roots) { const key = root.goalId ?? ''; perGoal.set(key, (perGoal.get(key) ?? 0) + 1); }
  for (const root of roots) root.goalRootCount = perGoal.get(root.goalId ?? '') ?? roots.length;
  const shown = roots.slice(0, Math.max(0, limit));
  return { source: 'workflow-graph', available: true, checkedAt: facts.collectedAt, totalRoots: roots.length, shownRoots: shown.length,
    truncated: shown.length < roots.length, roots: shown };
}

/**
 * One root blocker per goal, from the latest pass's verdicts. A material block (an owner or manager decision, or an unknown
 * state) is named before a waiting one, then the longest wait. Dispatchable work has no verdict and never appears here.
 * `facts` adds the impact count, the waiting chain and the people; without it those fields are empty.
 */
export function goalRootBlockers(verdicts: readonly DispatchVerdict[], facts?: GoalRootFacts): GoalRootBlocker[] {
  const byGoal = new Map<string, DispatchVerdict[]>();
  for (const verdict of verdicts) {
    if (verdict.dispatchable || !verdict.goalId) continue;
    byGoal.set(verdict.goalId, [...(byGoal.get(verdict.goalId) ?? []), verdict]);
  }
  return [...byGoal].sort(([a], [b]) => a.localeCompare(b)).map(([goalId, list]) => {
    const ranked = [...list].sort((a, b) => Number(a.feasible) - Number(b.feasible) || b.waitingMinutes - a.waitingMinutes || a.taskId.localeCompare(b.taskId));
    const root = ranked[0]!;
    const behind = waitingBehind(root.taskId, facts);
    const titleOf = (taskId: string) => (taskId === root.taskId ? root.title : (facts?.titles.get(taskId) ?? taskId));
    return { goalId, taskId: root.taskId, title: root.title, phase: root.phase, summary: root.summary, feasible: root.feasible,
      waitingMinutes: root.waitingMinutes, since: root.since, others: list.length - 1, undispatchable: list.length, impact: behind.count,
      workflowState: root.workflowState, eligibleCount: root.eligibleCount, checkedAt: root.checkedAt,
      dependencyPath: behind.path.map(taskId => ({ taskId, title: titleOf(taskId) })),
      people: facts?.people.get(root.taskId) ?? NO_PEOPLE, reasons: root.reasons };
  });
}
