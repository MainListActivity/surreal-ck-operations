import { expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordId } from 'surrealdb';
import { CompanyDatabase } from '../src/database.ts';
import { SurrealCompanyCore } from '../src/core.ts';
import { LocalEnrollmentAdmin } from '../src/enrollment.ts';
import { OwnerDesk } from '../src/owner.ts';
import { Workforce } from '../src/workforce.ts';
import { passLedger, readPauseState, writePause } from '../src/dispatch-pause.ts';
import { Dispatcher } from '../src/dispatcher/dispatcher.ts';
import type { PaseoGateway } from '../src/dispatcher/paseo.ts';
import { SidecarPool, type SidecarDeps } from '../plugin/server/sidecar.ts';

// SYS-DISP afdb562c review R-B: the maintenance pause observed through real Dispatcher.tick() passes, on a company fork.
// The existing fork suite covers core, MCP and sidecar; this one drives the dispatch pass itself (ledger, pause gate,
// spawn-race retirement, reuse, stalled reclaim, in-flight delivery), which the review found untested.
const run = process.env.RUN_SCK_DISPATCH_PAUSE_TESTS === '1' ? test : test.skip;
setDefaultTimeout(60000);
const ROOT_PASSWORD = 'isolated-dispatch-pause-tick-only';

interface PassFact { id: unknown; state: string; epoch?: number | null }
interface InstFact { retired?: boolean; retired_kind?: string; retired_reason?: string }

async function startFork(name: string) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `pause-tick-${name}-`)));
  const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('fixture') });
  const port = reservation.port!; reservation.stop(true);
  const child = Bun.spawn([join(homedir(), '.surrealdb/surreal'), 'start', '--bind', `127.0.0.1:${port}`, '--user', 'root', '--pass', ROOT_PASSWORD, '--log', 'error', `rocksdb:${dir}/db`], { stdout: 'ignore', stderr: 'ignore' });
  const db = new CompanyDatabase({ url: `ws://127.0.0.1:${port}/rpc`, rootUser: 'root', rootPassword: ROOT_PASSWORD,
    namespace: `pause_tick_${name.replaceAll('-', '_')}`, database: 'control_plane' });
  let pool: SidecarPool | undefined;
  const agentRows = new Map<string, { id: string; status: string }>();
  const spawns: string[] = [];
  const close = async () => {
    for (const id of agentRows.keys()) pool?.detachAgent(id);
    pool?.close();
    await db.close(); child.kill(); await child.exited; rmSync(dir, { recursive: true, force: true });
  };
  try {
    let ready = false;
    for (let n = 0; n < 160; n++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) { ready = true; break; } } catch {} await Bun.sleep(25); }
    expect(ready).toBe(true);
    await db.connect(); await db.bootstrap();
    const core = new SurrealCompanyCore(db), enrollment = new LocalEnrollmentAdmin(db), owner = new OwnerDesk(db);
    const gm = await enrollment.enroll(`pause-tick-gm-${name}`, 'gm', ['execute', 'review', 'manage']);
    const engineer = await enrollment.enroll(`pause-tick-eng-${name}`, 'engineering', ['execute', 'review']);
    const reviewer = await enrollment.enroll(`pause-tick-qa-${name}`, 'qa', ['execute', 'review']);
    // Deterministic staffing: no Jev, no quota floors, no wake budget.
    await db.db.upsert(new RecordId('company_meta', 'config')).content({ eval_enabled: false, jev_decisions: false,
      quota_floor_pct: 0, quota_weekly_floor_pct: 0, session_max_wakes: 0, session_max_input_k: 0 });
    const wf = new Workforce(db, join(dir, 'unused-credential-files'));
    const ops = { tools: ['ops_info'], call: async () => ({ available: true }), release: () => {} };
    pool = new SidecarPool({ core, workforce: wf as unknown as SidecarDeps['workforce'], ops, runDir: join(dir, 'comm'), sweepMs: 5 });
    const paseo: PaseoGateway = {
      list: async () => new Map([...agentRows].map(([id, row]) => [id, { id, status: row.status }])),
      status: async id => !agentRows.has(id) ? undefined : { status: agentRows.get(id)!.status, pendingPermissions: 0 },
      lastError: async () => '', logsTail: async () => 'isolated synthetic transcript', lastInputTokens: async () => 0,
      spawn: async b => { const id = `agent-${b.labels.employee_id}`; agentRows.set(id, { id, status: 'running' }); spawns.push(id); return id; },
      send: async id => { agentRows.get(id)!.status = 'running'; }, stop: async id => { agentRows.get(id)!.status = 'idle'; },
      reload: async id => { agentRows.get(id)!.status = 'idle'; },
      archive: async id => { agentRows.get(id)!.status = 'archived'; pool?.detachAgent(id); },
      listWorkspaces: async () => [], listProjects: async () => [], archiveWorkspace: async () => {}, deleteProject: async () => {} };
    // Every dispatcher gets its own pass ledger instance, like a restarted plugin process.
    const newDispatcher = () => new Dispatcher({ workforce: wf, owner, paseo, sidecar: pool!, rand: () => 0,
      passes: passLedger(db.db), env: { opsRepo: dir, sckBin: '/fixture/sck', paseoBin: '/fixture/paseo' } });
    const passes = async () => ((await db.db.query<[PassFact[]]>('SELECT id, state, epoch, started_at FROM dispatch_pass ORDER BY started_at;'))[0] ?? []);
    const instRow = async (instId: string) => ((await db.db.query<[InstFact[]]>('SELECT retired, retired_kind, retired_reason FROM ONLY $e;',
      { e: new RecordId('employee', instId) }))[0] ?? {}) as InstFact;
    const makeTask = (title: string, extra: Record<string, unknown> = {}) => core.createTask(gm, {
      title, context: 'Synthetic dispatch-pause regression fixture; no real work.', executorRole: 'engineering', reviewerRole: 'qa',
      idempotencyKey: `tick-${title}-${crypto.randomUUID()}`, ...extra } as never);
    return { core, owner, wf, db, gm, engineer, reviewer, pool: pool!, paseo, spawns, newDispatcher, passes, instRow, makeTask, close,
      url: `ws://127.0.0.1:${port}/rpc`, namespace: `pause_tick_${name.replaceAll('-', '_')}`, dir };
  } catch (error) {
    await close();
    throw error;
  }
}

