import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Dispatcher } from '../src/dispatcher/dispatcher.ts';
import type { PaseoGateway } from '../src/dispatcher/paseo.ts';
import { DEFAULT_CONFIG, type EmployeeInst, type EmployeeDef, type SupervisedTask, type Workforce } from '../src/workforce.ts';
import type { CompanyCore, TaskView, LeaseProof } from '../src/contracts.ts';
import type { OwnerDesk } from '../src/owner.ts';
import type { SidecarDeps } from '../plugin/server/sidecar.ts';
import { SidecarPool } from '../plugin/server/sidecar.ts';
import { readJsonFile, reqDir, resDir, reportPath, blockerPath } from '../src/comm.ts';
const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); });
function world(role: EmployeeDef['role'] = 'engineering') {
  const root = mkdtempSync(join(tmpdir(), 'dispatch-comm-'));
  const instances: EmployeeInst[] = [], rows: SupervisedTask[] = [];
  const views = new Map<string, TaskView>(), agents = new Map<string, { id: string; status: string }>();
  const envs = new Map<string, Record<string, string>>(), events: string[] = [], retired = new Set<string>();
  const def: EmployeeDef = { id: 'test', role, provider: 'codex', model: 'fixture', enabled: true, maxInstances: 1, priority: 0, weight: 1, scored: 0, errorStreak: 0 };
  let next = 0, request = 0;
  const addTask = (id: string) => { const v: TaskView = { id, title: id, context: '', state: 'ready', executorRole: 'engineering', reviewerRole: 'engineering', kind: 'task', dependencies: [], version: 1, fence: 0 };
    views.set(id, v); rows.push({ ...v, row: {}, evalAttempts: 0 } as unknown as SupervisedTask); };
  const wf = {
    config: async () => ({ ...DEFAULT_CONFIG, quotaFloorPct: 0, quotaWeeklyFloorPct: 0, sessionMaxWakes: 0, sessionMaxInputK: 0, evalEnabled: false, jevDecisions: false }),
    defs: async () => [def], serverNow: async () => 1000, insts: async () => instances.filter(i => !retired.has(i.id)), tasks: async () => rows,
    providerHealth: async () => new Map(), lastDispatch: async () => undefined, recordDispatch: async () => {}, touchWake: async () => {}, defHealthy: async () => {},
    defFailure: async () => { events.push('performance-failure'); return 1; },
    spawnInst: async () => { const i: EmployeeInst = { id: `employee-${++next}`, def: def.id, role: def.role, provider: def.provider, model: def.model, credential: `fixture-${next}` }; instances.push(i); return i; },
    bind: async (id: string, b: { agentId: string; cwd: string }) => { Object.assign(instances.find(i => i.id === id)!, { paseoAgentId: b.agentId, cwd: b.cwd }); },
    retire: async (id: string) => { events.push(`retire:${id}`); retired.add(id); },
    rotate: async (id: string) => { events.push(`rotate:${id}`); return `rotated-${id}`; },
    revokeLease: async (id: string, employee: string) => { const r = rows.find(t => t.id === id)!; if (r.currentEmployee !== employee) return false;
      events.push(`revoke:${id}`); Object.assign(r, { currentEmployee: undefined, state: 'ready', version: r.version + 1 }); Object.assign(views.get(id)!, r); return true; }, extendLease: async () => true,
  };
  const owner = { applyPending: async () => [], resolveNotice: async () => {}, openNotices: async () => [], triagePending: async () => [], raiseNotice: async () => false };
  const check = (p: LeaseProof) => { const v = views.get(p.taskId)!; if (v.deliveryId !== p.deliveryId || v.fence !== p.fence || v.version !== p.expectedVersion) throw Object.assign(new Error('stale lease'), { code: 'stale_lease' }); return v; };
  const core = {
    claim: async (cred: string, id: string) => { const i = instances.find(i => i.credential === cred || cred === `rotated-${i.id}`)!;
      events.push(`claim:${i.id}:${id}`); const v = views.get(id)!; Object.assign(v, { state: 'doing', currentEmployee: i.id, version: v.version + 1, fence: v.fence + 1 }); v.deliveryId = `d-${id}-${v.fence}`;
      Object.assign(rows.find(t => t.id === id)!, v, { leaseExpiresAt: 2000 }); i.activeTask = id;
      return { task: { ...v }, deliveryId: v.deliveryId, fence: v.fence, leaseExpiresAt: new Date().toISOString(), history: [] }; },
    getTask: async (_c: string, id: string) => ({ ...views.get(id)! }), history: async () => [], authenticate: async () => ({ employeeId: 'fixture', role: 'gm' }),
    companyBrief: async () => ({}), listTasks: async () => [], relayDirection: async () => { events.push('management'); }, heartbeat: async (_c: string, p: LeaseProof) => ({ task: check(p) }),
    submit: async (_c: string, p: LeaseProof) => { const v = check(p); events.push(`submit:${p.taskId}`); v.state = 'done'; v.currentEmployee = undefined; Object.assign(rows.find(t => t.id === v.id)!, v); return v; },
    block: async (_c: string, p: LeaseProof) => { check(p); events.push(`block:${p.taskId}`); return views.get(p.taskId)!; },
    accept: async (_c: string, p: LeaseProof) => { const v = check(p); events.push(`review:${p.taskId}`); return v; },
  };
  const ops = { tools: ['ops_info'], call: async () => { events.push('ops'); return {}; }, release: (id: string) => { events.push(`ops-release:${id}`); } };
  const makePool = () => new SidecarPool({ core: core as unknown as CompanyCore, workforce: wf as unknown as SidecarDeps['workforce'], ops, runDir: root, sweepMs: 5, heartbeatMs: 1000000 });
  let pool = makePool();
  const paseo: PaseoGateway = {
    list: async () => agents, status: async id => agents.get(id) ? { status: agents.get(id)!.status, pendingPermissions: 0 } : undefined,
    lastError: async () => '', logsTail: async () => 'fixture transcript', lastInputTokens: async () => 0,
    spawn: async b => { const id = `agent-${b.labels.employee_id}`; agents.set(id, { id, status: 'running' }); envs.set(id, b.env); events.push(`spawn:${id}`); return id; },
    send: async id => { events.push(`send:${id}`); agents.get(id)!.status = 'running'; }, stop: async id => { events.push(`stop:${id}`); agents.get(id)!.status = 'idle'; },
    archive: async id => { events.push(`archive:${id}`); agents.get(id)!.status = 'archived'; pool.detachAgent(id); },
  };
  const dispatcher = () => new Dispatcher({ workforce: wf as unknown as Workforce, owner: owner as unknown as OwnerDesk, paseo, sidecar: pool,
    env: { opsRepo: '/fixture', sckBin: '/bin/sck', paseoBin: '/bin/paseo' }, rand: () => 0 });
  const relay = async (env: Record<string, string>, tool: string, args: Record<string, unknown> = {}) => {
    const name = `${++request}.json`, dir = env.SCK_COMM_DIR!;
    writeFileSync(join(reqDir(dir), name), JSON.stringify({ key: env.SCK_COMM_KEY, tool, args }));
    for (let n = 0; n < 100 && !existsSync(join(resDir(dir), name)); n++) await Bun.sleep(5);
    const r = readJsonFile<{ ok: boolean; error?: string }>(join(resDir(dir), name)); if (!r) throw new Error('relay timeout'); return r;
  };
  cleanup.push(() => { for (const i of instances) if (i.paseoAgentId) pool.detachAgent(i.paseoAgentId); rmSync(root, { recursive: true, force: true }); });
  return { addTask, dispatcher, instances, agents, envs, events, views, relay, get pool() { return pool; },
    restart: async () => { for (const i of instances) if (i.paseoAgentId) pool.detachAgent(i.paseoAgentId); pool = makePool(); await pool.adopt(instances.map(i => ({ ...i, credential: undefined }))); } };
}
describe('dispatcher + sidecar launch/reuse/restart', () => {
  test('same-process reuse keeps launch binding for management, ops and review', async () => {
    const w = world(); w.addTask('first'); const d = w.dispatcher(); await d.tick();
    const i = w.instances[0]!, env = w.envs.get(i.paseoAgentId!)!;
    expect(w.pool.env(i).SCK_COMM_KEY === env.SCK_COMM_KEY).toBe(true);
    expect((await w.relay(env, 'set_direction', { text: 'fixture' })).ok).toBe(true);
    expect((await w.relay(env, 'ops_info')).ok).toBe(true);
    expect((await w.relay({ ...env, SCK_COMM_KEY: 'wrong' }, 'review')).ok).toBe(false);
    expect((await w.relay(env, 'submit', { text: 'fixture' })).ok).toBe(true);
    w.agents.get(i.paseoAgentId!)!.status = 'idle'; w.addTask('next');
    writeFileSync(join(reqDir(env.SCK_COMM_DIR!), 'old-review.json'), JSON.stringify({ key: env.SCK_COMM_KEY, tool: 'review', args: { decision: 'accept' } }));
    await d.tick(); expect(w.instances).toHaveLength(1);
    const oldRequest = readJsonFile<{ ok: boolean }>(join(resDir(env.SCK_COMM_DIR!), 'old-review.json'));
    expect(oldRequest?.ok).toBe(false); expect(w.events).not.toContain('review:next');
    expect((await w.relay(env, 'get_task_history', { taskId: 'next' })).ok).toBe(true);
    expect((await w.relay(env, 'ops_info')).ok).toBe(true);
    expect((await w.relay(env, 'review', { decision: 'accept', text: 'fixture' })).ok).toBe(true);
  });
  test('healthy management-only GM survives idempotent adoption in the same process', async () => {
    const w = world('gm');
    const gm: EmployeeInst = { id: 'gm-fixture', role: 'gm', credential: 'fixture-gm' };
    const env = w.pool.env(gm); w.pool.bindAgent(gm.id, 'agent-gm'); gm.paseoAgentId = 'agent-gm';
    await w.pool.adopt([gm]);
    expect(w.pool.canReuse(gm)).toBe(true);
    expect((await w.relay(env, 'set_direction', { text: 'fixture management' })).ok).toBe(true);
    expect((await w.relay({ ...env, SCK_COMM_KEY: 'wrong' }, 'set_direction')).ok).toBe(false);
    w.pool.detachAgent('agent-gm'); expect(w.pool.canReuse(gm)).toBe(false);
  });
  test('archival detaches, retires and releases the only seat without a performance strike', async () => {
    const w = world(); w.addTask('archived'); await w.dispatcher().tick();
    const old = w.instances[0]!;
    await w.relay(w.envs.get(old.paseoAgentId!)!, 'submit');
    w.pool.detachAgent(old.paseoAgentId!); w.agents.get(old.paseoAgentId!)!.status = 'archived'; w.addTask('replacement');
    const r = await w.dispatcher().tick();
    expect(r.retired).toContain(old.id); expect(w.pool.canReuse(old)).toBe(false);
    expect(r.woke[0]?.spawned).toBe(true); expect(w.events).not.toContain('performance-failure');
    expect(w.events.filter(e => e === `ops-release:${old.id}`).length).toBeGreaterThan(1);
  });
  test('restart re-keys the channel: pre-restart requests die, the instance keeps its seat', async () => {
    const w = world(); w.addTask('resume'); await w.dispatcher().tick();
    const old = w.instances[0]!, env = w.envs.get(old.paseoAgentId!)!; await w.restart();
    // Requests written under the pre-restart key are refused — the channel was re-keyed, not killed.
    for (const tool of ['get_task_history', 'ops_info', 'review']) expect((await w.relay(env, tool, { taskId: 'resume' })).ok).toBe(false);
    // Adoption rotated the credential and bound the same agent, so the instance stays reusable.
    expect(w.events).toContain(`rotate:${old.id}`); expect(w.pool.canReuse(old)).toBe(true);
    writeFileSync(reportPath(env.SCK_COMM_DIR!), 'stale report'); writeFileSync(blockerPath(env.SCK_COMM_DIR!), 'stale blocker'); await w.pool.settle(old.paseoAgentId!);
    // claim.json died with the old lease — these artifacts are orphaned, never submitted.
    expect(w.events).not.toContain('submit:resume'); expect(w.events).not.toContain('block:resume');
    const r = await w.dispatcher().tick();
    expect(r.retired).not.toContain(old.id); expect(w.instances).toHaveLength(1);
    expect(w.events).not.toContain('performance-failure');
  });
});
