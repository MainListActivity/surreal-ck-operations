import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordId } from 'surrealdb';
import { loadDatabaseConfig } from '../src/config.ts';
import { CompanyDatabase } from '../src/database.ts';
import { SurrealCompanyCore } from '../src/core.ts';
import { LocalEnrollmentAdmin } from '../src/enrollment.ts';
import { OwnerDesk } from '../src/owner.ts';
import { ProjectStore } from '../src/projects.ts';
import { createMcpHttpService } from '../src/mcp/server.ts';
import { connectCompanyClient } from '../src/mcp/client.ts';
import { SidecarPool, type SidecarDeps } from '../plugin/server/sidecar.ts';
import type { EmployeeInst } from '../src/workforce.ts';
import type { CreateTask } from '../src/contracts.ts';
import { PROJECT_TEXT_LIMITS } from '../src/input-bounds.ts';

setDefaultTimeout(180_000);
const NS = 'sck_agent_company_test_input_bounds';
const database = new CompanyDatabase({ ...loadDatabaseConfig(), namespace: NS, database: 'control_plane' });
const core = new SurrealCompanyCore(database);
const enrollment = new LocalEnrollmentAdmin(database);
const owner = new OwnerDesk(database);
let gm = '';
let eng = '';
const suffix = randomUUID().slice(0, 8);
const key = (label: string) => `ib-${suffix}-${label}-${randomUUID().slice(0, 8)}`;

beforeAll(async () => {
  await database.connect();
  await database.db.query(`DEFINE NAMESPACE IF NOT EXISTS ${NS};`);
  await database.db.use({ namespace: NS });
  await database.db.query('REMOVE DATABASE IF EXISTS control_plane;');
  await database.bootstrap();
  gm = await enrollment.enroll(`ib-gm-${suffix}`, 'gm', ['execute', 'review', 'manage']);
  eng = await enrollment.enroll(`ib-eng-${suffix}`, 'engineering', ['execute', 'review']);
});
afterAll(async () => { await database.close(); });

const input = (label: string, extra: Partial<CreateTask> = {}): CreateTask => ({
  title: `Input bounds ${label} ${suffix}`,
  context: 'Synthetic input-bounds fixture; isolated company fork only.',
  executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: key(label), ...extra,
});
async function count(table: 'task' | 'audit' | 'outbox' | 'idempotency'): Promise<number> {
  const [rows] = await database.db.query<[Array<{ c: number }>]>(`SELECT count() AS c FROM ${table} GROUP ALL;`);
  return rows[0]?.c ?? 0;
}
const counts = async () => ({
  task: await count('task'), audit: await count('audit'), outbox: await count('outbox'), idempotency: await count('idempotency'),
});
async function errorOf(action: Promise<unknown>): Promise<Error & { code?: string }> {
  return action.then(() => { throw new Error('expected a refusal'); }, error => error as Error & { code?: string });
}
const paths = (count: number, tail = 280): string[] => Array.from({ length: count }, (_, index) => `assets/${index}/${'a'.repeat(tail)}`);
/** 16 entries: 15 full 2048-byte entries plus one sized so JSON.stringify has exactly total bytes. */
function runbooksAtTotal(total: number): string[] {
  const count = 16;
  const sum = total - (3 * count + 1);
  const entries = Array.from({ length: count - 1 }, () => 'a'.repeat(PROJECT_TEXT_LIMITS.runbookBytes));
  return [...entries, 'a'.repeat(sum - (count - 1) * PROJECT_TEXT_LIMITS.runbookBytes)];
}

