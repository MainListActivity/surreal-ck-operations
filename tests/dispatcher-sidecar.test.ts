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
  const cwds = new Map<string, string>(), wtPaths = new Map<string, string>(), denied = new Set<string>();
  const authorsOf = new Map<string, string[]>();
  // Two seats: an independent reviewer other than the implementer needs a second engineer, so the fixture keeps a spare seat (R1).
  const def: EmployeeDef = { id: 'test', role, provider: 'codex', model: 'fixture', enabled: true, maxInstances: 2, priority: 0, weight: 1, scored: 0, errorStreak: 0 };
  let next = 0, request = 0, now = 1000;
  const addTask = (id: string, opts: { state?: TaskView['state']; submittedBy?: string; worktreePath?: string; discipline?: string } = {}) => {
    const v: TaskView = { id, title: id, context: '', state: opts.state ?? 'ready', executorRole: 'engineering', reviewerRole: 'engineering',
      kind: 'task', dependencies: [], version: 1, fence: 0, submittedBy: opts.submittedBy, discipline: opts.discipline };
    if (opts.worktreePath) {
      wtPaths.set(id, opts.worktreePath);
      v.worktree = { id: `wt-${id}`, repo: '/repo', worktreePath: opts.worktreePath, mode: 'exclusive', intent: { kind: 'code' }, discipline: '' };
    }
    views.set(id, v); rows.push({ ...v, row: {}, evalAttempts: 0, repoPath: opts.worktreePath ? '/repo' : undefined } as unknown as SupervisedTask); };
  const wf = {
    config: async () => ({ ...DEFAULT_CONFIG, quotaFloorPct: 0, quotaWeeklyFloorPct: 0, sessionMaxWakes: 0, sessionMaxInputK: 0, evalEnabled: false, jevDecisions: false }),
    defs: async () => [def], serverNow: async () => now, insts: async () => instances.filter(i => !retired.has(i.id)), tasks: async () => rows,
    providerHealth: async () => new Map(), lastDispatch: async () => undefined, recordDispatch: async () => {}, touchWake: async () => {}, defHealthy: async () => {},
    defFailure: async () => { events.push('performance-failure'); return 1; },
    spawnInst: async () => { const i: EmployeeInst = { id: `employee-${++next}`, def: def.id, role: def.role, provider: def.provider, model: def.model, credential: `fixture-${next}` }; instances.push(i); return i; },
    bind: async (id: string, b: { agentId: string; cwd: string; repoHome?: string }) => {
      const { agentId, ...rest } = b;
      Object.assign(instances.find(i => i.id === id)!, { paseoAgentId: agentId, ...rest });
    },
    retire: async (id: string, _reason: string, kind: string) => { events.push(`retire:${id}:${kind}`); retired.add(id); },
    rotate: async (id: string) => { events.push(`rotate:${id}`); return `rotated-${id}`; },
    revokeLease: async (id: string, employee: string) => { const r = rows.find(t => t.id === id)!; if (r.currentEmployee !== employee) return false;
      events.push(`revoke:${id}`); Object.assign(r, { currentEmployee: undefined, state: 'ready', version: r.version + 1 }); Object.assign(views.get(id)!, r); return true; }, extendLease: async () => true,
    evalState: async () => ({ participants: [], metrics: {} }),
    // Authors are set per task by the test (authorsOf); no implementer is bound, so no execute gate applies.
    contributors: async (taskId: string) => ({ authors: [], reviewers: [], unknown: [], ambiguous: false, excluded: authorsOf.get(taskId) ?? [] }),
    setDispatchBlock: async (id: string, phase?: string, since?: number) => {
      Object.assign(rows.find(t => t.id === id)!, { dispatchBlockedPhase: phase, dispatchBlockedSince: since });
    },
  };
  const notices = new Map<string, string>();
  const owner = { applyPending: async () => [], resolveNotice: async (key: string) => { notices.delete(key); }, openNotices: async () => [], triagePending: async () => [],
    raiseNotice: async (key: string, text: string) => { notices.set(key, text); return true; } };
  const check = (p: LeaseProof) => { const v = views.get(p.taskId)!; if (v.deliveryId !== p.deliveryId || v.fence !== p.fence || v.version !== p.expectedVersion) throw Object.assign(new Error('stale lease'), { code: 'stale_lease' }); return v; };
  const core = {
    claim: async (cred: string, id: string) => { const i = instances.find(i => i.credential === cred || cred === `rotated-${i.id}`)!;
      if (denied.has(id)) { events.push(`claim-denied:${i.id}:${id}`); throw Object.assign(new Error('scene is busy'), { code: 'worktree_busy' }); }
      events.push(`claim:${i.id}:${id}`); const v = views.get(id)!; Object.assign(v, { state: v.state === 'review' ? 'review' : 'doing', currentEmployee: i.id, version: v.version + 1, fence: v.fence + 1 }); v.deliveryId = `d-${id}-${v.fence}`;
      Object.assign(rows.find(t => t.id === id)!, v, { leaseExpiresAt: 2000 }); i.activeTask = id;
      return { task: { ...v }, deliveryId: v.deliveryId, fence: v.fence, leaseExpiresAt: new Date().toISOString(), history: [], worktree: v.worktree }; },
    getTask: async (_c: string, id: string) => ({ ...views.get(id)! }), history: async () => [], authenticate: async () => ({ employeeId: 'fixture', role: 'gm' }),
    companyBrief: async () => ({}), listTasks: async () => [], relayDirection: async () => { events.push('management'); }, heartbeat: async (_c: string, p: LeaseProof) => ({ task: check(p) }),
    submit: async (_c: string, p: LeaseProof) => { const v = check(p); events.push(`submit:${p.taskId}`); v.state = 'done'; v.currentEmployee = undefined; Object.assign(rows.find(t => t.id === v.id)!, v); return v; },
    block: async (_c: string, p: LeaseProof) => { check(p); events.push(`block:${p.taskId}`); return views.get(p.taskId)!; },
    accept: async (_c: string, p: LeaseProof) => { const v = check(p); events.push(`review:${p.taskId}`); return v; },
    // Channel rollback: lease dropped with no reviewer verdict — review stays review, doing goes ready.
    release: async (_c: string, p: LeaseProof) => { const v = check(p); events.push(`release:${p.taskId}`);
      const holder = v.currentEmployee; Object.assign(v, { currentEmployee: undefined, deliveryId: undefined, version: v.version + 1 });
      if (v.state === 'doing') v.state = 'ready';
      Object.assign(rows.find(t => t.id === v.id)!, v);
      const i = instances.find(i => i.id === holder); if (i) i.activeTask = undefined;
      return v; },
    returnTask: async (_c: string, p: LeaseProof) => { const v = check(p); events.push(`return:${p.taskId}`);
      Object.assign(v, { state: 'ready', currentEmployee: undefined, deliveryId: undefined, version: v.version + 1 });
      Object.assign(rows.find(t => t.id === v.id)!, v); return v; },
  };
  const ops = { tools: ['ops_info'], call: async () => { events.push('ops'); return {}; }, release: (id: string) => { events.push(`ops-release:${id}`); } };
  const makePool = () => new SidecarPool({ core: core as unknown as CompanyCore, workforce: wf as unknown as SidecarDeps['workforce'], ops, runDir: root, sweepMs: 5, heartbeatMs: 1000000 });
  let pool = makePool();
  const paseo: PaseoGateway = {
    list: async () => agents, status: async id => agents.get(id) ? { status: agents.get(id)!.status, pendingPermissions: 0 } : undefined,
    lastError: async () => '', logsTail: async () => 'fixture transcript', lastInputTokens: async () => 0,
    spawn: async b => { const id = `agent-${b.labels.employee_id}`; agents.set(id, { id, status: 'running' }); envs.set(id, b.env); cwds.set(id, b.cwd); events.push(`spawn:${id}`); return id; },
    send: async id => { events.push(`send:${id}`); agents.get(id)!.status = 'running'; }, stop: async id => { events.push(`stop:${id}`); agents.get(id)!.status = 'idle'; },
    archive: async id => { events.push(`archive:${id}`); agents.get(id)!.status = 'archived'; pool.detachAgent(id); },
    listWorkspaces: async () => [], listProjects: async () => [], archiveWorkspace: async () => {}, deleteProject: async () => {},
  };
  let host = { freeMemMb: 8192, freeDiskMb: 65536 };
  const dispatcher = () => new Dispatcher({ workforce: wf as unknown as Workforce, owner: owner as unknown as OwnerDesk, paseo, sidecar: pool,
    env: { opsRepo: '/fixture', sckBin: '/bin/sck', paseoBin: '/bin/paseo' }, rand: () => 0, hostResources: () => host });
  const relay = async (env: Record<string, string>, tool: string, args: Record<string, unknown> = {}) => {
    const name = `${++request}.json`, dir = env.SCK_COMM_DIR!;
    writeFileSync(join(reqDir(dir), name), JSON.stringify({ key: env.SCK_COMM_KEY, tool, args }));
    for (let n = 0; n < 100 && !existsSync(join(resDir(dir), name)); n++) await Bun.sleep(5);
    const r = readJsonFile<{ ok: boolean; error?: string }>(join(resDir(dir), name)); if (!r) throw new Error('relay timeout'); return r;
  };
  cleanup.push(() => { for (const i of instances) if (i.paseoAgentId) pool.detachAgent(i.paseoAgentId); rmSync(root, { recursive: true, force: true }); });
  return { addTask, dispatcher, def, notices, instances, rows, agents, envs, cwds, events, views, relay, denied, authorsOf, paseo, get pool() { return pool; },
    setNow: (v: number) => { now = v; },
    setHost: (v: { freeMemMb: number; freeDiskMb: number }) => { host = v; },
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
  test('review claim on a stale-cwd session releases silently and respawns into the worktree', async () => {
    const w = world();
    // A free, reusable engineering session anchored to the repo's shared tree.
    const stale = { id: 'employee-9', def: 'test', role: 'engineering', provider: 'codex', model: 'fixture',
      credential: 'fixture-9', cwd: '/repo', repoHome: '/repo' } as EmployeeInst;
    w.instances.push(stale);
    w.pool.env(stale); w.pool.bindAgent(stale.id, 'agent-9'); stale.paseoAgentId = 'agent-9';
    w.agents.set('agent-9', { id: 'agent-9', status: 'idle' });
    // A review task whose registered scene is the task's exclusive worktree.
    w.addTask('t1', { state: 'review', submittedBy: 'employee-77', worktreePath: '/repo-task-t1' });
    const r = await w.dispatcher().tick();
    // Channel rollback is not a reviewer verdict: a release, never a return.
    expect(w.events).toContain('claim:employee-9:t1');
    expect(w.events).toContain('release:t1');
    expect(w.events.some(e => e.startsWith('return:'))).toBe(false);
    // The mismatched session retired and the same tick spawned a reviewer into the worktree.
    expect(r.retired).toContain('employee-9');
    const inst = w.instances.find(i => i.id !== 'employee-9')!;
    expect(w.events).toContain(`claim:${inst.id}:t1`);
    // Home-bound spawn: the session parks on the instance's private comm dir so
    // scene reclaim can never cascade-kill it; the worktree arrives via claim.json.
    expect(w.cwds.get(inst.paseoAgentId!)).toBe(w.pool.commDirFor(inst.id));
    // The task stayed in review and is now held by the spawned reviewer.
    expect(w.views.get('t1')!.state).toBe('review');
    expect(w.views.get('t1')!.currentEmployee).toBe(inst.id);
  });
  test('a home-bound session wakes on a different worktree instead of retiring', async () => {
    const w = world();
    // A free session parked on its private comm dir — the shape bind() now records.
    const home = { id: 'employee-9', def: 'test', role: 'engineering', provider: 'codex', model: 'fixture',
      credential: 'fixture-9', repoHome: '/repo' } as EmployeeInst;
    home.cwd = w.pool.commDirFor(home.id);
    w.instances.push(home);
    w.pool.env(home); w.pool.bindAgent(home.id, 'agent-9'); home.paseoAgentId = 'agent-9';
    w.agents.set('agent-9', { id: 'agent-9', status: 'idle' });
    // Its new task lives on a tree the session has never seen — that is the normal case.
    w.addTask('t1', { state: 'ready', worktreePath: '/repo-task-t1' });
    const r = await w.dispatcher().tick();
    expect(w.events).toContain('claim:employee-9:t1');
    expect(w.events).toContain('send:agent-9');
    expect(r.retired).not.toContain('employee-9');
    expect(r.woke.map(x => x.employee)).toContain('employee-9');
    expect(w.views.get('t1')!.currentEmployee).toBe('employee-9');
  });
  test('a spawned instance binds its private comm dir as cwd, never the task worktree', async () => {
    const w = world();
    w.addTask('t1', { state: 'ready', worktreePath: '/repo-task-t1' });
    await w.dispatcher().tick();
    const inst = w.instances[0];
    expect(inst.cwd).toBe(w.pool.commDirFor(inst.id));
    expect(inst.repoHome).toBe('/repo');
    // Scene reclaim only ever archives workspaces under the tree — never this one.
    expect(inst.cwd!.startsWith('/repo-task-t1')).toBe(false);
  });
  test('releaseClaim on a review-state claim drops the lease without a reviewer return', async () => {
    const w = world();
    const inst = { id: 'employee-9', def: 'test', role: 'engineering', credential: 'fixture-9' } as EmployeeInst;
    w.instances.push(inst);
    w.pool.env(inst);
    w.addTask('t2', { state: 'review', submittedBy: 'employee-77' });
    const claim = await w.pool.claim(inst, w.rows[0]!);
    expect(claim?.task.state).toBe('review');
    await w.pool.releaseClaim(inst.id, 't2', '工作区路径变化，换新会话接管登记现场');
    expect(w.events).toContain('release:t2');
    expect(w.events.some(e => e.startsWith('return:'))).toBe(false);
    expect(w.views.get('t2')!.state).toBe('review');
    expect(w.views.get('t2')!.currentEmployee).toBeUndefined();
  });
  test('a real reviewer return still records a return and requeues the task', async () => {
    const w = world();
    const inst = { id: 'employee-9', def: 'test', role: 'engineering', credential: 'fixture-9' } as EmployeeInst;
    w.instances.push(inst);
    const env = w.pool.env(inst);
    w.addTask('t3', { state: 'review', submittedBy: 'employee-77' });
    await w.pool.claim(inst, w.rows[0]!);
    const r = await w.relay(env, 'review', { decision: 'return', text: '验收退回：fixture 复核不通过的原因说明' });
    expect(r.ok).toBe(true);
    expect(w.events).toContain('return:t3');
    expect(w.views.get('t3')!.state).toBe('ready');
  });
  test('a task-side claim denial cools the task instead of churning disposable instances', async () => {
    const w = world(); w.addTask('jammed'); w.denied.add('jammed');
    const d = w.dispatcher();
    const r1 = await d.tick();
    // First attempt spawned one instance, was refused, retired it.
    expect(w.events.filter(e => e.startsWith('claim-denied:'))).toHaveLength(1);
    expect(w.instances).toHaveLength(1);
    expect(r1.retired).toContain(w.instances[0]!.id);
    // Same version while cooled: no new instance, no new claim attempt.
    await d.tick(); await d.tick();
    expect(w.events.filter(e => e.startsWith('claim-denied:'))).toHaveLength(1);
    expect(w.instances).toHaveLength(1);
    // A version bump re-arms the task: the next tick retries the claim.
    w.views.get('jammed')!.version += 1; w.rows[0]!.version += 1;
    await d.tick();
    expect(w.events.filter(e => e.startsWith('claim-denied:'))).toHaveLength(2);
    expect(w.instances).toHaveLength(2);
    // Once the refusal clears the very next attempt claims and spawns normally.
    w.denied.delete('jammed');
    w.views.get('jammed')!.version += 1; w.rows[0]!.version += 1;
    await d.tick();
    expect(w.events.some(e => e.startsWith('claim:'))).toBe(true);
    expect(w.agents.size).toBe(1);
  });
  test('an idle holder past stallMinutes loses the lease — the heartbeat cannot squat the task', async () => {
    const w = world(); w.addTask('parked'); const d = w.dispatcher(); await d.tick();
    const inst = w.instances[0]!;
    expect(w.events).toContain(`claim:${inst.id}:parked`);
    // The claimer's turn ended mid-claim (e.g. parked on a permission prompt): the
    // sidecar heartbeat keeps the server lease fresh, so `expired` never fires.
    w.agents.get(inst.paseoAgentId!)!.status = 'idle';
    w.rows[0]!.progressAt = 1000;
    await d.tick(); // fresh progress: idle grace is not a stall
    expect(w.events).not.toContain('revoke:parked');
    w.setNow(1000 + 91 * 60);
    const r = await d.tick();
    expect(w.events).toContain('revoke:parked');
    // The idle session survives and is re-dispatched with the handover packet —
    // reclaim frees the claim, it does not retire the instance.
    expect(r.retired).not.toContain(inst.id);
    expect(w.events.filter(e => e === `claim:${inst.id}:parked`).length).toBeGreaterThan(1);
  });
  test('a busy holder past stallMinutes is still stopped and revoked', async () => {
    const w = world(); w.addTask('stuck'); const d = w.dispatcher(); await d.tick();
    const inst = w.instances[0]!;
    w.rows[0]!.progressAt = 1000;
    w.setNow(1000 + 91 * 60);
    await d.tick();
    expect(w.events).toContain(`stop:${inst.paseoAgentId}`);
    expect(w.events).toContain('revoke:stuck');
  });
  test('host below the free floors pauses all dispatch until water returns', async () => {
    const w = world(); w.addTask('queued');
    w.setHost({ freeMemMb: 128, freeDiskMb: 65536 });
    const d = w.dispatcher();
    const r = await d.tick();
    expect(r.skipped).toBe('resources');
    expect(r.notices).toContain('resources');
    expect(w.events.filter(e => e.startsWith('spawn:') || e.startsWith('claim:'))).toHaveLength(0);
    // Disk under the floor gates the same way.
    w.setHost({ freeMemMb: 8192, freeDiskMb: 128 });
    expect((await d.tick()).skipped).toBe('resources');
    // Water back above the floor: the next tick dispatches normally.
    w.setHost({ freeMemMb: 8192, freeDiskMb: 65536 });
    await d.tick();
    expect(w.events.some(e => e.startsWith('claim:'))).toBe(true);
  });
  test('dispatch-blocked notice names a track-mismatched def as 岗位轨不匹配, not a spawn failure', async () => {
    const w = world();
    w.def.tracks = ['角色设计'];
    w.addTask('synth', { discipline: '合成' });
    const r = await w.dispatcher().tick();
    expect(r.notices).toContain('dispatch-blocked:synth:execute');
    const text = w.notices.get('dispatch-blocked:synth:execute')!;
    expect(text).toContain('岗位轨不匹配');
    expect(text).not.toContain('可新开但唤醒/创建失败');
    // A task whose discipline the def covers still dispatches — the gate is the track only.
    w.addTask('chars', { discipline: '角色设计' });
    await w.dispatcher().tick();
    expect(w.events.some(e => e === 'claim:employee-1:chars')).toBe(true);
  });
  test('an archived session is a trusted normal end: retired as archive, not failure (FV06)', async () => {
    const w = world(); w.addTask('archived'); const d = w.dispatcher(); await d.tick();
    const inst = w.instances[0]!;
    // The real archive entry: Paseo soft-deletes the session and the plugin listener
    // detaches the launch binding — the next tick sees a lost binding and must consult
    // the Paseo-reported archived status instead of assuming a broken session.
    await w.paseo.archive(inst.paseoAgentId!);
    await d.tick();
    expect(w.events).toContain(`retire:${inst.id}:archive`);
    expect(w.events).not.toContain(`retire:${inst.id}:failure`);
  });
  test('a crashed or isolated session still retires as failure (FV06 fail closed)', async () => {
    const w = world(); w.addTask('crashed'); const d = w.dispatcher(); await d.tick();
    const inst = w.instances[0]!;
    w.agents.get(inst.paseoAgentId!)!.status = 'error';
    await d.tick();
    expect(w.events).toContain(`retire:${inst.id}:failure`);
    // A launch binding lost without the archived signal is real channel isolation.
    const w2 = world(); w2.addTask('isolated'); const d2 = w2.dispatcher(); await d2.tick();
    const inst2 = w2.instances[0]!;
    w2.pool.detachAgent(inst2.paseoAgentId!);
    await d2.tick();
    expect(w2.events).toContain(`retire:${inst2.id}:failure`);
  });
});

