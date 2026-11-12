/**
 * Dispatch-blocked evaluator: one server-side conclusion for why a task cannot be dispatched in its phase.
 * The tick, the owner notices, the roster and task cards, and the daily brief all read this result, so
 * they cannot disagree. Pure on purpose: callers pass the staffing entries and global gates they already
 * computed. `entries` undefined without a global gate means the candidate state could not be read (unknown,
 * never "busy").
 *
 * A task with zero eligible candidates is never dispatchable. Every effective reason code is reported with
 * the candidates it applies to, so an early coarse reason (busy, quota) cannot hide author exclusion.
 * Pass-wide gates (pause, budget, resources, concurrency cap) are reported alone: candidates are not read
 * while one applies, because the tick returns before it looks at them.
 */

/** execute: the executor does the work. review: a different reviewer accepts or returns. */
export type DispatchPhase = 'execute' | 'review';

/**
 * The workflow state of the work item the conclusion is about: the task's own state (what the workflow says), kept apart from the
 * dispatch status (`dispatchable`, what the pass decided). An execute item is `ready`, or `doing` when its holder is gone; a review
 * item is `review`.
 */
export type WorkflowState = 'ready' | 'doing' | 'review';

/** Stable machine codes. The text is for owners; codes drive grouping, notices and auto-clear. */
export type BlockCode =
  | 'paused' | 'budget' | 'resources' | 'memory_pressure' | 'disk_space' | 'max_running'
  | 'prior_submitter' | 'no_candidate' | 'session_busy' | 'held' | 'assigned' | 'track_mismatch' | 'model_slot'
  | 'provider_retry' | 'quota' | 'probe_busy' | 'provider_capacity' | 'seat_full' | 'def_disabled' | 'off_hours' | 'wake_failed' | 'unknown' | 'factory_wait';

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

/** Who may take a recovery action: the owner. */
export type RecoveryAuthority = 'owner' | 'system';

/**
 * One way out of a block. `tool` names the operations tool that performs it (sck call <tool>). `executable` is false when no
 * tool performs it: the owner acts outside the system and reports back.
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
  'prior_submitter', 'track_mismatch', 'def_disabled', 'no_candidate',
]);

/** Codes meaning a qualified candidate exists and is only occupied right now; they clear without anyone acting. */
const OCCUPIED: ReadonlySet<BlockCode> = new Set<BlockCode>(['held', 'assigned', 'provider_capacity', 'probe_busy', 'wake_failed']);

export interface StaffingShortage {
  /** True while the gate only waits for an occupied worker: a queue, not something the owner must fix. */
  queued: boolean;
  /** Owner-facing reasons, deduplicated, when nothing is merely occupied. */
  reasons: string[];
}

/**
 * Why a role has no free seat. Both seats of a workspace busy is ordinary queueing and must not reach the
 * owner as "no candidate available" — that notice then outlives the moment it described. `seat_full` alone is not a
 * queue: the seats may be held by employees that can never take the work (disabled, model drift), which only a fix
 * clears. `session_busy` counts only for a session that is really running a turn (`isBusy`), not one that is down.
 */
export function staffingShortage(
  entries: readonly { eligible: boolean; code?: BlockCode; reason?: string; inst?: { id: string } }[],
  isBusy: (instId: string) => boolean,
): StaffingShortage {
  const queued = entries.some(e => e.eligible || (e.code !== undefined && OCCUPIED.has(e.code)) ||
    (e.code === 'session_busy' && !!e.inst && isBusy(e.inst.id)));
  const reasons = [...new Set(entries.map(e => e.reason ?? (e.code ? BLOCK_TEXT[e.code] : undefined))
    .filter((r): r is string => !!r))];
  return { queued, reasons: reasons.length ? reasons : [BLOCK_TEXT.no_candidate] };
}

