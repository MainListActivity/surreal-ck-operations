import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDatabaseConfig } from '../src/config.ts';
import { CompanyDatabase } from '../src/database.ts';
import { CompanyError, SurrealCompanyCore } from '../src/core.ts';
import { LocalEnrollmentAdmin } from '../src/enrollment.ts';
import { readJsonFile, reqDir, resDir, writeFileAtomic } from '../src/comm.ts';
import type { ClaimResult, Credential, TaskView } from '../src/contracts.ts';
import type { EmployeeInst, SupervisedTask } from '../src/workforce.ts';
import { SidecarPool } from '../plugin/server/sidecar.ts';

// SYS01 R8 (non-gm list_worktrees without a task is forbidden; the lease never stands in) and null-as-absent, on the
// isolated company fork started by scripts/test-worktrees.ts. Real core and real sidecar pool.
// Never production: the fork is the only database this file touches.
const config = { ...loadDatabaseConfig(), namespace: 'sck_agent_company_test', database: 'control_plane' };
const database = new CompanyDatabase(config);
const plain = new SurrealCompanyCore(database);
const enrollment = new LocalEnrollmentAdmin(database);
const suffix = randomUUID().slice(0, 8);
let seq = 0;
const key = (label: string) => `nul-${suffix}-${label}-${++seq}`;
const ids = {
  gmA: `nul-gma-${suffix}`, gmB: `nul-gmb-${suffix}`, engA: `nul-enga-${suffix}`, engB: `nul-engb-${suffix}`,
  holderA: `nul-hla-${suffix}`, holderB: `nul-hlb-${suffix}`, csH: `nul-csh-${suffix}`,
};
setDefaultTimeout(180_000);

// The worktree core: the same database with an ops repository, so list_worktrees reads a real registry.
let core: SurrealCompanyCore;
let base: string;
let repo: string;
let pool: SidecarPool;
let gmA: Credential, gmB: Credential, engA: Credential, engB: Credential, holderA: Credential, holderB: Credential, csH: Credential;
const env: Record<string, { SCK_COMM_DIR: string; SCK_COMM_KEY: string }> = {};
let taskA: TaskView, taskB: TaskView, taskQa: TaskView, queueA: TaskView, queueB: TaskView;
let treeA = '', treeB = '';

type Answer = { ok: boolean; code?: string; data?: unknown; error?: string; thrown?: string };

/** One real sidecar relay: the request file goes through the pool's sweeper and the pool's own dispatch to core. */
let relaySeq = 0;
async function viaSidecar(channel: { SCK_COMM_DIR: string; SCK_COMM_KEY: string }, tool: string, args: Record<string, unknown>): Promise<Answer> {
  const name = `null-${++relaySeq}-${tool}`;
  writeFileAtomic(join(reqDir(channel.SCK_COMM_DIR), `${name}.json`), JSON.stringify({ key: channel.SCK_COMM_KEY, tool, args }));
  const file = join(resDir(channel.SCK_COMM_DIR), `${name}.json`);
  const deadline = Date.now() + 15_000;
  while (!existsSync(file)) {
    if (Date.now() > deadline) throw new Error(`sidecar gave no answer to ${tool}`);
    await Bun.sleep(10);
  }
  const answer = readJsonFile<{ ok: boolean; data?: unknown; error?: string }>(file)!;
  return { ok: answer.ok, data: answer.data, error: answer.error };
}

/** The code a sidecar error carries before its colon ("forbidden: ..."). */
const sidecarCode = (answer: Answer): string | undefined => answer.error?.split(':')[0];

/** Runs a core call and returns its error as CompanyError, or undefined when it returns. */
async function coreError(promise: Promise<unknown>): Promise<CompanyError | undefined> {
  const reason = await promise.then(() => undefined, (error: unknown) => error);
  if (reason === undefined) return undefined;
  expect(reason).toBeInstanceOf(CompanyError);
  return reason as CompanyError;
}

const idsOf = (rows: unknown): string[] => (rows as Array<{ id: string }>).map(row => String(row.id));
const pagedOf = (data: unknown) => data as { worktrees: Array<{ id: string }>; page: { returned: number; hasMore: boolean; nextCursor?: string } };

