/**
 * SYS05 · Dispatch admission for waiting tasks (AC01/AC06).
 *
 * A waiting task takes no provider seat and no employee: the queue excludes it before any pool, spawn or claim is
 * attempted. A due condition is released once by the store, and only the tick that actually sees the released
 * condition wakes an employee. This is exercised with a lightweight workforce stand-in; the real CAS is covered
 * by tests/wait-store.fork.test.ts.
 */
import { expect, test } from 'bun:test';
import { Dispatcher, type SidecarBridge } from '../src/dispatcher/dispatcher.ts';
import type { PaseoGateway } from '../src/dispatcher/paseo.ts';
import { DEFAULT_CONFIG, type EmployeeDef, type EmployeeInst, type SupervisedTask, type Workforce } from '../src/workforce.ts';
import type { OwnerDesk } from '../src/owner.ts';
import type { ClaimResult, WorktreeAssignment } from '../src/contracts.ts';

const OPS = '/fixture/ops';

function sharedTree(repo: string): WorktreeAssignment {
  return { id: `wt-${repo}`, repo, worktreePath: `${repo}-sck-shared`, mode: 'shared', branch: 'main',
    intent: { kind: 'read' }, discipline: 'fixture' };
}

function fixture(initial: SupervisedTask[]) {
  const def: EmployeeDef = {
    id: 'content-codex', role: 'ai-content', provider: 'codex', model: 'fixture',
    enabled: true, maxInstances: 4, priority: 0, weight: 1, scored: 0, errorStreak: 0,
  };
  const rows = initial;
  const instances: EmployeeInst[] = [];
  const agents = new Map<string, { id: string; status: string }>();
  const claimed: string[] = [];
  let next = 0;
  let releaseCalls = 0;
  let dueOnFirstSweep: ((task: SupervisedTask) => boolean) | undefined;

  const wf = {
    config: async () => ({
      ...DEFAULT_CONFIG, quotaFloorPct: 0, quotaWeeklyFloorPct: 0, sessionMaxWakes: 0, sessionMaxInputK: 0,
      evalEnabled: false, jevDecisions: false, maxRunning: 8, providerMax: { codex: 8 },
    }),
    defs: async () => [def],
    serverNow: async () => 1_000_000,
    insts: async () => instances,
    tasks: async () => rows,
    providerHealth: async () => new Map(),
    newKey: () => `fixture-key-${++next}`,
    openManagerWakes: async () => [],
    acquireManagerWake: async (input: unknown, token: string) => ({ key: token, token, attempt: 1, input }),
    markManagerWakeRunning: async () => true,
    finishManagerWake: async () => true,
    lastDispatch: async () => undefined,
    recordDispatch: async () => {},
    touchWake: async () => {},
    defHealthy: async () => {},
    defFailure: async () => 1,
    pendingEvaluations: async () => [],
    projectRepos: async () => [],
    doneTaskIds: async () => [],
    markHealthy: async () => {},
    markExhausted: async () => {},
    disableDef: async () => {},
    contributors: async () => ({ authors: [], excluded: [], implementer: undefined, ambiguous: false }),
    // The store contract: release due conditions once per sweep. The test controls which one is due.
    releaseDueWaits: async () => {
      releaseCalls++;
      const released: Array<{ waitKey: string; taskId: string }> = [];
      if (releaseCalls === 1) {
        for (const row of rows) {
          if (!row.waitState || !dueOnFirstSweep?.(row)) continue;
          row.waitState = undefined;
          row.state = 'ready';
          released.push({ waitKey: row.waitKey ?? row.id, taskId: row.id });
        }
      }
      return { released, held: [], expired: [] };
    },
    waitHandoffCards: async () => [],
    dueWaitChecks: async () => [],
    spawnInst: async () => {
      const inst: EmployeeInst = { id: `inst-${++next}`, def: def.id, role: def.role, provider: def.provider, model: def.model, credential: `cred-${next}` };
      instances.push(inst);
      return inst;
    },
    bind: async (id: string, binding: { agentId: string; cwd: string; repoHome?: string }) => {
      Object.assign(instances.find(inst => inst.id === id)!, { paseoAgentId: binding.agentId, cwd: binding.cwd, repoHome: binding.repoHome ?? binding.cwd });
    },
    retire: async () => {}, rotate: async (id: string) => `rotated-${id}`, revokeLease: async () => false,
    extendLease: async () => true, writeCredentialFile: () => '/dev/null',
  };

  const owner = {
    applyPending: async () => [], resolveNotice: async () => {}, openNotices: async () => [],
    triagePending: async () => [], raiseNotice: async () => false,
  };

  const paseo: PaseoGateway = {
    list: async () => agents,
    status: async id => agents.get(id) ? { status: agents.get(id)!.status, pendingPermissions: 0 } : undefined,
    lastError: async () => '', logsTail: async () => '', lastInputTokens: async () => 0,
    spawn: async binding => { const id = `agent-${binding.labels.employee_id}`; agents.set(id, { id, status: 'running' }); return id; },
    send: async id => { agents.get(id)!.status = 'running'; },
    stop: async () => {}, reload: async () => {}, archive: async () => {},
    listWorkspaces: async () => [], listProjects: async () => [], archiveWorkspace: async () => {}, deleteProject: async () => {},
  };

  const sidecar: SidecarBridge = {
    env: inst => ({ SCK_COMM_DIR: `/tmp/${inst.id}`, SCK_COMM_KEY: 'k' }),
    canReuse: () => true, detachAgent: () => {},
    claim: async (inst, task) => {
      claimed.push(task.id);
      const row = rows.find(item => item.id === task.id)!;
      row.state = 'doing';
      row.currentEmployee = inst.id;
      row.leaseExpiresAt = 1_000_600;
      return { task: { ...task, state: 'doing', currentEmployee: inst.id, version: task.version + 1 },
        deliveryId: `del-${task.id}`, fence: 1, leaseExpiresAt: new Date(1_000_600_000).toISOString(), history: [] } as unknown as ClaimResult;
    },
    writeScope: async () => [], claimDenial: () => undefined, bindAgent: () => {},
    commDirFor: id => `/tmp/comm/${id}`, scratchDirFor: instId => `/tmp/${instId}-scratch`,
    releaseClaim: async () => {}, releaseWorkspace: async () => {},
    readWorkspace: async () => sharedTree(OPS),
  };

  const dispatcher = new Dispatcher({
    workforce: wf as unknown as Workforce, owner: owner as unknown as OwnerDesk, paseo, sidecar,
    env: { opsRepo: OPS, sckBin: '/bin/sck', paseoBin: '/bin/paseo' }, rand: () => 0,
  });
  return {
    dispatcher, claimed, instances,
    dueWhen: (predicate: (task: SupervisedTask) => boolean) => { dueOnFirstSweep = predicate; },
    releaseCalls: () => releaseCalls,
  };
}

