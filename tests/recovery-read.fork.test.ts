// FV06 recovery read grant fork regression: the real company core on an isolated company fork.
//   RUN_COMPANY_PROOF_FORK_TESTS=1 bun test tests/recovery-read.fork.test.ts
// Everything is synthetic: no production credential, product call, secret or model is touched.
import { afterAll, beforeAll, beforeEach, setDefaultTimeout, test } from 'bun:test';
import { expect } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { RecordId } from 'surrealdb';
import { CompanyDatabase } from '../src/database.ts';
import { SurrealCompanyCore } from '../src/core.ts';
import { LocalEnrollmentAdmin } from '../src/enrollment.ts';
import { ProjectStore } from '../src/projects.ts';
import { RECOVERY_READ_ALIAS, RECOVERY_READ_PATHS, RECOVERY_READ_REFUSALS, nextRecoveryPath } from '../src/recovery-read.ts';
import { recoveryWake } from '../src/dispatcher/prompts.ts';
import { LEGACY_SCHEMA_MINIMUM, RECOVERY_READ_TABLES } from '../src/company-release.ts';
import { readReleaseSchema, verifyReleaseSchema } from '../src/release-schema.ts';
import { Dispatcher, type SidecarBridge } from '../src/dispatcher/dispatcher.ts';
import type { PaseoGateway } from '../src/dispatcher/paseo.ts';
import { DEFAULT_CONFIG, Workforce, type EmployeeInst } from '../src/workforce.ts';
import type { OwnerDesk } from '../src/owner.ts';
import { OpsBroker } from '../src/ops/broker.ts';
import { SidecarPool } from '../plugin/server/sidecar.ts';
import { brokerConfig, FakeCompany, FakeWorld, OPS_CLIENT, OPS_REDIRECT, OPS_RESOURCE } from './support/ops-world.ts';
import type { ClaimResult, CreateTask, Evidence, OpsScope } from '../src/contracts.ts';

const enabled = process.env.RUN_COMPANY_PROOF_FORK_TESTS === '1';
const check = test.skipIf(!enabled);
let markerPrinted = false;
setDefaultTimeout(300_000);

let dir: string, url: string, child: ReturnType<typeof Bun.spawn>, database: CompanyDatabase;
let core: SurrealCompanyCore, projects: ProjectStore;
let gm: string, gm2: string, eng1: string, eng2: string, eng3: string, cs: string;
const GOAL = 'recovery-goal';
const OTHER_GOAL = 'recovery-other-goal';

async function start() {
  const binary = join(homedir(), '.surrealdb/surreal');
  child = Bun.spawn([binary, 'start', '--no-banner', '--log', 'none', '--bind', url.replace('ws://', ''), '--user', 'root', '--pass', 'root', 'rocksdb:' + join(dir, 'db')],
    { stdout: 'ignore', stderr: 'ignore' });
  for (let i = 0; i < 100; i++) {
    const p = Bun.spawn([binary, 'is-ready', '--endpoint', url], { stdout: 'ignore', stderr: 'ignore' });
    if (await p.exited === 0) return;
    await Bun.sleep(50);
  }
  throw new Error('company fork unavailable');
}

beforeAll(async () => {
  if (!enabled) return;
  dir = await realpath(await mkdtemp(join(tmpdir(), 'sck-recovery-fork-')));
  const port = await new Promise<number>(resolve => {
    const s = createServer(); s.listen(0, '127.0.0.1', () => { const a = s.address() as { port: number }; s.close(() => resolve(a.port)); });
  });
  url = 'ws://127.0.0.1:' + port;
  await start();
  database = new CompanyDatabase({ url: url + '/rpc', rootUser: 'root', rootPassword: 'root', namespace: 'recovery_read_test', database: 'control_plane' });
  await database.connect();
  await database.bootstrap();
  // The release gate reads this marker: a skipped file (missing opt-in flag) must not look like a pass.
  console.log('recovery-read.fork executed');
  markerPrinted = true;
  core = new SurrealCompanyCore(database);
  projects = new ProjectStore(database.db);
  const enroll = new LocalEnrollmentAdmin(database);
  gm = await enroll.enroll('recovery-gm', 'gm', ['execute', 'review', 'manage']);
  gm2 = await enroll.enroll('recovery-gm2', 'gm', ['execute', 'review', 'manage']);
  eng1 = await enroll.enroll('recovery-eng1', 'engineering', ['execute', 'review']);
  eng2 = await enroll.enroll('recovery-eng2', 'engineering', ['execute', 'review']);
  eng3 = await enroll.enroll('recovery-eng3', 'engineering', ['execute', 'review']);
  cs = await enroll.enroll('recovery-cs', 'cs', ['execute', 'review']);
  await projects.upsert({
    id: 'surreal_ck', name: 'synthetic', repoPath: dir, release: 'synthetic',
    envs: [{ name: 'production', broker: brokerConfig() }],
  } as never);
  for (const goal of [GOAL, OTHER_GOAL]) {
    await database.db.query('CREATE $goal CONTENT {state:"active",project:$project,anchors:[],tasks:{}};',
      { goal: new RecordId('goal', goal), project: new RecordId('project', 'surreal_ck') });
  }
}, 30_000);

