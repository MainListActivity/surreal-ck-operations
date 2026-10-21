import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// worktree_audit.event is an ASSERT whitelist. A code path writing an event name the
// whitelist lacks makes SurrealDB reject the INSERT; the reclaim loop's repo-level catch
// then aborts the whole scan, so one bad event name silently stops every sweep for that
// repo (2026-10-21 02:37Z: drop_stale_row was missing from the 014 whitelist and each
// sweep died after dropping a single stale row). Keep schema and code in sync here —
// no database needed, so this runs in the channel suite.
const root = join(import.meta.dir, '..');
const whitelistFile = join(root, 'schema', '021-worktree-audit-events.surql');
const registryFile = join(root, 'src', 'dispatcher', 'worktree-registry.ts');

const schemaEvents = (): Set<string> => {
  const text = readFileSync(whitelistFile, 'utf8');
  const assert = text.match(/ASSERT \$value IN \[([^\]]+)\]/);
  if (!assert) throw new Error('021-worktree-audit-events.surql: event ASSERT whitelist not found');
  return new Set([...assert[1].matchAll(/'([a-z_]+)'/g)].map(m => m[1]));
};

const codeEvents = (): Set<string> => {
  const text = readFileSync(registryFile, 'utf8');
  return new Set([...text.matchAll(/event: '([a-z_]+)'/g)].map(m => m[1]));
};

test('worktree_audit event whitelist covers every event the registry writes', () => {
  const written = codeEvents();
  expect(written.size).toBeGreaterThan(0);
  expect([...written].filter(event => !schemaEvents().has(event))).toEqual([]);
});

test('the stale-row drop event stays whitelisted on both sides', () => {
  expect(schemaEvents().has('drop_stale_row')).toBe(true);
  expect(codeEvents().has('drop_stale_row')).toBe(true);
});