/** Owner-facing text per code. The staffing pool and the evaluator both read this table. */
export const BLOCK_TEXT: Record<BlockCode, string> = {
  provider_retry: '本任务供应商失败冷却或切换预算已用尽',
  factory_wait: 'Factory 仍有额度，本任务保留等待 Factory；已有 3 个等待任务后新任务可分流',
  paused: '全局暂停派工',
  budget: '订阅额度耗尽或限流',
  resources: '宿主机资源低于水位',
  memory_pressure: '宿主机内存压力偏高',
  disk_space: '宿主机空闲磁盘不足',
  max_running: '全局在办会话已达上限，等待空位',
  prior_submitter: '本任务作者（写过或提交过）不能复核',
  no_candidate: '该岗位与仓库下没有任何编制或员工',
  session_busy: '会话占用中或异常',
  held: '持有在办任务',
  assigned: '本轮已分配',
  track_mismatch: '岗位轨不匹配',
  model_slot: '模型槽位未解析或已漂移',
  quota: '订阅额度或健康冷却中',
  provider_capacity: '订阅并发已满',
  seat_full: '编制席位已满',
  def_disabled: '编制已停用',
  off_hours: '不在员工定义的工作时间',
  wake_failed: '派工未能唤醒或创建会话，下一轮重试',
  unknown: '状态或贡献者历史读取失败，不能判定（不视为忙），恢复后自动重判',
  probe_busy: '单次探测会话占用中（冷却已过，探测结束前不派其他会话）',
};

const OWNER: Record<BlockCode, RecoveryAuthority> = {
  provider_retry: 'system',
  factory_wait: 'system',
  paused: 'owner', budget: 'owner', resources: 'owner', memory_pressure: 'system', disk_space: 'owner', max_running: 'owner', prior_submitter: 'owner', no_candidate: 'owner',  session_busy: 'owner', held: 'owner', assigned: 'owner', track_mismatch: 'owner', model_slot: 'owner',
  quota: 'owner', provider_capacity: 'owner', seat_full: 'owner', def_disabled: 'owner', off_hours: 'system', wake_failed: 'owner', unknown: 'owner', probe_busy: 'owner',
};

const RECOVERY: Record<BlockCode, string> = {
  provider_retry: '等待本任务冷却或切换预算恢复；不会绕过已有派工屏障',
  factory_wait: '等待 Factory 空闲后自动派工；额度耗尽后回退其他合格员工',
  paused: '老板解除全局暂停',
  budget: '老板充值，或等待额度恢复',
  resources: '检查宿主机内存和磁盘，等待对应水位恢复',
  memory_pressure: '降低进程与数据库缓存占用，等待内存压力恢复；无需清理磁盘',
  disk_space: '清理宿主机磁盘，等待空闲磁盘恢复',
  max_running: '等待在办会话结束，或老板调高 max_running',
  prior_submitter: '老板增补独立复核人选（编制扩容或新员工），不能由作者自验',
  no_candidate: '老板为该岗位或仓库增加编制或员工',
  session_busy: '等待在办任务完成或租约到期',
  held: '等待在办任务完成或租约到期',
  assigned: '下一轮派工自动处理',
  track_mismatch: '老板调整编制轨或任务轨',
  model_slot: '等待模型槽位刷新，或老板检查订阅',
  quota: '等待订阅额度或健康恢复；老板可充值',
  provider_capacity: '等待在办任务释放该订阅并发',
  seat_full: '老板扩编（maxInstances）或等待席位释放',
  def_disabled: '老板重新启用编制或更换编制',
  off_hours: '到工作时间后自动派工，或老板调整工作时间',
  wake_failed: '检查 Paseo 会话与插件日志，下一轮自动重试',
  unknown: '检查 Paseo 插件、运行时日志与审计读取，恢复后自动重判',
  probe_busy: '等待单次探测会话结束，探测结果决定恢复或再次冷却',
};