afterAll(async () => {
  if (!enabled) return;
  await database.close();
  child.kill();
  await child.exited;
  await rm(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  if (!enabled) return;
  // Each check starts from no live lease and no grant; done tasks and their fault episodes stay.
  await database.db.query(`UPDATE task SET state = 'done', current_employee = NONE, delivery_id = NONE,
      lease_expires_at = NONE WHERE state != 'done';
    UPDATE employee SET active_task = NONE WHERE active_task != NONE;
    DELETE recovery_read_call;
    DELETE recovery_read_grant;`);
});

const key = () => randomUUID();
const evidence = (tag: string): Evidence => ({ text: `恢复取证授权 fork 夹具 ${tag}；不产生真实产品调用。`, idempotencyKey: key() });
const proofOf = (c: ClaimResult) => ({ taskId: c.task.id, deliveryId: c.deliveryId, fence: c.fence, expectedVersion: c.task.version });

async function makeTask(goalId: string, title: string): Promise<string> {
  const task = await core.createTask(gm, {
    title: `${title} ${key().slice(0, 8)}`, context: '恢复取证授权回归夹具；没有真实交付。',
    executorRole: 'engineering', reviewerRole: 'engineering', workIntent: { kind: 'read' }, goalId,
    idempotencyKey: key(),
  } as CreateTask);
  return task.id;
}

async function doneTask(goalId: string, title: string): Promise<string> {
  const taskId = await makeTask(goalId, title);
  const held = await core.claim(eng1, taskId) as ClaimResult;
  await core.submit(eng1, proofOf(held), evidence(`submit-${taskId}`));
  const review = await core.claim(eng2, taskId) as ClaimResult;
  await core.accept(eng2, proofOf(review), evidence(`accept-${taskId}`));
  return taskId;
}

/** A synthetic login failure opens the episode the grant requires; it writes no budget attempt of its own. */
async function openEpisode(taskId: string): Promise<void> {
  await core.reportFault({ taskId, employeeId: 'recovery-eng1' }, {
    tool: 'ops_operator_login', phase: 'login', status: 401, alias: RECOVERY_READ_ALIAS, target: 'product_token',
    stage: 'authorize', message: 'synthetic fixture failure (status only)',
  });
}

const grantInput = (sourceTaskId: string, authorizationTask: string, patch: Record<string, unknown> = {}) => ({
  taskId: sourceTaskId, employeeId: 'recovery-eng1', alias: RECOVERY_READ_ALIAS, paths: [...RECOVERY_READ_PATHS],
  expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(), authorizationTask, reason: '取出终态任务的四项证据',
  idempotencyKey: key(), ...patch,
});

async function refusal(promise: Promise<unknown>): Promise<Error & { code?: string }> {
  const error = await promise.then(() => undefined, (reason: unknown) => reason);
  expect(error).toBeInstanceOf(Error);
  return error as Error & { code?: string };
}

check('restart bootstrap runs schema 049 and the source task stays done without a new budget', async () => {
  const [installation] = await database.db.query<[{ schema_version?: number } | undefined]>(
    'SELECT schema_version FROM ONLY company_meta:installation;');
  expect(installation?.schema_version).toBe(50);
  const source = await doneTask(GOAL, '终态源任务');
  await openEpisode(source);
  const before = await core.faultStatus(gm, { taskId: source });
  const auth = await doneTask(GOAL, '经理批准任务');
  const status = await core.recoveryReadGrant(gm, grantInput(source, auth));
  expect(status.grant).toMatchObject({ taskId: source, employeeId: 'recovery-eng1', alias: RECOVERY_READ_ALIAS,
    state: 'issued', loginAttempts: 0, perPath: [0, 0, 0, 0] });
  const after = await core.faultStatus(gm, { taskId: source });
  expect(after.budgets.map(b => b.key)).toEqual(before.budgets.map(b => b.key));
  const task = await core.getTask(gm, source);
  expect(task.state).toBe('done');
  expect(task.currentEmployee).toBeUndefined();
});

check('grant issuance is gm + manage, never self-issued, done-only and episode-backed', async () => {
  const source = await doneTask(GOAL, '校验源任务');
  await openEpisode(source);
  const auth = await doneTask(GOAL, '校验批准任务');
  // Non-gm manage holder.
  await expect(refusal(core.recoveryReadGrant(eng1, grantInput(source, auth)))).resolves.toMatchObject({ code: 'forbidden' });
  // Self-issued.
  expect((await refusal(core.recoveryReadGrant(gm, grantInput(source, auth, { employeeId: 'recovery-gm' })))).code).toBe('forbidden');
  // Source not done.
  const live = await makeTask(GOAL, '未完成任务');
  expect((await refusal(core.recoveryReadGrant(gm, grantInput(live, auth)))).code).toBe('invalid');
  // No episode.
  const noFault = await doneTask(GOAL, '无故障任务');
  expect((await refusal(core.recoveryReadGrant(gm, grantInput(noFault, auth)))).code).toBe('invalid');
  // Authorization task not done.
  const openAuth = await makeTask(GOAL, '未完成批准');
  expect((await refusal(core.recoveryReadGrant(gm, grantInput(source, openAuth)))).code).toBe('invalid');
  // Different goal.
  const otherAuth = await doneTask(OTHER_GOAL, '别的目标批准');
  expect((await refusal(core.recoveryReadGrant(gm, grantInput(source, otherAuth)))).code).toBe('invalid');
  // Paths/alias/TTL.
  expect((await refusal(core.recoveryReadGrant(gm, grantInput(source, auth, { paths: RECOVERY_READ_PATHS.slice(0, 3) })))).code).toBe('invalid');
  expect((await refusal(core.recoveryReadGrant(gm, grantInput(source, auth, { alias: 'OTHER_OPS' })))).code).toBe('invalid');
  expect((await refusal(core.recoveryReadGrant(gm, grantInput(source, auth, { expiresAt: new Date(Date.now() + 40 * 60_000).toISOString() })))).code).toBe('invalid');
  // Grantee role outside the broker roles.
  expect((await refusal(core.recoveryReadGrant(gm, grantInput(source, auth, { employeeId: 'recovery-cs' })))).code).toBe('invalid');
  // Nothing above minted a grant for this source.
  expect(await core.recoveryReadStatus(gm, { taskId: source })).toHaveLength(0);
});

check('the chain counts are atomic, ordered and monotonic; rearm carries them over', async () => {
  const source = await doneTask(GOAL, '链级源任务');
  await openEpisode(source);
  const auth = await doneTask(GOAL, '链级批准');
  const issued = (await core.recoveryReadGrant(gm, grantInput(source, auth))).grant;
  const grantId = issued.id;
  expect(await core.recoveryReadReserve(eng1, { grantId, grantFence: 1, kind: 'login' }))
    .toMatchObject({ allowed: false, reason: 'grant_not_bound', message: expect.stringContaining('not bound') });
  const bound = await core.recoveryReadBind(eng1, { grantId, fence: 1 });
  expect(bound.state).toBe('bound');
  // Logout is always allowed and never counted.
  expect(await core.recoveryReadReserve(eng1, { grantId, grantFence: 1, kind: 'logout' })).toMatchObject({ allowed: true, kind: 'logout' });
  // A GET before a successful login is refused.
  expect(await core.recoveryReadReserve(eng1, { grantId, grantFence: 1, kind: 'get', path: RECOVERY_READ_PATHS[0] }))
    .toMatchObject({ allowed: false, reason: 'read_unavailable' });
  const login = await core.recoveryReadReserve(eng1, { grantId, grantFence: 1, kind: 'login' });
  expect(login).toMatchObject({ allowed: true, kind: 'login' });
  // Second login is refused while the first is in flight and after it settles.
  expect(await core.recoveryReadReserve(eng1, { grantId, grantFence: 1, kind: 'login' })).toMatchObject({ allowed: false, reason: 'busy' });
  await core.recoveryReadSettle(eng1, { grantId, grantFence: 1, callId: login.callId!, kind: 'login', ok: true, outcome: 'login_ok' });
  expect((await core.recoveryReadStatus(eng1, { grantId }))[0]!.grant).toMatchObject({ state: 'running', loginAttempts: 1 });
  expect(await core.recoveryReadReserve(eng1, { grantId, grantFence: 1, kind: 'login' }))
    .toMatchObject({ allowed: false, reason: 'login_unavailable' });
  // Skip order is refused.
  expect(await core.recoveryReadReserve(eng1, { grantId, grantFence: 1, kind: 'get', path: RECOVERY_READ_PATHS[1] }))
    .toMatchObject({ allowed: false, reason: 'path_order' });
  // Two concurrent reservations of path 1: exactly one runs; no counter moves twice.
  const [a, b] = await Promise.all([
    core.recoveryReadReserve(eng1, { grantId, grantFence: 1, kind: 'get', path: RECOVERY_READ_PATHS[0] }),
    core.recoveryReadReserve(eng1, { grantId, grantFence: 1, kind: 'get', path: RECOVERY_READ_PATHS[0] }),
  ]);
  expect([a.allowed, b.allowed].filter(Boolean)).toHaveLength(1);
  const winner = a.allowed ? a : b;
  const loser = a.allowed ? b : a;
  expect(loser.allowed).toBe(false);
  let view = (await core.recoveryReadStatus(eng1, { grantId }))[0]!.grant;
  expect(view.perPath).toEqual([1, 0, 0, 0]);
  // A first-item unexpected result stops the chain; the remaining paths are refused.
  await core.recoveryReadSettle(eng1, { grantId, grantFence: 1, callId: winner.callId!, kind: 'get', path: RECOVERY_READ_PATHS[0],
    status: 200, ok: false, outcome: 'unexpected_200', bodyDigest: 'a'.repeat(64) });
  view = (await core.recoveryReadStatus(eng1, { grantId }))[0]!.grant;
  expect(view.state).toBe('stopped');
  expect(view.stopReason).toBe('unexpected_200');
  expect(await core.recoveryReadReserve(eng1, { grantId, grantFence: 1, kind: 'get', path: RECOVERY_READ_PATHS[1] }))
    .toMatchObject({ allowed: false, reason: 'stopped' });
  // Logout stays possible after the stop.
  expect(await core.recoveryReadReserve(eng1, { grantId, grantFence: 1, kind: 'logout' })).toMatchObject({ allowed: true });
  // A new grant without rearm is refused; rearm needs another authorization task and preserves counts.
  expect((await refusal(core.recoveryReadGrant(gm, grantInput(source, auth)))).code).toBe('conflict');
  expect((await refusal(core.recoveryReadGrant(gm, grantInput(source, auth, { rearm: true })))).code).toBe('invalid');
  const auth2 = await doneTask(GOAL, '链级二次批准');
  const rearmed = (await core.recoveryReadGrant(gm, grantInput(source, auth2, { rearm: true }))).grant;
  expect(rearmed.loginAttempts).toBe(1);
  expect(rearmed.perPath).toEqual([1, 0, 0, 0]);
  expect(rearmed.state).toBe('issued');
});

check('status visibility is gm, grantee and source reviewer only; calls carry no body', async () => {
  const source = await doneTask(GOAL, '可见性源任务');
  await openEpisode(source);
  const auth = await doneTask(GOAL, '可见性批准');
  const { grant } = await core.recoveryReadGrant(gm, grantInput(source, auth));
  await core.recoveryReadBind(eng1, { grantId: grant.id, fence: 1 });
  const login = await core.recoveryReadReserve(eng1, { grantId: grant.id, grantFence: 1, kind: 'login' });
  await core.recoveryReadSettle(eng1, { grantId: grant.id, grantFence: 1, callId: login.callId!, kind: 'login', ok: true, outcome: 'login_ok' });
  const get = await core.recoveryReadReserve(eng1, { grantId: grant.id, grantFence: 1, kind: 'get', path: RECOVERY_READ_PATHS[0] });
  await core.recoveryReadSettle(eng1, { grantId: grant.id, grantFence: 1, callId: get.callId!, kind: 'get', path: RECOVERY_READ_PATHS[0],
    status: 503, ok: true, outcome: 'not_configured_503', bodyDigest: 'b'.repeat(64) });
  const mine = await core.recoveryReadStatus(eng1, { taskId: source });
  expect(mine).toHaveLength(1);
  expect(mine[0]!.calls.map(c => `${c.ordinal}:${c.kind}:${c.outcome}`)).toEqual(['1:login:login_ok', '2:get:not_configured_503']);
  expect(mine[0]!.calls[1]).not.toHaveProperty('body');
  expect(JSON.stringify(mine)).not.toMatch(/token|subject|https?:|s_[0-9a-f]{16}/i);
  // The source reviewer (role engineering) sees it; a role with no review right on the source does not.
  expect(await core.recoveryReadStatus(eng2, { taskId: source })).toHaveLength(1);
  expect(await core.recoveryReadStatus(cs, { taskId: source })).toHaveLength(0);
});

check('opsScope recovery branch: proof-bound, lease-exclusive, and never a task write', async () => {
  const source = await doneTask(GOAL, 'scope 源任务');
  await openEpisode(source);
  const auth = await doneTask(GOAL, 'scope 批准');
  const { grant } = await core.recoveryReadGrant(gm, grantInput(source, auth));
  await core.recoveryReadBind(eng1, { grantId: grant.id, fence: 1 });
  const scope = await core.opsScope(eng1, source, { grantId: grant.id, grantFence: 1 });
  expect(scope).toMatchObject({ kind: 'recovery_read', taskId: source, recovery: { grantId: grant.id, alias: RECOVERY_READ_ALIAS } });
  expect((await refusal(core.opsScope(eng1, source))).code).toBe('forbidden'); // no proof, no lease
  expect((await refusal(core.opsScope(eng1, source, { grantId: grant.id, grantFence: 2 }))).code).toBe('forbidden');
  expect((await refusal(core.opsScope(eng2, source, { grantId: grant.id, grantFence: 1 }))).code).toBe('forbidden');
  // A live execution lease blocks the recovery branch for the same employee.
  const other = await makeTask(GOAL, 'scope 执行任务');
  await core.claim(eng1, other);
  expect((await refusal(core.opsScope(eng1, source, { grantId: grant.id, grantFence: 1 }))).code).toBe('forbidden');
  expect((await refusal(core.recoveryReadBind(eng1, { grantId: grant.id, fence: 1 }))).code).toBe('conflict');
  // The grant wrote no task fields: it is still done and has no holder.
  const task = await core.getTask(gm, source);
  expect(task.state).toBe('done');
  expect(task.currentEmployee).toBeUndefined();
});

check('revoke closes the chain, audit is readable and local logout stays allowed', async () => {
  const source = await doneTask(GOAL, '撤销源任务');
  await openEpisode(source);
  const auth = await doneTask(GOAL, '撤销批准');
  const { grant } = await core.recoveryReadGrant(gm, grantInput(source, auth));
  await core.recoveryReadGrantRevoke(gm, { grantId: grant.id, reason: '夹具撤销', idempotencyKey: key() });
  const revoked = (await core.recoveryReadStatus(gm, { grantId: grant.id }))[0]!.grant;
  expect(revoked.state).toBe('revoked');
  expect(await core.recoveryReadReserve(eng1, { grantId: grant.id, grantFence: 1, kind: 'login' }))
    .toMatchObject({ allowed: false, reason: 'revoked' });
  expect(await core.recoveryReadReserve(eng1, { grantId: grant.id, grantFence: 1, kind: 'logout' })).toMatchObject({ allowed: true });
  const [rows] = await database.db.query<[Array<{ action: string; evidence: string }>]>(
    "SELECT action, evidence FROM audit WHERE task = $task AND action IN ['recovery_read_grant', 'recovery_read_revoke'];",
    { task: new RecordId('task', source) });
  expect(rows.map(r => r.action).sort()).toEqual(['recovery_read_grant', 'recovery_read_revoke']);
  expect(JSON.stringify(rows)).not.toContain('{{SECRET_');
});

check('an expired grant is closed and a source change is projected as stopped', async () => {
  const source = await doneTask(GOAL, '过期源任务');
  await openEpisode(source);
  const auth = await doneTask(GOAL, '过期批准');
  const { grant } = await core.recoveryReadGrant(gm, grantInput(source, auth, { expiresAt: new Date(Date.now() + 61_000).toISOString() }));
  await database.db.query('UPDATE $grant SET expires_at = time::now() - 1s;', { grant: new RecordId('recovery_read_grant', grant.id) });
  const projected = await core.recoveryGrantFor(eng1, grant.id);
  expect(projected.state).toBe('expired');
  const closed = await core.recoveryReadClose(eng1, { grantId: grant.id, fence: 1, reason: 'expired' });
  void closed;
  expect((await core.recoveryReadStatus(gm, { grantId: grant.id }))[0]!.grant.state).toBe('expired');
});

check('an unsettled inFlight past its deadline becomes stopped(unknown_outcome), never busy forever', async () => {
  const source = await doneTask(GOAL, '超时源任务');
  await openEpisode(source);
  const auth = await doneTask(GOAL, '超时批准');
  const { grant } = await core.recoveryReadGrant(gm, grantInput(source, auth));
  await core.recoveryReadBind(eng1, { grantId: grant.id, fence: 1 });
  const login = await core.recoveryReadReserve(eng1, { grantId: grant.id, grantFence: 1, kind: 'login' });
  expect(login).toMatchObject({ allowed: true, kind: 'login' });
  // Before the deadline the grant is busy, not stopped.
  expect(await core.recoveryReadReserve(eng1, { grantId: grant.id, grantFence: 1, kind: 'login' }))
    .toMatchObject({ allowed: false, reason: 'busy' });
  // Simulate a crash/plugin reload that lost the settle: the deadline is already in the past.
  const held = await database.db.select<{ in_flight?: { path: string; call_id: string } }>(
    new RecordId('recovery_read_grant', grant.id));
  await database.db.query(`UPDATE $grant SET in_flight = {
      path: $path, started_at: time::now() - 120s, deadline: time::now() - 1s, call_id: $callId };`, {
    grant: new RecordId('recovery_read_grant', grant.id),
    path: held?.in_flight?.path ?? 'login', callId: held?.in_flight?.call_id ?? login.callId,
  });
  // The next reserve advances the chain to its terminal stop instead of answering busy forever.
  expect(await core.recoveryReadReserve(eng1, { grantId: grant.id, grantFence: 1, kind: 'login' }))
    .toMatchObject({ allowed: false, reason: 'stopped' });
  const view = (await core.recoveryReadStatus(gm, { grantId: grant.id }))[0]!.grant;
  expect(view).toMatchObject({ state: 'stopped', stopReason: 'unknown_outcome', loginAttempts: 1 });
  expect(view.inFlight).toBeUndefined();
  // A reload/rebuild sees the terminal state and never rebinds it.
  expect((await core.recoveryGrantFor(eng1, grant.id)).state).toBe('stopped');
  expect(await core.recoveryGrantsFor(eng1)).toHaveLength(0);
  // The stop is auditable.
  const [rows] = await database.db.query<[Array<{ action: string }>]>(
    "SELECT action FROM audit WHERE task = $task AND action = 'recovery_read_stop';", { task: new RecordId('task', source) });
  expect(rows).toHaveLength(1);
});

check('the migrated database proves the schema receipt a 0.3.76 release needs', async () => {
  // The real fork after bootstrap: the marker is 49 and the three tables exist.
  const receipt = await readReleaseSchema(database.db);
  expect(receipt.schemaVersion).toBe(50);
  for (const table of RECOVERY_READ_TABLES) expect(receipt.tables).toContain(table);
  const verified = await verifyReleaseSchema(database.db, '0.3.76');
  expect(verified).toMatchObject({ schema: 49, schemaVersion: 50 });
  expect(verified.tables).toEqual([...RECOVERY_READ_TABLES]);
  // An older target keeps the older minimum: 49 is not forced onto a historical version.
  const legacy = await verifyReleaseSchema(database.db, '0.3.75');
  expect(legacy).toMatchObject({ schema: LEGACY_SCHEMA_MINIMUM, tables: [] });
});

check('an isolated database without the three tables or the marker keeps the release unverified', async () => {
  // The real fork, a second database on the same isolated instance: it is migrated down on purpose, so the
  // read-back has to refuse it for real — an old marker, a missing table and an unreadable receipt, not a
  // synthetic stub. Nothing here touches the migrated database the checks above use.
  const legacy = new CompanyDatabase({ url: url + '/rpc', rootUser: 'root', rootPassword: 'root', namespace: 'recovery_read_legacy', database: 'control_plane' });
  await legacy.connect();
  try {
    await legacy.bootstrap();
    // An old marker: the release that needs 49 is refused.
    await legacy.db.query('UPDATE company_meta:installation SET schema_version = 48;');
    const old = await readReleaseSchema(legacy.db);
    expect(old.schemaVersion).toBe(48);
    await expect(verifyReleaseSchema(legacy.db, '0.3.76')).rejects.toThrow(/below the 49/);
    // The marker is current but a table is missing: still refused, and the missing table is named.
    await legacy.db.query('UPDATE company_meta:installation SET schema_version = 49; REMOVE TABLE recovery_read_chain;');
    const receipt = await readReleaseSchema(legacy.db);
    expect(receipt.schemaVersion).toBe(49);
    expect(receipt.tables).not.toContain('recovery_read_chain');
    await expect(verifyReleaseSchema(legacy.db, '0.3.76')).rejects.toThrow(/missing the tables recovery_read_chain/);
    // An unreadable receipt is a failure, not an empty receipt.
    await legacy.close();
    await expect(readReleaseSchema(legacy.db)).rejects.toThrow(/unreadable/);
    // The migrated database the checks above use is untouched by this probe.
    expect((await readReleaseSchema(database.db)).schemaVersion).toBe(50);
  } finally {
    await legacy.close().catch(() => undefined);
  }
});

check('concurrent issuance creates exactly one chain for a source task', async () => {
  const source = await doneTask(GOAL, '并发签发源任务');
  await openEpisode(source);
  const auth = await doneTask(GOAL, '并发签发批准');
  const results = await Promise.allSettled([
    core.recoveryReadGrant(gm, grantInput(source, auth)),
    core.recoveryReadGrant(gm, grantInput(source, auth)),
  ]);
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  const rejected = results.filter(r => r.status === 'rejected') as PromiseRejectedResult[];
  expect(rejected).toHaveLength(1);
  expect((rejected[0]!.reason as { code?: string }).code).toBe('conflict');
  expect(await core.recoveryReadStatus(gm, { taskId: source })).toHaveLength(1);
});

// --- dispatcher 2a observability (schema 050) -------------------------------------------------------------------
// These run the real Dispatcher over the isolated fork: grant reads/writes go to the database, while the Paseo and
// sidecar faces are fixtures, so each skip/failure path is exercised for real without touching a live session.

function wakeHarness(options: {
  instances?: EmployeeInst[];
  statuses?: Record<string, string>;
  withSidecar?: boolean;
  adoptRecovery?: (inst: EmployeeInst, grantId?: string) => Promise<unknown>;
}) {
  const instances = options.instances ?? [];
  const agents = new Map(Object.entries(options.statuses ?? {}).map(([id, status]) => [id, { id, status }]));
  const logs: string[] = [];
  const sends: Array<{ agentId: string; text: string }> = [];
  const base = new Workforce(database, join(dir, 'unused-credential-files'));
  // The pass reads much more than the 2a block; every face other than the grant store is a fixture.
  const wf = {
    config: async () => ({ ...DEFAULT_CONFIG, quotaFloorPct: 0, quotaWeeklyFloorPct: 0, sessionMaxWakes: 0, sessionMaxInputK: 0,
      evalEnabled: false, jevDecisions: false, maxRunning: 8, providerMax: { codex: 8 } }),
    defs: async () => [],
    serverNow: async () => Math.floor(Date.now() / 1000),
    insts: async () => instances,
    tasks: async () => [],
    providerHealth: async () => new Map(),
    newKey: () => `fixture-${randomUUID()}`,
    openManagerWakes: async () => [],
    acquireManagerWake: async (input: unknown, token: string) => ({ key: token, token, attempt: 1, input }),
    markManagerWakeRunning: async () => true,
    finishManagerWake: async () => true,
    lastDispatch: async () => undefined,
    recordDispatch: async () => {},
    touchWake: async () => {},
    defHealthy: async () => {},
    defFailure: async () => 1,
    pendingEvaluations: async () => [],
    projectRepos: async () => [],
    doneTaskIds: async () => [],
    markHealthy: async () => {},
    markExhausted: async () => {},
    disableDef: async () => {},
    spawnInst: async () => { throw new Error('fixture does not spawn'); },
    bind: async () => {},
    retire: async () => {},
    rotate: async (id: string) => `rotated-${id}`,
    revokeLease: async () => false,
    extendLease: async () => true,
    writeCredentialFile: () => '/dev/null',
    // Real grant store: activeRecoveryGrants / the schema-050 wake-stamp writes run against the fork database.
    activeRecoveryGrants: (nowMs: number) => base.activeRecoveryGrants(nowMs),
    noteRecoveryWake: (grantId: string) => base.noteRecoveryWake(grantId),
    noteRecoverySkip: (grantId: string, reason: string) => base.noteRecoverySkip(grantId, reason),
  } as unknown as Workforce;
  const owner = { applyPending: async () => [], resolveNotice: async () => {}, openNotices: async () => [],
    triagePending: async () => [], raiseNotice: async () => false } as unknown as OwnerDesk;
  const paseo: PaseoGateway = {
    list: async () => agents,
    status: async id => agents.get(id) ? { status: agents.get(id)!.status, pendingPermissions: 0 } : undefined,
    lastError: async () => '', logsTail: async () => '', lastInputTokens: async () => 0,
    spawn: async () => { throw new Error('fixture does not spawn'); },
    send: async (id: string, prompt: string) => { sends.push({ agentId: id, text: prompt }); agents.get(id)!.status = 'running'; },
    stop: async () => {}, reload: async () => {}, archive: async () => {},
    listWorkspaces: async () => [], listProjects: async () => [], archiveWorkspace: async () => {}, deleteProject: async () => {},
  };
  const sidecar: SidecarBridge | undefined = options.withSidecar === false ? undefined : {
    env: inst => ({ SCK_COMM_DIR: `/tmp/${inst.id}`, SCK_COMM_KEY: 'k' }),
    canReuse: () => true,
    detachAgent: () => {},
    claim: async () => undefined,
    writeScope: async () => [],
    claimDenial: () => undefined,
    bindAgent: () => {},
    commDirFor: id => `/tmp/comm/${id}`,
    scratchDirFor: id => `/tmp/${id}-scratch`,
    releaseClaim: async () => {},
    releaseWorkspace: async () => {},
    ...(options.adoptRecovery ? { adoptRecovery: options.adoptRecovery } : {}),
  } as SidecarBridge;
  const dispatcher = new Dispatcher({
    workforce: wf, owner, paseo, ...(sidecar ? { sidecar } : {}),
    env: { opsRepo: dir, sckBin: '/fixture/sck', paseoBin: '/fixture/paseo' },
    log: message => logs.push(message),
  });
  return { dispatcher, logs, sends };
}

function idleSeat(): EmployeeInst {
  return { id: 'recovery-eng1', role: 'engineering', def: 'fixture-eng', provider: 'codex', model: 'fixture',
    paseoAgentId: 'agent-eng1', credentialFile: '/dev/null' } as EmployeeInst;
}

/** A fresh issued grant for recovery-eng1 on a done source task with an open fault episode. */
async function issuedGrant(): Promise<string> {
  const source = await doneTask(GOAL, '唤醒观测源任务');
  await openEpisode(source);
  const auth = await doneTask(GOAL, '唤醒观测批准');
  return (await core.recoveryReadGrant(gm, grantInput(source, auth))).grant.id;
}

const grantView = async (grantId: string) => (await core.recoveryReadStatus(gm, { grantId }))[0]!.grant;

check('2a: the grant read returns an issued grant on the real fork (a failed read used to look like "no grants")', async () => {
  // The company fork rejects ORDER BY on a field missing from the selection; the dispatcher turned that parse
  // error into an empty grant list every tick, so every issued grant silently never woke. Pin the read itself.
  const grantId = await issuedGrant();
  const wf = new Workforce(database, join(dir, 'unused-credential-files'));
  const grants = await wf.activeRecoveryGrants(Math.floor(Date.now() / 1000));
  expect(grants.map(grant => grant.id)).toContain(grantId);
});

check('2a: a grant whose employee has no session logs a no_instance skip and stays issued', async () => {
  const grantId = await issuedGrant();
  const h = wakeHarness({ instances: [], adoptRecovery: async () => { throw new Error('must not be called'); } });
  await h.dispatcher.tick();
  expect(h.logs.some(line => line.includes(`grant ${grantId}`) && line.includes('reason=no_instance'))).toBe(true);
  expect(h.sends).toHaveLength(0);
  const view = await grantView(grantId);
  expect(view.state).toBe('issued');
  expect(view.lastSkipReason).toBe('no_instance');
  expect(view.lastWakeAt).toBeUndefined();
});

check('2a: a busy session logs state=busy and the grant is neither interrupted nor bound', async () => {
  const grantId = await issuedGrant();
  const h = wakeHarness({ instances: [idleSeat()], statuses: { 'agent-eng1': 'busy' },
    adoptRecovery: async () => { throw new Error('must not be called'); } });
  await h.dispatcher.tick();
  expect(h.logs.some(line => line.includes(`grant ${grantId}`) && line.includes('reason=state=busy'))).toBe(true);
  expect(h.sends).toHaveLength(0);
  const view = await grantView(grantId);
  expect(view.state).toBe('issued');
  expect(view.lastSkipReason).toBe('state=busy');
});

check('2a: an adoptRecovery failure logs failed and the grant stays issued', async () => {
  const grantId = await issuedGrant();
  const h = wakeHarness({ instances: [idleSeat()], statuses: { 'agent-eng1': 'idle' },
    adoptRecovery: async () => { throw new Error('fixture channel bind failure'); } });
  await h.dispatcher.tick();
  expect(h.logs.some(line => line.includes(`grant ${grantId}`) && line.includes('failed: fixture channel bind failure'))).toBe(true);
  const view = await grantView(grantId);
  expect(view.state).toBe('issued');
  expect(view.lastSkipReason).toBe('failed');
  expect(view.lastWakeAt).toBeUndefined();
});

check('2a: a healthy idle seat binds the grant within one tick and stamps last_wake_at', async () => {
  const grantId = await issuedGrant();
  const h = wakeHarness({ instances: [idleSeat()], statuses: { 'agent-eng1': 'idle' },
    adoptRecovery: async (_inst, id) => core.recoveryReadBind(eng1, { grantId: id!, fence: 1 }) });
  await h.dispatcher.tick();
  expect(h.logs.some(line => line.includes(`recovery wake recovery-eng1 for grant ${grantId}`))).toBe(true);
  expect(h.sends).toHaveLength(1);
  expect(h.sends[0]!.agentId).toBe('agent-eng1');
  const view = await grantView(grantId);
  expect(view.state).toBe('bound');
  expect(view.lastWakeAt).toBeDefined();
  expect(view.lastSkipReason).toBeUndefined();
});

check('the dispatcher states the missing recovery hook once at startup, not once per tick', async () => {
  const h = wakeHarness({ withSidecar: false });
  await h.dispatcher.tick();
  await h.dispatcher.tick();
  expect(h.logs.filter(line => line === 'recovery wake disabled: sidecar hook missing')).toHaveLength(1);
});

// --- FV06 continue-after-login regression (d15cbecb §6, T1–T13) ------------------------------------------------
// A login that succeeded but whose four GETs were never sent used to look identical to a chain that was never
// consented: the next wake asked for another login (refused), and the source task lost its only chance at evidence.

const until = async (fn: () => boolean, ms = 5000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (fn()) return; await Bun.sleep(20); }
  throw new Error('condition not met');
};