run('R-B (1) every tick writes one pass row that records its epoch and ends done; a throwing pass ends failed', async () => {
  const w = await startFork('pass-rows');
  try {
    // No defs at all: the pass reaches the dispatch section, finds no candidate and still opens and closes its ledger row.
    const dispatcher = w.newDispatcher();
    const before = (await w.passes()).length;
    await dispatcher.tick();
    await dispatcher.tick();
    const rows = (await w.passes()).slice(before);
    expect(rows).toHaveLength(2);
    expect(rows.map(r => r.state)).toEqual(['done', 'done']);
    // The config had no pause_epoch yet: the pass records the default epoch 0.
    expect(rows.map(r => r.epoch)).toEqual([0, 0]);

    // A pass whose work throws still closes its row, as failed, so a pause waiting for drain cannot hang on it.
    const broken = w.newDispatcher();
    const realConfig = w.wf.config.bind(w.wf);
    w.wf.config = async () => { throw new Error('config read failed on purpose'); };
    await expect(broken.tick()).rejects.toThrow('config read failed on purpose');
    w.wf.config = realConfig;
    const failed = (await w.passes()).at(-1)!;
    expect(failed.state).toBe('failed');
    expect(failed.epoch ?? null).toBeNull();
  } finally { await w.close(); }
});

