import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSceneCleaner, type PaseoProjectInfo, type PaseoWorkspaceInfo } from '../src/dispatcher/paseo.ts';

interface FakePaseo {
  workspaces: PaseoWorkspaceInfo[];
  projects: PaseoProjectInfo[];
  archived: string[];
  deleted: string[];
  archiveCalls: number;
  fail: Record<string, string>;
  listWorkspaces(): Promise<PaseoWorkspaceInfo[]>;
  listProjects(): Promise<PaseoProjectInfo[]>;
  archiveWorkspace(id: string): Promise<void>;
  deleteProject(id: string): Promise<void>;
}

const fakePaseo = (workspaces: PaseoWorkspaceInfo[], projects: PaseoProjectInfo[], fail: Record<string, string> = {}): FakePaseo => ({
  workspaces, projects, archived: [], deleted: [], archiveCalls: 0, fail,
  async listWorkspaces() { return this.workspaces.filter(w => !this.archived.includes(w.workspaceId)); },
  async listProjects() { return this.projects.filter(p => !this.deleted.includes(p.projectId)); },
  async archiveWorkspace(id: string) {
    this.archiveCalls++;
    const failure = this.fail[`ws:${id}`];
    if (failure) throw new Error(failure);
    this.archived.push(id);
  },
  async deleteProject(id: string) {
    const failure = this.fail[`prj:${id}`];
    if (failure) throw new Error(failure);
    this.deleted.push(id);
  },
});

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sck-scene-')));
const tree = join(dir, 'repo-sck-deadbeef-c0ffee11');
const ws = (workspaceId: string, cwd: string, project?: string): PaseoWorkspaceInfo => ({ workspaceId, name: `W ${workspaceId}`, cwd, project });
const prj = (projectId: string, path: string, name = `P ${projectId}`): PaseoProjectInfo => ({ projectId, name, path });

test('archives every workspace whose cwd points at the tree, deletes a project rooted there only when empty', async () => {
  const paseo = fakePaseo([
    ws('w1', tree, 'scene-prj'),
    ws('w2', join(tree, 'subdir'), 'scene-prj'),
    ws('w3', join(dir, 'repo-sck-live-aaaaaaaa'), 'other-prj'),
  ], [
    prj('p-scene', tree, 'scene-prj'),
    prj('p-other', join(dir, 'repo-sck-live-aaaaaaaa'), 'other-prj'),
  ]);
  const clean = createSceneCleaner(paseo);
  const result = await clean(tree);
  expect(paseo.archived.sort()).toEqual(['w1', 'w2']);
  expect(paseo.deleted).toEqual(['p-scene']);
  expect(result).toEqual({ workspacesArchived: 2, projectsDeleted: 1 });
});

test('project hosting a surviving workspace elsewhere is retained; parent-repo project is never a match', async () => {
  const parent = join(dir, 'repo');
  const paseo = fakePaseo([
    ws('w-scene', tree, 'scene-prj'),
    ws('w-live', join(parent, 'elsewhere'), 'scene-prj'), // same project, live cwd outside the tree
  ], [
    prj('p-scene', tree, 'scene-prj'),
    prj('p-parent', parent, 'parent-prj'), // parent of the tree path: must never be deleted
  ]);
  const result = await createSceneCleaner(paseo)(tree);
  expect(paseo.archived).toEqual(['w-scene']);
  expect(paseo.deleted).toEqual([]);
  expect(result).toEqual({ workspacesArchived: 1, projectsDeleted: 0 });
});

test('already-gone objects count as done; a real failure throws after attempting all and keeps nothing partial', async () => {
  const paseo = fakePaseo([
    ws('w-gone', tree),
    ws('w-bad', tree),
    ws('w-good', tree),
  ], [prj('p-scene', tree)], {
    'ws:w-gone': 'paseo workspace archive failed (exit 1): workspace not found',
    'ws:w-bad': 'paseo workspace archive failed (exit 1): daemon unreachable',
    'prj:p-scene': 'project not found',
  });
  const clean = createSceneCleaner(paseo);
  await expect(clean(tree)).rejects.toThrow('daemon unreachable');
  // All workspaces were attempted even though one failed; the gone ones still count.
  expect(paseo.archiveCalls).toBe(3);
  expect(paseo.archived).toEqual(['w-good']);
  expect(paseo.deleted).toEqual([]);

  // Retry is idempotent: it finishes the objects that failed before and leaves the rest alone.
  paseo.fail = {};
  const result = await clean(tree);
  expect(result).toEqual({ workspacesArchived: 2, projectsDeleted: 1 });
  expect(paseo.archived.sort()).toEqual(['w-bad', 'w-gone', 'w-good']);
  expect(paseo.deleted).toEqual(['p-scene']);
  // Third pass: everything already gone — a clean no-op.
  expect(await clean(tree)).toEqual({ workspacesArchived: 0, projectsDeleted: 0 });
});

test('a project only dies once its last live workspace is gone', async () => {
  const paseo = fakePaseo([ws('w-last', tree, 'scene-prj')], [prj('p-scene', tree, 'scene-prj')]);
  // The workspace is archived first, so the re-list shows the project empty.
  const result = await createSceneCleaner(paseo)(tree);
  expect(paseo.archived).toEqual(['w-last']);
  expect(paseo.deleted).toEqual(['p-scene']);
  expect(result).toEqual({ workspacesArchived: 1, projectsDeleted: 1 });
});

test('missing tree path and no matching paseo objects is a clean no-op', async () => {
  const paseo = fakePaseo([ws('w-other', join(dir, 'other'))], [prj('p-other', join(dir, 'other'))]);
  const result = await createSceneCleaner(paseo)(join(dir, 'never-existed'));
  expect(result).toEqual({ workspacesArchived: 0, projectsDeleted: 0 });
  expect(paseo.archived).toEqual([]);
  expect(paseo.deleted).toEqual([]);
});

test('CLI usage errors are real failures, not already-gone', async () => {
  // "unknown flag" / "missing required argument" mean the call never ran: classifying them as
  // gone would leave the scene behind and destroy the retry anchor with the tree.
  const flag = fakePaseo([ws('w-flag', tree)], [], {
    'ws:w-flag': "paseo workspace archive failed (exit 2): error: unknown flag '--forece'",
  });
  await expect(createSceneCleaner(flag)(tree)).rejects.toThrow('unknown flag');
  expect(flag.archived).toEqual([]);
  const arg = fakePaseo([ws('w-arg', tree)], [], {
    'ws:w-arg': "paseo workspace archive failed (exit 2): error: missing required argument 'id'",
  });
  await expect(createSceneCleaner(arg)(tree)).rejects.toThrow('missing required argument');
  expect(arg.archived).toEqual([]);
});

rmSync(dir, { recursive: true, force: true });