/**
 * A real SidecarPool over the real core. The ops gateway is a fixture that performs the same reserve/settle the
 * broker does, so the channel's login-handle capture, claim.json mirror and refusal audit are exercised for real
 * without any product/IdP call.
 */
async function sidecarRig() {
  const runDir = await mkdtemp(join(tmpdir(), 'sck-recovery-fork-sidecar-'));
  const opsCalls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const ops = {
    tools: ['ops_info', 'ops_operator_login', 'ops_request', 'ops_logout'],
    call: async (cred: string, _taskId: string, tool: string, args: Record<string, unknown>, proof: { grantId: string; grantFence: number }) => {
      opsCalls.push({ tool, args });
      if (tool === 'ops_operator_login') {
        const reserved = await core.recoveryReadReserve(cred, { grantId: proof.grantId, grantFence: proof.grantFence, kind: 'login' });
        if (!reserved.allowed) throw new Error(reserved.message);
        await core.recoveryReadSettle(cred, { grantId: proof.grantId, grantFence: proof.grantFence, callId: reserved.callId!, kind: 'login', ok: true, outcome: 'login_ok' });
        return { session: `s_fixture_${randomUUID().slice(0, 8)}`, kind: 'operator', alias: RECOVERY_READ_ALIAS,
          username: 'fixture', expiresAt: new Date(Date.now() + 600_000).toISOString() };
      }
      if (tool === 'ops_request') {
        const path = String(args.path);
        const reserved = await core.recoveryReadReserve(cred, { grantId: proof.grantId, grantFence: proof.grantFence, kind: 'get', path });
        if (!reserved.allowed) throw new Error(reserved.message);
        await core.recoveryReadSettle(cred, { grantId: proof.grantId, grantFence: proof.grantFence, callId: reserved.callId!, kind: 'get',
          path, status: 503, ok: true, outcome: 'not_configured_503' });
        return { status: 503, body: { error: { code: 'endpoint-probe-temporary-grant-not-configured' } } };
      }
      return { closed: true };
    },
    releaseGrant: () => 0,
    release: () => ({ sessions: 0, browserSpaces: 0, pending: 0 }),
  };
  const logs: string[] = [];
  const pool = new SidecarPool({ core: core as never, workforce: { rotate: async () => eng1 } as never, ops, runDir,
    heartbeatMs: 60_000, sweepMs: 20, log: message => logs.push(message) });
  const inst: EmployeeInst = { id: 'recovery-eng1', role: 'engineering', credential: eng1 } as EmployeeInst;
  const env = pool.env(inst);
  const relay = async (dir: string, key: string, name: string, tool: string, args: Record<string, unknown>) => {
    writeFileSync(join(dir, 'req', `${name}.json`), JSON.stringify({ key, tool, args }));
    await until(() => existsSync(join(dir, 'res', `${name}.json`)), 5000);
    return JSON.parse(readFileSync(join(dir, 'res', `${name}.json`), 'utf8')) as { ok: boolean; data?: unknown; error?: string };
  };
  return { runDir, pool, inst, env, ops, relay, opsCalls, logs };
}