test('external create_task caps the raw dependency list before de-duplication, with zero task/audit/outbox/idempotency writes', async () => {
  const dep = await core.createTask(gm, input('dependency'));
  const before = await counts();
  const fifty = await core.createTask(gm, input('fifty', { dependencies: Array(50).fill(dep.id) }));
  expect(fifty.dependencies).toEqual([dep.id]);
  const afterFifty = await counts();
  const refused = await errorOf(core.createTask(gm, input('fifty-one', { dependencies: Array(51).fill(dep.id) })));
  expect(refused.code).toBe('invalid');
  expect(refused.message).toContain('dependencies count 51 exceeds limit 50');
  expect(await counts()).toEqual(afterFifty);
  const longId = await errorOf(core.createTask(gm, input('long-id', { dependencies: ['x'.repeat(201)] })));
  expect(longId.code).toBe('invalid');
  expect(longId.message).toContain('dependencies[0]');
  expect(await counts()).toEqual(afterFifty);
  const beforeDenied = await counts();
  const denied = await errorOf(core.createTask(eng, input('denied', { dependencies: Array(51).fill(dep.id) })));
  expect(denied.code).toBe('forbidden');
  expect(await counts()).toEqual(beforeDenied);
  const idem = input('idempotent', { dependencies: Array(50).fill(dep.id) });
  const first = await core.createTask(gm, idem);
  const second = await core.createTask(gm, idem);
  expect(second.id).toBe(first.id);
  expect(before.task).toBeGreaterThan(0);
});

test('asset intent has the same 50-entry and 300-character limits through core, and non-assets cannot carry paths', async () => {
  const before = await counts();
  const fifty = await core.createTask(gm, input('paths-fifty', {
    executorRole: 'asset-production', workIntent: { kind: 'assets', paths: paths(50) },
  }));
  // createTask's answer is budget-bounded; the stored task is the authority for all 50 paths.
  expect((await core.getTask(gm, fifty.id)).workIntent?.paths).toHaveLength(50);
  const tooMany = await errorOf(core.createTask(gm, input('paths-fifty-one', {
    executorRole: 'asset-production', workIntent: { kind: 'assets', paths: paths(51) },
  })));
  expect(tooMany.code).toBe('invalid');
  const tooLong = await errorOf(core.createTask(gm, input('path-long', {
    executorRole: 'asset-production', workIntent: { kind: 'assets', paths: [`assets/${'a'.repeat(294)}`] },
  })));
  expect(tooLong.code).toBe('invalid');
  const nonAsset = await errorOf(core.createTask(gm, input('paths-code', {
    workIntent: { kind: 'code', paths: ['assets/a'] },
  })));
  expect(nonAsset.code).toBe('invalid');
  expect((await counts()).task).toBe(before.task + 1);
});

test('MCP create_task reaches the same real core refusal for the 51st dependency', async () => {
  const dep = await core.createTask(gm, input('mcp-dependency'));
  const service = createMcpHttpService({ core, port: 0 });
  const connection = await connectCompanyClient({
    url: new URL(`http://127.0.0.1:${service.port}/mcp`), credential: gm, clientName: `input-bounds-${suffix}`,
  });
  try {
    const result = await connection.client.callTool({
      name: 'create_task',
      arguments: { ...input('mcp-fifty-one'), dependencies: Array(51).fill(dep.id) },
    });
    expect(result.structuredContent).toMatchObject({ ok: false, code: 'invalid' });
    expect(String((result.structuredContent as { error?: string }).error)).toContain('dependencies count 51 exceeds limit 50');
    const tooManyPaths = await connection.client.callTool({
      name: 'create_task',
      arguments: { ...input('mcp-paths-fifty-one'), executorRole: 'asset-production', workIntent: { kind: 'assets', paths: paths(51) } },
    });
    expect(tooManyPaths.structuredContent).toMatchObject({ ok: false, code: 'invalid' });
  } finally {
    await connection.close();
    await service.close();
  }
});

