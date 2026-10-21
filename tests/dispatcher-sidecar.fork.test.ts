import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { RecordId } from 'surrealdb';
import { CompanyDatabase } from '../src/database.ts';
import { SurrealCompanyCore } from '../src/core.ts';
import { LocalEnrollmentAdmin } from '../src/enrollment.ts';
import { OwnerDesk } from '../src/owner.ts';
import { Workforce } from '../src/workforce.ts';
import { Dispatcher } from '../src/dispatcher/dispatcher.ts';
import { BLOCK_TEXT } from '../src/dispatcher/dispatch-blocked.ts';
import type { PaseoGateway } from '../src/dispatcher/paseo.ts';
import { SidecarPool, type SidecarDeps } from '../plugin/server/sidecar.ts';
import { readJsonFile, reqDir, resDir } from '../src/comm.ts';
import type { ClaimResult, LeaseProof } from '../src/contracts.ts';

const run = process.env.RUN_SCK_CHANNEL_FORK_TESTS === '1' ? test : test.skip;
run('company fork: restart quarantine, actual lease fencing, fresh dispatch and independent review', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'channel-fork-'));
  const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('fixture') });
  const port = reservation.port!; reservation.stop(true);
  const rootPassword = 'isolated-channel-test-only';
  const child = Bun.spawn([join(homedir(), '.surrealdb/surreal'), 'start', '--bind', `127.0.0.1:${port}`, '--user', 'root', '--pass', rootPassword, '--log', 'error', `rocksdb:${dir}/database`], { stdout: 'ignore', stderr: 'ignore' });
  const db = new CompanyDatabase({ url: `ws://127.0.0.1:${port}/rpc`, rootUser: 'root', rootPassword, namespace: 'isolated_channel_test', database: 'control_plane' });
  let pool: SidecarPool | undefined;
  const agentRows = new Map<string, { id: string; status: string }>();
  try {
    let ready = false;
    for (let n = 0; n < 100; n++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) { ready = true; break; } } catch {} await Bun.sleep(25); }
    expect(ready).toBe(true); await db.connect(); await db.bootstrap();
    const core = new SurrealCompanyCore(db), enrollment = new LocalEnrollmentAdmin(db), owner = new OwnerDesk(db);
    const gm = await enrollment.enroll('fixture-manager', 'gm', ['execute', 'review', 'manage']);
    await db.db.upsert(new RecordId('company_meta', 'config')).content({ eval_enabled: false, jev_decisions: false, quota_floor_pct: 0, quota_weekly_floor_pct: 0, session_max_wakes: 0, session_max_input_k: 0 });
    const wf = new Workforce(db, join(dir, 'unused-credential-files'));
    await wf.upsertDef('fixture-eng', { role: 'engineering', provider: 'codex', model: 'fixture', maxInstances: 1 });
    const minted = new Map<string, string>();
    const originalSpawn = wf.spawnInst.bind(wf);
    wf.spawnInst = async d => { const i = await originalSpawn(d); minted.set(i.id, i.credential!); return i; };
    let releases = 0;
    const ops = { tools: ['ops_info'], call: async (credential: string, taskId: string) => {
      const actor = await core.authenticate(credential), task = await core.getTask(credential, taskId);
      if (task.currentEmployee !== actor.employeeId) throw new Error('stale ops lease');
      return { available: true };
    }, release: () => { releases++; } };
    const makePool = () => new SidecarPool({ core, workforce: wf as unknown as SidecarDeps['workforce'], ops, runDir: join(dir, 'comm'), sweepMs: 5 });
    pool = makePool();
    const envs = new Map<string, Record<string, string>>();
    const paseo: PaseoGateway = { list: async () => agentRows, status: async id => agentRows.get(id) ? { status: agentRows.get(id)!.status, pendingPermissions: 0 } : undefined,
      lastError: async () => '', logsTail: async () => 'isolated synthetic transcript', lastInputTokens: async () => 0,
      spawn: async b => { const id = `agent-${b.labels.employee_id}`; agentRows.set(id, { id, status: 'running' }); envs.set(id, b.env); return id; },
      send: async id => { agentRows.get(id)!.status = 'running'; }, stop: async id => { agentRows.get(id)!.status = 'idle'; }, reload: async id => { agentRows.get(id)!.status = 'idle'; },
      archive: async id => { agentRows.get(id)!.status = 'archived'; pool!.detachAgent(id); },
      listWorkspaces: async () => [], listProjects: async () => [], archiveWorkspace: async () => {}, deleteProject: async () => {} };
    const makeDispatcher = () => new Dispatcher({ workforce: wf, owner, paseo, sidecar: pool!, rand: () => 0,
      env: { opsRepo: dir, sckBin: '/fixture/sck', paseoBin: '/fixture/paseo' } });
    let counter = 0;
    const relay = async (env: Record<string, string>, tool: string, args: Record<string, unknown> = {}) => {
      const file = `${++counter}.json`; writeFileSync(join(reqDir(env.SCK_COMM_DIR!), file), JSON.stringify({ key: env.SCK_COMM_KEY, tool, args }));
      for (let n = 0; n < 200 && !existsSync(join(resDir(env.SCK_COMM_DIR!), file)); n++) await Bun.sleep(5);
      const result = readJsonFile<{ ok: boolean; error?: string }>(join(resDir(env.SCK_COMM_DIR!), file)); expect(!!result).toBe(true); return result!;
    };
    // The engineering claim needs a legal independent review after it (R1): a qa seat stays spare for that review.
    await wf.upsertDef('fixture-qa', { role: 'qa', provider: 'codex', model: 'fixture', maxInstances: 1 });
    const task = await core.createTask(gm, { title: 'isolated channel recovery', context: 'Synthetic regression only', executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: 'fixture-create' });
    await makeDispatcher().tick();
    const old = (await wf.insts())[0]!, oldEnv = envs.get(old.paseoAgentId!)!;
    const oldClaim = readJsonFile<ClaimResult>(join(oldEnv.SCK_COMM_DIR!, 'claim.json'))!;
    const oldProof: LeaseProof = { taskId: task.id, deliveryId: oldClaim.deliveryId, fence: oldClaim.fence, expectedVersion: oldClaim.task.version };
    expect((await relay(oldEnv, 'get_task_history', { taskId: task.id })).ok).toBe(true);
    expect((await relay(oldEnv, 'ops_info')).ok).toBe(true);
    // A restart is a process exit in production: the replaced pool stops sweeping the directories the new pool now owns.
    pool.detachAgent(old.paseoAgentId!); pool.close(); pool = makePool(); await pool.adopt(await wf.insts());
    // Restart fencing: the rotated-out channel key and the minted credential are
    // dead even though adopt() re-keyed the live session and kept its lease.
    expect((await relay(oldEnv, 'get_task_history', { taskId: task.id })).ok).toBe(false);
    expect((await relay(oldEnv, 'ops_info')).ok).toBe(false);
    expect((await relay(oldEnv, 'review', { decision: 'accept', text: 'stale' })).ok).toBe(false);
    await expect(core.checkpoint(minted.get(old.id)!, oldProof, { text: 'replay', idempotencyKey: 'old-replay' })).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(core.checkpoint(gm, oldProof, { text: 'lease replay', idempotencyKey: 'old-manager-proof' })).rejects.toBeDefined();
    // The adopted inst keeps its lease: no retirement, no revoke, no fresh dispatch.
    const recovery = await makeDispatcher().tick();
    expect(recovery.retired).not.toContain(old.id);
    expect(recovery.revoked).not.toContain(task.id);
    expect(recovery.woke).toHaveLength(0);
    expect(releases).toBeGreaterThan(0);
    // It submits through the re-keyed channel — the agent picks the fresh key up
    // from the binding pointer file on its next call, exactly like a real session.
    const rebound = readFileSync(join(dir, 'comm-agents', old.paseoAgentId!), 'utf8').split('\n');
    const env = { SCK_COMM_DIR: rebound[0], SCK_COMM_KEY: rebound[1] };
    expect(env.SCK_COMM_KEY === oldEnv.SCK_COMM_KEY).toBe(false);
    expect((await relay(env, 'get_task_history', { taskId: task.id })).ok).toBe(true);
    expect((await relay(env, 'ops_info')).ok).toBe(true);
    expect((await relay(env, 'submit', { text: 'synthetic isolated delivery', idempotencyKey: 'new-submit' })).ok).toBe(true);
    agentRows.get(old.paseoAgentId!)!.status = 'idle';
    await makeDispatcher().tick();
    const qa = (await wf.insts()).find(i => i.role === 'qa')!, qaEnv = envs.get(qa.paseoAgentId!)!;
    expect(qa.id === old.id).toBe(false);
    expect((await relay(qaEnv, 'review', { decision: 'accept', text: 'Independent synthetic regression review', idempotencyKey: 'qa-accept' })).ok).toBe(true);
    const final = await core.getTask(gm, task.id); expect(final.state).toBe('done');
    const history = await core.history(gm, task.id); expect(history.some(h => h.action === 'accept' && h.actor !== old.id)).toBe(true);
  } finally {
    for (const id of agentRows.keys()) pool?.detachAgent(id);
    await db.close(); child.kill(); await child.exited; rmSync(dir, { recursive: true, force: true });
  }
}, 30000);