/**
 * The real OpsBroker with a synthetic environment and a real-core audit sink: pre-try refusals are produced by the
 * broker's own enforcement and persisted where recovery_read_status reads them.
 */
async function brokerRig(sourceTaskId: string, grantId: string) {
  const world = new FakeWorld();
  const company = new FakeCompany();
  company.env('demo', 'production', brokerConfig({ ops: { clientId: OPS_CLIENT, redirectUri: OPS_REDIRECT, resource: OPS_RESOURCE } }));
  const audits: Array<{ action: string; evidence: string }> = [];
  const chain = { state: 'running' as 'bound' | 'running', loginAttempts: 1, perPath: [0, 0, 0, 0] as number[],
    inFlight: undefined as { callId: string; path: string } | undefined };
  const recoveryScope: OpsScope = {
    actor: { employeeId: 'recovery-eng1', role: 'engineering', capabilities: ['execute'] },
    taskId: sourceTaskId, project: 'demo', kind: 'recovery_read',
    recovery: { grantId, grantFence: 1, alias: RECOVERY_READ_ALIAS, paths: [...RECOVERY_READ_PATHS] },
  };
  const leaseScope: OpsScope = { actor: recoveryScope.actor, taskId: sourceTaskId, project: 'demo' };
  const coreAdapter = {
    opsScope: async (_credential: string, _taskId: string, proof?: { grantId: string; grantFence: number }) => proof ? recoveryScope : leaseScope,
    auditOps: async (_scope: OpsScope, action: string, evidence: string) => {
      audits.push({ action, evidence });
      await database.db.query(`CREATE audit CONTENT { task: $task, actor: $actor, action: $action, evidence: $evidence, at: time::now() };`,
        { task: new RecordId('task', sourceTaskId), actor: new RecordId('employee', 'recovery-eng1'), action, evidence });
    },
    opsCount: async () => 0,
    recoveryReadReserve: async (_credential: string, input: { kind: 'login' | 'get' | 'logout'; path?: string }) => {
      if (input.kind === 'logout') return { allowed: true, kind: 'logout', callId: randomUUID(), message: 'logout allowed' };
      if (chain.inFlight) return { allowed: false, kind: input.kind, reason: 'busy', message: 'Recovery read is busy with another call' };
      const callId = randomUUID();
      if (input.kind === 'login') {
        if (chain.state !== 'bound') return { allowed: false, kind: 'login', reason: 'login_unavailable', message: 'login unavailable' };
        chain.loginAttempts += 1;
        chain.inFlight = { callId, path: 'login' };
        return { allowed: true, kind: 'login', callId, message: 'login reserved' };
      }
      const index = RECOVERY_READ_PATHS.indexOf(input.path as never);
      if (index < 0) return { allowed: false, kind: 'get', reason: 'path_not_in_grant', message: 'Path is not in this grant' };
      chain.perPath[index] = (chain.perPath[index] ?? 0) + 1;
      chain.inFlight = { callId, path: input.path! };
      return { allowed: true, kind: 'get', callId, path: input.path, message: 'read reserved' };
    },
    recoveryReadSettle: async () => {},
  };
  const broker = new OpsBroker({
    core: coreAdapter as never, projects: company.projects as never, secretKey: () => Buffer.alloc(32),
    controlEnv: () => ({ cloudflareToken: 'cf-token-value', cloudflareAccountId: 'acct' }),
    fetch: (async (input: string | URL | Request, init?: RequestInit) => world.fetch(input as never, init as never)) as never,
    now: world.now, monoNow: () => world.clock, d1: () => world.d1, queryAsUser: world.queryAsUser, browser: world.browser,
    sleep: async ms => { world.clock += ms; },
  });
  return { broker, world, company, chain, audits, cred: 'fixture-credential', sourceTaskId, grantId };
}

