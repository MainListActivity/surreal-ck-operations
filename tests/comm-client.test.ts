import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureCommDirs, reqDir, resDir, writeFileAtomic } from '../src/comm.ts';
import type { CompanyCore } from '../src/contracts.ts';
import { createMcpHttpService } from '../src/mcp/server.ts';

// The comm client's own refusals (SYS01 AC03): every outcome is one line of JSON on stdout, with a recoverable
// code and the reason on stderr. Each case runs the real client file; no network is needed for these paths.
const ROOT = join(import.meta.dir, '..');
const CLIENT = join(ROOT, 'src/mcp/client-cli.ts');
const CREDENTIAL_ENV = ['SCK_COMM_DIR', 'SCK_COMM_KEY', 'SCK_MCP_URL', 'SCK_MCP_TOKEN', 'SCK_EMPLOYEE_CREDENTIAL', 'SCK_EMPLOYEE_CREDENTIAL_FILE'];

function cleanEnv(overrides: Record<string, string | undefined> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !CREDENTIAL_ENV.includes(key)) env[key] = value;
  }
  for (const [key, value] of Object.entries(overrides)) if (value !== undefined) env[key] = value;
  return env;
}

async function client(args: string[], overrides: Record<string, string | undefined> = {}) {
  const child = Bun.spawn([process.execPath, CLIENT, ...args], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe', env: cleanEnv(overrides) });
  const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { out, err, exit: await child.exited };
}

/** Exactly one JSON line on stdout: no stack trace, no empty output, no second line. */
function oneJsonLine(out: string): Record<string, unknown> {
  expect(out.endsWith('\n')).toBe(true);
  expect(out.trimEnd().split('\n')).toHaveLength(1);
  return JSON.parse(out) as Record<string, unknown>;
}

function commDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'comm-client-'));
  ensureCommDirs(dir);
  return dir;
}

function requestFiles(dir: string): string[] {
  return readdirSync(reqDir(dir)).filter(name => name.endsWith('.json'));
}

async function waitForRequest(dir: string): Promise<string> {
  for (let n = 0; n < 400; n++) {
    const [file] = requestFiles(dir);
    if (file) return file;
    await Bun.sleep(20);
  }
  throw new Error('the client did not write a request');
}

test('local refusals are one JSON line with a recoverable code, the reason on stderr, and exit 1', async () => {
  const dir = commDir();
  const withComm = { SCK_COMM_DIR: dir, SCK_COMM_KEY: 'comm-client-key' };
  const cases: Array<{ args: string[]; env: Record<string, string | undefined>; code: string; reason: RegExp }> = [
    { args: ['bogus'], env: {}, code: 'invalid_arguments', reason: /usage/ },
    { args: ['call'], env: {}, code: 'invalid_arguments', reason: /tool name/ },
    { args: ['call', 'get_context', '{bad'], env: {}, code: 'invalid_arguments', reason: /not valid JSON/ },
    { args: ['call', 'get_context', '{bad'], env: withComm, code: 'invalid_arguments', reason: /not valid JSON/ },
    { args: ['call', 'get_context', '[]'], env: withComm, code: 'invalid_arguments', reason: /one JSON object/ },
    { args: ['call', 'get_context', 'null'], env: withComm, code: 'invalid_arguments', reason: /one JSON object/ },
    { args: ['call', 'get_context', '"text"'], env: withComm, code: 'invalid_arguments', reason: /one JSON object/ },
    { args: ['call', 'get_context'], env: { SCK_COMM_DIR: dir, SCK_COMM_KEY: undefined }, code: 'missing_comm_key', reason: /SCK_COMM_KEY/ },
    { args: ['call', 'get_context'], env: { SCK_COMM_DIR: join(dir, 'absent'), SCK_COMM_KEY: 'k' }, code: 'comm_unavailable', reason: /SCK_COMM_DIR/ },
    { args: ['call', 'get_context'], env: {}, code: 'missing_endpoint', reason: /SCK_MCP_URL/ },
    { args: ['call', 'get_context'], env: { SCK_MCP_URL: 'http://127.0.0.1:9/mcp' }, code: 'missing_credential', reason: /SCK_EMPLOYEE_CREDENTIAL/ },
    { args: ['call', 'get_context', '{bad'], env: { SCK_MCP_URL: 'http://127.0.0.1:9/mcp', SCK_EMPLOYEE_CREDENTIAL: 'x' }, code: 'invalid_arguments', reason: /not valid JSON/ },
  ];
  for (const item of cases) {
    const run = await client(item.args, item.env);
    expect(run.exit, item.code).toBe(1);
    expect(oneJsonLine(run.out), item.code).toMatchObject({ ok: false, code: item.code });
    expect(run.err, item.code).toMatch(item.reason);
  }
  // Refused before the request is written: nothing reached the sidecar.
  expect(requestFiles(dir)).toEqual([]);
  rmSync(dir, { recursive: true, force: true });
});