const NEXT: Record<BlockCode, string> = {
  provider_retry: '冷却期限到达后重新评估合格供应商',
  factory_wait: 'Factory 空闲或额度状态变化',
  paused: '全局暂停解除',
  budget: '额度恢复或老板充值',
  resources: '宿主机水位恢复',
  memory_pressure: '宿主机内存压力恢复',
  disk_space: '宿主机空闲磁盘恢复',
  max_running: '在办会话数低于上限',
  prior_submitter: '出现独立候选人选',
  no_candidate: '新增编制或员工',
  session_busy: '候选会话空闲',
  held: '在办租约结束或任务完成',
  assigned: '下一轮派工',
  track_mismatch: '编制轨或任务轨调整',
  model_slot: '模型槽位解析',
  quota: '订阅额度或健康恢复',
  provider_capacity: '订阅并发释放',
  seat_full: '编制席位释放或扩编',
  def_disabled: '编制重新启用',
  off_hours: '进入工作时间',
  wake_failed: '下一轮唤醒成功',
  unknown: '状态与审计读取恢复',
  probe_busy: '探测会话结束',
};

/** The source each code is read from. Stable strings: the roster, the cards and the brief show them as they are. */
const BASIS: Record<BlockCode, string> = {
  provider_retry: 'task.provider_failures（明确终止回合，按 delivery 去重）',
  factory_wait: 'tick:factory-queue',
  paused: 'tick:global-gate', budget: 'tick:global-gate', resources: 'tick:global-gate', memory_pressure: 'host:memory', disk_space: 'host:disk', max_running: 'tick:global-gate', prior_submitter: 'contribution-audit',  no_candidate: 'tick:staffing-pool', session_busy: 'paseo:session-status', held: 'tick:staffing-pool', assigned: 'tick:staffing-pool',
  track_mismatch: 'tick:staffing-pool', model_slot: 'tick:model-slots',
  quota: 'tick:quota-rows', provider_capacity: 'tick:quota-rows', seat_full: 'tick:staffing-pool',
  def_disabled: 'tick:workforce-defs', off_hours: 'tick:workforce-defs', wake_failed: 'tick:wake', unknown: 'read:state-or-audit', probe_busy: 'tick:provider-health',
};

