import type {
  RuntimeAgentView,
  RuntimeDashboard,
  RuntimePendingMessage,
  RuntimeTransfer,
} from '../../../src/runtime-dashboard.ts';
import type { RuntimeEstimate } from '../../../src/runtime-timing.ts';
export { employeeProgress } from '../../../src/runtime-projects.ts';

export function onDuty(a: RuntimeAgentView): boolean {
  return (
    a.taskState === 'blocked' ||
    a.state === 'running' ||
    (a.state === 'waiting' && !!a.taskId) ||
    a.state === 'error' ||
    (a.state === 'unknown' && !!a.taskId)
  );
}
export function roomId(a: RuntimeAgentView) {
  return a.project?.id ?? 'company-unassigned';
}
export function roomAgents(data: RuntimeDashboard, project: string) {
  return data.agents
    .filter((a) => roomId(a) === project && onDuty(a))
    .sort((a, b) => a.id.localeCompare(b.id));
}
export interface RoomHandoffReference {
  id: string;
  agent?: RuntimeAgentView;
  name: string;
  status: string;
}
export interface RoomHandoffs {
  transfers: RuntimeTransfer[];
  references: RoomHandoffReference[];
}
/** Delivered work keeps its employee identity even after that employee leaves the room. */
export function roomHandoffs(
  data: RuntimeDashboard,
  projectId: string,
  active: Set<string>,
): RoomHandoffs {
  const present = new Map(roomAgents(data, projectId).map((agent) => [agent.id, agent]));
  const employees = new Map(data.agents.map((agent) => [agent.id, agent]));
  const latest = new Map<string, RuntimeTransfer>();
  for (const transfer of data.transfers) {
    if (
      !transfer.id?.trim() || !transfer.taskId?.trim() ||
      !transfer.from?.trim() || !transfer.to?.trim() ||
      transfer.from === transfer.to || !Number.isFinite(transfer.at)
    ) continue;
    const previous = latest.get(transfer.taskId);
    // Choose before room filtering: an older review must not reappear after rework.
    if (!previous || transfer.at > previous.at ||
        (transfer.at === previous.at && transfer.id.localeCompare(previous.id) > 0))
      latest.set(transfer.taskId, transfer);
  }
  const transfers = [...latest.values()]
    .filter((transfer) => [transfer.from, transfer.to].some((id) => {
      const agent = present.get(id);
      return agent && (agent.taskId === transfer.taskId || active.has(transfer.id));
    }))
    .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  const references = new Map<string, RoomHandoffReference>();
  for (const transfer of transfers) {
    for (const id of [transfer.from, transfer.to]) {
      if (present.has(id) || references.has(id)) continue;
      const agent = employees.get(id);
      references.set(id, {
        id,
        ...(agent ? { agent } : {}),
        name: agent?.name || `员工 ${id.slice(0, 8)}`,
        status: !agent ? '身份待补'
          : agent.state === 'unknown' ? '状态待确认'
          : onDuty(agent) && roomId(agent) !== projectId ? '其他项目'
          : '已离场',
      });
    }
  }
  return { transfers, references: [...references.values()] };
}
export const useAvatars = (count: number, focused: boolean) =>
  !focused && count > 4;
export function messagePreview(message: RuntimePendingMessage): string {
  const task = message.context?.files.find((f) => f.name === 'task.md')?.text;
  if (!task) return message.preview;
  // Task context is the work itself; the dispatch wrapper often only says “read task.md”.
  const context = task
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(
      (l) =>
        l &&
        !l.startsWith('#') &&
        !/^[-*]?\s*(任务号|ID|当前阶段|执行岗|复核岗|链路|项目|工作目录)[：:]/.test(
          l,
        ),
    )
    .slice(0, 4)
    .join(' ');
  return context || message.preview;
}
export function staffStatus(a: RuntimeAgentView): {
  text: string;
  kind: string;
} {
  if (a.state === 'unknown') return { text: '连接待确认', kind: 'unknown' };
  if (a.taskState === 'blocked') return { text: '受阻', kind: 'blocked' };
  if (a.state === 'error' || a.activity?.state === 'failed')
    return { text: '执行异常', kind: 'blocked' };
  if (a.activity && a.activity.state !== 'running')
    return {
      text: a.activity.state === 'canceled' ? '执行已停止' : '成果收尾中',
      kind: 'waiting',
    };
  if (a.state === 'waiting') return { text: '等待输入', kind: 'waiting' };
  if (a.state === 'running') return { text: '工作中', kind: 'working' };
  return { text: '待命', kind: 'idle' };
}
export function portraitIndex(
  a: Pick<RuntimeAgentView, 'role' | 'provider'>,
): number {
  if (a.role === 'product') return 0;
  if (a.role === 'engineering') return a.provider === 'factory-droid' ? 3 : 1;
  if (a.role === 'qa') return a.provider === 'factory-droid' ? 4 : 2;
  return 5;
}
export function finishText(
  estimate: RuntimeEstimate | undefined,
  at: number,
): string | undefined {
  if (
    estimate?.status !== 'estimated' ||
    !Number.isFinite(estimate.lowerSeconds) ||
    !Number.isFinite(estimate.upperSeconds)
  )
    return;
  const display = (seconds: number) => {
    const d = new Date(at + seconds * 1000),
      start = new Date(at);
    const time = d.toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    return (
      (d.toDateString() === start.toDateString()
        ? ''
        : `${d.getMonth() + 1}/${d.getDate()} `) + time
    );
  };
  const from = display(estimate.lowerSeconds!),
    to = display(estimate.upperSeconds!);
  return from === to ? `约 ${to} 结束` : `约 ${from}–${to} 结束`;
}