run('company fork: two rounds, A implements, B returns, A reworks, B re-reviews; the author set stays {A} and B never claims the code', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'channel-fork-rework-'));
  const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('fixture') });
  const port = reservation.port!; reservation.stop(true);
  const rootPassword = 'isolated-channel-test-only';
  const child = Bun.spawn([join(homedir(), '.surrealdb/surreal'), 'start', '--bind', `127.0.0.1:${port}`, '--user', 'root', '--pass', rootPassword, '--log', 'error', `rocksdb:${dir}/database`], { stdout: 'ignore', stderr: 'ignore' });
  const db = new CompanyDatabase({ url: `ws://127.0.0.1:${port}/rpc`, rootUser: 'root', rootPassword, namespace: 'isolated_channel_rework', database: 'control_plane' });
  let pool: SidecarPool | undefined;
  const agentRows = new Map<string, { id: string; status: string }>();
  try {
    let ready = false;
    for (let n = 0; n < 100; n++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) { ready = true; break; } } catch {} await Bun.sleep(25); }
    expect(ready).toBe(true); await db.connect(); await db.bootstrap();
    const core = new SurrealCompanyCore(db), enrollment = new LocalEnrollmentAdmin(db), owner = new OwnerDesk(db);
    const gm = await enrollment.enroll('fixture-manager', 'gm', ['execute', 'review', 'manage']);
    await db.db.upsert(new RecordId('company_meta', 'config')).content({ eval_enabled: false, jev_decisions: false, quota_floor_pct: 0, quota_weekly_floor_pct: 0, session_max_wakes: 0, session_max_input_k: 0 });
    const wf = new Workforce(db, join(dir, 'unused-credential-files'));
    // Two seats of one engineering def: the implementer takes one, and the independent reviewer keeps the other (R1).
    await wf.upsertDef('fixture-eng', { role: 'engineering', provider: 'codex', model: 'fixture', maxInstances: 2 });
    const minted = new Map<string, string>();
    const originalSpawn = wf.spawnInst.bind(wf);
    wf.spawnInst = async d => { const i = await originalSpawn(d); minted.set(i.id, i.credential!); return i; };
    const ops = { tools: ['ops_info'], call: async () => ({ available: true }), release: () => {} };
    pool = new SidecarPool({ core, workforce: wf as unknown as SidecarDeps['workforce'], ops, runDir: join(dir, 'comm'), sweepMs: 5 });
    const envs = new Map<string, Record<string, string>>();
    const paseo: PaseoGateway = { list: async () => agentRows, status: async id => agentRows.get(id) ? { status: agentRows.get(id)!.status, pendingPermissions: 0 } : undefined,
      lastError: async () => '', logsTail: async () => 'isolated synthetic transcript', lastInputTokens: async () => 0,
      spawn: async b => { const id = `agent-${b.labels.employee_id}`; agentRows.set(id, { id, status: 'running' }); envs.set(id, b.env); return id; },
      send: async id => { agentRows.get(id)!.status = 'running'; }, stop: async id => { agentRows.get(id)!.status = 'idle'; }, reload: async id => { agentRows.get(id)!.status = 'idle'; },
      archive: async id => { agentRows.get(id)!.status = 'archived'; pool!.detachAgent(id); },
      listWorkspaces: async () => [], listProjects: async () => [], archiveWorkspace: async () => {}, deleteProject: async () => {} };
    const makeDispatcher = () => new Dispatcher({ workforce: wf, owner, paseo, sidecar: pool!, rand: () => 0,
      env: { opsRepo: dir, sckBin: '/fixture/sck', paseoBin: '/fixture/paseo' } });
    let counter = 0;
    const relay = async (env: Record<string, string>, tool: string, args: Record<string, unknown> = {}) => {
      const file = `${++counter}.json`; writeFileSync(join(reqDir(env.SCK_COMM_DIR!), file), JSON.stringify({ key: env.SCK_COMM_KEY, tool, args }));
      for (let n = 0; n < 200 && !existsSync(join(resDir(env.SCK_COMM_DIR!), file)); n++) await Bun.sleep(5);
      const result = readJsonFile<{ ok: boolean; error?: string }>(join(resDir(env.SCK_COMM_DIR!), file)); expect(!!result).toBe(true); return result!;
    };
    const task = await core.createTask(gm, { title: 'two-round rework loop', context: 'Synthetic regression only', executorRole: 'engineering', reviewerRole: 'engineering', idempotencyKey: 'fixture-create-rework' });
    // Round 1: the first engineer (A) claims the execute, and the second seat stays reserved for the independent review.
    const first = await makeDispatcher().tick();
    expect(first.woke.find(w => w.task === task.id)?.spawned).toBe(true);
    const A = (await wf.insts())[0]!;
    const envA = () => envs.get(A.paseoAgentId!)!;
    expect(readJsonFile<ClaimResult>(join(envA().SCK_COMM_DIR!, 'claim.json'))!.task.id).toBe(task.id);
    expect((await relay(envA(), 'submit', { text: 'Synthetic round-1 delivery from A', idempotencyKey: 'a-submit-1' })).ok).toBe(true);
    agentRows.get(A.paseoAgentId!)!.status = 'idle';
    // A is the author, so the review goes to the second seat (B), who returns the work to A.
    const review1 = await makeDispatcher().tick();
    const B = (await wf.insts()).find(i => i.id !== A.id)!;
    expect(review1.woke.find(w => w.task === task.id)?.employee).toBe(B.id);
    expect((await relay(envs.get(B.paseoAgentId!)!, 'review', { decision: 'return', text: 'Synthetic round-1 return to the implementer' })).ok).toBe(true);
    agentRows.get(B.paseoAgentId!)!.status = 'idle';
    // B cannot quietly take the returned code: the real core refuses B's claim while A stays the bound implementer.
    await expect(core.claim(minted.get(B.id)!, task.id)).rejects.toMatchObject({ code: 'forbidden' });
    expect(await core.getTask(gm, task.id)).toMatchObject({ state: 'ready', implementer: A.id });
    // Round 2: the rework goes back to A, and B is never the execute target.
    const rework = await makeDispatcher().tick();
    expect(rework.woke.find(w => w.task === task.id)?.employee).toBe(A.id);
    expect((await relay(envA(), 'submit', { text: 'Synthetic round-2 rework from A', idempotencyKey: 'a-submit-2' })).ok).toBe(true);
    agentRows.get(A.paseoAgentId!)!.status = 'idle';
    // B re-reviews as the reserved independent reviewer and accepts; A stays the only author.
    const review2 = await makeDispatcher().tick();
    expect(review2.woke.find(w => w.task === task.id)?.employee).toBe(B.id);
    expect((await relay(envs.get(B.paseoAgentId!)!, 'review', { decision: 'accept', text: 'Independent synthetic re-review of the rework' })).ok).toBe(true);
    expect(await core.getTask(gm, task.id)).toMatchObject({ state: 'done', implementer: A.id });
    const facts = await wf.contributors(task.id);
    expect(facts.authors).toEqual([A.id]);
    expect(facts.excluded).toEqual([A.id]);
    expect(facts.reviewers).toEqual([B.id]);
  } finally {
    for (const id of agentRows.keys()) pool?.detachAgent(id);
    pool?.close();
    await db.close(); child.kill(); await child.exited; rmSync(dir, { recursive: true, force: true });
  }
}, 60000);

