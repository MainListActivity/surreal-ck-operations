// 迟到收尾交错回归：旧 report/blocker 提交与旧 heartbeat 在新租约建立后才收尾时，
// 不得结束新租约、不得移走新写入的同名文件。只用临时目录与合成身份，
// 不访问生产、凭证或真实 comm。
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SidecarPool, type SidecarDeps } from '../plugin/server/sidecar.ts';
import type { EmployeeInst, SupervisedTask } from '../src/workforce.ts';
import { reportPath, blockerPath } from '../src/comm.ts';

function deferred<T>() {
  let resolve!: (v: T) => void, reject!: (e: Error) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

const claimResult = (id: string) => ({
  task: { id, title: id, version: 2, state: 'doing' },
  deliveryId: `delivery-${id}`, fence: 1, history: [], leaseExpiresAt: new Date().toISOString(),
});

interface Harness {
  pool: SidecarPool;
  dir: string;
  entered: { promise: Promise<void> };
  pending: { resolve: (v: { task: { id: string; version: number; state: string } }) => void; reject: (e: Error) => void };
  claim: (taskId: string) => Promise<unknown>;
  relay: (tool: string) => Promise<{ ok: boolean; error?: string }>;
  cleanup: () => void;
}

/** 第一个指定调用挂起，直到用例手动 resolve/reject，制造与新租约交错的迟到收尾。 */
function harness(opts: { hang: 'submit' | 'block' | 'heartbeat'; heartbeatMs?: number }): Harness {
  const root = mkdtempSync(join(tmpdir(), 'late-lease-'));
  const entered = deferred<void>();
  const pending = deferred<{ task: { id: string; version: number; state: string } }>();
  let submits = 0, blocks = 0, beats = 0, requests = 0;
  const core = {
    claim: async (_c: string, id: string) => claimResult(id),
    submit: async (_c: string, p: { taskId: string }) => {
      if (opts.hang === 'submit' && ++submits === 1) { entered.resolve(); return pending.promise; }
      return { id: p.taskId, version: 3, state: 'review' };
    },
    block: async (_c: string, p: { taskId: string }, _to: string) => {
      if (opts.hang === 'block' && ++blocks === 1) { entered.resolve(); return pending.promise; }
      return { id: p.taskId, version: 3, state: 'blocked' };
    },
    heartbeat: async (_c: string, p: { taskId: string }) => {
      if (opts.hang === 'heartbeat' && ++beats === 1) { entered.resolve(); return pending.promise; }
      return { task: { id: p.taskId, version: 2 } };
    },
  };
  const pool = new SidecarPool({
    core: core as unknown as SidecarDeps['core'], workforce: {} as SidecarDeps['workforce'],
    runDir: root, sweepMs: 2, heartbeatMs: opts.heartbeatMs ?? 1_000_000,
    ops: { tools: ['ops_info'], call: async () => ({ fixture: true }), release: () => {} },
  });
  const inst: EmployeeInst = { id: 'synthetic-late-lease', role: 'engineering', credential: 'synthetic-test-only' };
  const env = pool.env(inst);
  const dir = env.SCK_COMM_DIR!;
  pool.bindAgent(inst.id, 'synthetic-agent');
  inst.paseoAgentId = 'synthetic-agent';
  const claim = (id: string) => pool.claim(inst, { id } as SupervisedTask);
  const relay = async (tool: string) => {
    const name = `${++requests}.json`;
    writeFileSync(join(dir, 'req', name), JSON.stringify({ key: env.SCK_COMM_KEY, tool, args: { text: 'synthetic' } }));
    const path = join(dir, 'res', name);
    for (let i = 0; i < 200 && !existsSync(path); i++) await Bun.sleep(5);
    if (!existsSync(path)) throw new Error('response timeout');
    return JSON.parse(readFileSync(path, 'utf8')) as { ok: boolean; error?: string };
  };
  const cleanup = () => { pool.detachAgent('synthetic-agent'); rmSync(root, { recursive: true, force: true }); };
  return { pool, dir, entered, pending, claim, relay, cleanup };
}

describe('迟到收尾与新租约交错', () => {
  test('旧 report 提交晚失败不删除新租约', async () => {
    const h = harness({ hang: 'submit' });
    try {
      await h.claim('A');
      writeFileSync(reportPath(h.dir), 'A 的报告');
      const settling = h.pool.settle('synthetic-agent');
      await h.entered.promise;
      expect((await h.relay('submit')).ok).toBe(true); // agent 自己的 submit 消费 A 的租约
      await h.claim('B');
      expect((await h.relay('ops_info')).ok).toBe(true);
      h.pending.reject(Object.assign(Error('stale lease A'), { code: 'stale_lease' }));
      await settling;
      expect((await h.relay('ops_info')).ok).toBe(true);
    } finally { h.cleanup(); }
  });

  test('旧 report 提交晚失败不移走 B 新写入的 report.md', async () => {
    const h = harness({ hang: 'submit' });
    try {
      await h.claim('A');
      writeFileSync(reportPath(h.dir), 'A 的报告');
      const settling = h.pool.settle('synthetic-agent');
      await h.entered.promise;
      expect((await h.relay('submit')).ok).toBe(true);
      await h.claim('B');
      writeFileSync(reportPath(h.dir), 'B 的新报告');
      h.pending.reject(Object.assign(Error('stale lease A'), { code: 'stale_lease' }));
      await settling;
      expect(readFileSync(reportPath(h.dir), 'utf8')).toBe('B 的新报告');
      expect(readdirSync(h.dir).some(n => /^report\.md\.(failed|done)-/.test(n))).toBe(false);
    } finally { h.cleanup(); }
  });

  test('旧 report 提交晚成功不结束新租约、不移走新文件', async () => {
    const h = harness({ hang: 'submit' });
    try {
      await h.claim('A');
      writeFileSync(reportPath(h.dir), 'A 的报告');
      const settling = h.pool.settle('synthetic-agent');
      await h.entered.promise;
      expect((await h.relay('submit')).ok).toBe(true);
      await h.claim('B');
      writeFileSync(reportPath(h.dir), 'B 的新报告');
      h.pending.resolve({ task: { id: 'A', version: 3, state: 'review' } });
      await settling;
      expect((await h.relay('ops_info')).ok).toBe(true);
      expect(readFileSync(reportPath(h.dir), 'utf8')).toBe('B 的新报告');
      expect(readdirSync(h.dir).some(n => /^report\.md\.(failed|done)-/.test(n))).toBe(false);
    } finally { h.cleanup(); }
  });

  test('旧 blocker 提交晚失败不删除新租约、不移走 B 新 blocker', async () => {
    const h = harness({ hang: 'block' });
    try {
      await h.claim('A');
      writeFileSync(blockerPath(h.dir), 'A 的阻塞');
      const settling = h.pool.settle('synthetic-agent');
      await h.entered.promise;
      expect((await h.relay('submit')).ok).toBe(true);
      await h.claim('B');
      expect((await h.relay('ops_info')).ok).toBe(true);
      writeFileSync(blockerPath(h.dir), 'B 的新阻塞');
      h.pending.reject(Object.assign(Error('stale lease A'), { code: 'stale_lease' }));
      await settling;
      expect((await h.relay('ops_info')).ok).toBe(true);
      expect(readFileSync(blockerPath(h.dir), 'utf8')).toBe('B 的新阻塞');
      expect(readdirSync(h.dir).some(n => /^blocker\.md\.(failed|done)-/.test(n))).toBe(false);
    } finally { h.cleanup(); }
  });

  test('旧 blocker 提交晚成功不结束新租约、不移走 B 新 blocker', async () => {
    const h = harness({ hang: 'block' });
    try {
      await h.claim('A');
      writeFileSync(blockerPath(h.dir), 'A 的阻塞');
      const settling = h.pool.settle('synthetic-agent');
      await h.entered.promise;
      expect((await h.relay('submit')).ok).toBe(true);
      await h.claim('B');
      expect((await h.relay('ops_info')).ok).toBe(true);
      writeFileSync(blockerPath(h.dir), 'B 的新阻塞');
      h.pending.resolve({ task: { id: 'A', version: 3, state: 'blocked' } });
      await settling;
      expect((await h.relay('ops_info')).ok).toBe(true);
      expect(readFileSync(blockerPath(h.dir), 'utf8')).toBe('B 的新阻塞');
      expect(readdirSync(h.dir).some(n => /^blocker\.md\.(failed|done)-/.test(n))).toBe(false);
    } finally { h.cleanup(); }
  });

  test('旧 heartbeat 晚失败不删除新租约', async () => {
    const h = harness({ hang: 'heartbeat', heartbeatMs: 20 });
    try {
      await h.claim('A');
      await h.entered.promise; // 第一次心跳挂起
      expect((await h.relay('submit')).ok).toBe(true); // 消费 A 的租约
      await h.claim('B');
      expect((await h.relay('ops_info')).ok).toBe(true);
      h.pending.reject(Object.assign(Error('stale lease A'), { code: 'stale_lease' }));
      await Bun.sleep(5);
      expect((await h.relay('ops_info')).ok).toBe(true);
    } finally { h.cleanup(); }
  });

  test('旧 heartbeat 晚成功不结束新租约', async () => {
    const h = harness({ hang: 'heartbeat', heartbeatMs: 20 });
    try {
      await h.claim('A');
      await h.entered.promise;
      expect((await h.relay('submit')).ok).toBe(true);
      await h.claim('B');
      expect((await h.relay('ops_info')).ok).toBe(true);
      h.pending.resolve({ task: { id: 'A', version: 3, state: 'doing' } });
      await Bun.sleep(5);
      expect((await h.relay('ops_info')).ok).toBe(true);
    } finally { h.cleanup(); }
  });
});

for (const artifact of ["report", "blocker"] as const) {
  for (const outcome of ["success", "failure"] as const) {
    test(`old ${artifact} late ${outcome} preserves identical-text new lease artifact`, async () => {
      const h = harness({ hang: artifact === "report" ? "submit" : "block" });
      const path = artifact === "report" ? reportPath(h.dir) : blockerPath(h.dir);
      try {
        await h.claim("A");
        writeFileSync(path, "repeatable synthetic evidence");
        const settling = h.pool.settle("synthetic-agent");
        await h.entered.promise;
        expect((await h.relay("submit")).ok).toBe(true);
        // B receives a distinct baseline, then writes its own same-text artifact.
        writeFileSync(path, "prior artifact baseline");
        await h.claim("B");
        writeFileSync(path, "repeatable synthetic evidence");
        if (outcome === "success") h.pending.resolve({ task: { id: "A", version: 3, state: "review" } });
        else h.pending.reject(Object.assign(Error("stale lease A"), { code: "stale_lease" }));
        await settling;
        expect((await h.relay("ops_info")).ok).toBe(true);
        expect(existsSync(path)).toBe(true);
        expect(readFileSync(path, "utf8")).toBe("repeatable synthetic evidence");
        expect(readdirSync(h.dir).some(n => n.startsWith(`${artifact}.md.done-`) || n.startsWith(`${artifact}.md.failed-`))).toBe(false);
        await h.pool.settle("synthetic-agent");
        expect(existsSync(path)).toBe(false);
        expect(readdirSync(h.dir).some(n => n.startsWith(`${artifact}.md.done-`))).toBe(true);
        expect((await h.relay("ops_info")).ok).toBe(false);
      } finally { h.cleanup(); }
    });
  }
}
