import { expect, test } from 'bun:test';
import { Dispatcher, type SidecarBridge } from '../src/dispatcher/dispatcher.ts';
import type { PaseoGateway } from '../src/dispatcher/paseo.ts';
import { DEFAULT_CONFIG, managerWakeKey, type EmployeeDef, type EmployeeInst, type ManagerWakeClaim, type ManagerWakeInput, type ManagerWakeRow, type ProviderHealth, type SupervisedTask, type Workforce } from '../src/workforce.ts';
import type { OwnerDesk } from '../src/owner.ts';
import type { ClaimResult, TaskView, WorktreeAssignment } from '../src/contracts.ts';
import { managerActionKey } from '../src/dispatcher/dispatch-blocked.ts';
import { RECOVERY_READ_PATHS } from '../src/recovery-read.ts';

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
  blockedTo?: 'owner';
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
    { id: 'owner-codex', role: 'owner', provider: 'codex', model: 'fixture', enabled: true, maxInstances: 4, priority: 0, weight: 1, scored: 0, errorStreak: 0 },
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
  const recoveryAdopts: Array<{ inst: string; grantId?: string }> = [];
  let recoveryGrants: Array<{ id: string; employeeId: string; taskId: string; alias: string; paths: string[]; expiresAt: string; state: string }> = [];
  let failRecoveryAdopt = false;
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
    activeRecoveryGrants: async () => recoveryGrants,
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
    adoptRecovery: async (inst, grantId) => {
      recoveryAdopts.push({ inst: inst.id, grantId });
      if (failRecoveryAdopt) throw new Error('execution lease held');
      return { bound: grantId };
    },
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
    recoveryAdopts,
    setRecoveryGrants(grants: typeof recoveryGrants) { recoveryGrants = grants; },
    failRecoveryAdopt(value: boolean) { failRecoveryAdopt = value; },
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

// Manager wake tests were removed with the gm role. This file keeps the shared fixture used by
// dispatcher-standby and other suites.
export default {};
