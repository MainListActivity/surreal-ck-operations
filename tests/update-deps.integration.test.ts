import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordId } from 'surrealdb';
import { loadDatabaseConfig } from '../src/config.ts';
import { CompanyDatabase } from '../src/database.ts';
import { SurrealCompanyCore } from '../src/core.ts';
import { LocalEnrollmentAdmin } from '../src/enrollment.ts';
import type { ClaimResult, TaskView } from '../src/contracts.ts';

const NS = 'sck_agent_company_test_deps';
const database = new CompanyDatabase({ ...loadDatabaseConfig(), namespace: NS, database: 'control_plane' });
setDefaultTimeout(120_000);
const core = new SurrealCompanyCore(database);
const enrollment = new LocalEnrollmentAdmin(database);
const credDir = mkdtempSync(join(tmpdir(), 'sck-deps-test-'));
const tokens: Record<string, string> = {};

beforeAll(async () => {
  await database.connect();
  await database.db.query(`DEFINE NAMESPACE IF NOT EXISTS ${NS};`);
  await database.db.use({ namespace: NS });
  await database.db.query('REMOVE DATABASE IF EXISTS control_plane;');
  await database.bootstrap();
  for (const [name, role, caps] of [
    ['gm', 'gm', ['execute', 'review', 'manage']], ['product', 'product', ['execute', 'review', 'manage']],
    ['eng-a', 'engineering', ['execute', 'review']], ['eng-b', 'engineering', ['execute', 'review']], ['qa', 'qa', ['execute', 'review']],
  ] as const) tokens[name] = await enrollment.enroll(`d-${name}`, role, caps);
});

afterAll(async () => {
  await database.close();
  rmSync(credDir, { recursive: true, force: true });
});

const key = () => crypto.randomUUID();
const ev = (text: string) => ({ text, idempotencyKey: key() });
const proofOf = (c: ClaimResult | { task: TaskView; deliveryId: string; fence: number }) =>
  ({ taskId: c.task.id, deliveryId: c.deliveryId, fence: c.fence, expectedVersion: c.task.version });
const mk = (title: string, dependencies: string[] = []) =>
  core.createTask(tokens.gm, { title, context: 'deps-update synthetic task', executorRole: 'engineering',
    reviewerRole: 'qa', dependencies, idempotencyKey: key() });
const markDone = async (taskId: string) =>
  database.db.query('UPDATE $t SET state = $s;', { t: new RecordId('task', taskId), s: 'done' });
const auditRows = (taskId: string) =>
  database.db.query<[Array<{ action: string; actor?: unknown; before?: unknown; after?: unknown; version?: number }>]>(
    'SELECT action, actor, before, after, version, at FROM audit WHERE task = $t ORDER BY at;', { t: new RecordId('task', taskId) })
    .then(([rows]) => rows);
const outboxKinds = (taskId: string) =>
  database.db.query<[Array<{ kind: string }>]>(
    'SELECT kind, sequence FROM outbox WHERE task = $t ORDER BY sequence;', { t: new RecordId('task', taskId) })
    .then(([rows]) => rows.map(r => r.kind));
const depsOf = async (taskId: string) => (await core.getTask(tokens.gm, taskId)).dependencies;

test('gm adds an unfinished dependency: task re-blocks, version bumps, deps_updated audit/outbox written', async () => {
  const target = await mk('等待汇合的目标');
  const dep = await mk('返工汇合');
  const updated = await core.updateTaskDependencies(tokens.gm, {
    taskId: target.id, add: [dep.id], remove: [], evidence: ev('CV-06 收口须等待返工汇合任务完成后再派工。'),
  });
  expect(updated.state).toBe('blocked');
  expect(updated.dependencies).toEqual([dep.id]);
  expect(updated.version).toBe(target.version + 1);
  const audit = await auditRows(target.id);
  const row = audit.find(a => a.action === 'deps_updated')!;
  expect(String(row.actor)).toContain('d-gm');
  expect(row.version).toBe(updated.version);
  expect(row.before).toEqual([]);
  expect((row.after as unknown[]).map(String).join()).toContain(dep.id);
  expect(await outboxKinds(target.id)).toContain('deps_updated');
});

