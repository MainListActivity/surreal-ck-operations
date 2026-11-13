/**
 * Warp（Warp Build agent）本地员工通道：与云端通道同构的桥接，但 oz 是本地 agent，
 * 在任务工作树里自己按公司协议工作（提交/推送由 agent 在任务分支上完成，通道不代做 git）。
 * prompt 正文写进 commDir 下的文件，进程参数只带一句短指令与文件路径。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { claimWorktree } from '../cloud-lane/lane.ts';

export interface WarpConfig {
  /** 命令名 → 绝对路径（如 {"oz": "/Applications/Warp.app/Contents/Resources/bin/oz"}）。 */
  bin?: Record<string, string>;
  /** 单轮上限（分钟），默认 120。 */
  maxMinutes?: number;
}

export interface WarpInput {
  /** 派工消息原文。 */
  prompt: string;
  /** 会话 cwd；没有 claim 工作树时的执行目录。 */
  cwd: string;
  /** 员工通道目录（task.md、claim.json、.warp/turn-*.md 都在这里）。 */
  commDir: string;
  resumeId?: string;
  model?: string;
  config?: WarpConfig;
  env?: Record<string, string | undefined>;
}

export interface WarpProcess {
  stdout: AsyncIterable<Uint8Array | string>;
  stderr: AsyncIterable<Uint8Array | string>;
  exited: Promise<number>;
  kill(): void;
}
export interface WarpDeps {
  spawn(cmd: string, args: string[], opts: { cwd: string; env: Record<string, string | undefined> }): WarpProcess;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** 每步进展以 lane_status 事件输出给执行端活动流。 */
  progress(status: string): void;
}
export interface WarpOutcome { sessionId: string; status: 'success' | 'error'; text: string }

/** oz 只认 --prompt 参数：prompt 正文落盘为文件，参数里只给一句不含任务内容的短指令。 */
export const WARP_INSTRUCTION_FILE = 'turn-';

/** 把 `lanes.warp.bin` 的目录前置到 PATH（与 cloud-lane exec.ts 的约定一致），让 shim 找到自己的运行时。 */
function childEnv(input: WarpInput): Record<string, string | undefined> {
  const env = { ...(input.env ?? process.env) } as Record<string, string | undefined>;
  const dirs = Object.values(input.config?.bin ?? {}).map(p => p.replace(/\/[^/]+$/, ''));
  const extra = [...new Set(dirs.filter(d => d.startsWith('/')))];
  if (extra.length) env.PATH = [...extra, env.PATH ?? ''].filter(Boolean).join(':');
  return env;
}

async function* lines(stream: AsyncIterable<Uint8Array | string>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of stream) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    let index: number;
    while ((index = buffer.indexOf('\n')) >= 0) { yield buffer.slice(0, index); buffer = buffer.slice(index + 1); }
  }
  buffer += decoder.decode();
  if (buffer.trim()) yield buffer;
}

async function stderrTail(stream: AsyncIterable<Uint8Array | string>): Promise<string> {
  let tail = '';
  for await (const line of lines(stream)) tail = `${tail}\n${line}`.slice(-2000);
  return tail.trim();
}

/**
 * 一轮 Warp 执行：写 prompt 文件 → oz agent run（流式 ndjson）→ 汇总 agent.text 为最终答复。
 * 执行目录优先取 claim.json 的任务工作树；没有则用会话 cwd（本地 agent 与普通员工同规则）。
 */
export async function runWarpTurn(input: WarpInput, deps: WarpDeps): Promise<WarpOutcome> {
  const sessionStart = `warp-${crypto.randomUUID()}`;
  const worktree = claimWorktree(input.commDir);
  const cwd = 'path' in worktree ? worktree.path : input.cwd;

  const dir = join(input.commDir, '.warp');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${WARP_INSTRUCTION_FILE}${deps.now()}.md`);
  writeFileSync(file, input.prompt, { mode: 0o600 });

  const oz = input.config?.bin?.oz ?? 'oz';
  const args = ['agent', 'run', '--prompt',
    `读取文件 ${file} 并按其中要求完成任务；最终答复按该文件中的公司协议格式书写。`,
    '--output-format', 'ndjson', '-C', cwd,
    ...(input.resumeId ? ['--conversation', input.resumeId] : []),
    ...(input.model && input.model !== 'default' ? ['--model', input.model] : [])];

  // oz 在发出 run_started 之前失败属于启动失败（如 Warp 服务端偶发的 team metadata 刷新超时），
  // 此时 run 尚未开始、重试不会重复执行，自动重试至多 2 次；收到 run_started 后任何失败都不重试。
  const maxMinutes = input.config?.maxMinutes ?? 120;
  const deadline = deps.now() + maxMinutes * 60_000;
  let lastError: WarpOutcome | undefined;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const proc = deps.spawn(oz, args, { cwd, env: childEnv(input) });
    const stderr = stderrTail(proc.stderr);
    let conversation: string | undefined;
    let answer = '';
    let runStarted = false;
    let timedOut = false;
    const timer = setInterval(() => { if (deps.now() > deadline) { timedOut = true; proc.kill(); } }, 1000);
    try {
      for await (const line of lines(proc.stdout)) {
        if (!line.trim()) continue;
        let event: { type?: string; event_type?: string; conversation_id?: string; run_url?: string; text?: string };
        try { event = JSON.parse(line); } catch { continue; }
        if (event.type === 'system' && event.event_type === 'conversation_started' && typeof event.conversation_id === 'string')
          conversation = event.conversation_id;
        else if (event.type === 'system' && event.event_type === 'run_started') {
          runStarted = true;
          if (typeof event.run_url === 'string') deps.progress(`Warp 运行中：${event.run_url}`);
        } else if (event.type === 'agent' && typeof event.text === 'string')
          answer += event.text;
      }
      const code = await proc.exited;
      if (timedOut) return { sessionId: conversation ?? sessionStart, status: 'error', text: `Warp 单轮超过 ${maxMinutes} 分钟上限，已终止` };
      const tail = await stderr;
      if (code !== 0) {
        if (!runStarted && attempt < 3) {
          deps.progress(`Warp 启动失败，第 ${attempt} 次重试：${tail.split('\n').at(-1)?.slice(0, 200) ?? `退出码 ${code}`}`);
          await deps.sleep(5000);
          continue;
        }
        lastError = { sessionId: conversation ?? sessionStart, status: 'error',
          text: `Warp 退出码 ${code}${tail ? `：${tail.slice(-400)}` : ''}` };
        return lastError;
      }
      if (!answer.trim()) return { sessionId: conversation ?? sessionStart, status: 'error',
        text: `Warp 没有给出答复${tail ? `：${tail.slice(-400)}` : ''}` };
      return { sessionId: conversation ?? sessionStart, status: 'success', text: answer.trim() };
    } finally { clearInterval(timer); }
  }
  return lastError!;
}

