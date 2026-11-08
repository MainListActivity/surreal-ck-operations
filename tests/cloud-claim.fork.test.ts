import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordId } from 'surrealdb';
import { CompanyDatabase } from '../src/database.ts';
import { SurrealCompanyCore } from '../src/core.ts';
import { LocalEnrollmentAdmin } from '../src/enrollment.ts';
import { OutboundMessageStore } from '../src/outbound-messages.ts';
import { OpsJobRunner, type OpsJobDeps } from '../src/cloud/ops-jobs.ts';
import { saveRoute } from '../src/routes.ts';

setDefaultTimeout(60000);

// 认领原子性的真实 fork 测试（门控 RUN_SCK_CLOUD_RUNNER_TESTS=1）。
// 只用 ~/.surrealdb/surreal，在临时 rocksdb 目录起停；两个独立连接模拟两台执行端并发认领同一对象。
const run = process.env.RUN_SCK_CLOUD_RUNNER_TESTS === '1' ? test : test.skip;
const ROOT_PASSWORD = 'fixture-only';
const NAMESPACE = 'cloud_claim_fixture';

let dir: string, server: ReturnType<typeof Bun.spawn>, url: string;
let dbA: CompanyDatabase, dbB: CompanyDatabase;
let coreA: SurrealCompanyCore, coreB: SurrealCompanyCore;
let gm: string, engA: string, engB: string, count = 0;

const config = () => ({ url, rootUser: 'root', rootPassword: ROOT_PASSWORD, namespace: NAMESPACE, database: 'control_plane' });
const key = () => `claim-${++count}-${crypto.randomUUID()}`;

beforeAll(async () => {
  if (process.env.RUN_SCK_CLOUD_RUNNER_TESTS !== '1') return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'sck-cloud-claim-')));
  const listener = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('fixture') });
  const port = listener.port!; listener.stop(true);
  url = `ws://127.0.0.1:${port}/rpc`;
  server = Bun.spawn([join(homedir(), '.surrealdb/surreal'), 'start', '--bind', `127.0.0.1:${port}`, '--user', 'root', '--pass', ROOT_PASSWORD, '--log', 'error', `rocksdb:${dir}/db`], { stdout: 'ignore', stderr: 'ignore' });
  for (let n = 0; n < 160; n++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch {} await new Promise(done => setTimeout(done, 25)); }
  // 两个执行端各自一个连接；bootstrap 只做一次。
  dbA = new CompanyDatabase(config());
  await dbA.connect(); await dbA.bootstrap();
  dbB = new CompanyDatabase(config());
  await dbB.connect();
  // connect 只登录不选库，第二个连接需要显式 use。
  await dbB.db.use({ namespace: NAMESPACE, database: 'control_plane' });
  coreA = new SurrealCompanyCore(dbA); coreB = new SurrealCompanyCore(dbB);
  const admin = new LocalEnrollmentAdmin(dbA);
  gm = await admin.enroll('claim-gm', 'owner', ['execute', 'review', 'manage']);
  engA = await admin.enroll('claim-eng-a', 'engineering', ['execute', 'review']);
  engB = await admin.enroll('claim-eng-b', 'engineering', ['execute', 'review']);
});

afterAll(async () => {
  if (!dir) return;
  await dbA.close(); await dbB.close();
  server.kill(); await server.exited;
  rmSync(dir, { recursive: true, force: true });
});

run('任务认领：两台执行端并发认领同一 ready 任务，只有一个成功，另一个 already_claimed', async () => {
  await saveRoute(dbA.db, { type: 'claim-race', label: 'claim-race', executor_role: 'engineering', reviewer_role: 'qa', code: false, hold: false, enabled: true }, 'test');
  const task = await coreA.createTask(gm, { type: 'claim-race', title: '认领竞争任务', context: 'fixture', idempotencyKey: key() } as never);
  const results = await Promise.allSettled([coreA.claim(engA, task.id), coreB.claim(engB, task.id)]);
  const won = results.filter(r => r.status === 'fulfilled');
  const lost = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
  expect(won).toHaveLength(1);
  expect(lost).toHaveLength(1);
  expect((lost[0]!.reason as { code?: string }).code).toBe('already_claimed');
  // 库中只有一条 claim 审计，任务的 fence 只前进一次。
  const [audits] = await dbA.db.query<[Array<{ actor: unknown }>]>(
    "SELECT actor FROM audit WHERE task = $t AND action = 'claim';", { t: new RecordId('task', task.id) });
  expect(audits).toHaveLength(1);
  const [rows] = await dbA.db.query<[Array<{ current_employee: string; fence: number }>]>(
    'SELECT current_employee, fence FROM task WHERE id = $t;', { t: new RecordId('task', task.id) });
  const winner = (won[0] as PromiseFulfilledResult<{ fence: number }>).value;
  expect(rows[0]!.fence).toBe(winner.fence);
});

run('outbound 消息认领：两个执行端并发 markSent 同一条消息，只有一个成功', async () => {
  await saveRoute(dbA.db, { type: 'claim-msg', label: 'claim-msg', executor_role: 'engineering', reviewer_role: 'qa', code: false, hold: false, enabled: true }, 'test');
  const task = await coreA.createTask(gm, { type: 'claim-msg', title: '消息认领任务', context: 'fixture', idempotencyKey: key() } as never);
  const [msgs] = await dbA.db.query<[Array<{ id: RecordId }>]>(
    "SELECT id FROM outbound_message WHERE task = $t AND step = 'execute';", { t: new RecordId('task', task.id) });
  const messageId = String(msgs[0]!.id.id);
  const storeA = new OutboundMessageStore(dbA.db), storeB = new OutboundMessageStore(dbB.db);
  const results = await Promise.allSettled([
    storeA.markSent(messageId, engA, 'body-a'),
    storeB.markSent(messageId, engB, 'body-b'),
  ]);
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  const lost = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  expect((lost?.reason as { code?: string }).code).toBe('conflict');
  const [rows] = await dbA.db.query<[Array<{ state: string; sent_to: string }>]>(
    'SELECT state, sent_to FROM $m;', { m: msgs[0]!.id });
  expect(rows[0]!.state).toBe('sent');
  expect([engA, engB]).toContain(rows[0]!.sent_to);
});

run('运维作业认领：两个执行端并发 drain 同一 queued 作业，opsCall 只执行一次', async () => {
  // 作业字段按 058：input 为 JSON 文本，task 为 task 记录（bootstrap 已应用 058，对象形状会被类型拒绝）。
  await dbA.db.query("CREATE ops_job:claim_race CONTENT { command: 'ops_info', input: '{}', actor_kind: 'agent', actor: 'agent-1', task: task:⟨task-claim⟩, state: 'queued', created_at: time::now() };");
  const calls: string[] = [];
  const deps = (name: string, db: CompanyDatabase): OpsJobDeps => ({
    db: db.db, runner: name, runnerOnlyCommands: new Set<string>(),
    opsCall: async () => { calls.push(name); return { ok: true, by: name }; },
    runnerOnly: async () => ({}), hostExec: async () => ({ exitCode: 0 }), releaseInstall: async () => ({ installed: true }),
  });
  const a = new OpsJobRunner(deps('runner-a', dbA));
  const b = new OpsJobRunner(deps('runner-b', dbB));
  await Promise.all([a.drain(), b.drain()]);
  expect(calls).toHaveLength(1);
  const [rows] = await dbA.db.query<[Array<{ state: string; runner?: string }>]>('SELECT state, runner FROM ops_job:claim_race;');
  expect(rows[0]!.state).toBe('done');
  expect(rows[0]!.runner).toBe(calls[0]);
});