test('the real sidecar channel reaches the same core refusal for the 51st dependency', async () => {
  const dep = await core.createTask(gm, input('sidecar-dependency'));
  const runDir = mkdtempSync(join(tmpdir(), 'input-bounds-sidecar-'));
  const pool = new SidecarPool({
    core, workforce: { rotate: async () => gm } as unknown as SidecarDeps['workforce'], runDir, sweepMs: 5,
  });
  try {
    const channel = pool.env({ id: `input-bounds-${suffix}`, credential: gm } as EmployeeInst);
    const child = Bun.spawn([process.execPath, join(import.meta.dir, '..', 'src/mcp/client-cli.ts'), 'call', 'create_task',
      JSON.stringify({ ...input('sidecar-fifty-one'), dependencies: Array(51).fill(dep.id) })], {
      cwd: join(import.meta.dir, '..'), stdout: 'pipe', stderr: 'pipe',
      env: { ...process.env, SCK_COMM_DIR: channel.SCK_COMM_DIR, SCK_COMM_KEY: channel.SCK_COMM_KEY },
    });
    const [out, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit, stderr).toBe(1);
    const answer = JSON.parse(out) as { ok: boolean; code?: string; error?: string };
    expect(answer).toMatchObject({ ok: false, code: 'invalid' });
    expect(answer.error).toContain('dependencies count 51 exceeds limit 50');
    const pathsChild = Bun.spawn([process.execPath, join(import.meta.dir, '..', 'src/mcp/client-cli.ts'), 'call', 'create_task',
      JSON.stringify({ ...input('sidecar-paths-fifty-one'), executorRole: 'asset-production', workIntent: { kind: 'assets', paths: paths(51) } })], {
      cwd: join(import.meta.dir, '..'), stdout: 'pipe', stderr: 'pipe',
      env: { ...process.env, SCK_COMM_DIR: channel.SCK_COMM_DIR, SCK_COMM_KEY: channel.SCK_COMM_KEY },
    });
    const [pathsOut, pathsErr, pathsExit] = await Promise.all([
      new Response(pathsChild.stdout).text(), new Response(pathsChild.stderr).text(), pathsChild.exited,
    ]);
    expect(pathsExit, pathsErr).toBe(1);
    expect(JSON.parse(pathsOut)).toMatchObject({ ok: false, code: 'invalid' });
  } finally {
    pool.close();
    rmSync(runDir, { recursive: true, force: true });
  }
});

