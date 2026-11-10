/**
 * 需求与反馈的展示规则：状态文案、下一步、阻止确认的原因、里程碑。纯函数，不依赖 DOM，供 bun test 测试。
 * 只 import 类型，不把服务端模块打进页面。
 */
import type { ProductPolicy, Requirement, RequirementState } from '../../../src/iteration/requirements.ts';

/** 状态色的固定含义：decide 等老板处理；progress Agent 推进中；blocked 受阻或失败；done 完成或上线；neutral 暂停、关闭等。 */
export type Tone = 'decide' | 'progress' | 'blocked' | 'done' | 'neutral';

export const REQUIREMENT_STATE: Record<RequirementState, { label: string; tone: Tone }> = {
  draft: { label: '草稿', tone: 'decide' },
  pending: { label: '待确认', tone: 'decide' },
  queued: { label: '已确认 · 规划中', tone: 'progress' },
  implementing: { label: '实施中', tone: 'progress' },
  release_pending: { label: '上线核验中', tone: 'progress' },
  released: { label: '已上线', tone: 'done' },
  paused: { label: '已暂停', tone: 'neutral' },
  rejected: { label: '已拒绝', tone: 'neutral' },
  merged: { label: '已归并', tone: 'neutral' },
};

export function stateOf(state: string): { label: string; tone: Tone } {
  return REQUIREMENT_STATE[state as RequirementState] ?? { label: state || '未知状态', tone: 'neutral' };
}

export interface RequirementGroup { id: string; label: string; states?: readonly string[] }

/** 需求池的状态分组。顺序即筛选栏顺序。 */
export const REQUIREMENT_GROUPS: readonly RequirementGroup[] = [
  { id: 'all', label: '全部' },
  { id: 'confirm', label: '待确认', states: ['draft', 'pending'] },
  { id: 'active', label: '实施中', states: ['queued', 'implementing'] },
  { id: 'release', label: '上线核验', states: ['release_pending'] },
  { id: 'released', label: '已上线', states: ['released'] },
  { id: 'paused', label: '已暂停', states: ['paused'] },
  { id: 'closed', label: '已关闭', states: ['rejected', 'merged'] },
];

export function inGroup(state: string, group: string): boolean {
  const found = REQUIREMENT_GROUPS.find(g => g.id === group);
  return !found?.states || found.states.includes(state);
}

export function groupCounts(rows: ReadonlyArray<{ state: string }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const g of REQUIREMENT_GROUPS) out[g.id] = rows.filter(r => inGroup(r.state, g.id)).length;
  return out;
}

export const PRIORITY_TEXT: Record<number, string> = { 0: 'P0 紧急', 1: 'P1 高', 2: 'P2 中', 3: 'P3 低' };
export const priorityText = (p: number): string => PRIORITY_TEXT[p] ?? `P${p}`;

/** 执行记录 stage（src/iteration/execution.ts）。 */
export const EXECUTION_STAGE: Record<string, { label: string; tone: Tone }> = {
  running: { label: '执行中', tone: 'progress' },
  blocked: { label: '执行受阻', tone: 'blocked' },
  deploying: { label: 'GitHub 自动部署中', tone: 'progress' },
  verifying: { label: '合并与上线核验中', tone: 'progress' },
  awaiting_release: { label: '等待执行端接续', tone: 'progress' },
  release_not_configured: { label: '等待执行端接续', tone: 'progress' },
  awaiting_evidence: { label: '等待部署证据', tone: 'blocked' },
  released: { label: '已上线', tone: 'done' },
};
export const stageOf = (stage: string | undefined): { label: string; tone: Tone } | undefined =>
  stage ? EXECUTION_STAGE[stage] ?? { label: stage, tone: 'neutral' } : undefined;

export interface NextStep { text: string; tone: Tone; /** 是否需要老板动手。 */ owner: boolean }