function task(id: string, over: Partial<SupervisedTask> = {}): SupervisedTask {
  return {
    id, title: id, state: 'ready', executorRole: 'ai-content', reviewerRole: 'qa', kind: 'task',
    version: 1, evalAttempts: 0, repoPath: OPS,
    row: { id, state: 'ready', executor_role: 'ai-content', reviewer_role: 'qa', version: 1 },
    ...over,
  } as unknown as SupervisedTask;
}

test('a waiting task is never in the work queue: zero spawn, zero claim, zero provider seat', async () => {
  const waiting = task('waiting-1', {
    waitState: 'waiting', waitKind: 'time', waitNotBefore: 1_000_000_000, waitKey: 'waiting-1:k',
  });
  const ordinary = task('ordinary-1');
  const f = fixture([waiting, ordinary]);
  const report = await f.dispatcher.tick();
  // Only the ordinary task is dispatched; the waiting one never reaches the pool or the sidecar.
  expect(report.woke.map(item => item.task)).toEqual(['ordinary-1']);
  expect(f.claimed).toEqual(['ordinary-1']);
  expect(f.instances).toHaveLength(1);
  // A second tick with the condition still false dispatches nothing more for it.
  const again = await f.dispatcher.tick();
  expect(again.woke).toHaveLength(0);
  expect(f.claimed).toEqual(['ordinary-1']);
});

test('a due condition is released once: the first tick wakes, the next tick has nothing to release', async () => {
  const waiting = task('due-1', {
    waitState: 'waiting', waitKind: 'time', waitNotBefore: 999_999_000, waitKey: 'due-1:k',
  });
  const f = fixture([waiting]);
  f.dueWhen(candidate => candidate.id === 'due-1');
  const first = await f.dispatcher.tick();
  expect(first.woke.map(item => item.task)).toEqual(['due-1']);
  expect(f.releaseCalls()).toBe(1);
  f.dueWhen(() => false);
  const second = await f.dispatcher.tick();
  expect(second.woke).toHaveLength(0);
  expect(f.releaseCalls()).toBe(2);
  expect(f.claimed).toEqual(['due-1']);
});