/** A lease-mode operator session (no grantId): under a recovery proof it must be refused as session_foreign. */
async function seedForeignSession(r: Awaited<ReturnType<typeof brokerRig>>): Promise<string> {
  await r.broker.call(r.cred, r.sourceTaskId, 'ops_account_ensure', { alias: RECOVERY_READ_ALIAS });
  const user = r.world.user('sck-lca04-ops')!;
  r.world.operatorCaps.set(user.id, ['quota.read', 'subscription.manage']);
  const login = await r.broker.call(r.cred, r.sourceTaskId, 'ops_operator_login', { alias: RECOVERY_READ_ALIAS }) as { session: string };
  return login.session;
}

const wakeEnv = () => ({ opsRepo: dir, sckBin: '/fixture/sck', paseoBin: '/fixture/paseo' });
const wakeGrant = (patch: Record<string, unknown> = {}) => ({
  id: 'g-prompt', taskId: 'task-done', paths: [...RECOVERY_READ_PATHS], expiresAt: new Date(Date.now() + 600_000).toISOString(),
  state: 'bound', loginAttempts: 0, perPath: [0, 0, 0, 0], maxLogin: 1, maxCallsPerPath: 1, ...patch,
});
const promptOf = (patch: Record<string, unknown> = {}) => recoveryWake(idleSeat(), wakeGrant(patch), wakeEnv(), false, { comm: true, commDir: '/tmp/comm' });
const viewGrant = (view: Awaited<ReturnType<typeof grantView>>, patch: Record<string, unknown> = {}) => ({
  id: view.id, taskId: view.taskId, paths: view.paths, expiresAt: view.expiresAt, state: view.state,
  loginAttempts: view.loginAttempts, perPath: view.perPath, maxLogin: 1, maxCallsPerPath: 1, ...patch,
});