/** Recovery actions per code. Only the ones with a tool are executable; the rest name who must act outside the system. */
const ACTIONS: Record<BlockCode, RecoveryAction[]> = {
  provider_retry: [{ authority: 'system', label: '预算或冷却到期后自动重判', executable: false }],
  factory_wait: [{authority:'system',label:'等待 Factory 空闲后自动重试；队列之外的任务可分流',executable:false}],
  paused: [{ authority: 'owner', label: '老板解除全局暂停', executable: false }],
  budget: [{ authority: 'owner', label: '老板充值，或等待额度恢复', executable: false }],
  resources: [{ authority: 'owner', label: '检查宿主机内存和磁盘，等待对应水位恢复', executable: false }],
  memory_pressure: [{authority:'system',label:'降低内存占用，压力恢复后自动重试',executable:false}],
  disk_space: [{authority:'owner',label:'清理磁盘，空闲磁盘恢复后自动重试',executable:false}],
  max_running: [{ authority: 'owner', label: '等待在办会话结束，或老板调高 max_running', executable: false }],
  prior_submitter: [{ authority: 'owner', label: '老板用 def_ensure 增补独立复核编制，或新增员工', tool: 'def_ensure', executable: true }],
  no_candidate: [{ authority: 'owner', label: '老板用 def_ensure 为该岗位与仓库增加编制', tool: 'def_ensure', executable: true }],
  session_busy: [{ authority: 'owner', label: '等待在办任务完成或租约到期', executable: false }],
  held: [{ authority: 'owner', label: '等待在办任务完成或租约到期', executable: false }],
  assigned: [{ authority: 'owner', label: '下一轮派工自动处理', executable: false }],
  track_mismatch: [{ authority: 'owner', label: '老板用 def_ensure 调整编制轨', tool: 'def_ensure', executable: true }],
  model_slot: [{ authority: 'owner', label: '等待模型槽位刷新，或老板检查订阅', executable: false }],
  quota: [{ authority: 'owner', label: '老板充值，或等待额度与健康恢复', executable: false }],
  provider_capacity: [{ authority: 'owner', label: '等待在办任务释放该订阅并发', executable: false }],
  seat_full: [{ authority: 'owner', label: '老板用 def_ensure 调高 maxInstances 扩编', tool: 'def_ensure', executable: true }],
  def_disabled: [{ authority: 'owner', label: '老板用 def_ensure 重新启用编制', tool: 'def_ensure', executable: true }],
  off_hours: [{ authority: 'system', label: '到工作时间后自动派工', executable: false }, { authority: 'owner', label: '老板在员工定义里调整工作时间', tool: 'def_ensure', executable: true }],
  wake_failed: [{ authority: 'owner', label: '检查 Paseo 会话与插件日志，下一轮自动重试', executable: false }],
  unknown: [{ authority: 'owner', label: '检查 Paseo 插件、运行时日志与审计读取，恢复后自动重判', executable: false }],
  probe_busy: [{ authority: 'owner', label: '等待单次探测会话结束', executable: false }],
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
 * does a reviewer whose role, home, track or def rules out new work (those need an owner edit). A legal reuse
 * reviewer or a spare seat (a reviewer def with room for a new instance, even when its provider is in quota or at its
 * concurrency cap) keeps the path open. With no spare seat, one legal reviewer is reserved: the execute pool must not pick it,
 * so the task keeps a reviewer who did not submit it. Nothing here creates a lease.
 */
export function reviewPlanOf(pool: readonly ReviewPoolEntry[]): ReviewPlan {
  const legalEntries = pool.filter(entry => entry.kind === 'reuse' && (entry.eligible || (entry.code !== undefined && CAPACITY.has(entry.code))));
  const legal = legalEntries.map(entry => entry.key).sort();
  const spareSeat = pool.some(entry => entry.kind === 'spawn' && (entry.eligible || entry.code === 'quota' || entry.code === 'provider_capacity'));
  const eligibleNow = legalEntries.filter(entry => entry.eligible).map(entry => entry.key).sort();
  const reserve = !spareSeat && legal.length > 0 ? (eligibleNow[0] ?? legal[0]) : undefined;
  return { feasible: legal.length > 0 || spareSeat, legal, spareSeat, reserve };
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

/** Stable key for one owner-action episode: task, phase, episode start (ms) and reason. */
export function ownerActionKey(taskId: string, phase: string, since: number, reason: string): string {
  return `${taskId}:${phase}:${since}:${reason}`;
}

/** The distinct owner-facing reasons of a group's candidates, sorted, so a repeated tick reads the same. */
const detailsOf = (list: readonly EvaluatedEntry[]): string =>
  [...new Set(list.map(entry => entry.reason).filter((r): r is string => r !== undefined))].sort().join('；');

/**
 * Owner-facing text of one reason. Quota, seat and prior-submitter reasons read their candidates, so the verdict states the facts it
 * rests on: a prior-submitter conflict names its source task and excluded employee, and an unreadable history names itself.
 */
function reasonText(code: BlockCode, list: readonly EvaluatedEntry[], until: string | undefined, home: string): string {
  if (code === 'provider_retry') return `${detailsOf(list) || BLOCK_TEXT.provider_retry}，${until ? `恢复时间 ${until}` : '恢复时间未知'}`;
  if (code === 'quota') return `${BLOCK_TEXT.quota}，${until ? `恢复时间 ${until}` : '恢复时间未知'}`;
  if (code === 'seat_full') return detailsOf(list) || `${BLOCK_TEXT.seat_full}（仓库 ${repoName(home)}）`;
  if (code === 'unknown') return detailsOf(list) || BLOCK_TEXT[code];
  return BLOCK_TEXT[code];
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
      const until = code === 'quota' || code === 'provider_retry' ? quotaUntil(list) : undefined;
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
    taskId: input.taskId, title: input.title, phase: input.phase, role: input.role, home: input.home,
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
  const recovery = verdict.reasons.map(reason => `${reason.owner === 'system' ? '系统' : '老板'}：${reason.recovery}`).join('；');
  return `${verdict.summary}。自 ${verdict.since ?? verdict.checkedAt} 起等待。原因：${reasons}。下一触发：${next || '待定'}。处理：${recovery}。`;
}

/** Who a chain root is attached to: the current holder, the submitters and reviewers from the audit history. */
