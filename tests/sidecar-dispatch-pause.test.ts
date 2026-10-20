import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SidecarPool } from '../plugin/server/sidecar.ts';
import { reqDir, resDir, readJsonFile } from '../src/comm.ts';
import type { ClaimResult, DispatchPauseView, DispatchStatusView, LeaseProof, TaskView } from '../src/contracts.ts';
import type { EmployeeInst, SupervisedTask } from '../src/workforce.ts';

// Adapter-level dispatch pause checks against a stub core: the pool's claim denial, the channel's
// gm-only dispatch relay, and the restart path (adopt, rebuildClaim, startBeat, close). The barrier
// itself is proven on the company fork in dispatch-pause.fork.test.ts.

type Doing = TaskView & { currentEmployee: string; leaseExpiresAt: string };
const future = () => new Date(Date.now() + 15 * 60_000).toISOString();
const past = () => new Date(Date.now() - 60_000).toISOString();

const view = (id: string, extra: Record<string, unknown> = {}): TaskView => ({
  id, title: `t-${id}`, context: '', state: 'doing', executorRole: 'engineering', reviewerRole: 'qa',
  kind: 'task', dependencies: [], version: 1, fence: 7, deliveryId: `d-${id}`, ...extra,
}) as TaskView;
const leaseOf = (taskId: string, version = 1): ClaimResult => ({
  task: view(taskId, { version }), deliveryId: `d-${taskId}`, fence: 7, leaseExpiresAt: future(), history: [],
});

let paused = false;
let authRole = 'engineering';
let doing: Doing[] = [];
const claimCalls: string[] = [];
const beats: LeaseProof[] = [];
const writes: Array<{ tool: string; proof: LeaseProof }> = [];
const rotated: string[] = [];
const dispatchCalls: Array<{ tool: string; input: Record<string, unknown> }> = [];

const core = {
  claim: async (_credential: string, taskId: string) => {
    claimCalls.push(taskId);
    if (paused) throw Object.assign(new Error('派工维护中，暂不发放新租约'), { code: 'dispatch_paused' });
    return leaseOf(taskId);
  },
  heartbeat: async (_credential: string, proof: LeaseProof) => {
    beats.push({ ...proof });
    return leaseOf(proof.taskId, proof.expectedVersion + 1);
  },
  checkpoint: async (_credential: string, proof: LeaseProof) => {
    writes.push({ tool: 'checkpoint', proof: { ...proof } });
    return view(proof.taskId, { version: proof.expectedVersion + 1 });
  },
  listTasks: async (_credential: string, state?: string) => (state === 'doing' ? doing : []),
  getTask: async (_credential: string, taskId: string) => doing.find(t => t.id === taskId) ?? view(taskId, { state: 'ready' }),
  setDispatchPause: async (_credential: string, input: Record<string, unknown> & { paused: boolean }) => {
    dispatchCalls.push({ tool: input.paused ? 'dispatch_pause' : 'dispatch_restore', input });
    if (authRole !== 'gm') throw Object.assign(new Error('只有经理可以变更派工暂停'), { code: 'forbidden' });
    const before = paused;
    paused = input.paused;
    return {
      operationId: 'op-adapter', operation: input.paused ? 'dispatch_pause' : 'dispatch_restore', paused, epoch: 2,
      before: { paused: before, epoch: 1 }, drained: null, replayed: false,
    } as DispatchPauseView;
  },
  dispatchStatus: async (_credential: string) => {
    if (authRole !== 'gm') throw Object.assign(new Error('只有经理可以查看派工暂停'), { code: 'forbidden' });
    return { paused, epoch: 2, runningPasses: [], oldRunning: 0 } as DispatchStatusView;
  },
};
const workforce = { rotate: async (id: string) => { rotated.push(id); return `tok-${id}-r${rotated.length}`; } };

const inst = (id: string, extra: Partial<EmployeeInst> = {}): EmployeeInst =>
  ({ id, role: 'engineering', credential: `tok-${id}`, ...extra }) as EmployeeInst;
const task = (id: string): SupervisedTask => ({ id, title: `t-${id}`, state: 'ready', executorRole: 'engineering', row: {} }) as unknown as SupervisedTask;

const until = async (fn: () => boolean, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (fn()) return; await Bun.sleep(10); }
  throw new Error('condition not met');
};
const relay = async (dir: string, key: string, name: string, tool: string, args: Record<string, unknown> = {}) => {
  writeFileSync(join(reqDir(dir), `${name}.json`), JSON.stringify({ key, tool, args }));
  await until(() => existsSync(join(resDir(dir), `${name}.json`)));
  return readJsonFile<{ ok: boolean; data?: unknown; error?: string }>(join(resDir(dir), `${name}.json`))!;
};

let parent = '';
let runDir = '';
let pools: SidecarPool[] = [];
const makePool = () => {
  const pool = new SidecarPool({ core: core as never, workforce: workforce as never, runDir, heartbeatMs: 20, sweepMs: 10 });
  pools.push(pool);
  return pool;
};

beforeEach(() => {
  parent = mkdtempSync(join(tmpdir(), 'sck-pause-adapter-'));
  runDir = join(parent, 'comm');
  paused = false; authRole = 'engineering'; doing = [];
  claimCalls.length = 0; beats.length = 0; writes.length = 0; rotated.length = 0; dispatchCalls.length = 0;
  pools = [];
});
afterEach(() => {
  for (const pool of pools) pool.close();
  rmSync(parent, { recursive: true, force: true });
});

