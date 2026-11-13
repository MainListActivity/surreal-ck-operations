import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readProviderRoutes, ownsProvider } from '../src/runner/provider-routing.ts';
test('显式原生归属阻止 Paseo 与另一原生节点新派工，不按节点在线状态自动回退', () => {
  const home = mkdtempSync(join(tmpdir(),'sck-routes-'));
  try {
    expect(ownsProvider(readProviderRoutes(home), 'claude', 'paseo:legacy')).toBe(true);
    mkdirSync(join(home,'private'));
    writeFileSync(join(home,'private/runtime-routes.json'), JSON.stringify({version:1,routes:{claude:'native:mac', 'factory-droid':'native:mac'}}));
    const routes = readProviderRoutes(home);
    for (const provider of ['claude','factory-droid']) {
      expect(ownsProvider(routes,provider,'paseo:legacy')).toBe(false);
      expect(ownsProvider(routes,provider,'native:remote')).toBe(false);
      expect(ownsProvider(routes,provider,'native:mac')).toBe(true);
    }
    expect(ownsProvider(routes,'codex','paseo:legacy')).toBe(true);
    writeFileSync(join(home,'private/runtime-routes.json'), JSON.stringify({version:1,routes:{'codex-cloud':'native:mac','devin-cloud':'native:mac','jules':'native:mac'}}));
    const laneRoutes = readProviderRoutes(home);
    expect(ownsProvider(laneRoutes,'jules','native:mac')).toBe(true);
    expect(ownsProvider(laneRoutes,'jules','paseo:legacy')).toBe(false);
    writeFileSync(join(home,'private/runtime-routes.json'), '{invalid');
    expect(() => readProviderRoutes(home)).toThrow();
  } finally { rmSync(home,{recursive:true,force:true}); }
});
