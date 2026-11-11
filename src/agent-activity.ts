/** Public execution observations only. Never persist reasoning, tool arguments or raw tool output. */
export interface ActivityEvent {
  seq: number;
  at: number;
  kind: 'output' | 'tool_start' | 'tool_end' | 'status';
  text: string;
}
export interface AgentActivity {
  agent: string;
  turn: string;
  runtime: 'native';
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
}
/** Defense in depth for ordinary assistant output; event selection excludes sensitive channels first. */
export function activityText(text: string): string {
  return text.slice(0, 4000)
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, '[密钥已隐藏]')
    .replace(/\b(?:Bearer\s+\S+|(?:sk-|fk-|ghp_|github_pat_)[A-Za-z0-9_-]{12,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/gi, '[凭证已隐藏]')
    .replace(/((?:\b[a-z0-9_-]{0,80}(?:api[_-]?key|token|secret|password)|\bauthorization)["']?\s*[=:]\s*["']?)[^\s,"'}]+/gi, '$1[已隐藏]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[凭证已隐藏]@')
    .replace(/(https?:\/\/[^\s?#]+)\?[^\s]+/g, '$1?[参数已隐藏]')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').slice(0, 1200);
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
  private tools = new Map<string, {name: string; at: number; sequence: number; updatesChecklist: boolean; checklist?: {done: number; total: number}}>();
  constructor(agent: string, turn: string, now: number) {
    this.value = { agent, turn, runtime: 'native', state: 'running', startedAt: now,
      observedAt: now, lastActivityAt: now, toolsCompleted: 0, events: [] };
    this.append('status', '原生会话已开始', now);
  }
  private append(kind: ActivityEvent['kind'], text: string, at: number) {
    const safe = activityText(text).trim();
    if (!safe) return;
    this.value.lastActivityAt = at;
    this.value.events.push({ seq: ++this.seq, at, kind, text: safe });
    this.value.events = this.value.events.slice(-40);
  }
  private start(id: unknown, name: unknown, at: number, input?: unknown) {
    if (typeof id !== 'string' || typeof name !== 'string' || this.tools.has(id)) return;
    const safe = name.replace(/[^\p{L}\p{N}_.:/-]/gu, '').slice(0, 100) || '工具';
    const updatesChecklist = /^(TodoWrite|todo_write)$/i.test(name);
    const todos = updatesChecklist && input && typeof input === 'object'
      ? (input as {todos?: unknown}).todos : undefined;
    const checklist = checklistCounts(todos);
    this.tools.set(id, {name: safe, at, sequence: this.seq, updatesChecklist, checklist}); this.value.tool = safe; this.value.toolStartedAt = at;
    this.append('tool_start', `开始调用 ${safe}`, at);
  }
  private end(id: unknown, failed: boolean, at: number) {
    if (typeof id !== 'string') return;
    const tool = this.tools.get(id);
    if (!tool) return;
    this.tools.delete(id); this.value.toolsCompleted++;
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
    } else if (provider === 'codex') {
      if (e.type === 'item.completed' && e.item?.type === 'agent_message' && typeof e.item.text === 'string') this.append('output', e.item.text, at);
      if (e.type === 'item.started' && e.item?.type === 'command_execution') this.start(e.item.id, '命令执行', at);
      if (e.type === 'item.completed' && e.item?.type === 'command_execution') this.end(e.item.id, e.item.exit_code !== 0, at);
    }
  }
  finish(state: AgentActivity['state'], text: string, at: number) {
    this.value.state = state; this.value.tool = undefined; this.value.toolStartedAt = undefined;
    if (text && this.value.events.at(-1)?.text !== activityText(text)) this.append('output', text, at);
    this.append('status', state === 'completed' ? '本轮已结束，执行端正在收集成果' : state === 'canceled' ? '本轮已取消' : '本轮运行失败', at);
  }
  snapshot(now = Date.now()): AgentActivity { return { ...this.value, observedAt: now,
    events: this.value.events.filter(e => e.at > now - 86_400_000).map(e => ({...e})) }; }
}
