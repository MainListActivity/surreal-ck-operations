import { randomBytes } from 'node:crypto';
import { fstatSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { readJsonFile, reqDir, resDir, writeFileAtomic, type CommResponse } from './comm.ts';
import { COMPANY_TOOL_SPECS } from './runner/company-tools.ts';

/** Writes every byte to stdout before the process may exit: a pipe that is not drained yet must not cut the output. */
function writeStdout(text: string): void {
  const bytes = Buffer.from(text, 'utf8');
  let offset = 0;
  while (offset < bytes.length) {
    try {
      offset += writeSync(1, bytes, offset, bytes.length - offset);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EAGAIN') throw error;
      Bun.sleepSync(2);
    }
  }
}

/** Codes a repeat of the same call may clear. Every other refusal needs the caller to change something. */
const RETRYABLE = new Set(['temporarily_unavailable', 'comm_timeout', 'comm_unavailable', 'upstream_unavailable', 'upstream_error']);

/**
 * Every outcome is one line of JSON on stdout, so a caller can always JSON.parse it (SYS01 AC03). The reason also
 * goes to stderr, and the exit status is 1. `code` is the recoverable error class.
 */
function fail(code: string, message: string): never {
  // A sidecar refusal already reads "code: reason"; keep that text once rather than repeating the code.
  const error = message.startsWith(`${code}:`) ? message : `${code}: ${message}`;
  try {
    writeStdout(`${JSON.stringify({ ok: false, code, error, retryable: RETRYABLE.has(code) })}\n`);
  } catch {
    // The reader has gone away; the exit status still reports the failure.
  }
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

/** The error class a sidecar answer carries before its first colon (`invalid: …`, `response_too_large: …`). */
function codeOf(error: string | undefined): string {
  const match = /^([a-z][a-z0-9_]{1,63}):/.exec(error ?? '');
  return match?.[1] ?? 'comm_error';
}

/** Tool arguments are one JSON object, or nothing. Anything else is refused before a request is written. */
function argumentsOf(json: string | undefined): Record<string, unknown> {
  if (json === undefined || json.trim() === '') return {};
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    fail('invalid_arguments', `arguments are not valid JSON: ${(error as Error).message}`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('invalid_arguments', 'arguments must be one JSON object, for example {} or {"pageSize":25}');
  }
  return value as Record<string, unknown>;
}

/** zsh expands `jq … | sck call tool "$(cat)"` to an empty argument (its `$(cat)` never sees the pipe) and the JSON
 * waits on stdin instead. An explicit empty argument with piped stdin reads it, briefly, rather than calling with {}. */
async function pipedArguments(): Promise<string> {
  try {
    const stat = fstatSync(0);
    if (!stat.isFIFO() && !stat.isFile() && !stat.isSocket()) return '';
  } catch {
    return '';
  }
  const text = await Promise.race([Bun.stdin.text(), new Promise<string>(resolve => setTimeout(() => resolve(''), 3000))]);
  return text;
}

/** Comm channel credentials: absent when the process was not launched inside a dispatched session. */
function commAuth(): { dir: string; key: string } | { error: string } {
  const dir = process.env.SCK_COMM_DIR;
  if (!dir) return { error: 'missing_comm_dir: SCK_COMM_DIR is not set — sck runs only in a session the plugin dispatched; check the dispatch environment' };
  const key = process.env.SCK_COMM_KEY;
  if (!key) return { error: 'missing_comm_key: SCK_COMM_KEY is not set — comm requests cannot be authenticated; check the dispatch environment' };
  return { dir, key };
}

/**
 * 写一条请求到 comm 目录并轮询响应直到成功或超时。sck call 与 sck mcp 共用这一段：
 * 员工不持有任何凭证，一切经 sidecar 代跑。返回原始 CommResponse（ok/data/error/notices）。
 */
async function commRequest(dir: string, commKey: string, tool: string, args: Record<string, unknown>, waitMs: number): Promise<CommResponse> {
  const key = `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
  try {
    writeFileAtomic(join(reqDir(dir), `${key}.json`), JSON.stringify({ key: commKey, tool, args }));
  } catch {
    return { ok: false, error: 'comm_unavailable: comm request directory is not writable; check SCK_COMM_DIR' };
  }
  const resFile = join(resDir(dir), `${key}.json`);
  const deadline = Date.now() + waitMs;
  for (;;) {
    const res = readJsonFile<CommResponse>(resFile);
    if (res) {
      try { unlinkSync(resFile); } catch { /* consumed race */ }
      return res;
    }
    if (Date.now() > deadline) return { ok: false, error: 'comm_timeout: comm request timed out; the sidecar did not answer in time' };
    await Bun.sleep(200);
  }
}

/** 按工具名决定 comm 等待时长（媒体/浏览器作业上游以分钟计）。 */
function waitMsFor(tool: string | undefined): number {
  return tool === 'media_music' || tool === 'media_voice_design' || tool === 'media_video' || tool?.startsWith('sync_') ? 330_000
    : tool === 'notebook_query' || tool === 'notebook_write' ? 500_000
    : tool === 'media_image' ? 300_000
    : tool?.startsWith('media_') || tool?.startsWith('notebook_') ? 150_000 : 120_000;
}

// ---- `sck mcp`：stdio MCP 服务器（行分隔 JSON-RPC 2.0），给原生执行端（claude/codex）注入公司工具。
// 不新增服务与端口：MCP 服务器就是员工 CLI 的 stdio 子进程，与 `sck call` 一样只经 comm 目录中转。
// stdout 只写协议行，诊断写 stderr。

const MCP_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

async function mcpVersion(): Promise<string> {
  try {
    const pkg = await Bun.file('package.json').json() as { version?: string };
    return pkg.version ?? 'dev';
  } catch {
    return 'dev';
  }
}

/** tools/call 的一次转发：SCK_COMM_* 缺失不拖垮服务器，只在结果里报错。 */
async function mcpToolCall(name: string, args: Record<string, unknown>): Promise<unknown> {
  const auth = commAuth();
  const toResult = (data: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data });
  const toError = (error: string) => {
    const colon = error.indexOf(':');
    const code = colon > 0 ? error.slice(0, colon).trim() : 'error';
    const payload = { error: { code, message: colon > 0 ? error.slice(colon + 1).trim() : error } };
    return { isError: true, content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload };
  };
  if ('error' in auth) return toError(auth.error);
  // company_tool 的等待时长按内层工具名套用现有映射（company_ops 用 args.tool 的名字）。
  const innerWait = name === 'company_ops' && typeof args.tool === 'string' ? waitMsFor(args.tool) : waitMsFor(undefined);
  const res = await commRequest(auth.dir, auth.key, 'company_tool', { name, args }, innerWait);
  return res.ok ? toResult(res.data) : toError(res.error ?? 'comm_error: comm request failed');
}

async function mcpServer(): Promise<void> {
  const version = await mcpVersion();
  const reply = (id: unknown, result: unknown) =>
    writeStdout(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
  const replyError = (id: unknown, code: number, message: string) =>
    writeStdout(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);

  const handle = async (msg: { jsonrpc?: string; id?: unknown; method?: string; params?: unknown }): Promise<void> => {
    const id = msg.id;
    switch (msg.method) {
      case 'initialize': {
        const requested = (msg.params as { protocolVersion?: string } | undefined)?.protocolVersion;
        reply(id, {
          protocolVersion: MCP_PROTOCOL_VERSIONS.includes(requested ?? '') ? requested : '2025-03-26',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'sck-company', version },
          instructions: '读用 task_current / task_context / company_landscape；交卷用 task_submit（执行阶段）、task_review（复核阶段）、task_block（受阻）；只读运维用 company_ops（能力清单外的工具用 sck list 查看）。需要任务的工具要求任务当前派给你且租约未过期。',
        });
        return;
      }
      case 'ping': reply(id, {}); return;
      case 'tools/list':
        reply(id, {
          tools: COMPANY_TOOL_SPECS.map(spec => ({
            name: spec.name, title: spec.title, description: spec.description,
            inputSchema: z.toJSONSchema(spec.input),
          })),
        });
        return;
      case 'tools/call': {
        const params = msg.params;
        if (typeof params !== 'object' || params === null || Array.isArray(params)) {
          replyError(id, -32602, 'tools/call params must be an object with name and arguments');
          return;
        }
        const { name, arguments: callArgs } = params as { name?: unknown; arguments?: unknown };
        reply(id, await mcpToolCall(String(name ?? ''), (callArgs ?? {}) as Record<string, unknown>));
        return;
      }
      default:
        replyError(id, -32601, `method not found: ${String(msg.method)}`);
    }
  };

  // 逐行 JSON-RPC；多个调用可并发，按 id 回包。stdin 关闭即退出。
  const decoder = new TextDecoder();
  let buffer = '';
  const tasks: Promise<void>[] = [];
  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk as Uint8Array, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let msg: { id?: unknown; method?: string; params?: unknown };
      try {
        msg = JSON.parse(line) as typeof msg;
      } catch {
        replyError(null, -32700, 'parse error');
        continue;
      }
      // 通知（无 id 或 notifications/*）一律忽略。
      if (msg.id === undefined || String(msg.method ?? '').startsWith('notifications/')) continue;
      tasks.push(handle(msg).catch((error: unknown) =>
        replyError(msg.id, -32603, error instanceof Error ? error.message : String(error))));
    }
  }
  await Promise.allSettled(tasks);
}

/**
 * sck, the employee's tool client (bin/sck call | list | mcp). It only relays requests through the plugin sidecar's comm
 * directory: the sidecar holds the company credential, so the agent carries no auth material and opens no connection.
 */
async function main(): Promise<void> {
  const [command, name, json] = Bun.argv.slice(2);
  if (command === 'mcp') { await mcpServer(); return; }
  if (!['list', 'call'].includes(command ?? '')) fail('invalid_arguments', 'usage: sck list | sck call <tool> [json-arguments] | sck mcp');
  if (command === 'call' && !name) fail('invalid_arguments', 'tool name is required');
  const args = argumentsOf(json === '' ? await pipedArguments() : json);

  const auth = commAuth();
  if ('error' in auth) {
    const [code] = auth.error.split(':', 1);
    fail(code, auth.error);
  }
  // Media generation runs upstream for minutes (music up to 300s); wait past the studio's own timeout.
  // Browser-lane jobs go through a real web UI: image ~60s, video gen plus capture ~120s.
  // Notebook chapter drafts are long grounded generations: allow up to the studio's 480s cap.
  const waitMs = waitMsFor(name);
  const res = await commRequest(auth.dir, auth.key, command === 'list' ? '__list__' : name!, args, waitMs);
  if (!res.ok) fail(codeOf(res.error), res.error ?? 'comm request failed');
  // The sidecar attaches the employee's unacked holder notices to a successful reply, fitted to the reply's
  // budget. Keep the plain data shape when there are none (one JSON line, unchanged), and surface them as a
  // top-level `notices` key otherwise, with the cut when some did not fit the budget (those stay unacked and
  // arrive on a later call), so an in-lease holder sees an acceptance amendment on its next sck call.
  const notices = Array.isArray(res.notices) && res.notices.length > 0 ? res.notices : undefined;
  // The cut is surfaced even when nothing fitted: the holder is told notices are waiting and reads them with
  // holder_notices, instead of the reply silently looking like there was nothing to read.
  const carried = notices === undefined && res.noticesTruncated === undefined
    ? undefined
    : { ...(notices === undefined ? {} : { notices }), ...(res.noticesTruncated === undefined ? {} : { noticesTruncated: res.noticesTruncated }) };
  const answer = carried === undefined
    ? res.data ?? null
    : res.data !== null && typeof res.data === 'object' && !Array.isArray(res.data)
      ? { ...(res.data as Record<string, unknown>), ...carried }
      : { data: res.data ?? null, ...carried };
  writeStdout(`${JSON.stringify(answer)}\n`);
  process.exit(0);
}

main().catch((error: unknown) => fail('internal_error', error instanceof Error ? error.message : String(error)));
