import { describe, expect, test } from 'bun:test';
import { Dispatcher, type SidecarBridge } from '../src/dispatcher/dispatcher.ts';
import type { PaseoGateway } from '../src/dispatcher/paseo.ts';
import { DEFAULT_CONFIG, type EmployeeDef, type EmployeeInst, type SupervisedTask, type Workforce } from '../src/workforce.ts';
import type { OwnerDesk } from '../src/owner.ts';
import type { WorktreeAssignment } from '../src/contracts.ts';

const OPS = '/fixture/ops';
const PROJ_A = '/fixture/proj-a';
const PROJ_B = '/fixture/proj-b';

function sharedTree(repo: string): WorktreeAssignment {
  return {
    id: `wt-${repo}`,
    repo,
    worktreePath: `${repo}-sck-shared`,
    mode: 'shared',
    branch: 'main',
    intent: { kind: 'read' },
    discipline: 'fixture',
  };
}

/** Light fixture: owner-aware dispatcher with blocked-to-owner tasks; records owner notices and any dispatch side effects. */
function fixture(tasks: Array<{ id: string; repoPath?: string }>) {
  const def: EmployeeDef = {
    id: 'gm-codex', role: 'owner', provider: 'codex', model: 'fixture',
    enabled: true, maxInstances: 4, priority: 0, weight: 1, scored: 0, errorStreak: 0,
  };
  const instances: EmployeeInst[] = [];
  const agents = new Map<string, { id: string; status: string }>();
  const rows: SupervisedTask[] = tasks.map(t => ({
    id: t.id, title: t.id, state: 'blocked', blockedTo: 'owner',
    executorRole: 'engineering', reviewerRole: 'engineering', kind: 'task',
    version: 1, evalAttempts: 0, repoPath: t.repoPath,
    row: { id: t.id, state: 'blocked', blocked_to: 'owner', version: 1 },
  } as unknown as SupervisedTask));
  const readWorkspaceCalls: Array<{ instId: string; taskId?: string }> = [];
  const spawnCwds: string[] = [];
  let next = 0;

  const wf = {
    config: async () => ({
      ...DEFAULT_CONFIG,
      quotaFloorPct: 0, quotaWeeklyFloorPct: 0,
      sessionMaxWakes: 0, sessionMaxInputK: 0,
      evalEnabled: false, jevDecisions: false,
      maxRunning: 8, providerMax: { codex: 8 },
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
    spawnInst: async () => {
      const i: EmployeeInst = {
        id: `gm-${++next}`, def: def.id, role: def.role,
        provider: def.provider, model: def.model, credential: `cred-${next}`,
      };
      instances.push(i);
      return i;
    },
    bind: async (id: string, b: { agentId: string; cwd: string; repoHome?: string }) => {
      Object.assign(instances.find(i => i.id === id)!, {
        paseoAgentId: b.agentId, cwd: b.cwd, repoHome: b.repoHome ?? b.cwd,
      });
    },
    retire: async () => {},
    rotate: async (id: string) => `rotated-${id}`,
    revokeLease: async () => false,
    extendLease: async () => true,
    writeCredentialFile: () => '/dev/null',
  };

  const notices: Array<{ key: string; text: string }> = [];
  const owner = {
    applyPending: async () => [],
    resolveNotice: async () => {},
    openNotices: async () => [],
    triagePending: async () => [],
    raiseNotice: async (key: string, text: string) => {
      notices.push({ key, text });
      return true;
    },
  };

  const paseo: PaseoGateway = {
    list: async () => agents,
    status: async id => agents.get(id) ? { status: agents.get(id)!.status, pendingPermissions: 0 } : undefined,
    lastError: async () => '',
    logsTail: async () => '',
    lastInputTokens: async () => 0,
    spawn: async b => {
      const id = `agent-${b.labels.employee_id}`;
      agents.set(id, { id, status: 'running' });
      spawnCwds.push(b.cwd);
      return id;
    },
    send: async id => { agents.get(id)!.status = 'running'; },
    stop: async () => {}, reload: async () => {},
    archive: async () => {},
    listWorkspaces: async () => [], listProjects: async () => [], archiveWorkspace: async () => {}, deleteProject: async () => {},
  };

  const sidecar: SidecarBridge = {
    env: inst => ({ SCK_COMM_DIR: `/tmp/${inst.id}`, SCK_COMM_KEY: 'k' }),
    canReuse: () => true,
    detachAgent: () => {},
    claim: async () => undefined,
    writeScope: async () => [],
    claimDenial: () => undefined,
    bindAgent: () => {},
    commDirFor: id => `/tmp/comm/${id}`,
    scratchDirFor: instId => `/tmp/${instId}-scratch`,
    releaseClaim: async () => {},
    releaseWorkspace: async () => {},
    readWorkspace: async (inst, taskId) => {
      readWorkspaceCalls.push({ instId: inst.id, taskId });
      const task = rows.find(t => t.id === taskId);
      const repo = task?.repoPath ?? OPS;
      return sharedTree(repo);
    },
  };

  const dispatcher = new Dispatcher({
    workforce: wf as unknown as Workforce,
    owner: owner as unknown as OwnerDesk,
    paseo,
    sidecar,
    env: { opsRepo: OPS, sckBin: '/bin/sck', paseoBin: '/bin/paseo' },
    rand: () => 0,
  });

  return { dispatcher, readWorkspaceCalls, spawnCwds, instances, rows, notices };
}

describe('owner-attention routes blocked-to-owner work to the owner inbox', () => {
  test('two different repoPaths → one owner notice per task, no employee dispatch', async () => {
    const f = fixture([
      { id: 'task-a1', repoPath: PROJ_A },
      { id: 'task-b1', repoPath: PROJ_B },
    ]);
    const report = await f.dispatcher.tick();

    // The owner-attention behaviour changed with the role freeze: blocked-to-owner work is never dispatched to a
    // session, and the repo path no longer groups anything. Each task gets its own owner inbox notice.
    expect(report.woke).toHaveLength(0);
    expect(report.notices.sort()).toEqual(['question:task-a1:1', 'question:task-b1:1']);
    expect(f.readWorkspaceCalls).toHaveLength(0);
    expect(f.spawnCwds).toHaveLength(0);
    expect(f.instances).toHaveLength(0);
  });

  test('same repoPath multi-task → one owner notice each, never a shared dispatch', async () => {
    const f = fixture([
      { id: 'task-a1', repoPath: PROJ_A },
      { id: 'task-a2', repoPath: PROJ_A },
      { id: 'task-a3', repoPath: PROJ_A },
    ]);
    const report = await f.dispatcher.tick();

    expect(report.woke).toHaveLength(0);
    expect(report.notices.sort()).toEqual(['question:task-a1:1', 'question:task-a2:1', 'question:task-a3:1']);
    expect(f.readWorkspaceCalls).toHaveLength(0);
    expect(f.instances).toHaveLength(0);
  });

  test('project-only owner work is never anchored on the opsRepo workspace', async () => {
    const f = fixture([
      { id: 'task-a1', repoPath: PROJ_A },
      { id: 'task-a2', repoPath: PROJ_A },
    ]);
    await f.dispatcher.tick();

    expect(f.readWorkspaceCalls.every(c => c.taskId !== undefined)).toBe(true);
    expect(f.spawnCwds.every(cwd => cwd !== OPS && !cwd.startsWith(`${OPS}-`))).toBe(true);
    expect(f.spawnCwds).toHaveLength(0);
    expect(f.instances).toHaveLength(0);
    expect(f.notices.map(n => n.key).sort()).toEqual(['question:task-a1:1', 'question:task-a2:1']);
  });

  test('repoPath=undefined tasks also go to the owner inbox, not to an opsRepo session', async () => {
    const f = fixture([
      { id: 'ops-1' },
      { id: 'ops-2' },
    ]);
    const report = await f.dispatcher.tick();

    expect(report.woke).toHaveLength(0);
    expect(report.notices.sort()).toEqual(['question:ops-1:1', 'question:ops-2:1']);
    expect(f.readWorkspaceCalls).toHaveLength(0);
    expect(f.spawnCwds).toHaveLength(0);
    expect(f.instances).toHaveLength(0);
  });

  test('mixed: every blocked task lands in the owner inbox and nothing is dispatched', async () => {
    const f = fixture([
      { id: 'ops-1' },
      { id: 'task-a1', repoPath: PROJ_A },
      { id: 'ops-2' },
    ]);
    const report = await f.dispatcher.tick();

    expect(report.woke).toHaveLength(0);
    expect(report.notices.sort()).toEqual(['question:ops-1:1', 'question:ops-2:1', 'question:task-a1:1']);
    expect(f.readWorkspaceCalls).toHaveLength(0);
    expect(f.spawnCwds).toHaveLength(0);
    expect(f.instances).toHaveLength(0);
  });
});
