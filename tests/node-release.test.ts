/**
 * Node records, upgrade results, rollback records and the lease count that gates a node upgrade, on the company fork.
 *
 * Runs through the fork runner, which provides an isolated company database and sets RUN_SCK_NODE_RELEASE_TESTS=1:
 *   bun scripts/test-worktrees.ts tests/node-release.test.ts
 * Without that flag every case is skipped.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { RecordId } from 'surrealdb';
import { loadDatabaseConfig } from '../src/config.ts';
import { CompanyDatabase } from '../src/database.ts';
import { SurrealCompanyCore } from '../src/core.ts';
import { LocalEnrollmentAdmin } from '../src/enrollment.ts';
import type { ClaimResult, CreateTask } from '../src/contracts.ts';
import {
  activeLeaseCount, beatNodeRelease, ensureNodeRelease, readNodeRelease, recordNodeRollback, recordNodeUpgrade, touchNodeCheck,
} from '../src/node-release.ts';

const enabled = process.env.RUN_SCK_NODE_RELEASE_TESTS === '1';
const run = enabled ? describe : describe.skip;
const NS = 'sck_agent_company_test_node_release';
setDefaultTimeout(180_000);
const tokens: Record<string, string> = {};
const NODE_A = randomUUID();
const NODE_B = randomUUID();
const SHA = 'a'.repeat(40);
const now = () => Math.floor(Date.now() / 1000);

let database: CompanyDatabase;
let coreA: SurrealCompanyCore;
let coreUnowned: SurrealCompanyCore;

beforeAll(async () => {
  if (!enabled) return;
  database = new CompanyDatabase({ ...loadDatabaseConfig(), namespace: NS, database: 'control_plane' });
  coreA = new SurrealCompanyCore(database, { nodeId: NODE_A });
  coreUnowned = new SurrealCompanyCore(database);
  await database.connect();
  await database.db.query(`DEFINE NAMESPACE IF NOT EXISTS ${NS};`);
  await database.db.use({ namespace: NS });
  await database.db.query('REMOVE DATABASE IF EXISTS control_plane;');
  await database.bootstrap();
  const enrollment = new LocalEnrollmentAdmin(database);
  tokens.owner = await enrollment.enroll('t-owner', 'owner', ['execute', 'review', 'manage']);
  tokens.eng = await enrollment.enroll('t-eng', 'engineering', ['execute', 'review']);
  tokens.eng2 = await enrollment.enroll('t-eng2', 'engineering', ['execute', 'review']);
  // Nothing from an earlier run may hold a lease in this fixture.
  await clearLeases();
});

afterAll(async () => {
  if (enabled) await database.close();
});

async function clearLeases(): Promise<void> {
  await database.db.query(`UPDATE task SET current_employee = NONE, delivery_id = NONE, lease_expires_at = NONE, lease_node = NONE
    WHERE current_employee != NONE; UPDATE employee SET active_task = NONE WHERE active_task != NONE;`);
}

async function makeTask(title: string): Promise<string> {
  const view = await coreA.createTask(tokens.owner!, {
    title, context: 'node release fixture', executorRole: 'engineering', reviewerRole: 'qa',
    workIntent: { kind: 'read' }, idempotencyKey: `node-release-${title}-${randomUUID()}`,
  } as CreateTask);
  return view.id;
}

async function claim(core: SurrealCompanyCore, taskId: string, employee: string): Promise<ClaimResult> {
  return core.claim(tokens[employee]!, taskId) as Promise<ClaimResult>;
}

run('node record', () => {
  test('a heartbeat is readable back with its version and seen time', async () => {
    const at = now();
    await beatNodeRelease(database, { node: NODE_A, host: 'mac-a', platform: 'darwin', version: '0.5.0', sha: SHA, at });
    const row = await readNodeRelease(database, NODE_A);
    expect(row).toMatchObject({ host: 'mac-a', platform: 'darwin', version: '0.5.0', sha: SHA, seen_at: at, updated_at: at });
  });

  test('a second heartbeat replaces the version and keeps the node a single row', async () => {
    await beatNodeRelease(database, { node: NODE_A, host: 'mac-a', platform: 'darwin', version: '0.6.0', sha: 'b'.repeat(40), at: now() });
    const row = await readNodeRelease(database, NODE_A);
    expect(row?.version).toBe('0.6.0');
    expect(row?.sha).toBe('b'.repeat(40));
  });

  test('an unknown node reads as undefined', async () => {
    expect(await readNodeRelease(database, randomUUID())).toBeUndefined();
  });

  test('ensuring a node row creates it without a heartbeat: seen time and last status stay empty', async () => {
    const node = randomUUID();
    await ensureNodeRelease(database, { node, host: 'mac-c', platform: 'darwin', at: now() });
    const row = await readNodeRelease(database, node);
    expect(row).toMatchObject({ host: 'mac-c', platform: 'darwin' });
    expect(row?.seen_at ?? null).toBeNull();
    expect(row?.last_status ?? null).toBeNull();
  });

  test('an upgrade result is recorded with its status, target and time, and the error is redacted and clipped', async () => {
    const at = now();
    const token = 'eyJhbGciOiJIUzUxMiJ9.eyJzdWIiOiJ4In0.signaturepart';
    await recordNodeUpgrade(database, { node: NODE_A, status: 'failed', target: '0.6.0', at, error: `boom ${token} ${'x'.repeat(1000)}` });
    const row = await readNodeRelease(database, NODE_A);
    expect(row).toMatchObject({ last_status: 'failed', last_target: '0.6.0', last_at: at, checked_at: at, updated_at: at });
    expect(row?.last_error).not.toContain('eyJhbGciOiJIUzUxMiJ9');
    expect(row?.last_error).toContain('[redacted]');
    expect(row!.last_error!.length).toBeLessThanOrEqual(500);
  });

  test('a check that is not an upgrade only moves checked_at and keeps the last status', async () => {
    const before = await readNodeRelease(database, NODE_A);
    const at = now() + 60;
    await touchNodeCheck(database, NODE_A, at);
    const row = await readNodeRelease(database, NODE_A);
    expect(row?.checked_at).toBe(at);
    expect(row?.updated_at).toBe(at);
    expect(row?.last_status).toBe(before?.last_status);
    expect(row?.last_target).toBe(before?.last_target);
  });

  test('a rollback is appended with its from and to versions, and the reason is redacted', async () => {
    const at = now();
    await recordNodeRollback(database, {
      node: NODE_A, at, fromVersion: '0.6.0', fromSha: 'b'.repeat(40), toVersion: '0.5.0', toSha: SHA,
      reason: 'health check failed eyJhbGciOiJIUzUxMiJ9.eyJzdWIiOiJ4In0.signaturepart', outcome: 'rolled_back',
    });
    await recordNodeRollback(database, {
      node: NODE_A, at: at + 1, fromVersion: '0.6.0', fromSha: 'b'.repeat(40), toVersion: '0.5.0', toSha: SHA,
      reason: 'second', outcome: 'rollback_failed',
    });
    const [rows] = await database.db.query<[Array<{ from_version: string; to_version: string; reason: string; outcome: string }>]>(
      'SELECT from_version, to_version, reason, outcome, at FROM node_rollback WHERE node = $node ORDER BY at;', { node: NODE_A });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ from_version: '0.6.0', to_version: '0.5.0', outcome: 'rolled_back' });
    expect(rows[0]!.reason).not.toContain('eyJhbGciOiJIUzUxMiJ9');
    expect(rows[1]).toMatchObject({ outcome: 'rollback_failed', reason: 'second' });
  });
});

run('lease node and active lease count', () => {
  test('a claim writes the node of the claiming core into task.lease_node; a core without a node writes none', async () => {
    await clearLeases();
    const owned = await makeTask('lease-node-owned');
    await claim(coreA, owned, 'eng');
    const ownedRow = await database.db.select<{ lease_node?: string }>(new RecordId('task', owned));
    expect(ownedRow?.lease_node).toBe(NODE_A);
    await clearLeases();

    const unowned = await makeTask('lease-node-unowned');
    await claim(coreUnowned, unowned, 'eng2');
    const unownedRow = await database.db.select<{ lease_node?: string | null }>(new RecordId('task', unowned));
    expect(unownedRow?.lease_node ?? null).toBeNull();
    await clearLeases();
  });

  test('own, unowned and other-node leases are counted by the rule; released and expired ones are not', async () => {
    await clearLeases();
    const own = await makeTask('count-own');
    const other = await makeTask('count-other');
    const unowned = await makeTask('count-unowned');
    const released = await makeTask('count-released');
    const expired = await makeTask('count-expired');
    const future = now() + 600;
    const past = now() - 600;
    // Writes a lease directly. The node is set to NONE when null, the same as an old lease claimed before lease_node existed.
    const lease = (task: string, employee: string, expires: number, node: string | null) =>
      database.db.query(
        `UPDATE $task SET current_employee = $employee, lease_expires_at = $expires, lease_node = ${node === null ? 'NONE' : '$node'};`,
        { task: new RecordId('task', task), employee, expires, ...(node === null ? {} : { node }) });
    await lease(own, 'x-own', future, NODE_A);
    await lease(other, 'x-other', future, NODE_B);
    await lease(unowned, 'x-unowned', future, null);
    await lease(released, 'x-released', future, NODE_A);
    await database.db.query('UPDATE $task SET current_employee = NONE, lease_expires_at = NONE;', { task: new RecordId('task', released) });
    await lease(expired, 'x-expired', past, NODE_A);

    // NODE_A counts its own lease and the unowned one. It does not count NODE_B's lease, the released task or the expired one.
    expect(await activeLeaseCount(database, NODE_A)).toBe(2);
    // NODE_B counts its own lease and the unowned one, not NODE_A's lease.
    expect(await activeLeaseCount(database, NODE_B)).toBe(2);
    // A node with no lease of its own still sees the unowned lease (fail closed).
    expect(await activeLeaseCount(database, randomUUID())).toBe(1);
    await clearLeases();
  });
});
