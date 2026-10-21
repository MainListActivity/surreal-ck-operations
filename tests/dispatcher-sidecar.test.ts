import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Dispatcher } from '../src/dispatcher/dispatcher.ts';
import type { PaseoGateway } from '../src/dispatcher/paseo.ts';
import { DEFAULT_CONFIG, type EmployeeInst, type EmployeeDef, type ProviderHealth, type SupervisedTask, type Workforce } from '../src/workforce.ts';
import type { CompanyCore, ProviderQuota, TaskView, LeaseProof, WriteScopeHolder } from '../src/contracts.ts';
import { overlap } from '../src/dispatcher/worktree-registry.ts';
import type { OwnerDesk } from '../src/owner.ts';
import type { SidecarDeps } from '../plugin/server/sidecar.ts';
import { SidecarPool } from '../plugin/server/sidecar.ts';
import { readJsonFile, reqDir, resDir, reportPath, blockerPath } from '../src/comm.ts';
import type { ArtifactReclaimResult } from '../src/dispatcher/artifact-sweeper.ts';
import type { ArtifactTrigger } from '../src/dispatcher/artifact-reclaim.ts';
const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); });
function world(role: EmployeeDef['role'] = 'engineering') {
  const root = mkdtempSync(join(tmpdir(), 'dispatch-comm-'));
  const instances: EmployeeInst[] = [], rows: SupervisedTask[] = [];
  const views = new Map<string, TaskView>(), agents = new Map<string, { id: string; status: string; model?: string }>();
  const envs = new Map<string, Record<string, string>>(), events: string[] = [], retired = new Set<string>();
  const logs: string[] = [];
  const cwds = new Map<string, string>(), wtPaths = new Map<string, string>(), denied = new Map<string, string>();
  // Write scopes another writer holds right now, and tasks whose scope cannot be read (SYS-DISP R1): the preflight sees both.
  const held = new Set<string>(), scopeUnreadable = new Set<string>();
  // Authorised asset directories per task, and live assets holds of other writers: the registry's own overlap rule decides (B1).
  const assetPaths = new Map<string, string[]>(), assetHolds: Array<{ paths: string[]; holder: WriteScopeHolder }> = [];
  const authorsOf = new Map<string, string[]>();
  // Tasks whose audit history cannot be read right now (R3 replay): the read throws until the test clears the entry.
  const unreadable = new Set<string>();
  // Two seats: an independent reviewer other than the implementer needs a second engineer, so the fixture keeps a spare seat (R1).
  const def: EmployeeDef = { id: 'test', role, provider: 'codex', model: 'fixture', enabled: true, maxInstances: 2, priority: 0, weight: 1, scored: 0, errorStreak: 0 };
  let next = 0, request = 0, now = 1000;
  const addTask = (id: string, opts: { state?: TaskView['state']; submittedBy?: string; worktreePath?: string; discipline?: string; assets?: string[] } = {}) => {
    if (opts.assets) assetPaths.set(id, opts.assets);
    const v: TaskView = { id, title: id, context: '', state: opts.state ?? 'ready', executorRole: 'engineering', reviewerRole: 'engineering',
      kind: 'task', dependencies: [], version: 1, fence: 0, submittedBy: opts.submittedBy, discipline: opts.discipline };
    if (opts.worktreePath) {
      wtPaths.set(id, opts.worktreePath);
      v.worktree = { id: `wt-${id}`, repo: '/repo', worktreePath: opts.worktreePath, mode: 'exclusive', intent: { kind: 'code' }, discipline: '' };
    }
    views.set(id, v); rows.push({ ...v, row: {}, evalAttempts: 0, repoPath: opts.worktreePath ? '/repo' : undefined } as unknown as SupervisedTask); };
  /** Per-test config overrides; the breaker floors stay 0 unless a test asks for them. */
  let cfgOverride: Partial<typeof DEFAULT_CONFIG> = {};
  const wf = {
    config: async () => ({ ...DEFAULT_CONFIG, quotaFloorPct: 0, quotaWeeklyFloorPct: 0, sessionMaxWakes: 0, sessionMaxInputK: 0, evalEnabled: false, jevDecisions: false, ...cfgOverride }),
    defs: async () => [def], serverNow: async () => now, insts: async () => instances.filter(i => !retired.has(i.id)), tasks: async () => rows,
    providerHealth: async () => health, lastDispatch: async () => undefined, recordDispatch: async () => {}, touchWake: async () => {}, defHealthy: async () => {},
    markExhausted: async (provider: string, _error: string, resetsAt?: number) => {
      events.push(`exhausted:${provider}`);
      health = new Map(health).set(provider, { provider, state: 'exhausted', until: resetsAt ?? now + 1800, failures: 1 });
      return health.get(provider)!; },
    markHealthy: async (provider: string) => { events.push(`healthy:${provider}`); health = new Map(health).set(provider, { provider, state: 'healthy', failures: 0 }); },
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
    contributors: async (taskId: string) => {
      if (unreadable.has(taskId)) throw new Error('audit history unreadable');
      return { authors: [], reviewers: [], unknown: [], ambiguous: false, excluded: authorsOf.get(taskId) ?? [] };
    },
    setDispatchBlock: async (id: string, phase?: string, since?: number) => {
      Object.assign(rows.find(t => t.id === id)!, { dispatchBlockedPhase: phase, dispatchBlockedSince: since });
    },
  };
  const notices = new Map<string, string>();
  const owner = { applyPending: async () => [], resolveNotice: async (key: string) => { notices.delete(key); },
    openNotices: async () => [...notices].map(([key, text]) => ({ key, text, at: '' })), triagePending: async () => [],
    raiseNotice: async (key: string, text: string) => { notices.set(key, text); return true; } };
  const check = (p: LeaseProof) => { const v = views.get(p.taskId)!; if (v.deliveryId !== p.deliveryId || v.fence !== p.fence || v.version !== p.expectedVersion) throw Object.assign(new Error('stale lease'), { code: 'stale_lease' }); return v; };
  const core = {
    writeScopeOf: async (id: string) => {
      if (scopeUnreadable.has(id)) throw new Error('write scope unreadable');
      const need = assetPaths.get(id) ?? [];
      const overlapping = assetHolds.filter(h => h.paths.some(a => need.some(b => overlap(a, b))));
      if (overlapping.length) return overlapping.map(h => h.holder);
      return held.has(id) ? [{ taskId: 'writer-1', employee: 'employee-7', intent: 'code' }] : [];
    },
    claim: async (cred: string, id: string) => { const i = instances.find(i => i.credential === cred || cred === `rotated-${i.id}`)!;
      const refusal = denied.get(id);
      if (refusal) { events.push(`claim-denied:${i.id}:${id}`); throw Object.assign(new Error(`refused: ${refusal}`), { code: refusal }); }
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
    lastError: async () => lastError, logsTail: async () => 'fixture transcript', lastInputTokens: async () => 0,
    spawn: async b => { const id = `agent-${b.labels.employee_id}`; agents.set(id, { id, status: 'running' }); envs.set(id, b.env); cwds.set(id, b.cwd); events.push(`spawn:${id}`); return id; },
    send: async id => { events.push(`send:${id}`); agents.get(id)!.status = 'running'; }, stop: async id => { events.push(`stop:${id}`); agents.get(id)!.status = 'idle'; },
    reload: async id => { events.push(`reload:${id}`); agents.get(id)!.status = 'idle'; },
    archive: async id => { events.push(`archive:${id}`); agents.get(id)!.status = 'archived'; pool.detachAgent(id); },
    listWorkspaces: async () => [], listProjects: async () => [], archiveWorkspace: async () => {}, deleteProject: async () => {},
  };
  let host = { freeMemMb: 8192, freeDiskMb: 65536 };
  /** Provider health the dispatcher reads; a test sets it to put a provider in (or past) cooldown. */
  let health = new Map<string, ProviderHealth>();
  /** What Paseo reports as the session's last error; empty unless a test sets it. */
  let lastError = '';
  // Artifact reclaim seam for the resource-gate tests; absent by default so the
  // existing gate test keeps exercising the "no reclaim wired" path.
  type ReclaimInput = { trigger?: ArtifactTrigger; targetFreeMb?: number; dryRun?: boolean; taskId?: string; emergency?: boolean };
  let reclaim: ((input?: ReclaimInput) => Promise<ArtifactReclaimResult>) | undefined;
  /** Realign seam: absent by default, so the "no realign path" behaviour is the default too. */
  type RealignFn = (agentId: string, model: string) => Promise<boolean>;
  let realign: RealignFn | undefined;
  /** Quota snapshot the breaker and the pre-warning read; empty unless a test sets one. */
  let quotaRows: ProviderQuota[] = [];
  const dispatcher = () => new Dispatcher({ workforce: wf as unknown as Workforce, owner: owner as unknown as OwnerDesk, paseo, sidecar: pool,
    env: { opsRepo: '/fixture', sckBin: '/bin/sck', paseoBin: '/bin/paseo' }, rand: () => 0, hostResources: () => host,
    log: (message: string) => { logs.push(message); },
    ...(reclaim ? { reclaimArtifacts: (input?: ReclaimInput) => reclaim!(input) } : {}),
    ...(realign ? { realignAgent: (agentId: string, model: string) => realign!(agentId, model) } : {}),
    quota: async () => quotaRows });
  const relay = async (env: Record<string, string>, tool: string, args: Record<string, unknown> = {}) => {
    const name = `${++request}.json`, dir = env.SCK_COMM_DIR!;
    writeFileSync(join(reqDir(dir), name), JSON.stringify({ key: env.SCK_COMM_KEY, tool, args }));
    for (let n = 0; n < 100 && !existsSync(join(resDir(dir), name)); n++) await Bun.sleep(5);
    const r = readJsonFile<{ ok: boolean; error?: string }>(join(resDir(dir), name)); if (!r) throw new Error('relay timeout'); return r;
  };
  cleanup.push(() => { for (const i of instances) if (i.paseoAgentId) pool.detachAgent(i.paseoAgentId); rmSync(root, { recursive: true, force: true }); });
  return { addTask, dispatcher, def, notices, instances, rows, agents, envs, cwds, events, logs, views, relay, denied, held, scopeUnreadable,
    holdAssets: (paths: string[], holder: WriteScopeHolder) => { assetHolds.push({ paths, holder }); }, freeAssets: () => { assetHolds.splice(0); },
    authorsOf, unreadable, paseo, get pool() { return pool; },
    setNow: (v: number) => { now = v; },
    setHost: (v: { freeMemMb: number; freeDiskMb: number }) => { host = v; },
    setReclaim: (fn: typeof reclaim) => { reclaim = fn; },
    setRealign: (fn: typeof realign) => { realign = fn; },
    setQuota: (rows: ProviderQuota[]) => { quotaRows = rows; },
    setConfig: (v: Partial<typeof DEFAULT_CONFIG>) => { cfgOverride = v; },
    setHealth: (rows: Map<string, ProviderHealth>) => { health = rows; },
    setLastError: (text: string) => { lastError = text; },
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
  test('a generic claim refusal cools the task instead of churning disposable instances (write scope is no cooldown, see R1)', async () => {
    const w = world(); w.addTask('jammed'); w.denied.set('jammed', 'forbidden');
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

  test('gate reclaims terminal artifacts first and dispatches in the same tick', async () => {
    const w = world(); w.addTask('queued');
    w.setHost({ freeMemMb: 8192, freeDiskMb: 128 });
    let seen: { emergency?: boolean; targetFreeMb?: number } | undefined;
    w.setReclaim(async input => {
      seen = input as { emergency?: boolean; targetFreeMb?: number };
      // Reclaim freed real blocks: the probe the dispatcher re-reads must see them.
      w.setHost({ freeMemMb: 8192, freeDiskMb: 65536 });
      return { runId: 'run-1', trigger: 'pressure', dryRun: false, mode: 'pressure',
        trimmed: [{ kind: 'evidence', taskId: 'old', reason: 'disk-pressure', removedFiles: 3, removedBytes: 1024,
          keptFiles: 0, keptBytes: 0, errors: 0, partial: false }],
        skipped: {}, removedFiles: 3, freedBytes: 1024, truncated: false, errors: 0,
        freeDiskMbBefore: 128, freeDiskMbAfter: 65536 };
    });
    const r = await w.dispatcher().tick();
    expect(seen?.emergency).toBe(true);
    expect(seen?.targetFreeMb).toBeGreaterThan(0);
    expect(r.skipped).toBeUndefined();
    expect(r.reclaimed?.tasks).toBe(1);
    expect(w.events.some(e => e.startsWith('claim:'))).toBe(true);
  });

  test('gate with reclaim disabled by config names the switch and blocks', async () => {
    const w = world(); w.addTask('queued');
    w.setHost({ freeMemMb: 8192, freeDiskMb: 128 });
    w.setReclaim(async () => ({ runId: 'run-2', trigger: 'pressure', dryRun: false, mode: 'pressure',
      trimmed: [], skipped: {}, removedFiles: 0, freedBytes: 0, truncated: false, errors: 0,
      disabled: true, disabledReason: 'config' }));
    const r = await w.dispatcher().tick();
    expect(r.skipped).toBe('resources');
    expect(r.notices).toContain('resources');
    expect(r.notices).toContain('resources-reclaim-blocked');
    expect(w.notices.get('resources')).toContain('artifact_reclaim_enabled=false');
    expect(w.notices.get('resources-reclaim-blocked')).toContain('artifact_reclaim_enabled=false');
    expect(w.events.some(e => e.startsWith('claim:'))).toBe(false);
  });

  test('gate with the env hard stop points the notice at SCK_ARTIFACT_RECLAIM=0', async () => {
    const w = world(); w.addTask('queued');
    w.setHost({ freeMemMb: 8192, freeDiskMb: 128 });
    w.setReclaim(async () => ({ runId: 'run-3', trigger: 'pressure', dryRun: false, mode: 'pressure',
      trimmed: [], skipped: {}, removedFiles: 0, freedBytes: 0, truncated: false, errors: 0,
      disabled: true, disabledReason: 'env' }));
    const r = await w.dispatcher().tick();
    expect(r.skipped).toBe('resources');
    expect(w.notices.get('resources')).toContain('SCK_ARTIFACT_RECLAIM=0');
    expect(w.notices.get('resources-reclaim-blocked')).toContain('SCK_ARTIFACT_RECLAIM=0');
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

describe('R1: a write scope held by another writer is a verdict, never a spawn churn or a wake failure', () => {
  test('a scope held by another writer waits as write_scope: no spawn, no claim, the holder is named, and the claim follows once it ends', async () => {
    const w = world(); w.addTask('scoped'); w.held.add('scoped');
    const d = w.dispatcher();
    const held = await d.tick();
    expect(held.woke).toHaveLength(0);
    expect(w.instances).toHaveLength(0);
    expect(w.events.some(e => e.startsWith('claim') || e.startsWith('spawn:') || e.startsWith('send:'))).toBe(false);
    const verdict = d.dispatchVerdicts().find(v => v.taskId === 'scoped')!;
    expect(verdict.dispatchable).toBe(false);
    expect(verdict.reasons).toEqual([expect.objectContaining({ code: 'write_scope', owner: 'gm', candidates: ['任务 writer-1 · employee-7'] })]);
    w.setNow(1_300);
    await d.tick();
    const text = w.notices.get('dispatch-blocked:scoped:execute')!;
    expect(text).toContain('同线或重叠目录');
    expect(text).toContain('任务 writer-1 · employee-7');
    expect(text).not.toContain('派工未能唤醒');
    w.held.delete('scoped'); w.setNow(1_360);
    const freed = await d.tick();
    expect(freed.woke.map(x => x.task)).toContain('scoped');
    expect(w.notices.has('dispatch-blocked:scoped:execute')).toBe(false);
  });
  test('a claim refused for the write scope at claim time is write_scope, not wake_failed, and earns no cooldown', async () => {
    const w = world(); w.addTask('raced'); w.denied.set('raced', 'worktree_busy');
    const d = w.dispatcher();
    const lost = await d.tick();
    expect(lost.woke).toHaveLength(0);
    expect(w.events).toContain('claim-denied:employee-1:raced');
    // The seat spawned for the refused claim is released as write scope held, not as a claim denial.
    expect(lost.retired).toEqual(['employee-1']);
    expect(w.events).toContain('retire:employee-1:failure');
    expect(w.notices.has('dispatch-blocked:raced:execute')).toBe(false);
    w.setNow(1_300);
    await d.tick();
    const text = w.notices.get('dispatch-blocked:raced:execute')!;
    expect(text).toContain('同线或重叠目录');
    expect(text).not.toContain('派工未能唤醒');
    // No cooldown: once the refusal clears, the next pass claims without waiting for a version bump.
    w.denied.delete('raced'); w.setNow(1_360);
    const resumed = await d.tick();
    expect(resumed.woke.map(x => x.task)).toContain('raced');
  });
  test('a refused claim on a reused seat keeps the seat: nothing is spawned or retired', async () => {
    const w = world(); w.addTask('reused'); w.denied.set('reused', 'worktree_busy');
    const inst = { id: 'employee-9', def: 'test', role: 'engineering', provider: 'codex', model: 'fixture', credential: 'fixture-9' } as EmployeeInst;
    w.instances.push(inst); w.pool.env(inst); w.pool.bindAgent(inst.id, 'agent-9'); inst.paseoAgentId = 'agent-9';
    w.agents.set('agent-9', { id: 'agent-9', status: 'idle' });
    const r = await w.dispatcher().tick();
    expect(w.events).toContain('claim-denied:employee-9:reused');
    expect(w.events.some(e => e.startsWith('spawn:'))).toBe(false);
    expect(r.retired).toEqual([]);
    expect(r.woke).toHaveLength(0);
    expect(w.instances).toHaveLength(1);
  });
  test('an unreadable write scope is unknown: never free, never a claim, and the owner reads that the state is undecided', async () => {
    const w = world(); w.addTask('blind'); w.scopeUnreadable.add('blind');
    const r = await w.dispatcher().tick();
    expect(r.woke).toHaveLength(0);
    expect(w.instances).toHaveLength(0);
    expect(w.events.some(e => e.startsWith('claim') || e.startsWith('spawn:'))).toBe(false);
    expect(w.notices.get('dispatch-blocked:blind:execute')).toContain('不能判定');
  });
  test('an assets scope overlapping another writer waits as write_scope: the holder is named to gm, no spawn, no claim, never a wake failure', async () => {
    const w = world(); w.addTask('assets-overlap', { assets: ['docs/brand/logo'] });
    w.holdAssets(['docs/brand'], { taskId: 'asset-w1', employee: 'employee-7', intent: 'assets' });
    const d = w.dispatcher();
    const blocked = await d.tick();
    expect(blocked.woke).toHaveLength(0);
    expect(w.instances).toHaveLength(0);
    expect(w.events.some(e => e.startsWith('claim') || e.startsWith('spawn:'))).toBe(false);
    const verdict = d.dispatchVerdicts().find(v => v.taskId === 'assets-overlap')!;
    expect(verdict).toMatchObject({ dispatchable: false, workflowState: 'ready' });
    expect(verdict.reasons).toEqual([expect.objectContaining({ code: 'write_scope', owner: 'gm', candidates: ['任务 asset-w1 · employee-7'] })]);
    expect(verdict.reasons.some(reason => reason.code === 'wake_failed')).toBe(false);
    w.setNow(1_300);
    await d.tick();
    const text = w.notices.get('dispatch-blocked:assets-overlap:execute')!;
    expect(text).toContain('同线或重叠目录');
    expect(text).toContain('任务 asset-w1 · employee-7');
    expect(text).not.toContain('派工未能唤醒');
    w.freeAssets(); w.setNow(1_360);
    const freed = await d.tick();
    expect(freed.woke.map(x => x.task)).toContain('assets-overlap');
    expect(w.notices.has('dispatch-blocked:assets-overlap:execute')).toBe(false);
  });
  test('an assets scope on a disjoint directory of the same writer is not blocked: the claim proceeds', async () => {
    const w = world(); w.addTask('assets-disjoint', { assets: ['docs/press'] });
    w.holdAssets(['docs/brand'], { taskId: 'asset-w1', employee: 'employee-7', intent: 'assets' });
    const d = w.dispatcher();
    const r = await d.tick();
    expect(r.woke.map(x => x.task)).toContain('assets-disjoint');
    expect(w.events).toContain('claim:employee-1:assets-disjoint');
    expect(d.dispatchVerdicts().some(v => v.taskId === 'assets-disjoint')).toBe(false);
  });
});

describe('R3: repeated ticks, replay, bound repo and recusal capacity', () => {
  // Idle engineers in this fixture's home (or another repo's home), each with its own agent and fixed id.
  const engineers = (w: ReturnType<typeof world>, ids: string[], repoHome?: string) => {
    for (const id of ids) {
      const agent = `agent-${id}`;
      const inst = { id, def: 'test', role: 'engineering', provider: 'codex', model: 'fixture', credential: `fixture-${id}`, repoHome } as EmployeeInst;
      w.instances.push(inst); w.pool.env(inst); w.pool.bindAgent(id, agent); inst.paseoAgentId = agent;
      w.agents.set(agent, { id: agent, status: 'idle' });
    }
  };
  test('ten repeated ticks, with a restart in the middle, keep one blocked episode: no claim, one notice, one persisted start', async () => {
    const w = world(); w.def.maxInstances = 1; w.addTask('ten');
    let d = w.dispatcher();
    const notes = new Set<string>(), starts = new Set<number | undefined>(), texts = new Set<string>();
    for (let n = 0; n < 10; n++) {
      if (n === 5) d = w.dispatcher();
      w.setNow(1_000_000 + n * 60);
      const r = await d.tick();
      expect(r.woke).toHaveLength(0);
      for (const key of r.notices) notes.add(key);
      starts.add(w.rows.find(t => t.id === 'ten')!.dispatchBlockedSince);
      texts.add(w.notices.get('dispatch-blocked:ten:execute')!);
    }
    expect(w.events.filter(e => e.startsWith('claim:') || e.startsWith('spawn:') || e.startsWith('send:'))).toEqual([]);
    expect(w.instances).toHaveLength(0);
    expect([...notes]).toEqual(['dispatch-blocked:ten:execute']);
    expect([...starts]).toEqual([1_000_000]);
    expect(texts.size).toBe(1);
    expect(w.notices.size).toBe(1);
  });
  test('an unreadable contributor history holds the claim as unknown, and the episode clears once the history reads again', async () => {
    const w = world(); w.addTask('replay'); w.unreadable.add('replay');
    const held = await w.dispatcher().tick();
    expect(held.woke).toHaveLength(0);
    expect(w.events.some(e => e.startsWith('claim:') || e.startsWith('spawn:'))).toBe(false);
    expect(w.notices.get('dispatch-blocked:replay:execute')).toContain('状态或贡献者历史读取失败');
    w.unreadable.delete('replay'); w.setNow(1_000_060);
    const resumed = await w.dispatcher().tick();
    expect(resumed.woke.map(x => x.task)).toContain('replay');
    expect(w.events).toContain('claim:employee-1:replay');
    expect(w.notices.has('dispatch-blocked:replay:execute')).toBe(false);
  });
  test('A, B and C all recused with the seats full: no claim, the review capacity root cause is named, and one more seat clears it', async () => {
    const w = world(); w.def.maxInstances = 3; w.addTask('abc');
    const ids = ['employee-8', 'employee-9', 'employee-10'];
    engineers(w, ids);
    w.authorsOf.set('abc', ids);
    const blocked = await w.dispatcher().tick();
    expect(blocked.woke).toHaveLength(0);
    expect(w.events.some(e => e.startsWith('claim:') || e.startsWith('spawn:'))).toBe(false);
    // A full seat can still free up, so the block waits; the owner hears about it once the five-minute threshold passes.
    expect(w.notices.has('dispatch-blocked:abc:execute')).toBe(false);
    w.setNow(1_300);
    const waited = await w.dispatcher().tick();
    expect(waited.notices).toContain('dispatch-blocked:abc:execute');
    expect(w.notices.get('dispatch-blocked:abc:execute')).toContain('后续独立复核缺合格人选');
    w.def.maxInstances = 4; w.setNow(1_360);
    const resumed = await w.dispatcher().tick();
    expect(resumed.woke.map(x => x.task)).toContain('abc');
    expect(w.notices.has('dispatch-blocked:abc:execute')).toBe(false);
  });
  test('a task with no reviewer role cannot prove an independent review: it is blocked as review capacity and never claimed', async () => {
    const w = world(); w.addTask('norole');
    Object.assign(w.rows.find(t => t.id === 'norole')!, { reviewerRole: undefined });
    const r = await w.dispatcher().tick();
    expect(r.woke).toHaveLength(0);
    expect(w.events.some(e => e.startsWith('claim:') || e.startsWith('spawn:'))).toBe(false);
    expect(w.notices.get('dispatch-blocked:norole:execute')).toContain('后续独立复核缺合格人选');
  });
  test('an engineer bound to another repo cannot review this task, so the only seat is not spent on its claim', async () => {
    const w = world(); w.def.maxInstances = 1; w.addTask('bound');
    engineers(w, ['employee-8'], '/other-repo');
    const r = await w.dispatcher().tick();
    expect(r.woke).toHaveLength(0);
    expect(w.instances).toHaveLength(1);
    expect(w.events.some(e => e.startsWith('claim:') || e.startsWith('spawn:'))).toBe(false);
    expect(w.notices.get('dispatch-blocked:bound:execute')).toContain('后续独立复核缺合格人选');
  });
  test('a failed Paseo spawn releases the claim and retires the seat as a failure, waits as wake_failed, and clears on the next good pass', async () => {
    const w = world(); w.addTask('spawnfail');
    const spawn = w.paseo.spawn;
    w.paseo.spawn = async () => { throw new Error('paseo daemon unreachable'); };
    const failed = await w.dispatcher().tick();
    expect(failed.woke).toHaveLength(0);
    expect(failed.retired).toContain('employee-1');
    expect(w.events).toContain('retire:employee-1:failure');
    expect(w.rows.find(t => t.id === 'spawnfail')!.currentEmployee).toBeUndefined();
    // Spawn failures are not material at once: the owner hears about them after the five-minute threshold.
    expect(w.notices.has('dispatch-blocked:spawnfail:execute')).toBe(false);
    w.setNow(1_300);
    const again = await w.dispatcher().tick();
    expect(again.notices).toContain('dispatch-blocked:spawnfail:execute');
    expect(w.notices.get('dispatch-blocked:spawnfail:execute')).toContain('派工未能唤醒或创建会话');
    w.paseo.spawn = spawn; w.setNow(1_360);
    const recovered = await w.dispatcher().tick();
    expect(recovered.woke.map(x => x.task)).toContain('spawnfail');
    expect(w.notices.has('dispatch-blocked:spawnfail:execute')).toBe(false);
  });
  test('a same-role engineer of another repo is never woken: the target repo takes its own legal seat (R3 hard filter)', async () => {
    const w = world(); w.def.maxInstances = 2; w.addTask('local');
    engineers(w, ['employee-8'], '/other-repo');
    const r = await w.dispatcher().tick();
    expect(r.woke.map(x => x.task)).toContain('local');
    expect(w.events).toContain('claim:employee-1:local');
    expect(w.events.some(e => e.includes('employee-8'))).toBe(false);
  });
  test('a zero-candidate verdict names the other-repo engineers it left out, while its reasons stay in this repo', async () => {
    const w = world(); w.def.maxInstances = 1; w.addTask('home-busy');
    Object.assign(w.rows.find(t => t.id === 'home-busy')!, { reviewerRole: 'owner' });
    engineers(w, ['employee-9']);
    w.agents.set('agent-employee-9', { id: 'agent-employee-9', status: 'running' });
    engineers(w, ['employee-8'], '/other-repo');
    const d = w.dispatcher();
    await d.tick();
    const verdict = d.dispatchVerdicts().find(v => v.taskId === 'home-busy')!;
    expect(verdict.dispatchable).toBe(false);
    expect(verdict.reasons.map(r => r.code)).toEqual(['seat_full', 'session_busy']);
    expect(verdict.reasons.find(r => r.code === 'seat_full')!.text).toContain('仓库 fixture');
    expect(verdict.summary).toContain('另有 1 名同岗位员工属其他仓库，不参与本仓库派工');
    expect(w.events.some(e => e.includes('employee-8'))).toBe(false);
  });
});

// A provider may switch the model under a running subscription on its own: Factory serves a
// cheaper model once its standard allowance is spent and switches back when it recovers. The
// session, its conversation and its seat all stay valid, so the pass realigns the model in place
// instead of retiring the employee and losing its context.
describe('R4: provider model drift is realigned in place, never a retirement', () => {
  const driftedSession = (w: ReturnType<typeof world>) => {
    const drifted = { id: 'employee-9', def: 'test', role: 'engineering', provider: 'codex', model: 'fixture',
      credential: 'fixture-9', cwd: '/repo', repoHome: '/repo' } as EmployeeInst;
    w.instances.push(drifted);
    w.pool.env(drifted);
    w.pool.bindAgent(drifted.id, 'agent-9');
    drifted.paseoAgentId = 'agent-9';
    // Paseo reports what the session actually serves, which is no longer what the def asks for.
    w.agents.set('agent-9', { id: 'agent-9', status: 'idle', model: 'cheap-model' });
    return drifted;
  };

  test('the session is put back on its definition model and keeps its seat', async () => {
    const w = world();
    driftedSession(w);
    const calls: Array<[string, string]> = [];
    w.setRealign(async (agentId, model) => { calls.push([agentId, model]); return true; });
    const r = await w.dispatcher().tick();
    expect(calls).toEqual([['agent-9', 'fixture']]);
    expect(r.realigned).toContain('employee-9');
    expect(r.retired).not.toContain('employee-9');
    expect(w.events.some(e => e.startsWith('retire:employee-9'))).toBe(false);
    expect(w.agents.get('agent-9')!.status).not.toBe('archived');
  });

  test('with no realign path the session is left for the next pass, not retired', async () => {
    const w = world();
    driftedSession(w);
    const r = await w.dispatcher().tick();
    expect(r.realigned).toEqual([]);
    expect(r.retired).not.toContain('employee-9');
    expect(w.events.some(e => e.startsWith('retire:employee-9'))).toBe(false);
    expect(w.agents.get('agent-9')!.status).toBe('idle');
  });

  test('while the subscription is still out, the drift is left alone instead of retried every pass', async () => {
    const w = world();
    driftedSession(w);
    // Factory keeps serving its fallback model until the allowance resets: realigning now cannot take effect.
    w.setHealth(new Map([['codex', { provider: 'codex', state: 'exhausted', until: 5000, failures: 1 }]]));
    const calls: string[] = [];
    w.setRealign(async agentId => { calls.push(agentId); return true; });
    const r = await w.dispatcher().tick();
    expect(calls).toEqual([]);
    expect(r.realigned).toEqual([]);
    expect(r.retired).not.toContain('employee-9');
    expect(w.agents.get('agent-9')!.status).toBe('idle');
  });

  test('the waiting line is written once per drift episode, not on every pass', async () => {
    const w = world();
    driftedSession(w);
    w.setHealth(new Map([['codex', { provider: 'codex', state: 'exhausted', until: 5000, failures: 1 }]]));
    w.setRealign(async () => true);
    const d = w.dispatcher();
    await d.tick();
    await d.tick();
    expect(w.logs.filter(m => m.includes('waits for codex to recover'))).toHaveLength(1);
  });

  test('a session already on its definition model is left alone', async () => {
    const w = world();
    driftedSession(w);
    w.agents.set('agent-9', { id: 'agent-9', status: 'idle', model: 'fixture' });
    const calls: string[] = [];
    w.setRealign(async agentId => { calls.push(agentId); return true; });
    const r = await w.dispatcher().tick();
    expect(calls).toEqual([]);
    expect(r.realigned).toEqual([]);
    expect(r.retired).not.toContain('employee-9');
  });
});

// The breaker stops dispatch only at the floor; the owner should hear about a subscription that
// is nearly spent while there is still time to top it up.
describe('R4: a nearly spent subscription warns before it stops the company', () => {
  test('a subscription under the warning line raises one notice', async () => {
    const w = world();
    w.setQuota([{ provider: 'codex', summary: 'Weekly 剩余 10%', weeklyPct: 10, sessionPct: 50, fetchedAt: new Date().toISOString() }]);
    const r = await w.dispatcher().tick();
    expect(r.notices).toContain('quota-warn:codex');
    expect(w.notices.get('quota-warn:codex')).toContain('10%');
  });

  test('the warning clears once the subscription recovers', async () => {
    const w = world();
    w.setQuota([{ provider: 'codex', summary: 'Weekly 剩余 10%', weeklyPct: 10, fetchedAt: new Date().toISOString() }]);
    await w.dispatcher().tick();
    expect(w.notices.has('quota-warn:codex')).toBe(true);
    w.setQuota([{ provider: 'codex', summary: 'Weekly 剩余 90%', weeklyPct: 90, fetchedAt: new Date().toISOString() }]);
    await w.dispatcher().tick();
    expect(w.notices.has('quota-warn:codex')).toBe(false);
  });

  test('a stale snapshot raises no warning, and clears one built on older data', async () => {
    const w = world();
    w.setQuota([{ provider: 'codex', summary: 'Weekly 剩余 10%', weeklyPct: 10, fetchedAt: new Date().toISOString() }]);
    await w.dispatcher().tick();
    expect(w.notices.has('quota-warn:codex')).toBe(true);
    // Twenty minutes later the row says the same thing, but nobody verified it since: the breaker
    // already fails open on stale snapshots, and the owner must not be warned from one either.
    const stale = new Date(Date.now() - 20 * 60_000).toISOString();
    w.setQuota([{ provider: 'codex', summary: 'Weekly 剩余 10%', weeklyPct: 10, fetchedAt: stale }]);
    await w.dispatcher().tick();
    expect(w.notices.has('quota-warn:codex')).toBe(false);
  });

  test('a healthy subscription raises nothing', async () => {
    const w = world();
    w.setQuota([{ provider: 'codex', summary: 'Weekly 剩余 90%', weeklyPct: 90, fetchedAt: new Date().toISOString() }]);
    const r = await w.dispatcher().tick();
    expect(r.notices.filter(n => n.startsWith('quota-warn:'))).toEqual([]);
  });
});

// A quota failure parks the session in Paseo's `error` state, and nothing in Paseo leaves that
// state on its own. The dispatcher only dispatches into idle sessions, so without a restart the
// seat stays lost after the subscription recovers — the employee is never retired, but never works
// again either. The session is restarted in place once the cooldown has passed.
describe('R5: a session parked by a quota failure comes back when the window reopens', () => {
  const parkedSession = (w: ReturnType<typeof world>, until: number) => {
    const inst = { id: 'employee-9', def: 'test', role: 'engineering', provider: 'codex', model: 'fixture',
      credential: 'fixture-9', cwd: '/repo', repoHome: '/repo' } as EmployeeInst;
    w.instances.push(inst);
    w.pool.env(inst);
    w.pool.bindAgent(inst.id, 'agent-9');
    inst.paseoAgentId = 'agent-9';
    w.agents.set('agent-9', { id: 'agent-9', status: 'error' });
    w.setLastError('Error: Agent turn ended: model_usage_exhausted[System Error] Internal error: Agent turn ended: model_usage_exhausted');
    w.setHealth(new Map([['codex', { provider: 'codex', state: 'exhausted', until, failures: 1 }]]));
    return inst;
  };

  test('once the cooldown has passed the session is reloaded in place and keeps its seat', async () => {
    const w = world();
    parkedSession(w, 500); // server time is 1000: the window has reopened
    const r = await w.dispatcher().tick();
    expect(w.events).toContain('reload:agent-9');
    expect(r.recovered).toEqual(['employee-9']);
    expect(r.retired).not.toContain('employee-9');
    expect(r.exhausted).toEqual([]);
    expect(w.agents.get('agent-9')!.status).toBe('idle');
  });

  test('while the cooldown still runs the session is left alone', async () => {
    const w = world();
    parkedSession(w, 5000);
    const r = await w.dispatcher().tick();
    expect(w.events.some(e => e.startsWith('reload:'))).toBe(false);
    expect(r.recovered).toEqual([]);
    expect(w.agents.get('agent-9')!.status).toBe('error');
  });

  test('a fresh quota failure still records the cooldown and does not reload', async () => {
    const w = world();
    parkedSession(w, 500);
    w.setHealth(new Map()); // no prior cooldown: this failure is the one that starts it
    const r = await w.dispatcher().tick();
    expect(r.exhausted).toEqual(['codex']);
    expect(w.events).toContain('exhausted:codex');
    expect(w.events.some(e => e.startsWith('reload:'))).toBe(false);
    expect(r.recovered).toEqual([]);
  });
});

// A spent monthly allowance can keep a provider under the floor for days. One line per change
// keeps the plugin log — which only holds the last ~130 lines — readable through the outage.
describe('R4: a persistent quota floor writes one line, not one per tick', () => {
  test('the floor line repeats only when the blocked set changes', async () => {
    const w = world();
    w.setConfig({ quotaFloorPct: 8, quotaWeeklyFloorPct: 2 });
    w.setQuota([{ provider: 'codex', summary: 'Weekly 剩余 0%', weeklyPct: 0, sessionPct: 100, fetchedAt: new Date().toISOString() }]);
    const d = w.dispatcher();
    await d.tick();
    await d.tick();
    expect(w.logs.filter(m => m.startsWith('quota below floor'))).toHaveLength(1);

    w.setQuota([{ provider: 'codex', summary: 'Weekly 剩余 90%', weeklyPct: 90, sessionPct: 90, fetchedAt: new Date().toISOString() }]);
    await d.tick();
    await d.tick();
    expect(w.logs.filter(m => m.startsWith('quota below floor'))).toHaveLength(1);
    expect(w.logs.filter(m => m.startsWith('quota recovered'))).toHaveLength(1);
  });
});
