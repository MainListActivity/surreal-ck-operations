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

/** Light fixture: gm defs + blocked-to-gm tasks, SidecarBridge records readWorkspace/spawn cwd. */
function fixture(tasks: Array<{ id: string; repoPath?: string }>) {
  const def: EmployeeDef = {
    id: 'gm-codex', role: 'gm', provider: 'codex', model: 'fixture',
    enabled: true, maxInstances: 4, priority: 0, weight: 1, scored: 0, errorStreak: 0,
  };
  const instances: EmployeeInst[] = [];
  const agents = new Map<string, { id: string; status: string }>();
  const rows: SupervisedTask[] = tasks.map(t => ({
    id: t.id, title: t.id, state: 'blocked', blockedTo: 'gm',
    executorRole: 'engineering', reviewerRole: 'engineering', kind: 'task',
    version: 1, evalAttempts: 0, repoPath: t.repoPath,
    row: { id: t.id, state: 'blocked', blocked_to: 'gm', version: 1 },
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

  const owner = {
    applyPending: async () => [],
    resolveNotice: async () => {},
    openNotices: async () => [],
    triagePending: async () => [],
    raiseNotice: async () => false,
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
    stop: async () => {},
    archive: async () => {},
  };

  const sidecar: SidecarBridge = {
    env: inst => ({ SCK_COMM_DIR: `/tmp/${inst.id}`, SCK_COMM_KEY: 'k' }),
    canReuse: () => true,
    detachAgent: () => {},
    claim: async () => undefined,
    bindAgent: () => {},
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

  return { dispatcher, readWorkspaceCalls, spawnCwds, instances, rows };
}

describe('gm-attention groups pendingGm by repoPath', () => {
  test('two different repoPaths → two dispatches, each readWorkspace/spawn cwd on that project', async () => {
    const f = fixture([
      { id: 'task-a1', repoPath: PROJ_A },
      { id: 'task-b1', repoPath: PROJ_B },
    ]);
    const report = await f.dispatcher.tick();

    expect(report.woke).toHaveLength(2);
    expect(f.readWorkspaceCalls).toHaveLength(2);
    expect(f.readWorkspaceCalls.map(c => c.taskId).sort()).toEqual(['task-a1', 'task-b1']);
    expect(f.spawnCwds.sort()).toEqual([
      `${PROJ_A}-sck-shared`,
      `${PROJ_B}-sck-shared`,
    ]);
    // Each wake is a distinct employee (assigned prevents reuse across groups).
    expect(new Set(report.woke.map(w => w.employee)).size).toBe(2);
  });

  test('same repoPath multi-task → one dispatch covering the whole group', async () => {
    const f = fixture([
      { id: 'task-a1', repoPath: PROJ_A },
      { id: 'task-a2', repoPath: PROJ_A },
      { id: 'task-a3', repoPath: PROJ_A },
    ]);
    const report = await f.dispatcher.tick();

    expect(report.woke).toHaveLength(3);
    expect(new Set(report.woke.map(w => w.employee)).size).toBe(1);
    expect(f.readWorkspaceCalls).toHaveLength(1);
    expect(f.readWorkspaceCalls[0]!.taskId).toBe('task-a1');
    expect(f.spawnCwds).toEqual([`${PROJ_A}-sck-shared`]);
  });

  test('project-only pendingGm is never anchored on opsRepo workspace', async () => {
    const f = fixture([
      { id: 'task-a1', repoPath: PROJ_A },
      { id: 'task-a2', repoPath: PROJ_A },
    ]);
    await f.dispatcher.tick();

    expect(f.readWorkspaceCalls.every(c => c.taskId !== undefined)).toBe(true);
    expect(f.spawnCwds.every(cwd => cwd !== OPS && !cwd.startsWith(`${OPS}-`))).toBe(true);
    expect(f.spawnCwds).toEqual([`${PROJ_A}-sck-shared`]);
    expect(f.instances.every(i => i.repoHome === PROJ_A || i.cwd === `${PROJ_A}-sck-shared`)).toBe(true);
  });

  test('repoPath=undefined tasks group under opsRepo', async () => {
    const f = fixture([
      { id: 'ops-1' },
      { id: 'ops-2' },
    ]);
    const report = await f.dispatcher.tick();

    expect(report.woke).toHaveLength(2);
    expect(new Set(report.woke.map(w => w.employee)).size).toBe(1);
    expect(f.readWorkspaceCalls).toHaveLength(1);
    // readTask is the first undefined-repoPath task; readWorkspace still gets its taskId
    // so core can resolve project=undefined → opsRepo shared tree.
    expect(f.readWorkspaceCalls[0]!.taskId).toBe('ops-1');
    expect(f.spawnCwds).toEqual([`${OPS}-sck-shared`]);
  });

  test('mixed: opsRepo group and project group dispatch separately', async () => {
    const f = fixture([
      { id: 'ops-1' },
      { id: 'task-a1', repoPath: PROJ_A },
      { id: 'ops-2' },
    ]);
    const report = await f.dispatcher.tick();

    expect(report.woke).toHaveLength(3);
    expect(new Set(report.woke.map(w => w.employee)).size).toBe(2);
    expect(f.spawnCwds.sort()).toEqual([
      `${OPS}-sck-shared`,
      `${PROJ_A}-sck-shared`,
    ].sort());
  });
});
