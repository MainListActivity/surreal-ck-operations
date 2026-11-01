import { expect, test } from 'bun:test';
import { Dispatcher, type SidecarBridge } from '../src/dispatcher/dispatcher.ts';
import type { PaseoGateway } from '../src/dispatcher/paseo.ts';
import { DEFAULT_CONFIG, managerWakeKey, type EmployeeDef, type EmployeeInst, type ManagerWakeClaim, type ManagerWakeInput, type ManagerWakeRow, type ProviderHealth, type SupervisedTask, type Workforce } from '../src/workforce.ts';
import type { OwnerDesk } from '../src/owner.ts';
import type { ClaimResult, TaskView, WorktreeAssignment } from '../src/contracts.ts';
import { managerActionKey } from '../src/dispatcher/dispatch-blocked.ts';

const OPS = '/fixture/ops';
const PROJ_A = '/fixture/proj-a';
const PROJ_B = '/fixture/proj-b';

function sharedTree(repo: string): WorktreeAssignment {
  return { id: `wt-${repo}`, repo, worktreePath: `${repo}-sck-shared`, mode: 'shared', branch: 'main',
    intent: { kind: 'read' }, discipline: 'fixture' };
}

interface TaskSpec {
  id: string;
  state?: 'ready' | 'blocked' | 'doing' | 'review';
  blockedTo?: 'gm' | 'owner';
  repoPath?: string;
  implementer?: string;
  version?: number;
  facts?: Record<string, unknown>;
  goalId?: string;
}

interface ActionInput {
  taskId: string; phase: 'execute' | 'review'; episode: number; reason: string;
  action: 'implementer_takeover'; version: number; repo: string; implementer?: string;
}
interface ActionRow extends ActionInput { key: string; status: 'open' | 'closed'; resolution?: string }

