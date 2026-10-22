import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Surreal } from 'surrealdb';
import { CompanyDatabase } from '../src/database.ts';
import { SurrealCompanyCore } from '../src/core.ts';
import { LocalEnrollmentAdmin } from '../src/enrollment.ts';
import { OwnerDesk } from '../src/owner.ts';
import { passLedger, reapStaleRunningPasses, waitForDrain } from '../src/dispatch-pause.ts';
import { readJsonFile, reqDir, resDir } from '../src/comm.ts';
import { connectCompanyClient } from '../src/mcp/client.ts';
import { createMcpHttpService } from '../src/mcp/server.ts';
import { SidecarPool } from '../plugin/server/sidecar.ts';
import type { LeaseProof, Principal, Role, TaskView } from '../src/contracts.ts';
import type { EmployeeInst, SupervisedTask } from '../src/workforce.ts';

setDefaultTimeout(60000);
// Isolated company fork on a private RocksDB store: no production data, credentials or dispatcher.
const run = process.env.RUN_SCK_DISPATCH_PAUSE_TESTS === '1' ? test : test.skip;
let dir: string, server: ReturnType<typeof Bun.spawn>, db: CompanyDatabase, core: SurrealCompanyCore, owner: OwnerDesk;
let gmA: string, gmB: string, product: string, count = 0, people = 0;

const enrollAs = (role: Role, capabilities: Principal['capabilities']) =>
  new LocalEnrollmentAdmin(db).enroll(`pause-${role}-${++people}`, role, capabilities);
const key = () => `pause-key-${++count}-${crypto.randomUUID()}`;
const task = (extra: Record<string, unknown> = {}) => core.createTask(gmA, {
  title: `暂停测试任务 ${++count}`, context: 'fixture', executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: key(), ...extra,
} as never);
const status = () => core.dispatchStatus(gmA);
const pause = (credential: string, expectedEpoch: number, reason = '维护停派测试', drainTimeoutSeconds = 10) =>
  core.setDispatchPause(credential, { paused: true, expectedEpoch, reason, idempotencyKey: key(), drainTimeoutSeconds });
const restore = (credential: string, expectedEpoch: number, reason = '维护结束恢复派工') =>
  core.setDispatchPause(credential, { paused: false, expectedEpoch, reason, idempotencyKey: key() });
const ensureOpen = async () => { const s = await status(); if (s.paused) await restore(gmA, s.epoch); };
const outboxCounter = async () => {
  const [row] = await db.db.query<[{ value?: number } | undefined]>('SELECT * FROM ONLY company_meta:outbox_counter;');
  return row?.value ?? 0;
};

beforeAll(async () => {
  if (process.env.RUN_SCK_DISPATCH_PAUSE_TESTS !== '1') return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'sck-dispatch-pause-')));
  const listener = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('fixture') });
  const port = listener.port!; listener.stop(true);
  server = Bun.spawn([join(homedir(), '.surrealdb/surreal'), 'start', '--bind', `127.0.0.1:${port}`, '--user', 'root', '--pass', 'fixture-only', '--log', 'error', `rocksdb:${dir}/db`], { stdout: 'ignore', stderr: 'ignore' });
  for (let n = 0; n < 160; n++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch {} await Bun.sleep(25); }
  db = new CompanyDatabase({ url: `ws://127.0.0.1:${port}/rpc`, rootUser: 'root', rootPassword: 'fixture-only', namespace: 'dispatch_pause_fixture', database: 'control_plane' });
  await db.connect(); await db.bootstrap();
  core = new SurrealCompanyCore(db); owner = new OwnerDesk(db);
  gmA = await enrollAs('gm', ['execute', 'review', 'manage']);
  gmB = await enrollAs('gm', ['execute', 'review', 'manage']);
  product = await enrollAs('product', ['manage']);
});
afterAll(async () => {
  if (!dir) return;
  await db.close(); server.kill(); await server.exited; rmSync(dir, { recursive: true, force: true });
});