/** 列表「下一步」列：老板一眼看出谁在等谁。stage 只在已读取执行记录时传入。 */
export function nextStep(r: Pick<Requirement, 'state' | 'acceptance' | 'planning_error' | 'execution_error'>, stage?: string): NextStep {
  switch (r.state) {
    case 'draft':
    case 'pending':
      return r.acceptance?.trim()
        ? { text: '等你确认开工', tone: 'decide', owner: true }
        : { text: '补充验收标准后确认', tone: 'decide', owner: true };
    case 'queued':
      return r.planning_error
        ? { text: '规划失败，可重试', tone: 'blocked', owner: true }
        : { text: 'Agent 正在拆解任务', tone: 'progress', owner: false };
    case 'implementing':
      if (r.execution_error || stage === 'blocked') return { text: '执行受阻，需要查看', tone: 'blocked', owner: true };
      return { text: 'Agent 执行中', tone: 'progress', owner: false };
    case 'release_pending':
      if (r.execution_error || stage === 'blocked') return { text: '合并或上线核验受阻', tone: 'blocked', owner: true };
      if (stage === 'awaiting_release' || stage === 'release_not_configured') return { text: '等待执行端接续', tone: 'progress', owner: false };
      if (stage === 'awaiting_evidence') return { text: '等待部署证据', tone: 'blocked', owner: false };
      if (stage === 'deploying' || stage === 'verifying') return { text: stageOf(stage)!.label, tone: 'progress', owner: false };
      return { text: '合并与上线核验中', tone: 'progress', owner: false };
    case 'released': return { text: '已上线', tone: 'done', owner: false };
    case 'paused': return { text: '已暂停，可恢复', tone: 'neutral', owner: true };
    case 'rejected': return { text: '已拒绝，可修改后重提', tone: 'neutral', owner: false };
    case 'merged': return { text: '已并入其他需求', tone: 'neutral', owner: false };
    default: return { text: '—', tone: 'neutral', owner: false };
  }
}

/** 流程步骤：整理 → 确认 → 规划 → 实施 → 发布 → 上线。返回当前所在步骤下标；已上线返回 6（全部完成）。 */
export const FLOW_STEPS = ['整理需求', '老板确认', 'Agent 规划', '执行与验收', 'GitHub 部署与核验', '已上线'] as const;
export function flowIndex(state: string, pausedFrom?: string): number {
  const s = state === 'paused' ? pausedFrom ?? 'queued' : state;
  switch (s) {
    case 'draft': return 0;
    case 'pending': case 'rejected': return 1;
    case 'queued': return 2;
    case 'implementing': return 3;
    case 'release_pending': return 4;
    case 'released': return 6;
    default: return 1;
  }
}

export const isEditable = (state: string): boolean => ['draft', 'pending', 'rejected'].includes(state);
export const isApprovable = (state: string): boolean => ['draft', 'pending'].includes(state);
export const isPausable = (state: string): boolean => ['queued', 'implementing', 'release_pending'].includes(state);

/** 「确认开工」被禁用的原因；空数组表示可以确认。 */
export function approveBlockers(r: Pick<Requirement, 'state' | 'acceptance'>, policy: ProductPolicy | undefined, dirty: boolean, policyLoaded = true): string[] {
  const out: string[] = [];
  if (!isApprovable(r.state)) out.push('当前状态不能确认开工');
  if (dirty) out.push('有未保存的修改，请先保存');
  if (!r.acceptance?.trim()) out.push('请先填写验收标准');
  if (!policyLoaded) out.push('正在读取产品设置');
  else if (!policy?.enabled) out.push('该产品未启用迭代流程（在产品设置中启用）');
  return out;
}

/** 验收标准按行拆成可逐条核对的条目；去掉常见的列表前缀。 */
export function acceptanceItems(text: string | undefined): string[] {
  return (text ?? '').split(/\r?\n/).map(line => line.trim().replace(/^([-*•·]|\d+[.、)）]|\[[ xX]?\])\s*/, '').trim()).filter(Boolean);
}

export interface TaskLike { state?: string }
export interface TaskProgress { done: number; total: number; active: number; blocked: number; percent: number }
/** 作废的任务不计入总数。 */
export function taskProgress(tasks: readonly TaskLike[]): TaskProgress {
  const live = tasks.filter(t => t.state !== 'void');
  const done = live.filter(t => t.state === 'done').length;
  const active = live.filter(t => t.state === 'doing' || t.state === 'review').length;
  const blocked = live.filter(t => t.state === 'blocked').length;
  return { done, total: live.length, active, blocked, percent: live.length ? Math.round((done / live.length) * 100) : 0 };
}