test('an empty argument string means no arguments, and the request is written with them', async () => {
  const dir = commDir();
  const child = Bun.spawn([process.execPath, CLIENT, 'call', 'get_context', ''], {
    cwd: ROOT, stdout: 'pipe', stderr: 'pipe', env: cleanEnv({ SCK_COMM_DIR: dir, SCK_COMM_KEY: 'comm-client-key' }),
  });
  const file = await waitForRequest(dir);
  const request = JSON.parse(readFileSync(join(reqDir(dir), file), 'utf8')) as Record<string, unknown>;
  child.kill();
  await child.exited;
  expect(request).toEqual({ key: 'comm-client-key', tool: 'get_context', args: {} });
  rmSync(dir, { recursive: true, force: true });
});

test('a sidecar refusal keeps its code and reason, as JSON on stdout', async () => {
  const dir = commDir();
  const child = Bun.spawn([process.execPath, CLIENT, 'call', 'get_context', '{"pageSize":0}'], {
    cwd: ROOT, stdout: 'pipe', stderr: 'pipe', env: cleanEnv({ SCK_COMM_DIR: dir, SCK_COMM_KEY: 'comm-client-key' }),
  });
  const file = await waitForRequest(dir);
  writeFileAtomic(join(resDir(dir), file), JSON.stringify({ ok: false, error: 'invalid: pageSize must be an integer from 1 to 100' }));
  const out = await new Response(child.stdout).text();
  const err = await new Response(child.stderr).text();
  expect(await child.exited).toBe(1);
  expect(oneJsonLine(out)).toMatchObject({ ok: false, code: 'invalid', error: 'invalid: pageSize must be an integer from 1 to 100', retryable: false });
  expect(err).toContain('pageSize');
  rmSync(dir, { recursive: true, force: true });
});

test('a sidecar answer passes through as one JSON line, Chinese and emoji intact', async () => {
  const dir = commDir();
  const child = Bun.spawn([process.execPath, CLIENT, 'call', 'get_context', '{}'], {
    cwd: ROOT, stdout: 'pipe', stderr: 'pipe', env: cleanEnv({ SCK_COMM_DIR: dir, SCK_COMM_KEY: 'comm-client-key' }),
  });
  const file = await waitForRequest(dir);
  const data = { tasks: [{ title: '中文标题🙂' }], page: { returned: 1, hasMore: false } };
  writeFileAtomic(join(resDir(dir), file), JSON.stringify({ ok: true, data }));
  const out = await new Response(child.stdout).text();
  expect(await child.exited).toBe(0);
  expect(out).toBe(`${JSON.stringify(data)}\n`);
  expect(oneJsonLine(out)).toEqual(data);
  rmSync(dir, { recursive: true, force: true });
});

// SYS-INT 复核 round-02（需求 4）：sidecar 把未确认的修订通知挂在回包顶层；客户端要把它带到员工看得见的
// 那一行 JSON 里——数据是对象时并进对象，否则包成 {data, notices}，始终只有一行。
test('unacked holder notices ride along with the next answer, still as one JSON line', async () => {
  const notices = [{ noticeKey: 'task-1:acceptance_amended:audit-1:a-eng', kind: 'acceptance_amended', taskId: 'task-1', text: '验收要求已修订' }];
  const run = async (data: unknown, name: string) => {
    const dir = commDir();
    const child = Bun.spawn([process.execPath, CLIENT, 'call', 'checkpoint', '{"text":"half"}'], {
      cwd: ROOT, stdout: 'pipe', stderr: 'pipe', env: cleanEnv({ SCK_COMM_DIR: dir, SCK_COMM_KEY: 'comm-client-key' }),
    });
    const file = await waitForRequest(dir);
    writeFileAtomic(join(resDir(dir), file), JSON.stringify({ ok: true, data, notices }));
    const out = await new Response(child.stdout).text();
    expect(await child.exited, name).toBe(0);
    rmSync(dir, { recursive: true, force: true });
    return oneJsonLine(out);
  };
  const task = { id: 'task-1', state: 'review', version: 21 };
  expect(await run(task, 'object data')).toEqual({ ...task, notices });
  expect(await run([1, 2], 'array data')).toEqual({ data: [1, 2], notices });
});

