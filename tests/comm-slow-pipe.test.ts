import { expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureCommDirs, reqDir, resDir, writeFileAtomic } from '../src/comm.ts';

// Regression for the comm client's stdout (SYS01 AC01, AC03). The pre-SYS01 client wrote with process.stdout.write
// and then called process.exit, so a reader slower than the writer cut the answer at the 64 KiB pipe buffer.
// Only a real shell pipe with a slow reader reproduces that: a Bun.spawn pipe drains at once and hides it.
// The stand-in sidecar answers with an unguarded 1000-task payload on purpose, so the transport alone is tested.
const ROOT = join(import.meta.dir, '..');
const CLIENT = join(ROOT, 'src/mcp/client-cli.ts');
const LEGACY_CLIENT = join(ROOT, 'tests/fixtures/comm-client-8d03d35.ts');
const TASKS = 1000;
const unit = '中文🙂字符';

/** 1000 task rows with Chinese and emoji titles; every 25th context is long (about 7500 code points). */
function fixturePayload() {
  const tasks = Array.from({ length: TASKS }, (_, index) => ({
    id: `task:fixture${String(index).padStart(4, '0')}`,
    title: `样例 ${index} ${unit}`,
    state: ['ready', 'doing', 'review', 'blocked', 'done'][index % 5],
    context: index % 25 === 0 ? `第${index}条长正文 ${unit.repeat(1500)}` : `短正文 ${index} ${unit}`,
  }));
  return { principal: { employeeId: 'fixture-gm', role: 'owner' }, tasks, page: { returned: TASKS, hasMore: false } };
}

function cleanEnv(overrides: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith('SCK_COMM_') && !key.startsWith('SCK_EMPLOYEE_') && key !== 'SCK_MCP_URL') env[key] = value;
  }
  return { ...env, ...overrides };
}

async function waitForRequest(dir: string): Promise<string> {
  for (let n = 0; n < 500; n++) {
    const [file] = readdirSync(reqDir(dir)).filter(name => name.endsWith('.json'));
    if (file) return file;
    await Bun.sleep(20);
  }
  throw new Error('the client did not write a request');
}

/**
 * Runs `client call get_context` with its stdout piped through `sh`: the reader sleeps two seconds before it reads,
 * so the pipe fills while the client writes. The stand-in sidecar answers the request file with `payload`.
 */
async function throughSlowPipe(client: string, payload: unknown): Promise<{ bytes: Buffer; status: string; stderr: string }> {
  const commRoot = mkdtempSync(join(tmpdir(), 'comm-pipe-'));
  const outRoot = mkdtempSync(join(tmpdir(), 'comm-pipe-out-'));
  ensureCommDirs(commRoot);
  const out = join(outRoot, 'stdout.bin');
  const status = join(outRoot, 'status.txt');
  const script = 'status="$1"; out="$2"; shift 2; { "$@"; echo $? > "$status"; } | { sleep 2; cat; } > "$out"';
  const child = Bun.spawn(['sh', '-c', script, 'sh', status, out, process.execPath, client, 'call', 'get_context', '{}'], {
    stdout: 'ignore', stderr: 'pipe', env: cleanEnv({ SCK_COMM_DIR: commRoot, SCK_COMM_KEY: 'slow-pipe-key' }),
  });
  const file = await waitForRequest(commRoot);
  writeFileAtomic(join(resDir(commRoot), file), JSON.stringify({ ok: true, data: payload }));
  const stderr = await new Response(child.stderr).text();
  await child.exited;
  const result = { bytes: readFileSync(out), status: readFileSync(status, 'utf8').trim(), stderr };
  rmSync(commRoot, { recursive: true, force: true });
  rmSync(outRoot, { recursive: true, force: true });
  return result;
}

test('the comm client delivers every byte of a 1000-task answer through a slow shell pipe', async () => {
  const payload = fixturePayload();
  const expected = `${JSON.stringify(payload)}\n`;
  const expectedBytes = Buffer.byteLength(expected, 'utf8');
  expect(expectedBytes).toBeGreaterThan(4 * 65_536);
  const run = await throughSlowPipe(CLIENT, payload);
  expect(run.status).toBe('0');
  expect(run.bytes.length).toBe(expectedBytes);
  expect(run.bytes.toString('utf8')).toBe(expected);
  const parsed = JSON.parse(run.bytes.toString('utf8')) as typeof payload;
  expect(parsed.tasks).toHaveLength(TASKS);
  expect(parsed.tasks.every(task => task.title.includes('🙂'))).toBe(true);
  console.log(JSON.stringify({ check: 'comm-slow-pipe', client: 'src/mcp/client-cli.ts', expectedBytes, receivedBytes: run.bytes.length, exit: run.status }));
});

// Red control (not a CI gate: the pipe behaviour depends on the host). Run locally with SCK_COMM_CONTROL=1 to show
// that the pre-SYS01 client loses the tail through the same pipe; the harness above is only trusted if this is red.
const control = process.env.SCK_COMM_CONTROL === '1' ? test : test.skip;
control('control: the 8d03d35 client cuts the same answer at the pipe buffer', async () => {
  const payload = fixturePayload();
  const expectedBytes = Buffer.byteLength(`${JSON.stringify(payload)}\n`, 'utf8');
  const run = await throughSlowPipe(LEGACY_CLIENT, payload);
  console.log(JSON.stringify({ check: 'comm-slow-pipe-control', client: 'comm-client-8d03d35', expectedBytes, receivedBytes: run.bytes.length, exit: run.status }));
  expect(run.bytes.length).toBeLessThan(expectedBytes);
});
