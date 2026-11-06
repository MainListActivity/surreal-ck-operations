import { afterAll, beforeAll, beforeEach, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordId } from 'surrealdb';
import { CompanyDatabase } from '../src/database.ts';
import { SurrealCompanyCore } from '../src/core.ts';
import { LocalEnrollmentAdmin } from '../src/enrollment.ts';
import { OwnerDesk } from '../src/owner.ts';
import { getRoute, listRoutes, saveRoute, disableRoute } from '../src/routes.ts';

setDefaultTimeout(60000);
// Isolated company fork on a private RocksDB store: no production data, credentials or dispatcher.
const run = process.env.RUN_SCK_TASK_ROUTES_TESTS === '1' ? test : test.skip;
let dir: string, server: ReturnType<typeof Bun.spawn>, db: CompanyDatabase, core: SurrealCompanyCore, owner: OwnerDesk, gm: string, eng: string, qa: string, count = 0;

beforeAll(async () => {
  if (process.env.RUN_SCK_TASK_ROUTES_TESTS !== '1') return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'sck-task-routes-')));
  const listener = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('fixture') });
  const port = listener.port!; listener.stop(true);
  server = Bun.spawn([join(homedir(), '.surrealdb/surreal'), 'start', '--bind', `127.0.0.1:${port}`, '--user', 'root', '--pass', 'fixture-only', '--log', 'error', `rocksdb:${dir}/db`], { stdout: 'ignore', stderr: 'ignore' });
  for (let n = 0; n < 160; n++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch {} await Bun.sleep(25); }
  db = new CompanyDatabase({ url: `ws://127.0.0.1:${port}/rpc`, rootUser: 'root', rootPassword: 'fixture-only', namespace: 'task_routes_fixture', database: 'control_plane' });
  await db.connect(); await db.bootstrap();
  core = new SurrealCompanyCore(db); owner = new OwnerDesk(db);
  const admin = new LocalEnrollmentAdmin(db);
  gm = await admin.enroll('routes-gm', 'owner', ['execute', 'review', 'manage']);
  eng = await admin.enroll('routes-eng', 'engineering', ['execute', 'review']);
  qa = await admin.enroll('routes-qa', 'qa', ['execute', 'review']);
});
afterAll(async () => { if (!dir) return; await db.close(); server.kill(); await server.exited; rmSync(dir, { recursive: true, force: true }); });
beforeEach(async () => { if (process.env.RUN_SCK_TASK_ROUTES_TESTS === '1') await db.db.query('UPDATE employee SET active_task = NONE;'); });

const key = () => `routes-${++count}-${crypto.randomUUID()}`;
const proof = (c: { task: { id: string; version: number }; deliveryId: string; fence: number }) => ({ taskId: c.task.id, deliveryId: c.deliveryId, fence: c.fence, expectedVersion: c.task.version });
const evidence = (extra: Record<string, unknown> = {}) => ({ text: 'fixture evidence long enough to be accepted by the task service validation', idempotencyKey: key(), ...extra });
const byType = (type: string) => saveRoute(db.db, { type, label: type, executor_role: 'engineering', reviewer_role: 'qa', code: false, hold: false, enabled: true }, 'test');

run('route seeds exist, list/save/disable round-trip, roles differ and cycles refuse', async () => {
  const types = (await listRoutes(db.db)).map(r => r.type);
  expect(types).toContain('software');
  await byType('tr-a'); await byType('tr-b');
  const saved = await saveRoute(db.db, { type: 'tr-c', label: 'tr-c', executor_role: 'engineering', reviewer_role: 'qa', code: false, next: 'tr-b', hold: false, enabled: true }, 'test');
  expect((await getRoute(db.db, 'tr-c'))?.next).toBe('tr-b');
  await disableRoute(db.db, 'tr-c', 'test');
  expect((await getRoute(db.db, 'tr-c'))?.enabled).toBe(false);
  await saveRoute(db.db, { ...saved, enabled: true } as never, 'test');
  // Same role on both sides refuses.
  await expect(saveRoute(db.db, { type: 'tr-same', label: 'x', executor_role: 'qa', reviewer_role: 'qa', code: false, hold: false, enabled: true }, 'test')).rejects.toMatchObject({ code: 'invalid' });
  // next must point at an enabled route and the chain may never loop back.
  await expect(saveRoute(db.db, { type: 'tr-missing', label: 'x', executor_role: 'engineering', reviewer_role: 'qa', code: false, next: 'tr-nope', hold: false, enabled: true }, 'test')).rejects.toMatchObject({ code: 'invalid' });
  await byType('tr-ring');
  await expect(saveRoute(db.db, { type: 'tr-ring', label: 'x', executor_role: 'engineering', reviewer_role: 'qa', code: false, next: 'tr-ring', hold: false, enabled: true }, 'test')).rejects.toMatchObject({ code: 'invalid' });
});

