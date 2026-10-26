import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, existsSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SidecarPool } from '../plugin/server/sidecar.ts';
import { commDir, reqDir, resDir, readJsonFile } from '../src/comm.ts';
import type { ActiveLease, ClaimResult, LeaseProof, TaskView } from '../src/contracts.ts';
import type { EmployeeInst, SupervisedTask } from '../src/workforce.ts';

// SYS04: the plugin runtime diagnostic rides the employee's own `sck call` channel. These cases pin what the
// acceptance asks for — the answer comes from the plugin execution context, an unauthorized request is
// refused, and no sensitive content rides along.

const taskView = (id: string, version = 1): TaskView => ({
  id, title: `t-${id}`, context: '', state: 'doing', executorRole: 'engineering', reviewerRole: 'qa',
  kind: 'task', dependencies: [], version, fence: 1, deliveryId: `d-${id}`,
});
const claimResult = (taskId: string): ClaimResult => ({
  task: taskView(taskId), deliveryId: `d-${taskId}`, fence: 7, leaseExpiresAt: new Date().toISOString(), history: [],
});

const core = {
  authenticate: async () => ({ employeeId: 'eng-x', role: 'engineering' }),
  listTasks: async () => [], getTask: async () => taskView('task-x'),
  heartbeat: async () => ({}), claim: async () => claimResult('task-x'), checkpoint: async () => ({}),
  submit: async () => ({}), review: async () => ({}), block: async () => ({}), history: async () => [],
  worktreeList: async () => [], worktreePage: async () => ({ worktrees: [], page: {} }),
  contextView: async () => ({ principal: { employeeId: 'eng-x' }, tasks: [] }),
};
const workforce = { rotate: async () => ({}), list: async () => [], heartbeat: async () => ({}) };
const ops = { tools: ['ops_info'] as const, call: async () => ({ ok: true }), release: () => undefined };
const inst = (id: string, extra: Partial<EmployeeInst> = {}): EmployeeInst =>
  ({ id, employeeId: 'eng-x', role: 'engineering', comm: id, ...extra } as EmployeeInst);
const task = (id: string) => ({ id, title: `t-${id}`, state: 'doing', executorRole: 'engineering', reviewerRole: 'qa' } as unknown as SupervisedTask);

const until = async (predicate: () => boolean, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(10);
};
const relay = async (envDir: string, key: string, name: string, tool: string, args: Record<string, unknown> | null) => {
  writeFileSync(join(reqDir(envDir), `${name}.json`), JSON.stringify({ key, tool, args }));
  await until(() => existsSync(join(resDir(envDir), `${name}.json`)));
  return readJsonFile<{ ok: boolean; data?: unknown; error?: string }>(join(resDir(envDir), `${name}.json`))!;
};

let runDir: string;
let pool: SidecarPool;
beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'sck-rt-diag-sidecar-'));
  pool = new SidecarPool({ core: core as never, workforce: workforce as never, ops, runDir, heartbeatMs: 10_000, sweepMs: 20 });
});
afterEach(() => { pool.close(); rmSync(runDir, { recursive: true, force: true }); });

