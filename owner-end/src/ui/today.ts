/**
 * 首页「等你决定」队列：把分散在需求、任务、派工消息里需要老板处理的事项合并成一列。
 * 纯函数，只读页面已经在读的数据，不新增接口；排序：受阻在前，其次等你确认，再其次扣住的消息，同类按时间新到旧。
 */
import type { RuntimeDashboard, RuntimePendingMessage } from '../../../src/runtime-dashboard.ts';
import type { Requirement } from '../../../src/iteration/requirements.ts';
import { nextStep } from './iteration.ts';
import { hrefOf, taskIdOf } from './model.ts';

export type DecisionKind = 'blocked' | 'confirm' | 'held';

export interface DecisionItem {
  key: string;
  kind: DecisionKind;
  /** 状态点的含义：blocked 红、decide 琥珀。 */
  tone: 'blocked' | 'decide';
  label: string;
  title: string;
  reason: string;
  projectId?: string;
  at?: number;
  href: string;
  action: string;
}

export interface TaskLike {
  id?: unknown;
  title?: string;
  state?: string;
  updated_at?: unknown;
  [key: string]: unknown;
}

const timeOf = (v: unknown): number | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  const n = typeof v === 'number' ? v : new Date(String(v)).getTime();
  return Number.isFinite(n) ? n : undefined;
};

const RANK: Record<DecisionKind, number> = { blocked: 0, confirm: 1, held: 2 };

export function decisionQueue(input: {
  requirements?: ReadonlyArray<Requirement & { stage?: string }>;
  tasks?: readonly TaskLike[];
  dashboard?: RuntimeDashboard;
}): DecisionItem[] {
  const out: DecisionItem[] = [];
  for (const r of input.requirements ?? []) {
    const step = nextStep(r, r.stage);
    if (!step.owner || (step.tone !== 'decide' && step.tone !== 'blocked')) continue;
    const blocked = step.tone === 'blocked';
    out.push({
      key: `req:${r.id}`,
      kind: blocked ? 'blocked' : 'confirm',
      tone: blocked ? 'blocked' : 'decide',
      label: blocked ? '需求受阻' : '待确认开工',
      title: r.title,
      reason: blocked
        ? (r.execution_error || r.planning_error || step.text)
        : step.text === '等你确认开工' ? `修订 ${r.revision} 已整理好，确认后锁定并开工` : step.text,
      projectId: r.project,
      at: timeOf(r.updated_at),
      href: hrefOf('requirements', r.id),
      action: blocked ? '查看原因' : '去确认',
    });
  }

  // 员工报告的受阻原因按任务归并到任务条目上。
  const reasons = new Map<string, { reason: string; project?: string }>();
  for (const a of input.dashboard?.agents ?? []) {
    if (a.taskId && a.blockedReason) reasons.set(a.taskId, { reason: a.blockedReason, project: a.project?.id });
  }
  for (const t of input.tasks ?? []) {
    if (t.state !== 'blocked') continue;
    const id = taskIdOf(t);
    const found = reasons.get(id);
    out.push({
      key: `task:${id}`,
      kind: 'blocked',
      tone: 'blocked',
      label: '任务受阻',
      title: t.title || id,
      reason: found?.reason ?? '员工报告受阻，打开任务查看原因与证据',
      projectId: found?.project,
      at: timeOf(t.updated_at),
      href: hrefOf('tasks', id),
      action: '查看',
    });
  }

  const held = new Map<string, { message: RuntimePendingMessage; project?: string }>();
  for (const p of input.dashboard?.projects ?? []) {
    for (const m of p.pendingMessages) if (m.hold) held.set(m.messageId, { message: m, project: p.id });
  }
  for (const a of input.dashboard?.agents ?? []) {
    for (const m of a.pendingMessages ?? []) if (m.hold && !held.has(m.messageId)) held.set(m.messageId, { message: m, project: a.project?.id });
  }
  for (const { message, project } of held.values()) {
    out.push({
      key: `msg:${message.messageId}`,
      kind: 'held',
      tone: 'decide',
      label: '消息已扣住',
      title: message.title,
      reason: '你扣住的派工消息还没有发出，可以放行或改写后再发',
      projectId: project,
      href: hrefOf('messages'),
      action: '去处理',
    });
  }

  return out.sort((a, b) => RANK[a.kind] - RANK[b.kind] || (b.at ?? 0) - (a.at ?? 0));
}

/** 已暂停的需求不算紧急，只在首页底部提示数量。 */
export const pausedCount = (requirements: readonly Requirement[] | undefined): number =>
  (requirements ?? []).filter((r) => r.state === 'paused').length;

/** 项目的状态点：有受阻 → blocked；有人在工作 → running；否则 idle。 */
export function projectTone(blocked: number, working: number): 'blocked' | 'running' | 'idle' {
  if (blocked > 0) return 'blocked';
  return working > 0 ? 'running' : 'idle';
}

/** 友好时间：今天 HH:MM / 昨天 HH:MM / M月D日。now 由调用方给出，便于测试。 */
export function friendlyTime(at: number | undefined, now: number): string {
  if (at === undefined || !Number.isFinite(at)) return '';
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const day = (t: number) => { const x = new Date(t); return new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime(); };
  const diff = Math.round((day(now) - day(at)) / 86_400_000);
  if (diff === 0) return `今天 ${hm}`;
  if (diff === 1) return `昨天 ${hm}`;
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}