export interface Milestone { key: 'approved' | 'tasks' | 'released'; label: string; done: boolean; detail: string }

/**
 * 三个不能混淆的里程碑：需求已确认（老板确认了某个修订）、任务已完成（执行与验收结束）、产品已上线（发布证据齐全）。
 */
export function milestones(r: Pick<Requirement, 'state' | 'approved_revision' | 'revision'>, tasks: readonly TaskLike[], releasedSha?: string): Milestone[] {
  const approved = r.approved_revision != null || ['queued', 'implementing', 'release_pending', 'released'].includes(r.state);
  const p = taskProgress(tasks);
  const tasksDone = r.state === 'released' || (p.total > 0 && p.done === p.total);
  const released = r.state === 'released';
  return [
    { key: 'approved', label: '需求已确认', done: approved, detail: approved ? `修订 ${r.approved_revision ?? r.revision} 已锁定` : '等你确认开工' },
    { key: 'tasks', label: '任务已完成', done: tasksDone, detail: p.total ? `${p.done} / ${p.total} 项完成${p.blocked ? `，${p.blocked} 项受阻` : ''}` : tasksDone ? '已全部验收' : approved ? '等待 Agent 拆解任务' : '确认后开始' },
    { key: 'released', label: '产品已上线', done: released, detail: released ? releasedSha ? `发布提交 ${releasedSha}` : '已上线' : r.state === 'release_pending' ? '等待生产证据及 QA 验收' : '尚未上线' },
  ];
}

export const FEEDBACK_STATE: Record<string, { label: string; tone: Tone }> = {
  new: { label: '待整理', tone: 'neutral' },
  processing: { label: '整理中', tone: 'progress' },
  linked: { label: '已形成需求', tone: 'done' },
  dismissed: { label: '已忽略', tone: 'neutral' },
  failed: { label: '整理失败', tone: 'blocked' },
};
export const feedbackStateOf = (s: string) => FEEDBACK_STATE[s] ?? { label: s, tone: 'neutral' as Tone };
export const FEEDBACK_CATEGORY: Record<string, string> = { bug: '问题', feature: '功能建议', question: '咨询', noise: '无效' };

export interface RequirementDraft { title: string; problem: string; acceptance: string; priority: number }
export const EMPTY_DRAFT: RequirementDraft = { title: '', problem: '', acceptance: '', priority: 2 };
export const draftFrom = (r: RequirementDraft): RequirementDraft => ({ title: r.title, problem: r.problem, acceptance: r.acceptance, priority: r.priority });
export const sameDraft = (a: RequirementDraft, b: RequirementDraft): boolean =>
  a.title === b.title && a.problem === b.problem && a.acceptance === b.acceptance && a.priority === b.priority;
export const LIMITS = { title: 200, problem: 6000, acceptance: 3000 } as const;

/** 需求表单校验：与服务端 requirementContent 的限制一致。 */
export function validateRequirement(d: RequirementDraft): Partial<Record<keyof RequirementDraft, string>> {
  const out: Partial<Record<keyof RequirementDraft, string>> = {};
  if (!d.title.trim()) out.title = '请填写标题';
  else if (d.title.length > LIMITS.title) out.title = `标题不超过 ${LIMITS.title} 字`;
  if (!d.problem.trim()) out.problem = '请描述要解决的问题';
  else if (d.problem.length > LIMITS.problem) out.problem = `问题描述不超过 ${LIMITS.problem} 字`;
  if (d.acceptance.length > LIMITS.acceptance) out.acceptance = `验收标准不超过 ${LIMITS.acceptance} 字`;
  return out;
}

/** 执行任务状态的颜色含义。 */
export function taskTone(state: string | undefined): Tone {
  switch (state) {
    case 'doing': case 'review': return 'progress';
    case 'blocked': return 'blocked';
    case 'done': return 'done';
    default: return 'neutral';
  }
}
