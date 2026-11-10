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
import { writeBoardView, readBoardView, writeRunnerHeartbeat, renderContextFor } from '../src/board.ts';
import { Workforce } from '../src/workforce.ts';
import { saveRoute } from '../src/routes.ts';

setDefaultTimeout(60000);

// 认领原子性的真实 fork 测试（门控 RUN_SCK_CLOUD_RUNNER_TESTS=1）。
// 只用 ~/.surrealdb/surreal，在临时 rocksdb 目录起停；两个独立连接模拟两台执行端并发认领同一对象。
const run = process.env.RUN_SCK_CLOUD_RUNNER_TESTS === '1' ? test : test.skip;
const ROOT_PASSWORD = 'fixture-only';
const NAMESPACE = 'runner_ownership_fixture';

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

run('节点归属隔离：只管理本节点员工和租约，兼容节点可接管旧记录', async () => {
  const a = new Workforce(dbA, undefined, { id: 'native:a' });
  const b = new Workforce(dbB, undefined, { id: 'native:b' });
  const legacy = new Workforce(dbA, undefined, { id: 'paseo:legacy', adoptLegacy: true });
  const admin = new Workforce(dbA);
  await admin.upsertDef('ownership-fixture', { role: 'engineering', provider: 'factory-droid', model: 'fixture' });
  const def = (await admin.defs()).find(d => d.id === 'ownership-fixture')!;
  const ia = await a.spawnInst(def), ib = await b.spawnInst(def), old = await admin.spawnInst(def);
  expect((await a.insts()).map(i => i.id)).toContain(ia.id);
  expect((await a.insts()).map(i => i.id)).not.toContain(ib.id);
  expect((await a.insts()).map(i => i.id)).not.toContain(old.id);
  expect((await b.insts()).map(i => i.id)).toEqual([ib.id]);
  expect((await legacy.insts()).map(i => i.id)).toContain(old.id);
  expect((await legacy.insts()).map(i => i.id)).not.toContain(ia.id);
  await saveRoute(dbA.db, { type: 'ownership', label: 'ownership', executor_role: 'engineering', reviewer_role: 'qa', code: false, hold: false, enabled: true }, 'test');
  const task = await coreA.createTask(gm, { type: 'ownership', title: '节点租约隔离', context: 'fixture', idempotencyKey: key() } as never);
  expect((await a.tasks()).map(t => t.id)).toContain(task.id);
  expect((await b.tasks()).map(t => t.id)).toContain(task.id);
  await coreA.claim(ia.credential!, task.id);
  expect((await a.tasks()).map(t => t.id)).toContain(task.id);
  expect((await b.tasks()).map(t => t.id)).not.toContain(task.id);
  expect((await legacy.tasks()).map(t => t.id)).not.toContain(task.id);
});

run('两节点看板/心跳独立保存，渲染使用员工所在节点的 sck 路径', async () => {
  const base = { queue: [], at: Date.now() };
  await writeBoardView(dbA.db, { ...base, env: { sckBin: '/mac/sck', opsRepo: '/mac/repo' }, employees: { a: { commDir: '/mac/comm', next: [] } } }, 'native:a');
  await writeBoardView(dbB.db, { ...base, at: base.at + 1, env: { sckBin: '/remote/sck', opsRepo: '/remote/repo' }, employees: { b: { commDir: '/remote/comm', next: [] } } }, 'native:b');
  const view = (await readBoardView(dbA.db))!;
  expect(Object.keys(view.employees).sort()).toEqual(['a', 'b']);
  expect(renderContextFor(view, 'a', { taskId: 't', step: 'execute', acceptanceCriteria: [] })?.sckBin).toBe('/mac/sck');
  await writeRunnerHeartbeat(dbA.db, { runner: 'native:a', host: 'a', version: 'fixture' });
  await writeRunnerHeartbeat(dbB.db, { runner: 'native:b', host: 'b', version: 'fixture' });
  const [beats] = await dbA.db.query<[unknown[]]>('SELECT * FROM runner_heartbeat;');
  expect(beats).toHaveLength(2);
});
