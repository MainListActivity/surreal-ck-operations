import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';

const consoleSrc = readFileSync('plugin/server/console.ts', 'utf8');
const script = /<script>([\s\S]*?)<\/script>/.exec(consoleSrc)?.[1] ?? '';

function ownerCommands(): Set<string> {
  const cmds = new Set<string>();
  for (const file of ['src/owner-api.ts', 'plugin/server/owner-api.ts']) {
    for (const m of readFileSync(file, 'utf8').matchAll(/case '([a-z][a-z0-9._]*)'/g)) cmds.add(m[1]);
  }
  return cmds;
}

test('console inline script compiles', () => {
  expect(script.length).toBeGreaterThan(1000);
  expect(() => new Function(script)).not.toThrow();
});

test('every console api() call names an owner command — all writes go through the owner prefix', () => {
  const allowed = ownerCommands();
  const called = new Set<string>();
  for (const m of script.matchAll(/api\('([a-z0-9._-]+)'/g)) called.add(m[1]);
  expect(called.size).toBeGreaterThan(10);
  for (const name of called) expect(allowed.has(name)).toBe(true);
});
