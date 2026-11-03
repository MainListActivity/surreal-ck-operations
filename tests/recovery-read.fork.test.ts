// FV06 recovery read grant fork regression: the real company core on an isolated company fork.
//   RUN_COMPANY_PROOF_FORK_TESTS=1 bun test tests/recovery-read.fork.test.ts
// Everything is synthetic: no production credential, product call, secret or model is touched.
import { afterAll, beforeAll, beforeEach, setDefaultTimeout, test } from 'bun:test';
import { expect } from 'bun:test';
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
import { RECOVERY_READ_ALIAS, RECOVERY_READ_PATHS } from '../src/recovery-read.ts';
import { brokerConfig } from './support/ops-world.ts';
import type { ClaimResult, CreateTask, Evidence } from '../src/contracts.ts';

const enabled = process.env.RUN_COMPANY_PROOF_FORK_TESTS === '1';
const check = test.skipIf(!enabled);
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
  expect(installation?.schema_version).toBe(49);
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
    .toMatchObject({ allowed: false, reason: 'not_bound', message: expect.stringContaining('not bound') });
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
    .toMatchObject({ allowed: false, reason: 'grant_stopped' });
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
  expect(JSON.stringify(mine)).not.toMatch(/session|token|subject|https?:/i);
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
    .toMatchObject({ allowed: false, reason: 'grant_revoked' });
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