/** Light fixture: real Dispatcher.tick, fake Paseo/sidecar/owner, in-memory persistence for restarts. */
export function fixture(specs: TaskSpec[]) {
  const defs: EmployeeDef[] = [
    { id: 'gm-codex', role: 'gm', provider: 'codex', model: 'fixture', enabled: true, maxInstances: 4, priority: 0, weight: 1, scored: 0, errorStreak: 0 },
    { id: 'eng-codex', role: 'engineering', provider: 'codex', model: 'fixture', enabled: true, maxInstances: 4, priority: 0, weight: 1, scored: 0, errorStreak: 0 },
    { id: 'qa-codex', role: 'qa', provider: 'codex', model: 'fixture', enabled: true, maxInstances: 4, priority: 0, weight: 1, scored: 0, errorStreak: 0 },
  ];
  const instances: EmployeeInst[] = [];
  const agents = new Map<string, { id: string; status: string }>();
  const errors = new Map<string, string>();
  const health = new Map<string, ProviderHealth>();
  const facts = new Map<string, Record<string, unknown>>();
  const prompts: Array<{ employee: string; prompt: string; cwd: string }> = [];
  const sends: Array<{ agentId: string; prompt: string }> = [];
  const spawnCwds: string[] = [];
  const readWorkspaceCalls: Array<{ instId: string; taskId?: string }> = [];
  const notices = new Map<string, { text: string; resolved: boolean }>();
  const noticeCalls: unknown[][] = [];
  const dispatches = new Map<string, { employee: string; at: number }>();
  const actions = new Map<string, ActionRow>();
  const wakes = new Map<string, ManagerWakeRow>();
  const now = 1_000_000;
  let next = 0;
  let keySeq = 0;
  let failReload = false;
  let contributorsFail = false;
  let statusFails = false;
  let failSpawnAfterStart = false;
  let failSendAfterStart = false;
  let failWakeRead = false;
  let failActionRead = false;

  const rows: SupervisedTask[] = specs.map(spec => {
    const state = spec.state ?? 'blocked';
    const task = {
      id: spec.id, title: spec.id, state, blockedTo: spec.blockedTo, executorRole: 'engineering', reviewerRole: 'qa',
      kind: 'task', goalId: spec.goalId, version: spec.version ?? 1, implementer: spec.implementer, repoPath: spec.repoPath,
      evalAttempts: 0, ownerRerouted: false,
      row: { id: spec.id, title: spec.id, state, blocked_to: spec.blockedTo, version: spec.version ?? 1,
        implementer: spec.implementer, repo_path: spec.repoPath } as never,
    } as unknown as SupervisedTask;
    facts.set(spec.id, spec.facts ?? (spec.implementer
      ? { authors: [spec.implementer], reviewers: [], excluded: [spec.implementer], unknown: [], ambiguous: false, implementer: spec.implementer }
      : { authors: ['author-a', 'author-b'], reviewers: [], excluded: ['author-a', 'author-b'], unknown: [], ambiguous: true }));
    return task;
  });

  const addTask = (spec: TaskSpec): SupervisedTask => {
    const state = spec.state ?? 'blocked';
    const task = {
      id: spec.id, title: spec.id, state, blockedTo: spec.blockedTo, executorRole: 'engineering', reviewerRole: 'qa',
      kind: 'task', version: spec.version ?? 1, implementer: spec.implementer, repoPath: spec.repoPath,
      evalAttempts: 0, ownerRerouted: false,
      row: { id: spec.id, title: spec.id, state, blocked_to: spec.blockedTo, version: spec.version ?? 1,
        implementer: spec.implementer, repo_path: spec.repoPath } as never,
    } as unknown as SupervisedTask;
    facts.set(spec.id, spec.facts ?? (spec.implementer
      ? { authors: [spec.implementer], reviewers: [], excluded: [spec.implementer], unknown: [], ambiguous: false, implementer: spec.implementer }
      : { authors: ['author-a', 'author-b'], reviewers: [], excluded: ['author-a', 'author-b'], unknown: [], ambiguous: true }));
    rows.push(task);
    return task;
  };

  const addInstance = (def: EmployeeDef, id: string, status = 'idle') => {
    const inst: EmployeeInst = { id, role: def.role, def: def.id, provider: def.provider, model: def.model,
      paseoAgentId: `agent-${id}`, cwd: OPS, repoHome: OPS, workspaceScope: 'maintenance', credential: `cred-${id}` };
    instances.push(inst);
    agents.set(inst.paseoAgentId!, { id: inst.paseoAgentId!, status });
    return inst;
  };
  addInstance(defs[1]!, 'eng-1');
  addInstance(defs[2]!, 'qa-1');

  const wf = {
    config: async () => ({ ...DEFAULT_CONFIG, quotaFloorPct: 0, quotaWeeklyFloorPct: 0, quotaWarnPct: 0,
      sessionMaxWakes: 0, sessionMaxInputK: 0, evalEnabled: false, jevDecisions: false, maxRunning: 8,
      providerMax: { codex: 8 }, minFreeMemMb: 0, minFreeDiskMb: 0, artifactReclaimEnabled: false,
      ownerBriefHour: -1, blockLoopLimit: 0 }),
    defs: async () => defs,
    serverNow: async () => now,
    insts: async () => instances,
    tasks: async () => rows,
    contributors: async (taskId: string) => {
      if (contributorsFail) throw new Error('contributors read failed');
      return facts.get(taskId) ?? { authors: [], reviewers: [], excluded: [], unknown: [], ambiguous: false };
    },
    setDispatchBlock: async (taskId: string, phase?: string, since?: number) => {
      const row = rows.find(r => r.id === taskId);
      if (row) { row.dispatchBlockedPhase = phase; row.dispatchBlockedSince = since; }
    },
    providerHealth: async () => new Map(health),
    markHealthy: async (provider: string) => { health.set(provider, { provider, state: 'healthy', failures: 0 }); },
    markExhausted: async (provider: string, error: string) => {
      const prior = health.get(provider);
      const nextHealth: ProviderHealth = { provider, state: 'exhausted', until: prior?.until ?? now + 3600,
        failures: (prior?.failures ?? 0) + 1, lastError: error };
      health.set(provider, nextHealth);
      return nextHealth;
    },
    lastDispatch: async (taskId: string, version: number, purpose: string) =>
      dispatches.get(`${taskId}:${version}:${purpose}`),
    lastDispatches: async (taskIds: string[], purpose: string) => {
      const out = new Map<string, { employee: string; at: number }>();
      for (const [key, value] of dispatches) {
        const [task, version, ...rest] = key.split(':');
        if (rest.join(':') === purpose && taskIds.includes(task!)) out.set(`${task}:${version}`, value);
      }
      return out;
    },
    recordDispatch: async (taskId: string, version: number, purpose: string, employee: string) => {
      dispatches.set(`${taskId}:${version}:${purpose}`, { employee, at: now });
    },
    openManagerAction: async (input: ActionInput) => {
      const key = managerActionKey(input.taskId, input.phase, input.episode, input.reason);
      if (actions.get(key)?.status === 'open') return false;
      actions.set(key, { ...input, key, status: 'open' });
      return true;
    },
    openManagerActions: async () => {
      if (failActionRead) throw new Error('manager action read failed');
      return [...actions.values()].filter(action => action.status === 'open');
    },
    closeManagerAction: async (action: ActionRow, resolution: string) => {
      const row = actions.get(action.key);
      if (row && row.status === 'open') { row.status = 'closed'; row.resolution = resolution; }
    },
    newKey: () => `tok-${++keySeq}`,
    wakeClaim: (row: ManagerWakeRow): ManagerWakeClaim => ({ key: row.key, token: row.token, attempt: row.attempt,
      input: { taskId: row.taskId, phase: row.phase, episode: row.episode, reason: row.reason, version: row.version, repo: row.repo } }),
    acquireManagerWake: async (input: ManagerWakeInput, token: string) => {
      const key = managerWakeKey(input.taskId, input.phase, input.episode);
      const existing = wakes.get(key);
      if (existing && ['pending', 'running', 'unknown'].includes(existing.state)) return undefined;
      const attempt = (existing?.attempt ?? 0) + 1;
      const row: ManagerWakeRow = { ...input, key, purpose: 'gm-manager-wake', state: 'pending', attempt, token,
        startedAt: now, updatedAt: now };
      wakes.set(key, row);
      return { key, token, attempt, input };
    },
    markManagerWakeRunning: async (claim: ManagerWakeClaim, employee: string, agent?: string) => {
      const row = wakes.get(claim.key);
      if (!row || row.token !== claim.token || row.attempt !== claim.attempt ||
          !['pending', 'running', 'unknown'].includes(row.state)) return false;
      row.state = 'running'; row.employee = employee;
      if (agent !== undefined) row.agent = agent;
      row.externalStartedAt ??= now;
      row.lastCheckedAt = now; row.updatedAt = now;
      return true;
    },
    finishManagerWake: async (claim: ManagerWakeClaim, state: 'finished' | 'unknown', resolution: string, lastStatus?: string) => {
      const row = wakes.get(claim.key);
      if (!row || row.token !== claim.token || row.attempt !== claim.attempt ||
          !['pending', 'running', 'unknown'].includes(row.state)) return false;
      if (state === 'unknown' && row.state === 'unknown' && row.lastStatus === lastStatus) return false;
      row.state = state; row.resolution = resolution; row.lastStatus = lastStatus;
      row.lastCheckedAt = now; row.updatedAt = now;
      return true;
    },
    openManagerWakes: async () => {
      if (failWakeRead) throw new Error('manager wake read failed');
      return [...wakes.values()].filter(row => ['pending', 'running', 'unknown'].includes(row.state)).map(row => ({ ...row }));
    },
    finishManagerWakesForTask: async (taskId: string, resolution: string) => {
      let closed = 0;
      for (const row of wakes.values()) {
        if (row.taskId !== taskId || !['pending', 'running', 'unknown'].includes(row.state)) continue;
        if (await (wf as unknown as { finishManagerWake: (claim: ManagerWakeClaim, state: 'finished' | 'unknown', resolution: string, lastStatus?: string) => Promise<boolean> }).finishManagerWake(
          { key: row.key, token: row.token, attempt: row.attempt,
            input: { taskId: row.taskId, phase: row.phase, episode: row.episode, reason: row.reason, version: row.version, repo: row.repo } },
          'finished', resolution, row.lastStatus)) closed++;
      }
      return closed;
    },
    touchWake: async () => {},
    defHealthy: async () => {},
    defFailure: async () => 1,
    pendingEvaluations: async () => [],
    projectRepos: async () => [],
    doneTaskIds: async () => [],
    readySince: async () => new Map<string, number>(),
    disableDef: async () => {},
    spawnInst: async (def: EmployeeDef) => {
      const inst: EmployeeInst = { id: `${def.id}-${++next}`, role: def.role, def: def.id, provider: def.provider,
        model: def.model, credential: `cred-${next}` };
      instances.push(inst);
      return inst;
    },
    bind: async (id: string, binding: { agentId: string; cwd: string; repoHome?: string; model?: string }) => {
      Object.assign(instances.find(i => i.id === id)!, { paseoAgentId: binding.agentId, cwd: binding.cwd,
        repoHome: binding.repoHome ?? binding.cwd, model: binding.model, workspaceScope: (binding as { workspaceScope?: string }).workspaceScope });
      agents.set(binding.agentId, { id: binding.agentId, status: 'running' });
    },
    retire: async () => {},
    rotate: async (id: string) => `rotated-${id}`,
    revokeLease: async () => false,
    extendLease: async () => true,
    writeCredentialFile: () => '/dev/null',
  };

  const owner = {
    applyPending: async () => [],
    resolveNotice: async (key: string) => {
      const notice = notices.get(key);
      if (notice) notice.resolved = true;
    },
    openNotices: async () => [...notices.entries()].filter(([, notice]) => !notice.resolved)
      .map(([key, notice]) => ({ key, text: notice.text, at: new Date(now * 1000).toISOString() })),
    hasNotice: async (key: string) => Boolean(notices.get(key) && !notices.get(key)!.resolved),
    triagePending: async () => [],
    blockLoopStats: async () => new Map<string, { loops: number; reasons: string[] }>(),
    blockLoops: async () => ({ loops: 0, reasons: [] }),
    escalateLooping: async () => false,
    brief: async () => ({ directions: [] }),
    raiseNotice: async (key: string, text: string) => {
      const prior = notices.get(key);
      if (prior && !prior.resolved && prior.text === text) return false;
      notices.set(key, { text, resolved: false });
      noticeCalls.push([key, text]);
      return true;
    },
  };

  const paseo: PaseoGateway = {
    list: async () => agents,
    status: async id => {
      if (statusFails) throw new Error('status read failed');
      return agents.get(id) ? { status: agents.get(id)!.status, pendingPermissions: 0 } : undefined;
    },
    lastError: async id => errors.get(id) ?? '',
    logsTail: async () => '',
    lastInputTokens: async () => 0,
    spawn: async input => {
      const id = `agent-${input.labels.employee_id}`;
      agents.set(id, { id, status: 'running' });
      prompts.push({ employee: input.labels.employee_id!, prompt: input.prompt, cwd: input.cwd });
      spawnCwds.push(input.cwd);
      if (failSpawnAfterStart) throw new Error('spawn result lost');
      return id;
    },
    send: async (id, prompt) => {
      agents.get(id)!.status = 'running';
      sends.push({ agentId: id, prompt });
      if (failSendAfterStart) throw new Error('send result lost');
    },
    stop: async id => { agents.get(id)!.status = 'idle'; },
    reload: async id => { if (failReload) throw new Error('reload failed'); agents.get(id)!.status = 'idle'; },
    archive: async id => { agents.get(id)!.status = 'archived'; },
    listWorkspaces: async () => [], listProjects: async () => [], archiveWorkspace: async () => {}, deleteProject: async () => {},
  };

  const taskView = (task: SupervisedTask): TaskView => ({
    id: task.id, title: task.title, context: '', state: 'doing', executorRole: task.executorRole,
    reviewerRole: task.reviewerRole, kind: 'task', dependencies: [], version: task.version, fence: 1,
  } as TaskView);

  const sidecar: SidecarBridge = {
    env: inst => ({ SCK_COMM_DIR: `/tmp/${inst.id}`, SCK_COMM_KEY: 'k' }),
    canReuse: () => true,
    detachAgent: () => {},
    claim: async (inst, task) => task && inst.role === (task.state==='review'?task.reviewerRole:task.executorRole)
      ? ({ task: taskView(task), deliveryId: `delivery-${task.id}`, fence: 1,
          leaseExpiresAt: new Date((now + 600) * 1000).toISOString(), history: [] } as ClaimResult)
      : undefined,
    writeScope: async () => [],
    claimDenial: () => undefined,
    bindAgent: () => {},
    commDirFor: () => '/tmp/comm',
    scratchDirFor: instId => `/tmp/${instId}-scratch`,
    releaseClaim: async () => {},
    releaseWorkspace: async () => {},
    readWorkspace: async (inst, taskId) => {
      readWorkspaceCalls.push({ instId: inst.id, taskId });
      return sharedTree(rows.find(row => row.id === taskId)?.repoPath ?? OPS);
    },
  };

  let last: Dispatcher | undefined;
  const tick = async (extra: Partial<ConstructorParameters<typeof Dispatcher>[0]> = {}) => {
    last = new Dispatcher({ workforce: wf as unknown as Workforce, owner: owner as unknown as OwnerDesk,
      paseo, sidecar, env: { opsRepo: OPS, sckBin: '/bin/sck', paseoBin: '/bin/paseo' }, rand: () => 0, ...extra });
    return last.tick();
  };

  return {
    tick,
    get last() { return last; },
    paseo, rows, instances, agents, errors, health, facts, prompts, sends, spawnCwds, readWorkspaceCalls, notices, actions, dispatches,
    setStatus(agentId: string, status: string) { agents.get(agentId)!.status = status; },
    setError(agentId: string, error: string) { errors.set(agentId, error); },
    failReload(value: boolean) { failReload = value; },
    failContributors(value: boolean) { contributorsFail = value; },
    failStatus(value: boolean) { statusFails = value; },
    failWakeRead(value: boolean) { failWakeRead = value; },
    failActionRead(value: boolean) { failActionRead = value; },
    failSpawnAfterStart(value: boolean) { failSpawnAfterStart = value; },
    failSendAfterStart(value: boolean) { failSendAfterStart = value; },
    wakes, addTask,
    wakeFor(key: string) { return wakes.get(key); },
    ageWake(key: string, seconds: number) {
      const row = wakes.get(key); if (!row) return;
      if (row.startedAt !== undefined) row.startedAt -= seconds;
      if (row.externalStartedAt !== undefined) row.externalStartedAt -= seconds;
    },
    wf: wf as unknown as Workforce,
    defs,
    setImplementer(taskId: string, employee: string) {
      const row = rows.find(r => r.id === taskId)!;
      row.implementer = employee;
      (row.row as unknown as { implementer?: string }).implementer = employee;
      facts.set(taskId, { authors: [employee], reviewers: [], excluded: [employee], unknown: [], ambiguous: false, implementer: employee });
    },
    openActions() { return [...actions.values()].filter(action => action.status === 'open'); },
    actionFor(key: string) { return actions.get(key); },
  };
}

