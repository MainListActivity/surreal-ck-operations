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

/** execute: the implementer writes code. review: an independent reviewer accepts or returns. */
export type DispatchPhase = 'execute' | 'review';

/** Stable machine codes. The text is for owners; codes drive grouping, notices and auto-clear. */
export type BlockCode =
  | 'paused' | 'budget' | 'resources' | 'max_running'
  | 'implementer_mismatch' | 'implementer_unresolved' | 'author_recusal' | 'no_candidate'
  | 'session_busy' | 'held' | 'assigned' | 'credential_file' | 'track_mismatch' | 'model_slot'
  | 'quota' | 'provider_capacity' | 'seat_full' | 'def_disabled' | 'wake_failed' | 'unknown';

/** One staffing entry, reduced to what the evaluator reads. `key` is the employee id or `spawn:<def>`. */
export interface EvaluatedEntry {
  key: string;
  eligible: boolean;
  code?: BlockCode;
}

/** A gate that applies to the whole pass (paused, budget, resources, concurrency cap), not to one candidate. */
export interface GlobalBlock {
  code: BlockCode;
  text: string;
}

/** Who may take a recovery action: the manager (gm, with the manage capability) or the owner. */
export type RecoveryAuthority = 'gm' | 'owner';

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
  owner: 'gm' | 'owner';
  recovery: string;
  nextTrigger: string;
  /** The source the code was read from, so a reader can tell which fact the conclusion rests on (for example "contribution-audit"). */
  basis: string;
  /** Structured recovery actions with their authority; the text in `recovery` says the same in words. */
  actions: RecoveryAction[];
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
  /** Evaluation time, unix milliseconds. */
  checkedAt: number;
}

/** Codes that only an owner edit (task, roster, pool) can change; waiting never clears them. */
const PERMANENT: ReadonlySet<BlockCode> = new Set<BlockCode>([
  'author_recusal', 'implementer_mismatch', 'implementer_unresolved', 'track_mismatch',
  'credential_file', 'def_disabled', 'no_candidate',
]);

/** Owner-facing text per code. The staffing pool and the evaluator both read this table. */
export const BLOCK_TEXT: Record<BlockCode, string> = {
  paused: '全局暂停派工',
  budget: '订阅额度耗尽或限流',
  resources: '宿主机资源低于水位',
  max_running: '全局在办会话已达上限，等待空位',
  implementer_mismatch: '任务已绑定实现负责人，其他人不能接手代码',
  implementer_unresolved: '多个作者且无实现负责人，需经理指定',
  author_recusal: '本任务作者（写过或提交过）不能复核',
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
};

const OWNER: Record<BlockCode, 'gm' | 'owner'> = {
  paused: 'gm', budget: 'owner', resources: 'gm', max_running: 'gm',
  implementer_mismatch: 'gm', implementer_unresolved: 'gm', author_recusal: 'gm', no_candidate: 'gm',
  session_busy: 'gm', held: 'gm', assigned: 'gm', credential_file: 'gm', track_mismatch: 'gm', model_slot: 'gm',
  quota: 'owner', provider_capacity: 'gm', seat_full: 'gm', def_disabled: 'gm', wake_failed: 'gm', unknown: 'gm',
};

const RECOVERY: Record<BlockCode, string> = {
  paused: '经理解除全局暂停',
  budget: '老板充值，或等待额度恢复',
  resources: '清理宿主机磁盘或等待水位恢复',
  max_running: '等待在办会话结束，或经理调高 max_running',
  implementer_mismatch: '等待绑定的实现负责人可用，或经理用 implementer_takeover 显式接手',
  implementer_unresolved: '经理用 implementer_takeover 记录实现负责人',
  author_recusal: '经理增补独立复核人选（编制扩容或新员工），不能由作者自验',
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
};

const NEXT: Record<BlockCode, string> = {
  paused: '全局暂停解除',
  budget: '额度恢复或老板充值',
  resources: '宿主机水位恢复',
  max_running: '在办会话数低于上限',
  implementer_mismatch: '绑定实现负责人可派工，或经理接手',
  implementer_unresolved: '经理记录实现负责人',
  author_recusal: '出现独立候选人选',
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
};