run('task.create expands the route chain: planned children with inherited fields and two drafts each', async () => {
  await saveRoute(db.db, { type: 'chain-mid', label: 'mid', executor_role: 'engineering', reviewer_role: 'qa', code: false, hold: false, enabled: true }, 'test');
  await saveRoute(db.db, { type: 'chain-leaf', label: 'leaf', executor_role: 'engineering', reviewer_role: 'qa', code: false, hold: false, enabled: true }, 'test');
  await saveRoute(db.db, { type: 'chain-root', label: 'root', executor_role: 'engineering', reviewer_role: 'qa', code: false, next: 'chain-mid', hold: false, enabled: true }, 'test');
  await saveRoute(db.db, { type: 'chain-mid', label: 'mid', executor_role: 'engineering', reviewer_role: 'qa', code: false, next: 'chain-leaf', hold: false, enabled: true }, 'test');
  const root = await core.createTask(gm, { type: 'chain-root', title: '链路根任务', context: 'fixture', requirement: '根需求', acceptance_text: '根验收', idempotencyKey: key() } as never);
  expect(root.type).toBe('chain-root');
  const [children] = await db.db.query<[Array<{ id: RecordId; title: string; type: string; state: string; parent: RecordId; proposed_in?: string }>]>(
    'SELECT id, title, type, state, parent, proposed_in FROM task WHERE parent = $r ;', { r: new RecordId('task', root.id) });
  expect(children).toHaveLength(1);
  const mid = children[0]!;
  expect(mid.state).toBe('planned'); expect(mid.type).toBe('chain-mid'); expect(mid.title).toContain('mid'); expect(mid.proposed_in).toBeUndefined();
  const [leafs] = await db.db.query<[Array<{ state: string }>]>('SELECT state FROM task WHERE parent = $m;', { m: mid.id });
  expect(leafs[0]!.state).toBe('planned');
  // Every chain task holds its execute and review drafts.
  for (const t of [root.id, String(mid.id.id)]) {
    const [drafts] = await db.db.query<[Array<{ step: string; state: string }>]>('SELECT step, state FROM outbound_message WHERE task = $t;', { t: new RecordId('task', t) });
    expect(drafts.map(d => d.step).sort()).toEqual(['execute', 'review']);
    expect(drafts.every(d => d.state === 'draft')).toBe(true);
  }
});

