import { expect, test } from 'bun:test';
import { Dispatcher } from '../src/dispatcher/dispatcher.ts';
import { MAINTENANCE_WORKSPACE, workspaceTitleOf } from '../src/dispatcher/paseo.ts';

type Saved = { cwd: string; id: string };
function harness(input: { workspaces?: Saved[]; listed?: string[]; finished?: Array<{ id: string; title: string; workspaces: Saved[] }>; archiveError?: Error } = {}) {
  const created: Array<[string, string, string | undefined]> = [], archived: string[] = [], saved: Array<[string, Saved[]]> = [];
  const paseo = {
    listWorkspaces: async () => (input.listed ?? []).map(workspaceId => ({ workspaceId, name: 'x', cwd: '/repo' })),
    createWorkspace: async (title: string, cwd: string, repoHome?: string) => { created.push([title, cwd, repoHome]); return `wks_${created.length}`; },
    archiveWorkspace: async (id: string) => { if (input.archiveError) throw input.archiveError; archived.push(id); },
  };
  const workforce = {
    chainRoot: async () => ({ id: 'root', title: '  把公司插件\n做成一致的界面  ', workspaces: input.workspaces ?? [] }),
    saveChainWorkspaces: async (id: string, workspaces: Saved[]) => { saved.push([id, workspaces]); },
    finishedChains: async () => input.finished ?? [],
  };
  const dispatcher = new Dispatcher({ workforce, paseo, owner: {}, env: {}, log: () => undefined } as never) as unknown as {
    sessionWorkspace(task: { id: string; title?: string } | undefined, cwd: string, repoHome: string): Promise<{ workspaceId?: string; workspaceTitle: string }>;
    closeFinishedWorkspaces(insts: Array<{ id: string; paseoWorkspace?: string }>, retired: string[]): Promise<void>;
  };
  return { dispatcher, created, archived, saved };
}

test('a task\'s session lands in a container named after the chain root, never an employee', async () => {
  const h = harness();
  const container = await h.dispatcher.sessionWorkspace({ id: 'child', title: '子任务' }, '/repo', '/repo');
  expect(container).toEqual({ workspaceId: 'wks_1', workspaceTitle: '把公司插件 做成一致的界面' });
  expect(h.created).toEqual([['把公司插件 做成一致的界面', '/repo', '/repo']]);
  expect(h.saved).toEqual([['root', [{ cwd: '/repo', id: 'wks_1' }]]]);
});

test('the next session of the chain joins the same container', async () => {
  const h = harness({ workspaces: [{ cwd: '/repo', id: 'wks_9' }], listed: ['wks_9'] });
  expect((await h.dispatcher.sessionWorkspace({ id: 'child' }, '/repo', '/repo')).workspaceId).toBe('wks_9');
  expect(h.created).toEqual([]);
});

test('an archived container is replaced, and another repository gets its own', async () => {
  const gone = harness({ workspaces: [{ cwd: '/repo', id: 'wks_9' }], listed: [] });
  expect((await gone.dispatcher.sessionWorkspace({ id: 'child' }, '/repo', '/repo')).workspaceId).toBe('wks_1');
  expect(gone.saved[0]![1]).toEqual([{ cwd: '/repo', id: 'wks_1' }]);
  const other = harness({ workspaces: [{ cwd: '/repo', id: 'wks_9' }], listed: ['wks_9'] });
  await other.dispatcher.sessionWorkspace({ id: 'child' }, '/other', '/other');
  expect(other.saved[0]![1]).toEqual([{ cwd: '/repo', id: 'wks_9' }, { cwd: '/other', id: 'wks_1' }]);
});

test('a session with no task shares the maintenance container', async () => {
  expect(await harness().dispatcher.sessionWorkspace(undefined, '/repo', '/repo')).toEqual({ workspaceTitle: MAINTENANCE_WORKSPACE });
});

test('a finished chain\'s container closes only once no session on the roster lives in it', async () => {
  const finished = [{ id: 'root', title: 't', workspaces: [{ cwd: '/repo', id: 'wks_1' }] }];
  const busy = harness({ finished });
  await busy.dispatcher.closeFinishedWorkspaces([{ id: 'e1', paseoWorkspace: 'wks_1' }], []);
  expect(busy.archived).toEqual([]);
  expect(busy.saved).toEqual([]);
  const done = harness({ finished });
  await done.dispatcher.closeFinishedWorkspaces([{ id: 'e1', paseoWorkspace: 'wks_1' }], ['e1']);
  expect(done.archived).toEqual(['wks_1']);
  expect(done.saved).toEqual([['root', []]]);
});

test('a failed archive keeps the record for the next tick', async () => {
  const h = harness({ finished: [{ id: 'root', title: 't', workspaces: [{ cwd: '/repo', id: 'wks_1' }] }], archiveError: new Error('daemon busy') });
  await h.dispatcher.closeFinishedWorkspaces([], []);
  expect(h.saved).toEqual([]);
});

test('titles stay readable in the sidebar', () => {
  expect(workspaceTitleOf('a'.repeat(80))).toHaveLength(60);
  expect(workspaceTitleOf('   ')).toBe('未命名任务');
});
