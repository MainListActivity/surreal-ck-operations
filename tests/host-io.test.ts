import { expect, test } from 'bun:test';
import { CompanyError } from '../src/core-errors.ts';
import { SurrealCompanyCore } from '../src/core.ts';
import type { CompanyDatabase } from '../src/database.ts';
import { hostIO, installHost } from '../src/host-io.ts';
import { installNodeHost } from '../src/host-node.ts';

// Paths that do not exist on any machine, so canonicalRepoPath resolves them without touching the disk.
const OPS = '/sck-host-fixture/operations';
const PROJECT = '/sck-host-fixture/maplayer-content';

/** The execution host is process-wide: run `action` without one, then put back the node host the preload installed. */
async function withoutHost<T>(action: () => Promise<T>): Promise<T> {
  installHost(undefined);
  try { return await action(); } finally { installNodeHost(); }
}

/** The private seam creation-time routing reads, reached by cast as other core tests do. */
type CodeRepoRouting = {
  projects: { get(id: string): Promise<{ repoPath: string } | undefined> };
  creationCodeRepo(input: { context: string; project?: string; workIntent?: { kind: string } }, kind: 'task'): Promise<string | undefined>;
};

test('without an execution host, hostIO refuses with unavailable instead of guessing a local answer', async () => {
  const thrown = await withoutHost(async () => {
    try { hostIO(); return undefined; } catch (error) { return error; }
  });
  expect(thrown).toBeInstanceOf(CompanyError);
  expect(thrown).toMatchObject({ code: 'unavailable' });
});

test('a code task naming the ops repo is bound to it with a host, and refused without one rather than routed to the project repo', async () => {
  const routing = new SurrealCompanyCore({} as CompanyDatabase, { worktrees: { opsRepo: OPS } }) as unknown as CodeRepoRouting;
  routing.projects = { get: async () => ({ repoPath: PROJECT }) };
  const input = { context: `代码在 ${OPS}`, project: 'maplayer-content', workIntent: { kind: 'code' } };
  expect(await routing.creationCodeRepo(input, 'task')).toBe(OPS);
  await expect(withoutHost(() => routing.creationCodeRepo(input, 'task'))).rejects.toMatchObject({ code: 'unavailable' });
});