run('R-B (2) a paused tick returns skipped=paused, claims and spawns nothing, but still reclaims a stalled lease', async () => {
  const w = await startFork('paused-skip');
  try {
    await w.wf.upsertDef('tick-eng', { role: 'engineering', provider: 'codex', model: 'fixture', maxInstances: 1 });
    // A review seat keeps the dispatch pass out of the review-capacity gate, so the execute candidate is the only variable.
    await w.wf.upsertDef('tick-qa', { role: 'qa', provider: 'codex', model: 'fixture', maxInstances: 1 });
    const task = await w.makeTask('paused skip');
    // The lease exists before the pause, as an in-flight delivery does, and its holder stops renewing under it.
    const stale = await w.core.claim(w.engineer, task.id);
    // The lease expiry lives on the task row; moving it into the past makes the holder a stalled lease.
    await w.db.db.query('UPDATE $t SET lease_expires_at = time::unix() - 3600;', { t: new RecordId('task', task.id) });
    const paused = await w.core.setDispatchPause(w.gm, { paused: true, expectedEpoch: 0, reason: '维护停派：暂停闸门', idempotencyKey: 'tick-pause-1', drainTimeoutSeconds: 10 });
    expect(paused).toMatchObject({ paused: true, epoch: 1, before: { paused: false, epoch: 0 }, drained: { drained: true } });

    // Supervision runs before the gate: this tick still revokes the stalled lease, and dispatches nothing.
    const reclaim = await w.newDispatcher().tick();
    expect(reclaim.skipped).toBe('paused');
    expect(reclaim.revoked).toContain(task.id);
    // Nothing was claimed or spawned in either pass: a paused pass never reaches the dispatch section.
    expect(reclaim.woke).toEqual([]);
    expect(w.spawns).toEqual([]);
    expect((await w.db.db.query<[unknown[]]>('SELECT * FROM dispatch WHERE task = $t;', { t: task.id }))[0]).toEqual([]);
    const taskRow = (await w.db.db.query<[{ state: string; current_employee?: unknown }]>('SELECT state, current_employee FROM ONLY $t;', { t: new RecordId('task', task.id) }))[0]!;
    expect(taskRow.state).toBe('ready');
    expect(taskRow.current_employee ?? null).toBeNull();
  } finally { await w.close(); }
});

run('R-B (3) a spawn that loses the claim to the pause is retired as a rotation, without a seat failure or a denial', async () => {
  const w = await startFork('spawn-race');
  try {
    await w.wf.upsertDef('tick-eng', { role: 'engineering', provider: 'codex', model: 'fixture', maxInstances: 1 });
    // A review seat keeps the dispatch pass out of the review-capacity gate, so the execute candidate is the only variable.
    await w.wf.upsertDef('tick-qa', { role: 'qa', provider: 'codex', model: 'fixture', maxInstances: 1 });
    const task = await w.makeTask('spawn race');
    // The pause commits after the pass read the config and after the spawn, exactly where the orphan appears: the gate is
    // crossed on a stale read, the spawn happens, and only the claim inside claimLease sees the pause.
    const dispatcher = w.newDispatcher();
    const pool = w.pool;
    const realClaim = pool.claim.bind(pool);
    let first = true;
    pool.claim = async (inst, t) => {
      if (first) { first = false; await w.core.setDispatchPause(w.gm, { paused: true, expectedEpoch: 0, reason: '维护停派：spawn 与暂停竞争', idempotencyKey: 'tick-pause-race', drainTimeoutSeconds: 10 }); }
      return realClaim(inst, t);
    };
    const report = await dispatcher.tick();
    // The gate saw paused=false on the read that opened the pass, so this pass was not skipped: it opened a seat and only
    // the claim inside claimLease met the pause. The orphan is that seat, and it must be retired here, as a rotation.
    expect(report.skipped).toBeUndefined();
    expect(report.woke).toEqual([]);
    expect(report.retired).toHaveLength(1);
    // No Paseo session was ever created for it (the claim comes before paseo.spawn), and no live seat remains.
    expect(w.spawns).toEqual([]);
    expect(await w.wf.insts()).toEqual([]);
    const retired = (await w.db.db.query<[Array<InstFact & { id: unknown }>]>(
      "SELECT retired, retired_kind, retired_reason FROM employee WHERE retired = true;"))[0] ?? [];
    expect(retired).toHaveLength(1);
    expect(retired[0]).toMatchObject({ retired: true, retired_kind: 'rotation', retired_reason: 'dispatch paused before claim' });
    // A pause refusal says nothing about the task: it earns no cooldown, so a restore dispatches it on the very next pass.
    const status = await w.core.dispatchStatus(w.gm);
    await w.core.setDispatchPause(w.gm, { paused: false, expectedEpoch: status.epoch, reason: '维护结束：恢复派工', idempotencyKey: 'tick-race-restore', drainTimeoutSeconds: 10 });
    const after = await w.newDispatcher().tick();
    expect(after.woke.find(x => x.task === task.id)?.spawned).toBe(true);
    expect((await w.db.db.query<[{ state: string }]>('SELECT state FROM ONLY $t;', { t: new RecordId('task', task.id) }))[0]!.state).toBe('doing');
  } finally { await w.close(); }
});