check('T1: a bound grant with no login asks for exactly one login and carries state/nextPath', async () => {
  const prompt = promptOf({ state: 'bound', loginAttempts: 0, perPath: [0, 0, 0, 0] });
  expect(prompt.match(/ops_operator_login/g) ?? []).toHaveLength(1);
  expect(prompt).toContain('"state":"bound"');
  expect(prompt).toContain('"nextPath":0');
  expect(prompt).toContain('立刻');
  // The four ordered GETs are spelled out in the same turn: no waiting for another wake.
  for (const path of RECOVERY_READ_PATHS) expect(prompt).toContain(path);
});

check('T2: a running grant never asks for a login and points at the next path', async () => {
  const prompt = promptOf({ state: 'running', loginAttempts: 1, perPath: [1, 0, 0, 0] });
  expect(prompt).not.toContain('ops_operator_login');
  expect(prompt).toContain('登录已完成');
  expect(prompt).toContain('perPath=[1,0,0,0]');
  expect(prompt).toContain('nextPath=1');
  expect(prompt).toContain(RECOVERY_READ_PATHS[1]);
});

check('T3: perPath=[1,0,0,0] gives the second GET only and forbids replaying the first', async () => {
  const prompt = promptOf({ state: 'running', loginAttempts: 1, perPath: [1, 0, 0, 0] });
  expect(prompt).toContain(RECOVERY_READ_PATHS[1]);
  expect(prompt).not.toContain('"path":"' + RECOVERY_READ_PATHS[0] + '"');
  expect(prompt).toContain('不要重放');
  expect(nextRecoveryPath([1, 0, 0, 0])).toBe(1);
  expect(nextRecoveryPath([0, 0, 0, 0])).toBe(0);
  expect(nextRecoveryPath([1, 1, 1, 1])).toBe(-1);
});

