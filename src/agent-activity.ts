/**
 * Public execution observations only. Never persist reasoning or raw tool output.
 * 每个工具动作留一行脱敏摘要（执行了什么命令、读写了哪个文件、搜了什么）：只取能说明“做了什么”的那一个参数，
 * 文件内容、编辑前后的文本、命令输出都不存。
 */
export interface ActivityEvent {
  seq: number;
  at: number;
  kind: 'output' | 'tool_start' | 'tool_end' | 'status';
  text: string;
}
/** 一个动作：工具调用，或通道报告的一步进展。 */
export interface AgentAction {
  at: number;
  /** 工具名（已清洗）；通道进展写“通道”。 */
  tool: string;
  /** 一行摘要，已脱敏。 */
  text: string;
  state: 'running' | 'ok' | 'failed';
  /** 结束时刻；仍在跑的没有。 */
  endedAt?: number;
}
/** 一轮里保留的动作条数上限；更早的丢弃并计数。 */
export const ACTION_LIMIT = 200;

export interface AgentActivity {
  agent: string;
  turn: string;
  runtime: 'native' | 'paseo';
  state: 'running' | 'completed' | 'failed' | 'canceled';
  startedAt: number;
  observedAt: number;
  lastActivityAt: number;
  tool?: string;
  toolStartedAt?: number;
  toolsCompleted: number;
  /** Only counts from a successful structured todo write; no task text or tool arguments are stored. */
  checklist?: { done: number; total: number; at: number };
  events: ActivityEvent[];
  /** 本轮的动作，按发生顺序；超过 ACTION_LIMIT 时丢最早的。旧版本写的记录没有这一项。 */
  actions?: AgentAction[];
  actionsDropped?: number;
}
/** Defense in depth for ordinary assistant output; event selection excludes sensitive channels first. */
export function activityText(text: string): string {
  return text.slice(0, 4000)
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, '[密钥已隐藏]')
    .replace(/\b(?:Bearer\s+\S+|(?:sk-|fk-|ghp_|github_pat_)[A-Za-z0-9_-]{12,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/gi, '[凭证已隐藏]')
    .replace(/((?:\b[a-z0-9_-]{0,80}(?:api[_-]?key|token|secret|password)|\bauthorization)["']?\s*[=:]\s*["']?)[^\s,"'}]+/gi, '$1[已隐藏]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[凭证已隐藏]@')
    // 命令行里的凭证：--password x、--token=x、-p x 之外的常见写法，以及 curl -u 用户:口令。
    .replace(/(--?(?:password|passwd|pass|token|secret|api[-_]?key|access[-_]?key|key)(?:=|\s+))("[^"]*"|'[^']*'|\S+)/gi, '$1[已隐藏]')
    .replace(/((?:^|\s)-u\s+)\S+:\S+/g, '$1[已隐藏]')
    .replace(/(https?:\/\/[^\s?#]+)\?[^\s]+/g, '$1?[参数已隐藏]')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').slice(0, 1200);
}

const ONE_LINE = 160;
const line = (value: unknown): string => activityText(String(value ?? '')).replace(/\s+/g, ' ').trim().slice(0, ONE_LINE);
const pick = (input: unknown, ...keys: string[]): string | undefined => {
  if (!input || typeof input !== 'object') return undefined;
  for (const key of keys) { const value = (input as Record<string, unknown>)[key]; if (typeof value === 'string' && value.trim()) return value; }
  return undefined;
};

/**
 * 一个工具调用的一行摘要。各家工具名和参数名不同，这里只认几种通用的形态：命令、文件、搜索、网址、子任务；
 * 认不出的只留工具名。参数里的凭证由 activityText 再清一遍。
 */
export function actionSummary(name: string, input?: unknown): string {
  const tool = name.replace(/[^\p{L}\p{N}_.:/-]/gu, '').slice(0, 100) || '工具';
  // 搜索类工具常带一个 path（搜索范围），要记的是搜什么。
  const searching = /grep|glob|search|find/i.test(tool) ? pick(input, 'pattern', 'query', 'glob', 'regex') : undefined;
  if (searching) return `搜索：${line(searching)}`;
  const command = pick(input, 'command', 'cmd', 'script');
  if (command) return `执行命令：${line(command)}`;
  const file = pick(input, 'file_path', 'filePath', 'path', 'notebook_path', 'target_file');
  if (file) return `${/write|create/i.test(tool) ? '写文件' : /edit|patch|replace|update|apply/i.test(tool) ? '改文件' : /read|view|open|cat/i.test(tool) ? '读文件' : tool}：${line(file)}`;
  const query = pick(input, 'pattern', 'query', 'glob', 'regex');
  if (query) return `搜索：${line(query)}`;
  const url = pick(input, 'url');
  if (url) return `打开网址：${line(url)}`;
  const task = pick(input, 'description');
  if (task && /task|agent/i.test(tool)) return `派子任务：${line(task)}`;
  return `调用 ${tool}`;
}

/** Paseo 时间线里的工具调用（detail 已是结构化的）→ 一行摘要。 */
export function paseoActionSummary(name: string, detail: unknown): string {
  const d = (detail && typeof detail === 'object' ? detail : {}) as Record<string, unknown>;
  switch (d.type) {
    case 'shell': return `执行命令：${line(d.command)}`;
    case 'read': return `读文件：${line(d.filePath)}`;
    case 'edit': return `改文件：${line(d.filePath)}`;
    case 'write': return `写文件：${line(d.filePath)}`;
    case 'search': return `搜索：${line(d.query)}`;
    case 'fetch': return `打开网址：${line(d.url)}`;
    default: return actionSummary(name, d.input ?? d);
  }
}

/** Provider-native todo formats. Count status markers only; never persist todo descriptions. */
function checklistCounts(todos: unknown): {done: number; total: number} | undefined {
  const statuses = Array.isArray(todos) ? todos.map(t => t?.status) :
    typeof todos === 'string' && todos.length <= 100_000 ? todos.split(/\r?\n/).filter(l => l.trim()).map(line =>
      /^\s*(?:\d+[.)]|[-*])\s+\[(pending|in_progress|completed)\]\s+\S/.exec(line)?.[1]) : [];
  if (!statuses.length || statuses.length > 200 || !statuses.every(s => ['pending','in_progress','completed'].includes(s))) return;
  return {done: statuses.filter(s => s === 'completed').length, total: statuses.length};
}

/** Bounded, deterministic projection of provider events; no model call and no guessed completion %. */
export class ActivityCollector {
  readonly value: AgentActivity;
  private seq = 0;
  private checklistSequence = -1;
  private tools = new Map<string, {name: string; at: number; sequence: number; updatesChecklist: boolean; checklist?: {done: number; total: number}; action: AgentAction}>();
  constructor(agent: string, turn: string, now: number) {
    this.value = { agent, turn, runtime: 'native', state: 'running', startedAt: now,
      observedAt: now, lastActivityAt: now, toolsCompleted: 0, events: [], actions: [] };
    this.append('status', '原生会话已开始', now);
  }
  private append(kind: ActivityEvent['kind'], text: string, at: number) {
    const safe = activityText(text).trim();
    if (!safe) return;
    this.value.lastActivityAt = at;
    this.value.events.push({ seq: ++this.seq, at, kind, text: safe });
    this.value.events = this.value.events.slice(-40);
  }
  private act(tool: string, text: string, state: AgentAction['state'], at: number): AgentAction {
    const action: AgentAction = { at, tool, text: line(text) || tool, state };
    const actions = this.value.actions ??= [];
    actions.push(action);
    if (actions.length > ACTION_LIMIT) { actions.splice(0, actions.length - ACTION_LIMIT); this.value.actionsDropped = (this.value.actionsDropped ?? 0) + 1; }
    return action;
  }
  private start(id: unknown, name: unknown, at: number, input?: unknown) {
    if (typeof id !== 'string' || typeof name !== 'string' || this.tools.has(id)) return;
    const safe = name.replace(/[^\p{L}\p{N}_.:/-]/gu, '').slice(0, 100) || '工具';
    const updatesChecklist = /^(TodoWrite|todo_write)$/i.test(name);
    const todos = updatesChecklist && input && typeof input === 'object'
      ? (input as {todos?: unknown}).todos : undefined;
    const checklist = checklistCounts(todos);
    // 待办清单的内容不存（只数状态），所以它的动作只留工具名。
    const summary = updatesChecklist ? '更新待办清单' : actionSummary(safe, input);
    const action = this.act(safe, summary, 'running', at);
    this.tools.set(id, {name: safe, at, sequence: this.seq, updatesChecklist, checklist, action}); this.value.tool = safe; this.value.toolStartedAt = at;
    this.append('tool_start', summary, at);
  }
  private end(id: unknown, failed: boolean, at: number) {
    if (typeof id !== 'string') return;
    const tool = this.tools.get(id);
    if (!tool) return;
    this.tools.delete(id); this.value.toolsCompleted++;
    tool.action.state = failed ? 'failed' : 'ok'; tool.action.endedAt = at;
    if (!failed && tool.updatesChecklist && tool.sequence > this.checklistSequence) {
      this.value.checklist = tool.checklist ? {...tool.checklist, at: tool.at} : undefined;
      this.checklistSequence = tool.sequence;
    }
    this.append('tool_end', `${tool.name} ${failed ? '调用失败' : '调用结束'}`, at);
    const active = [...this.tools.values()].at(-1);
    this.value.tool = active?.name; this.value.toolStartedAt = active?.at;
  }
  ingest(provider: string, e: any, at: number) {
    if (!e || typeof e !== 'object') return;
    // Only explicitly identified assistant text. Thinking/reasoning blocks are intentionally ignored.
    if (provider === 'claude') {
      if (e.type === 'assistant') for (const b of e.message?.content ?? []) {
        if (b.type === 'text' && typeof b.text === 'string') this.append('output', b.text, at);
        if (b.type === 'tool_use') this.start(b.id, b.name, at, b.input);
      }
      if (e.type === 'user') for (const b of e.message?.content ?? [])
        if (b.type === 'tool_result') this.end(b.tool_use_id, b.is_error === true, at);
    } else if (provider === 'factory-droid') {
      if (e.type === 'message' && e.role === 'assistant' && typeof e.text === 'string') this.append('output', e.text, at);
      if (e.type === 'tool_call') this.start(e.toolId ?? e.toolCallId ?? e.id, e.toolName, at, e.parameters);
      if (e.type === 'tool_result') this.end(e.toolId ?? e.toolCallId ?? e.id, e.isError === true, at);
    } else if (provider === 'codex-cloud' || provider === 'devin-cloud' || provider === 'jules') {
      // 云端通道桥接进程的进展行：只取状态短语，不取供应商转录。
      if (e.type === 'lane_status' && typeof e.status === 'string') { this.append('status', `云端运行中：${e.status}`, at); this.act('通道', e.status, 'ok', at); }
    } else if (provider === 'warp' || provider === 'grok-bot' || provider === 'muse-web' || provider === 'chatgpt-web' || provider === 'gemini-web') {
      // warp 本地通道 / grok-bot 网页通道桥接的进展行，同样只取状态短语。
      if (e.type === 'lane_status' && typeof e.status === 'string') { this.append('status', e.status, at); this.act('通道', e.status, 'ok', at); }
    } else if (provider === 'codex') {
      if (e.type === 'item.completed' && e.item?.type === 'agent_message' && typeof e.item.text === 'string') this.append('output', e.item.text, at);
      if (e.type === 'item.started' && e.item?.type === 'command_execution') this.start(e.item.id, '命令执行', at, { command: e.item.command });
      if (e.type === 'item.completed' && e.item?.type === 'command_execution') this.end(e.item.id, e.item.exit_code !== 0, at);
    }
  }
  finish(state: AgentActivity['state'], text: string, at: number) {
    this.value.state = state; this.value.tool = undefined; this.value.toolStartedAt = undefined;
    // 一轮结束时还没收到结果的工具调用：成功结束的按完成记，其余按失败记。
    for (const tool of this.tools.values()) { tool.action.state = state === 'completed' ? 'ok' : 'failed'; tool.action.endedAt = at; }
    this.tools.clear();
    if (text && this.value.events.at(-1)?.text !== activityText(text)) this.append('output', text, at);
    this.append('status', state === 'completed' ? '本轮已结束，执行端正在收集成果' : state === 'canceled' ? '本轮已取消' : '本轮运行失败', at);
  }
  snapshot(now = Date.now()): AgentActivity { return { ...this.value, observedAt: now,
    events: this.value.events.filter(e => e.at > now - 86_400_000).map(e => ({...e})),
    actions: (this.value.actions ?? []).map(a => ({...a})) }; }
}