/**
 * A real company fork for the real-tick scenarios below: the actual core, dispatcher and sidecar pool over a fresh database.
 * Paseo is a fake: the test drives each session's status and last error, and agents get real comm directories to relay through.
 */
async function startCompanyFork(name: string) {
  const dir = mkdtempSync(join(tmpdir(), `channel-fork-${name}-`));
  const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('fixture') });
  const port = reservation.port!; reservation.stop(true);
  const rootPassword = 'isolated-channel-test-only';
  const child = Bun.spawn([join(homedir(), '.surrealdb/surreal'), 'start', '--bind', `127.0.0.1:${port}`, '--user', 'root', '--pass', rootPassword, '--log', 'error', `rocksdb:${dir}/database`], { stdout: 'ignore', stderr: 'ignore' });
  // SurrealDB reads a hyphen in a bare identifier as subtraction, so the namespace name uses underscores only.
  const db = new CompanyDatabase({ url: `ws://127.0.0.1:${port}/rpc`, rootUser: 'root', rootPassword, namespace: `isolated_${name.replaceAll('-', '_')}`, database: 'control_plane' });
  let ready = false;
  for (let n = 0; n < 100; n++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) { ready = true; break; } } catch {} await Bun.sleep(25); }
  expect(ready).toBe(true);
  await db.connect(); await db.bootstrap();
  const core = new SurrealCompanyCore(db), enrollment = new LocalEnrollmentAdmin(db), owner = new OwnerDesk(db);
  const gm = await enrollment.enroll('fixture-manager', 'gm', ['execute', 'review', 'manage']);
  await db.db.upsert(new RecordId('company_meta', 'config')).content({ eval_enabled: false, jev_decisions: false, quota_floor_pct: 0, quota_weekly_floor_pct: 0, session_max_wakes: 0, session_max_input_k: 0 });
  const wf = new Workforce(db, join(dir, 'unused-credential-files'));
  const agentRows = new Map<string, { id: string; status: string }>();
  const errors = new Map<string, string>();
  const envs = new Map<string, Record<string, string>>();
  const ops = { tools: ['ops_info'], call: async () => ({ available: true }), release: () => {} };
  let pool: SidecarPool | undefined = new SidecarPool({ core, workforce: wf as unknown as SidecarDeps['workforce'], ops, runDir: join(dir, 'comm'), sweepMs: 5 });
  const paseo: PaseoGateway = { list: async () => agentRows, status: async id => agentRows.get(id) ? { status: agentRows.get(id)!.status, pendingPermissions: 0 } : undefined,
    lastError: async id => errors.get(id) ?? '', logsTail: async () => 'isolated synthetic transcript', lastInputTokens: async () => 0,
    spawn: async b => { const id = `agent-${b.labels.employee_id}`; agentRows.set(id, { id, status: 'running' }); envs.set(id, b.env); return id; },
    send: async id => { agentRows.get(id)!.status = 'running'; }, stop: async id => { agentRows.get(id)!.status = 'idle'; }, reload: async id => { agentRows.get(id)!.status = 'idle'; },
    archive: async id => { agentRows.get(id)!.status = 'archived'; pool?.detachAgent(id); },
    listWorkspaces: async () => [], listProjects: async () => [], archiveWorkspace: async () => {}, deleteProject: async () => {} };
  let last: Dispatcher | undefined;
  let counter = 0;
  const relay = async (env: Record<string, string>, tool: string, args: Record<string, unknown> = {}) => {
    const file = `${++counter}.json`; writeFileSync(join(reqDir(env.SCK_COMM_DIR!), file), JSON.stringify({ key: env.SCK_COMM_KEY, tool, args }));
    for (let n = 0; n < 200 && !existsSync(join(resDir(env.SCK_COMM_DIR!), file)); n++) await Bun.sleep(5);
    const result = readJsonFile<{ ok: boolean; error?: string }>(join(resDir(env.SCK_COMM_DIR!), file)); expect(!!result).toBe(true); return result!;
  };
  return {
    core, owner, wf, db, gm, dir, pool: pool!, agentRows, errors, envs, relay,
    /** One real tick on a fresh dispatcher, as the existing fork tests run it. */
    tick: async () => {
      last = new Dispatcher({ workforce: wf, owner, paseo, sidecar: pool!, rand: () => 0,
        autoTakeover: async input => { await core.systemImplementerTakeover(input); return true; },
        log: process.env.SCK_TEST_DISPATCH_LOG === '1' ? message => console.log('DISPATCH', message) : undefined,
        env: { opsRepo: dir, sckBin: '/fixture/sck', paseoBin: '/fixture/paseo' } });
      return last.tick();
    },
    verdicts: () => last?.dispatchVerdicts() ?? [],
    close: async () => {
      for (const id of agentRows.keys()) pool?.detachAgent(id);
      pool?.close();
      await db.close(); child.kill(); await child.exited; rmSync(dir, { recursive: true, force: true });
    },
  };
}