test('ProjectStore rejects new over-size public text before any project or env write, and preserves unchanged old values', async () => {
  const store = new ProjectStore(database.db);
  const projectId = `ib-project-${suffix}`;
  const base = { id: projectId, name: 'Input bounds', repoPath: '/fixture/input-bounds', envs: [] };
  await store.upsert({ ...base, release: 'a'.repeat(PROJECT_TEXT_LIMITS.releaseBytes) });
  expect((await store.textLengths(projectId))!.release).toMatchObject({
    bytes: PROJECT_TEXT_LIMITS.releaseBytes, limit: PROJECT_TEXT_LIMITS.releaseBytes, over: false,
  });
  const badId = `ib-bad-${suffix}`;
  await expect(store.upsert({ ...base, id: badId, release: 'a'.repeat(PROJECT_TEXT_LIMITS.releaseBytes + 1), envs: [{ name: 'production' }] }))
    .rejects.toMatchObject({ code: 'invalid' });
  expect(await store.get(badId)).toBeUndefined();
  const [envRows] = await database.db.query<[Array<{ c: number }>]>(
    'SELECT count() AS c FROM project_env WHERE project = $project GROUP ALL;', { project: new RecordId('project', badId) });
  expect(envRows[0]?.c ?? 0).toBe(0);
  await expect(store.upsert({ ...base, release: 'a'.repeat(PROJECT_TEXT_LIMITS.releaseBytes + 1) })).rejects.toMatchObject({ code: 'invalid' });
  expect((await store.get(projectId))!.release).toBe('a'.repeat(PROJECT_TEXT_LIMITS.releaseBytes));
  await store.upsert({ ...base, release: 'ok', notes: 'n'.repeat(PROJECT_TEXT_LIMITS.notesBytes) });
  await expect(store.upsert({ ...base, release: 'ok', notes: 'n'.repeat(PROJECT_TEXT_LIMITS.notesBytes + 1) })).rejects.toMatchObject({ code: 'invalid' });
  const exactRunbooks = runbooksAtTotal(PROJECT_TEXT_LIMITS.runbooksTotalBytes);
  await store.upsert({ ...base, release: 'ok', runbooks: exactRunbooks });
  expect((await store.textLengths(projectId))!.runbooks.totalBytes).toBe(PROJECT_TEXT_LIMITS.runbooksTotalBytes);
  await expect(store.upsert({ ...base, release: 'ok', runbooks: runbooksAtTotal(PROJECT_TEXT_LIMITS.runbooksTotalBytes + 1) }))
    .rejects.toMatchObject({ code: 'invalid' });

  const longRelease = 'a'.repeat(PROJECT_TEXT_LIMITS.releaseBytes + 1);
  const longNotes = 'n'.repeat(PROJECT_TEXT_LIMITS.notesBytes + 1);
  const longRunbooks = ['r'.repeat(PROJECT_TEXT_LIMITS.runbookBytes + 1)];
  await database.db.query('UPDATE $project SET release = $release, notes = $notes, runbooks = $runbooks;', {
    project: new RecordId('project', projectId), release: longRelease, notes: longNotes, runbooks: longRunbooks,
  });
  expect((await store.get(projectId))!.release).toBe(longRelease);
  const lengths = (await store.textLengths(projectId))!;
  expect(lengths.release.over).toBe(true);
  expect(lengths.notes.over).toBe(true);
  expect(lengths.runbooks.over).toBe(true);
  expect(JSON.stringify(lengths)).not.toContain('aaaaaaaaaaaaaaaaaaaa');
  await store.upsert({ ...base, release: longRelease, notes: longNotes, runbooks: longRunbooks });
  expect((await store.get(projectId))!.notes).toBe(longNotes);
  await expect(store.upsert({ ...base, release: 'b'.repeat(PROJECT_TEXT_LIMITS.releaseBytes + 1), notes: longNotes, runbooks: longRunbooks }))
    .rejects.toMatchObject({ code: 'invalid' });
  await store.upsert({ ...base, release: 'legal', notes: longNotes, runbooks: longRunbooks });
  expect((await store.get(projectId))!.release).toBe('legal');
  expect((await store.get(projectId))!.runbooks).toEqual(longRunbooks);
  const checked = await store.checkInput({ ...base, release: 'legal', notes: longNotes, runbooks: longRunbooks });
  expect(checked.ok).toBe(true);
  expect(checked.lengths.notes.over).toBe(true);
  expect(JSON.stringify(checked)).not.toContain('nnnnnnnnnnnnnnnnnnnn');
});

test('external create_delivery caps the raw dependency list before de-duplication, with zero task/audit/outbox/idempotency writes', async () => {
  const dep = await core.createTask(gm, input('delivery-dependency'));
  const goal = await owner.createGoal({ text: 'Input bounds delivery goal', source: 'owner:test', key: key('delivery-goal'), tier: 'quick' });
  const before = await counts();
  const refused = await errorOf(core.createDelivery(gm, {
    goalId: goal.id, title: 'Input bounds delivery', spec: 'Synthetic create_delivery fixture for the external dependency bound.',
    dependencies: Array(51).fill(dep.id), idempotencyKey: key('delivery-fifty-one'),
  }));
  expect(refused.code).toBe('invalid');
  expect(refused.message).toContain('dependencies count 51 exceeds limit 50');
  expect(await counts()).toEqual(before);
  const longId = await errorOf(core.createDelivery(gm, {
    goalId: goal.id, title: 'Input bounds delivery', spec: 'Synthetic create_delivery fixture for the external dependency bound.',
    dependencies: ['x'.repeat(201)], idempotencyKey: key('delivery-long-id'),
  }));
  expect(longId.code).toBe('invalid');
  expect(longId.message).toContain('dependencies[0]');
  expect(await counts()).toEqual(before);
  // 50 raw entries are accepted; the chain still records one edge on the first leg and its own legs after it.
  const fiftyKey = key('delivery-fifty');
  const fifty = await core.createDelivery(gm, {
    goalId: goal.id, title: 'Input bounds delivery', spec: 'Synthetic create_delivery fixture for the external dependency bound.',
    dependencies: Array(50).fill(dep.id), idempotencyKey: fiftyKey,
  });
  expect(fifty).toHaveLength(3);
  const legs = await Promise.all(fifty.map(leg => core.getTask(gm, leg.id)));
  expect(legs[0]!.dependencies).toEqual([dep.id]);
  expect(legs[1]!.dependencies).toEqual([legs[0]!.id]);
  expect(legs[2]!.dependencies).toEqual([legs[1]!.id]);
  // The same idempotency key replays the same legs instead of creating a second chain.
  const replay = await core.createDelivery(gm, {
    goalId: goal.id, title: 'Input bounds delivery', spec: 'Synthetic create_delivery fixture for the external dependency bound.',
    dependencies: Array(50).fill(dep.id), idempotencyKey: fiftyKey,
  });
  expect(replay.map(leg => leg.id)).toEqual(fifty.map(leg => leg.id));
});