test('regression: ready + implementer_unresolved wakes an available gm with a takeover prompt', async () => {
  const f = fixture([{ id: 'captured-ready-unresolved', state: 'ready', repoPath: OPS }]);
  const result = await f.tick();
  const wake = result.woke.find(w => w.task === 'captured-ready-unresolved');
  expect(wake?.employee.startsWith('gm-')).toBe(true);
  const prompt = f.prompts.find(p => p.employee === wake!.employee)?.prompt ?? '';
  expect(prompt).toContain('contributor_dryrun');
  expect(prompt).toContain('implementer_takeover');
  expect(prompt).toContain('expectedVersion');
  expect(prompt).toContain('不要调用 resume_task');
  expect(f.openActions()).toHaveLength(1);
  expect(f.openActions()[0]).toMatchObject({ reason: 'implementer_unresolved', taskId: 'captured-ready-unresolved' });
  expect(f.notices.has('dispatch-blocked:captured-ready-unresolved:execute')).toBe(true);
});

test('control: explicit blockedTo=gm still wakes the same available gm with resume_task', async () => {
  const f = fixture([{ id: 'explicit-gm-block', state: 'blocked', blockedTo: 'gm', repoPath: OPS }]);
  const result = await f.tick();
  const wake = result.woke.find(w => w.task === 'explicit-gm-block');
  expect(wake?.employee.startsWith('gm-')).toBe(true);
  const prompt = f.prompts.find(p => p.employee === wake!.employee)?.prompt ?? '';
  expect(prompt).toContain('resume_task');
  expect(f.openActions()).toHaveLength(0);
});

test('the same episode does not wake again across ticks and dispatcher restarts', async () => {
  const f = fixture([{ id: 'dedup-task', state: 'ready', repoPath: OPS }]);
  await f.tick();
  f.setStatus('agent-gm-codex-1', 'idle');
  const again = await f.tick();
  expect(again.woke.filter(w => w.task === 'dedup-task')).toHaveLength(0);
  expect(f.openActions()).toHaveLength(1);
});

test('a recorded implementer closes the old todo and resumes engineering dispatch', async () => {
  const f = fixture([{ id: 'takeover-task', state: 'ready', repoPath: OPS }]);
  await f.tick();
  f.setImplementer('takeover-task', 'eng-1');
  f.setStatus('agent-eng-1', 'idle');
  const result = await f.tick();
  expect(result.woke.find(w => w.task === 'takeover-task')?.employee).toBe('eng-1');
  expect(f.openActions()).toHaveLength(0);
  expect([...f.wakes.values()][0]?.state).toBe('finished');
  expect(f.last!.dispatchVerdicts().filter(v => v.taskId === 'takeover-task')).toHaveLength(0);
});

test('persistent implementer quota failure becomes an implementer_quota gm todo', async () => {
  const f = fixture([{ id: 'quota-task', state: 'ready', implementer: 'eng-1', repoPath: OPS }]);
  f.setStatus('agent-eng-1', 'error');
  f.setError('agent-eng-1', 'Your workspace is out of credits. Add credits to continue.');
  f.failReload(true);
  f.health.set('codex', { provider: 'codex', state: 'exhausted', failures: 2, lastError: 'out of credits' });
  const result = await f.tick();
  const verdict = f.last!.dispatchVerdicts().find(v => v.taskId === 'quota-task')!;
  expect(verdict.reasons.map(reason => reason.code)).toContain('implementer_quota');
  const wake = result.woke.find(w => w.task === 'quota-task');
  expect(wake?.employee.startsWith('gm-')).toBe(true);
  const prompt = f.prompts.find(p => p.employee === wake!.employee)?.prompt ?? '';
  expect(prompt).toContain('恢复时间未知');
  expect(prompt).toContain('implementer_takeover');
  expect(f.openActions()[0]).toMatchObject({ reason: 'implementer_quota', taskId: 'quota-task' });
});