run('company fork: a bound implementer runs out of quota, the task waits without another engineer, the same implementer resumes, and the notice closes with an audit row', async () => {
  const w = await startCompanyFork('quota');
  try {
    await w.wf.upsertDef('fixture-eng', { role: 'engineering', provider: 'codex', model: 'fixture', maxInstances: 2 });
    // A second provider stays healthy, so the pass is not a global budget stop and candidates are read.
    await w.wf.upsertDef('fixture-eng-grok', { role: 'engineering', provider: 'grok', model: 'fixture', maxInstances: 1 });
    await w.wf.upsertDef('fixture-qa', { role: 'qa', provider: 'codex', model: 'fixture', maxInstances: 1 });
    const task = await w.core.createTask(w.gm, { title: 'quota recovery of a bound implementer', context: 'Synthetic regression only', executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: 'fixture-create-quota' });
    // The first claim binds the implementer. The other seats stay free, so only the bound-implementer gate keeps them out.
    expect((await w.tick()).woke.find(x => x.task === task.id)?.spawned).toBe(true);
    const A = (await w.wf.insts()).find(i => i.role === 'engineering')!;
    // A's subscription runs out mid-task: the lease is revoked and the task waits in ready, still bound to A.
    w.errors.set(A.paseoAgentId!, 'Your workspace is out of credits. Add credits to continue.');
    w.agentRows.get(A.paseoAgentId!)!.status = 'error';
    const exhausted = await w.tick();
    expect(exhausted.exhausted).toEqual(['codex']);
    expect(exhausted.revoked).toEqual([task.id]);
    expect(exhausted.woke).toHaveLength(0);
    expect(await w.core.getTask(w.gm, task.id)).toMatchObject({ state: 'ready', implementer: A.id });
    const verdict = w.verdicts().find(v => v.taskId === task.id && v.phase === 'execute')!;
    expect(verdict).toMatchObject({ dispatchable: false, feasible: true, eligibleCount: 0 });
    expect(verdict.reasons.map(r => r.code)).toEqual(['implementer_mismatch', 'quota']);
    expect(verdict.reasons.find(r => r.code === 'quota')?.candidates).toEqual([A.id]);
    // The quota reason carries the recovery time the provider health record holds (ISO 8601), never the concurrency-full text (AC02).
    const [healthRows] = await w.db.db.query<[Array<{ until: number }>]>('SELECT until FROM provider_health:codex;');
    const quota = verdict.reasons.find(r => r.code === 'quota')!;
    expect(quota.until).toBe(new Date(healthRows![0]!.until * 1000).toISOString());
    expect(quota.text).toContain('恢复时间');
    expect(quota.text).not.toContain('并发已满');
    expect((await w.wf.insts()).filter(i => i.role === 'engineering')).toHaveLength(1);
    // A fresh episode waits five minutes before it becomes an owner notice; repeated ticks keep one open item.
    expect((await w.tick()).notices).not.toContain(`dispatch-blocked:${task.id}:execute`);
    await w.db.db.query('UPDATE $t SET dispatch_blocked_since = time::unix(time::now()) - 400;', { t: new RecordId('task', task.id) });
    expect((await w.tick()).notices).toContain(`dispatch-blocked:${task.id}:execute`);
    expect((await w.owner.openNotices()).filter(n => n.key === `dispatch-blocked:${task.id}:execute`)).toHaveLength(1);
    // Recovery: the subscription window resets and A's session is idle again. The same implementer resumes its own task.
    await w.db.db.query('UPDATE provider_health:codex SET until = 0;');
    w.errors.delete(A.paseoAgentId!);
    w.agentRows.get(A.paseoAgentId!)!.status = 'idle';
    const recovered = await w.tick();
    expect(recovered.skipped).toBeUndefined();
    expect(recovered.woke).toEqual([expect.objectContaining({ task: task.id, employee: A.id, spawned: false })]);
    expect(await w.core.getTask(w.gm, task.id)).toMatchObject({ state: 'doing', currentEmployee: A.id, implementer: A.id });
    expect((await w.owner.openNotices()).some(n => n.key === `dispatch-blocked:${task.id}:execute`)).toBe(false);
    const [cleared] = await w.db.db.query<[Array<{ action: string; evidence: string }>]>(
      "SELECT action, evidence FROM audit WHERE task = $task AND action = 'dispatch_unblocked';", { task: new RecordId('task', task.id) });
    expect(cleared).toEqual([expect.objectContaining({ action: 'dispatch_unblocked', evidence: 'dispatch-blocked execute episode ended: dispatched' })]);
    expect((await w.wf.insts()).filter(i => i.role === 'engineering')).toHaveLength(1);
  } finally {
    await w.close();
  }
}, 90000);