run('R-B (4) a reuse claim refused by the pause keeps the instance and starts no cooldown', async () => {
  const w = await startFork('reuse-refusal');
  try {
    await w.wf.upsertDef('tick-eng', { role: 'engineering', provider: 'codex', model: 'fixture', maxInstances: 1 });
    // A review seat keeps the dispatch pass out of the review-capacity gate, so the execute candidate is the only variable.
    await w.wf.upsertDef('tick-qa', { role: 'qa', provider: 'codex', model: 'fixture', maxInstances: 1 });
    // One tick with the gate open spawns and claims the first task, so the next pass has an instance it could reuse.
    const first = await w.makeTask('reuse first');
    await w.newDispatcher().tick();
    const [inst] = await w.wf.insts();
    expect(inst).toBeDefined();
    expect(w.spawns).toHaveLength(1);

    // The supervisor path clears the lease the way it does for a stalled holder, and the session goes idle: the next pass
    // then sees an instance it can reuse rather than a busy one it must leave alone.
    const holder = (await w.db.db.query<[{ current_employee: string }]>('SELECT current_employee FROM ONLY $t;',
      { t: new RecordId('task', first.id) }))[0]!;
    expect(await w.wf.revokeLease(first.id, holder.current_employee, '复用竞争夹具：交还租约', '夹具交接说明')).toBe(true);
    w.pool.releaseClaim(inst!.id, first.id, '复用竞争夹具：结束本轮租约');
    const agentId = inst!.paseoAgentId!;
    const list = w.paseo.list;
    w.paseo.list = async () => new Map([...await list()].map(([id, row]) => [id, id === agentId ? { ...row, status: 'idle' } : row]));
    expect((await w.db.db.query<[{ state: string }]>('SELECT state FROM ONLY $t;', { t: new RecordId('task', first.id) }))[0]!.state).toBe('ready');

    // Now the pause commits between the gate read and the reuse claim of that same task.
    const dispatcher = w.newDispatcher();
    const realClaim = w.pool.claim.bind(w.pool);
    let paused = false;
    w.pool.claim = async (employee, task) => {
      if (!paused) { paused = true; await w.core.setDispatchPause(w.gm, { paused: true, expectedEpoch: 0, reason: '维护停派：复用竞争', idempotencyKey: 'tick-pause-reuse', drainTimeoutSeconds: 10 }); }
      return realClaim(employee, task);
    };
    const report = await dispatcher.tick();
    expect(report.skipped).toBeUndefined();
    // The pause is not the instance's failure: it was kept, nothing was spawned again, and nothing was retired.
    expect(w.spawns).toHaveLength(1);
    expect(report.retired).toEqual([]);
    expect(report.woke).toEqual([]);
    const [kept] = await w.wf.insts();
    expect(kept?.id).toBe(inst!.id);
    // The task stays ready for the restore, with no cooldown taken from the pause.
    const row = (await w.db.db.query<[{ state: string; current_employee?: unknown }]>('SELECT state, current_employee FROM ONLY $t;',
      { t: new RecordId('task', first.id) }))[0]!;
    expect(row.state).toBe('ready');
    expect(row.current_employee ?? null).toBeNull();
    const status = await w.core.dispatchStatus(w.gm);
    await w.core.setDispatchPause(w.gm, { paused: false, expectedEpoch: status.epoch, reason: '维护结束：恢复派工', idempotencyKey: 'tick-reuse-restore', drainTimeoutSeconds: 10 });
    const after = await w.newDispatcher().tick();
    expect(after.woke.find(x => x.task === first.id)).toMatchObject({ employee: inst!.id, spawned: false });
  } finally { await w.close(); }
});

