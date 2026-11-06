import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompanyDatabase } from '../src/database.ts';
import { SurrealCompanyCore } from '../src/core.ts';
import { LocalEnrollmentAdmin } from '../src/enrollment.ts';
import { OwnerDesk } from '../src/owner.ts';
import { DEFAULT_CONFIG } from '../src/workforce.ts';
import { Dispatcher, type TickReport } from '../src/dispatcher/dispatcher.ts';
import type { LeaseProof, TaskView } from '../src/contracts.ts';

setDefaultTimeout(60000);
// Isolated company fork on a private RocksDB store: no production data, credentials or dispatcher.
const run = process.env.RUN_SCK_LOOP_BREAKER_TESTS === '1' ? test : test.skip;
let dir: string, server: ReturnType<typeof Bun.spawn>, db: CompanyDatabase, core: SurrealCompanyCore, owner: OwnerDesk, gm: string, eng: string, count = 0;

beforeAll(async () => {
  if (process.env.RUN_SCK_LOOP_BREAKER_TESTS !== '1') return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'sck-loop-breaker-')));
  const listener = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('fixture') });
  const port = listener.port!; listener.stop(true);
  server = Bun.spawn([join(homedir(), '.surrealdb/surreal'), 'start', '--bind', `127.0.0.1:${port}`, '--user', 'root', '--pass', 'fixture-only', '--log', 'error', `rocksdb:${dir}/db`], { stdout: 'ignore', stderr: 'ignore' });
  for (let n = 0; n < 160; n++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch {} await Bun.sleep(25); }
  db = new CompanyDatabase({ url: `ws://127.0.0.1:${port}/rpc`, rootUser: 'root', rootPassword: 'fixture-only', namespace: 'loop_breaker_fixture', database: 'control_plane' });
  await db.connect(); await db.bootstrap();
  core = new SurrealCompanyCore(db); owner = new OwnerDesk(db);
  const admin = new LocalEnrollmentAdmin(db);
  gm = await admin.enroll('loop-gm', 'owner', ['execute', 'review', 'manage']);
  eng = await admin.enroll('loop-eng', 'engineering', ['execute', 'review']);
});
afterAll(async () => { if (!dir) return; await db.close(); server.kill(); await server.exited; rmSync(dir, { recursive: true, force: true }); });

const text = (what: string) => ({ text: `${what} — long enough to satisfy the evidence validation`, idempotencyKey: `loop-ev-${++count}-${crypto.randomUUID()}` });
const proofOf = (c: { task: TaskView; deliveryId: string; fence: number }): LeaseProof => ({ taskId: c.task.id, deliveryId: c.deliveryId, fence: c.fence, expectedVersion: c.task.version });
const newTask = () => core.createTask(gm, { title: `Looping task ${++count}`, context: 'fixture', executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: `loop-task-${++count}-${crypto.randomUUID()}` } as never);
/** One round trip: the employee blocks on the manager. The manager resumes it unless this is the last round. */
async function bounce(taskId: string, round: number, resume: boolean) {
  const claim = await core.claim(eng, taskId);
  await core.block(eng, proofOf(claim), 'owner', text(`第 ${round} 次阻塞：WS 连接 1006 无事件`));
  if (resume) await core.resume(gm, taskId, text(`经理第 ${round} 次回复`));
}
const breaker = () => new Dispatcher({ workforce: {} as never, owner, paseo: {} as never, env: {} as never, log: () => {} }) as unknown as
  { breakLoop(task: { id: string; version: number }, cfg: typeof DEFAULT_CONFIG, report: TickReport): Promise<boolean> };
const report = () => ({ decisions: [] as string[] } as TickReport);

run('a task that keeps bouncing between employee and manager goes to the owner with the recent reasons', async () => {
  const t = await newTask();
  await bounce(t.id, 1, true); await bounce(t.id, 2, true); await bounce(t.id, 3, false);
  const loops = await owner.blockLoops(t.id);
  expect(loops.loops).toBe(3); expect(loops.reasons[0]).toContain('第 3 次阻塞');
  const current = await core.getTask(gm, t.id); expect(current).toMatchObject({ state: 'blocked', blockedTo: 'owner' });
  const r = report();
  expect(await breaker().breakLoop(current, { ...DEFAULT_CONFIG, blockLoopLimit: 4 }, r)).toBe(false);
  expect(await breaker().breakLoop(current, { ...DEFAULT_CONFIG, blockLoopLimit: 0 }, r)).toBe(false);
  expect((await core.getTask(gm, t.id)).blockedTo).toBe('owner');
  expect(await breaker().breakLoop(current, { ...DEFAULT_CONFIG, blockLoopLimit: 3 }, r)).toBe(true);
  expect(r.decisions).toEqual([`escalate-loop:${t.id}`]);
  expect(await core.getTask(gm, t.id)).toMatchObject({ state: 'blocked', blockedTo: 'owner' });
  const question = (await owner.inbox()).questions.find(q => q.task.id === t.id)!;
  expect(question.question).toContain('往返 3 次'); expect(question.question).toContain('第 3 次阻塞'); expect(question.question).toContain('第 1 次阻塞');
  expect((await owner.waitingOnOwner()).find(i => i.taskId === t.id)).toMatchObject({ kind: 'question' });
  expect(await breaker().breakLoop(current, { ...DEFAULT_CONFIG, blockLoopLimit: 3 }, report())).toBe(false);
});

run('the owner answering resets the count so the task gets a fresh set of round trips', async () => {
  const t = await newTask();
  await bounce(t.id, 1, true); await bounce(t.id, 2, false);
  expect(await breaker().breakLoop(await core.getTask(gm, t.id), { ...DEFAULT_CONFIG, blockLoopLimit: 2 }, report())).toBe(true);
  await owner.decide({ taskId: t.id, decision: 'reply', note: '换个思路：先只验证聊天路径，行分析另开任务', source: 'owner:test', key: `loop-reply-${count++}` });
  expect(await core.getTask(gm, t.id)).toMatchObject({ state: 'doing', blockedTo: undefined });
  expect((await owner.blockLoops(t.id)).loops).toBe(0);
  await bounce(t.id, 3, false);
  expect(await breaker().breakLoop(await core.getTask(gm, t.id), { ...DEFAULT_CONFIG, blockLoopLimit: 2 }, report())).toBe(false);
});