run('company fork: an engineering execute task with reviewerRole=owner dispatches normally, without a review capacity hold, and waits for the owner after submit', async () => {
  const w = await startCompanyFork('owner-gate');
  try {
    await w.wf.upsertDef('fixture-eng', { role: 'engineering', provider: 'codex', model: 'fixture', maxInstances: 1 });
    // No independent reviewer exists at all. A peer-reviewed execute task would be held for review capacity; an owner gate is not.
    const task = await w.core.createTask(w.gm, { title: 'owner-reviewed implementation', context: 'Synthetic regression only', executorRole: 'engineering', reviewerRole: 'owner', idempotencyKey: 'fixture-create-owner-gate' });
    const first = await w.tick();
    expect(first.woke).toEqual([expect.objectContaining({ task: task.id, spawned: true })]);
    expect(first.decisions.filter(d => d.startsWith('reserve:'))).toEqual([]);
    expect(first.notices).not.toContain(`dispatch-blocked:${task.id}:execute`);
    expect(w.verdicts().filter(v => v.taskId === task.id)).toEqual([]);
    const A = (await w.wf.insts())[0]!;
    expect(await w.core.getTask(w.gm, task.id)).toMatchObject({ state: 'doing', currentEmployee: A.id });
    expect((await w.relay(w.envs.get(A.paseoAgentId!)!, 'submit', { text: 'Synthetic owner-gated delivery', idempotencyKey: 'owner-gate-submit' })).ok).toBe(true);
    w.agentRows.get(A.paseoAgentId!)!.status = 'idle';
    // The owner gate is the reviewer: no engineer is woken for it, it stays out of the verdicts, and it waits in the owner inbox.
    const after = await w.tick();
    expect(after.woke.filter(x => x.task === task.id)).toEqual([]);
    expect(w.verdicts().filter(v => v.taskId === task.id)).toEqual([]);
    expect((await w.owner.inbox()).gates.map(g => g.task.id)).toContain(task.id);
  } finally {
    await w.close();
  }
}, 60000);

run('company fork: session rotation never retires the bound implementer of an active task, even past the wake limit', async () => {
  const w = await startCompanyFork('rotation');
  try {
    await w.db.db.upsert(new RecordId('company_meta', 'config')).content({ eval_enabled: false, jev_decisions: false, quota_floor_pct: 0, quota_weekly_floor_pct: 0, session_max_wakes: 1, session_max_input_k: 0 });
    await w.wf.upsertDef('fixture-eng', { role: 'engineering', provider: 'codex', model: 'fixture', maxInstances: 1 });
    await w.wf.upsertDef('fixture-qa', { role: 'qa', provider: 'codex', model: 'fixture', maxInstances: 1 });
    const task = await w.core.createTask(w.gm, { title: 'rotation keeps the implementer', context: 'Synthetic regression only', executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: 'fixture-create-rotation' });
    expect((await w.tick()).woke.find(x => x.task === task.id)?.spawned).toBe(true);
    const A = (await w.wf.insts()).find(i => i.role === 'engineering')!;
    expect((await w.relay(w.envs.get(A.paseoAgentId!)!, 'submit', { text: 'Synthetic delivery before rotation', idempotencyKey: 'rotation-submit-1' })).ok).toBe(true);
    w.agentRows.get(A.paseoAgentId!)!.status = 'idle';
    // A is idle, past the wake limit, and still the bound implementer of an active task: the rotation pass must keep A.
    const review = await w.tick();
    expect(review.retired).not.toContain(A.id);
    const Q = (await w.wf.insts()).find(i => i.role === 'qa')!;
    expect(review.woke.find(x => x.task === task.id)?.employee).toBe(Q.id);
    expect((await w.relay(w.envs.get(Q.paseoAgentId!)!, 'review', { decision: 'return', text: 'Synthetic return for rework' })).ok).toBe(true);
    w.agentRows.get(Q.paseoAgentId!)!.status = 'idle';
    expect(await w.core.getTask(w.gm, task.id)).toMatchObject({ state: 'ready', implementer: A.id });
    // The rework tick: A is idle, past the wake limit, and bound to the ready task. It is neither retired nor archived.
    const rework = await w.tick();
    expect(rework.retired).not.toContain(A.id);
    expect(w.agentRows.get(A.paseoAgentId!)!.status).not.toBe('archived');
    expect(rework.woke.find(x => x.task === task.id)?.employee).toBe(A.id);
    expect(await w.core.getTask(w.gm, task.id)).toMatchObject({ state: 'doing', currentEmployee: A.id });
  } finally {
    await w.close();
  }
}, 60000);