test('a direct call prints one answer: the data within the budget on success; one refusal line and exit 1 on failure (SYS01 AC03, F1)', async () => {
  // The same 60-task page with 200-character contexts fits. The MCP result carries the answer twice (as text and as
  // structuredContent), and the 48 KiB budget counts both copies, so the direct call prints the answer once and it is
  // within the budget. With 400-character contexts the whole result is over the budget and is refused as one line.
  const principal = { employeeId: 'gm-01', role: 'owner', capabilities: ['execute', 'review'] };
  const page = (contextLength: number) => ({
    principal,
    tasks: Array.from({ length: 60 }, (_, i) => ({ id: `task:${i}`, title: `样例 ${i} 中文🙂`, state: 'ready', context: `正文 "${i}" ${'x'.repeat(contextLength)}` })),
    page: { pageSize: 60, returned: 60, hasMore: false, total: 60 },
  });
  const fits = page(200);
  let answer: unknown = fits;
  const core = {
    async authenticate(credential: string) {
      if (credential !== 'sck_direct_valid') throw { code: 'unauthorized' };
      return principal;
    },
    async contextView(_credential: string, input: Record<string, unknown>) {
      if (input.taskId === 'missing') throw Object.assign(new Error('no such task'), { code: 'not_found' });
      return answer;
    },
  } as unknown as CompanyCore;
  const service = createMcpHttpService({ core, port: 0 });
  const env = { SCK_MCP_URL: `http://127.0.0.1:${service.port}/mcp`, SCK_EMPLOYEE_CREDENTIAL: 'sck_direct_valid' };
  try {
    const answered = await client(['call', 'get_context', '{"pageSize":60}'], env);
    expect(answered.exit).toBe(0);
    expect(answered.out.trimEnd().split('\n')).toHaveLength(1);
    expect(Buffer.byteLength(answered.out, 'utf8')).toBeLessThanOrEqual(49_152);
    expect(JSON.parse(answered.out)).toEqual(fits);

    answer = page(400);
    const oversized = await client(['call', 'get_context', '{"pageSize":60}'], env);
    expect(oversized.exit).toBe(1);
    expect(oneJsonLine(oversized.out)).toMatchObject({ ok: false, code: 'response_too_large', retryable: false });
    expect(oversized.err).toContain('49152-byte budget');

    const refused = await client(['call', 'get_context', '{"taskId":"missing"}'], env);
    expect(refused.exit).toBe(1);
    expect(oneJsonLine(refused.out)).toEqual({ ok: false, code: 'not_found', error: 'not_found: no such task', retryable: false });
    expect(refused.err).toContain('no such task');
  } finally {
    await service.close();
  }
});

// zsh leaves "$(cat)" empty in the last pipeline stage, so the client gets '' and the JSON on stdin.
const PIPED = '{"session":"s_1","method":"GET","path":"/api/ops/x"}';
const zshPipe = (dir: string) => Bun.spawn(['/bin/zsh', '-fc', `printf '%s' '${PIPED}' | "${process.execPath}" "${CLIENT}" call ops_request "$(cat)"`],
  { cwd: ROOT, stdout: 'pipe', stderr: 'pipe', env: cleanEnv({ SCK_COMM_DIR: dir, SCK_COMM_KEY: 'comm-client-key' }) });
const emptyArgWithPipe = (dir: string) => Bun.spawn([process.execPath, CLIENT, 'call', 'ops_request', ''],
  { cwd: ROOT, stdin: new Blob([PIPED]), stdout: 'pipe', stderr: 'pipe', env: cleanEnv({ SCK_COMM_DIR: dir, SCK_COMM_KEY: 'comm-client-key' }) });
for (const [name, spawn] of [['an empty argument with piped stdin', emptyArgWithPipe], ['a real zsh "jq … | sck call tool \"$(cat)\""', zshPipe]] as const)
test.skipIf(spawn === zshPipe && !existsSync('/bin/zsh'))(`${name} sends the piped JSON, not an empty argument list`, async () => {
  const dir = commDir();
  try {
    const child = spawn(dir);
    const file = await waitForRequest(dir);
    const request = JSON.parse(readFileSync(join(reqDir(dir), file), 'utf8'));
    expect(request.args).toEqual({ session: 's_1', method: 'GET', path: '/api/ops/x' });
    child.kill();
    await child.exited;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
