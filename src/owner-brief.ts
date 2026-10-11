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

export interface BriefData {
  date: string;
  waiting: Array<WaitingItem & { hours: number }>;
  stuck: Array<{ taskId: string; title: string; reason: string }>;
  last24h: { done: number; returned: number; rejected: number; retired: number };
  goals: Array<{ title: string; days: number }>;
  resources: string[];
  staffingAlerts: number;
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
  lines.push('', `【近24小时】完成 ${data.last24h.done}｜退回 ${data.last24h.returned}｜老板驳回 ${data.last24h.rejected}｜作废 ${data.last24h.retired}`);
  if (data.goals.length) {
    lines.push('', '【在办目标】');
    for (const goal of data.goals.slice(0, 8)) lines.push(`- ${short(goal.title, 40)}（已 ${goal.days} 天）`);
  }
  if (data.resources.length || data.staffingAlerts) {
    lines.push('', '【资源】');
    for (const item of data.resources) lines.push(`- ${item}`);
    if (data.staffingAlerts) lines.push(`- 有 ${data.staffingAlerts} 个岗位暂无可用员工（见提醒）`);
  }
  return { summary, text: lines.join('\n') };
}

export const localDate = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