// SYS-DISP R6(a) (AC04/AC06): a real tick. The bound implementer loses its lease to a quota stop, the manager hands the task to another
// engineer, the tick wakes that engineer and never the old one, and the same independent reviewer accepts the work.
run('company fork: the bound implementer loses its lease, the manager hands the task to another engineer, the tick wakes that engineer, and the same independent reviewer accepts', async () => {
  const w = await startCompanyFork('takeover');
  try {
    // Only the codex engineer exists at first, so A claims the task and the first claim binds it.
    await w.wf.upsertDef('fixture-eng', { role: 'engineering', provider: 'codex', model: 'fixture', maxInstances: 1 });
    await w.wf.upsertDef('fixture-qa', { role: 'qa', provider: 'codex', model: 'fixture', maxInstances: 1 });
    const task = await w.core.createTask(w.gm, { title: 'takeover to another engineer', context: 'Synthetic regression only', executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: 'fixture-create-takeover' });
    expect((await w.tick()).woke.find(x => x.task === task.id)?.spawned).toBe(true);
    const A = (await w.wf.insts()).find(i => i.role === 'engineering')!;
    expect(A.provider).toBe('codex');
    expect(await w.core.getTask(w.gm, task.id)).toMatchObject({ state: 'doing', currentEmployee: A.id, implementer: A.id });
    // A grok engineer appears for another task while the codex seat is full. It is the handover target C, and it finishes its own work first.
    await w.wf.upsertDef('fixture-eng-grok', { role: 'engineering', provider: 'grok', model: 'fixture', maxInstances: 1 });
    const warm = await w.core.createTask(w.gm, { title: 'the grok engineer finishes its own work first', context: 'Synthetic regression only', executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: 'fixture-create-takeover-warm' });
    const warmWake = await w.tick();
    const C = (await w.wf.insts()).find(i => i.provider === 'grok')!;
    expect(warmWake.woke.find(x => x.task === warm.id)).toMatchObject({ employee: C.id, spawned: true });
    expect((await w.relay(w.envs.get(C.paseoAgentId!)!, 'submit', { text: 'Synthetic warm-up delivery by the grok engineer', idempotencyKey: 'warm-submit' })).ok).toBe(true);
    w.agentRows.get(C.paseoAgentId!)!.status = 'idle';
    // The warm-up task goes to the qa reviewer B, who accepts it. B is the reviewer of the original task too.
    const warmReview = await w.tick();
    const B = (await w.wf.insts()).find(i => i.role === 'qa')!;
    expect(warmReview.woke.find(x => x.task === warm.id)).toMatchObject({ employee: B.id, spawned: true });
    expect((await w.relay(w.envs.get(B.paseoAgentId!)!, 'review', { decision: 'accept', text: 'Independent synthetic review of the warm-up task', idempotencyKey: 'warm-accept' })).ok).toBe(true);
    w.agentRows.get(B.paseoAgentId!)!.status = 'idle';
    // A's codex subscription runs out mid-task: the lease is revoked and the task waits in ready, still bound to A.
    w.errors.set(A.paseoAgentId!, 'Your workspace is out of credits. Add credits to continue.');
    w.agentRows.get(A.paseoAgentId!)!.status = 'error';
    const exhausted = await w.tick();
    expect(exhausted.exhausted).toEqual(['codex']);
    expect(exhausted.revoked).toEqual([task.id]);
    expect(await w.core.getTask(w.gm, task.id)).toMatchObject({ state: 'ready', implementer: A.id });
    // The manager hands the task to C, which is neither its author nor its reviewer.
    const taken = await w.core.implementerTakeover(w.gm, { taskId: task.id, toEmployee: C.id, expectedVersion: (await w.core.getTask(w.gm, task.id)).version,
      reason: 'A 的 codex 额度用尽，经理指定 C 续做本任务', idempotencyKey: 'takeover-to-c' });
    expect(taken).toMatchObject({ state: 'ready', implementer: C.id });
    // Codex recovers and A's session is idle again, so A is otherwise eligible for the task. Only the bound-implementer gate keeps A out.
    await w.db.db.query('UPDATE provider_health:codex SET until = 0;');
    w.errors.delete(A.paseoAgentId!);
    w.agentRows.get(A.paseoAgentId!)!.status = 'idle';
    // The tick wakes C and never A.
    const handover = await w.tick();
    expect(handover.woke.filter(x => x.task === task.id)).toEqual([expect.objectContaining({ employee: C.id, spawned: false })]);
    expect(await w.core.getTask(w.gm, task.id)).toMatchObject({ state: 'doing', currentEmployee: C.id, implementer: C.id });
    // C continues the work and submits.
    expect((await w.relay(w.envs.get(C.paseoAgentId!)!, 'submit', { text: 'Synthetic delivery by the new implementer C', idempotencyKey: 'c-submit' })).ok).toBe(true);
    w.agentRows.get(C.paseoAgentId!)!.status = 'idle';
    // The review goes to B, the same reviewer, and B accepts.
    const review = await w.tick();
    expect(review.woke.filter(x => x.task === task.id)).toEqual([expect.objectContaining({ employee: B.id, spawned: false })]);
    expect((await w.relay(w.envs.get(B.paseoAgentId!)!, 'review', { decision: 'accept', text: 'Independent synthetic review after the takeover', idempotencyKey: 'c-accept' })).ok).toBe(true);
    expect(await w.core.getTask(w.gm, task.id)).toMatchObject({ state: 'done', implementer: C.id });
    // The record: A and C both wrote the task, C is the bound implementer, and B reviewed it without ever authoring it.
    const facts = await w.wf.contributors(task.id);
    expect(facts.implementer).toBe(C.id);
    expect([...facts.authors].sort()).toEqual([A.id, C.id].sort());
    expect(facts.reviewers).toEqual([B.id]);
    expect(facts.excluded).not.toContain(B.id);
  } finally {
    await w.close();
  }
}, 90000);

