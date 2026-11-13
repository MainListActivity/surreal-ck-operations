import { acquireNativeWriter } from './native-lock.ts';
import { ActivityCollector, type AgentActivity } from '../agent-activity.ts';
import { spawn as spawnProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentRuntime, SpawnInput, RuntimeWorkspace, TurnEnded } from './contracts.ts';

import { nativeArgs, type NativeProvider } from './native-args.ts';
export { nativeArgs, type NativeProvider };
export interface NativeSession {
  id: string; host: string; provider: NativeProvider; nativeSessionId?: string;
  title: string; cwd: string; model: string; thinking?: string; mode?: string;
  labels: Record<string, string>; workspaceId?: string;
  status: 'starting' | 'running' | 'idle' | 'error' | 'unknown' | 'archived';
  pendingEnd?: TurnEnded;
  turnId?: string; pid?: number; error?: string; inputTokens?: number;
}
interface State { version: 1; host: string; sessions: NativeSession[]; workspaces: RuntimeWorkspace[] }
export interface NativeOptions {
  onHeartbeat?(): Promise<void>;
  root: string; host: string;
  /** 已配置的员工沙箱启动命令；不从 PATH 猜测，也不执行 shell 字符串。 */
  command(provider: NativeProvider): string[];
  /** 每轮从 sidecar 重新取得通道、员工沙箱和模型环境，不持久化 env/凭证。 */
  environment(session: Readonly<NativeSession>): Promise<Record<string, string>>;
  onStarted?(session: Readonly<NativeSession>): void | Promise<void>;
  onEnded?(event: TurnEnded): Promise<void>;
  maxOutputBytes?: number;
  stopGraceMs?: number;
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== 'ESRCH'; } };
const supported = (provider: string): provider is NativeProvider => ['factory-droid', 'claude', 'codex', 'codex-cloud', 'devin-cloud', 'jules', 'warp'].includes(provider);

export interface NativeResult { sessionId?: string; completed: boolean; error?: string; text: string; inputTokens?: number }
/** 只识别正式终态；空输出、任意 stdout、只有 assistant 文本均不能算完成。 */
export function parseNativeResult(provider: NativeProvider, output: string): NativeResult {
  const result: NativeResult = { completed: false, text: '' };
  if (provider !== 'codex') {
    let value: any;
    try { value = JSON.parse(output.trim()); } catch {
      try { value = output.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)); }
      catch { return { ...result, error: '原生 CLI 没有返回有效 JSON 结果' }; }
    }
    // Claude 的 verbose 配置会让 json 输出成为完整事件数组；只接受末尾正式结果。
    if (Array.isArray(value)) {
      const start = value.find(e => e.type === 'system');
      result.sessionId = start?.session_id ?? start?.sessionId;
      if (value.some(e => e?.type === 'error' || (['result', 'completion'].includes(e?.type) && (e.is_error === true || e.isError === true))))
        result.error = '原生 CLI 事件流返回错误';
      value = value.at(-1);
    }
    if (provider === 'factory-droid' && value?.type === 'completion') value = {
      ...value, type: 'result', session_id: value.session_id ?? value.sessionId ?? result.sessionId,
      result: value.finalText ?? value.text ?? value.result,
      subtype: value.isError === true || value.is_error === true ? 'error' : 'success',
      is_error: value.isError === true || value.is_error === true,
    };
    if (!value || value.type !== 'result') return { ...result, error: '原生 CLI 缺少 result 终态' };
    if (typeof value.session_id === 'string' && value.session_id) result.sessionId = value.session_id;
    result.text = typeof value.result === 'string' ? value.result : '';
    result.completed = !result.error && value.is_error === false && value.subtype === 'success';
    if (!result.completed) result.error = typeof value.error === 'string' ? value.error : result.text || '原生 CLI 返回失败终态';
    if (Number.isFinite(value.usage?.input_tokens)) result.inputTokens = value.usage.input_tokens;
    return result;
  }
  for (const line of output.split(/\r?\n/).filter(Boolean)) {
    let event: any;
    try { event = JSON.parse(line); } catch { result.error = 'Codex 事件流包含无效 JSON'; continue; }
    if (event.type === 'thread.started' && typeof event.thread_id === 'string') result.sessionId = event.thread_id;
    if (event.type === 'item.completed' && event.item?.type === 'agent_message') result.text = event.item.text ?? '';
    if (event.type === 'turn.completed') {
      result.completed = true;
      if (Number.isFinite(event.usage?.input_tokens)) result.inputTokens = event.usage.input_tokens;
    }
    if (event.type === 'turn.failed') result.error = event.error?.message || 'Codex 回合失败';
    if (event.type === 'error') result.error = event.message || 'Codex 事件流错误';
  }
  if (result.error) result.completed = false;
  return result;
}

