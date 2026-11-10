import { NativeRuntime } from '../src/runner/native.ts';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
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
import type { HostResources } from '../src/dispatcher/host.ts';
import type { ArtifactTrigger } from '../src/dispatcher/artifact-reclaim.ts';
const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); });
export function world(role: EmployeeDef['role'] = 'engineering') {
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
  const def: EmployeeDef = { id: 'test', role, provider: 'codex', model: 'fixture', enabled: true, maxInstances: 2, priority: 0, weight: 1, errorStreak: 0 };
  let next = 0, request = 0, now = 1000;
  const addTask = (id: string, opts: { state?: TaskView['state']; submittedBy?: string; worktreePath?: string; discipline?: string; assets?: string[] } = {}) => {
    if (opts.assets) assetPaths.set(id, opts.assets);
    const v: TaskView = { id, title: id, context: '', state: opts.state ?? 'ready', executorRole: 'engineering', reviewerRole: 'engineering',
      kind: 'task', version: 1, fence: 0, submittedBy: opts.submittedBy, discipline: opts.discipline };
    if (opts.worktreePath) {
      wtPaths.set(id, opts.worktreePath);
      v.worktree = { id: `wt-${id}`, repo: '/repo', worktreePath: opts.worktreePath, mode: 'exclusive', intent: { kind: 'code' }, discipline: '' };
    }
    views.set(id, v); rows.push({ ...v, row: {}, repoPath: opts.worktreePath ? '/repo' : undefined } as unknown as SupervisedTask); };
  /** Per-test config overrides; the breaker floors stay 0 unless a test asks for them. */
  let cfgOverride: Partial<typeof DEFAULT_CONFIG> = {};
  const attempts = new Map<string, { id: string; employee: string; task?: string; kind: string; agent?: string; message?: string; activationRequired?: boolean; activation_state?: string; binding?: { cwd: string; repoHome?: string; workspaceScope?: string; model?: string } }>();
  const wf = {
    pendingDispatchAttempts: async () => [...attempts.values()],
    recoverDispatchBindings: async () => [] as string[],
    beginDispatchAttempt: async (input: { employee: string; task?: string; kind: string; agent?: string }) => {
      const id = `attempt-${attempts.size + 1}`; attempts.set(id, { id, ...input }); return id;
    },
    acknowledgeDispatchAttempt: async (id: string, agent: string) => { attempts.get(id)!.agent = agent; },
    prepareDispatchActivation: async (id: string, agent: string) => {
      const attempt = attempts.get(id)!;
      await wf.bind(attempt.employee, { ...attempt.binding, agentId: agent, cwd: attempt.binding?.cwd ?? '/fixture' });
      attempt.activation_state = 'calling';
    },
    confirmDispatchActivation: async (id: string) => { attempts.get(id)!.activation_state = 'activated'; },
    finishDispatchAttempt: async (id: string, agent: string) => {
      const attempt = attempts.get(id)!;
      await messages.markSent(attempt.message ?? 'fixture');
      if (attempt.kind === 'spawn') await wf.bind(attempt.employee, { ...attempt.binding, agentId: agent, cwd: attempt.binding?.cwd ?? '/fixture' });
      await wf.touchWake();
      attempts.delete(id);
    },
    config: async () => ({ ...DEFAULT_CONFIG, quotaFloorPct: 0, quotaWeeklyFloorPct: 0, sessionMaxWakes: 0, sessionMaxInputK: 0, jevDecisions: false, ...cfgOverride }),
    defs: async () => [def], serverNow: async () => now, insts: async () => instances.filter(i => !retired.has(i.id)), tasks: async () => rows,
    providerHealth: async () => health, lastDispatch: async () => undefined, recordDispatch: async () => {}, observeSessionIdle: async (observations: Array<{ id: string; since?: number }>) => {
      for (const o of observations) { const i = instances.find(i => i.id === o.id); if (i) i.idleSince = o.since; }
    }, openPendingWakes: async () => [],
    retireIdle: async (inst: EmployeeInst) => { events.push(`retire:${inst.id}:rotation`); retired.add(inst.id); },
    touchWake: async () => {}, defHealthy: async () => {},
    sessionTaskFacts: async () => ({ states: new Map([...views].map(([id, v]) => [id, v.state as string])) }),
    markExhausted: async (provider: string, _error: string, resetsAt?: number) => {
      events.push(`exhausted:${provider}`);
      health = new Map(health).set(provider, { provider, state: 'exhausted', until: resetsAt ?? now + 1800, failures: 1 });
      return health.get(provider)!; },
    markHealthy: async (provider: string) => { events.push(`healthy:${provider}`); health = new Map(health).set(provider, { provider, state: 'healthy', failures: 0 }); },
    defFailure: async () => { events.push('performance-failure'); return 1; },
    spawnInst: async (_def: EmployeeDef, _repoHome?: string, _scope?: string, sessionTask?: string) => { const i: EmployeeInst = { id: `employee-${++next}`, def: def.id, role: def.role, provider: def.provider, model: def.model, credential: `fixture-${next}`, sessionTask }; instances.push(i); return i; },
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
  const sentBodies: Array<{ id: string; body: string }> = [];
  const spawnBodies: string[] = [];
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
      Object.assign(rows.find(t => t.id === id)!, v, { leaseExpiresAt: 2000 }); rows.find(t => t.id === id)!.row.delivery_id = v.deliveryId; i.activeTask = id;
      return { task: { ...v }, deliveryId: v.deliveryId, fence: v.fence, leaseExpiresAt: new Date().toISOString(), history: [], worktree: v.worktree }; },
    getTask: async (_c: string, id: string) => ({ ...views.get(id)! }), history: async () => [], authenticate: async () => ({ employeeId: 'fixture', role: 'owner' }),
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
    spawn: async b => { const id = `agent-${b.labels.employee_id}`; agents.set(id, { id, status: 'running' }); envs.set(id, b.env); cwds.set(id, b.cwd); spawnBodies.push(b.prompt); events.push(`spawn:${id}`); return id; },
    send: async (id, body) => { events.push(`send:${id}`); sentBodies.push({ id, body }); agents.get(id)!.status = 'running'; }, stop: async id => { events.push(`stop:${id}`); agents.get(id)!.status = 'idle'; },
    reload: async id => { events.push(`reload:${id}`); agents.get(id)!.status = 'idle'; },
    archive: async id => { events.push(`archive:${id}`); agents.get(id)!.status = 'archived'; pool.detachAgent(id); },
    listWorkspaces: async () => [], listProjects: async () => [], archiveWorkspace: async () => {}, deleteProject: async () => {},
  };
  let host: HostResources = { freeMemMb: 8192, freeDiskMb: 65536 };
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
  // Translation gate (Dispatcher.translationPending): a task in `waiting` has no ready translation; `aligned` logs each alignment.
  const waiting = new Set<string>(), aligned: string[] = [];
  const messages = {
    prepareSend: async (taskId: string, step: string, employeeId: string) => ({
      body: `fixture ${step} body for ${taskId}`,
      message: { id: `m-${taskId}-${step}`, taskId, step, role: 'x', body: `fixture ${step} body`, state: 'draft', hold: false, createdAt: '' },
    }),
    createDraft: async (taskId: string, step: string, role: string, _code?: boolean, _phase?: string, body?: string) => ({
      id: `d-${taskId}-${step}`, taskId, step, role, body: body ?? `fixture ${step} body`, state: 'draft', hold: false, createdAt: '',
    }),
    ensureDraft: async (taskId: string, step: string, role: string) => ({
      id: `d-${taskId}-${step}`, taskId, step, role, body: `fixture ${step} body`, state: 'draft', hold: false, createdAt: '',
    }),
    isHeld: async () => false,
    alignLanguage: async (taskId: string, step: string, employeeId: string) => { aligned.push(`${taskId}:${step}:${employeeId}`); },
    awaitingTranslation: async (taskId: string) => waiting.has(taskId),
    markSent: async (messageId: string) => { events.push(`markSent:${messageId}`); },
    latestDraft: async () => undefined,
    machineCriterionId: async () => 'AC-1',
    list: async () => [],
    nextStep: async () => 'execute',
  };
  const dispatcher = () => new Dispatcher({ workforce: wf as unknown as Workforce, owner: owner as unknown as OwnerDesk, paseo, sidecar: pool, messages: messages as never,
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
  return { wf, messages, attempts, addTask, dispatcher, def, notices, instances, rows, agents, envs, cwds, events, logs, views, relay, denied, held, scopeUnreadable, sentBodies, spawnBodies, waiting, aligned,
    holdAssets: (paths: string[], holder: WriteScopeHolder) => { assetHolds.push({ paths, holder }); }, freeAssets: () => { assetHolds.splice(0); },
    authorsOf, unreadable, paseo, get pool() { return pool; },
    setNow: (v: number) => { now = v; },
    setHost: (v: HostResources) => { host = v; },
    setReclaim: (fn: typeof reclaim) => { reclaim = fn; },
    setRealign: (fn: typeof realign) => { realign = fn; },
    setQuota: (rows: ProviderQuota[]) => { quotaRows = rows; },
    setConfig: (v: Partial<typeof DEFAULT_CONFIG>) => { cfgOverride = v; },
    setHealth: (rows: Map<string, ProviderHealth>) => { health = rows; },
    setLastError: (text: string) => { lastError = text; },
    restart: async () => { for (const i of instances) if (i.paseoAgentId) pool.detachAgent(i.paseoAgentId); pool = makePool(); await pool.adopt(instances.map(i => ({ ...i, credential: undefined }))); } };
}
describe('lease supervision requires a confirmed runtime stop', () => {
  for (const stopResult of ['throws', 'still-running', 'unknown', 'status-throws'] as const) {
    test(`a stalled holder is not reassigned when stopping ${stopResult}`, async () => {
      const w = world(); w.addTask('stalled'); await w.dispatcher().tick();
      const employee = w.rows[0]!.currentEmployee;
      w.rows[0]!.progressAt = 0; w.setNow(100000);
      w.paseo.stop = async () => {
        if (stopResult === 'throws') throw new Error('stop response lost');
      };
      if (stopResult === 'unknown') w.paseo.status = async () => ({ status: 'unknown', pendingPermissions: 0 });
      if (stopResult === 'status-throws') w.paseo.status = async () => { throw new Error('status unavailable'); };
      // Reconstructing the dispatcher cannot turn an unconfirmed stop into permission to retry.
      for (let n = 0; n < 2; n++) {
        const report = await w.dispatcher().tick();
        expect(report.revoked).toEqual([]);
        expect(w.rows[0]!.currentEmployee).toBe(employee);
      }
      expect(w.events.filter(e => e.startsWith('claim:'))).toHaveLength(1);
      expect(w.spawnBodies).toHaveLength(1);
    });
  }
  test('an expired holder with unknown runtime status keeps its lease and raises an operational notice', async () => {
    const w = world(); w.addTask('unreachable'); await w.dispatcher().tick();
    const employee = w.rows[0]!.currentEmployee;
    w.agents.get(w.instances[0]!.paseoAgentId!)!.status = 'unknown';
    w.rows[0]!.progressAt = 0; w.setNow(100000);
    const report = await w.dispatcher().tick();
    expect(report.revoked).toEqual([]);
    expect(w.rows[0]!.currentEmployee).toBe(employee);
    expect([...w.notices.keys()]).toContain(`runtime-uncertain:${employee}:unreachable`);
    expect(w.events.filter(e => e.startsWith('claim:'))).toHaveLength(1);
  });
  test('a confirmed idle runtime after stop can release the stalled lease', async () => {
    const w = world(); w.addTask('stalled'); await w.dispatcher().tick();
    w.rows[0]!.progressAt = 0; w.setNow(100000);
    await w.dispatcher().tick();
    expect(w.events).toContain('revoke:stalled');
  });
  test('a captured result waiting for storage is retained even if the runtime is idle and the lease expired', async () => {
    const w = world(); w.addTask('pending'); await w.dispatcher().tick();
    const employee = w.rows[0]!.currentEmployee;
    w.agents.get(w.instances[0]!.paseoAgentId!)!.status = 'idle';
    w.pool.hasPendingResult = (inst, task, delivery) => inst === employee && task === 'pending'
      && delivery === w.rows[0]!.row.delivery_id;
    w.rows[0]!.progressAt = 0; w.setNow(100000);
    const report = await w.dispatcher().tick();
    expect(report.revoked).toEqual([]);
    expect(w.rows[0]!.currentEmployee).toBe(employee);
    expect(w.events.filter(e => e.startsWith('claim:'))).toHaveLength(1);
  });
  test('a result captured while stopping is retained before the next dispatch', async () => {
    const w = world(); w.addTask('stopping'); await w.dispatcher().tick();
    let pending = false;
    w.pool.hasPendingResult = () => pending;
    const stop = w.paseo.stop;
    w.paseo.stop = async id => { await stop(id); pending = true; };
    w.rows[0]!.progressAt = 0; w.setNow(100000);
    expect((await w.dispatcher().tick()).revoked).toEqual([]);
    expect(w.events.filter(e => e.startsWith('claim:'))).toHaveLength(1);
  });
  test('resolved uncertainty clears only this node employee notice', async () => {
    const w = world(); w.addTask('local'); await w.dispatcher().tick();
    const employee = w.rows[0]!.currentEmployee;
    w.agents.get(w.instances[0]!.paseoAgentId!)!.status = 'unknown';
    await w.dispatcher().tick();
    const own = `runtime-uncertain:${employee}:local`, foreign = 'runtime-uncertain:other-node-worker:foreign';
    w.notices.set(foreign, 'another node is waiting');
    expect(w.notices.has(own)).toBe(true);
    w.rows[0]!.currentEmployee = undefined;
    w.rows[0]!.state = 'done';
    await w.dispatcher().tick();
    expect(w.notices.has(own)).toBe(false);
    expect(w.notices.has(foreign)).toBe(true);
  });
});
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
    await d.tick(); expect(w.instances).toHaveLength(2); // a session serves only its own task: 'next' opens a new one
    const oldRequest = readJsonFile<{ ok: boolean }>(join(resDir(env.SCK_COMM_DIR!), 'old-review.json'));
    expect(oldRequest?.ok).not.toBe(true); expect(w.events).not.toContain('review:next');
    const nextEnv = w.envs.get(w.instances[1]!.paseoAgentId!)!;
    expect((await w.relay(nextEnv, 'get_task_history', { taskId: 'next' })).ok).toBe(true);
    expect((await w.relay(nextEnv, 'ops_info')).ok).toBe(true);
    expect((await w.relay(nextEnv, 'review', { decision: 'accept', text: 'fixture' })).ok).toBe(true);
  });
  test('healthy management-only GM survives idempotent adoption in the same process', async () => {
    const w = world('owner');
    const gm: EmployeeInst = { id: 'gm-fixture', role: 'owner', credential: 'fixture-gm' };
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
      credential: 'fixture-9', cwd: '/repo', repoHome: '/repo', sessionTask: 't1' } as EmployeeInst;
    w.instances.push(stale);
    w.pool.env(stale); w.pool.bindAgent(stale.id, 'agent-9'); stale.paseoAgentId = 'agent-9';
    w.agents.set('agent-9', { id: 'agent-9', status: 'idle' });
    // A review task whose registered scene is the task's exclusive worktree.
    w.addTask('t1', { state: 'review', submittedBy: 'employee-77', worktreePath: '/repo-task-t1' });
    w.rows[0].previousEmployee = stale.id;
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
    expect(w.cwds.get(inst.paseoAgentId!)).toBe('/repo');
    // The task stayed in review and is now held by the spawned reviewer.
    expect(w.views.get('t1')!.state).toBe('review');
    expect(w.views.get('t1')!.currentEmployee).toBe(inst.id);
  });
  test('a home-bound session wakes on a different worktree instead of retiring', async () => {
    const w = world();
    // A free session parked on its private comm dir — the shape bind() now records.
    const home = { id: 'employee-9', def: 'test', role: 'engineering', provider: 'codex', model: 'fixture',
      credential: 'fixture-9', repoHome: '/repo', sessionTask: 't1' } as EmployeeInst;
    home.cwd = w.pool.commDirFor(home.id);
    w.instances.push(home);
    w.pool.env(home); w.pool.bindAgent(home.id, 'agent-9'); home.paseoAgentId = 'agent-9';
    w.agents.set('agent-9', { id: 'agent-9', status: 'idle' });
    // Its new task lives on a tree the session has never seen — that is the normal case.
    w.addTask('t1', { state: 'ready', worktreePath: '/repo-task-t1' });
    w.rows[0].previousEmployee = home.id;
    const r = await w.dispatcher().tick();
    expect(w.events).toContain('claim:employee-9:t1');
    expect(w.events).toContain('send:agent-9');
    expect(r.retired).not.toContain('employee-9');
    expect(r.woke.map(x => x.employee)).toContain('employee-9');
    expect(w.views.get('t1')!.currentEmployee).toBe('employee-9');
  });
  test('a message waiting for its translation holds a free session before any lease, then dispatches once translated', async () => {
    const w = world();
    const home = { id: 'employee-9', def: 'test', role: 'engineering', provider: 'codex', model: 'fixture',
      credential: 'fixture-9', repoHome: '/repo', sessionTask: 't1' } as EmployeeInst;
    home.cwd = w.pool.commDirFor(home.id);
    w.instances.push(home);
    w.pool.env(home); w.pool.bindAgent(home.id, 'agent-9'); home.paseoAgentId = 'agent-9';
    w.agents.set('agent-9', { id: 'agent-9', status: 'idle' });
    w.addTask('t1', { state: 'ready', worktreePath: '/repo-task-t1' });
    w.rows[0].previousEmployee = home.id;
    w.waiting.add('t1');
    const d = w.dispatcher();
    await d.tick();
    // The session's language is aligned to the message first; the wait then stops the pass before any claim, send or notice.
    expect(w.aligned).toContain('t1:execute:employee-9');
    expect(w.events.some(e => e.startsWith('claim:') || e.startsWith('send:'))).toBe(false);
    expect(w.notices.size).toBe(0);
    w.waiting.delete('t1');
    await d.tick();
    expect(w.events).toContain('claim:employee-9:t1');
    expect(w.events).toContain('send:agent-9');
  });
  test('a waiting message creates no employee and takes no lease; the pass after its translation spawns the seat', async () => {
    const w = world();
    w.addTask('t2', { state: 'ready' });
    w.waiting.add('t2');
    const d = w.dispatcher();
    await d.tick();
    expect(w.instances).toHaveLength(0);
    expect(w.events.some(e => e.startsWith('claim:') || e.startsWith('spawn:'))).toBe(false);
    w.waiting.delete('t2');
    await d.tick();
    expect(w.instances).toHaveLength(1);
    expect(w.events).toContain(`claim:${w.instances[0]!.id}:t2`);
    expect(w.spawnBodies[0]).toContain('t2');
  });
  test('a spawned instance binds the repository root as cwd and keeps private comm separately', async () => {
    const w = world();
    w.addTask('t1', { state: 'ready', worktreePath: '/repo-task-t1' });
    await w.dispatcher().tick();
    const inst = w.instances[0];
    expect(inst.cwd).toBe('/repo');
    expect(inst.workspaceScope).toBe('maintenance');
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
  test('a busy holder past stallMinutes is asked for a checkpoint, then stopped once its timeline stands still', async () => {
    const w = world(); w.addTask('stuck'); const d = w.dispatcher(); await d.tick();
    const inst = w.instances[0]!;
    w.rows[0]!.progressAt = 1000;
    w.setNow(1000 + 91 * 60);
    await d.tick();
    expect(w.events).toContain(`send:${inst.paseoAgentId}`);
    expect(w.events).not.toContain(`stop:${inst.paseoAgentId}`);
    w.setNow(1000 + 112 * 60);
    await d.tick();
    expect(w.events).toContain(`stop:${inst.paseoAgentId}`);
    expect(w.events).toContain('revoke:stuck');
  });
  test('a busy holder whose timeline keeps moving survives the stall window up to its cap', async () => {
    const w = world(); w.addTask('long-build'); const d = w.dispatcher(); await d.tick();
    const inst = w.instances[0]!;
    let line = 0;
    w.paseo.logsTail = async () => `tool call ${++line}`;
    w.rows[0]!.progressAt = 1000;
    for (const minute of [91, 120, 180, 260]) {
      w.setNow(1000 + minute * 60);
      await d.tick();
    }
    expect(w.events).not.toContain(`stop:${inst.paseoAgentId}`);
    expect(w.views.get('long-build')!.currentEmployee).toBe(inst.id);
    w.setNow(1000 + 271 * 60);
    await d.tick();
    expect(w.events).toContain(`stop:${inst.paseoAgentId}`);
    expect(w.events).toContain('revoke:long-build');
  });
  test('a closed session holding a lease is resumed in place and told to continue', async () => {
    const w = world(); w.addTask('interrupted'); const d = w.dispatcher(); await d.tick();
    const inst = w.instances[0]!, agent = inst.paseoAgentId!;
    w.agents.get(agent)!.status = 'closed';
    const sends = w.events.filter(e => e === `send:${agent}`).length;
    const r = await d.tick();
    expect(w.events).toContain(`reload:${agent}`);
    expect(w.events.filter(e => e === `send:${agent}`).length).toBe(sends + 1);
    expect(r.retired).not.toContain(inst.id);
    expect(r.revoked).toHaveLength(0);
    expect(w.views.get('interrupted')!.currentEmployee).toBe(inst.id);
  });
  test('a closed session holding a lease that cannot resume stays unknown through the grace, then reads as down', async () => {
    const w = world(); w.addTask('bound');
    const inst = { id: 'employee-9', def: 'test', role: 'engineering', provider: 'codex', model: 'fixture', credential: 'fixture-9' } as EmployeeInst;
    w.instances.push(inst); w.pool.env(inst); w.pool.bindAgent(inst.id, 'agent-9'); inst.paseoAgentId = 'agent-9';
    w.agents.set('agent-9', { id: 'agent-9', status: 'closed' });
    Object.assign(w.rows[0]!, { state: 'doing', currentEmployee: inst.id, deliveryId: 'd-bound', leaseExpiresAt: 9999 });
    w.paseo.reload = async id => { w.events.push(`reload-failed:${id}`); throw new Error('synthetic resume failure'); };
    const d = w.dispatcher();
    await d.tick();
    expect(w.events).toContain('reload-failed:agent-9');
    expect(w.events.some(e => e.startsWith('retire:employee-9'))).toBe(false);
    expect(d.sessionSnapshot().sessions.get('employee-9')?.state).toBe('unknown');
    w.setNow(1000 + 11 * 60);
    await d.tick();
    expect(d.sessionSnapshot().sessions.get('employee-9')?.state).toBe('down');
  });
  test('oneshot: a new task opens a new session, its own session continues it, and a finished session ends', async () => {
    const w = world();
    w.setConfig({ sessionPolicy: 'oneshot' });
    w.addTask('first'); await w.dispatcher().tick();
    const old = w.instances[0]!;
    Object.assign(old, { lastTask: 'first', lastPhase: 'execute', activeTask: undefined });
    Object.assign(w.views.get('first')!, { state: 'done', currentEmployee: undefined });
    Object.assign(w.rows.find(t => t.id === 'first')!, { state: 'done', currentEmployee: undefined });
    w.rows.splice(w.rows.findIndex(t => t.id === 'first'), 1);
    w.agents.get(old.paseoAgentId!)!.status = 'idle';
    w.addTask('second');
    const report = await w.dispatcher().tick();
    expect(report.retired).toContain(old.id);
    expect(report.woke.find(entry => entry.task === 'second')).toMatchObject({ spawned: true });
    expect(w.events).not.toContain(`claim:${old.id}:second`);
  });
  test('an idle session with another task\'s context is not reused under either session policy', async () => {
    const run = async (policy: 'reuse' | 'oneshot') => {
      const w = world();
      w.addTask('first'); await w.dispatcher().tick();
      const old = w.instances[0]!;
      expect((await w.relay(w.envs.get(old.paseoAgentId!)!, 'submit', { text: 'fixture' })).ok).toBe(true);
      Object.assign(old, { lastTask: 'open', lastPhase: 'execute', activeTask: undefined });
      w.agents.get(old.paseoAgentId!)!.status = 'idle';
      w.setConfig({ sessionPolicy: policy });
      w.addTask('open-next');
      return { spawned: (await w.dispatcher().tick()).woke.find(entry => entry.task === 'open-next')?.spawned };
    };
    expect(await run('oneshot')).toEqual({ spawned: true });
    expect(await run('reuse')).toEqual({ spawned: true });
  });
  test('a per-role wake limit rotates that role sooner and leaves the global limit for the rest', async () => {
    const w = world();
    const inst = { id: 'employee-9', def: 'test', role: 'engineering', provider: 'codex', model: 'fixture', credential: 'fixture-9', wakeCount: 4 } as EmployeeInst;
    w.instances.push(inst); w.pool.env(inst); w.pool.bindAgent(inst.id, 'agent-9'); inst.paseoAgentId = 'agent-9';
    w.agents.set('agent-9', { id: 'agent-9', status: 'idle' });
    w.setConfig({ sessionMaxWakes: 12, sessionMaxWakesByRole: { qa: 2 } });
    expect((await w.dispatcher().tick()).retired).not.toContain('employee-9');
    w.setConfig({ sessionMaxWakes: 12, sessionMaxWakesByRole: { engineering: 4 } });
    expect((await w.dispatcher().tick()).retired).toContain('employee-9');
  });
  test('a closed session with no work keeps the retirement path', async () => {
    const w = world();
    const inst = { id: 'employee-9', def: 'test', role: 'engineering', provider: 'codex', model: 'fixture', credential: 'fixture-9' } as EmployeeInst;
    w.instances.push(inst); w.pool.env(inst); w.pool.bindAgent(inst.id, 'agent-9'); inst.paseoAgentId = 'agent-9';
    w.agents.set('agent-9', { id: 'agent-9', status: 'closed' });
    const r = await w.dispatcher().tick();
    expect(w.events).not.toContain('reload:agent-9');
    expect(r.retired).toContain('employee-9');
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

// A def can opt out of quota gating: even at 0% remaining the owner wants it dispatched and
// retried, accepting that some turns will fail until the allowance returns.
describe('R6: a def exempt from quota gating keeps dispatching through a spent subscription', () => {
  test('a spawn is admitted while the provider is quota-blocked and cooling down', async () => {
    const w = world();
    w.def.quotaLimited = false;
    try {
      w.setConfig({ quotaFloorPct: 8, quotaWeeklyFloorPct: 2 });
      w.setQuota([{ provider: 'codex', summary: 'Weekly 剩余 0%', weeklyPct: 0, sessionPct: 100, fetchedAt: new Date().toISOString() }]);
      w.setHealth(new Map([['codex', { provider: 'codex', state: 'exhausted', until: 5000, failures: 1 }]]));
      w.addTask('exempt-task');
      const r = await w.dispatcher().tick();
      expect(r.skipped).toBeUndefined();
      expect(r.woke).toHaveLength(1);
      expect(r.woke[0]!.spawned).toBe(true);
    } finally { w.def.quotaLimited = undefined; }
  });

  test('a limited def in the same state still waits', async () => {
    const w = world();
    w.setConfig({ quotaFloorPct: 8, quotaWeeklyFloorPct: 2 });
    w.setQuota([{ provider: 'codex', summary: 'Weekly 剩余 0%', weeklyPct: 0, sessionPct: 100, fetchedAt: new Date().toISOString() }]);
    w.setHealth(new Map([['codex', { provider: 'codex', state: 'exhausted', until: 5000, failures: 1 }]]));
    w.addTask('limited-task');
    const r = await w.dispatcher().tick();
    expect(r.woke).toHaveLength(0);
    expect(r.skipped).toBe('budget');
  });

  test('a session parked by a quota error is reloaded without waiting out the cooldown', async () => {
    const w = world();
    w.def.quotaLimited = false;
    try {
      const inst = { id: 'employee-9', def: 'test', role: 'engineering', provider: 'codex', model: 'fixture',
        credential: 'fixture-9', cwd: '/repo', repoHome: '/repo' } as EmployeeInst;
      w.instances.push(inst);
      w.pool.env(inst);
      w.pool.bindAgent(inst.id, 'agent-9');
      inst.paseoAgentId = 'agent-9';
      w.agents.set('agent-9', { id: 'agent-9', status: 'error' });
      w.setLastError('Error: Agent turn ended: model_usage_exhausted[System Error] Internal error: Agent turn ended: model_usage_exhausted');
      // Still cooling down: a limited def waits, an exempt def restarts on the retry interval.
      w.setHealth(new Map([['codex', { provider: 'codex', state: 'exhausted', until: 5000, failures: 1 }]]));
      const r = await w.dispatcher().tick();
      expect(w.events).toContain('reload:agent-9');
      expect(r.recovered).toEqual(['employee-9']);
      expect(w.agents.get('agent-9')!.status).toBe('idle');
    } finally { w.def.quotaLimited = undefined; }
  });
});


test('kernel pressure gates the real dispatcher even when byte estimates disagree', async () => {
  const w = world();
  w.addTask('kernel-pressure');
  w.setHost({ freeMemMb: 8192, freeDiskMb: 65536, memoryPressure: 2 });
  expect((await w.dispatcher().tick()).skipped).toBe('resources');
  expect(w.events.some(e => e.startsWith('spawn:'))).toBe(false);
  w.setHost({ freeMemMb: 100, freeDiskMb: 65536, memoryPressure: 1 });
  expect((await w.dispatcher().tick()).woke).toHaveLength(1);
});


test('idle retirement waits for two hours of actual observations, then archives without a performance failure', async () => {
  const w = world();
  const inst: EmployeeInst = { id: 'employee-9', def: 'test', role: 'engineering', provider: 'codex', model: 'fixture', credential: 'synthetic', lastWakeAt: 1 };
  w.instances.push(inst); w.pool.env(inst); w.pool.bindAgent(inst.id, 'agent-9'); inst.paseoAgentId = 'agent-9';
  w.agents.set('agent-9', { id: 'agent-9', status: 'idle' });
  expect((await w.dispatcher().tick()).retired).toEqual([]);
  expect(inst.idleSince).toBe(1000);
  w.setNow(8199);
  expect((await w.dispatcher().tick()).retired).toEqual([]);
  w.setNow(8201);
  expect((await w.dispatcher().tick()).retired).toEqual([inst.id]);
  expect(w.events).toContain('archive:agent-9');
  expect(w.events).not.toContain('performance-failure');
});

test('memory-only admission never reclaims disk or emits disk recovery instructions; snapshot survives restart',async()=>{
 const w=world();w.addTask('memory-only');w.setHost({freeMemMb:249,freeDiskMb:45000,memoryPressure:2});let reclaimed=0;
 w.setReclaim(async()=>{reclaimed++;return {runId:'unused',trigger:'pressure',dryRun:false,mode:'pressure',trimmed:[],skipped:{},removedFiles:0,freedBytes:0,truncated:false,errors:0,disabled:true,disabledReason:'config'};});
 for(let i=0;i<2;i++){const d=w.dispatcher();expect((await d.tick()).skipped).toBe('resources');const v=d.dispatchVerdicts().find(v=>v.taskId==='memory-only')!;expect(v.reasons.map(r=>r.code)).toEqual(['memory_pressure']);expect(v.reasons[0]!.recovery).not.toContain('清理宿主机磁盘');expect(v.reasons[0]!.text).toContain('内存');}
 expect(reclaimed).toBe(0);expect(w.notices.has('resources-reclaim-blocked')).toBe(false);
 w.setHost({freeMemMb:249,freeDiskMb:45000,memoryPressure:1});const r=await w.dispatcher().tick();expect(r.skipped).toBeUndefined();expect(r.woke.length).toBeGreaterThan(0);
});
test('a simultaneous memory and disk block preserves both causes in the task verdict',async()=>{
 const w=world();w.addTask('both-low');w.setHost({freeMemMb:249,freeDiskMb:128,memoryPressure:2});const d=w.dispatcher();await d.tick();expect(d.dispatchVerdicts().find(v=>v.taskId==='both-low')!.reasons.map(r=>r.code).sort()).toEqual(['disk_space','memory_pressure']);
});

test('every employee-facing send carries an outbound_message body that is then marked sent', async () => {
  // Execute dispatch: the wake body is the rendered execute draft, marked sent after paseo.send.
  const w = world(); w.addTask('dispatch'); const d = w.dispatcher(); await d.tick();
  const bodies = [...w.sentBodies.map(b => b.body), ...w.spawnBodies];
  expect(bodies.some(b => b.includes('fixture execute body for dispatch'))).toBe(true);
  expect(w.events.some(e => e.startsWith('markSent:'))).toBe(true);
  expect(bodies.every(b => typeof b === 'string' && b.length > 0)).toBe(true);
});

test('a stall nudge travels as an outbound row marked sent', async () => {
  const w = world(); w.addTask('stalled'); const d = w.dispatcher(); await d.tick();
  w.rows[0]!.progressAt = 1000;
  w.setNow(1000 + 91 * 60);
  await d.tick();
  const nudge = w.sentBodies.find(b => b.body.includes('checkpoint'))!;
  expect(nudge.body).toContain(`任务 stalled 已 `);
  expect(nudge.body).toContain('分钟没有 checkpoint');
  expect(w.sentBodies.every(b => typeof b.body === 'string' && b.body.length > 0)).toBe(true);
});

describe('派工外部副作用不确定状态', () => {
  for (const failure of ['acknowledgeDispatchAttempt', 'markSent', 'bind', 'touchWake', 'finishDispatchAttempt'] as const) {
    test(`spawn 成功后 ${failure} 失败不得释放、退休或重派，重建 dispatcher 后仍阻断`, async () => {
      const w = world(); w.addTask(`uncertain-${failure}`);
      const fail = async () => { throw new Error(`injected ${failure}`); };
      if (failure === 'markSent') w.messages.markSent = fail;
      else w.wf[failure] = fail;
      const failureResult = await w.dispatcher().tick().then(() => undefined, error => error);
      expect(w.events.some(e => /^(release|retire|revoke|performance-failure):/.test(e))).toBe(false);
      expect(w.spawnBodies).toHaveLength(1);
      expect(w.attempts.size).toBe(1);
      expect(w.rows[0]!.currentEmployee).toBe('employee-1');
      w.setNow(100000); // Even an expired/stale lease must not authorize a blind retry.
      const report = await w.dispatcher().tick();
      expect(report.notices).toContain('dispatch-uncertain');
      expect(report.revoked).toHaveLength(0);
      expect(w.spawnBodies).toHaveLength(1);
      expect(failureResult).toBeInstanceOf(Error);
      expect(failureResult.message).toContain(`injected ${failure}`);
    });
  }
  test('spawn 运行端已接收但响应丢失，禁止尝试下一员工', async () => {
    const w = world(); w.addTask('lost-spawn-reply');
    const spawn = w.paseo.spawn;
    w.paseo.spawn = async input => { await spawn(input); throw new Error('reply lost'); };
    const failureResult = await w.dispatcher().tick().then(() => undefined, error => error);
    expect(w.events.some(e => /^(release|retire|revoke|performance-failure):/.test(e))).toBe(false);
    expect(w.spawnBodies).toHaveLength(1);
    expect(w.instances).toHaveLength(1);
    expect(w.attempts.size).toBe(1);
    await w.dispatcher().tick();
    expect(w.spawnBodies).toHaveLength(1);
    expect(failureResult).toBeInstanceOf(Error);
    expect(failureResult.message).toContain('reply lost');
  });
  test('写前日志失败不得调用运行端；日志查询失败不得开始派工', async () => {
    const w = world(); w.addTask('journal-failure');
    w.wf.beginDispatchAttempt = async () => { throw new Error('journal write lost'); };
    await expect(w.dispatcher().tick()).rejects.toThrow('journal write lost');
    expect(w.spawnBodies).toHaveLength(0);
    w.wf.pendingDispatchAttempts = async () => { throw new Error('journal unavailable'); };
    await expect(w.dispatcher().tick()).rejects.toThrow('journal unavailable');
    expect(w.spawnBodies).toHaveLength(0);
  });
});

for (const failure of ['reply', 'markSent', 'touchWake'] as const) {
  test(`复用 send 后 ${failure} 失败保留租约且重启不补发`, async () => {
    const w = world();
    const inst: EmployeeInst = { id: 'employee-9', def: 'test', role: 'engineering', provider: 'codex', model: 'fixture',
      credential: 'fixture-9', repoHome: '/repo', sessionTask: 'send-task' };
    inst.cwd = w.pool.commDirFor(inst.id);
    w.instances.push(inst); w.pool.env(inst); w.pool.bindAgent(inst.id, 'agent-9'); inst.paseoAgentId = 'agent-9';
    w.agents.set('agent-9', { id: 'agent-9', status: 'idle' });
    w.addTask('send-task', { worktreePath: '/repo-send-task' }); w.rows[0]!.previousEmployee = inst.id;
    const fail = async () => { throw new Error(`send ${failure}`); };
    if (failure === 'reply') { const send = w.paseo.send; w.paseo.send = async (...args) => { await send(...args); await fail(); }; }
    else if (failure === 'markSent') w.messages.markSent = fail;
    else w.wf.touchWake = fail;
    const failureResult = await w.dispatcher().tick().then(() => undefined, error => error);
    expect(w.rows[0]!.currentEmployee).toBe(inst.id);
    expect(w.events).not.toContain('release:send-task');
    expect(w.sentBodies).toHaveLength(1); expect(w.attempts.size).toBe(1);
    const report = await w.dispatcher().tick();
    expect(report.woke).toHaveLength(0); expect(w.sentBodies).toHaveLength(1);
    expect(failureResult).toBeInstanceOf(Error);
    expect(failureResult.message).toContain(`send ${failure}`);
  });
}

test('不确定任务局部隔离，不阻止无关任务新派工及运行监督', async () => {
  const w = world(); w.addTask('uncertain');
  const bind = w.wf.bind;
  w.wf.bind = async () => { throw new Error('bind uncertain'); };
  await expect(w.dispatcher().tick()).rejects.toThrow('bind uncertain');
  w.wf.bind = bind;
  w.addTask('unrelated');
  const report = await w.dispatcher().tick();
  expect(report.woke.map(x => x.task)).toContain('unrelated');
  expect(w.spawnBodies).toHaveLength(2);
  expect(w.rows[0]!.currentEmployee).toBe('employee-1');
  expect(w.events).not.toContain('release:uncertain');
});

for (const lostReply of [false, true]) {
  test(`真实 NativeRuntime 经 dispatcher spawn→绑定→activate，激活回执丢失=${lostReply}`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'dispatch-native-'));
    const script = join(root, 'fixture.cjs'), received = join(root, 'received.txt');
    writeFileSync(script, `let p='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>p+=s);process.stdin.on('end',()=>{require('fs').writeFileSync(process.env.FIXTURE_ROOT+'/received.txt',p);console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,session_id:'fixture-session',result:'完成'}));});`);
    const runtime = new NativeRuntime({ root: join(root, 'runtime'), host: 'fixture', command: () => [process.execPath, script], environment: async () => ({ PATH: process.env.PATH ?? '', FIXTURE_ROOT: root }), onEnded: async () => {} });
    try {
      const w = world(); w.def.provider = 'factory-droid'; w.addTask('native-activation'); w.rows[0]!.repoPath = root;
      let calls = 0;
      w.paseo.spawn = input => runtime.spawn(input);
      w.paseo.activate = async agent => {
        calls++;
        expect(w.instances[0]!.paseoAgentId).toBe(agent);
        expect([...w.attempts.values()][0]!.activation_state).toBe('calling');
        expect(w.events.some(e => e.startsWith('markSent:'))).toBe(false);
        await runtime.activate(agent);
        if (lostReply) throw new Error('activation reply lost');
      };
      if (lostReply) await expect(w.dispatcher().tick()).rejects.toThrow('activation reply lost');
      else await w.dispatcher().tick();
      for (let i = 0; i < 100 && !existsSync(received); i++) await Bun.sleep(10);
      expect(readFileSync(received, 'utf8')).toContain('native-activation');
      expect(calls).toBe(1);
      if (lostReply) {
        expect(w.attempts.size).toBe(1);
        await w.dispatcher().tick();
        expect(calls).toBe(1);
        expect(w.events.some(e => e.startsWith('markSent:'))).toBe(false);
      } else { expect(w.attempts.size).toBe(0); expect(w.events.some(e => e.startsWith('markSent:'))).toBe(true); }
    } finally { await runtime.close(); rmSync(root, { recursive: true, force: true }); }
  });
}