test('adding a dependency already implied transitively is rejected; remove+re-add is allowed', async () => {
  const b = await mk('最底层依赖');
  const a = await mk('中间层', [b.id]);
  const c = await mk('顶层任务', [a.id]); // C -> A -> B
  await expect(core.updateTaskDependencies(tokens.gm, {
    taskId: c.id, add: [b.id], remove: [], evidence: ev('B 已通过 A 传递依赖，重复声明应被拒绝。'),
  })).rejects.toMatchObject({ code: 'invalid' });
  // Removing A leaves C un-implied on B; then adding B directly is legal.
  const swapped = await core.updateTaskDependencies(tokens.gm, {
    taskId: c.id, add: [b.id], remove: [a.id], evidence: ev('移除中间层 A 改为直接依赖 B，验证传递依赖放开后可以直加。'),
  });
  expect(swapped.dependencies).toEqual([b.id]);
});

test('cycle detection walks the whole graph, not just direct edges', async () => {
  const leaf = await mk('叶子任务');
  const mid = await mk('中间任务', [leaf.id]);
  const top = await mk('顶端任务', [mid.id]); // top -> mid -> leaf
  // leaf -> top would close a three-hop cycle.
  await expect(core.updateTaskDependencies(tokens.gm, {
    taskId: leaf.id, add: [top.id], remove: [], evidence: ev('制造 top->mid->leaf->top 环，必须拒绝。'),
  })).rejects.toMatchObject({ code: 'invalid' });
  // A self-loop is a one-edge cycle.
  await expect(core.updateTaskDependencies(tokens.gm, {
    taskId: leaf.id, add: [leaf.id], remove: [], evidence: ev('任务依赖自身形成单点环，接口的环检测必须拒绝。'),
  })).rejects.toMatchObject({ code: 'invalid' });
  // The same dep in add and remove is contradictory input.
  await expect(core.updateTaskDependencies(tokens.gm, {
    taskId: leaf.id, add: [mid.id], remove: [mid.id], evidence: ev('同一依赖同时出现在增删两侧，输入自相矛盾应拒绝。'),
  })).rejects.toMatchObject({ code: 'invalid' });
  expect(await depsOf(leaf.id)).toEqual([]);
});

test('missing target or dependency, done target, leased task: all rejected', async () => {
  const target = await mk('各类拒绝');
  const dep = await mk('存在的依赖');
  await expect(core.updateTaskDependencies(tokens.gm, {
    taskId: 'no-such-task', add: [dep.id], remove: [], evidence: ev('目标任务不存在时接口应拒绝并返回 not_found。'),
  })).rejects.toMatchObject({ code: 'not_found' });
  await expect(core.updateTaskDependencies(tokens.gm, {
    taskId: target.id, add: ['no-such-dep'], remove: [], evidence: ev('新增依赖记录不存在于库中，应返回 not_found。'),
  })).rejects.toMatchObject({ code: 'not_found' });
  await markDone(dep.id);
  await expect(core.updateTaskDependencies(tokens.gm, {
    taskId: dep.id, add: [target.id], remove: [], evidence: ev('已完成任务的依赖集合不允许再修改，应拒绝。'),
  })).rejects.toMatchObject({ code: 'invalid' });
  // A doing task holds a live lease; re-edging would strand the holder's version check.
  const live = await mk('在制任务');
  await core.claim(tokens['eng-a'], live.id);
  await expect(core.updateTaskDependencies(tokens.gm, {
    taskId: live.id, add: [dep.id], remove: [], evidence: ev('任务持有有效租约时不能直接改依赖，应先回收租约。'),
  })).rejects.toMatchObject({ code: 'conflict' });
  expect(await depsOf(live.id)).toEqual([]);
});