describe('plugin_runtime_diagnostics through the employee channel', () => {
  test('the answer reaches the employee with the plugin execution context, the collection instant and the loaded paths', async () => {
    const i = inst('e-rt');
    const env = pool.env(i);
    await pool.claim(i, task('task-rt'));
    const answer = await relay(env.SCK_COMM_DIR, env.SCK_COMM_KEY!, 'rt1', 'plugin_runtime_diagnostics', {});
    expect(answer.ok).toBe(true);
    const data = answer.data as Record<string, unknown>;
    // The context is explicit, and the stamp says this answer came from the plugin face rather than the MCP one.
    expect(data.context).toBe('plugin-host');
    expect(data.channel).toBe('plugin-sidecar');
    expect(data.instanceId).toBe('e-rt');
    expect(String(data.collectedAt)).toMatch(/Z$/);
    // Loaded paths and a content binding, from this process.
    expect((data.loaded as { serverDir: string | null }).serverDir).toContain('plugin/server');
    const modules = data.modules as Array<{ name: string; sha256: string | null }>;
    expect(modules.length).toBeGreaterThan(0);
    expect(modules.some(m => m.sha256 !== null)).toBe(true);
  });

  test('the tool is advertised to the employee, so it is discoverable rather than hidden', async () => {
    const i = inst('e-list');
    const env = pool.env(i);
    await pool.claim(i, task('task-list'));
    const answer = await relay(env.SCK_COMM_DIR, env.SCK_COMM_KEY!, 'l1', '__list__', {});
    expect(answer.ok).toBe(true);
    expect((answer.data as { tools: string[] }).tools).toContain('plugin_runtime_diagnostics');
  });

  test('an unauthorized request is refused before any diagnostic is produced', async () => {
    // The comm key is this channel's authorization, exactly as for every other tool on it: the plugin mints it
    // for one employee session and hands it over only in the session's spawn env. A request carrying a wrong
    // key never reaches the dispatcher, so nothing is sampled.
    const i = inst('e-bad');
    const env = pool.env(i);
    await pool.claim(i, task('task-bad'));
    const answer = await relay(env.SCK_COMM_DIR, 'not-the-key', 'bad1', 'plugin_runtime_diagnostics', {});
    expect(answer.ok).toBe(false);
    expect(answer.error).toContain('stale comm key');
  });

  test('a request whose key predates a plugin restart is refused, not answered with stale facts', async () => {
    // A rotated key means the session outlived a restart: the answer would describe a process the caller no
    // longer belongs to, so the channel refuses it instead.
    const i = inst('e-restart');
    const env = pool.env(i);
    await pool.claim(i, task('task-restart'));
    const rotated = 'a'.repeat(32);
    (pool as unknown as { keys: Map<string, string> }).keys.set(i.id, rotated);
    const answer = await relay(env.SCK_COMM_DIR, env.SCK_COMM_KEY!, 'r1', 'plugin_runtime_diagnostics', {});
    expect(answer.ok).toBe(false);
    expect(answer.error).toContain('stale comm key');
  });

  test('the answer carries no credential, private path or environment value', async () => {
    const home = mkdtempSync(join(tmpdir(), 'sck-rt-home-'));
    // A private service env with a real-looking secret must not surface in the answer.
    mkdirSync(join(home, 'private'), { recursive: true });
    writeFileSync(join(home, 'private', 'service.env'), 'SCK_MCP_TOKEN=secret-token-value\nSCK_EMPLOYEE_CREDENTIAL=cred-value\n');
    const prev = process.env.SCK_SERVICE_HOME;
    process.env.SCK_SERVICE_HOME = home;
    try {
      const i = inst('e-secret');
      const env = pool.env(i);
      await pool.claim(i, task('task-secret'));
      const answer = await relay(env.SCK_COMM_DIR, env.SCK_COMM_KEY!, 's1', 'plugin_runtime_diagnostics', {});
      expect(answer.ok).toBe(true);
      const text = JSON.stringify(answer.data);
      expect(text).not.toContain('secret-token-value');
      expect(text).not.toContain('cred-value');
      expect(text).not.toContain('SCK_MCP_TOKEN');
      expect(text).not.toContain('SCK_EMPLOYEE_CREDENTIAL');
      // The boundary is declared in the answer itself, so a reader can check it without the source.
      expect(text).toContain('process environment values');
    } finally { process.env.SCK_SERVICE_HOME = prev; }
  });

  test('the reported release binding is the loaded code, not the active symlink', async () => {
    // A service home whose `active` points somewhere else entirely: the answer must not simply echo it.
    const home = mkdtempSync(join(tmpdir(), 'sck-rt-active-'));
    const elsewhere = mkdtempSync(join(tmpdir(), 'sck-rt-elsewhere-'));
    mkdirSync(join(home, 'releases', 'f'.repeat(40)), { recursive: true });
    symlinkSync(elsewhere, join(home, 'active'));
    const prev = process.env.SCK_SERVICE_HOME;
    process.env.SCK_SERVICE_HOME = home;
    try {
      const i = inst('e-active');
      const env = pool.env(i);
      await pool.claim(i, task('task-active'));
      const answer = await relay(env.SCK_COMM_DIR, env.SCK_COMM_KEY!, 'a1', 'plugin_runtime_diagnostics', {});
      expect(answer.ok).toBe(true);
      const binding = (answer.data as { binding: { kind: string; path: string | null } }).binding;
      // The binding names the release the plugin's own code resolves into, never the symlink's target.
      expect(binding.path).not.toBe(elsewhere);
      expect(String(JSON.stringify(answer.data))).not.toContain(elsewhere);
    } finally { process.env.SCK_SERVICE_HOME = prev; }
  });

  test('a null argument object is accepted for this read, and the answer still arrives', async () => {
    // Same rule as the other reads on this channel: null means "no arguments", not an error.
    const i = inst('e-null');
    const env = pool.env(i);
    await pool.claim(i, task('task-null'));
    const answer = await relay(env.SCK_COMM_DIR, env.SCK_COMM_KEY!, 'n1', 'plugin_runtime_diagnostics', null);
    expect(answer.ok).toBe(true);
    expect((answer.data as { context: string }).context).toBe('plugin-host');
  });
});