test('a busy bound implementer is not escalated to the manager', async () => {
  const f = fixture([{ id: 'busy-task', state: 'ready', implementer: 'eng-1', repoPath: OPS }]);
  f.setStatus('agent-eng-1', 'running');
  const result = await f.tick();
  expect(result.woke.filter(w => w.task === 'busy-task')).toHaveLength(0);
  expect(f.openActions()).toHaveLength(0);
  const codes = f.last!.dispatchVerdicts().find(v => v.taskId === 'busy-task')?.reasons.map(reason => reason.code) ?? [];
  expect(codes).not.toContain('implementer_quota');
  expect(codes).not.toContain('implementer_unresolved');
});

test('an implementer bound across goal workspaces is unavailable, not a busy wait', async () => {
  const f = fixture([{ id: 'cross-goal', state: 'ready', implementer: 'eng-1', repoPath: OPS }]);
  (f.rows[0] as { goalId?: string }).goalId = 'goal-b';
  await f.tick();
  const verdict = f.last!.dispatchVerdicts().find(v => v.taskId === 'cross-goal')!;
  expect(verdict.reasons.map(reason => reason.code)).toContain('implementer_unavailable');
  // Same workspace: the binding stands and the implementer is dispatched.
  const same = fixture([{ id: 'same-goal', state: 'ready', implementer: 'eng-1', repoPath: OPS }]);
  expect((await same.tick()).woke.find(w => w.task === 'same-goal')?.employee).toBe('eng-1');
});

test('a vanished bound implementer enters the manager takeover todo', async () => {
  const f = fixture([{ id: 'gone-task', state: 'ready', implementer: 'gone-employee', repoPath: OPS }]);
  const result = await f.tick();
  const verdict = f.last!.dispatchVerdicts().find(v => v.taskId === 'gone-task')!;
  expect(verdict.reasons.map(reason => reason.code)).toContain('implementer_unavailable');
  const wake = result.woke.find(w => w.task === 'gone-task');
  expect(wake?.employee.startsWith('gm-')).toBe(true);
  const prompt = f.prompts.find(p => p.employee === wake!.employee)?.prompt ?? '';
  expect(prompt).toContain('implementer_takeover');
  expect(prompt).toContain('系统会继续自动重试');
  expect(f.openActions()[0]).toMatchObject({ reason: 'implementer_unavailable', taskId: 'gone-task' });
});

test('a known short quota cooldown stays a wait, not a manager takeover', async () => {
  const f = fixture([{ id: 'quota-wait', state: 'ready', implementer: 'eng-1', repoPath: OPS }]);
  f.setStatus('agent-eng-1', 'error');
  f.setError('agent-eng-1', 'Your workspace is out of credits. Add credits to continue.');
  f.failReload(true);
  f.health.set('codex', { provider: 'codex', state: 'exhausted', failures: 1, until: 1_000_000 + 3600, lastError: 'out of credits' });
  const result = await f.tick();
  expect(result.woke.filter(w => w.task === 'quota-wait')).toHaveLength(0);
  expect(f.openActions()).toHaveLength(0);
  const codes = f.last!.dispatchVerdicts().find(v => v.taskId === 'quota-wait')?.reasons.map(reason => reason.code) ?? [];
  expect(codes).not.toContain('implementer_quota');
});

test('a contributors read failure keeps an open todo instead of treating it as resolved', async () => {
  const f = fixture([{ id: 'read-fail', state: 'ready', repoPath: OPS }]);
  await f.tick();
  expect(f.openActions()).toHaveLength(1);
  f.failContributors(true);
  const result = await f.tick();
  expect(result.woke.filter(w => w.task === 'read-fail')).toHaveLength(0);
  expect(f.openActions()).toHaveLength(1);
  const codes = f.last!.dispatchVerdicts().find(v => v.taskId === 'read-fail')?.reasons.map(reason => reason.code) ?? [];
  expect(codes).toContain('unknown');
});

test('manager todos group by the task repository', async () => {
  const f = fixture([
    { id: 'repo-a', state: 'ready', repoPath: PROJ_A },
    { id: 'repo-b', state: 'ready', repoPath: PROJ_B },
  ]);
  const result = await f.tick();
  expect(result.woke.filter(w => w.task === 'repo-a' || w.task === 'repo-b')).toHaveLength(2);
  expect(new Set(result.woke.map(w => w.employee)).size).toBe(2);
  expect(f.readWorkspaceCalls.map(call => call.taskId).sort()).toEqual(['repo-a', 'repo-b']);
  // Sidecar sessions run in their private comm dir; repo grouping is proven by readWorkspace's anchors.
  expect(f.prompts).toHaveLength(2);
  expect(f.openActions()).toHaveLength(2);
});

test('MR02: same open episode does not wake a second GM after throttle expiry, version change or restart', async () => {
  const f = fixture([{ id: 'mr02-one-episode', state: 'ready', repoPath: OPS }]);
  const first = await f.tick();
  const one = first.woke.find(w => w.task === 'mr02-one-episode')!;
  expect(one).toBeDefined();
  expect(f.agents.get(`agent-${one.employee}`)?.status).toBe('running');
  // The task/open episode and first GM stay unchanged; only time and an ordinary version bump move.
  f.rows[0]!.version += 1;
  for (const entry of f.dispatches.values()) entry.at -= DEFAULT_CONFIG.redispatchMinutes * 60 + 1;
  const second = await f.tick();
  expect(second.woke.filter(w => w.task === 'mr02-one-episode')).toHaveLength(0);
  expect(f.openActions()).toHaveLength(1);
  expect([...f.wakes.values()].filter(w => w.state === 'running')).toHaveLength(1);
  expect([...f.wakes.values()][0]!.attempt).toBe(1);
});

test('MR02: a definite ended turn retries once after the throttle, then running suppresses again', async () => {
  const f = fixture([{ id: 'mr02-retry', state: 'ready', repoPath: OPS }]);
  const first = await f.tick();
  const firstWake = first.woke.find(w => w.task === 'mr02-retry')!;
  const key = [...f.wakes.keys()][0]!;
  f.setStatus(`agent-${firstWake.employee}`, 'idle');
  f.ageWake(key, 120);
  for (const entry of f.dispatches.values()) entry.at -= DEFAULT_CONFIG.redispatchMinutes * 60 + 1;
  const second = await f.tick();
  expect(second.woke.filter(w => w.task === 'mr02-retry')).toHaveLength(1);
  expect([...f.wakes.values()][0]).toMatchObject({ state: 'running', attempt: 2 });
  expect(f.openActions()).toHaveLength(1);
  for (const entry of f.dispatches.values()) entry.at -= DEFAULT_CONFIG.redispatchMinutes * 60 + 1;
  const third = await f.tick();
  expect(third.woke.filter(w => w.task === 'mr02-retry')).toHaveLength(0);
});

test('MR02: unknown or unreadable session state keeps ownership and never wakes a second GM', async () => {
  const f = fixture([{ id: 'mr02-unknown', state: 'ready', repoPath: OPS }]);
  const first = await f.tick();
  const firstWake = first.woke.find(w => w.task === 'mr02-unknown')!;
  const key = [...f.wakes.keys()][0]!;
  f.setStatus(`agent-${firstWake.employee}`, 'unknown');
  for (const entry of f.dispatches.values()) entry.at -= DEFAULT_CONFIG.redispatchMinutes * 60 + 1;
  const second = await f.tick();
  expect(second.woke.filter(w => w.task === 'mr02-unknown')).toHaveLength(0);
  expect([...f.wakes.values()][0]).toMatchObject({ state: 'unknown', attempt: 1 });
  expect(f.openActions()).toHaveLength(1);
  expect(f.notices.has('manager-wake-unknown:mr02-unknown')).toBe(true);
  // A failed status read is also unknown, not idle.
  f.failStatus(true);
  for (const entry of f.dispatches.values()) entry.at -= DEFAULT_CONFIG.redispatchMinutes * 60 + 1;
  const third = await f.tick();
  expect(third.woke.filter(w => w.task === 'mr02-unknown')).toHaveLength(0);
  // Once the turn is provably ended, the existing throttle allows exactly one controlled retry.
  f.failStatus(false);
  f.setStatus(`agent-${firstWake.employee}`, 'idle');
  f.ageWake(key, 120);
  for (const entry of f.dispatches.values()) entry.at -= DEFAULT_CONFIG.redispatchMinutes * 60 + 1;
  const fourth = await f.tick();
  expect(fourth.woke.filter(w => w.task === 'mr02-unknown')).toHaveLength(1);
});

