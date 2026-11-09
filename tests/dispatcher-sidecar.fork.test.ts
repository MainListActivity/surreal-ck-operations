import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
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
import { readJsonFile, reqDir, resDir, reportPath } from '../src/comm.ts';
import type { ClaimResult, LeaseProof } from '../src/contracts.ts';
import { RESPONSE_BUDGET_BYTES, answerBytes, guardRelayResponse } from '../src/response-budget.ts';

const run = process.env.RUN_SCK_CHANNEL_FORK_TESTS === '1' ? test : test.skip;
const CLIENT_CLI = join(import.meta.dir, '..', 'src', 'mcp', 'client-cli.ts');

/** Exercise the same comm path a real `sck call` uses: a separate client-cli process writes req and reads res. */
async function relayViaClient(env: Record<string, string>, tool: string, args: Record<string, unknown> = {}) {
  // Spawn asynchronously: the sidecar sweeper lives in this same Bun process, so a blocking
  // spawnSync would prevent it from answering the child client.
  const child = Bun.spawn([process.execPath, CLIENT_CLI, 'call', tool, JSON.stringify(args)], {
    env: { ...process.env, SCK_COMM_DIR: env.SCK_COMM_DIR!, SCK_COMM_KEY: env.SCK_COMM_KEY! },
    stdout: 'pipe', stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  let answer: { data?: unknown; error?: string } | undefined;
  try { answer = stdout.trim() ? JSON.parse(stdout.trim()) : undefined; } catch { answer = undefined; }
  if (code === 0) return { ok: true, data: answer };
  const error = (typeof answer?.error === 'string' && answer.error) || stderr.trim() || 'real sck client failed';
  return { ok: false, error };
}
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
    const gm = await enrollment.enroll('fixture-manager', 'owner', ['execute', 'review', 'manage']);
    await db.db.upsert(new RecordId('company_meta', 'config')).content({ jev_decisions: false, quota_floor_pct: 0, quota_weekly_floor_pct: 0, session_max_wakes: 0, session_max_input_k: 0 });
    const wf = new Workforce(db, join(dir, 'unused-credential-files'));
    await wf.upsertDef('fixture-eng', { role: 'engineering', provider: 'codex', model: 'fixture', maxInstances: 1 });
    const minted = new Map<string, string>();
    const originalSpawn = wf.spawnInst.bind(wf);
    // All arguments are forwarded: the session's task binding (sessionTask) decides whether it is ever reused.
    wf.spawnInst = async (...args) => { const i = await originalSpawn(...args); minted.set(i.id, i.credential!); return i; };
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
    const relay = (env: Record<string, string>, tool: string, args: Record<string, unknown> = {}) => relayViaClient(env, tool, args);
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
    pool?.close(); await db.close(); child.kill(); await child.exited; rmSync(dir, { recursive: true, force: true });
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
    const gm = await enrollment.enroll('fixture-manager', 'owner', ['execute', 'review', 'manage']);
    await db.db.upsert(new RecordId('company_meta', 'config')).content({ jev_decisions: false, quota_floor_pct: 0, quota_weekly_floor_pct: 0, session_max_wakes: 0, session_max_input_k: 0 });
    const wf = new Workforce(db, join(dir, 'unused-credential-files'));
    // Two seats of one engineering def: the implementer takes one, and the independent reviewer keeps the other (R1).
    await wf.upsertDef('fixture-eng', { role: 'engineering', provider: 'codex', model: 'fixture', maxInstances: 2 });
    const minted = new Map<string, string>();
    const originalSpawn = wf.spawnInst.bind(wf);
    // All arguments are forwarded: the session's task binding (sessionTask) decides whether it is ever reused.
    wf.spawnInst = async (...args) => { const i = await originalSpawn(...args); minted.set(i.id, i.credential!); return i; };
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
    // The returned task is ready again: any engineer may claim it (the prior-submitter rule gates only review).
    const bClaim = await core.claim(minted.get(B.id)!, task.id);
    await core.release(minted.get(B.id)!, { taskId: task.id, deliveryId: bClaim.deliveryId, fence: bClaim.fence, expectedVersion: bClaim.task.version }, { text: 'B releases the task back to the ready queue for the rework test.', idempotencyKey: 'b-release' });
    expect(await core.getTask(gm, task.id)).toMatchObject({ state: 'ready' });
    // Round 2: the rework goes back to A, and B is never the execute target.
    const rework = await makeDispatcher().tick();
    expect(rework.woke.find(w => w.task === task.id)?.employee).toBe(A.id);
    expect((await relay(envA(), 'submit', { text: 'Synthetic round-2 rework from A', idempotencyKey: 'a-submit-2' })).ok).toBe(true);
    agentRows.get(A.paseoAgentId!)!.status = 'idle';
    // B re-reviews as the reserved independent reviewer and accepts; A stays the only author.
    const review2 = await makeDispatcher().tick();
    expect(review2.woke.find(w => w.task === task.id)?.employee).toBe(B.id);
    expect((await relay(envs.get(B.paseoAgentId!)!, 'review', { decision: 'accept', text: 'Independent synthetic re-review of the rework' })).ok).toBe(true);
    expect(await core.getTask(gm, task.id)).toMatchObject({ state: 'done' });
    const facts = await wf.contributors(task.id);
    expect(facts.excluded).toEqual([A.id]);
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
async function startCompanyFork(name: string, tempRoot = tmpdir()) {
  const dir = mkdtempSync(join(tempRoot, `channel-fork-${name}-`));
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
  const gm = await enrollment.enroll('fixture-manager', 'owner', ['execute', 'review', 'manage']);
  await db.db.upsert(new RecordId('company_meta', 'config')).content({ jev_decisions: false, quota_floor_pct: 0, quota_weekly_floor_pct: 0, session_max_wakes: 0, session_max_input_k: 0 });
  const wf = new Workforce(db, join(dir, 'unused-credential-files'));
  const agentRows = new Map<string, { id: string; status: string }>();
  const errors = new Map<string, string>();
  const envs = new Map<string, Record<string, string>>();
  const ops = { tools: ['ops_info'], call: async () => ({ available: true }), release: () => {} };
  let pool: SidecarPool | undefined = new SidecarPool({ core, workforce: wf as unknown as SidecarDeps['workforce'], ops, runDir: join(dir, 'comm'), sweepMs: 5 });
  const spawnFailures = { remaining: 0 };
  const paseo: PaseoGateway = { list: async () => agentRows, status: async id => agentRows.get(id) ? { status: agentRows.get(id)!.status, pendingPermissions: 0 } : undefined,
    lastError: async id => errors.get(id) ?? '', logsTail: async () => 'isolated synthetic transcript', lastInputTokens: async () => 0,
    spawn: async b => { if (spawnFailures.remaining > 0) { spawnFailures.remaining--; throw new Error('fixture launch unavailable'); } const id = `agent-${b.labels.employee_id}`; agentRows.set(id, { id, status: 'running' }); envs.set(id, b.env); return id; },
    send: async id => { agentRows.get(id)!.status = 'running'; }, stop: async id => { agentRows.get(id)!.status = 'idle'; }, reload: async id => { agentRows.get(id)!.status = 'idle'; },
    archive: async id => { agentRows.get(id)!.status = 'archived'; pool?.detachAgent(id); },
    listWorkspaces: async () => [], listProjects: async () => [], archiveWorkspace: async () => {}, deleteProject: async () => {} };
  let last: Dispatcher | undefined;
  const relay = (env: Record<string, string>, tool: string, args: Record<string, unknown> = {}) => relayViaClient(env, tool, args);
  return {
    core, owner, wf, db, gm, dir, pool: pool!, agentRows, errors, envs, relay, spawnFailures,
    /** One real tick on a fresh dispatcher, as the existing fork tests run it. */
    tick: async () => {
      last = new Dispatcher({ workforce: wf, owner, paseo, sidecar: pool!, rand: () => 0,
        log: process.env.SCK_TEST_DISPATCH_LOG === '1' ? message => console.log('DISPATCH', message) : undefined,
        env: { opsRepo: dir, sckBin: '/fixture/sck', paseoBin: '/fixture/paseo' } });
      return last.tick();
    },
    /** Process restart: the old pool loses its channel/claim memory, then a fresh pool adopts the roster.
     *  The comm directory (including claim.json and any artifact written before the crash) persists. */
    reload: async () => {
      pool?.close();
      const next = new SidecarPool({ core, workforce: wf as unknown as SidecarDeps['workforce'], ops, runDir: join(dir, 'comm'), sweepMs: 5 });
      pool = next;
      await next.adopt(await wf.insts());
    },
    verdicts: () => last?.dispatchVerdicts() ?? [],
    snapshot: () => last?.dispatchSnapshot(),
    close: async () => {
      for (const id of agentRows.keys()) pool?.detachAgent(id);
      pool?.close();
      await db.close(); child.kill(); await child.exited; rmSync(dir, { recursive: true, force: true });
    },
  };
}

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

run('company fork: plugin reload recovers a live review lease for checkpoint and formal review', async () => {
  const w = await startCompanyFork('review-recovery');
  try {
    await w.wf.upsertDef('fixture-eng', { role: 'engineering', provider: 'codex', model: 'fixture', maxInstances: 1 });
    await w.wf.upsertDef('fixture-qa', { role: 'qa', provider: 'codex', model: 'fixture', maxInstances: 1 });
    const task = await w.core.createTask(w.gm, { title: 'review lease survives plugin reload', context: 'Synthetic regression only', executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: 'fixture-create-review-recovery' });
    expect((await w.tick()).woke.find(x => x.task === task.id)?.spawned).toBe(true);
    const A = (await w.wf.insts()).find(i => i.role === 'engineering')!;
    expect((await w.relay(w.envs.get(A.paseoAgentId!)!, 'submit', { text: 'Synthetic delivery for reload review', idempotencyKey: 'review-recovery-submit' })).ok).toBe(true);
    w.agentRows.get(A.paseoAgentId!)!.status = 'idle';
    const reviewTick = await w.tick();
    const Q = (await w.wf.insts()).find(i => i.role === 'qa')!;
    expect(reviewTick.woke.find(x => x.task === task.id)).toMatchObject({ employee: Q.id, spawned: true });
    expect(await w.core.getTask(w.gm, task.id)).toMatchObject({ state: 'review', currentEmployee: Q.id });
    const qaEnv = w.envs.get(Q.paseoAgentId!)!;
    expect((await w.relay(qaEnv, 'checkpoint', { text: 'review checkpoint before plugin reload', idempotencyKey: 'review-checkpoint-before' })).ok).toBe(true);
    const before = await w.core.getTask(w.gm, task.id);
    expect(before.state).toBe('review');
    expect(before.deliveryId).toBeTruthy();
    // A report.md written before the process died is not a review closeout: the recovered
    // pool must archive it, never submit it or end the review lease.
    writeFileSync(reportPath(qaEnv.SCK_COMM_DIR!), 'review report written during plugin reload');
    await w.reload();
    expect(readdirSync(qaEnv.SCK_COMM_DIR!).some(f => f.startsWith('report.md.stale-'))).toBe(true);
    // The old session key is fenced out; the agent re-enters through the adopter's binding pointer.
    expect((await w.relay(qaEnv, 'checkpoint', { text: 'old key must be fenced after reload', idempotencyKey: 'review-old-key' })).ok).toBe(false);
    const [boundDir, boundKey] = readFileSync(join(w.dir, 'comm-agents', Q.paseoAgentId!), 'utf8').trim().split('\n');
    const rebound = { SCK_COMM_DIR: boundDir!, SCK_COMM_KEY: boundKey! };
    expect((await w.relay(rebound, 'checkpoint', { text: 'review checkpoint after plugin reload', idempotencyKey: 'review-checkpoint-after' })).ok).toBe(true);
    expect((await w.relay(rebound, 'review', { decision: 'accept', text: 'Independent review after plugin reload', idempotencyKey: 'review-accept-after' })).ok).toBe(true);
    const final = await w.core.getTask(w.gm, task.id);
    expect(final).toMatchObject({ state: 'done' });
    const history = await w.core.history(w.gm, task.id);
    expect(history.some(h => h.action === 'accept' && h.actor === Q.id)).toBe(true);
    const [audits] = await w.db.db.query<[Array<{ action: string; actor: string }>]>(
      "SELECT action, actor FROM audit WHERE task = $task AND action IN ['checkpoint','accept'];",
      { task: new RecordId('task', task.id) });
    expect(audits.filter(a => a.action === 'checkpoint')).toHaveLength(2);
    expect(audits.filter(a => a.action === 'accept')).toHaveLength(1);
    expect(String(audits.find(a => a.action === 'accept')?.actor)).toContain(Q.id);
  } finally {
    await w.close();
  }
}, 90000);

run('company fork: plugin reload recovers a live review lease for report_blocker', async () => {
  const w = await startCompanyFork('review-blocker-recovery');
  try {
    await w.wf.upsertDef('fixture-eng', { role: 'engineering', provider: 'codex', model: 'fixture', maxInstances: 1 });
    await w.wf.upsertDef('fixture-qa', { role: 'qa', provider: 'codex', model: 'fixture', maxInstances: 1 });
    const task = await w.core.createTask(w.gm, { title: 'review blocker survives plugin reload', context: 'Synthetic regression only', executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: 'fixture-create-review-blocker' });
    expect((await w.tick()).woke.find(x => x.task === task.id)?.spawned).toBe(true);
    const A = (await w.wf.insts()).find(i => i.role === 'engineering')!;
    expect((await w.relay(w.envs.get(A.paseoAgentId!)!, 'submit', { text: 'Synthetic delivery for reload blocker', idempotencyKey: 'review-blocker-submit' })).ok).toBe(true);
    w.agentRows.get(A.paseoAgentId!)!.status = 'idle';
    const reviewTick = await w.tick();
    const Q = (await w.wf.insts()).find(i => i.role === 'qa')!;
    expect(reviewTick.woke.find(x => x.task === task.id)).toMatchObject({ employee: Q.id, spawned: true });
    expect(await w.core.getTask(w.gm, task.id)).toMatchObject({ state: 'review', currentEmployee: Q.id });
    await w.reload();
    const [boundDir, boundKey] = readFileSync(join(w.dir, 'comm-agents', Q.paseoAgentId!), 'utf8').trim().split('\n');
    const rebound = { SCK_COMM_DIR: boundDir!, SCK_COMM_KEY: boundKey! };
    expect((await w.relay(rebound, 'report_blocker', { to: 'owner', text: 'Review blocker after plugin reload', idempotencyKey: 'review-blocker-after' })).ok).toBe(true);
    expect(await w.core.getTask(w.gm, task.id)).toMatchObject({ state: 'blocked', blockedTo: 'owner' });
    const history = await w.core.history(w.gm, task.id);
    expect(history.some(h => h.action === 'block' && h.actor === Q.id)).toBe(true);
    const [audits] = await w.db.db.query<[Array<{ action: string; actor: string }>]>(
      "SELECT action, actor FROM audit WHERE task = $task AND action = 'block';",
      { task: new RecordId('task', task.id) });
    expect(audits).toHaveLength(1);
    expect(String(audits[0]!.actor)).toContain(Q.id);
  } finally {
    await w.close();
  }
}, 90000);


