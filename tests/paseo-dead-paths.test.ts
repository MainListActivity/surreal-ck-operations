import { expect, test } from 'bun:test';
import { deadPathCleanup, type DeadPathGateway, type DeadPathReport } from '../src/dispatcher/paseo-dead-paths.ts';

/** In-memory Paseo: archived/deleted entries stop being listed, like the real CLI. */
function fixture(exists: (path: string) => boolean) {
  const calls: string[] = [];
  const workspaces = [
    { workspaceId: 'wks_dead', cwd: '/tmp/gone-tree' },
    { workspaceId: 'wks_live', cwd: '/tmp/live-tree' },
    { workspaceId: 'wks_nocwd' },
  ];
  const projects = [
    { projectId: 'prj_dead', path: '/tmp/gone-project' },
    { projectId: 'prj_live', path: '/tmp/live-project' },
    { projectId: 'prj_nopath' },
  ];
  const archived: string[] = [], deleted: string[] = [];
  const gateway: DeadPathGateway = {
    listWorkspaces: async () => workspaces.filter(w => !archived.includes(w.workspaceId))
      .map(w => ({ workspaceId: w.workspaceId, cwd: w.cwd })),
    archiveWorkspace: async id => { calls.push(`archive:${id}`); archived.push(id); },
    listProjects: async () => projects.filter(p => !deleted.includes(p.projectId))
      .map(p => ({ projectId: p.projectId, path: p.path })),
    deleteProject: async id => { calls.push(`deleteProject:${id}`); deleted.push(id); },
  };
  return { calls, gateway, archived, deleted, exists };
}

test('dead-path plan selects only vanished paths and reports pathless entries', async () => {
  const f = fixture(path => path.startsWith('/tmp/live'));
  const dry: DeadPathReport = await deadPathCleanup(f.gateway, { exists: f.exists });
  expect(dry.apply).toBe(false);
  expect(dry.workspaces).toEqual([{ id: 'wks_dead', path: '/tmp/gone-tree' }]);
  expect(dry.projects).toEqual([{ id: 'prj_dead', path: '/tmp/gone-project' }]);
  expect(dry.skipped.map(s => s.id).sort()).toEqual(['prj_nopath', 'wks_nocwd']);
  expect(f.calls).toEqual([]); // dry-run never writes
});

test('apply touches exactly the dead entries; live duplicates stay for the reference-zero path', async () => {
  const f = fixture(path => path.startsWith('/tmp/live'));
  const report = await deadPathCleanup(f.gateway, { apply: true, exists: f.exists });
  expect(report.apply).toBe(true);
  expect(f.archived).toEqual(['wks_dead']);
  expect(f.deleted).toEqual(['prj_dead']);
  expect(f.calls).toEqual(['archive:wks_dead', 'deleteProject:prj_dead']);
});

test('re-running after apply is a no-op (idempotent)', async () => {
  const f = fixture(path => path.startsWith('/tmp/live'));
  await deadPathCleanup(f.gateway, { apply: true, exists: f.exists });
  const again = await deadPathCleanup(f.gateway, { apply: true, exists: f.exists });
  expect(again.workspaces).toEqual([]);
  expect(again.projects).toEqual([]);
  expect(again.skipped.map(s => s.id).sort()).toEqual(['prj_nopath', 'wks_nocwd']);
  expect(f.calls).toEqual(['archive:wks_dead', 'deleteProject:prj_dead']);
});

test('a failing archive call aborts the run so the operator can retry the same plan', async () => {
  const f = fixture(path => path.startsWith('/tmp/live'));
  const failing: DeadPathGateway = {
    listWorkspaces: f.gateway.listWorkspaces,
    archiveWorkspace: async () => { throw new Error('paseo daemon unreachable'); },
    listProjects: f.gateway.listProjects,
    deleteProject: f.gateway.deleteProject,
  };
  await expect(deadPathCleanup(failing, { apply: true, exists: f.exists })).rejects.toThrow('paseo daemon unreachable');
  expect(f.archived).toEqual([]); // nothing recorded as done when the layer failed
});
