// Company fork regression for ops_platform_operator_list: the tool runs through the real OpsBroker and a real
// company database, against the product's operator-listing contract (format_version 1). Gated like the other
// fork suites:
//   RUN_COMPANY_PROOF_FORK_TESTS=1 bun test tests/platform-operator-list.fork.test.ts
// The IdP and product are synthetic; no real credential, operator subject or model is touched.
import { afterAll, beforeAll, expect, test } from 'bun:test';
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
import { OpsBroker } from '../src/ops/broker.ts';
import { PROOF_GOAL } from '../src/ops/proof-contract.ts';
import { brokerConfig, FakeWorld, OPS_CLIENT, OPS_REDIRECT, OPS_RESOURCE } from './support/ops-world.ts';

const enabled = process.env.RUN_COMPANY_PROOF_FORK_TESTS === '1';
const check = test.skipIf(!enabled);
const key = Buffer.alloc(32, 29); // synthetic sealing key, no real service credentials

let dir: string, url: string, child: ReturnType<typeof Bun.spawn>, database: CompanyDatabase;
let core: SurrealCompanyCore, projects: ProjectStore, ops: OpsBroker, world: FakeWorld;
let gm: string, author: string, taskId: string;

async function start() {
  const binary = join(homedir(), '.surrealdb/surreal');
  child = Bun.spawn([binary, 'start', '--no-banner', '--log', 'none', '--bind', url.replace('ws://', ''), '--user', 'root', '--pass', 'root', 'rocksdb:' + join(dir, 'db')], { stdout: 'ignore', stderr: 'ignore' });
  for (let i = 0; i < 100; i++) { const p = Bun.spawn([binary, 'is-ready', '--endpoint', url], { stdout: 'ignore', stderr: 'ignore' }); if (await p.exited === 0) return; await Bun.sleep(50); }
  throw new Error('company fork unavailable');
}
async function connect() {
  database = new CompanyDatabase({ url: url + '/rpc', rootUser: 'root', rootPassword: 'root', namespace: 'platform_operator_test', database: 'control_plane' });
  await database.connect(); await database.bootstrap(); core = new SurrealCompanyCore(database); projects = new ProjectStore(database.db);
}
async function stop() { await database.close(); child.kill(); await child.exited; }

beforeAll(async () => {
  if (!enabled) return;
  dir = await realpath(await mkdtemp(join(tmpdir(), 'platform-operator-fork-')));
  const port = await new Promise<number>(resolve => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const a = s.address() as { port: number }; s.close(() => resolve(a.port)); }); });
  url = 'ws://127.0.0.1:' + port; await start(); await connect();
  const enroll = new LocalEnrollmentAdmin(database);
  gm = await enroll.enroll('test-gm', 'owner', ['execute', 'review', 'manage']);
  author = await enroll.enroll('test-author', 'engineering', ['execute', 'review']);
  await projects.upsert({
    id: 'surreal_ck', name: 'synthetic', repoPath: dir, release: 'synthetic',
    envs: [{ name: 'production', broker: brokerConfig({ ops: { clientId: OPS_CLIENT, redirectUri: OPS_REDIRECT, resource: OPS_RESOURCE } }) }],
  });
  await database.db.query('CREATE $goal CONTENT {state:"active",project:$project,anchors:[],tasks:{}};', { goal: new RecordId('goal', PROOF_GOAL), project: new RecordId('project', 'surreal_ck') });
  world = new FakeWorld();
  const task = await core.createTask(gm, { title: 'Synthetic operator listing', context: 'Only test fixtures', executorRole: 'engineering', reviewerRole: 'qa', goalId: PROOF_GOAL, idempotencyKey: randomUUID() });
  taskId = task.id;
  await core.claim(author, task.id);
  ops = new OpsBroker({
    core, projects, secretKey: () => key, serviceHome: dir, now: world.now,
    controlEnv: () => ({ cloudflareToken: '{{SECRET_fk9z8y7x}}', cloudflareAccountId: 'acct' }),
    fetch: world.fetch, d1: () => world.d1, queryAsUser: world.queryAsUser, browser: world.browser,
  });
}, 30_000);

afterAll(async () => {
  if (enabled) { await stop(); await rm(dir, { recursive: true, force: true }); }
});

async function call(tool: string, args: Record<string, unknown> = {}) {
  return await ops.call(author, taskId, tool, args) as Record<string, any>;
}

check('an operator session lists platform operators through the real broker with hashes only', async () => {
  await call('ops_account_ensure', { alias: 'qa-ops' });
  const subject = world.user('sck-qa-ops')!.id;
  world.operatorCaps.set(subject, ['quota.read']);
  const login = await call('ops_operator_login', { alias: 'qa-ops' });
  const before = world.sql.filter(row => /^\s*(INSERT|UPDATE|DELETE|CREATE|DEFINE|REMOVE)\b/i.test(row.sql)).length;
  const view = await call('ops_platform_operator_list', { session: login.session });
  expect(view.format_version).toBe(1);
  expect(view.operators.length).toBe(3);
  for (const operator of view.operators) {
    expect(Object.keys(operator).sort()).toEqual(['capabilities', 'isCurrent', 'kind', 'status', 'subject_hash']);
    expect(operator.subject_hash).toMatch(/^sha256:[a-f0-9]{12}$/);
  }
  expect(view.operators.filter((o: { isCurrent: boolean }) => o.isCurrent)).toHaveLength(1);
  const text = JSON.stringify(view);
  expect(text).not.toContain(subject);
  expect(text).not.toContain('synthetic-second-operator');
  expect(text).not.toContain('@');
  const after = world.sql.filter(row => /^\s*(INSERT|UPDATE|DELETE|CREATE|DEFINE|REMOVE)\b/i.test(row.sql)).length;
  expect(after).toBe(before);
});

check('a customer session cannot list platform operators', async () => {
  await call('ops_account_ensure', { alias: 'owner' });
  const login = await call('ops_login', { alias: 'owner' });
  const error = await call('ops_platform_operator_list', { session: login.session }).catch((e: { code?: string }) => e);
  expect(error.code).toBe('invalid');
});

check('the audit trail records the listing without PII', async () => {
  const rows = await database.db.query<[Array<{ action: string; evidence: string }>]>(
    "SELECT action, evidence FROM audit WHERE task = $task AND action = 'ops_call' AND evidence CONTAINS 'ops_platform_operator_list';",
    { task: new RecordId('task', taskId) });
  const evidence = (rows[0] ?? []).map(row => row.evidence);
  expect(evidence.some(text => /ops_platform_operator_list → 200 operators=3 current=1/.test(text))).toBe(true);
  expect(JSON.stringify(evidence)).not.toContain('@');
});