describe('sidecar under a dispatch pause', () => {
  test('a paused company refuses a new lease as a denial: nothing is staged, and a restore lets the channel claim', async () => {
    const pool = makePool();
    const i = inst('p-new');
    pool.env(i);
    paused = true;
    await expect(pool.claim(i, task('task-paused'))).resolves.toBeUndefined();
    expect(pool.claimDenial(i.id)).toBe('dispatch_paused');
    expect(existsSync(join(runDir, i.id, 'claim.json'))).toBe(false);
    paused = false;
    await expect(pool.claim(i, task('task-after-restore'))).resolves.toMatchObject({ deliveryId: 'd-task-after-restore' });
    expect(pool.claimDenial(i.id)).toBeUndefined();
  });

  test('restart during a pause: adopt restores the same lease proof, keeps renewing it, claims nothing; close stops the keepalive', async () => {
    const before = makePool();
    const i = inst('p-held');
    before.env(i);
    before.bindAgent(i.id, 'agent-held');
    await before.claim(i, task('task-held'));
    before.close(); // the plugin process exits; its keepalive dies with it
    beats.length = 0; claimCalls.length = 0;
    doing = [{ ...view('task-held', { version: 3 }), currentEmployee: i.id, leaseExpiresAt: future() } as Doing];
    paused = true;

    // After the restart the workforce row names the bound agent, which is what adopt re-keys.
    const restarted = inst('p-held', { paseoAgentId: 'agent-held' });
    const fresh = makePool();
    await fresh.adopt([restarted]);
    expect(rotated).toEqual([i.id]); // the channel is re-keyed through workforce.rotate
    expect(claimCalls).toEqual([]); // rebuilding a seat never mints a lease, even while paused

    await until(() => beats.length >= 2);
    expect(beats.every(p => p.taskId === 'task-held' && p.deliveryId === 'd-task-held' && p.fence === 7)).toBe(true);
    expect(beats[0]!.expectedVersion).toBe(3); // resumes from the server's version, not a fresh claim

    const env = fresh.env(restarted);
    const res = await relay(env.SCK_COMM_DIR, env.SCK_COMM_KEY!, 'r1', 'checkpoint', { text: '暂停期间继续开发' });
    expect(res.ok).toBe(true);
    expect(writes.at(-1)).toMatchObject({ tool: 'checkpoint', proof: { taskId: 'task-held', deliveryId: 'd-task-held', fence: 7 } });

    fresh.close();
    await Bun.sleep(40);
    const settled = beats.length;
    await Bun.sleep(120);
    expect(beats.length).toBe(settled);
  });

  test('an expired lease is not rebuilt: the instance holds no seat and is refused while paused', async () => {
    const i = inst('p-expired', { paseoAgentId: 'agent-expired' });
    doing = [{ ...view('task-old', { version: 2, fence: 3 }), currentEmployee: i.id, leaseExpiresAt: past() } as Doing];
    const fresh = makePool();
    await fresh.adopt([i]);
    await Bun.sleep(60);
    expect(beats.filter(p => p.taskId === 'task-old')).toHaveLength(0);
    paused = true;
    await expect(fresh.claim(i, task('task-new'))).resolves.toBeUndefined();
    expect(fresh.claimDenial(i.id)).toBe('dispatch_paused');
    paused = false;
    await expect(fresh.claim(i, task('task-new'))).resolves.toMatchObject({ deliveryId: 'd-task-new' });
  });

  test('dispatch tools are listed and relayed to the core for a gm only; the status read is refused for others', async () => {
    const pool = makePool();
    const i = inst('p-gm');
    const env = pool.env(i);
    const listed = await relay(env.SCK_COMM_DIR, env.SCK_COMM_KEY!, 'l1', '__list__', {});
    expect((listed.data as { tools: string[] }).tools).toEqual(expect.arrayContaining(['dispatch_pause', 'dispatch_restore', 'dispatch_status']));

    authRole = 'engineering';
    const denied = await relay(env.SCK_COMM_DIR, env.SCK_COMM_KEY!, 'd0', 'dispatch_status', {});
    expect(denied.ok).toBe(false);
    expect(denied.error).toContain('forbidden');

    authRole = 'gm';
    const status = await relay(env.SCK_COMM_DIR, env.SCK_COMM_KEY!, 'd1', 'dispatch_status', {});
    expect(status).toMatchObject({ ok: true, data: { paused: false, epoch: 2 } });
    const pausedRes = await relay(env.SCK_COMM_DIR, env.SCK_COMM_KEY!, 'd2', 'dispatch_pause',
      { expectedEpoch: 2, reason: '维护停派', idempotencyKey: 'k-pause', drainTimeoutSeconds: 30 });
    expect(pausedRes).toMatchObject({ ok: true, data: { paused: true } });
    expect(dispatchCalls.at(-1)).toMatchObject({ tool: 'dispatch_pause', input: { paused: true, expectedEpoch: 2, drainTimeoutSeconds: 30 } });
    const restored = await relay(env.SCK_COMM_DIR, env.SCK_COMM_KEY!, 'd3', 'dispatch_restore',
      { expectedEpoch: 2, reason: '恢复派工', idempotencyKey: 'k-restore' });
    expect(restored).toMatchObject({ ok: true, data: { paused: false } });
    expect(dispatchCalls.at(-1)).toMatchObject({ tool: 'dispatch_restore', input: { paused: false } });
  });
});