// SYS-DISP R6(b) (AC04/AC06): legacy authors with no recorded implementer fail closed through the real tick and the real core. The
// conclusion is visible with its reason, the manager is woken with a takeover todo, and the core refuses a claim by a fresh engineer.
run('company fork: legacy authors without a recorded implementer wake the manager for takeover and the core refuses a claim', async () => {
  const w = await startCompanyFork('legacy');
  try {
    await w.wf.upsertDef('fixture-eng', { role: 'engineering', provider: 'codex', model: 'fixture', maxInstances: 2 });
    await w.wf.upsertDef('fixture-qa', { role: 'qa', provider: 'codex', model: 'fixture', maxInstances: 1 });
    await w.wf.upsertDef('fixture-gm', { role: 'gm', provider: 'codex', model: 'fixture', maxInstances: 1 });
    const task = await w.core.createTask(w.gm, { title: 'legacy authors and no recorded implementer', context: 'Synthetic regression only', executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: 'fixture-create-legacy' });
    // Two legacy authors. Their rows carry no phase, and the task never recorded an implementer. Actors are employee records,
    // as production audit rows are written: the derivation reads only employee actors, so plain strings would be dropped.
    const legacyOne = new RecordId('employee', 'legacy-author-one'), legacyTwo = new RecordId('employee', 'legacy-author-two');
    await w.db.db.query(`CREATE audit CONTENT { task: $task, actor: $one, action: 'claim', evidence: 'legacy row without phase', version: 2, at: time::now() };
      CREATE audit CONTENT { task: $task, actor: $one, action: 'submit', evidence: 'legacy row without phase', version: 3, at: time::now() };
      CREATE audit CONTENT { task: $task, actor: $two, action: 'claim', evidence: 'legacy row without phase', version: 4, at: time::now() };
      CREATE audit CONTENT { task: $task, actor: $two, action: 'submit', evidence: 'legacy row without phase', version: 5, at: time::now() };`,
    { task: new RecordId('task', task.id), one: legacyOne, two: legacyTwo });
    const facts = await w.wf.contributors(task.id);
    expect(facts.ambiguous).toBe(true);
    expect(facts.implementer).toBeUndefined();
    expect(facts.authors).toEqual(['legacy-author-one', 'legacy-author-two']);
    // The manager is woken with a takeover todo; the verdict stays the single source of the reason.
    const tick = await w.tick();
    const wake = tick.woke.find(x => x.task === task.id);
    expect(wake?.employee.startsWith('fixture-gm')).toBe(true);
    expect(tick.woke.filter(x => x.task === task.id)).toHaveLength(1);
    const verdict = w.verdicts().find(v => v.taskId === task.id && v.phase === 'execute')!;
    expect(verdict).toMatchObject({ dispatchable: false, feasible: false, workflowState: 'ready' });
    expect(verdict.reasons.map(r => r.code)).toContain('implementer_unresolved');
    expect(tick.notices).toContain(`dispatch-blocked:${task.id}:execute`);
    expect(await w.wf.openManagerActions()).toEqual([expect.objectContaining({ taskId: task.id, reason: 'implementer_unresolved' })]);
    // The core refuses a claim by a fresh engineer as well: the manager has to record the implementer first.
    const fresh = await w.wf.spawnInst((await w.wf.defs()).find(d => d.id === 'fixture-eng')!);
    await expect(w.core.claim(fresh.credential!, task.id)).rejects.toMatchObject({ code: 'forbidden' });
    expect(await w.core.getTask(w.gm, task.id)).toMatchObject({ state: 'ready' });
    // The same episode does not wake another gm on a repeated tick.
    expect((await w.tick()).woke.filter(x => x.task === task.id)).toHaveLength(0);
    // Real manager seam: dry-run first, then a compare-and-set takeover; a stale version is refused.
    const dry = await w.core.contributorDryRun(w.gm, { taskIds: [task.id] });
    expect(dry.tasks[0]).toMatchObject({ status: 'manager_decision' });
    const C = await w.wf.spawnInst((await w.wf.defs()).find(d => d.id === 'fixture-eng')!);
    // Launch the channel before binding the agent, then bind the agent in the pool: canReuse requires both.
    w.pool.env(C);
    await w.wf.bind(C.id, { agentId: `agent-${C.id}`, cwd: w.dir, repoHome: w.dir, model: 'fixture' });
    w.pool.bindAgent(C.id, `agent-${C.id}`);
    w.agentRows.set(`agent-${C.id}`, { id: `agent-${C.id}`, status: 'idle' });
    const current = await w.core.getTask(w.gm, task.id);
    await expect(w.core.implementerTakeover(w.gm, { taskId: task.id, toEmployee: C.id, expectedVersion: current.version + 1,
      reason: 'stale takeover regression', idempotencyKey: 'legacy-stale-takeover' })).rejects.toMatchObject({ code: 'conflict' });
    expect(await w.core.implementerTakeover(w.gm, { taskId: task.id, toEmployee: C.id, expectedVersion: current.version,
      reason: 'manager takes over the unresolved legacy task', idempotencyKey: 'legacy-takeover' })).toMatchObject({ implementer: C.id, state: 'ready' });
    const after = await w.tick();
    expect(after.woke.find(x => x.task === task.id)?.employee).toBe(C.id);
    expect(await w.wf.openManagerActions()).toHaveLength(0);
  } finally {
    await w.close();
  }
}, 90000);

