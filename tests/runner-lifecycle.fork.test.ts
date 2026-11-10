import { afterAll, beforeAll, expect, test, setDefaultTimeout } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompanyDatabase, CLOUD_SCHEMA_VERSION } from '../src/database.ts';
import { SurrealCompanyCore } from '../src/core.ts';
import { LocalEnrollmentAdmin } from '../src/enrollment.ts';
import { Workforce } from '../src/workforce.ts';
import { SidecarPool } from '../src/runner/sidecar.ts';
import { saveRoute } from '../src/routes.ts';
setDefaultTimeout(60000);
const run = process.env.RUN_SCK_CLOUD_RUNNER_TESTS === '1' ? test : test.skip;
let dir: string, server: ReturnType<typeof Bun.spawn>, db: CompanyDatabase, core: SurrealCompanyCore, owner: string, wf: Workforce;
const pools: SidecarPool[] = [];
beforeAll(async () => {
  if (process.env.RUN_SCK_CLOUD_RUNNER_TESTS !== '1') return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'sck-lifecycle-fork-')));
  const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('ok') });
  const port = probe.port!; probe.stop(true);
  server = Bun.spawn([join(homedir(), '.surrealdb/surreal'), 'start', '--bind', `127.0.0.1:${port}`, '--user', 'root', '--pass', 'fixture', '--log', 'error', `rocksdb:${dir}/db`], { stdout: 'ignore', stderr: 'ignore' });
  for (let i = 0; i < 160; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch {} await Bun.sleep(25); }
  db = new CompanyDatabase({ url: `ws://127.0.0.1:${port}/rpc`, namespace: 'lifecycle', database: 'fixture', rootUser: 'root', rootPassword: 'fixture' });
  await db.connect(); await db.bootstrap(); core = new SurrealCompanyCore(db); wf = new Workforce(db);
  owner = await new LocalEnrollmentAdmin(db).enroll('owner', 'owner', ['manage', 'execute', 'review']);
  await saveRoute(db.db, { type: 'lifecycle-fixture', label: 'lifecycle', executor_role: 'engineering', reviewer_role: 'qa', code: false, hold: false, enabled: true }, 'fixture');
});
afterAll(async () => { for (const pool of pools) pool.close(); if (db) await db.close(); if (server) { server.kill(); await server.exited; } if (dir) rmSync(dir, { recursive: true, force: true }); });
run('真实 fork：模型零生命周期命令，从领取、自动送审到独立 QA 验收完成', async () => {
  const task = await core.createTask(owner, { type: 'lifecycle-fixture', title: '执行端自动收尾', context: '验证自动状态转换', idempotencyKey: crypto.randomUUID() } as never);
  for (const role of ['engineering', 'qa'] as const) {
    await wf.upsertDef(`fixture-${role}`, { role, provider: 'claude', model: 'fixture' });
    const def = (await wf.defs()).find(d => d.id === `fixture-${role}`)!;
    const inst = await wf.spawnInst(def);
    const pool = new SidecarPool({ runDir: join(dir, role, 'comm'), core, workforce: wf, managedLifecycle: true }); pools.push(pool);
    pool.env(inst); inst.paseoAgentId = role; pool.bindAgent(inst.id, role);
    await pool.claim(inst, { id: task.id } as never);
    await pool.turnStarted(role, role + '-turn');
    const result = await pool.settleExecution({ agent: { id: role }, turnId: role + '-turn', outcome: { kind: 'completed' },
      timeline: [{ type: 'assistant_message', text: role === 'qa' ? '复核结论：通过\n已独立核对自动收尾的执行证据与结果，全部符合本任务验收要求。' : '工作结果：完成\n已核对任务目标和验收要求，输出完整可核验的测试结果。' }] });
    expect(result?.status).toBe('ingested');
    expect((await core.getTask(owner, task.id)).state).toBe(role === 'qa' ? 'done' : 'review');
  }
  const history = await core.history(owner, task.id);
  expect(history.filter(h => h.action === 'submit')).toHaveLength(1);
  expect(history.filter(h => h.action === 'accept')).toHaveLength(1);
});

run('模板迁移可重复执行，保留老板修改的正文与已发送记录', async () => {
  const { readFileSync } = await import('node:fs');
  const { OutboundMessageStore } = await import('../src/outbound-messages.ts');
  const { RecordId } = await import('surrealdb');
  const migration = readFileSync(join(import.meta.dir, '../schema/064-runner-lifecycle.surql'), 'utf8');
  const old = '先读 notes.md。按 task.md 完成当前步骤，记录可验证证据；有前置缺口请报告阻塞。 使用派工消息中的 sck 命令记录 checkpoint / submit。不要创建后继任务，由迭代流程统一推进。提交后结束本轮。';
  const store = new OutboundMessageStore(db.db);
  const one = await store.createDraft('fixture-template', 'execute', 'product', false, 'doing', old);
  const edited = await store.createDraft('fixture-template', 'execute', 'product', false, 'doing', old + '老板补充：只读核对。');
  const sent = await store.createDraft('fixture-template', 'execute', 'product', false, 'doing', old);
  await db.db.query('UPDATE $id SET state="sent";', { id: new RecordId('outbound_message', sent.id) });
  await db.db.query(migration); await db.db.query(migration);
  expect((await store.get(one.id))?.body).not.toContain('checkpoint / submit');
  expect((await store.get(edited.id))?.body).toBe(old + '老板补充：只读核对。');
  expect((await store.get(sent.id))?.body).toBe(old);
});

run('完整迁移保存当前 schema 回执，重复迁移不降级', async () => {
  await db.applySchema(false);
  const [rows] = await db.db.query('SELECT schema_version FROM company_meta:installation;');
  expect((rows as Array<{schema_version:number}>)[0]?.schema_version).toBe(CLOUD_SCHEMA_VERSION);
});