/** The source each code is read from. Stable strings: the roster, the cards and the brief show them as they are. */
const BASIS: Record<BlockCode, string> = {
  paused: 'tick:global-gate', budget: 'tick:global-gate', resources: 'tick:global-gate', max_running: 'tick:global-gate',
  implementer_mismatch: 'contribution-audit', implementer_unresolved: 'contribution-audit', author_recusal: 'contribution-audit',
  no_candidate: 'tick:staffing-pool', session_busy: 'paseo:session-status', held: 'tick:staffing-pool', assigned: 'tick:staffing-pool',
  credential_file: 'tick:staffing-pool', track_mismatch: 'tick:staffing-pool', model_slot: 'tick:model-slots',
  quota: 'tick:quota-rows', provider_capacity: 'tick:quota-rows', seat_full: 'tick:staffing-pool',
  def_disabled: 'tick:workforce-defs', wake_failed: 'tick:wake', unknown: 'read:state-or-audit',
};

/** Recovery actions per code. Only the ones with a tool are executable; the rest name who must act outside the system. */
const ACTIONS: Record<BlockCode, RecoveryAction[]> = {
  paused: [{ authority: 'gm', label: '经理解除全局暂停', executable: false }],
  budget: [{ authority: 'owner', label: '老板充值，或等待额度恢复', executable: false }],
  resources: [{ authority: 'gm', label: '清理宿主机磁盘或等待水位恢复', executable: false }],
  max_running: [{ authority: 'gm', label: '等待在办会话结束，或经理调高 max_running', executable: false }],
  implementer_mismatch: [{ authority: 'gm', label: '经理用 implementer_takeover 显式接手', tool: 'implementer_takeover', executable: true }],
  implementer_unresolved: [{ authority: 'gm', label: '经理用 implementer_takeover 记录实现负责人', tool: 'implementer_takeover', executable: true }],
  author_recusal: [{ authority: 'gm', label: '经理用 def_ensure 增补独立复核编制，或新增员工', tool: 'def_ensure', executable: true }],
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
};

const PHASE_LABEL: Record<DispatchPhase, string> = { execute: '执行', review: '复核' };

const iso = (ms: number) => new Date(ms).toISOString();

/** A pass-wide gate with its owner-facing text. */
export const globalBlock = (code: BlockCode): GlobalBlock => ({ code, text: BLOCK_TEXT[code] });

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
  for (const gate of globals) addCandidate(gate.code, '*');
  const dispatchable = globals.length === 0 && entries !== undefined && eligibleCount > 0;
  const reasons: DispatchReason[] = dispatchable ? [] : [...grouped.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([code, candidates]) => ({
      code,
      text: BLOCK_TEXT[code],
      candidates: candidates.sort(),
      owner: OWNER[code],
      recovery: RECOVERY[code],
      nextTrigger: NEXT[code],
      basis: BASIS[code],
      actions: ACTIONS[code].map(action => ({ ...action })),
    }));
  // Pass-wide gates clear by themselves. A candidate list holding only owner-decision codes never does, and neither does an
  // unknown state: nobody can tell whether it will, so it is material at once.
  const materialCode = (code: BlockCode = 'unknown') => code === 'unknown' || PERMANENT.has(code);
  const feasible = dispatchable || (globals.length > 0
    ? globals.every(gate => !materialCode(gate.code))
    : entries !== undefined && entries.some(entry => !entry.eligible && !materialCode(entry.code)));
  const phase = PHASE_LABEL[input.phase];
  const summary = dispatchable
    ? `${input.title}：${phase}可派工`
    : `${input.title}：${phase}无法派工（${reasons.map(reason => reason.text).join('；') || '原因未知'}）`;
  const since = input.since ?? input.checkedAt;
  return {
    noticeKey: `dispatch-blocked:${input.taskId}:${input.phase}`,
    taskId: input.taskId, goalId: input.goalId, title: input.title, phase: input.phase, role: input.role, home: input.home,
    dispatchable, eligibleCount, reasons, feasible,
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
  const recovery = verdict.reasons.map(reason => `${reason.owner === 'gm' ? 'gm' : '老板'}：${reason.recovery}`).join('；');
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
export interface GoalRootFacts {
  /** Unfinished goal tasks and the task ids each one depends on. */
  dependencies: ReadonlyMap<string, readonly string[]>;
  titles: ReadonlyMap<string, string>;
  people: ReadonlyMap<string, GoalRootPeople>;
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
  /** Other blocked work behind the same goal, from this pass's verdicts. */
  others: number;
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
      waitingMinutes: root.waitingMinutes, since: root.since, others: list.length - 1, impact: behind.count,
      dependencyPath: behind.path.map(taskId => ({ taskId, title: titleOf(taskId) })),
      people: facts?.people.get(root.taskId) ?? NO_PEOPLE, reasons: root.reasons };
  });
}
