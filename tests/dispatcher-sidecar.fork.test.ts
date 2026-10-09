import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { RecordId } from 'surrealdb';
import { CompanyDatabase } from '../src/database.ts';
import { SurrealCompanyCore } from '../src/core.ts';
import { LocalEnrollmentAdmin } from '../src/enrollment.ts';
import { OwnerDesk } from '../src/owner.ts';
import { Workforce } from '../src/workforce.ts';
import { Dispatcher } from '../src/dispatcher/dispatcher.ts';
import type { PaseoGateway } from '../src/dispatcher/paseo.ts';
import { SidecarPool, type SidecarDeps } from '../plugin/server/sidecar.ts';
import { readJsonFile, reqDir, resDir, reportPath, blockerPath } from '../src/comm.ts';
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
      send: async id => { agentRows.get(id)!.status = 'running'; }, stop: async id => { agentRows.get(id)!.status = 'idle'; },
      archive: async id => { agentRows.get(id)!.status = 'archived'; pool!.detachAgent(id); } };
    const makeDispatcher = () => new Dispatcher({ workforce: wf, owner, paseo, sidecar: pool!, rand: () => 0,
      env: { opsRepo: dir, sckBin: '/fixture/sck', paseoBin: '/fixture/paseo' } });
    let counter = 0;
    const relay = async (env: Record<string, string>, tool: string, args: Record<string, unknown> = {}) => {
      const file = `${++counter}.json`; writeFileSync(join(reqDir(env.SCK_COMM_DIR!), file), JSON.stringify({ key: env.SCK_COMM_KEY, tool, args }));
      for (let n = 0; n < 200 && !existsSync(join(resDir(env.SCK_COMM_DIR!), file)); n++) await Bun.sleep(5);
      const result = readJsonFile<{ ok: boolean; error?: string }>(join(resDir(env.SCK_COMM_DIR!), file)); expect(!!result).toBe(true); return result!;
    };
    const task = await core.createTask(gm, { title: 'isolated channel recovery', context: 'Synthetic regression only', executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: 'fixture-create' });
    await makeDispatcher().tick();
    const old = (await wf.insts())[0]!, oldEnv = envs.get(old.paseoAgentId!)!;
    const oldClaim = readJsonFile<ClaimResult>(join(oldEnv.SCK_COMM_DIR!, 'claim.json'))!;
    const oldProof: LeaseProof = { taskId: task.id, deliveryId: oldClaim.deliveryId, fence: oldClaim.fence, expectedVersion: oldClaim.task.version };
    expect((await relay(oldEnv, 'get_task_history', { taskId: task.id })).ok).toBe(true);
    expect((await relay(oldEnv, 'ops_info')).ok).toBe(true);
    pool.detachAgent(old.paseoAgentId!); pool = makePool(); await pool.adopt(await wf.insts());
    expect((await relay(oldEnv, 'get_task_history', { taskId: task.id })).ok).toBe(false);
    expect((await relay(oldEnv, 'ops_info')).ok).toBe(false);
    expect((await relay(oldEnv, 'review', { decision: 'accept', text: 'stale' })).ok).toBe(false);
    writeFileSync(reportPath(oldEnv.SCK_COMM_DIR!), 'stale report'); writeFileSync(blockerPath(oldEnv.SCK_COMM_DIR!), 'stale blocker');
    await pool.settle(old.paseoAgentId!);
    const recovery = await makeDispatcher().tick();
    expect(recovery.retired).toContain(old.id); expect(recovery.revoked).toContain(task.id); expect(recovery.woke).toHaveLength(1);
    expect(releases).toBeGreaterThan(1);
    await expect(core.checkpoint(minted.get(old.id)!, oldProof, { text: 'replay', idempotencyKey: 'old-replay' })).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(core.checkpoint(gm, oldProof, { text: 'lease replay', idempotencyKey: 'old-manager-proof' })).rejects.toBeDefined();
    const fresh = (await wf.insts())[0]!, env = envs.get(fresh.paseoAgentId!)!;
    const current = readJsonFile<ClaimResult>(join(env.SCK_COMM_DIR!, 'claim.json'))!;
    expect(current.fence).toBeGreaterThan(oldClaim.fence); expect(current.deliveryId === oldClaim.deliveryId).toBe(false);
    expect((await relay(env, 'get_task_history', { taskId: task.id })).ok).toBe(true);
    expect((await relay(env, 'ops_info')).ok).toBe(true);
    expect((await relay(env, 'submit', { text: 'synthetic isolated delivery', idempotencyKey: 'new-submit' })).ok).toBe(true);
    agentRows.get(fresh.paseoAgentId!)!.status = 'idle';
    await wf.upsertDef('fixture-qa', { role: 'qa', provider: 'codex', model: 'fixture', maxInstances: 1 });
    await makeDispatcher().tick();
    const qa = (await wf.insts()).find(i => i.role === 'qa')!, qaEnv = envs.get(qa.paseoAgentId!)!;
    expect(qa.id === fresh.id).toBe(false);
    expect((await relay(qaEnv, 'review', { decision: 'accept', text: 'Independent synthetic regression review', idempotencyKey: 'qa-accept' })).ok).toBe(true);
    const final = await core.getTask(gm, task.id); expect(final.state).toBe('done');
    const history = await core.history(gm, task.id); expect(history.some(h => h.action === 'revoked')).toBe(true); expect(history.some(h => h.action === 'accept' && h.actor !== fresh.id)).toBe(true);
  } finally {
    for (const id of agentRows.keys()) pool?.detachAgent(id);
    await db.close(); child.kill(); await child.exited; rmSync(dir, { recursive: true, force: true });
  }
}, 30000);