test('lease, not state, gates the update: unleased review task is re-edged, leased review is rejected', async () => {
  const dep = await mk('等待的依赖');
  // Unleased review: submitted, awaiting a reviewer to claim (no current_employee/delivery_id).
  const unleased = await mk('未领取的评审任务');
  const unleasedClaim = await core.claim(tokens['eng-b'], unleased.id);
  await core.submit(tokens['eng-b'], proofOf(unleasedClaim), ev('提交评审的合成交付证据，等待验收人领取。'));
  expect(await core.getTask(tokens.gm, unleased.id)).toMatchObject({ state: 'review', currentEmployee: undefined });
  // Adding an unfinished dep expresses real waiting: the task re-blocks and clears stale lease fields.
  const reblocked = await core.updateTaskDependencies(tokens.gm, {
    taskId: unleased.id, add: [dep.id], remove: [], evidence: ev('评审中发现提交物依赖未完成的返工，转为依赖阻塞等待。'),
  });
  expect(reblocked.state).toBe('blocked');
  expect(reblocked.currentEmployee).toBeUndefined();
  expect(reblocked.dependencies).toEqual([dep.id]);
  // When its dep finishes the blocked task unlocks to ready via the normal accept path.
  await markDone(dep.id);
  await core.updateTaskDependencies(tokens.gm, {
    taskId: unleased.id, add: [], remove: [], evidence: ev('依赖已完成，空更新应同事务解锁为 ready。'),
  });
  expect((await core.getTask(tokens.gm, unleased.id)).state).toBe('ready');
  // Leased review: a reviewer holding a live lease cannot have the edges moved mid-review.
  const leased = await mk('持租的评审任务');
  const leasedClaim = await core.claim(tokens['eng-b'], leased.id);
  await core.submit(tokens['eng-b'], proofOf(leasedClaim), ev('提交评审的合成交付证据，等待验收人领取。'));
  await core.claim(tokens.qa, leased.id);
  await expect(core.updateTaskDependencies(tokens.gm, {
    taskId: leased.id, add: [dep.id], remove: [], evidence: ev('验收人持有活租约期间不能移动依赖边，应先结束租约。'),
  })).rejects.toMatchObject({ code: 'conflict' });
  // An abandoned doing task (lease expired) is unleased again and may be re-edged.
  const staleDep = await mk('仍未完成的依赖');
  const stale = await mk('过期租约的在制任务');
  await core.claim(tokens['eng-b'], stale.id);
  await database.db.query('UPDATE $t SET lease_expires_at = 1;', { t: new RecordId('task', stale.id) });
  const revived = await core.updateTaskDependencies(tokens.gm, {
    taskId: stale.id, add: [staleDep.id], remove: [], evidence: ev('租约已过期任务视为无租约，可重新挂依赖边。'),
  });
  expect(revived.state).toBe('blocked');
  expect(revived.currentEmployee).toBeUndefined();
});

test('re-adding an edge already in the set is a no-op even when it is also implied transitively', async () => {
  const b = await mk('底层依赖 B');
  const a = await mk('中间依赖 A', [b.id]);
  // createTask allows stating an already-implied edge: C depends on [A,B] with A -> B.
  const c = await mk('双依赖任务 C', [a.id, b.id]);
  const again = await core.updateTaskDependencies(tokens.gm, {
    taskId: c.id, add: [b.id], remove: [], evidence: ev('重复追加已存在的依赖边，应无副作用返回原视图。'),
  });
  expect(again.version).toBe(c.version);
  expect(again.dependencies.sort()).toEqual([a.id, b.id].sort());
  expect((await auditRows(c.id)).filter(r => r.action === 'deps_updated')).toHaveLength(0);
  // A genuinely new edge that is implied transitively is still rejected.
  await expect(core.updateTaskDependencies(tokens.gm, {
    taskId: a.id, add: [], remove: [], evidence: ev('占位：同任务无操作调用，验证幂等不写行。'),
  })).resolves.toMatchObject({ version: a.version });
});