check('T4: a completed grant is not returned to the wake loop and sends nothing', async () => {
  const source = await doneTask(GOAL, 'T4 完成源任务');
  await openEpisode(source);
  const auth = await doneTask(GOAL, 'T4 批准');
  const { grant } = await core.recoveryReadGrant(gm, grantInput(source, auth));
  await core.recoveryReadBind(eng1, { grantId: grant.id, fence: 1 });
  const login = await core.recoveryReadReserve(eng1, { grantId: grant.id, grantFence: 1, kind: 'login' });
  await core.recoveryReadSettle(eng1, { grantId: grant.id, grantFence: 1, callId: login.callId!, kind: 'login', ok: true, outcome: 'login_ok' });
  for (const path of RECOVERY_READ_PATHS) {
    const get = await core.recoveryReadReserve(eng1, { grantId: grant.id, grantFence: 1, kind: 'get', path });
    await core.recoveryReadSettle(eng1, { grantId: grant.id, grantFence: 1, callId: get.callId!, kind: 'get', path, status: 200, ok: true, outcome: 'ok' });
  }
  const wf = new Workforce(database, join(dir, 'unused-credential-files'));
  expect(await wf.activeRecoveryGrants(Date.now())).toHaveLength(0);
  const h = wakeHarness({ instances: [idleSeat()], statuses: { 'agent-eng1': 'idle' },
    adoptRecovery: async () => { throw new Error('a completed grant must not be adopted'); } });
  await h.dispatcher.tick();
  expect(h.sends).toHaveLength(0);
  expect((await grantView(grant.id)).state).toBe('completed');
});

check('T5: a failed login burns the single attempt, stops the chain and later wakes never ask again', async () => {
  const source = await doneTask(GOAL, 'T5 登录失败源任务');
  await openEpisode(source);
  const auth = await doneTask(GOAL, 'T5 批准');
  const { grant } = await core.recoveryReadGrant(gm, grantInput(source, auth));
  await core.recoveryReadBind(eng1, { grantId: grant.id, fence: 1 });
  const login = await core.recoveryReadReserve(eng1, { grantId: grant.id, grantFence: 1, kind: 'login' });
  await core.recoveryReadSettle(eng1, { grantId: grant.id, grantFence: 1, callId: login.callId!, kind: 'login', ok: false, outcome: 'login_failed' });
  const view = await grantView(grant.id);
  expect(view).toMatchObject({ state: 'stopped', stopReason: 'login_failed', loginAttempts: 1 });
  const wf = new Workforce(database, join(dir, 'unused-credential-files'));
  expect(await wf.activeRecoveryGrants(Date.now())).toHaveLength(0);
  const prompt = recoveryWake(idleSeat(), viewGrant(view), wakeEnv(), false, { comm: true });
  expect(prompt).not.toContain('ops_operator_login');
});

check('T6: the login handle survives the turn, claim.json carries it, and the next wake resumes GET #1', async () => {
  const rig = await sidecarRig();
  try {
    const source = await doneTask(GOAL, 'T6 句柄源任务');
    await openEpisode(source);
    const auth = await doneTask(GOAL, 'T6 批准');
    const { grant } = await core.recoveryReadGrant(gm, grantInput(source, auth));
    await rig.pool.adoptRecovery(rig.inst, grant.id);
    const login = await rig.relay(rig.env.SCK_COMM_DIR, rig.env.SCK_COMM_KEY!, 't6-login', 'ops_operator_login', { alias: RECOVERY_READ_ALIAS });
    expect(login.ok).toBe(true);
    const staged = JSON.parse(readFileSync(join(rig.env.SCK_COMM_DIR, 'claim.json'), 'utf8')) as { recovery?: { sessionHandle?: string } };
    const handle = staged.recovery?.sessionHandle;
    expect(typeof handle).toBe('string');
    const running = await grantView(grant.id);
    expect(running.state).toBe('running');
    const claim = await rig.pool.adoptRecovery(rig.inst, grant.id);
    expect(claim?.sessionHandle).toBe(handle);
    const prompt = recoveryWake(idleSeat(), viewGrant(running, { sessionHandle: claim?.sessionHandle }), wakeEnv(), false, { comm: true });
    expect(prompt).toContain(handle!);
    expect(prompt).not.toContain('ops_operator_login');
    const get = await rig.relay(rig.env.SCK_COMM_DIR, rig.env.SCK_COMM_KEY!, 't6-get1', 'ops_request',
      { session: handle, method: 'GET', path: RECOVERY_READ_PATHS[0] });
    expect(get.ok).toBe(true);
    expect((await grantView(grant.id)).perPath).toEqual([1, 0, 0, 0]);
  } finally {
    rig.pool.close();
    await rm(rig.runDir, { recursive: true, force: true });
  }
});

check('T7: a handle opened outside this grant is refused as session_foreign and moves no counter', async () => {
  const source = await doneTask(GOAL, 'T7 句柄隔离源任务');
  await openEpisode(source);
  const auth = await doneTask(GOAL, 'T7 批准');
  const { grant } = await core.recoveryReadGrant(gm, grantInput(source, auth));
  const r = await brokerRig(source, grant.id);
  const foreign = await seedForeignSession(r);
  const before = { ...r.chain, perPath: [...r.chain.perPath] };
  const error = await refusal(r.broker.call(r.cred, source, 'ops_request',
    { session: foreign, method: 'GET', path: RECOVERY_READ_PATHS[0] }, { grantId: grant.id, grantFence: 1 }));
  expect(error.code).toBe('forbidden');
  expect(error.message).toContain('grant');
  expect(r.chain.perPath).toEqual(before.perPath);
  expect(r.chain.loginAttempts).toBe(before.loginAttempts);
  const view = await grantView(grant.id);
  expect(view.refusals).toMatchObject({ session_foreign: 1 });
  expect(view.lastRefusal).toMatchObject({ outcome: 'session_foreign', tool: 'ops_request' });
});

check('T8: a running grant whose handle died with the process is stopped(session_lost), not retried', async () => {
  const rig = await sidecarRig();
  let second: SidecarPool | undefined;
  try {
    const source = await doneTask(GOAL, 'T8 句柄丢失源任务');
    await openEpisode(source);
    const auth = await doneTask(GOAL, 'T8 批准');
    const { grant } = await core.recoveryReadGrant(gm, grantInput(source, auth));
    await rig.pool.adoptRecovery(rig.inst, grant.id);
    const login = await rig.relay(rig.env.SCK_COMM_DIR, rig.env.SCK_COMM_KEY!, 't8-login', 'ops_operator_login', { alias: RECOVERY_READ_ALIAS });
    expect(login.ok).toBe(true);
    expect((await grantView(grant.id)).state).toBe('running');
    // A new process over the same channel state: the in-memory handle is gone with the old pool.
    rig.pool.close();
    second = new SidecarPool({ core: core as never, workforce: { rotate: async () => eng1 } as never, ops: rig.ops, runDir: rig.runDir,
      heartbeatMs: 60_000, sweepMs: 20, log: () => undefined });
    second.env(rig.inst);
    await expect(second.adoptRecovery(rig.inst, grant.id)).rejects.toThrow(/session_lost/);
    const view = await grantView(grant.id);
    expect(view).toMatchObject({ state: 'stopped', stopReason: 'session_lost' });
    expect(view.sessionPresent).toBe(false);
    const wf = new Workforce(database, join(dir, 'unused-credential-files'));
    expect(await wf.activeRecoveryGrants(Date.now())).toHaveLength(0);
  } finally {
    second?.close();
    rig.pool.close();
    await rm(rig.runDir, { recursive: true, force: true });
  }
});

