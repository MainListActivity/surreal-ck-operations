import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordId } from 'surrealdb';
import { CompanyDatabase } from '../src/database.ts';
import { SurrealCompanyCore } from '../src/core.ts';
import type { CompanyCore } from '../src/contracts.ts';
import { LocalEnrollmentAdmin } from '../src/enrollment.ts';
import { OwnerDesk } from '../src/owner.ts';
import { ownerApi } from '../src/owner-api.ts';
import { OutboundMessageStore } from '../src/outbound-messages.ts';
import { saveRoute } from '../src/routes.ts';
import { taskBrief } from '../src/dispatcher/brief.ts';

setDefaultTimeout(60000);
const run = process.env.RUN_SCK_TASK_ROUTES_TESTS === '1' ? test : test.skip;
let dir: string, server: ReturnType<typeof Bun.spawn>, db: CompanyDatabase, core: SurrealCompanyCore, eng: string, ownerTok: string, count = 0;

beforeAll(async () => {
  if (process.env.RUN_SCK_TASK_ROUTES_TESTS !== '1') return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'sck-owner-acc-')));
  const listener = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('fixture') });
  const port = listener.port!; listener.stop(true);
  server = Bun.spawn([join(homedir(), '.surrealdb/surreal'), 'start', '--bind', `127.0.0.1:${port}`, '--user', 'root', '--pass', 'fixture-only', '--log', 'error', `rocksdb:${dir}/db`], { stdout: 'ignore', stderr: 'ignore' });
  for (let n = 0; n < 160; n++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch {} await Bun.sleep(25); }
  db = new CompanyDatabase({ url: `ws://127.0.0.1:${port}/rpc`, rootUser: 'root', rootPassword: 'fixture-only', namespace: 'owner_acc_fixture', database: 'control_plane' });
  await db.connect(); await db.bootstrap();
  core = new SurrealCompanyCore(db);
  const admin = new LocalEnrollmentAdmin(db);
  eng = await admin.enroll('acc-eng', 'engineering', ['execute', 'review']);
  ownerTok = await admin.enroll('acc-owner', 'owner', ['execute', 'review', 'manage']);
  process.env.SCK_OWNER_TOKEN = ownerTok;
});
afterAll(async () => { if (!dir) return; await db.close(); server.kill(); await server.exited; rmSync(dir, { recursive: true, force: true }); });

const apiCtx = () => ({ db, core: core as unknown as CompanyCore & { contributorDryRun(credential: string, input: { taskIds: string[] }): Promise<unknown> }, owner: new OwnerDesk(db), workforce: null as never, messages: new OutboundMessageStore(db.db), opsRepo: '/tmp' });
const key = () => `acc-${++count}-${crypto.randomUUID()}`;
const ACC = '验收标准：上线页能在生产打开且按钮生效';

run('owner task.create stores acceptance_text, the planned child inherits it, and taskBrief renders 验收标准', async () => {
  await saveRoute(db.db, { type: 'oa-child', label: 'child', executor_role: 'qa', reviewer_role: 'engineering', code: false, hold: false, enabled: true }, 'test');
  await saveRoute(db.db, { type: 'oa-root', label: 'root', executor_role: 'engineering', reviewer_role: 'qa', code: false, next: 'oa-child', hold: false, enabled: true }, 'test');
  const out = await ownerApi(apiCtx(), { command: 'task.create', type: 'oa-root',
    title: '上线一个落地页', requirement: '做一个 B2C 落地页并发布到生产', acceptance: ACC, idempotencyKey: key() }, 'cli');
  const taskId = (out as { task: { id: string } }).task.id;
  void taskId;
  const [rows] = await db.db.query<[Array<{ acceptance_text?: string }>]>('SELECT acceptance_text FROM $t;', { t: new RecordId('task', taskId) });
  expect(rows[0]?.acceptance_text).toBe(ACC);
  const [children] = await db.db.query<[Array<{ acceptance_text?: string }>]>(
    "SELECT acceptance_text FROM task WHERE parent = $t AND state = 'planned';", { t: new RecordId('task', taskId) });
  expect(children.length).toBeGreaterThan(0);
  expect(children[0]?.acceptance_text).toBe(ACC);
  const brief = taskBrief({ task: { id: taskId, title: '上线一个落地页', requirement: '做一个 B2C 落地页并发布到生产', acceptance_text: ACC } } as never);
  expect(brief).toContain('## 验收标准');
  expect(brief).toContain(ACC);
});

run('submit next proposal stores its acceptance text', async () => {
  await saveRoute(db.db, { type: 'oa-prop', label: 'prop', executor_role: 'engineering', reviewer_role: 'qa', code: false, hold: false, enabled: true }, 'test');
  const created = await ownerApi(apiCtx(), { command: 'task.create', type: 'oa-prop',
    title: '提议链源头任务', requirement: '提议链源头任务的上下文与验收范围说明。', acceptance: '源任务验收标准', idempotencyKey: key() }, 'cli');
  const task = (created as { task: { id: string } }).task;
  const claim = await core.claim(eng, task.id);
  const evidence = () => ({ text: 'fixture evidence long enough to be accepted by the task service validation', idempotencyKey: key(),
    next: [{ type: 'oa-prop', title: '提议的后续任务', requirement: '后续需求正文', acceptance: '后续验收标准正文' }] });
  await core.submit(eng, { taskId: claim!.task.id, deliveryId: claim!.deliveryId, fence: claim!.fence, expectedVersion: claim!.task.version }, evidence());
  const [props] = await db.db.query<[Array<{ acceptance_text?: string; requirement?: string }>]>(
    "SELECT acceptance_text, requirement FROM task WHERE proposed_in != NONE AND parent = $t;", { t: new RecordId('task', task.id) });
  expect(props.length).toBe(1);
  expect(props[0]?.acceptance_text).toBe('后续验收标准正文');
  expect(props[0]?.requirement).toBe('后续需求正文');
});

run('owner task.create by executorRole honours hold: the task stays held until released', async () => {
  const out = await ownerApi(apiCtx(), { command: 'task.create', executorRole: 'product', reviewerRole: 'owner', hold: true,
    title: '按岗位建单扣住', requirement: '需求原文', acceptanceText: '验收原文' }, 'web') as { task?: { id: string }; id?: string };
  const id = out.task?.id ?? out.id!;
  const store = new OutboundMessageStore(db.db);
  expect(await store.isHeld(id, 'execute')).toBe(true);
});

run('owner task.create for read-only engineering work does not get the deploy template', async () => {
  const out = await ownerApi(apiCtx(), { command: 'task.create', executorRole: 'engineering', reviewerRole: 'owner', workIntent: { kind: 'read' },
    title: '只读巡检', requirement: '需求原文', acceptanceText: '验收原文' }, 'web') as { task?: { id: string }; id?: string };
  const id = out.task?.id ?? out.id!;
  const [rows] = await db.db.query<[Array<{ acceptance_criteria?: Array<{ verify: string }> }>]>('SELECT acceptance_criteria FROM type::record("task", $id);', { id });
  expect((rows[0]?.acceptance_criteria ?? []).some(c => c.verify === 'deploy-run')).toBe(false);
});