test('MR02: an in-flight episode is excluded from a mixed repo group while a new episode wakes', async () => {
  const f = fixture([{ id: 'mr02-a', state: 'ready', repoPath: OPS }]);
  const first = await f.tick();
  expect(first.woke.find(w => w.task === 'mr02-a')).toBeDefined();
  for (const entry of f.dispatches.values()) entry.at -= DEFAULT_CONFIG.redispatchMinutes * 60 + 1;
  f.addTask({ id: 'mr02-b', state: 'ready', repoPath: OPS });
  const second = await f.tick();
  expect(second.woke.map(w => w.task)).toContain('mr02-b');
  expect(second.woke.map(w => w.task)).not.toContain('mr02-a');
  const prompt = f.prompts.at(-1)?.prompt ?? '';
  expect(prompt).toContain('mr02-b');
  expect(prompt).not.toContain('mr02-a');
  expect(f.openActions()).toHaveLength(2);
});

test('MR02: explicit blockedTo=gm uses the same in-flight ownership', async () => {
  const f = fixture([{ id: 'mr02-explicit', state: 'blocked', blockedTo: 'gm', repoPath: OPS }]);
  const first = await f.tick();
  expect(first.woke.find(w => w.task === 'mr02-explicit')).toBeDefined();
  for (const entry of f.dispatches.values()) entry.at -= DEFAULT_CONFIG.redispatchMinutes * 60 + 1;
  const second = await f.tick();
  expect(second.woke.filter(w => w.task === 'mr02-explicit')).toHaveLength(0);
  expect([...f.wakes.values()][0]).toMatchObject({ state: 'running', attempt: 1 });
});

test('MR02: candidate-free assignment waits without acquiring a pending attempt', async () => {
  const f = fixture([{ id: 'mr02-prefail', state: 'ready', repoPath: OPS }]);
  f.defs[0]!.enabled = false;
  const first = await f.tick();
  expect(first.woke.filter(w => w.task === 'mr02-prefail')).toHaveLength(0);
  expect(f.wakes.size).toBe(0);
  f.defs[0]!.enabled = true;
  const second = await f.tick();
  expect(second.woke.filter(w => w.task === 'mr02-prefail')).toHaveLength(1);
});

test('MR02: a spawn that starts and loses its result stays unknown, not a second wake', async () => {
  const f = fixture([{ id: 'mr02-spawn-lost', state: 'ready', repoPath: OPS }]);
  f.failSpawnAfterStart(true);
  const first = await f.tick();
  expect(first.woke.filter(w => w.task === 'mr02-spawn-lost')).toHaveLength(0);
  expect([...f.wakes.values()][0]).toMatchObject({ state: 'unknown' });
  for (const entry of f.dispatches.values()) entry.at -= DEFAULT_CONFIG.redispatchMinutes * 60 + 1;
  const second = await f.tick();
  expect(second.woke.filter(w => w.task === 'mr02-spawn-lost')).toHaveLength(0);
  expect([...f.wakes.values()][0]).toMatchObject({ state: 'unknown' });
});

test('MR02: an old attempt cannot finish a newer attempt', async () => {
  const f = fixture([{ id: 'mr02-stale-event', state: 'ready', repoPath: OPS }]);
  await f.tick();
  const oldRow = [...f.wakes.values()][0]!;
  const oldClaim = f.wf.wakeClaim(oldRow);
  expect(await f.wf.finishManagerWake(oldClaim, 'finished', 'turn ended')).toBe(true);
  for (const entry of f.dispatches.values()) entry.at -= DEFAULT_CONFIG.redispatchMinutes * 60 + 1;
  const second = await f.tick();
  expect(second.woke.filter(w => w.task === 'mr02-stale-event')).toHaveLength(1);
  const newRow = [...f.wakes.values()][0]!;
  expect(newRow.attempt).toBe(2);
  expect(await f.wf.finishManagerWake(oldClaim, 'finished', 'late old event')).toBe(false);
  expect([...f.wakes.values()][0]!.state).not.toBe('finished');
});


test('MR02: ticks inside the throttle never release a running owner for a later second wake', async () => {
  const f = fixture([{ id: 'mr02-throttle-owner', state: 'ready', repoPath: OPS }]);
  const first = await f.tick();
  expect(first.woke.find(w => w.task === 'mr02-throttle-owner')).toBeDefined();
  const key = [...f.wakes.keys()][0]!;
  const inThrottle = await f.tick();
  expect(inThrottle.woke.filter(w => w.task === 'mr02-throttle-owner')).toHaveLength(0);
  expect(f.wakeFor(key)).toMatchObject({ state: 'running', attempt: 1 });
  for (const entry of f.dispatches.values()) entry.at -= DEFAULT_CONFIG.redispatchMinutes * 60 + 1;
  const afterExpiry = await f.tick();
  expect(afterExpiry.woke.filter(w => w.task === 'mr02-throttle-owner')).toHaveLength(0);
  expect(f.wakeFor(key)).toMatchObject({ state: 'running', attempt: 1 });
});

test('MR02: an archived session releases ownership for exactly one controlled retry', async () => {
  const f = fixture([{ id: 'mr02-archived', state: 'ready', repoPath: OPS }]);
  const first = await f.tick();
  const firstWake = first.woke.find(w => w.task === 'mr02-archived')!;
  f.setStatus(`agent-${firstWake.employee}`, 'archived');
  for (const entry of f.dispatches.values()) entry.at -= DEFAULT_CONFIG.redispatchMinutes * 60 + 1;
  const second = await f.tick();
  expect(second.woke.filter(w => w.task === 'mr02-archived')).toHaveLength(1);
  expect([...f.wakes.values()][0]).toMatchObject({ state: 'running', attempt: 2 });
});


test('MR02: unreadable wake ownership keeps the todo and never wakes a second GM', async () => {
  const f = fixture([{ id: 'mr02-wake-read-fail', state: 'ready', repoPath: OPS }]);
  await f.tick();
  expect([...f.wakes.values()][0]).toMatchObject({ state: 'running', attempt: 1 });
  f.failWakeRead(true);
  for (const entry of f.dispatches.values()) entry.at -= DEFAULT_CONFIG.redispatchMinutes * 60 + 1;
  const second = await f.tick();
  expect(second.woke.filter(w => w.task === 'mr02-wake-read-fail')).toHaveLength(0);
  expect(f.openActions()).toHaveLength(1);
  expect([...f.wakes.values()][0]).toMatchObject({ state: 'running', attempt: 1 });
});

test('MR02: unreadable manager-action set keeps wake ownership and the durable action', async () => {
  const f = fixture([{ id: 'mr02-action-read-fail', state: 'ready', repoPath: OPS }]);
  await f.tick();
  f.failActionRead(true);
  for (const entry of f.dispatches.values()) entry.at -= DEFAULT_CONFIG.redispatchMinutes * 60 + 1;
  const second = await f.tick();
  expect(second.woke.filter(w => w.task === 'mr02-action-read-fail')).toHaveLength(0);
  expect(f.actions.get([...f.actions.keys()][0]!)?.status).toBe('open');
  expect([...f.wakes.values()][0]).toMatchObject({ state: 'running', attempt: 1 });
});

