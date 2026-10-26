import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const root = join(import.meta.dir, '..');
const probe = (path: string, scope = 'core') => Bun.spawnSync(['sh', '-c', '. "$1/scripts/goal-workspace-guard.sh"; goal_workspace_target_supported "$2" "$3"', 'guard', root, path, scope]).exitCode;
test('goal workspace rollback guard rejects an old or declaration-only core and accepts the current enforced contract', () => {
  const old = mkdtempSync(join(tmpdir(), 'goal-workspace-old-'));
  try {
    expect(probe(old)).not.toBe(0);
    mkdirSync(join(old, 'src'));
    writeFileSync(join(old, 'src/goal-workspace-capability.ts'), "export const GOAL_WORKSPACE_CONTRACT = 'sck-goal-workspace/v1';\n");
    expect(probe(old)).not.toBe(0);
    expect(probe(root)).toBe(0);
  } finally { rmSync(old, { recursive: true, force: true }); }
});
test('both switch entry points enforce goal workspace compatibility before the existing release gate or upload', () => {
  const local = readFileSync(join(root, 'scripts/company-service.sh'), 'utf8');
  const remote = readFileSync(join(root, 'scripts/deploy-mcp-remote.sh'), 'utf8');
  expect(local.indexOf('goal_workspace_target_supported "$release"')).toBeLessThan(local.indexOf('    check_gate comm-slow-pipe'));
  expect(remote).toContain('goal_workspace_target_supported "$staging/probe" core');
});