// SYS-DISP R7 (AC07): the bound implementer's session ends for good (archived). No manager is involved: the tick hands the
// code to a live engineer of the same repository on its own, the audit row records the system actor, and the successor
// delivers without a manager takeover. With nobody available the same block waits instead of assigning.
run('company fork: an archived implementer is replaced by the system on its own, and the successor delivers', async () => {
  const w = await startCompanyFork('auto-successor');
  try {
    await w.wf.upsertDef('fixture-eng', { role: 'engineering', provider: 'codex', model: 'fixture', maxInstances: 1 });
    await w.wf.upsertDef('fixture-eng-grok', { role: 'engineering', provider: 'grok', model: 'fixture', maxInstances: 1 });
    await w.wf.upsertDef('fixture-qa', { role: 'qa', provider: 'codex', model: 'fixture', maxInstances: 1 });
    const task = await w.core.createTask(w.gm, { title: 'the struck implementer is replaced by the system', context: 'Synthetic regression only', executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: 'fixture-create-auto' });
    expect((await w.tick()).woke.find(x => x.task === task.id)?.spawned).toBe(true);
    const A = (await w.wf.insts()).filter(i => i.role === 'engineering').find(i => i.provider === 'codex')!;
    expect(await w.core.getTask(w.gm, task.id)).toMatchObject({ state: 'doing', currentEmployee: A.id, implementer: A.id });
    // A second engineer appears and finishes its own work first, so it is live, idle and free for handover.
    const warm = await w.core.createTask(w.gm, { title: 'the second engineer finishes its own work first', context: 'Synthetic regression only', executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: 'fixture-create-auto-warm' });
    expect((await w.tick()).woke.find(x => x.task === warm.id)?.spawned).toBe(true);
    const C = (await w.wf.insts()).filter(i => i.role === 'engineering').find(i => i.provider === 'grok')!;
    expect((await w.relay(w.envs.get(C.paseoAgentId!)!, 'submit', { text: 'Synthetic warm-up delivery by the second engineer', idempotencyKey: 'auto-warm-submit' })).ok).toBe(true);
    w.agentRows.get(C.paseoAgentId!)!.status = 'idle';
    const warmReview = await w.tick();
    const B = (await w.wf.insts()).find(i => i.role === 'qa')!;
    expect(warmReview.woke.find(x => x.task === warm.id)).toMatchObject({ employee: B.id, spawned: true });
    expect((await w.relay(w.envs.get(B.paseoAgentId!)!, 'review', { decision: 'accept', text: 'Independent synthetic review of the warm-up task', idempotencyKey: 'auto-warm-accept' })).ok).toBe(true);
    w.agentRows.get(B.paseoAgentId!)!.status = 'idle';
    // A's session ends normally: Paseo reports it archived, the employee record stays while its task is open, and the
    // retirement gate refuses to drop the session (the task is bound to it).
    w.agentRows.get(A.paseoAgentId!)!.status = 'archived';
    const replaced = await w.tick();
    expect(replaced.refused).toContain(A.id);
    expect(replaced.decisions).toContain(`auto-takeover:${task.id}=${C.id}`);
    expect(await w.core.getTask(w.gm, task.id)).toMatchObject({ state: 'ready', implementer: C.id });
    // The system acted, and the record says so: no manager credential was involved.
    const audit = await w.db.db.query<[Array<{ actor: string; action: string; evidence: string; at: string }>]>(
      `SELECT actor, action, evidence, at FROM audit WHERE task = $task AND action = 'implementer_takeover';`,
      { task: new RecordId('task', task.id) });
    const lastTakeover = [...(audit[0] ?? [])].sort((a, b) => String(a.at).localeCompare(String(b.at))).at(-1);
    expect(lastTakeover).toMatchObject({ actor: 'system:dispatcher' });
    expect(lastTakeover?.evidence).toContain('[implementer_takeover:auto]');
    // The next pass wakes the successor, which delivers and is reviewed by the same independent reviewer.
    const handover = await w.tick();
    expect(handover.woke.filter(x => x.task === task.id)).toEqual([expect.objectContaining({ employee: C.id, spawned: false })]);
    expect(await w.core.getTask(w.gm, task.id)).toMatchObject({ state: 'doing', currentEmployee: C.id, implementer: C.id });
    expect((await w.relay(w.envs.get(C.paseoAgentId!)!, 'submit', { text: 'Synthetic delivery by the automatic successor', idempotencyKey: 'auto-successor-submit' })).ok).toBe(true);
    w.agentRows.get(C.paseoAgentId!)!.status = 'idle';
    expect((await w.tick()).woke.filter(x => x.task === task.id)).toEqual([expect.objectContaining({ employee: B.id })]);
    expect((await w.relay(w.envs.get(B.paseoAgentId!)!, 'review', { decision: 'accept', text: 'Independent synthetic review after the automatic successor', idempotencyKey: 'auto-successor-accept' })).ok).toBe(true);
    expect(await w.core.getTask(w.gm, task.id)).toMatchObject({ state: 'done', implementer: C.id });
    const facts = await w.wf.contributors(task.id);
    expect(facts.implementer).toBe(C.id);
    expect(facts.authors).toContain(A.id);
  } finally {
    await w.close();
  }
}, 90000);

// SYS-DISP R7: with no live candidate the same conclusion waits by itself — nothing is assigned and the copy names the
// system, never the manager.
run('company fork: a struck implementer with no live candidate waits on a system block, and the manager is never asked', async () => {
  const w = await startCompanyFork('auto-successor-none');
  try {
    await w.wf.upsertDef('fixture-eng', { role: 'engineering', provider: 'codex', model: 'fixture', maxInstances: 1 });
    await w.wf.upsertDef('fixture-qa', { role: 'qa', provider: 'codex', model: 'fixture', maxInstances: 1 });
    const task = await w.core.createTask(w.gm, { title: 'no successor is available yet', context: 'Synthetic regression only', executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: 'fixture-create-auto-none' });
    expect((await w.tick()).woke.find(x => x.task === task.id)?.spawned).toBe(true);
    const A = (await w.wf.insts()).find(i => i.role === 'engineering')!;
    w.agentRows.get(A.paseoAgentId!)!.status = 'archived';
    const stuck = await w.tick();
    expect(stuck.woke.filter(x => x.task === task.id)).toHaveLength(0);
    expect(await w.core.getTask(w.gm, task.id)).toMatchObject({ state: 'ready', implementer: A.id });
    const verdict = w.verdicts().find(v => v.taskId === task.id && v.phase === 'execute')!;
    expect(verdict.dispatchable).toBe(false);
    const reason = verdict.reasons.find(r => r.code === 'implementer_unavailable')!;
    expect(reason).toMatchObject({ owner: 'system' });
    expect(reason.text).toContain('系统自动改派');
    expect(reason.actions[0]).toMatchObject({ authority: 'system', executable: false });
    expect(reason.recovery).toContain('无需经理');
  } finally {
    await w.close();
  }
}, 90000);
