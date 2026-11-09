import {afterAll, beforeAll, expect, test} from 'bun:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// Exercise the real registration entry without loading native rendering or invoking RPCs.
const dir = mkdtempSync(join(tmpdir(), 'sck-company-navigation-'));
let contribute: (client: any) => void;
beforeAll(async () => {
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, '../plugin/index.client.tsx')],
    outdir: dir, target: 'bun',
    plugins: [{name: 'ui-registration-fixtures', setup(build) {
      build.onLoad({filter: /\/client\/(company|usage|session-history)\.tsx$/}, () => ({
        contents: ['CompanySurface', 'MagpieUsageSurface', 'AgentUsagePanel', 'SessionHistoryPanel', 'SessionHistorySurface']
          .map(name => `export function ${name}(){return null}`).join('\n'), loader: 'js',
      }));
    }}],
  });
  if (!result.success) throw new Error(result.logs.join('\n'));
  contribute = (await import(join(dir, 'index.client.js'))).default;
});
afterAll(() => rmSync(dir, {recursive: true, force: true}));

function registry() {
  const surfaces = new Map<string, any>(), sidebar: any[] = [], panels: any[] = [], commands: any[] = [], timelines: any[] = [];
  contribute({
    addSurface: (id: string, component: any) => surfaces.set(id, component),
    addSidebarItem: (item: any) => sidebar.push(item),
    addWorkspacePanel: (item: any) => panels.push(item),
    addCommandCenterItem: (item: any) => commands.push(item),
    addTimelineRenderer: (item: any) => timelines.push(item),
  });
  return {surfaces, sidebar, panels, commands, timelines};
}

test('company owns exactly one sidebar entry and keeps the per-agent usage and history panels', () => {
  const r = registry();
  expect(r.sidebar.map(({id, title, surface}) => ({id, title, surface})))
    .toEqual([{id: 'company', title: '公司', surface: 'company'}]);
  expect(r.panels.map(p => p.id).sort()).toEqual(['agent-model-metrics', 'employee-history']);
  // The model switch and model metrics timelines went with the model ranking and scoring: none is registered now.
  expect(r.timelines).toEqual([]);
});

test('legacy routes and global shortcuts open the same company workbench at the relevant section', () => {
  const r = registry(), props = {host: {id: 'test-host'}, layout: {compact: true}, theme: {}};
  for (const [id, tab, command] of [
    ['employee-history', 'history', 'employee-history-global'],
    ['magpie-usage', 'usage', 'open-magpie-usage'],
  ]) {
    const element = r.surfaces.get(id)(props);
    expect(element.type).toBe(r.surfaces.get('company'));
    expect(element.props.initialTab).toBe(tab);
    expect(element.props.host).toBe(props.host);
    const opened: string[] = [];
    r.commands.find(c => c.id === command).onSelect({openSurface: (target: string) => opened.push(target)});
    expect(opened).toEqual([id]);
  }
});
