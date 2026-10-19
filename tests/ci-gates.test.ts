import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// CI gate guard (SYS01 review defect 1). A missing space once glued two test paths into one token, so the bridge
// gate silently ran 9 files instead of 11. Every test path a gate script names must be one existing file.
const ROOT = join(import.meta.dir, '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
const gates = Object.entries(pkg.scripts).filter(([name, command]) => name.startsWith('test:') && command.startsWith('bun test'));

test('every test file a gate script names is one existing path', () => {
  expect(gates.length).toBeGreaterThan(0);
  for (const [name, command] of gates) {
    for (const token of command.split(/\s+/).filter(part => part.includes('.test.'))) {
      expect(token, `${name}: one path per token`).toMatch(/^tests\/[\w.-]+\.test\.ts$/);
      expect(existsSync(join(ROOT, token)), `${name}: ${token} exists`).toBe(true);
    }
  }
});

test('the bridge gate runs the response budget and ops login suites', () => {
  const tokens = pkg.scripts['test:bridge']!.split(/\s+/);
  expect(tokens).toContain('tests/response-budget.test.ts');
  expect(tokens).toContain('tests/ops-login-transport.test.ts');
});

test('the comm gate runs the client and slow pipe regressions, and CI runs the comm gate', () => {
  const comm = pkg.scripts['test:comm']!;
  for (const file of ['tests/comm-client.test.ts', 'tests/comm-slow-pipe.test.ts', 'tests/ci-gates.test.ts']) expect(comm).toContain(file);
  expect(readFileSync(join(ROOT, '.github/workflows/quality-gate.yml'), 'utf8')).toContain('pnpm test:comm');
});
