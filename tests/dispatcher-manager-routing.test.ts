import { expect, test } from 'bun:test';
import { Dispatcher, type SidecarBridge } from '../src/dispatcher/dispatcher.ts';
import type { PaseoGateway } from '../src/dispatcher/paseo.ts';
import { DEFAULT_CONFIG, type EmployeeDef, type EmployeeInst, type ProviderHealth, type SupervisedTask, type Workforce } from '../src/workforce.ts';
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
  const now = 1_000_000;
  let next = 0;
  let failReload = false;
  let contributorsFail = false;

  const rows: SupervisedTask[] = specs.map(spec => {
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
    return task;
  });

  const addInstance = (def: EmployeeDef, id: string, status = 'idle') => {
    const inst: EmployeeInst = { id, role: def.role, def: def.id, provider: def.provider, model: def.model,
      paseoAgentId: `agent-${id}`, cwd: OPS, repoHome: OPS, credential: `cred-${id}` };
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
    openManagerActions: async () => [...actions.values()].filter(action => action.status === 'open'),
    closeManagerAction: async (action: ActionRow, resolution: string) => {
      const row = actions.get(action.key);
      if (row && row.status === 'open') { row.status = 'closed'; row.resolution = resolution; }
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
        repoHome: binding.repoHome ?? binding.cwd, model: binding.model });
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
    status: async id => agents.get(id) ? { status: agents.get(id)!.status, pendingPermissions: 0 } : undefined,
    lastError: async id => errors.get(id) ?? '',
    logsTail: async () => '',
    lastInputTokens: async () => 0,
    spawn: async input => {
      const id = `agent-${input.labels.employee_id}`;
      agents.set(id, { id, status: 'running' });
      prompts.push({ employee: input.labels.employee_id!, prompt: input.prompt, cwd: input.cwd });
      spawnCwds.push(input.cwd);
      return id;
    },
    send: async (id, prompt) => {
      agents.get(id)!.status = 'running';
      sends.push({ agentId: id, prompt });
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
    claim: async (inst, task) => task && inst.role === task.executorRole
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
  const tick = async () => {
    last = new Dispatcher({ workforce: wf as unknown as Workforce, owner: owner as unknown as OwnerDesk,
      paseo, sidecar, env: { opsRepo: OPS, sckBin: '/bin/sck', paseoBin: '/bin/paseo' }, rand: () => 0 });
    return last.tick();
  };

  return {
    tick,
    get last() { return last; },
    rows, instances, agents, errors, health, facts, prompts, sends, spawnCwds, readWorkspaceCalls, notices, actions, dispatches,
    setStatus(agentId: string, status: string) { agents.get(agentId)!.status = status; },
    setError(agentId: string, error: string) { errors.set(agentId, error); },
    failReload(value: boolean) { failReload = value; },
    failContributors(value: boolean) { contributorsFail = value; },
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
