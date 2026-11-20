// `sck mcp`：员工 CLI 的 stdio MCP 子进程（行分隔 JSON-RPC 2.0），给原生执行端（claude/codex）
// 注入与云端公司 MCP 同名的 7 个工具。请求只经 comm 目录中转（与 sck call 同一通道），
// 员工不持有凭证。这里用真 sck-cli.ts 子进程 + 假 sidecar 应答循环验证协议形状。
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Subprocess } from 'bun';
import { ensureCommDirs, reqDir, resDir, writeFileAtomic, type CommResponse } from '../src/comm.ts';
import { COMPANY_TOOL_SPECS } from '../src/runner/company-tools.ts';

const ROOT = join(import.meta.dir, '..');
const CLIENT = join(ROOT, 'src/sck-cli.ts');
const CREDENTIAL_ENV = ['SCK_COMM_DIR', 'SCK_COMM_KEY'];

const cleanEnv = (overrides: Record<string, string | undefined> = {}): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !CREDENTIAL_ENV.includes(key)) env[key] = value;
  }
  for (const [key, value] of Object.entries(overrides)) if (value !== undefined) env[key] = value;
  return env;
};

const dirs: string[] = [];
const procs: Subprocess[] = [];
afterEach(() => {
  while (procs.length) { try { procs.pop()!.kill(); } catch { /* gone */ } }
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** 假 sidecar：轮询 req/ 读请求并按同名回 res/，请求内容留给断言。 */
function fakeSidecar(dir: string, answer: (req: { key: string; tool: string; args: Record<string, unknown> }) => CommResponse) {
  const requests: Array<{ key: string; tool: string; args: Record<string, unknown> }> = [];
  const seen = new Set<string>();
  const timer = setInterval(() => {
    for (const file of readdirSync(reqDir(dir))) {
      if (!file.endsWith('.json') || seen.has(file)) continue;
      seen.add(file);
      const req = JSON.parse(readFileSync(join(reqDir(dir), file), 'utf8')) as { key: string; tool: string; args: Record<string, unknown> };
      requests.push(req);
      writeFileAtomic(join(resDir(dir), file), JSON.stringify(answer(req)));
    }
  }, 20);
  afterEach(() => clearInterval(timer));
  return requests;
}

/** 起 sck mcp 子进程，提供按 id 取响应的读取循环（stdout 每行都是一条 JSON-RPC）。 */
function startMcp(env: Record<string, string | undefined>) {
  const child = Bun.spawn([process.execPath, CLIENT, 'mcp'], { cwd: ROOT, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: cleanEnv(env) });
  procs.push(child);
  const byId = new Map<unknown, Record<string, unknown>>();
  const rawLines: string[] = [];
  const waiters: Array<() => void> = [];
  void (async () => {
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        rawLines.push(line);
        const msg = JSON.parse(line) as Record<string, unknown>;
        byId.set(msg.id, msg);
        for (const waiter of waiters.splice(0)) waiter();
      }
    }
  })();
  const send = (msg: Record<string, unknown>) => { child.stdin.write(`${JSON.stringify(msg)}\n`); void child.stdin.flush(); };
  const wait = async (id: unknown, ms = 15_000): Promise<Record<string, unknown>> => {
    const deadline = Date.now() + ms;
    while (!byId.has(id)) {
      if (Date.now() > deadline) throw new Error(`没有等到 id=${String(id)} 的响应`);
      await Promise.race([new Promise<void>(resolve => waiters.push(resolve)), Bun.sleep(50)]);
    }
    return byId.get(id)!;
  };
  return { child, send, wait, rawLines };
}

const commHome = () => {
  const dir = mkdtempSync(join(tmpdir(), 'sck-mcp-'));
  dirs.push(dir);
  ensureCommDirs(dir);
  return dir;
};

