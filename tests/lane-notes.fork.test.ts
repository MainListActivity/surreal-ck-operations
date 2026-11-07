import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordId } from 'surrealdb';
import { CompanyDatabase } from '../src/database.ts';
import { SurrealCompanyCore } from '../src/core.ts';
import { LocalEnrollmentAdmin } from '../src/enrollment.ts';
import { LaneNoteStore } from '../src/lane-notes.ts';
import { saveRoute } from '../src/routes.ts';

setDefaultTimeout(60000);
// Isolated company fork on a private store: no production data, credentials or dispatcher.
const run = process.env.RUN_SCK_TASK_ROUTES_TESTS === '1' ? test : test.skip;
let dir: string, server: ReturnType<typeof Bun.spawn>, db: CompanyDatabase, core: SurrealCompanyCore, notes: LaneNoteStore, gm: string, eng: string, qa: string, count = 0;

beforeAll(async () => {
  if (process.env.RUN_SCK_TASK_ROUTES_TESTS !== '1') return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'sck-lane-notes-')));
  const listener = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('fixture') });
  const port = listener.port!; listener.stop(true);
  server = Bun.spawn([join(homedir(), '.surrealdb/surreal'), 'start', '--bind', `127.0.0.1:${port}`, '--user', 'root', '--pass', 'fixture-only', `rocksdb:${join(dir, 'db')}`], { stdout: 'ignore', stderr: 'ignore' });
  for (let n = 0; n < 160; n++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch {} await Bun.sleep(25); }
  db = new CompanyDatabase({ url: `ws://127.0.0.1:${port}/rpc`, rootUser: 'root', rootPassword: 'fixture-only', namespace: 'lane_notes_fixture', database: 'control_plane' } as never);
  await db.connect(); await db.bootstrap();
  core = new SurrealCompanyCore(db); notes = new LaneNoteStore(db.db);
  const admin = new LocalEnrollmentAdmin(db);
  gm = await admin.enroll('lanes-gm', 'owner', ['execute', 'review', 'manage']);
  eng = await admin.enroll('lanes-eng', 'engineering', ['execute', 'review']);
  qa = await admin.enroll('lanes-qa', 'qa', ['execute', 'review']);
  await db.db.query(`CREATE project:alpha CONTENT { name: 'alpha', repo_path: '/tmp/alpha-fixture' };`);
  await db.db.query(`CREATE project:beta CONTENT { name: 'beta', repo_path: '/tmp/beta-fixture' };`);
});
afterAll(async () => { if (!dir) return; await db.close(); server.kill(); await server.exited; rmSync(dir, { recursive: true, force: true }); });

const key = () => `lanes-${++count}-${crypto.randomUUID()}`;
const proof = (c: { task: { id: string; version: number }; deliveryId: string; fence: number }) => ({ taskId: c.task.id, deliveryId: c.deliveryId, fence: c.fence, expectedVersion: c.task.version });
const evidence = (extra: Record<string, unknown> = {}) => ({ text: 'fixture evidence long enough to be accepted by the task service validation', idempotencyKey: key(), ...extra });
const task = (title: string, project?: string) => core.createTask(gm, { title, context: 'fixture', executorRole: 'engineering', reviewerRole: 'qa', project, idempotencyKey: key() } as never);
const texts = async (lane: string) => (await notes.active(lane)).map(n => n.text).sort();

run('a done task\'s lessons reach the next claim of the same lane only', async () => {
  const first = await task('沉淀笔记', 'alpha');
  const c = await core.claim(eng, first.id);
  expect(c.lane).toBe('alpha:engineering');
  await core.submit(eng, proof(c), evidence({ learned: ['执行经验'] }));
  const r = await core.claim(qa, first.id);
  expect(r.lane).toBe('alpha:qa');
  await core.accept(qa, proof(r), evidence({ learned: ['复核标准'] }));
  expect(await texts('alpha:engineering')).toEqual([]); // Proposals wait for settle.
  expect(await notes.settle()).toMatchObject({ activated: 2, discarded: 0 });
  expect(await texts('alpha:engineering')).toEqual(['执行经验']);
  expect(await texts('alpha:qa')).toEqual(['复核标准']);

  const same = await task('同线的任务', 'alpha');
  const next = await core.claim(eng, same.id);
  expect(next.laneNotes).toContain('执行经验');
  expect(next.laneNotes).not.toContain('复核标准'); // Executor and reviewer lanes never see each other's notes.
  await core.submit(eng, proof(next), evidence());
  const rv = await core.claim(qa, same.id);
  expect(rv.laneNotes).toContain('复核标准');
  await core.accept(qa, proof(rv), evidence());

  const other = await task('别的项目', 'beta');
  const b = await core.claim(eng, other.id);
  expect(b.laneNotes).not.toContain('执行经验');
  await core.submit(eng, proof(b), evidence());
  await core.accept(qa, proof(await core.claim(qa, other.id)), evidence());
});

