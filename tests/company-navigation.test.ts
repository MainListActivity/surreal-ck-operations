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

test('公司插件不再注册页面、面板或导航，老板工作流使用云端网页', () => {
  const r = registry();
  expect(r.surfaces.size).toBe(0);
  expect(r.sidebar).toEqual([]);
  expect(r.panels).toEqual([]);
  expect(r.commands).toEqual([]);
  expect(r.timelines).toEqual([]);
});
