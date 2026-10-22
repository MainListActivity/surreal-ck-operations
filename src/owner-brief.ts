import type { DispatchBlockedRow } from './dispatcher/dispatch-list.ts';

/** What is waiting on the owner (a gate to approve or a question to answer) and what it holds up. */
export interface WaitingItem {
  taskId: string;
  version: number;
  kind: 'gate' | 'question';
  title: string;
  goal?: string;
  sinceMs: number;
  /** Non-terminal tasks that transitively depend on this one. */
  downstream: number;
}

/** How many of a role's enabled seats can take work right now, and why the others cannot. */
export interface RoleCapacity { role: string; total: number; usable: number; down: string[] }

export interface BriefData {
  date: string;
  waiting: Array<WaitingItem & { hours: number }>;
  stuck: Array<{ taskId: string; title: string; reason: string }>;
  last24h: { done: number; returned: number; rolledBack: number; rejected: number; retired: number };
  goals: Array<{ title: string; days: number }>;
  resources: string[];
  capacity: RoleCapacity[];
  /** Employee instances opened/closed in the last 24h; a high lost-claim count means the scheduler is thrashing. */
  churn: { created: number; retired: number; claimLost: number };
  /** The latest pass's blocked work: how many items are blocked, and the first rows the brief names (most urgent first). */
  dispatchBlocked: { total: number; rows: DispatchBlockedRow[] };
}

/** Hours of waiting at which a reminder is (re)raised; after the last step a new one every 24h. */
export const AGING_STEPS_HOURS = [4, 24, 72] as const;
const LAST_STEP = AGING_STEPS_HOURS[AGING_STEPS_HOURS.length - 1];

export function agingLevel(hours: number): number {
  const passed = AGING_STEPS_HOURS.filter(step => hours >= step).length;
  return passed < AGING_STEPS_HOURS.length ? passed : AGING_STEPS_HOURS.length + Math.floor((hours - LAST_STEP) / 24);
}

export const formatAge = (hours: number): string => hours < 48 ? `${Math.max(1, Math.round(hours))} 小时` : `${(hours / 24).toFixed(1)} 天`;

const short = (text: string, max: number) => text.length > max ? `${text.slice(0, max - 1)}…` : text;

export function agingText(item: WaitingItem, hours: number): string {
  const what = item.kind === 'gate' ? '待你批准的关口' : '待你回答的问题';
  const holds = item.downstream > 0 ? `，卡住下游 ${item.downstream} 个任务` : '';
  const goal = item.goal ? `（目标：${short(item.goal, 30)}）` : '';
  return `已等你 ${formatAge(hours)}：${what}《${short(item.title, 60)}》${goal}${holds}。任务 ${item.taskId}。查看：company owner inbox`;
}

const PHASE_NAME = { execute: '执行', review: '复核' } as const;
const WORKFLOW_NAME = { ready: '就绪', doing: '在办无人持有', review: '待复核' } as const;

/** One blocked item as the brief names it: what, which phase and workflow state, every reason, the wait, who acts, what unblocks it. */
export function dispatchLine(row: DispatchBlockedRow): string {
  const reasons = row.reasons.map(reason => reason.text).join('；') || row.summary;
  const owner = row.reasons.some(reason => reason.owner === 'owner') ? '老板'
    : row.reasons.some(reason => reason.owner === 'system') ? '系统' : 'gm';
  const next = [...new Set(row.reasons.map(reason => reason.nextTrigger))].join('；');
  return `《${short(row.title, 40)}》（${PHASE_NAME[row.phase]}·${WORKFLOW_NAME[row.workflowState]}）：${reasons}；已等 ${row.waitingMinutes} 分钟；负责：${owner}；下一触发：${next || '待定'}`;
}

export function renderBrief(data: BriefData): { summary: string; text: string } {
  const oldest = data.waiting.reduce((max, item) => Math.max(max, item.hours), 0);
  const summary = `每日简报 ${data.date}：待你处理 ${data.waiting.length} 项${data.waiting.length ? `（最久 ${formatAge(oldest)}）` : ''}｜异常卡滞 ${data.stuck.length}｜近24小时完成 ${data.last24h.done}`;
  const lines = [summary, ''];
  lines.push(data.waiting.length ? '【等你处理】' : '【等你处理】无');
  for (const item of [...data.waiting].sort((a, b) => b.hours - a.hours)) {
    lines.push(`- ${item.kind === 'gate' ? '批准' : '回答'}《${short(item.title, 50)}》已等 ${formatAge(item.hours)}${item.downstream ? `，卡住 ${item.downstream} 个下游` : ''}`);
  }
  if (data.stuck.length) {
    lines.push('', '【异常卡滞】');
    for (const item of data.stuck.slice(0, 8)) lines.push(`- ${short(item.title, 50)}：${item.reason}（${item.taskId.slice(0, 8)}）`);
  }
  lines.push('', `【近24小时】完成 ${data.last24h.done}｜退回 ${data.last24h.returned}｜老板驳回 ${data.last24h.rejected}｜作废 ${data.last24h.retired}${data.last24h.rolledBack ? `｜通道回滚 ${data.last24h.rolledBack}（系统换会话，不算退回）` : ''}`);
  if (data.goals.length) {
    lines.push('', '【在办目标】');
    for (const goal of data.goals.slice(0, 8)) lines.push(`- ${short(goal.title, 40)}（已 ${goal.days} 天）`);
  }
  // Every blocked item of the latest pass is named here, with its own reason and owner. The brief does not count notices.
  if (data.dispatchBlocked.total) {
    lines.push('', `【无法派工】共 ${data.dispatchBlocked.total} 项（同一份结论，见岗位页面）`);
    for (const row of data.dispatchBlocked.rows) lines.push(`- ${dispatchLine(row)}`);
    const rest = data.dispatchBlocked.total - data.dispatchBlocked.rows.length;
    if (rest > 0) lines.push(`- 另有 ${rest} 项未逐条列出，见岗位页面`);
  }
  const short_ = data.capacity.filter(c => c.usable < c.total);
  if (short_.length || data.resources.length) {
    lines.push('', '【产能】');
    for (const c of short_) lines.push(`- ${c.role}：${c.usable === 0 ? '当前没有任何可用编制' : `可用编制 ${c.usable}/${c.total}`}（${c.down.join('；')}）`);
    for (const item of data.resources) lines.push(`- ${item}`);
  }
  lines.push('', `【员工流动】近24小时新建实例 ${data.churn.created}，退役 ${data.churn.retired}${data.churn.claimLost ? `（认领失败 ${data.churn.claimLost}）` : ''}`);
  return { summary, text: lines.join('\n') };
}

export const localDate = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