const make = (label: string, executorRole: string, reviewerRole = 'qa'): Promise<TaskView> => core.createTask(gmA, {
  title: `空参数样例 ${label} ${suffix}`, context: `空参数正文 ${label}`,
  executorRole: executorRole as never, reviewerRole: reviewerRole as never, workIntent: executorRole === 'engineering' ? { kind: 'code' } : undefined, idempotencyKey: key(label),
});

function git(args: string[]) {
  const result = Bun.spawnSync(['git', '-C', repo, ...args], { stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode) throw new Error(result.stderr.toString());
}

beforeAll(async () => {
  await database.connect();
  await database.bootstrap();
  gmA = await enrollment.enroll(ids.gmA, 'owner', ['execute', 'review', 'manage']);
  gmB = await enrollment.enroll(ids.gmB, 'owner', ['execute', 'review', 'manage']);
  engA = await enrollment.enroll(ids.engA, 'engineering', ['execute', 'review']);
  engB = await enrollment.enroll(ids.engB, 'engineering', ['execute', 'review']);
  holderA = await enrollment.enroll(ids.holderA, 'asset-production', ['execute']);
  holderB = await enrollment.enroll(ids.holderB, 'asset-production', ['execute']);
  csH = await enrollment.enroll(ids.csH, 'cs', ['execute']);

  // A git repository for the registry. Its trees are created beside it, inside the temporary parent removed in afterAll.
  base = realpathSync(mkdtempSync(join(tmpdir(), 'sck-null-absent-')));
  repo = join(base, 'repo-main');
  Bun.spawnSync(['git', 'init', '-q', '-b', 'main', repo]);
  writeFileSync(join(repo, 'source.txt'), 'baseline');
  git(['add', '.']);
  git(['commit', '-qm', 'baseline']);
  core = new SurrealCompanyCore(database, { worktrees: { opsRepo: repo } });

  taskA = await make('wt-a', 'engineering');
  taskB = await make('wt-b', 'engineering');
  taskQa = await make('wt-qa', 'qa', 'cs');
  queueA = await make('queue-a', 'asset-production');
  queueB = await make('queue-b', 'asset-production');

  // Channels: one pool over the same core. Only the employee's own credential is used; rotation is never needed.
  pool = new SidecarPool({
    core: core as never,
    workforce: { rotate: async () => { throw new Error('fixture never rotates a credential'); } } as never,
    runDir: join(base, 'run'), heartbeatMs: 600_000, sweepMs: 20,
  });
  const channel = (id: string, role: string, credential: Credential) => {
    const opened = pool.env({ id, role, credential } as unknown as EmployeeInst);
    return { SCK_COMM_DIR: opened.SCK_COMM_DIR!, SCK_COMM_KEY: opened.SCK_COMM_KEY! };
  };
  env.gmA = channel(ids.gmA, 'owner', gmA);
  env.gmB = channel(ids.gmB, 'owner', gmB);
  env.engA = channel(ids.engA, 'engineering', engA);
  env.holderA = channel(ids.holderA, 'asset-production', holderA);
  env.holderB = channel(ids.holderB, 'asset-production', holderB);
  env.csH = channel(ids.csH, 'cs', csH);

  // engA holds a real sidecar lease on taskA (its tree A). engB claims taskB directly on the core (its tree B).
  const leased = await pool.claim({ id: ids.engA, role: 'engineering', credential: engA } as unknown as EmployeeInst, { id: taskA.id } as unknown as SupervisedTask);
  expect(leased).toBeDefined();
  treeA = leased!.worktree!.id;
  const claimedB = await core.claim(engB, taskB.id) as ClaimResult;
  treeB = claimedB.worktree!.id;
  expect(treeA).not.toBe(treeB);

}, 600_000);

afterAll(async () => {
  if (pool) pool.close();
  await database.close();
  if (base) rmSync(base, { recursive: true, force: true });
});

test('R8: a non-gm employee without taskId is forbidden on sidecar and core, with absent or null arguments alike', async () => {
  const unscoped: Array<Record<string, unknown>> = [{}, { taskId: null }, { pageSize: null, cursor: null }, { taskId: null, pageSize: null, cursor: null, includeReleased: null }];
  for (const args of unscoped) {
    // The sidecar answers the same refusal; a null task id is not read as the task "null" (that would be not_found).
    const side = await viaSidecar(env.engA!, 'list_worktrees', args);
    expect(side.ok).toBe(false);
    expect(sidecarCode(side)).toBe('forbidden');
    expect(side.data).toBeUndefined();
  }
  // Core, with the registry and without it: the refusal comes before any registry is consulted.
  for (const error of [
    await coreError(core.listWorktrees(engA as never)),
    await coreError(core.worktreeList(engA, { taskId: null, pageSize: null } as never)),
    await coreError(core.worktreePage(engA, { pageSize: 5, cursor: null, taskId: null } as never)),
    await coreError(plain.listWorktrees(engA as never)),
  ]) {
    expect(error?.code).toBe('forbidden');
    expect(error?.message).toMatch(/requires owner/);
  }
});

test('R8: the sidecar lease is not a fallback scope: an employee holding a live lease on taskA is still refused without taskId', async () => {
  // The lease is real: the core names engA the current employee of taskA under the pool's delivery.
  const current = await core.getTask(engA, taskA.id);
  expect(current.currentEmployee).toBe(ids.engA);
  const unscoped = await viaSidecar(env.engA!, 'list_worktrees', {});
  expect(unscoped.ok).toBe(false);
  expect(sidecarCode(unscoped)).toBe('forbidden');
  const paged = await viaSidecar(env.engA!, 'list_worktrees', { pageSize: 5 });
  expect(paged.ok).toBe(false);
  expect(sidecarCode(paged)).toBe('forbidden');
  expect(paged.data).toBeUndefined();
  // Explicitly naming the leased task is the way to read its tree; that answer does contain tree A.
  const scoped = await viaSidecar(env.engA!, 'list_worktrees', { taskId: taskA.id });
  expect(scoped.ok).toBe(true);
  expect(idsOf(scoped.data)).toContain(treeA);
});

test('explicit taskId: an authorized task reads the repository inventory, an unauthorized one is forbidden, a missing one is not_found, on the sidecar and core layers', async () => {
  // Authorized: engA is the engineering executor of taskA. The answer is the repository's inventory (tree A is in it).
  const side = await viaSidecar(env.engA!, 'list_worktrees', { taskId: taskA.id, includeReleased: null });
  expect(side.ok).toBe(true);
  expect(idsOf(side.data)).toContain(treeA);
  const sidePaged = await viaSidecar(env.engA!, 'list_worktrees', { taskId: taskA.id, pageSize: 5 });
  expect(sidePaged.ok).toBe(true);
  expect(pagedOf(sidePaged.data).worktrees.map(w => w.id)).toContain(treeA);
  const coreArray = await core.listWorktrees(engA, taskA.id as never);
  expect(coreArray.map(w => w.id)).toContain(treeA);

  // Unauthorized: taskQa is an executor qa task, so an engineering caller has no role access to it.
  const sideDenied = await viaSidecar(env.engA!, 'list_worktrees', { taskId: taskQa.id });
  expect(sideDenied.ok).toBe(false);
  expect(sidecarCode(sideDenied)).toBe('forbidden');
  const coreDenied = await coreError(core.listWorktrees(engA, taskQa.id as never));
  expect(coreDenied?.code).toBe('forbidden');
  expect(coreDenied?.message).toBe('Task access denied');

  // Missing: a task id that names nothing is not_found, before any access rule is applied.
  const missing = `nul-missing-${suffix}`;
  expect(sidecarCode(await viaSidecar(env.engA!, 'list_worktrees', { taskId: missing }))).toBe('not_found');
  expect((await coreError(core.listWorktrees(engA, missing as never)))?.code).toBe('not_found');
});

test('gm global: no taskId is the repository inventory, and null is absent (an array, never a page)', async () => {
  // Global reads are gm-only and unchanged by R8: both of this fixture's trees are listed.
  const side = await viaSidecar(env.gmA!, 'list_worktrees', {});
  const sideNull = await viaSidecar(env.gmA!, 'list_worktrees', { taskId: null, pageSize: null, cursor: null });
  expect(Array.isArray(side.data)).toBe(true);
  expect(Array.isArray(sideNull.data)).toBe(true);
  expect(sideNull.data).toEqual(side.data);
  expect(idsOf(side.data)).toEqual(expect.arrayContaining([treeA, treeB]));
  const coreAll = await core.listWorktrees(gmA as never);
  expect(coreAll.map(w => w.id)).toEqual(expect.arrayContaining([treeA, treeB]));
  // The explicit gm task read is the same as the gm global read of that repository (gm reads any task).
  const coreScoped = await core.listWorktrees(gmA, taskB.id as never);
  expect(coreScoped.map(w => w.id)).toEqual(expect.arrayContaining([treeB]));
});

test('gm paging: the cursor is bound to the gm identity, and page sizes outside 1 to 100 are invalid, on the sidecar and core', async () => {
  // The first page of gm A, its cursor, and a second gm: the cursor is refused for the other identity.
  const first = pagedOf(await core.worktreePage(gmA, { pageSize: 1 } as never));
  expect(first.page.hasMore).toBe(true);
  const cursor = first.page.nextCursor!;
  expect((await coreError(core.worktreePage(gmB, { pageSize: 1, cursor } as never)))?.code).toBe('forbidden');
  expect(sidecarCode(await viaSidecar(env.gmB!, 'list_worktrees', { pageSize: 1, cursor }))).toBe('forbidden');

  // Sidecar paged read, with a null cursor and taskId beside a real page size: the paged branch, unscoped.
  const sidePaged = await viaSidecar(env.gmA!, 'list_worktrees', { pageSize: 1, cursor: null, taskId: null });
  expect(sidePaged.ok).toBe(true);
  expect(pagedOf(sidePaged.data).page.returned).toBe(1);

  // Page size bounds: 0 and 101 are refused as invalid on core and on the sidecar.
  for (const size of [0, 101]) {
    expect((await coreError(core.worktreePage(gmA, { pageSize: size } as never)))?.code).toBe('invalid');
    const side = await viaSidecar(env.gmA!, 'list_worktrees', { pageSize: size });
    expect(side.ok).toBe(false);
    expect(sidecarCode(side)).toBe('invalid');
  }
});

test('get_context: null arguments are absent on the sidecar, and a null page size keeps the complete answer', async () => {
  const nulls = { taskId: null, state: null, tag: null, role: null, since: null, includeCompany: null, fields: null, pageSize: null, cursor: null };
  const taskIdsOf = (data: unknown) => ((data as { tasks: Array<{ id: string }> }).tasks).map(task => String(task.id)).sort();
  const keysOf = (data: unknown) => Object.keys(data as object).sort();
  // holderB's working set holds this file's queue tasks (asset-production); the answer is the complete one, not a page.

  const sideAbsent = await viaSidecar(env.holderB!, 'get_context', {});
  const sideNulls = await viaSidecar(env.holderB!, 'get_context', nulls);
  expect(sideNulls.ok).toBe(true);
  expect(keysOf(sideNulls.data)).toEqual(keysOf(sideAbsent.data));
  expect(taskIdsOf(sideNulls.data)).toEqual(taskIdsOf(sideAbsent.data));
  expect(taskIdsOf(sideNulls.data)).toContain(queueB.id);
});

test('get_task_history: null pageSize and cursor are the same answer as absent on the sidecar; a null task id is refused', async () => {
  const sideAbsent = await viaSidecar(env.gmA!, 'get_task_history', { taskId: taskA.id });
  const sideNulls = await viaSidecar(env.gmA!, 'get_task_history', { taskId: taskA.id, pageSize: null, cursor: null });
  expect(sideNulls.data).toEqual(sideAbsent.data);
  expect(Object.keys(sideNulls.data as object)).toEqual(['history']);
  const sideNullTask = await viaSidecar(env.gmA!, 'get_task_history', { taskId: null });
  expect(sideNullTask.ok).toBe(false);
  expect(sideNullTask.error).toMatch(/taskId/);
  expect(sideNullTask.error).not.toMatch(/Task not found/);
});

test('claim_next: the sidecar never claims from the queue, with absent and null taskId alike', async () => {
  // The sidecar channel never claims for the employee: the dispatcher does. Absent and null are refused alike.
  for (const args of [{}, { taskId: null }]) {
    const side = await viaSidecar(env.holderA!, 'claim_next', args);
    expect(side.ok).toBe(false);
    expect(sidecarCode(side)).toBe('forbidden');
  }
});

test('heartbeat: the sidecar keepalive answers absent and null arguments alike', async () => {
  // The sidecar heartbeat is a keepalive answer that the sidecar owns; absent and null give the same answer.
  expect(await viaSidecar(env.holderA!, 'heartbeat', {})).toEqual(await viaSidecar(env.holderA!, 'heartbeat', { pageSize: null, cursor: null }));
});