run('R-B (5) while paused, an existing lease still delivers: checkpoint, submit and review decisions pass unchanged', async () => {
  const w = await startFork('inflight');
  try {
    await w.wf.upsertDef('tick-eng', { role: 'engineering', provider: 'codex', model: 'fixture', maxInstances: 1 });
    // A review seat keeps the dispatch pass out of the review-capacity gate, so the execute candidate is the only variable.
    await w.wf.upsertDef('tick-qa', { role: 'qa', provider: 'codex', model: 'fixture', maxInstances: 1 });
    const task = await w.makeTask('inflight delivery');
    const claimed = await w.core.claim(w.engineer, task.id);
    let proof = { taskId: task.id, deliveryId: claimed.deliveryId, fence: claimed.fence, expectedVersion: claimed.task.version };
    const paused = await w.core.setDispatchPause(w.gm, { paused: true, expectedEpoch: 0, reason: '维护停派：在办继续', idempotencyKey: 'tick-pause-inflight', drainTimeoutSeconds: 10 });
    expect(paused.drained?.drained).toBe(true);
    // Same lease, same fence: heartbeat, checkpoint and submit are not new leases and must keep working.
    const beat = await w.core.heartbeat(w.engineer, proof);
    proof = { ...proof, expectedVersion: beat.task.version };
    const note = await w.core.checkpoint(w.engineer, proof, { text: '暂停期间的进度检查点：接口与测试已完成，下一步补齐验证。', idempotencyKey: 'tick-inflight-cp' });
    proof = { ...proof, expectedVersion: note.version };
    const submitted = await w.core.submit(w.engineer, proof, { text: '暂停期间提交交付：实现与测试均已完成，等待独立复核。', idempotencyKey: 'tick-inflight-submit' });
    expect(submitted.state).toBe('review');
    // The review lease is a new lease, so it waits for the restore.
    await expect(w.core.claim(w.reviewer, task.id)).rejects.toMatchObject({ code: 'dispatch_paused' });
    // A tick under the pause reclaims nothing here and refuses to wake the reviewer.
    const report = await w.newDispatcher().tick();
    expect(report.skipped).toBe('paused');
    expect(report.woke).toEqual([]);
    expect((await w.db.db.query<[{ state: string }]>('SELECT state FROM ONLY $t;', { t: new RecordId('task', task.id) }))[0]!.state).toBe('review');
    // Restore with the current epoch, then the same review claim goes through.
    const restored = await w.core.setDispatchPause(w.gm, { paused: false, expectedEpoch: paused.epoch, reason: '维护结束：恢复派工', idempotencyKey: 'tick-restore-inflight' });
    expect(restored).toMatchObject({ paused: false, epoch: paused.epoch + 1, before: { paused: true, epoch: paused.epoch } });
    expect((await w.core.claim(w.reviewer, task.id)).task.state).toBe('review');
  } finally { await w.close(); }
});

