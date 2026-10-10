import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SidecarPool, type SidecarDeps } from '../plugin/server/sidecar.ts';
import type { EmployeeInst, SupervisedTask } from '../src/workforce.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('插件认证重试保留原请求租约，不能在 B 下重放 A 的 ops 请求', async () => {
  const root = mkdtempSync(join(tmpdir(), 'plugin-lease-'));
  const pending = deferred<unknown>();
  const entered = deferred<void>();
  const calls: string[] = [];
  let rotations = 0;
  const pool = new SidecarPool({
    runDir: join(root, 'comm'), sweepMs: 2, heartbeatMs: 1_000_000,
    core: {
      claim: async (_credential: string, id: string) => ({
        task: { id, version: 2 }, deliveryId: `delivery-${id}`, fence: 1, history: [],
      }),
      submit: async () => ({ id: 'A', version: 3 }),
    } as unknown as SidecarDeps['core'],
    workforce: { rotate: async () => { rotations++; return 'synthetic-rotated'; } } as unknown as SidecarDeps['workforce'],
    ops: {
      tools: ['ops_info'], release: () => {},
      call: async (_credential, task) => {
        calls.push(task);
        if (calls.length === 1) { entered.resolve(); return pending.promise; }
        return { synthetic: true };
      },
    },
  });
  const inst: EmployeeInst = { id: 'synthetic-integration', role: 'engineering', credential: 'synthetic-only' };
  const env = pool.env(inst);
  pool.bindAgent(inst.id, 'synthetic-agent');
  inst.paseoAgentId = 'synthetic-agent';
  let requests = 0;
  const relay = async (tool: string) => {
    const file = `${++requests}.json`;
    writeFileSync(join(env.SCK_COMM_DIR!, 'req', file), JSON.stringify({ key: env.SCK_COMM_KEY, tool, args: {} }));
    const response = join(env.SCK_COMM_DIR!, 'res', file);
    for (let n = 0; n < 200 && !existsSync(response); n++) await Bun.sleep(5);
    if (!existsSync(response)) throw new Error('response timeout');
    return JSON.parse(readFileSync(response, 'utf8')) as { ok: boolean; error?: string };
  };
  try {
    await pool.claim(inst, { id: 'A' } as SupervisedTask);
    const oldRequest = relay('ops_info');
    await entered.promise;
    expect((await relay('submit')).ok).toBe(true);
    await pool.claim(inst, { id: 'B' } as SupervisedTask);
    pending.reject(Object.assign(new Error('unauthorized synthetic'), { code: 'unauthorized' }));
    const response = await oldRequest;
    expect(response.ok).toBe(false);
    expect(response.error).toContain('no_lease');
    expect(calls).toEqual(['A']);
    expect(rotations).toBe(1);
    expect((await relay('ops_info')).ok).toBe(true);
    expect(calls).toEqual(['A', 'B']);
  } finally {
    pool.detachAgent('synthetic-agent');
    rmSync(root, { recursive: true, force: true });
  }
});

test('健康 launch 写绑定，重启 adopt 重铸通道：轮换凭证、重写绑定 key、实例可复用', async () => {
  const root = mkdtempSync(join(tmpdir(), 'plugin-binding-'));
  let rotations = 0;
  const deps: SidecarDeps = {
    runDir: join(root, 'comm'), sweepMs: 1_000_000,
    core: { listTasks: async () => [] } as unknown as SidecarDeps['core'],
    workforce: { rotate: async () => { rotations++; return 'synthetic-only'; } } as unknown as SidecarDeps['workforce'],
  };
  const original = new SidecarPool(deps);
  const replacement = new SidecarPool(deps);
  const inst: EmployeeInst = { id: 'synthetic-binding', role: 'engineering', credential: 'synthetic-only' };
  const binding = join(root, 'comm-agents', 'synthetic-agent');
  try {
    original.env(inst);
    original.bindAgent(inst.id, 'synthetic-agent');
    inst.paseoAgentId = 'synthetic-agent';
    expect(existsSync(binding)).toBe(true);
    const oldKey = readFileSync(binding, 'utf8').split('\n')[1];
    // Same-process adoption is idempotent — the binding is already healthy.
    await original.adopt([inst]);
    expect(original.canReuse(inst)).toBe(true);
    expect(readFileSync(binding, 'utf8').split('\n')[1]).toBe(oldKey);
    // A replacement process (restart) cannot reuse the in-memory key, so it
    // rotates the credential and re-keys the pointer instead of quarantining.
    await replacement.adopt([inst]);
    expect(rotations).toBe(1);
    expect(replacement.canReuse(inst)).toBe(true);
    const newKey = readFileSync(binding, 'utf8').split('\n')[1];
    expect(newKey).not.toBe(oldKey);
    expect(replacement.env(inst).SCK_COMM_KEY).toBe(newKey);
  } finally {
    original.detachAgent('synthetic-agent');
    replacement.detachAgent('synthetic-agent');
    rmSync(root, { recursive: true, force: true });
  }
});