run('only a gm with manage reads or changes the dispatch pause, and bad input is refused before any write', async () => {
  const before = await status();
  const engineer = await enrollAs('engineering', ['execute', 'review']);
  for (const credential of [product, engineer]) {
    await expect(core.dispatchStatus(credential)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(core.setDispatchPause(credential, { paused: true, expectedEpoch: before.epoch, reason: '非经理尝试停派', idempotencyKey: key(), drainTimeoutSeconds: 10 }))
      .rejects.toMatchObject({ code: 'forbidden' });
  }
  await expect(core.setDispatchPause(gmA, { paused: true, expectedEpoch: -1, reason: '纪元越界', idempotencyKey: key() })).rejects.toMatchObject({ code: 'invalid' });
  await expect(core.setDispatchPause(gmA, { paused: true, expectedEpoch: before.epoch, reason: '超时过短', idempotencyKey: key(), drainTimeoutSeconds: 5 }))
    .rejects.toMatchObject({ code: 'invalid' });
  await expect(core.setDispatchPause(gmA, { paused: true, expectedEpoch: before.epoch, reason: 'x', idempotencyKey: key() })).rejects.toMatchObject({ code: 'invalid' });
  expect(await status()).toMatchObject({ paused: false, epoch: before.epoch });
});

run('compare-and-set: a stale or future epoch conflicts and changes nothing; a second gm cannot overwrite the first', async () => {
  await ensureOpen();
  const s0 = await status();
  expect(await pause(gmA, s0.epoch)).toMatchObject({ operation: 'dispatch_pause', paused: true, epoch: s0.epoch + 1, before: { paused: false, epoch: s0.epoch }, replayed: false });
  // Pausing while already paused keeps the epoch: only a change of the paused value moves it.
  expect(await pause(gmB, s0.epoch + 1)).toMatchObject({ paused: true, epoch: s0.epoch + 1, before: { paused: true, epoch: s0.epoch + 1 } });
  // The first gm's stale view and a future epoch both conflict.
  await expect(pause(gmA, s0.epoch)).rejects.toMatchObject({ code: 'conflict' });
  await expect(pause(gmA, s0.epoch + 5)).rejects.toMatchObject({ code: 'conflict' });
  expect(await status()).toMatchObject({ paused: true, epoch: s0.epoch + 1 });
  expect(await restore(gmB, s0.epoch + 1)).toMatchObject({ operation: 'dispatch_restore', paused: false, epoch: s0.epoch + 2, drained: null });
  // A restore from a stale view does not reopen over a later change made by another gm.
  await expect(restore(gmA, s0.epoch + 1)).rejects.toMatchObject({ code: 'conflict' });
  expect(await status()).toMatchObject({ paused: false, epoch: s0.epoch + 2 });
});

run('idempotency: the same key and payload replays the stored result; the same key with another payload conflicts', async () => {
  await ensureOpen();
  const s0 = await status();
  const k = key();
  const input = { paused: true, expectedEpoch: s0.epoch, reason: '幂等测试停派', idempotencyKey: k, drainTimeoutSeconds: 10 };
  const first = await core.setDispatchPause(gmA, input);
  const replay = await core.setDispatchPause(gmA, input);
  expect(replay).toMatchObject({ replayed: true, operationId: first.operationId, epoch: first.epoch, paused: true });
  await expect(core.setDispatchPause(gmA, { ...input, reason: '另一个理由' })).rejects.toMatchObject({ code: 'conflict' });
  expect(await status()).toMatchObject({ paused: true, epoch: s0.epoch + 1 });
  const [rows] = await db.db.query<[Array<{ id: unknown }>]>(
    "SELECT id FROM audit WHERE action = 'dispatch_pause' AND evidence CONTAINS '幂等测试停派';");
  expect(rows.length).toBe(1);
  await restore(gmA, s0.epoch + 1);
});

run('a pause refuses new leases; the holder keeps heartbeat, checkpoint and submit; a review lease waits for the restore', async () => {
  await ensureOpen();
  const holder = await enrollAs('engineering', ['execute', 'review']);
  const newcomer = await enrollAs('engineering', ['execute', 'review']);
  const reviewer = await enrollAs('qa', ['execute', 'review']);
  const first = await task();
  const lease = await core.claim(holder, first.id);
  let proof: LeaseProof = { taskId: first.id, deliveryId: lease.deliveryId, fence: lease.fence, expectedVersion: lease.task.version };
  const s0 = await status();
  expect(await pause(gmA, s0.epoch)).toMatchObject({ paused: true, epoch: s0.epoch + 1, drained: { drained: true, blocking: 0 } });
  const second = await task();
  await expect(core.claim(newcomer, second.id)).rejects.toMatchObject({ code: 'dispatch_paused' });
  expect(await core.getTask(gmA, second.id)).toMatchObject({ state: 'ready' });
  const beat = await core.heartbeat(holder, proof);
  proof = { ...proof, expectedVersion: beat.task.version };
  const note = await core.checkpoint(holder, proof, { text: '暂停期间继续开发并记录检查点：接口与测试框架已完成，下一步补齐验证。', idempotencyKey: key() });
  proof = { ...proof, expectedVersion: note.version };
  expect(await core.submit(holder, proof, { text: '暂停期间提交交付：实现与测试均已完成，等待独立复核。', idempotencyKey: key() })).toMatchObject({ state: 'review' });
  // Review is a new lease for the reviewer, so it waits for the restore.
  await expect(core.claim(reviewer, first.id)).rejects.toMatchObject({ code: 'dispatch_paused' });
  await restore(gmA, s0.epoch + 1);
  const review = await core.claim(reviewer, first.id);
  const accepted = await core.accept(reviewer, { taskId: first.id, deliveryId: review.deliveryId, fence: review.fence, expectedVersion: review.task.version },
    { text: '独立复核通过：逐项核对暂停屏障与续租行为，结论一致。', idempotencyKey: key() });
  expect(accepted).toMatchObject({ state: 'done' });
});

run('drain: an old pass that runs past the bound keeps paused with drained=false; the same key then reports drained once it ends', async () => {
  await ensureOpen();
  const s0 = await status();
  const pass = await passLedger(db.db, 'fixture-host:drain-timeout').begin();
  await pass.setEpoch(s0.epoch);
  const input = { paused: true, expectedEpoch: s0.epoch, reason: '排空超时测试', idempotencyKey: key(), drainTimeoutSeconds: 10 };
  const first = await core.setDispatchPause(gmA, input);
  expect(first).toMatchObject({ paused: true, epoch: s0.epoch + 1, drained: { drained: false, blocking: 1 } });
  expect(first.drained!.waitedMs).toBeGreaterThanOrEqual(10000);
  expect(await status()).toMatchObject({ paused: true, epoch: s0.epoch + 1, oldRunning: 1 });
  await pass.end('done');
  expect(await core.setDispatchPause(gmA, input)).toMatchObject({ replayed: true, operationId: first.operationId, drained: { drained: true, blocking: 0 } });
  await restore(gmA, s0.epoch + 1);
});

run('drain succeeds only after the old pass has ended, inside the bounded wait', async () => {
  await ensureOpen();
  const s0 = await status();
  const pass = await passLedger(db.db, 'fixture-host:drain-ok').begin();
  await pass.setEpoch(s0.epoch);
  const ending = Bun.sleep(300).then(() => pass.end('done'));
  const paused = await pause(gmA, s0.epoch);
  await ending;
  expect(paused).toMatchObject({ paused: true, epoch: s0.epoch + 1, drained: { drained: true, blocking: 0 } });
  await restore(gmA, s0.epoch + 1);
});

run('a drain wait whose ledger reads fail never reports drained', async () => {
  const broken = { query: () => { throw new Error('synthetic ledger read failure'); } } as unknown as Surreal;
  await expect(waitForDrain(broken, 3, 60, 5)).resolves.toMatchObject({ drained: false, blocking: null });
});

run('the pass ledger shows each running pass with its epoch, and drops it when the pass ends', async () => {
  await ensureOpen();
  const epoch = (await status()).epoch;
  const instance = 'fixture-host:ledger';
  const pass = await passLedger(db.db, instance).begin();
  const started = await status();
  expect(started.runningPasses.find(p => p.instance === instance)).toMatchObject({ epoch: null });
  // A pass that has not recorded its epoch counts as old, so a pause waits for it.
  expect(started.oldRunning).toBeGreaterThanOrEqual(1);
  await pass.setEpoch(epoch);
  expect((await status()).runningPasses.find(p => p.instance === instance)).toMatchObject({ epoch });
  await pass.end('done');
  expect((await status()).runningPasses.some(p => p.instance === instance)).toBe(false);
});

run('owner RPC pause and owner_command resume move the same epoch and write the same audited transition', async () => {
  await ensureOpen();
  const before = await status();
  const base = await outboxCounter();
  await owner.setPaused(true);
  expect(await status()).toMatchObject({ paused: true, epoch: before.epoch + 1 });
  await db.db.query("CREATE owner_command CONTENT { kind: 'resume', text: '维护结束，恢复派工', status: 'pending', source: 'test', created_at: time::now() };");
  const applied = await owner.applyPending();
  expect(applied.at(-1)).toMatchObject({ kind: 'resume', status: 'applied' });
  expect(await status()).toMatchObject({ paused: false, epoch: before.epoch + 2 });
  const [rows] = await db.db.query<[Array<{ action: string; actor: string; evidence: string }>]>(
    "SELECT action, actor, evidence, sequence FROM audit WHERE action IN ['dispatch_pause', 'dispatch_restore'] AND sequence > $base ORDER BY sequence;", { base });
  expect(rows.map(row => [row.action, row.actor])).toEqual([['dispatch_pause', 'owner'], ['dispatch_restore', 'owner']]);
  expect(rows[0]!.evidence).toContain('paseo_rpc');
  expect(rows[1]!.evidence).toContain('owner_command');
});

run('claims racing a pause: each committed lease sits in an interval that the outbox order places before the pause', async () => {
  await ensureOpen();
  const base = await outboxCounter();
  const open = await status();
  const tasks: TaskView[] = [], holders: string[] = [];
  for (let i = 0; i < 8; i++) { tasks.push(await task()); holders.push(await enrollAs('engineering', ['execute', 'review'])); }
  const claims = tasks.map((t, i) => core.claim(holders[i]!, t.id).then(
    () => 'lease',
    (error: { code?: string }) => `refused:${error.code ?? 'unknown'}`));
  const cycles = (async () => {
    for (let round = 0; round < 3; round++) {
      for (let attempt = 0; ; attempt++) {
        const s = await status();
        try {
          await core.setDispatchPause(gmA, { paused: !s.paused, expectedEpoch: s.epoch, reason: '竞争测试切换', idempotencyKey: key(), drainTimeoutSeconds: 10 });
          break;
        } catch (error) {
          if ((error as { code?: string }).code !== 'conflict' || attempt >= 5) throw error;
        }
      }
    }
  })();
  const [outcomes] = await Promise.all([Promise.all(claims), cycles]);
  const leased = outcomes.filter(outcome => outcome === 'lease').length;
  const refused = outcomes.filter(outcome => outcome !== 'lease');
  console.log(`race outcomes: ${leased} leased, ${refused.length} refused (${[...new Set(refused)].join(', ')})`);
  expect(refused.every(outcome => outcome === 'refused:dispatch_paused' || outcome === 'refused:conflict')).toBe(true);
  expect(leased + refused.length).toBe(tasks.length);
  const [changes] = await db.db.query<[Array<{ sequence: number; paused: boolean }>]>(
    "SELECT sequence, paused FROM audit WHERE action IN ['dispatch_pause', 'dispatch_restore'] AND sequence > $base ORDER BY sequence;", { base });
  const [leases] = await db.db.query<[Array<{ sequence: number }>]>(
    "SELECT sequence FROM outbox WHERE kind = 'claimed' AND sequence > $base ORDER BY sequence;", { base });
  expect(changes.length).toBe(3);
  expect(leases.length).toBe(leased);
  for (const lease of leases) {
    const prior = changes.filter(change => change.sequence < lease.sequence).at(-1);
    expect(prior?.paused ?? open.paused).toBe(false);
  }
  await ensureOpen();
});

run('a claim transaction that read the config before a pause committed conflicts with it, and its retry sees the pause', async () => {
  await ensureOpen();
  const open = await status();
  // The statements claimLease runs: read the config, write the shared gate, take an outbox sequence. The sleep is the window.
  const window = (ms: number) => `BEGIN;
    LET $cfg = SELECT paused, pause_epoch FROM ONLY company_meta:config;
    LET $held = sleep(${ms}ms);
    UPSERT company_meta:dispatch_gate MERGE { last_lease_at: time::now() };
    LET $sequence = UPDATE ONLY company_meta:outbox_counter SET value += 1 RETURN AFTER;
    RETURN { paused: $cfg.paused ?? false, sequence: $sequence.value };
    COMMIT;`;
  const stale = db.db.query<unknown[]>(window(400)).responses();
  await Bun.sleep(100);
  await pause(gmA, open.epoch);
  const outcome = await stale;
  expect(outcome.some(response => !response.success && /conflict/i.test(String((response as { error?: { message?: string } }).error?.message)))).toBe(true);
  const retry = await db.db.query<unknown[]>(window(1)).responses();
  expect(retry.at(-2)).toMatchObject({ success: true, result: { paused: true } });
  await restore(gmA, open.epoch + 1);
});

run('MCP transport: dispatch tools are listed; a gm reads status and pauses and restores; an engineer is refused', async () => {
  const service = createMcpHttpService({ core: core as never, port: 0 });
  const url = new URL(`http://127.0.0.1:${service.port}/mcp`);
  const engineer = await enrollAs('engineering', ['execute', 'review']);
  try {
    const gm = await connectCompanyClient({ url, credential: gmA, clientName: 'dispatch-pause-test' });
    try {
      const tools = (await gm.client.listTools()).tools.map(tool => tool.name);
      expect(tools).toEqual(expect.arrayContaining(['dispatch_pause', 'dispatch_restore', 'dispatch_status']));
      const before = await gm.client.callTool({ name: 'dispatch_status', arguments: {} });
      expect(before.structuredContent).toMatchObject({ ok: true, data: { paused: false } });
      const epoch = (before.structuredContent as { data: { epoch: number } }).data.epoch;
      const paused = await gm.client.callTool({ name: 'dispatch_pause', arguments: { expectedEpoch: epoch, reason: 'MCP 维护停派', idempotencyKey: key(), drainTimeoutSeconds: 10 } });
      expect(paused.structuredContent).toMatchObject({ ok: true, data: { paused: true, epoch: epoch + 1 } });
      const stale = await gm.client.callTool({ name: 'dispatch_restore', arguments: { expectedEpoch: epoch, reason: 'MCP 过期恢复', idempotencyKey: key() } });
      expect(stale.structuredContent).toMatchObject({ ok: false, code: 'conflict' });
      const restored = await gm.client.callTool({ name: 'dispatch_restore', arguments: { expectedEpoch: epoch + 1, reason: 'MCP 恢复派工', idempotencyKey: key() } });
      expect(restored.structuredContent).toMatchObject({ ok: true, data: { paused: false, epoch: epoch + 2 } });
    } finally { await gm.close(); }
    const denied = await connectCompanyClient({ url, credential: engineer, clientName: 'dispatch-pause-denied' });
    try {
      expect((await denied.client.callTool({ name: 'dispatch_status', arguments: {} })).structuredContent).toMatchObject({ ok: false, code: 'forbidden' });
      expect((await denied.client.callTool({ name: 'dispatch_pause', arguments: { expectedEpoch: 0, reason: '非经理停派', idempotencyKey: key() } })).structuredContent)
        .toMatchObject({ ok: false, code: 'forbidden' });
    } finally { await denied.close(); }
  } finally { await service.close(); }
});

run('sidecar on the real core: a paused claim is denied; a restarted channel keeps the same lease through the pause', async () => {
  await ensureOpen();
  // workforce.rotate stands in for a restart: the same credential stays valid, so the lease proof is what must survive.
  const credentials = new Map<string, string>();
  const workforce = { rotate: async (id: string) => credentials.get(id)! };
  const runDir = join(dir, 'sidecar-comm');
  const makePool = () => new SidecarPool({ core: core as never, workforce: workforce as never, runDir, heartbeatMs: 50, sweepMs: 10 });
  const channelInst = async (credential: string): Promise<EmployeeInst> => {
    const actor = await core.authenticate(credential);
    credentials.set(actor.employeeId, credential);
    return { id: actor.employeeId, role: 'engineering', credential } as unknown as EmployeeInst;
  };
  const supervised = (view: TaskView) => ({ id: view.id, title: view.title, state: 'ready', executorRole: 'engineering', row: {} }) as unknown as SupervisedTask;
  const relayTo = async (env: Record<string, string>, tool: string, args: Record<string, unknown>) => {
    const name = `${++count}.json`;
    writeFileSync(join(reqDir(env.SCK_COMM_DIR!), name), JSON.stringify({ key: env.SCK_COMM_KEY, tool, args }));
    for (let n = 0; n < 400 && !existsSync(join(resDir(env.SCK_COMM_DIR!), name)); n++) await Bun.sleep(5);
    return readJsonFile<{ ok: boolean; error?: string }>(join(resDir(env.SCK_COMM_DIR!), name))!;
  };
  const holder = await channelInst(await enrollAs('engineering', ['execute', 'review']));
  const newcomer = await channelInst(await enrollAs('engineering', ['execute', 'review']));
  const heldTask = await task();
  const queuedTask = await task();
  let pool = makePool();
  try {
    const holderEnv = pool.env(holder);
    pool.bindAgent(holder.id, 'agent-holder');
    const held = await pool.claim(holder, supervised(heldTask));
    expect(held).toBeDefined();
    pool.env(newcomer);
    pool.bindAgent(newcomer.id, 'agent-newcomer');

    const s0 = await status();
    expect(await pause(gmA, s0.epoch)).toMatchObject({ paused: true, drained: { drained: true, blocking: 0 } });
    await expect(pool.claim(newcomer, supervised(queuedTask))).resolves.toBeUndefined();
    expect(pool.claimDenial(newcomer.id)).toBe('dispatch_paused');

    // The held lease keeps renewing and checkpointing under the pause.
    const before = await core.getTask(gmA, heldTask.id);
    expect((await relayTo(holderEnv, 'checkpoint', { text: '暂停期间继续实现：通道续租与检查点不受影响。' })).ok).toBe(true);
    // Lease expiry is stored in whole seconds: wait past one boundary so a renewal shows.
    await Bun.sleep(1100);
    const renewed = await core.getTask(gmA, heldTask.id);
    expect(Date.parse(renewed.leaseExpiresAt!)).toBeGreaterThan(Date.parse(before.leaseExpiresAt!));

    // A restart re-keys the channel and rebuilds the same proof; no new lease is minted while paused.
    pool.close();
    const restarted = { ...holder, paseoAgentId: 'agent-holder' } as EmployeeInst;
    pool = makePool();
    await pool.adopt([restarted]);
    pool.env(newcomer);
    expect(await core.getTask(gmA, heldTask.id)).toMatchObject({ currentEmployee: holder.id, deliveryId: held!.deliveryId, fence: held!.fence });
    expect((await relayTo(pool.env(restarted), 'checkpoint', { text: '重启后沿同一租约继续，检查点仍用原证明写入。' })).ok).toBe(true);
    await expect(pool.claim(newcomer, supervised(queuedTask))).resolves.toBeUndefined();
    expect(pool.claimDenial(newcomer.id)).toBe('dispatch_paused');

    // After the restore the same channel takes the queued task.
    await restore(gmA, (await status()).epoch);
    await expect(pool.claim(newcomer, supervised(queuedTask))).resolves.toMatchObject({ deliveryId: expect.any(String) });
  } finally {
    pool.close();
  }
});

// SYS-DISP 876e36e2 H1: the startup reaper against the real company fork. The row states, the audit row and the drain
// effect must hold on SurrealDB itself, not only in the decision unit test (tests/dispatch-pause-reap.test.ts).
run('H1 reap: orphan running row of a provably dead pid becomes abandoned, and the pause then drains to true', async () => {
  await ensureOpen();
  // Fixture hygiene: the fork database is shared across cases. End any running row an earlier case left behind so the
  // counts below see only this case's orphan. (These are test-fork rows; production data is never in reach here.)
  await db.db.query("UPDATE dispatch_pass SET state = 'done', finished_at = time::now() WHERE state = 'running';", {});
  const dead = Bun.spawn(['/bin/sleep', '0.05']);
  await dead.exited; // kernel has reaped it: processAlive(dead.pid) is the ESRCH death proof now
  const instance = `${hostname()}:${dead.pid}:orphan1`;
  await passLedger(db.db, instance).begin(); // never ended: exactly what a killed process leaves behind (runbook §7 ★1)
  const s0 = await status();
  // Fail closed first: an orphan counts as blocking, and no timeout makes it drained.
  expect(await waitForDrain(db.db, s0.epoch + 1, 300)).toMatchObject({ drained: false, blocking: 1 });
  const summary = await reapStaleRunningPasses(db.db);
  expect(summary.reaped).toBeGreaterThanOrEqual(1);
  const [orphan] = await db.db.query<[Array<{ state?: string; finished_at?: string }> | undefined]>(
    'SELECT state, finished_at FROM dispatch_pass WHERE instance = $i;', { i: instance });
  expect(orphan).toMatchObject([{ state: 'abandoned' }]);
  expect(orphan?.[0]?.finished_at).toBeTruthy(); // retired through the existing non-running prune path, never deleted here
  const [audits] = await db.db.query<[Array<{ actor?: string; action?: string }>]>(
    "SELECT actor, action FROM audit WHERE action = 'dispatch_pass_reaped' AND instance = $i;", { i: instance });
  expect(audits).toMatchObject([{ actor: 'system:dispatcher', action: 'dispatch_pass_reaped' }]);
  // The defect this task exists for: after the reap, dispatch_pause reaches drained=true instead of timing out forever.
  const paused = await pause(gmA, s0.epoch, '维护停派：孤儿回收后端到端排空', 10);
  expect(paused.drained).toMatchObject({ drained: true, blocking: 0 });
  await restore(gmA, paused.epoch);
});

run('H1 fail closed on the fork: live-pid row and cross-host row both stay running through the reap', async () => {
  const live = Bun.spawn(['/bin/sleep', '30']);
  const liveInstance = `${hostname()}:${live.pid}:live1`;
  const foreignInstance = 'sck-other-host:999999:foreign1';
  const malformed = `${hostname()}:999998`; // host and pid but no uuid part: shape unrecognised, never a guess
  try {
    // Fixture hygiene (shared fork database): end leftover running rows so `blocking: 3` counts only this case's rows.
    await db.db.query("UPDATE dispatch_pass SET state = 'done', finished_at = time::now() WHERE state = 'running';", {});
    const good = await passLedger(db.db, liveInstance).begin();
    const foreign = await passLedger(db.db, foreignInstance).begin();
    const bad = await passLedger(db.db, malformed).begin();
    const summary = await reapStaleRunningPasses(db.db);
    expect(summary.reaped).toBe(0);
    const rows = await db.db.query<Array<{ instance: string; state: string }>>(
      'SELECT instance, state FROM dispatch_pass WHERE instance IN [$a, $b, $c] ORDER BY instance;',
      { a: liveInstance, b: foreignInstance, c: malformed });
    expect(rows.map(r => r.state)).toEqual(['running', 'running', 'running']);
    // And drain still counts all three: keeping them is the fail-closed side of the rule, not a cleanup shortcut.
    const s0 = await status();
    expect(await waitForDrain(db.db, s0.epoch + 1, 300)).toMatchObject({ drained: false, blocking: 3 });
    await good.end('done'); await foreign.end('done'); await bad.end('done');
    live.kill(); await live.exited;
  } finally { live.kill(); }
});

run('H1 reap audit stays with the row: re-run over the same ledger reaps nothing twice', async () => {
  // Fixture hygiene (shared fork database): start from a clean running set so scanned==0 is this case alone.
  await db.db.query("UPDATE dispatch_pass SET state = 'done', finished_at = time::now() WHERE state = 'running';", {});
  const dead = Bun.spawn(['/bin/sleep', '0.05']);
  await dead.exited;
  const instance = `${hostname()}:${dead.pid}:again1`;
  await passLedger(db.db, instance).begin();
  const first = await reapStaleRunningPasses(db.db);
  expect(first.reaped).toBeGreaterThanOrEqual(1);
  const second = await reapStaleRunningPasses(db.db);
  expect(second.scanned).toBe(0); // the abandoned row no longer matches state='running'
  const [audits] = await db.db.query<[Array<{ c?: number }>]>(
    'SELECT count() AS c FROM audit WHERE action = $a AND instance = $i GROUP ALL;', { a: 'dispatch_pass_reaped', i: instance });
  expect(audits).toMatchObject([{ c: 1 }]);
});