test('MR02: task leaving the execute queue closes the open action and wake ownership', async () => {
  const f = fixture([{ id: 'mr02-leaves-queue', state: 'ready', repoPath: OPS }]);
  await f.tick();
  f.rows[0]!.state = 'done';
  f.setStatus('agent-gm-codex-1', 'idle');
  const result = await f.tick();
  expect(result.woke.filter(w => w.task === 'mr02-leaves-queue')).toHaveLength(0);
  expect(f.openActions()).toHaveLength(0);
  expect([...f.wakes.values()][0]).toMatchObject({ state: 'finished' });
});

test('MR02: a pending attempt without external start is released after the conservative grace', async () => {
  const f = fixture([{ id: 'mr02-pending-crash', state: 'ready', repoPath: OPS }]);
  await f.tick();
  const row = [...f.wakes.values()][0]!;
  row.state = 'pending';
  row.externalStartedAt = undefined;
  row.agent = undefined;
  f.ageWake(row.key, 121);
  for (const entry of f.dispatches.values()) entry.at -= DEFAULT_CONFIG.redispatchMinutes * 60 + 1;
  const second = await f.tick();
  expect(second.woke.filter(w => w.task === 'mr02-pending-crash')).toHaveLength(1);
  expect([...f.wakes.values()][0]).toMatchObject({ state: 'running', attempt: 2 });
});


test('no eligible GM never acquires/releases wake claims on repeated ticks; recovery wakes immediately', async () => {
  const f = fixture([{ id: 'fixture-no-gm', blockedTo: 'gm' }]);
  f.defs.find(d => d.role === 'gm')!.enabled = false;
  for (let n = 0; n < 4; n++) await f.tick(); // fixture recreates Dispatcher: includes restart behavior
  expect(f.wakes.size).toBe(0);
  expect(f.prompts).toHaveLength(0);
  const raised = [...f.notices.entries()].find(([k]) => k.startsWith('gm-unavailable:'));
  expect(raised?.[1].text).toContain('编制已停用');
  f.defs.find(d => d.role === 'gm')!.enabled = true;
  expect((await f.tick()).woke.some(w => w.task === 'fixture-no-gm')).toBe(true);
});

test('busy managers filling the workspace are a queue, not an outage; a queue past an hour reaches the owner', async () => {
  const f = fixture([{ id: 'q-busy', blockedTo: 'gm' }]);
  const gm = f.defs.find(d => d.role === 'gm')!;
  gm.maxInstances = 1;
  f.instances.push({ id: 'gm-busy', def: gm.id, role: 'gm', provider: gm.provider, model: gm.model, paseoAgentId: 'agent-gm-busy',
    cwd: OPS, repoHome: OPS, workspaceScope: 'maintenance', credential: 'cred-gm-busy' });
  f.agents.set('agent-gm-busy', { id: 'agent-gm-busy', status: 'running' });
  const open = () => [...f.notices.entries()].filter(([k, n]) => k.startsWith('gm-unavailable:') && !n.resolved);
  const first = await f.tick();
  expect(first.decisions).toContain('gm-queued:q-busy');
  expect(open()).toHaveLength(0);
  // The same seats held for over an hour since the gate opened: now the owner hears about it.
  f.rows[0]!.dispatchBlockedSince = 1_000_000 - 61 * 60;
  await f.tick();
  expect(open()).toHaveLength(1);
  expect(open()[0]![1].text).toContain('连续占满');
});

test('a seat held by a manager that is down is an outage, not a queue', async () => {
  const f = fixture([{ id: 'q-down', blockedTo: 'gm' }]);
  const gm = f.defs.find(d => d.role === 'gm')!;
  gm.maxInstances = 1;
  f.instances.push({ id: 'gm-down', def: gm.id, role: 'gm', provider: gm.provider, model: gm.model, paseoAgentId: 'agent-gm-down',
    cwd: OPS, repoHome: OPS, workspaceScope: 'maintenance', credential: 'cred-gm-down' });
  f.agents.set('agent-gm-down', { id: 'agent-gm-down', status: 'error' });
  const report = await f.tick();
  expect(report.decisions).not.toContain('gm-queued:q-down');
});

test('a gm-unavailable notice closes once its workspace has no manager work left, and stays while it does', async () => {
  const f = fixture([{ id: 'stale-a', blockedTo: 'gm' }, { id: 'stale-b', blockedTo: 'gm' }]);
  (f.rows[1] as { goalId?: string }).goalId = 'goal-b';
  f.defs.find(d => d.role === 'gm')!.enabled = false;
  await f.tick();
  const open = () => [...f.notices.entries()].filter(([k, n]) => k.startsWith('gm-unavailable:') && !n.resolved).map(([k]) => k);
  expect(open()).toHaveLength(2);
  // stale-a was closed by hand: its workspace has no manager-gate task any more.
  f.rows[0]!.state = 'done';
  (f.rows[0] as { blockedTo?: string }).blockedTo = undefined;
  expect((await f.tick()).decisions).toContain('gm-unavailable-cleared:gm-unavailable:/fixture/ops:maintenance');
  expect(open()).toEqual([expect.stringMatching(/:goal-b$/)]);
  // The workspace that still waits on a manager keeps its notice across passes.
  await f.tick();
  expect(open()).toHaveLength(1);
});

test('a persisted full-history model evaluation dispatches an eval employee even for quick/jev-only settings',async()=>{
  const f=fixture([]);
  f.defs.push({id:'eval-claude',role:'eval',provider:'claude',model:'group/sck-haiku',enabled:true,maxInstances:2,priority:0,weight:1,scored:0,errorStreak:0});
  const original=f.wf.config.bind(f.wf);
  f.wf.config=async()=>({...await original(),evalEnabled:true,evalEngine:'jev',evalQuickLlm:false});
  f.wf.pendingEvaluations=async()=>[{id:'long-rework',title:'long-rework',state:'done',executorRole:'engineering',reviewerRole:'qa',kind:'task',version:8,goalTier:'quick',evalAttempts:4,row:{model_eval_full_history:true}} as SupervisedTask];
  const report=await f.tick();
  expect(report.evals).toContain('long-rework');
  expect(report.woke.some(w=>w.employee.startsWith('eval-claude'))).toBe(true);
  expect(f.prompts.at(-1)?.prompt).toContain('get_model_evidence');
});


