import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordId } from 'surrealdb';
import { CompanyDatabase } from '../src/database.ts';
import { SurrealCompanyCore } from '../src/core.ts';
import { LocalEnrollmentAdmin } from '../src/enrollment.ts';
import { OwnerDesk } from '../src/owner.ts';

setDefaultTimeout(60000);
// Isolated company fork on a private RocksDB store: no production data, credentials or dispatcher.
const run = process.env.RUN_SCK_OWNER_COMMANDS_TESTS === '1' ? test : test.skip;
let dir: string, server: ReturnType<typeof Bun.spawn>, db: CompanyDatabase, core: SurrealCompanyCore, owner: OwnerDesk, gm: string, count = 0;

beforeAll(async () => {
  if (process.env.RUN_SCK_OWNER_COMMANDS_TESTS !== '1') return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'sck-owner-commands-')));
  const listener = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('fixture') });
  const port = listener.port!; listener.stop(true);
  server = Bun.spawn([join(homedir(), '.surrealdb/surreal'), 'start', '--bind', `127.0.0.1:${port}`, '--user', 'root', '--pass', 'fixture-only', '--log', 'error', `rocksdb:${dir}/db`], { stdout: 'ignore', stderr: 'ignore' });
  for (let n = 0; n < 160; n++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch {} await Bun.sleep(25); }
  db = new CompanyDatabase({ url: `ws://127.0.0.1:${port}/rpc`, rootUser: 'root', rootPassword: 'fixture-only', namespace: 'owner_commands_fixture', database: 'control_plane' });
  await db.connect(); await db.bootstrap();
  core = new SurrealCompanyCore(db); owner = new OwnerDesk(db);
  gm = await new LocalEnrollmentAdmin(db).enroll('commands-gm', 'owner', ['execute', 'review', 'manage']);
});
afterAll(async () => { if (!dir) return; await db.close(); server.kill(); await server.exited; rmSync(dir, { recursive: true, force: true }); });

const key = () => `owner-cmd-${++count}-${crypto.randomUUID()}`;
const task = (extra: Record<string, unknown> = {}) => core.createTask(gm, { title: `Command task ${++count}`, context: 'fixture', executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: key(), ...extra } as never);
const state = async (id: string) => (await core.getTask(gm, id)).state;
run('void retires a task, voids its planned descendants, is idempotent, and refuses finished work', async () => {
  const a = await task(), b = await task({ parent: a.id });
  expect(await state(b.id)).toBe('planned');
  const k = key();
  const voided = await owner.retire({ taskId: a.id, note: '方向变了，不需要了', source: 'owner:test', key: k });
  expect(voided.state).toBe('void'); expect(await state(b.id)).toBe('void');
  expect((await owner.retire({ taskId: a.id, note: '方向变了，不需要了', source: 'owner:test', key: k })).version).toBe(voided.version);
  await db.db.query("UPDATE $t SET state = 'done';", { t: new RecordId('task', b.id) });
  await expect(owner.retire({ taskId: b.id, note: '已经完成的不能作废', source: 'owner:test', key: key() })).rejects.toMatchObject({ code: 'conflict' });
});

run('revoke releases the live lease back to ready with owner provenance; no-ops without a lease', async () => {
  const { Workforce } = await import('../src/workforce.ts');
  const wf = new Workforce(db);
  const a = await task();
  await db.db.query("CREATE employee:`fixture-worker` CONTENT { role: 'engineering', active_task: $t };", { t: new RecordId('task', a.id) });
  await db.db.query("UPDATE $t SET state = 'doing', current_employee = 'fixture-worker', lease_expires_at = time::unix(time::now()) + 3600;", { t: new RecordId('task', a.id) });
  const r = await wf.revokeTaskLease(a.id, '老板终止在途执行', '【交接包】', 'owner:test');
  expect(r).toEqual({ ok: true, employee: 'fixture-worker' });
  const [t] = await db.db.query<[Array<{ state: string; current_employee?: string; previous_employee?: string; handover?: boolean }>]>('SELECT state, current_employee, previous_employee, handover FROM task WHERE id = $t;', { t: new RecordId('task', a.id) });
  expect(t[0]).toMatchObject({ state: 'ready', current_employee: undefined, previous_employee: 'fixture-worker', handover: true });
  const [e] = await db.db.query<[Array<{ active_task?: unknown }>]>('SELECT active_task FROM employee WHERE id = employee:`fixture-worker`;');
  expect(e[0]!.active_task).toBeUndefined();
  const [audit] = await db.db.query<[Array<{ action: string; actor: unknown }>]>("SELECT action, actor FROM audit WHERE task = $t AND action = 'revoked';", { t: new RecordId('task', a.id) });
  expect(audit[0]).toMatchObject({ action: 'revoked', actor: 'owner:test' });
  expect(await wf.revokeTaskLease(a.id, '再撤一次', '', 'owner:test')).toEqual({ ok: false });
});

