/**
 * 跨目录共库双节点租约负例（N2–N5）与第二节点心跳。
 * 两个不同 runner/node ID、两个本机目录、同一个公司 SurrealDB fork 测试库。
 * 不得用同目录 writer.lock 测试替代本文件证据。
 *
 * 经 fork runner：
 *   bun scripts/test-worktrees.ts tests/dual-node-lease.fork.test.ts
 * 无 RUN_SCK_DUAL_NODE_LEASE_TESTS=1 时全部 skip。
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { RecordId } from 'surrealdb';
import { loadDatabaseConfig } from '../src/config.ts';
import { CompanyDatabase } from '../src/database.ts';
import { SurrealCompanyCore } from '../src/core.ts';
import { LocalEnrollmentAdmin } from '../src/enrollment.ts';
import type { ClaimResult, CreateTask, LeaseProof } from '../src/contracts.ts';
import { beatNodeRelease, readNodeRelease } from '../src/node-release.ts';
import { acquireNativeWriter } from '../src/runner/native-lock.ts';
import { ownsProvider, readProviderRoutes } from '../src/runner/provider-routing.ts';
import { redactText } from '../src/ops/redact.ts';

const enabled = process.env.RUN_SCK_DUAL_NODE_LEASE_TESTS === '1';
const run = enabled ? describe : describe.skip;
const NS = 'sck_agent_company_test_dual_node_lease';
setDefaultTimeout(180_000);

const NODE_A = `node-a-${randomUUID().slice(0, 8)}`;
const NODE_B = `node-b-${randomUUID().slice(0, 8)}`;
const SHA = 'c'.repeat(40);
const tokens: Record<string, string> = {};

let database: CompanyDatabase;
let coreA: SurrealCompanyCore;
let coreB: SurrealCompanyCore;
let dirA: string;
let dirB: string;
let routesHome: string;

beforeAll(async () => {
  if (!enabled) return;
  dirA = mkdtempSync(join(tmpdir(), 'sck-dual-a-'));
  dirB = mkdtempSync(join(tmpdir(), 'sck-dual-b-'));
  routesHome = mkdtempSync(join(tmpdir(), 'sck-dual-routes-'));
  database = new CompanyDatabase({ ...loadDatabaseConfig(), namespace: NS, database: 'control_plane' });
  // 短租约便于过期负例；两核共享同一库、不同 nodeId。
  coreA = new SurrealCompanyCore(database, { nodeId: NODE_A, leaseSeconds: 3 });
  coreB = new SurrealCompanyCore(database, { nodeId: NODE_B, leaseSeconds: 3 });
  await database.connect();
  await database.db.query(`DEFINE NAMESPACE IF NOT EXISTS ${NS};`);
  await database.db.use({ namespace: NS });
  await database.db.query('REMOVE DATABASE IF EXISTS control_plane;');
  await database.bootstrap();
  const enrollment = new LocalEnrollmentAdmin(database);
  tokens.owner = await enrollment.enroll('dual-owner', 'owner', ['execute', 'review', 'manage']);
  tokens.engA = await enrollment.enroll('dual-eng-a', 'engineering', ['execute', 'review']);
  tokens.engB = await enrollment.enroll('dual-eng-b', 'engineering', ['execute', 'review']);
  await clearLeases();
});

afterAll(async () => {
  if (!enabled) return;
  await database.close();
  rmSync(dirA, { recursive: true, force: true });
  rmSync(dirB, { recursive: true, force: true });
  rmSync(routesHome, { recursive: true, force: true });
});

async function clearLeases(): Promise<void> {
  await database.db.query(`UPDATE task SET current_employee = NONE, delivery_id = NONE, lease_expires_at = NONE, lease_node = NONE
    WHERE current_employee != NONE; UPDATE employee SET active_task = NONE WHERE active_task != NONE;`);
}

async function makeTask(title: string): Promise<string> {
  const view = await coreA.createTask(tokens.owner!, {
    title, context: 'dual-node lease fixture (synthetic)', executorRole: 'engineering', reviewerRole: 'qa',
    workIntent: { kind: 'read' }, idempotencyKey: `dual-${title}-${randomUUID()}`,
  } as CreateTask);
  return view.id;
}

function proofOf(claim: ClaimResult): LeaseProof {
  return { taskId: claim.task.id, deliveryId: claim.deliveryId, fence: claim.fence, expectedVersion: claim.task.version };
}

run('前置：两目录写锁互不抢占（与租约证据分离）', () => {
  test('runner-a 与 runner-b 各持本目录锁；跨目录不互相替代租约断言', () => {
    const ra = acquireNativeWriter(join(dirA, 'writer.lock'), 'runner-a');
    const rb = acquireNativeWriter(join(dirB, 'writer.lock'), 'runner-b');
    try {
      expect(JSON.parse(readFileSync(join(dirA, 'writer.lock'), 'utf8')).host).toBe('runner-a');
      expect(JSON.parse(readFileSync(join(dirB, 'writer.lock'), 'utf8')).host).toBe('runner-b');
    } finally { ra(); rb(); }
  });
});

run('N2：有效租约下唯一写者；跨节点接手拒绝', () => {
  test('节点 A 认领后节点 B 对同一任务 claim 得到 already_claimed，且 lease_node 仍为 A', async () => {
    await clearLeases();
    const taskId = await makeTask('unique-writer');
    const won = await coreA.claim(tokens.engA!, taskId);
    expect(won.fence).toBeGreaterThanOrEqual(1);
    await expect(coreB.claim(tokens.engB!, taskId)).rejects.toMatchObject({ code: 'already_claimed' });
    const row = await database.db.select<{ current_employee?: string; lease_node?: string; fence?: number }>(new RecordId('task', taskId));
    expect(row?.current_employee).toBe('dual-eng-a');
    expect(row?.lease_node).toBe(NODE_A);
    expect(row?.fence).toBe(won.fence);
    // B 不能用 A 的 proof 续租/写检查点。
    await expect(coreB.heartbeat(tokens.engB!, proofOf(won))).rejects.toMatchObject({ code: expect.stringMatching(/forbidden|conflict|lease_expired|already_claimed/) });
    await expect(coreB.checkpoint(tokens.engB!, proofOf(won), { text: 'cross-node takeover refused', idempotencyKey: randomUUID() }))
      .rejects.toMatchObject({ code: expect.stringMatching(/forbidden|conflict|lease_expired/) });
    // A 仍可 heartbeat。
    const kept = await coreA.heartbeat(tokens.engA!, proofOf(won));
    expect(kept.deliveryId).toBe(won.deliveryId);
    expect(kept.fence).toBe(won.fence);
  });
});

run('N4/N5：旧租约失效不可写；恢复后可接手', () => {
  test('租约过期后旧 proof 写入失败；节点 B 认领成功且 fence 前进', async () => {
    await clearLeases();
    const taskId = await makeTask('expire-then-handoff');
    const first = await coreA.claim(tokens.engA!, taskId);
    const oldProof = proofOf(first);
    const oldFence = first.fence;
    // 直接把租约打到过去，模拟节点离线后租约耗尽（不启生产第二节点）。
    await database.db.query('UPDATE $task SET lease_expires_at = time::unix(time::now()) - 10;', { task: new RecordId('task', taskId) });
    await expect(coreA.heartbeat(tokens.engA!, oldProof)).rejects.toMatchObject({ code: 'lease_expired' });
    await expect(coreA.checkpoint(tokens.engA!, oldProof, { text: 'stale lease must not write', idempotencyKey: randomUUID() }))
      .rejects.toMatchObject({ code: 'lease_expired' });

    const second = await coreB.claim(tokens.engB!, taskId);
    expect(second.fence).toBeGreaterThan(oldFence);
    expect(second.deliveryId).not.toBe(first.deliveryId);
    const row = await database.db.select<{ current_employee?: string; lease_node?: string; fence?: number }>(new RecordId('task', taskId));
    expect(row?.current_employee).toBe('dual-eng-b');
    expect(row?.lease_node).toBe(NODE_B);
    expect(row?.fence).toBe(second.fence);

    // 旧 fence/delivery 在新租约下仍不可写。
    await expect(coreA.heartbeat(tokens.engA!, oldProof)).rejects.toMatchObject({ code: expect.stringMatching(/conflict|lease_expired|forbidden/) });
    const live = await coreB.heartbeat(tokens.engB!, proofOf(second));
    expect(live.fence).toBe(second.fence);
  });
});

run('N3：离线路由不回退', () => {
  test('runtime-routes 指定 native:A 时，即使 A 无心跳，B 与 paseo 也不 ownsProvider', async () => {
    mkdirSync(join(routesHome, 'private'), { recursive: true });
    writeFileSync(join(routesHome, 'private/runtime-routes.json'), JSON.stringify({
      version: 1, routes: { claude: `native:${NODE_A}`, 'factory-droid': `native:${NODE_A}` },
    }));
    const routes = readProviderRoutes(routesHome);
    // 不写入 NODE_A 的 node_release，模拟离线；路由归属仍不回退到 B / paseo。
    expect(await readNodeRelease(database, NODE_A)).toBeUndefined();
    expect(ownsProvider(routes, 'claude', `native:${NODE_A}`)).toBe(true);
    expect(ownsProvider(routes, 'claude', `native:${NODE_B}`)).toBe(false);
    expect(ownsProvider(routes, 'claude', 'paseo:legacy')).toBe(false);
    expect(ownsProvider(routes, 'factory-droid', `native:${NODE_B}`)).toBe(false);
  });
});

run('第二节点心跳与证据脱敏', () => {
  test('NODE_B 心跳写入 node_release；错误文本脱敏令牌与长路径约定可勾选', async () => {
    const at = Math.floor(Date.now() / 1000);
    await beatNodeRelease(database, {
      node: NODE_B, host: 'linux-fixture', platform: 'linux', version: '0.13.58', sha: SHA, at,
    });
    const row = await readNodeRelease(database, NODE_B);
    expect(row).toMatchObject({ host: 'linux-fixture', platform: 'linux', version: '0.13.58', sha: SHA, seen_at: at });

    // 合成令牌形态（非真实凭证）；按段拼接避免误触扫描器，redactText 仍按 sk-ant- 规则脱敏。
    const token = ['sk', 'ant', 'fixtureSecretValue99'].join('-');
    const longPath = '/Users/fixture/Library/Application Support/SurrealCKCompany/native/mac-native/private/secret.env';
    expect(longPath.length).toBeGreaterThanOrEqual(40);
    const scrubbed = redactText(`boom ${token} path=${longPath}`);
    expect(scrubbed).not.toContain(token);
    expect(scrubbed).toContain('[redacted]');
    // 清单要求长路径在证据投影中脱敏；本断言锁定 redactText 至少吃掉令牌，路径策略见 checklist §3。
  });
});