/** 一台执行节点一个写者。持久化会话映射；每轮只持有一个原生 CLI 子进程。 */
export class NativeRuntime implements AgentRuntime {
  async heartbeat(): Promise<void> { await this.options.onHeartbeat?.(); }
  private readonly sessions = new Map<string, NativeSession>();
  private readonly workspaces = new Map<string, RuntimeWorkspace>();
  private readonly pending = new Map<string, string>();
  private readonly processes = new Map<string, { child: ChildProcessWithoutNullStreams; done: Promise<void>; cancel: () => void; kill: (signal: NodeJS.Signals) => void }>();
  private readonly launches = new Set<Promise<void>>();
  private readonly turns = new Set<Promise<void>>();
  private readonly settling = new Map<string, string>();
  private readonly logs = new Map<string, string>();
  private readonly activities = new Map<string, ActivityCollector>();
  activity(): AgentActivity[] { return [...this.activities.values()].map(a => a.snapshot()); }
  acknowledgeActivity(agent: string, turn: string): void {
    const activity = this.activities.get(turn);
    if (activity?.value.agent === agent && activity.value.state !== 'running') this.activities.delete(turn);
  }
  private closed = false;
  private readonly releaseWriter: () => void;
  constructor(private readonly options: NativeOptions) {
    if (!/^[a-zA-Z0-9_-]+$/.test(options.host)) throw new Error('执行节点 host ID 必须是字母、数字、_、-');
    mkdirSync(options.root, { recursive: true, mode: 0o700 });
    this.releaseWriter = acquireNativeWriter(join(options.root, 'writer.lock'), options.host);
    try {
      let state: State | undefined;
      try { state = JSON.parse(readFileSync(join(options.root, 'sessions.json'), 'utf8')); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      if (state) {
        if (state.version !== 1 || state.host !== options.host) throw new Error('会话存储版本或执行节点不匹配');
        for (const session of state.sessions) {
          if (session.status === 'running' || session.status === 'starting' || session.status === 'unknown') {
            session.status = session.pid && alive(session.pid) ? 'unknown' : 'error';
            session.error = '执行端中断；先核对原回合，不自动重发';
          }
          this.sessions.set(session.id, session);
        }
        for (const workspace of state.workspaces) this.workspaces.set(workspace.workspaceId, workspace);
      }
    } catch (error) { this.releaseWriter(); throw error; }
  }
  private save(): void {
    const path = join(this.options.root, 'sessions.json');
    writeFileSync(`${path}.tmp`, JSON.stringify({ version: 1, host: this.options.host,
      sessions: [...this.sessions.values()], workspaces: [...this.workspaces.values()] } satisfies State), { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
  }
  describe(id: string): Readonly<NativeSession> | undefined { const s = this.sessions.get(id); return s && structuredClone(s); }
  private get(id: string): NativeSession {
    if (this.closed) throw new Error('执行端已关闭');
    const session = this.sessions.get(id);
    if (!session) throw new Error('原生会话不存在');
    return session;
  }
  async list() { return new Map([...this.sessions.values()].filter(s => s.status !== 'archived').map(s => [s.id, { id: s.id, status: s.status === 'starting' || this.settling.has(s.id) ? 'running' : s.status, model: s.model }])); }
  async status(id: string) { const s = this.sessions.get(id); return s && { status: s.status === 'starting' || this.settling.has(s.id) ? 'running' : s.status, pendingPermissions: 0 }; }
  async lastError(id: string) { return this.get(id).error ?? ''; }
  async logsTail(id: string, entries: number) { return (this.logs.get(id) ?? '').split('\n').slice(-Math.max(0, entries)).join('\n'); }
  async lastInputTokens(id: string) { return this.get(id).inputTokens; }
  async spawn(input: SpawnInput): Promise<string> {
    if (this.closed) throw new Error('执行端已关闭');
    if (!supported(input.provider)) throw new Error(`原生执行端尚不支持 ${input.provider}`);
    const id = `native:${this.options.host}:${randomUUID()}`;
    const s: NativeSession = { id, host: this.options.host, provider: input.provider, title: input.title,
      cwd: input.cwd, model: input.model, thinking: input.thinking, mode: input.mode,
      labels: { ...input.labels }, workspaceId: input.workspaceId, status: 'starting' };
    this.sessions.set(id, s); this.pending.set(id, input.prompt); this.save();
    return id;
  }
  /** 派工器先登记员工和 sidecar 绑定，再激活，避免极快退出事件早于身份登记。 */
  async activate(id: string): Promise<void> {
    const prompt = this.pending.get(id);
    if (prompt === undefined) throw new Error('原生会话没有待激活首轮');
    this.pending.delete(id);
    await this.start(this.get(id), prompt);
  }
  async send(id: string, prompt: string): Promise<void> {
    const s = this.get(id);
    if (s.status !== 'idle') throw new Error(`原生会话当前不可发送：${s.status}`);
    if (!s.nativeSessionId) throw new Error('缺少原生会话 ID，不能以新会话冒充续跑');
    await this.start(s, prompt);
  }
  private start(s: NativeSession, prompt: string): Promise<void> {
    const pending = this.launch(s, prompt);
    this.launches.add(pending);
    void pending.then(() => this.launches.delete(pending), () => this.launches.delete(pending));
    return pending;
  }
  private async launch(s: NativeSession, prompt: string): Promise<void> {
    if (s.pendingEnd) { await this.recoverFinishedTurns(); if (s.pendingEnd) throw new Error('上一轮结果尚未交付执行端'); }
    s.status = 'running'; s.turnId = randomUUID(); s.error = undefined; this.save();
    let command: string[], env: Record<string, string>;
    try {
      command = this.options.command(s.provider);
      if (!command.length || !command[0]!.startsWith('/')) throw new Error('原生启动命令必须使用绝对路径');
      env = await this.options.environment(structuredClone(s));
      if (this.closed) throw new Error('执行端正在关闭');
    } catch (error) { s.status = 'error'; s.error = (error as Error).message; this.save(); throw error; }
    const child = spawnProcess(command[0]!, [...command.slice(1), ...nativeArgs(s)], {
      cwd: s.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], shell: false, detached: process.platform !== 'win32',
    });
    s.pid = child.pid; this.save();
    const turnId = s.turnId;
    const activity = new ActivityCollector(s.id, turnId!, Date.now());
    this.activities.set(turnId!, activity);
    // Unacknowledged observations are diagnostic only; never retain them without a bound.
    for (const [id, old] of this.activities) if (old.value.state !== 'running' &&
      (old.value.lastActivityAt < Date.now() - 86_400_000 || this.activities.size > 200)) this.activities.delete(id);
    let lineBuffer = '', canceled = false, processError: string | undefined;
    // Retain only terminal facts. Tool payloads must not accumulate for the duration of a long task.
    const facts = new Map<string, unknown>();
    const limit = this.options.maxOutputBytes ?? 8 * 1024 * 1024;
    const terminate = (signal: NodeJS.Signals) => {
      try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch {}
    };
    const consume = (line: string) => {
      if (!line.trim()) return;
      if (Buffer.byteLength(line) > limit) { processError = '原生 CLI 输出超过限制'; terminate('SIGKILL'); return; }
      try {
        const e = JSON.parse(line);
        activity.ingest(s.provider, e, Date.now());
        if (s.provider === 'codex') {
          if (e.type === 'thread.started') facts.set('session', {type:e.type, thread_id:e.thread_id});
          if (e.type === 'item.completed' && e.item?.type === 'agent_message') facts.set('text', e);
          if (e.type === 'turn.completed') facts.set('terminal', {type:e.type,usage:e.usage});
          if (e.type === 'turn.failed' || e.type === 'error') facts.set('error', {type:'error', message:'原生 CLI 事件流返回错误'});
        } else {
          if (e.type === 'system') facts.set('session', {type:e.type, session_id:e.session_id ?? e.sessionId});
          if (e.type === 'error') facts.set('error', {type:'error'});
          facts.set('terminal', ['completion','result'].includes(e.type) ? e : {type:e.type});
        }
      } catch { processError = '原生 CLI 事件流包含无效 JSON'; }
    };
    const capture = (chunk: string) => {
      lineBuffer += chunk;
      let newline: number;
      while ((newline = lineBuffer.indexOf('\n')) >= 0) {
        const line = lineBuffer.slice(0, newline); lineBuffer = lineBuffer.slice(newline + 1);
        consume(line);
      }
      if (Buffer.byteLength(lineBuffer) > limit) { processError = '原生 CLI 输出超过限制'; lineBuffer = ''; terminate('SIGKILL'); }
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', capture);
    // stderr 可包含供应商凭证和命令正文，只排空，不写证据或持久日志。
    child.stderr.resume();
    child.stdin.on('error', () => {});
    let resolveDone!: () => void;
    const done = new Promise<void>(resolve => { resolveDone = resolve; });
    this.turns.add(done);
    void done.then(() => this.turns.delete(done));
    this.processes.set(s.id, { child, done, cancel: () => { canceled = true; }, kill: terminate });
    child.once('error', error => { processError = error.message; });
    let started: Promise<void> = Promise.resolve();
    child.once('close', (code, signal) => {
      void (async () => {
        await started;
        consume(lineBuffer); lineBuffer = '';
        const stdout = ['session','text','error','terminal'].flatMap(k => facts.has(k) ? [JSON.stringify(facts.get(k))] : []).join('\n');
        const result = parseNativeResult(s.provider, stdout);
        if (result.sessionId) s.nativeSessionId = result.sessionId;
        s.inputTokens = result.inputTokens;
        const success = !canceled && !processError && code === 0 && result.completed && !!s.nativeSessionId;
        activity.finish(canceled ? 'canceled' : success ? 'completed' : 'failed', result.text, Date.now());
        s.status = success || canceled && !!s.nativeSessionId ? 'idle' : 'error';
        s.pid = undefined;
        s.error = success || canceled ? undefined : processError ?? result.error ?? `原生回合未完整结束（exit=${code}, signal=${signal ?? 'none'}）`;
        this.logs.set(s.id, result.text.slice(-32_768));
        this.processes.delete(s.id);
        this.settling.set(s.id, turnId!);
        this.save();
        s.pendingEnd = { agent: { id: s.id, title: s.title, provider: s.provider }, turnId,
          outcome: canceled ? { kind: 'canceled' } : success ? { kind: 'completed' } : { kind: 'failed', error: { message: s.error! } },
          timeline: result.text ? [{ type: 'assistant_message', text: result.text }] : [] };
        this.save();
        if (!this.closed && this.options.onEnded) {
          await this.options.onEnded(s.pendingEnd);
          s.pendingEnd = undefined; this.save();
        }
      })().catch(error => { s.status = 'error'; s.error = `回合收尾失败：${(error as Error).message}`; this.save(); }).finally(() => { if (this.settling.get(s.id) === turnId) this.settling.delete(s.id); resolveDone(); });
    });
    // A failed spawn must never produce a start acknowledgement.
    child.once('spawn', () => {
      started = Promise.resolve().then(() => this.options.onStarted?.(structuredClone(s)))
        .catch(() => { processError = '回合开始通知失败'; terminate('SIGKILL'); });
    });
    child.stdin.end(prompt);
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  }
  /** Replay recorded ends after binding recovery, without starting another model process. */
  async recoverFinishedTurns(): Promise<void> {
    if (!this.options.onEnded) return;
    for (const session of this.sessions.values()) {
      if (!session.pendingEnd) continue;
      await this.options.onEnded(session.pendingEnd);
      session.pendingEnd = undefined; this.save();
    }
  }
  async stop(id: string): Promise<void> {
    const s = this.get(id), active = this.processes.get(id);
    if (!active) {
      if (s.status === 'unknown') throw new Error('不能接管存活但不属于当前执行端的进程');
      this.pending.delete(id); if (s.status === 'starting') { s.status = 'error'; s.error = '首轮激活前取消'; this.save(); }
      return;
    }
    active.cancel(); active.kill('SIGTERM');
    const timer = setTimeout(() => active.kill('SIGKILL'), this.options.stopGraceMs ?? 3000);
    try { await active.done; } finally { clearTimeout(timer); }
  }
  async reload(id: string) {
    const s = this.get(id);
    if (s.status === 'unknown' || s.status === 'running' || s.status === 'starting') throw new Error('运行中或状态不明的会话不能重载');
    if (!s.nativeSessionId) throw new Error('没有可恢复的原生会话 ID');
    if (s.status === 'archived') throw new Error('不能恢复已归档会话');
    s.status = 'idle'; s.error = undefined; this.save();
  }
  async archive(id: string) { await this.stop(id); this.get(id).status = 'archived'; this.save(); }
  async sleep(id: string, beforeClose?: () => Promise<boolean>) { if (!beforeClose || await beforeClose()) await this.stop(id); }
  async listWorkspaces() { return [...this.workspaces.values()].map(w => ({ ...w })); }
  async listProjects() { return []; }
  async createWorkspace(name: string, cwd: string) { const workspaceId = randomUUID(); this.workspaces.set(workspaceId, { workspaceId, name, cwd }); this.save(); return workspaceId; }
  async archiveWorkspace(id: string) { for (const s of this.sessions.values()) if (s.workspaceId === id) await this.archive(s.id); this.workspaces.delete(id); this.save(); }
  async deleteProject(_id: string) { throw new Error('原生执行端不维护宿主项目注册表'); }
  async close() {
    if (this.closed) return;
    // 停止时不触发业务收尾/重新派工，租约由下一次恢复或到期处理。
    this.closed = true;
    await Promise.allSettled([...this.launches]);
    await Promise.all([...this.processes.values()].map(async active => {
      active.cancel(); active.kill('SIGTERM');
      const timer = setTimeout(() => active.kill('SIGKILL'), this.options.stopGraceMs ?? 3000);
      try { await active.done; } finally { clearTimeout(timer); }
    }));
    await Promise.all([...this.turns]);
    this.releaseWriter();
  }
}
