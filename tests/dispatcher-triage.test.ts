import { describe, expect, test } from 'bun:test';
import { Dispatcher, type SidecarBridge } from '../src/dispatcher/dispatcher.ts';
import type { PaseoGateway } from '../src/dispatcher/paseo.ts';
import { DEFAULT_CONFIG, type EmployeeDef, type EmployeeInst, type Workforce } from '../src/workforce.ts';
import type { OwnerDesk } from '../src/owner.ts';
import type { GoalView, WorktreeAssignment } from '../src/contracts.ts';

const OPS = '/fixture/ops';
const PROJ_A = '/fixture/proj-a';
const PROJ_B = '/fixture/proj-b';
const REPO_BY_PROJECT = new Map<string, string>([['pa', PROJ_A], ['pb', PROJ_B]]);

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

/** Light fixture: gm defs + triage-pending goals, SidecarBridge records readWorkspace/spawn cwd. */
function fixture(goals: Array<{ id: string; project?: string }>) {
  const def: EmployeeDef = {
    id: 'gm-codex', role: 'gm', provider: 'codex', model: 'fixture',
    enabled: true, maxInstances: 4, priority: 0, weight: 1, scored: 0, errorStreak: 0,
  };
  const instances: EmployeeInst[] = [];
  const agents = new Map<string, { id: string; status: string }>();
  // GoalView.repoPath is the field owner.triagePending joins from project.repo_path.
  const rows: GoalView[] = goals.map(g => ({
    id: g.id, title: g.id, brief: `brief ${g.id}`, state: 'triage',
    project: g.project, repoPath: g.project ? REPO_BY_PROJECT.get(g.project) : undefined,
    tasks: {},
  }));
  const readWorkspaceCalls: Array<{ instId: string; taskId?: string; project?: string }> = [];
  const dispatches: Array<{ key: string; purpose: string }> = [];
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
    tasks: async () => [],
    providerHealth: async () => new Map(),
    lastDispatch: async () => undefined,
    recordDispatch: async (key: string, _version: number, purpose: string) => { dispatches.push({ key, purpose }); },
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
    triagePending: async () => rows,
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
    listWorkspaces: async () => [], listProjects: async () => [], archiveWorkspace: async () => {}, deleteProject: async () => {},
  };

  const sidecar: SidecarBridge = {
    env: inst => ({ SCK_COMM_DIR: `/tmp/${inst.id}`, SCK_COMM_KEY: 'k' }),
    canReuse: () => true,
    detachAgent: () => {},
    claim: async () => undefined,
    bindAgent: () => {},
    commDirFor: () => '/tmp/comm',
    releaseClaim: async () => {},
    releaseWorkspace: async () => {},
    readWorkspace: async (inst, taskId, project) => {
      readWorkspaceCalls.push({ instId: inst.id, taskId, project });
      return sharedTree((project ? REPO_BY_PROJECT.get(project) : undefined) ?? OPS);
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

  return { dispatcher, readWorkspaceCalls, spawnCwds, instances, dispatches };
}

describe('triage groups due goals by project repoPath', () => {
  test('two different projects → two dispatches, each readWorkspace/spawn cwd on that project', async () => {
    const f = fixture([
      { id: 'goal-a1', project: 'pa' },
      { id: 'goal-b1', project: 'pb' },
    ]);
    const report = await f.dispatcher.tick();

    expect(report.woke).toHaveLength(2);
    expect(f.readWorkspaceCalls).toHaveLength(2);
    // Task-less anchor: no taskId, the goal's project id resolves the workspace repo.
    expect(f.readWorkspaceCalls.map(c => c.taskId)).toEqual([undefined, undefined]);
    expect(f.readWorkspaceCalls.map(c => c.project).sort()).toEqual(['pa', 'pb']);
    expect(f.spawnCwds.sort()).toEqual([
      `${PROJ_A}-sck-shared`,
      `${PROJ_B}-sck-shared`,
    ]);
    // Each wake is a distinct employee (assigned prevents reuse across groups).
    expect(new Set(report.woke.map(w => w.employee)).size).toBe(2);
    expect(f.dispatches.filter(d => d.purpose === 'triage').map(d => d.key).sort())
      .toEqual(['goal:goal-a1', 'goal:goal-b1']);
  });

  test('same project multi-goal → one dispatch covering the whole group', async () => {
    const f = fixture([
      { id: 'goal-a1', project: 'pa' },
      { id: 'goal-a2', project: 'pa' },
      { id: 'goal-a3', project: 'pa' },
    ]);
    const report = await f.dispatcher.tick();

    expect(report.woke).toHaveLength(3);
    expect(new Set(report.woke.map(w => w.employee)).size).toBe(1);
    expect(f.readWorkspaceCalls).toHaveLength(1);
    expect(f.readWorkspaceCalls[0]!.project).toBe('pa');
    expect(f.spawnCwds).toEqual([`${PROJ_A}-sck-shared`]);
  });

  test('project goals are never anchored on the opsRepo workspace', async () => {
    const f = fixture([
      { id: 'goal-a1', project: 'pa' },
      { id: 'goal-a2', project: 'pa' },
    ]);
    await f.dispatcher.tick();

    expect(f.readWorkspaceCalls.every(c => c.project === 'pa')).toBe(true);
    expect(f.spawnCwds.every(cwd => cwd !== OPS && !cwd.startsWith(`${OPS}-`))).toBe(true);
    expect(f.spawnCwds).toEqual([`${PROJ_A}-sck-shared`]);
    expect(f.instances.every(i => i.repoHome === PROJ_A)).toBe(true);
  });

  test('project-less goals group under opsRepo with an empty anchor', async () => {
    const f = fixture([
      { id: 'goal-ops1' },
      { id: 'goal-ops2' },
    ]);
    const report = await f.dispatcher.tick();

    expect(report.woke).toHaveLength(2);
    expect(new Set(report.woke.map(w => w.employee)).size).toBe(1);
    expect(f.readWorkspaceCalls).toHaveLength(1);
    expect(f.readWorkspaceCalls[0]!.project).toBeUndefined();
    expect(f.readWorkspaceCalls[0]!.taskId).toBeUndefined();
    expect(f.spawnCwds).toEqual([`${OPS}-sck-shared`]);
  });

  test('mixed: opsRepo group and project group dispatch separately', async () => {
    const f = fixture([
      { id: 'goal-ops1' },
      { id: 'goal-a1', project: 'pa' },
      { id: 'goal-ops2' },
    ]);
    const report = await f.dispatcher.tick();

    expect(report.woke).toHaveLength(3);
    expect(new Set(report.woke.map(w => w.employee)).size).toBe(2);
    expect(f.spawnCwds.sort()).toEqual([
      `${OPS}-sck-shared`,
      `${PROJ_A}-sck-shared`,
    ].sort());
    expect(f.dispatches.map(d => d.key).sort()).toEqual(['goal:goal-a1', 'goal:goal-ops1', 'goal:goal-ops2']);
  });
});