run('accept activates the planned child in the same transaction; return voids only proposals', async () => {
  await saveRoute(db.db, { type: 'act-next', label: 'next', executor_role: 'engineering', reviewer_role: 'qa', code: false, hold: false, enabled: true }, 'test');
  await saveRoute(db.db, { type: 'act-root', label: 'root', executor_role: 'engineering', reviewer_role: 'qa', code: false, next: 'act-next', hold: false, enabled: true }, 'test');
  const root = await core.createTask(gm, { type: 'act-root', title: '激活根', context: 'fixture', idempotencyKey: key() } as never);
  const [children] = await db.db.query<[Array<{ id: RecordId; state: string }>]>('SELECT id, state FROM task WHERE parent = $r;', { r: new RecordId('task', root.id) });
  const child = String(children[0]!.id.id);
  expect(children[0]!.state).toBe('planned');
  const claim = await core.claim(eng, root.id);
  await core.submit(eng, proof(claim), evidence());
  const review = await core.claim(qa, root.id);
  await core.accept(qa, proof(review), evidence());
  expect((await core.getTask(gm, root.id)).state).toBe('done');
  expect((await core.getTask(gm, child)).state).toBe('ready');

  // A submitted proposal under the same task: return voids it but the route successor stays.
  const t2 = await core.createTask(gm, { type: 'act-root', title: '退回根', context: 'fixture', idempotencyKey: key() } as never);
  const c2 = await core.claim(eng, t2.id);
  await core.submit(eng, proof(c2), evidence({ next: [{ type: 'act-next', title: '员工提议后续' }] }));
  const [props] = await db.db.query<[Array<{ id: RecordId; state: string; proposed_in?: string }>]>('SELECT id, state, proposed_in FROM task WHERE parent = $r;', { r: new RecordId('task', t2.id) });
  const proposal = props.find(p => p.proposed_in !== undefined)!;
  const routeChild = props.find(p => p.proposed_in === undefined)!;
  expect(proposal.state).toBe('planned'); expect(routeChild.state).toBe('planned');
  const r2 = await core.claim(qa, t2.id);
  await core.returnTask(qa, proof(r2), evidence());
  expect((await core.getTask(gm, String(proposal.id.id))).state).toBe('void');
  expect((await core.getTask(gm, String(routeChild.id.id))).state).toBe('planned');
});

run('submit next proposals are planned children with drafts; an unknown type refuses the whole submit', async () => {
  await saveRoute(db.db, { type: 'prop-t', label: 't', executor_role: 'engineering', reviewer_role: 'qa', code: false, hold: false, enabled: true }, 'test');
  const good = await core.createTask(gm, { title: '提议父', context: 'fixture', executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: key() } as never);
  const c = await core.claim(eng, good.id);
  await core.submit(eng, proof(c), evidence({ next: [{ type: 'prop-t', title: '子提议' }] }));
  const [props] = await db.db.query<[Array<{ id: RecordId; state: string; type: string; proposed_in?: string }>]>('SELECT id, state, type, proposed_in FROM task WHERE parent = $r;', { r: new RecordId('task', good.id) });
  expect(props).toHaveLength(1); expect(props[0]!.state).toBe('planned'); expect(props[0]!.type).toBe('prop-t'); expect(props[0]!.proposed_in).toBeDefined();
  const [drafts] = await db.db.query<[Array<{ step: string }>]>('SELECT step FROM outbound_message WHERE task = $t;', { t: props[0]!.id });
  expect(drafts.map(d => d.step).sort()).toEqual(['execute', 'review']);
  const bad = await core.createTask(gm, { title: '坏提议父', context: 'fixture', executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: key() } as never);
  const cb = await core.claim(eng, bad.id);
  await expect(core.submit(eng, proof(cb), evidence({ next: [{ type: 'tr-nope', title: '不存在' }] }))).rejects.toMatchObject({ code: 'invalid' });
  expect((await core.getTask(gm, bad.id)).state).toBe('doing');
});

run('a prior submitter may not review its own task; a different reviewer may', async () => {
  const t = await core.createTask(gm, { title: '提交人复核隔离', context: 'fixture', executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: key() } as never);
  // Reuse the submitter as a would-be reviewer by reassigning review to engineering: the audit still bars it.
  const c = await core.claim(eng, t.id);
  await core.submit(eng, proof(c), evidence());
  await expect(core.claim(eng, t.id)).rejects.toMatchObject({ code: 'self_review' });
  const r = await core.claim(qa, t.id);
  expect(r.task.state).toBe('review');
});

run('rework prefers the last submitter when it can claim', async () => {
  const t = await core.createTask(gm, { title: '返修优先', context: 'fixture', executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: key() } as never);
  const c = await core.claim(eng, t.id);
  await core.submit(eng, proof(c), evidence());
  const r = await core.claim(qa, t.id);
  await core.returnTask(qa, proof(r), evidence());
  const again = await core.claim(eng, t.id);
  expect(again.task.state).toBe('doing');
});
