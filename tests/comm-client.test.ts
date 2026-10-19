import { expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureCommDirs, reqDir, resDir, writeFileAtomic } from '../src/comm.ts';

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
  expect(oneJsonLine(out)).toMatchObject({ ok: false, code: 'invalid', retryable: false });
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