test('initialize 版本协商：请求内版本回显，表外回落 2025-03-26', async () => {
  const dir = commHome();
  fakeSidecar(dir, () => ({ ok: true, data: {} }));
  const mcp = startMcp({ SCK_COMM_DIR: dir, SCK_COMM_KEY: 'mcp-key' });
  mcp.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
  const res = await mcp.wait(1);
  const result = res.result as { protocolVersion: string; capabilities: unknown; serverInfo: { name: string } };
  expect(result.protocolVersion).toBe('2025-06-18');
  expect(result.capabilities).toEqual({ tools: { listChanged: false } });
  expect(result.serverInfo.name).toBe('sck-company');

  mcp.send({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
  const res2 = await mcp.wait(2);
  expect((res2.result as { protocolVersion: string }).protocolVersion).toBe('2025-03-26');

  mcp.send({ jsonrpc: '2.0', method: 'notifications/initialized' }); // 通知忽略
  mcp.send({ jsonrpc: '2.0', id: 3, method: 'ping' });
  expect((await mcp.wait(3)).result).toEqual({});
});

test('tools/list 恰好 7 个公司工具，inputSchema 是 object', async () => {
  const dir = commHome();
  fakeSidecar(dir, () => ({ ok: true, data: {} }));
  const mcp = startMcp({ SCK_COMM_DIR: dir, SCK_COMM_KEY: 'mcp-key' });
  mcp.send({ jsonrpc: '2.0', id: 10, method: 'tools/list' });
  const res = await mcp.wait(10);
  const tools = (res.result as { tools: Array<{ name: string; description: string; inputSchema: { type: string } }> }).tools;
  expect(tools.map(t => t.name).sort()).toEqual(COMPANY_TOOL_SPECS.map(s => s.name).sort());
  for (const tool of tools) {
    expect(tool.inputSchema.type).toBe('object');
    expect(tool.description.length).toBeGreaterThan(0);
  }
});

test('tools/call 经 comm 转 company_tool：请求形状、成功与失败映射', async () => {
  const dir = commHome();
  const requests = fakeSidecar(dir, req => req.args.name === 'task_current'
    ? { ok: true, data: { tasks: [{ taskId: 't-1', phase: 'doing' }] } }
    : { ok: false, error: 'invalid: summary 需要 20..8000 字符' });
  const mcp = startMcp({ SCK_COMM_DIR: dir, SCK_COMM_KEY: 'mcp-key' });

  mcp.send({ jsonrpc: '2.0', id: 20, method: 'tools/call', params: { name: 'task_current', arguments: {} } });
  const ok = await mcp.wait(20);
  const okResult = ok.result as { content: Array<{ type: string; text: string }>; structuredContent: unknown; isError?: boolean };
  expect(okResult.isError).toBeUndefined();
  expect(okResult.structuredContent).toEqual({ tasks: [{ taskId: 't-1', phase: 'doing' }] });
  expect(okResult.content[0]).toEqual({ type: 'text', text: JSON.stringify({ tasks: [{ taskId: 't-1', phase: 'doing' }] }) });

  mcp.send({ jsonrpc: '2.0', id: 21, method: 'tools/call', params: { name: 'task_submit', arguments: { taskId: 't-1', summary: '短' } } });
  const bad = await mcp.wait(21);
  const badResult = bad.result as { isError: boolean; structuredContent: { error: { code: string; message: string } } };
  expect(badResult.isError).toBe(true);
  expect(badResult.structuredContent.error).toEqual({ code: 'invalid', message: 'summary 需要 20..8000 字符' });

  // 请求文件：tool 是 company_tool、key 正确、name/args 原样进 args。
  expect(requests.map(r => [r.tool, r.key])).toEqual([['company_tool', 'mcp-key'], ['company_tool', 'mcp-key']]);
  expect(requests[0]!.args).toEqual({ name: 'task_current', args: {} });
  expect(requests[1]!.args).toEqual({ name: 'task_submit', args: { taskId: 't-1', summary: '短' } });
});

test('协议纪律：未知方法 -32601、非对象参数 -32602、stdout 每行合法 JSON、stdin 关闭即退出', async () => {
  const dir = commHome();
  fakeSidecar(dir, () => ({ ok: true, data: {} }));
  const mcp = startMcp({ SCK_COMM_DIR: dir, SCK_COMM_KEY: 'mcp-key' });
  mcp.send({ jsonrpc: '2.0', id: 30, method: 'resources/list' });
  const res = await mcp.wait(30);
  expect((res.error as { code: number }).code).toBe(-32601);

  mcp.send({ jsonrpc: '2.0', id: 31, method: 'tools/call', params: 'oops' });
  const res2 = await mcp.wait(31);
  expect((res2.error as { code: number }).code).toBe(-32602);

  for (const line of mcp.rawLines) expect(() => JSON.parse(line)).not.toThrow();

  mcp.child.stdin.end();
  expect(await mcp.child.exited).toBe(0);
});

test('SCK_COMM_* 缺失不拖垮服务器：tools/list 照答，tools/call 回 isError', async () => {
  const mcp = startMcp({});
  mcp.send({ jsonrpc: '2.0', id: 40, method: 'tools/list' });
  const list = await mcp.wait(40);
  expect((list.result as { tools: unknown[] }).tools).toHaveLength(7);

  mcp.send({ jsonrpc: '2.0', id: 41, method: 'tools/call', params: { name: 'task_current', arguments: {} } });
  const res = await mcp.wait(41);
  const result = res.result as { isError: boolean; structuredContent: { error: { code: string } } };
  expect(result.isError).toBe(true);
  expect(result.structuredContent.error.code).toBe('missing_comm_dir');
});