run('R-B (6) a review lease held before the pause can accept or return while paused, and the decision opens no new lease', async () => {
  const w = await startFork('review-decide');
  try {
    await w.wf.upsertDef('tick-eng', { role: 'engineering', provider: 'codex', model: 'fixture', maxInstances: 1 });
    await w.wf.upsertDef('tick-qa', { role: 'qa', provider: 'codex', model: 'fixture', maxInstances: 1 });
    // Both tasks reach review and are claimed by their reviewer before the pause, so each review lease exists when the pause starts.
    // Each task has its own executor: an engineer that submitted one task stays active on it until that review ends.
    const otherEngineer = await new LocalEnrollmentAdmin(w.db).enroll(`pause-tick-eng-return-${crypto.randomUUID().slice(0, 8)}`, 'engineering', ['execute', 'review']);
    const held: Array<{ action: 'accept' | 'return'; executor: string; reviewer: string; taskId: string; proof: { taskId: string; deliveryId: string; fence: number; expectedVersion: number } }> = [];
    // A reviewer that holds one review lease cannot claim a second one, so the return case has its own reviewer.
    const otherReviewer = await new LocalEnrollmentAdmin(w.db).enroll(`pause-tick-qa-return-${crypto.randomUUID().slice(0, 8)}`, 'qa', ['execute', 'review']);
    for (const [action, executor, reviewer] of [['accept', w.engineer, w.reviewer], ['return', otherEngineer, otherReviewer]] as const) {
      const task = await w.makeTask(`review decided while paused: ${action}`);
      const lease = await w.core.claim(executor, task.id);
      const submitted = await w.core.submit(executor, { taskId: task.id, deliveryId: lease.deliveryId, fence: lease.fence, expectedVersion: lease.task.version },
        { text: '暂停前提交交付：实现与测试均已完成，等待独立复核。', idempotencyKey: `review-decide-submit-${action}` });
      expect(submitted.state).toBe('review');
      const review = await w.core.claim(reviewer, task.id);
      held.push({ action, executor, reviewer, taskId: task.id, proof: { taskId: task.id, deliveryId: review.deliveryId, fence: review.fence, expectedVersion: review.task.version } });
    }
    const claimCount = async (taskId: string) => ((await w.db.db.query<[Array<{ action: string }>]>(
      "SELECT action FROM audit WHERE task = $t AND action = 'claim';", { t: new RecordId('task', taskId) }))[0] ?? []).length;
    const claimsBefore = new Map<string, number>();
    for (const h of held) claimsBefore.set(h.taskId, await claimCount(h.taskId));
    const paused = await w.core.setDispatchPause(w.gm, { paused: true, expectedEpoch: 0, reason: '维护停派：复核中途暂停', idempotencyKey: 'tick-pause-review-decide', drainTimeoutSeconds: 10 });
    expect(paused).toMatchObject({ paused: true, epoch: 1 });
    for (const h of held) {
      if (h.action === 'accept') {
        // The accept carries the review lease's own proof: same delivery, fence and version as when the review began.
        const accepted = await w.core.accept(h.reviewer, h.proof, { text: '暂停期间独立复核通过：逐项核对，结论一致。', idempotencyKey: `review-decide-accept-${h.taskId}` });
        expect(accepted.state).toBe('done');
      } else {
        const returned = await w.core.returnTask(h.reviewer, h.proof, { text: '暂停期间退回：需补齐验证记录后再提交，原因如下。', idempotencyKey: `review-decide-return-${h.taskId}` });
        expect(returned.state).toBe('ready');
        // The returned task is ready again, but a new lease is refused while the pause holds.
        await expect(w.core.claim(h.executor, h.taskId)).rejects.toMatchObject({ code: 'dispatch_paused' });
      }
      // The decision itself opens no lease: no claim row is written, and the task holds no employee.
      expect(await claimCount(h.taskId)).toBe(claimsBefore.get(h.taskId));
      const row = (await w.db.db.query<[{ state: string; current_employee?: unknown }]>('SELECT state, current_employee FROM ONLY $t;', { t: new RecordId('task', h.taskId) }))[0]!;
      expect(row.current_employee ?? null).toBeNull();
    }
  } finally { await w.close(); }
});