test('MCP create_delivery reaches the same real core refusal for the 51st dependency, with zero writes', async () => {
  const dep = await core.createTask(gm, input('mcp-delivery-dependency'));
  const goal = await owner.createGoal({ text: 'MCP input bounds delivery goal', source: 'owner:test', key: key('mcp-delivery-goal'), tier: 'quick' });
  const before = await counts();
  const service = createMcpHttpService({ core, port: 0 });
  const connection = await connectCompanyClient({
    url: new URL(`http://127.0.0.1:${service.port}/mcp`), credential: gm, clientName: `input-bounds-delivery-${suffix}`,
  });
  try {
    const result = await connection.client.callTool({
      name: 'create_delivery',
      arguments: {
        goalId: goal.id, title: 'MCP input bounds delivery', spec: 'Synthetic MCP create_delivery fixture for the external dependency bound.',
        dependencies: Array(51).fill(dep.id), idempotencyKey: key('mcp-delivery'),
      },
    });
    expect(result.structuredContent).toMatchObject({ ok: false, code: 'invalid' });
    expect(String((result.structuredContent as { error?: string }).error)).toContain('dependencies count 51 exceeds limit 50');
    expect(await counts()).toEqual(before);
  } finally {
    await connection.close();
    await service.close();
  }
});

test('the real sidecar channel reaches the same core refusal for the 51st create_delivery dependency, with zero writes', async () => {
  const dep = await core.createTask(gm, input('sidecar-delivery-dependency'));
  const goal = await owner.createGoal({ text: 'Sidecar input bounds delivery goal', source: 'owner:test', key: key('sidecar-delivery-goal'), tier: 'quick' });
  const before = await counts();
  const runDir = mkdtempSync(join(tmpdir(), 'input-bounds-delivery-sidecar-'));
  const pool = new SidecarPool({
    core, workforce: { rotate: async () => gm } as unknown as SidecarDeps['workforce'], runDir, sweepMs: 5,
  });
  try {
    const channel = pool.env({ id: `input-bounds-delivery-${suffix}`, credential: gm } as EmployeeInst);
    const child = Bun.spawn([process.execPath, join(import.meta.dir, '..', 'src/mcp/client-cli.ts'), 'call', 'create_delivery',
      JSON.stringify({
        goalId: goal.id, title: 'Sidecar input bounds delivery', spec: 'Synthetic sidecar create_delivery fixture for the external dependency bound.',
        dependencies: Array(51).fill(dep.id), idempotencyKey: key('sidecar-delivery'),
      })], {
      cwd: join(import.meta.dir, '..'), stdout: 'pipe', stderr: 'pipe',
      env: { ...process.env, SCK_COMM_DIR: channel.SCK_COMM_DIR, SCK_COMM_KEY: channel.SCK_COMM_KEY },
    });
    const [out, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit, stderr).toBe(1);
    const answer = JSON.parse(out) as { ok: boolean; code?: string; error?: string };
    expect(answer).toMatchObject({ ok: false, code: 'invalid' });
    expect(answer.error).toContain('dependencies count 51 exceeds limit 50');
    expect(await counts()).toEqual(before);
  } finally {
    pool.close();
    rmSync(runDir, { recursive: true, force: true });
  }
});