describe('R1: review capacity before an engineering execute claim', () => {
  // Two idle engineers fill both seats of the fixture def.
  const twoEngineers = (w: ReturnType<typeof world>) => {
    for (const [id, agent] of [['employee-8', 'agent-8'], ['employee-9', 'agent-9']] as const) {
      const inst = { id, def: 'test', role: 'engineering', provider: 'codex', model: 'fixture', credential: `fixture-${id}` } as EmployeeInst;
      w.instances.push(inst); w.pool.env(inst); w.pool.bindAgent(id, agent); inst.paseoAgentId = agent;
      w.agents.set(agent, { id: agent, status: 'idle' });
    }
  };
  test('a single engineering seat holds the claim: no independent reviewer exists after it', async () => {
    const w = world(); w.def.maxInstances = 1; w.addTask('solo');
    const r = await w.dispatcher().tick();
    expect(r.woke).toHaveLength(0);
    expect(w.instances).toHaveLength(0);
    expect(w.events.some(e => e.startsWith('claim:') || e.startsWith('spawn:'))).toBe(false);
    expect(r.notices).toContain('dispatch-blocked:solo:execute');
    expect(w.notices.get('dispatch-blocked:solo:execute')).toContain('后续独立复核缺合格人选');
  });
  test('a spare seat keeps the claim: the implementer takes one seat and a second stays free for review', async () => {
    const w = world(); w.addTask('spare');
    await w.dispatcher().tick();
    expect(w.events).toContain('claim:employee-1:spare');
    expect(w.views.get('spare')!.currentEmployee).toBe('employee-1');
  });
  test('a reserved reviewer is never picked to implement the task', async () => {
    const w = world(); twoEngineers(w); w.addTask('held');
    const r = await w.dispatcher().tick();
    const reserved = r.decisions.find(d => d.startsWith('reserve:held='))?.split('=')[1];
    const claimed = w.events.find(e => e.startsWith('claim:') && e.endsWith(':held'))?.split(':')[1];
    expect(reserved).toBeDefined();
    expect(claimed).toBeDefined();
    expect(claimed).not.toBe(reserved);
    expect(w.views.get('held')!.currentEmployee).toBe(claimed);
  });
  test('an author may implement a rework, and the reserved reviewer is the other engineer', async () => {
    const w = world(); twoEngineers(w); w.addTask('rework'); w.authorsOf.set('rework', ['employee-8']);
    const r = await w.dispatcher().tick();
    expect(w.events).toContain('claim:employee-8:rework');
    expect(r.decisions).toContain('reserve:rework=employee-9');
  });
});