function factoryWorld() {
  const f=fixture([{id:'factory-task',state:'ready',repoPath:OPS,facts:{authors:[],reviewers:[],excluded:[],unknown:[],ambiguous:false}}]);
  const claude=f.defs.find(d=>d.role==='engineering')!;
  Object.assign(claude,{provider:'claude',model:'group/sck-haiku',quotaLimited:false});
  Object.assign(f.instances.find(i=>i.id==='eng-1')!,{provider:'claude',model:'group/sck-haiku'});
  const factory:EmployeeDef={...claude,id:'engineering-factory',provider:'factory-droid',model:'native-factory-model',quotaLimited:true,maxInstances:1};
  f.defs.push(factory);
  const addFactory=(status:string)=>{
    const inst:EmployeeInst={id:'factory-1',def:factory.id,provider:factory.provider,model:factory.model,role:factory.role,paseoAgentId:'agent-factory',cwd:OPS,repoHome:OPS,workspaceScope:'maintenance'};
    f.instances.push(inst);f.agents.set('agent-factory',{id:'agent-factory',status});return inst;
  };
  return {...f,factory,addFactory,get last(){return f.last;}};
}
test('Factory native spawn precedes idle Claude reuse and staffing never asks Jev',async()=>{
  const f=factoryWorld();let calls=0;
  const config=f.wf.config.bind(f.wf);f.wf.config=async()=>({...await config(),jevDecisions:true,jevNotifyTriage:false});
  const report=await f.tick({jev:{model:'spy',ask:async()=>{calls++;throw Error('staffing must not call Jev');}}});
  const assigned=report.woke.find(w=>w.task==='factory-task')!;
  expect(f.instances.find(i=>i.id===assigned.employee)).toMatchObject({provider:'factory-droid',model:'native-factory-model'});
  expect(assigned.spawned).toBe(true);expect(calls).toBe(0);
});
test('Factory idle reuse precedes idle Claude reuse',async()=>{
 const f=factoryWorld();f.addFactory('idle');
 expect((await f.tick()).woke.find(w=>w.task==='factory-task')).toMatchObject({employee:'factory-1',spawned:false});
});
test('Factory full seats wait rather than using idle Claude',async()=>{
 const f=factoryWorld();f.addFactory('running');
 const report=await f.tick();expect(report.woke.find(w=>w.task==='factory-task')).toBeUndefined();
 expect(f.last!.dispatchVerdicts().find(v=>v.taskId==='factory-task')!.reasons.map(r=>r.code)).toContain('factory_wait');
});
test('Factory exhausted health falls back to Claude without reopening Factory',async()=>{
 const f=factoryWorld();f.health.set('factory-droid',{provider:'factory-droid',state:'exhausted',until:2_000_000_000,failures:1});
 expect((await f.tick()).woke.find(w=>w.task==='factory-task')).toMatchObject({employee:'eng-1',spawned:false});
});
test('Factory quota floor falls back to Claude',async()=>{
 const f=factoryWorld();const config=f.wf.config.bind(f.wf);f.wf.config=async()=>({...await config(),quotaFloorPct:5,quotaWeeklyFloorPct:5});
 const report=await f.tick({quota:async()=>[{provider:'factory-droid',sessionPct:0,weeklyPct:0,fetchedAt:new Date().toISOString(),summary:'fixture exhausted'}]});
 expect(report.woke.find(w=>w.task==='factory-task')).toMatchObject({employee:'eng-1',spawned:false});
});
test('Factory provider concurrency cap waits even with spare definition seats',async()=>{
 const f=factoryWorld();f.factory.maxInstances=3;f.addFactory('running');const config=f.wf.config.bind(f.wf);
 f.wf.config=async()=>({...await config(),providerMax:{'factory-droid':1,claude:4,codex:8}});
 expect((await f.tick()).woke.find(w=>w.task==='factory-task')).toBeUndefined();
});

test('a repository difference without an explicit code repo binding never authorizes automatic takeover',async()=>{
 const f=fixture([{id:'repo-overlay-only',state:'ready',implementer:'eng-1',repoPath:PROJ_A}]);
 const calls:unknown[]=[];
 await f.tick({autoTakeover:async input=>{calls.push(input);return true;}});
 expect(calls).toEqual([]);
 expect(f.rows[0]!.implementer).toBe('eng-1');
 expect(f.last!.dispatchVerdicts().find(v=>v.taskId==='repo-overlay-only')!.dispatchable).toBe(false);
});

test('same-repo bound implementer stays assigned after an explicit code repo binding',async()=>{
 const f=fixture([{id:'same-repo',state:'ready',implementer:'eng-1',repoPath:OPS}]);
 f.rows[0]!.codeRepoPath=OPS;
 const calls:unknown[]=[];
 const report=await f.tick({autoTakeover:async input=>{calls.push(input);return true;}});
 expect(calls).toEqual([]);
 expect(report.woke.find(w=>w.task==='same-repo')?.employee).toBe('eng-1');
});


test('same repository manager work is separated by goal, not batched into one conversation', async () => {
  const f = fixture([{ id: 'goal-a-task', goalId: 'goal-a', repoPath: PROJ_A, blockedTo: 'gm' },
    { id: 'goal-b-task', goalId: 'goal-b', repoPath: PROJ_A, blockedTo: 'gm' }]);
  await f.tick();
  const managers = f.instances.filter(i => i.role === 'gm');
  expect(managers.map(i => i.workspaceScope).sort()).toEqual(['goal-a', 'goal-b']);
});


test('three Factory waiters are retained and later work spills to Claude',async()=>{
 const f=factoryWorld();f.addFactory('running');
 f.rows[0]!.row.created_at=new Date('2026-10-01T00:00:00Z') as never;
 for(let n=2;n<=5;n++){
  const t=f.addTask({id:`waiting-${n}`,state:'ready',repoPath:OPS,facts:{authors:[],reviewers:[],excluded:[],unknown:[],ambiguous:false}});
  t.row.created_at=new Date(`2026-10-0${n}T00:00:00Z`) as never;
 }
 const r=await f.tick();
 expect(r.woke.some(w=>['factory-task','waiting-2','waiting-3'].includes(w.task))).toBe(false);
 expect(r.woke.some(w=>w.task==='waiting-4')).toBe(true);
 expect(f.instances.find(i=>i.id===r.woke.find(w=>w.task==='waiting-4')!.employee)?.provider).toBe('claude');
 const again=await f.tick();expect(again.woke.some(w=>['factory-task','waiting-2','waiting-3'].includes(w.task))).toBe(false);
});

test('manager wakes share the three-job Factory backlog and allow later independent groups to spill',async()=>{
 const f=fixture([1,2,3,4].map(n=>({id:`gm-queued-${n}`,state:'blocked' as const,blockedTo:'gm' as const,repoPath:OPS,goalId:`g${n}`})));
 const fd:EmployeeDef={...f.defs[0]!,id:'gm-factory',provider:'factory-droid',model:'native',maxInstances:4};f.defs.push(fd);
 f.instances.push({id:'busy-factory-gm',def:fd.id,role:'gm',provider:'factory-droid',model:'native',paseoAgentId:'busy-factory-agent',repoHome:OPS,workspaceScope:'maintenance'});
 f.agents.set('busy-factory-agent',{id:'busy-factory-agent',status:'running'});
 const config=f.wf.config.bind(f.wf);f.wf.config=async()=>({...await config(),providerMax:{codex:8,'factory-droid':1}});
 f.rows.forEach((t,n)=>{t.row.created_at=new Date(1000+n) as never;});
 const r=await f.tick();expect(r.woke.map(w=>w.task)).toEqual(['gm-queued-4']);
 expect(f.instances.find(i=>i.id===r.woke[0]!.employee)?.provider).not.toBe('factory-droid');
});

test('review tasks retain three Factory waiting slots and overflow keeps author recusal',async()=>{
 const f=factoryWorld();f.rows.length=0;
 f.factory.role='qa';f.factory.maxInstances=1;
 const fi=f.addFactory('running');fi.role='qa';
 const q=f.defs.find(d=>d.id==='qa-codex')!;Object.assign(q,{provider:'claude',model:'group/sck-haiku',quotaLimited:false});
 Object.assign(f.instances.find(i=>i.id==='qa-1')!,{provider:'claude',model:'group/sck-haiku'});
 for(let n=1;n<=4;n++){const t=f.addTask({id:`review-${n}`,state:'review',repoPath:OPS,facts:{authors:['author'],reviewers:[],excluded:['author'],unknown:[],ambiguous:false}});t.row.created_at=new Date(n*1000) as never;}
 const r=await f.tick();expect(r.woke.map(w=>w.task)).toEqual(['review-4']);expect(r.woke[0]?.employee).toBe('qa-1');
});