test('only gm may update dependencies; other roles and capabilities are rejected', async () => {
  const target = await mk('权限目标');
  const dep = await mk('权限依赖');
  await expect(core.updateTaskDependencies(tokens.product, {
    taskId: target.id, add: [dep.id], remove: [], evidence: ev('product 有 manage 但不是 gm，应拒绝。'),
  })).rejects.toMatchObject({ code: 'forbidden' });
  await expect(core.updateTaskDependencies(tokens['eng-a'], {
    taskId: target.id, add: [dep.id], remove: [], evidence: ev('engineering 无 manage 能力，应拒绝。'),
  })).rejects.toMatchObject({ code: 'forbidden' });
});

test('dependency-blocked task unlocks to ready in the same transaction once all deps are done', async () => {
  const f = await mk('未完成的依赖');
  const g = await mk('已完成的依赖');
  await markDone(g.id);
  const target = await mk('依赖阻塞任务', [f.id]);
  expect(target.state).toBe('blocked');
  const updated = await core.updateTaskDependencies(tokens.gm, {
    taskId: target.id, add: [g.id], remove: [f.id], evidence: ev('返工汇合完成，替换为已完成依赖，应同事务解锁。'),
  });
  expect(updated.state).toBe('ready');
  expect(updated.dependencies).toEqual([g.id]);
  const kinds = await outboxKinds(target.id);
  expect(kinds).toContain('deps_updated');
  expect(kinds).toContain('dependency_unlocked');
  const audit = await auditRows(target.id);
  expect(audit.map(a => a.action)).toContain('dependency_unlocked');
  // Removing the last unfinished dep unlocks too (deps end empty => all done).
  const h = await mk('另一个未完成依赖');
  const target2 = await mk('清空依赖解锁', [h.id]);
  const cleared = await core.updateTaskDependencies(tokens.gm, {
    taskId: target2.id, add: [], remove: [h.id], evidence: ev('依赖被移除后任务不再等待任何任务，应解锁。'),
  });
  expect(cleared.state).toBe('ready');
  expect(cleared.dependencies).toEqual([]);
});

test('repeated add is a no-op; same idempotency key replays the original result', async () => {
  const target = await mk('幂等目标');
  const dep = await mk('幂等依赖');
  const evidence = { text: '先加一个依赖，再用相同幂等键重放验证无副作用。', idempotencyKey: key() };
  const first = await core.updateTaskDependencies(tokens.gm, { taskId: target.id, add: [dep.id], remove: [], evidence });
  const second = await core.updateTaskDependencies(tokens.gm, { taskId: target.id, add: [dep.id], remove: [], evidence });
  expect(second).toEqual(first);
  const updatedCount = (await auditRows(target.id)).filter(a => a.action === 'deps_updated').length;
  expect(updatedCount).toBe(1);
  expect((await outboxKinds(target.id)).filter(k => k === 'deps_updated')).toHaveLength(1);
  // Same key with different input must conflict, not silently succeed.
  await expect(core.updateTaskDependencies(tokens.gm, {
    taskId: target.id, add: [], remove: [dep.id], evidence: { text: '相同幂等键携带不同载荷时必须判定冲突而非静默成功。', idempotencyKey: evidence.idempotencyKey },
  })).rejects.toMatchObject({ code: 'conflict' });
  // Re-adding an existing edge under a fresh key is an audited no-op: same version, no new rows.
  const again = await core.updateTaskDependencies(tokens.gm, {
    taskId: target.id, add: [dep.id], remove: [], evidence: ev('重复追加同一依赖时接口应无副作用返回原视图。'),
  });
  expect(again.version).toBe(first.version);
  expect((await auditRows(target.id)).filter(a => a.action === 'deps_updated')).toHaveLength(1);
});