run('a returned attempt loses its executor lessons but keeps the reviewer\'s; a void task loses all', async () => {
  const t = await task('退回的任务', 'alpha');
  const c = await core.claim(eng, t.id);
  await core.submit(eng, proof(c), evidence({ learned: ['被否定的做法'] }));
  await core.returnTask(qa, proof(await core.claim(qa, t.id)), evidence({ learned: ['退回时的标准'] }));
  await notes.settle();
  const rework = await core.claim(eng, t.id);
  await core.submit(eng, proof(rework), evidence({ learned: ['返工后的做法'] }));
  await core.accept(qa, proof(await core.claim(qa, t.id)), evidence());
  await notes.settle();
  expect(await texts('alpha:engineering')).not.toContain('被否定的做法');
  expect(await texts('alpha:engineering')).toContain('返工后的做法');
  expect(await texts('alpha:qa')).toContain('退回时的标准');

  const dead = await task('作废的任务', 'alpha');
  await core.submit(eng, proof(await core.claim(eng, dead.id)), evidence({ learned: ['作废任务的经验'] }));
  await db.db.query(`UPDATE $t SET state = 'void';`, { t: new RecordId('task', dead.id) });
  expect((await notes.settle()).discarded).toBe(1);
  expect(await texts('alpha:engineering')).not.toContain('作废任务的经验');
});

run('a bad learned list refuses the submit before anything changes', async () => {
  const t = await task('非法笔记');
  const c = await core.claim(eng, t.id);
  await expect(core.submit(eng, proof(c), evidence({ learned: [`sck_${'a'.repeat(32)}`] }))).rejects.toMatchObject({ code: 'invalid' });
  expect((await core.getTask(gm, t.id)).state).toBe('doing');
  await core.submit(eng, proof(c), evidence());
  await core.accept(qa, proof(await core.claim(qa, t.id)), evidence());
});

run('a task without a project uses the company lane', async () => {
  const t = await task('无项目的任务');
  const c = await core.claim(eng, t.id);
  expect(c.lane).toBe('company:engineering');
  await core.submit(eng, proof(c), evidence());
  await core.accept(qa, proof(await core.claim(qa, t.id)), evidence());
});

run('owner notes: immediate, queued seed notes wait for approval, and a full lane holds new lessons', async () => {
  const mine = await notes.add('gamma:qa', '老板手写', 'owner:test');
  expect(mine.state).toBe('active');
  const seed = await notes.add('gamma:qa', '种子经验', 'seed', { proposed: true });
  expect(await texts('gamma:qa')).toEqual(['老板手写']);
  await notes.settle();
  expect(await texts('gamma:qa')).toEqual(['老板手写']); // No source task: only the owner activates it.
  await notes.activate(seed.id);
  expect(await texts('gamma:qa')).toEqual(['种子经验', '老板手写']);
  await notes.edit(seed.id, '种子经验改');
  await notes.remove(mine.id);
  expect(await texts('gamma:qa')).toEqual(['种子经验改']);
  await expect(notes.activate(seed.id)).rejects.toMatchObject({ code: 'conflict' });

  for (let i = 0; i < 200; i++) await db.db.query(`CREATE lane_note CONTENT { lane: 'full:engineering', text: $t, state: 'active', author: 'fixture', pinned: false, created_at: time::now(), updated_at: time::now() };`, { t: `经验 ${i}` });
  await expect(notes.add('full:engineering', '放不下', 'owner:test')).rejects.toThrow('上限');
  const done = await core.createTask(gm, { title: '满线的任务', context: 'fixture', executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: key() } as never);
  await db.db.query(`UPDATE $t SET state = 'done';`, { t: new RecordId('task', done.id) });
  await notes.propose('full:engineering', done.id, 'execute', ['排队经验'], 'fixture');
  expect((await notes.settle()).fullLanes).toEqual(['full:engineering']);
  expect((await notes.list('full:engineering')).find(n => n.text === '排队经验')?.state).toBe('proposed');
});

run('a route template reaches the task drafts, with the notes pointer added', async () => {
  await saveRoute(db.db, { type: 'lane-tpl', label: 'tpl', executor_role: 'engineering', reviewer_role: 'qa', code: false, execute_body: '按模板执行 task.md', review_body: '先读 notes.md 再按模板复核', hold: false, enabled: true }, 'test');
  const t = await core.createTask(gm, { type: 'lane-tpl', title: '模板任务', context: 'fixture', idempotencyKey: key() } as never);
  const [rows] = await db.db.query<[Array<{ step: string; body: string }>]>('SELECT step, body FROM outbound_message WHERE task = $t;', { t: new RecordId('task', t.id) });
  expect(rows.find(r => r.step === 'execute')?.body).toBe('先读 notes.md。按模板执行 task.md');
  expect(rows.find(r => r.step === 'review')?.body).toBe('先读 notes.md 再按模板复核');
});