test('a Factory assignment leaves three waiting slots for the remaining jobs',async()=>{
 const f=factoryWorld();f.addFactory('running');f.factory.maxInstances=2;
 const config=f.wf.config.bind(f.wf);f.wf.config=async()=>({...await config(),providerMax:{'factory-droid':2,claude:8,codex:8}});
 f.rows[0]!.row.created_at=new Date(1000) as never;
 for(let n=2;n<=5;n++){const t=f.addTask({id:`promote-${n}`,state:'ready',repoPath:OPS,facts:{authors:[],reviewers:[],excluded:[],unknown:[],ambiguous:false}});t.row.created_at=new Date(n*1000) as never;}
 const r=await f.tick();expect(r.woke.map(w=>w.task)).toEqual(['factory-task','promote-5']);
 expect(f.instances.find(i=>i.id===r.woke[0]!.employee)?.provider).toBe('factory-droid');
 expect(f.instances.find(i=>i.id===r.woke[1]!.employee)?.provider).toBe('claude');
});

test('Factory max thinking is passed independently of auto-high permission mode',async()=>{
 const f=factoryWorld();f.factory.thinking='max';let seen:unknown;
 const spawn=f.paseo.spawn.bind(f.paseo);f.paseo.spawn=async input=>{seen=input;return spawn(input);};
 await f.tick();expect(seen).toMatchObject({provider:'factory-droid',thinking:'max',mode:'auto-high'});
});

test('a live Claude implementer is not parked behind Factory that cannot legally take its code',async()=>{
 const f=factoryWorld();f.setImplementer('factory-task','eng-1');
 const r=await f.tick();expect(r.woke.find(w=>w.task==='factory-task')?.employee).toBe('eng-1');
});

test('an older executable Factory task precedes a newer Factory review sharing one provider slot',async()=>{
 const f=factoryWorld();f.rows[0]!.row.created_at=new Date(1000) as never;
 f.defs.push({...f.factory,id:'qa-factory',role:'qa'});
 const review=f.addTask({id:'new-review',state:'review',repoPath:OPS,facts:{authors:[],reviewers:[],excluded:[],unknown:[],ambiguous:false}});review.row.created_at=new Date(2000) as never;
 const cfg=f.wf.config.bind(f.wf);f.wf.config=async()=>({...await cfg(),providerMax:{'factory-droid':1,claude:8,codex:8}});
 const r=await f.tick();expect(r.woke.map(w=>w.task)).toEqual(['factory-task']);
 expect(f.instances.find(i=>i.id===r.woke[0]!.employee)?.provider).toBe('factory-droid');
});

test('an older runnable Factory manager wake precedes a newer execute task with a shared slot',async()=>{
 const f=factoryWorld();f.rows[0]!.row.created_at=new Date(2000) as never;
 f.defs.push({...f.factory,id:'gm-factory',role:'gm'});
 const gm=f.addTask({id:'old-manager',state:'blocked',blockedTo:'gm',repoPath:OPS});gm.row.created_at=new Date(1000) as never;
 const cfg=f.wf.config.bind(f.wf);f.wf.config=async()=>({...await cfg(),providerMax:{'factory-droid':1,claude:8,codex:8}});
 const r=await f.tick();expect(r.woke.map(w=>w.task)).toEqual(['old-manager']);
 expect(f.instances.find(i=>i.id===r.woke[0]!.employee)?.provider).toBe('factory-droid');
});

test('goal employee closed by idle cleanup sleeps across ticks and reuses its identity for later work',async()=>{
 const f=fixture([]);f.setStatus('agent-eng-1','closed');let reloads=0;f.paseo.reload=async()=>{reloads++;};
 const first=await f.tick();expect(first.retired).not.toContain('eng-1');expect(reloads).toBe(0);
 expect(f.last!.sessionSnapshot().sessions.get('eng-1')).toMatchObject({status:'closed',state:'sleeping'});
 const second=await f.tick();expect(second.retired).not.toContain('eng-1');expect(reloads).toBe(0);
 f.addTask({id:'later',state:'ready',facts:{authors:[],reviewers:[],excluded:[],unknown:[],ambiguous:false}});
 const report=await f.tick();expect(report.woke.find(w=>w.task==='later')).toMatchObject({employee:'eng-1',spawned:false});
 expect(f.sends.some(s=>s.agentId==='agent-eng-1')).toBe(true);expect(f.spawnCwds).toHaveLength(0);
});
test('sleeping Claude seats do not displace a new Factory seat in the same workspace',async()=>{
 const f=factoryWorld();f.setStatus('agent-eng-1','closed');
 for(let n=0;n<6;n++){const base=f.instances.find(i=>i.id==='eng-1')!;const id=`claude-extra-${n}`;f.instances.push({...base,id,paseoAgentId:'agent-'+id});f.agents.set('agent-'+id,{id:'agent-'+id,status:'closed'});}
 const r=await f.tick();const assigned=r.woke.find(w=>w.task==='factory-task')!;expect(assigned.spawned).toBe(true);expect(f.instances.find(i=>i.id===assigned.employee)?.provider).toBe('factory-droid');expect(r.retired).not.toContain('eng-1');
});

test('an old holder notice cannot wake a sleeping employee without a legal assignment',async()=>{
 const f=fixture([]);f.setStatus('agent-eng-1','closed');let delivered=0;
 Object.assign(f.wf,{pendingHolderNotices:async()=>[{noticeKey:'old-notice',taskId:'old-task',holder:'eng-1',kind:'revoked',text:'已撤租'}],markHolderNotices:async()=>{delivered++;return 1;}});
 const r=await f.tick();expect(f.sends).toHaveLength(0);expect(delivered).toBe(0);expect(r.decisions).toContain('holder-notice-wait:old-task');expect(r.retired).not.toContain('eng-1');
});

test('memory pressure sleeps an hour-idle employee and reuses the same identity once the probe recovers',async()=>{
 const f=fixture([{id:'lru-work',state:'ready',facts:{authors:[],reviewers:[],excluded:[],unknown:[],ambiguous:false}}]);
 const target=f.instances.find(i=>i.id==='eng-1')!;target.idleSince=990000;target.lastWakeAt=980000;
 const original=f.wf.config.bind(f.wf);let closed=0;
 Object.assign(f.wf,{config:async()=>({...await original(),minFreeMemMb:2048}),observeSessionIdle:async()=>{},confirmRuntimeSleep:async()=>true,reserveRuntimeSleep:async(i:EmployeeInst,now:number)=>{i.runtimeSleepRequestedAt=now;return true},releaseRuntimeSleep:async()=>{}});
 Object.assign(f.paseo,{sleep:async(id:string)=>{closed++;f.setStatus(id,'closed')}});
 const report=await f.tick({hostResources:()=>({freeMemMb:100,freeDiskMb:99999,memoryPressure:closed?1:2})});
 expect(closed).toBe(1);expect(report.retired).toEqual([]);expect(report.woke.find(w=>w.task==='lru-work')).toMatchObject({employee:'eng-1',spawned:false});expect(f.spawnCwds).toEqual([]);
});
test('memory pressure waits when every employee is idle less than an hour',async()=>{
 const f=fixture([{id:'lru-young',state:'ready',facts:{authors:[],reviewers:[],excluded:[],unknown:[],ambiguous:false}}]);
 const original=f.wf.config.bind(f.wf);let closed=0;
 Object.assign(f.wf,{config:async()=>({...await original(),minFreeMemMb:2048}),observeSessionIdle:async()=>{},confirmRuntimeSleep:async()=>true,reserveRuntimeSleep:async()=>true,releaseRuntimeSleep:async()=>{}});
 for(const i of f.instances){i.idleSince=999000;i.lastWakeAt=990000}
 Object.assign(f.paseo,{sleep:async()=>{closed++}});
 const r=await f.tick({hostResources:()=>({freeMemMb:100,freeDiskMb:99999,memoryPressure:2})});
 expect(r.skipped).toBe('resources');expect(closed).toBe(0);expect(r.woke).toEqual([]);expect(r.retired).toEqual([]);
});