run('R-A regression: admin config can no longer set paused without the epoch, gate and audit, and refuses pause_epoch', async () => {
  const w = await startFork('admin-config');
  try {
    const before = await readPauseState(w.db.db);
    expect(before.paused).toBe(false);
    // The operator path (src/admin.ts `config paused true`) now runs the same transaction as the manager pause.
    const written = await writePause(w.db.db, { paused: true, actor: 'admin', actorRole: 'operator', expectedEpoch: null,
      evidence: JSON.stringify({ source: 'admin config paused', value: true }) });
    expect(written).toMatchObject({ operation: 'dispatch_pause', paused: true, epoch: 1, before: { paused: false, epoch: 0 } });
    const after = await readPauseState(w.db.db);
    expect(after).toMatchObject({ paused: true, epoch: 1 });
    const [gate] = await w.db.db.query<[unknown]>('SELECT paused, epoch FROM ONLY company_meta:dispatch_gate;');
    expect(gate).toMatchObject({ paused: true, epoch: 1 });
    const [audits] = await w.db.db.query<[Array<{ action: string; actor: string; epoch: number }>]>(
      "SELECT action, actor, epoch, sequence FROM audit WHERE action IN ['dispatch_pause', 'dispatch_restore'] ORDER BY sequence;");
    expect(audits).toMatchObject([{ action: 'dispatch_pause', actor: 'admin', epoch: 1 }]);
    // A new lease is refused while the operator pause holds, so this path cannot be a silent side door either.
    const task = await w.makeTask('admin pause barrier');
    await expect(w.core.claim(w.engineer, task.id)).rejects.toMatchObject({ code: 'dispatch_paused' });
    // And the operator can restore it through the same transaction.
    const restored = await writePause(w.db.db, { paused: false, actor: 'admin', actorRole: 'operator', expectedEpoch: null,
      evidence: JSON.stringify({ source: 'admin config paused', value: false }) });
    expect(restored).toMatchObject({ operation: 'dispatch_restore', paused: false, epoch: 2 });
    expect((await w.core.claim(w.engineer, task.id)).task.state).toBe('doing');
  } finally { await w.close(); }
});

run('R-A end to end: the admin CLI writes the pause through the transaction, refuses pause_epoch, and restores', async () => {
  const w = await startFork('admin-cli');
  try {
    const cli = async (...args: string[]) => {
      const child = Bun.spawn(['bun', join(import.meta.dir, '..', 'src', 'admin.ts'), ...args], {
        cwd: join(import.meta.dir, '..'), stdout: 'pipe', stderr: 'pipe',
        env: { ...process.env, SCK_PRODUCT_ENV: '/dev/null', SCK_CREDENTIAL_DIR: join(w.dir, 'cli-credentials'),
          SURREAL_URL: w.url, SURREAL_ROOT_USER: 'root', SURREAL_ROOT_PASS: ROOT_PASSWORD,
          SCK_COMPANY_NS: w.namespace, SCK_COMPANY_DB: 'control_plane' },
      });
      const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
      return { code: await child.exited, out, err };
    };

    const paused = await cli('config', 'paused', 'true');
    expect(paused.code).toBe(0);
    expect(paused.out).toContain('"operation": "dispatch_pause"');
    expect(await readPauseState(w.db.db)).toMatchObject({ paused: true, epoch: 1 });
    const [gate] = await w.db.db.query<[unknown]>('SELECT paused, epoch FROM ONLY company_meta:dispatch_gate;');
    expect(gate).toMatchObject({ paused: true, epoch: 1 });
    const [audits] = await w.db.db.query<[Array<{ action: string; actor: string }>]>(
      "SELECT action, actor, sequence FROM audit WHERE action IN ['dispatch_pause', 'dispatch_restore'] ORDER BY sequence;");
    expect(audits).toMatchObject([{ action: 'dispatch_pause', actor: 'admin' }]);
    // The epoch is not an operator-settable key: the CLI refuses it and points at the pause itself.
    const epoch = await cli('config', 'pause_epoch', '7');
    expect(epoch.code).not.toBe(0);
    expect(epoch.err).toContain('dispatch_pause');
    expect(await readPauseState(w.db.db)).toMatchObject({ paused: true, epoch: 1 });
    // Other config keys still work unchanged.
    const maxRunning = await cli('config', 'max_running', '3');
    expect(maxRunning.code).toBe(0);
    // And the same CLI restores it, moving the epoch again.
    const restored = await cli('config', 'paused', 'false');
    expect(restored.code).toBe(0);
    expect(restored.out).toContain('"operation": "dispatch_restore"');
    expect(await readPauseState(w.db.db)).toMatchObject({ paused: false, epoch: 2 });
  } finally { await w.close(); }
});
