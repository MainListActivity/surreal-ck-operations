import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordId } from 'surrealdb';
import { CompanyDatabase } from '../src/database.ts';
import { SurrealCompanyCore } from '../src/core.ts';
import { LocalEnrollmentAdmin } from '../src/enrollment.ts';
import { ownerApi } from '../src/owner-api.ts';
import { OwnerDesk } from '../src/owner.ts';
import { Workforce } from '../src/workforce.ts';
import { OutboundMessageStore } from '../src/outbound-messages.ts';
import { readBoardTask, writeBoardView } from '../src/board.ts';
import { answerBytes, RESPONSE_BUDGET_BYTES } from '../src/response-budget.ts';

// board.task on a real company fork: the queued/read paths run the same SurrealQL the gateway runs, so a bad
// statement fails here instead of reaching production. No production data, credentials or dispatcher.
const run = process.env.RUN_SCK_OWNER_COMMANDS_TESTS === '1' ? test : test.skip;
setDefaultTimeout(60000);
let dir: string, server: ReturnType<typeof Bun.spawn>, db: CompanyDatabase, core: SurrealCompanyCore, gm: string, count = 0;
let ctx: Parameters<typeof ownerApi>[0];

beforeAll(async () => {
  if (process.env.RUN_SCK_OWNER_COMMANDS_TESTS !== '1') return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'sck-board-task-')));
  const listener = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('fixture') });
  const port = listener.port!; listener.stop(true);
  server = Bun.spawn([join(homedir(), '.surrealdb/surreal'), 'start', '--bind', `127.0.0.1:${port}`, '--user', 'root', '--pass', 'fixture-only', '--log', 'error', `rocksdb:${dir}/db`], { stdout: 'ignore', stderr: 'ignore' });
  for (let n = 0; n < 160; n++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch {} await Bun.sleep(25); }
  db = new CompanyDatabase({ url: `ws://127.0.0.1:${port}/rpc`, rootUser: 'root', rootPassword: 'fixture-only', namespace: 'board_task_fixture', database: 'control_plane' });
  await db.connect(); await db.bootstrap();
  core = new SurrealCompanyCore(db);
  gm = await new LocalEnrollmentAdmin(db).enroll('board-task-gm', 'owner', ['execute', 'review', 'manage']);
  ctx = { db, core: core as never, owner: new OwnerDesk(db), workforce: new Workforce(db), messages: new OutboundMessageStore(db.db), opsRepo: dir,
    now: () => NOW };
});
afterAll(async () => { if (!dir) return; await db.close(); server.kill(); await server.exited; rmSync(dir, { recursive: true, force: true }); });

const key = () => `board-task-${++count}-${crypto.randomUUID()}`;
const task = (extra: Record<string, unknown> = {}) => core.createTask(gm, { title: `Board task ${++count}`, context: 'fixture', executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: key(), ...extra } as never);
const NOW = 1_900_000_000_000;

run('board.task reads a queued task with its real position and a leased task with its holder, all inside the relay budget', async () => {
  const queued = await task();
  const held = await task();
  const doing = await task();
  await db.db.query("CREATE employee:`fixture-eng` CONTENT { role: 'engineering', def: employee_def:`fixture-eng-def` };");
  await db.db.query('CREATE employee_def:`fixture-eng-def` CONTENT { role: "engineering" };')
    .catch(() => undefined);
  await db.db.query("UPDATE $t SET state = 'doing', current_employee = 'fixture-eng', lease_expires_at = $until;", { t: new RecordId('task', doing.id), until: Math.floor(NOW / 1000) + 600 });
  const [claim] = await db.db.query<[Array<{ id: RecordId }>]>(
    "CREATE audit CONTENT { task: $t, actor: 'employee:fixture-eng', action: 'claim', evidence: '领取任务', at: time::now() } RETURN id;",
    { t: new RecordId('task', doing.id) });
  expect(claim?.[0]).toBeDefined();

  await writeBoardView(db.db, {
    at: NOW - 10_000,
    env: { sckBin: '/sck', opsRepo: dir },
    queue: [
      { taskId: queued.id, title: '队列任务', phase: 'execute', role: 'engineering', blocked: false, eligible: true, body: '依赖已解锁，等待派工' },
      { taskId: held.id, title: '门槛任务', phase: 'execute', role: 'engineering', blocked: true, eligible: false, body: '全员配额耗尽' },
      { taskId: 'gone', title: '已完成任务', phase: 'execute', role: 'engineering', blocked: false, eligible: true, body: '依赖已解锁，等待派工' },
    ],
    employees: { 'fixture-eng': { commDir: '/comm/fixture-eng', next: [{ taskId: queued.id, title: '队列任务', phase: 'execute', eligible: true, body: '可接' }] } },
  });

  const status = await readBoardTask(db.db, queued.id, { now: NOW });
  expect(status).toBeDefined();
  // The completed task dropped out of the queue between snapshot and read, so positions renumber like the board.
  expect(status!.queue).toMatchObject({ position: 1, of: 2, blocked: false, eligible: true });
  expect(status!.waiting).toMatchObject({ on: 'scheduler', kind: 'queued' });
  expect(status!.scheduler).toMatchObject({ at: NOW - 10_000, stale: false });
  expect(status!.candidates).toEqual([{ employeeId: 'fixture-eng', position: 1, eligible: true, reason: '排在第 1 位，可接' }]);

  const gated = await readBoardTask(db.db, held.id, { now: NOW });
  expect(gated!.queue).toMatchObject({ position: 2, blocked: true, eligible: false });
  expect(gated!.waiting.kind).toBe('gate');

  const leased = await readBoardTask(db.db, doing.id, { now: NOW });
  expect(leased!.holder).toMatchObject({ employeeId: 'fixture-eng', leaseActive: true, phase: 'execute' });
  expect(leased!.waiting).toMatchObject({ on: 'employee', kind: 'lease' });

  // The owner API answers the same status, inside the relay's 48 KiB budget, with no task text or message body. Its clock is the
  // server's (ctx.now); a caller cannot set it.
  const viaApi = await ownerApi(ctx, { command: 'board.task', taskId: queued.id, now: NOW + 3_600_000 }, 'agent') as Record<string, unknown>;
  expect(viaApi).toMatchObject({ taskId: queued.id, state: 'ready', scheduler: { at: NOW - 10_000, ageMs: 10_000, stale: false } });
  expect(answerBytes(viaApi)).toBeLessThan(RESPONSE_BUDGET_BYTES);
  await expect(ownerApi(ctx, { command: 'board.task', taskId: 'missing' }, 'agent')).rejects.toMatchObject({ code: 'not_found' });
});
