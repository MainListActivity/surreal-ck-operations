/**
 * Paseo 里运行的员工的动作流：从 Paseo 的时间线投影出与原生执行端相同形状的 AgentActivity。
 * 只取公开的助手文本和工具调用的一行摘要（paseoActionSummary）；reasoning、用户消息、工具输出都不取。
 */
import type { Surreal } from 'surrealdb';
import { ACTION_LIMIT, activityText, paseoActionSummary, type ActivityEvent, type AgentAction, type AgentActivity } from '../agent-activity.ts';
import type { RuntimeHost } from './host.ts';

interface Entry { timestamp?: string; turnId?: string; seqEnd: number; item: Record<string, unknown> & { type: string } }

/** 一轮时间线 → 动作流。entries 已按本轮筛过；running 表示这一轮还在进行。 */
export function activityFromTimeline(agent: string, turn: string, entries: Entry[], running: boolean, now: number): AgentActivity | undefined {
  const rows = [...entries].sort((a, b) => a.seqEnd - b.seqEnd);
  if (!rows.length) return undefined;
  const at = (row: Entry) => (row.timestamp && Date.parse(row.timestamp)) || now;
  const events: ActivityEvent[] = [];
  // 同一个工具调用会先后以 running、completed 出现：按 callId 合并成一个动作。
  const actions = new Map<string, AgentAction>();
  let seq = 0, toolsCompleted = 0;
  for (const row of rows) {
    const item = row.item, when = at(row);
    if (item.type === 'assistant_message' && typeof item.text === 'string') {
      const text = activityText(item.text).trim();
      if (text) events.push({ seq: ++seq, at: when, kind: 'output', text });
    } else if (item.type === 'tool_call') {
      const name = String(item.name ?? '工具').replace(/[^\p{L}\p{N}_.:/-]/gu, '').slice(0, 100) || '工具';
      const key = String(item.callId ?? `${name}:${row.seqEnd}`);
      const state: AgentAction['state'] = item.status === 'completed' ? 'ok' : item.status === 'running' ? 'running' : 'failed';
      const prior = actions.get(key);
      if (!prior) {
        const action: AgentAction = { at: when, tool: name, text: paseoActionSummary(name, item.detail), state, ...(state !== 'running' ? { endedAt: when } : {}) };
        actions.set(key, action);
        events.push({ seq: ++seq, at: when, kind: 'tool_start', text: action.text });
      } else if (prior.state === 'running' && state !== 'running') { prior.state = state; prior.endedAt = when; }
      if (state !== 'running' && (!prior || prior.endedAt === when)) toolsCompleted++;
    } else if (item.type === 'error' && typeof item.message === 'string') {
      const text = activityText(item.message).trim();
      if (text) events.push({ seq: ++seq, at: when, kind: 'status', text });
    }
  }
  const all = [...actions.values()];
  // 一轮已经结束还标着进行中的工具调用，按失败记（没有等到结果）。
  if (!running) for (const action of all) if (action.state === 'running') { action.state = 'failed'; action.endedAt = at(rows.at(-1)!); }
  const active = running ? all.filter(action => action.state === 'running').at(-1) : undefined;
  return {
    agent, turn, runtime: 'paseo', state: running ? 'running' : 'completed', startedAt: at(rows[0]!), observedAt: now, lastActivityAt: at(rows.at(-1)!),
    ...(active ? { tool: active.tool, toolStartedAt: active.at } : {}), toolsCompleted, events: events.slice(-40),
    actions: all.slice(-ACTION_LIMIT), ...(all.length > ACTION_LIMIT ? { actionsDropped: all.length - ACTION_LIMIT } : {}),
  };
}

/**
 * 当前有任务在手的 Paseo 员工的动作流。每个员工只读时间线最新一页（100 条）：一轮很长时最早的动作不在其中，
 * 这是一次心跳能承受的读取量。读不出的跳过，不影响其它员工。
 */
export async function paseoActivities(db: Surreal, host: RuntimeHost | undefined, now = Date.now()): Promise<AgentActivity[]> {
  if (!host) return [];
  const [rows] = await db.query<[Array<{ execution?: { agent?: string; turn?: string } }>]>(
    "SELECT runtime_execution AS execution FROM task WHERE current_employee != NONE AND state IN ['doing', 'review'] AND runtime_execution.agent != NONE AND runtime_execution.turn != NONE;");
  const out: AgentActivity[] = [];
  for (const row of rows ?? []) {
    const agent = row.execution?.agent, turn = row.execution?.turn;
    if (!agent || !turn) continue;
    try {
      const timeline = host.agents.ref(agent).timeline;
      if (!timeline) continue;
      const page = await timeline.refetch({ direction: 'tail', limit: 100, projection: 'projected' });
      if (page.error || page.gap || page.staleCursor) continue;
      const running = page.agent?.activeTurn?.turnId === turn || (page.agent?.status === 'running' && !page.agent?.activeTurn);
      const activity = activityFromTimeline(agent, turn, page.entries.filter(entry => entry.turnId === turn) as unknown as Entry[], running, now);
      if (activity) out.push(activity);
    } catch { /* 这位员工的时间线暂时读不出，下一次心跳再试 */ }
  }
  return out;
}