check('T9: each reserve refusal writes a closed-enum row and never moves the counters', async () => {
  const source = await doneTask(GOAL, 'T9 拒绝入账源任务');
  await openEpisode(source);
  const auth = await doneTask(GOAL, 'T9 批准');
  const { grant } = await core.recoveryReadGrant(gm, grantInput(source, auth));
  await core.recoveryReadBind(eng1, { grantId: grant.id, fence: 1 });
  // read_unavailable: a GET before the login.
  expect(await core.recoveryReadReserve(eng1, { grantId: grant.id, grantFence: 1, kind: 'get', path: RECOVERY_READ_PATHS[0] }))
    .toMatchObject({ allowed: false, reason: 'read_unavailable' });
  let view = await grantView(grant.id);
  expect(view).toMatchObject({ loginAttempts: 0, perPath: [0, 0, 0, 0] });
  // login_unavailable: the login is already settled successfully.
  const login = await core.recoveryReadReserve(eng1, { grantId: grant.id, grantFence: 1, kind: 'login' });
  await core.recoveryReadSettle(eng1, { grantId: grant.id, grantFence: 1, callId: login.callId!, kind: 'login', ok: true, outcome: 'login_ok' });
  expect(await core.recoveryReadReserve(eng1, { grantId: grant.id, grantFence: 1, kind: 'login' }))
    .toMatchObject({ allowed: false, reason: 'login_unavailable' });
  // path_order: skipping the first path.
  expect(await core.recoveryReadReserve(eng1, { grantId: grant.id, grantFence: 1, kind: 'get', path: RECOVERY_READ_PATHS[1] }))
    .toMatchObject({ allowed: false, reason: 'path_order' });
  view = await grantView(grant.id);
  expect(view).toMatchObject({ loginAttempts: 1, perPath: [0, 0, 0, 0] });
  const get = await core.recoveryReadReserve(eng1, { grantId: grant.id, grantFence: 1, kind: 'get', path: RECOVERY_READ_PATHS[0] });
  await core.recoveryReadSettle(eng1, { grantId: grant.id, grantFence: 1, callId: get.callId!, kind: 'get', path: RECOVERY_READ_PATHS[0], status: 503, ok: true, outcome: 'not_configured_503' });
  // path_attempted: the same path twice.
  expect(await core.recoveryReadReserve(eng1, { grantId: grant.id, grantFence: 1, kind: 'get', path: RECOVERY_READ_PATHS[0] }))
    .toMatchObject({ allowed: false, reason: 'path_attempted' });
  const status = await core.recoveryReadStatus(gm, { grantId: grant.id });
  const refusals = status[0]!.calls.filter(call => !call.ok).map(call => call.outcome);
  expect(refusals).toEqual(expect.arrayContaining(['read_unavailable', 'login_unavailable', 'path_order', 'path_attempted']));
  expect(status[0]!.grant).toMatchObject({ loginAttempts: 1, perPath: [1, 0, 0, 0] });
  expect(status[0]!.grant.refusals).toMatchObject({ read_unavailable: 1, login_unavailable: 1, path_order: 1, path_attempted: 1 });
});

check('T10: pre-try refusals leave visible enum rows without touching the chain', async () => {
  const source = await doneTask(GOAL, 'T10 pre-try 源任务');
  await openEpisode(source);
  const auth = await doneTask(GOAL, 'T10 批准');
  const { grant } = await core.recoveryReadGrant(gm, grantInput(source, auth));
  const r = await brokerRig(source, grant.id);
  const proof = { grantId: grant.id, grantFence: 1 };
  const call = (tool: string, args: Record<string, unknown>) => r.broker.call(r.cred, source, tool, args, proof);
  await refusal(call('ops_info', {}));
  await refusal(call('ops_request', { session: 's_x', method: 'GET', path: RECOVERY_READ_PATHS[0], taskId: source }));
  await refusal(call('ops_request', { session: 's_x', method: 'POST', path: RECOVERY_READ_PATHS[0] }));
  await refusal(call('ops_request', { session: 's_x', method: 'GET', path: '/api/ops/other' }));
  await refusal(call('ops_request', { session: 's_missing', method: 'GET', path: RECOVERY_READ_PATHS[0] }));
  const foreign = await seedForeignSession(r);
  await refusal(call('ops_request', { session: foreign, method: 'GET', path: RECOVERY_READ_PATHS[0] }));
  expect(r.chain).toMatchObject({ loginAttempts: 1, perPath: [0, 0, 0, 0] });
  expect(r.audits.filter(a => a.action === 'ops_recovery_refuse')).toHaveLength(6);
  const view = await grantView(grant.id);
  expect(view.refusals).toMatchObject({
    not_allowlisted_tool: 1, reserved_arg: 1, method_not_get: 1, path_not_in_grant: 1,
    session_missing: 1, session_foreign: 1,
  });
  expect(view.lastRefusal?.outcome).toBe('session_foreign');
});

check('T11: sidecar-local refusals land as the same enum audit on the source task', async () => {
  const rig = await sidecarRig();
  try {
    const source = await doneTask(GOAL, 'T11 本地拒绝源任务');
    await openEpisode(source);
    const auth = await doneTask(GOAL, 'T11 批准');
    const { grant } = await core.recoveryReadGrant(gm, grantInput(source, auth));
    await rig.pool.adoptRecovery(rig.inst, grant.id);
    await rig.relay(rig.env.SCK_COMM_DIR, rig.env.SCK_COMM_KEY!, 't11-reserved', 'ops_request',
      { session: 's_x', method: 'GET', path: RECOVERY_READ_PATHS[0], taskId: source });
    await rig.relay(rig.env.SCK_COMM_DIR, rig.env.SCK_COMM_KEY!, 't11-tool', 'ops_info', {});
    const view = await grantView(grant.id);
    expect(view.refusals).toMatchObject({ reserved_arg: 1, not_allowlisted_tool: 1 });
    expect(view.loginAttempts).toBe(0);
    expect(view.perPath).toEqual([0, 0, 0, 0]);
  } finally {
    rig.pool.close();
    await rm(rig.runDir, { recursive: true, force: true });
  }
});

check('T12: the refusal vocabulary is closed and unknown outcomes are rejected, not stored', async () => {
  const source = await doneTask(GOAL, 'T12 枚举源任务');
  await openEpisode(source);
  const auth = await doneTask(GOAL, 'T12 批准');
  const { grant } = await core.recoveryReadGrant(gm, grantInput(source, auth));
  const error = await refusal(core.recoveryReadRefuse(eng1, { grantId: grant.id, outcome: 'free_text_reason' }));
  expect(error.code).toBe('invalid');
  const view = await grantView(grant.id);
  for (const outcome of Object.keys(view.refusals ?? {})) expect(RECOVERY_READ_REFUSALS).toContain(outcome as never);
  expect(view.refusals).toBeUndefined();
});

check('T13: the fork marker is still printed under the gate flag and no added case skips silently', async () => {
  expect(enabled).toBe(true);
  expect(markerPrinted).toBe(true);
  const source = readFileSync(join(import.meta.dir, 'recovery-read.fork.test.ts'), 'utf8');
  expect((source.match(/test\.skipIf\(!enabled\)/g) ?? [])).toHaveLength(1);
  expect(source).not.toContain(['test', 'skip'].join('.') + '(');
});
