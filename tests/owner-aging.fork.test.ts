import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordId } from 'surrealdb';
import { CompanyDatabase } from '../src/database.ts';
import { SurrealCompanyCore } from '../src/core.ts';
import { LocalEnrollmentAdmin } from '../src/enrollment.ts';
import { OwnerDesk } from '../src/owner.ts';
import { DEFAULT_CONFIG } from '../src/workforce.ts';
import { Dispatcher } from '../src/dispatcher/dispatcher.ts';
import { localDate } from '../src/owner-brief.ts';
import type { ClaimResult, LeaseProof, TaskView } from '../src/contracts.ts';

setDefaultTimeout(60000);
// Isolated company fork on a private RocksDB store: no production data, credentials or dispatcher.
const run = process.env.RUN_SCK_OWNER_AGING_TESTS === '1' ? test : test.skip;
let dir: string, server: ReturnType<typeof Bun.spawn>, db: CompanyDatabase, core: SurrealCompanyCore, owner: OwnerDesk;
let gm: string, eng: string, count = 0, goal: RecordId;
const hours = (h: number) => new Date(Date.now() - h * 3_600_000);

beforeAll(async () => {
  if (process.env.RUN_SCK_OWNER_AGING_TESTS !== '1') return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'sck-owner-aging-')));
  const listener = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('fixture') });
  const port = listener.port!; listener.stop(true);
  server = Bun.spawn([join(homedir(), '.surrealdb/surreal'), 'start', '--bind', `127.0.0.1:${port}`, '--user', 'root', '--pass', 'fixture-only', '--log', 'error', `rocksdb:${dir}/db`], { stdout: 'ignore', stderr: 'ignore' });
  for (let n = 0; n < 160; n++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch {} await Bun.sleep(25); }
  db = new CompanyDatabase({ url: `ws://127.0.0.1:${port}/rpc`, rootUser: 'root', rootPassword: 'fixture-only', namespace: 'owner_aging_fixture', database: 'control_plane' });
  await db.connect(); await db.bootstrap();
  core = new SurrealCompanyCore(db); owner = new OwnerDesk(db);
  const admin = new LocalEnrollmentAdmin(db);
  gm = await admin.enroll('aging-gm', 'owner', ['execute', 'review', 'manage']);
  eng = await admin.enroll('aging-eng', 'engineering', ['execute', 'review']);
  const [rows] = await db.db.query<[Array<{ id: RecordId }>]>("CREATE goal CONTENT { title: '两位律师试用', brief: 'fixture', state: 'active', source: 'fixture', note: '', tasks: {}, anchors: [], created_at: time::now() } RETURN AFTER;");
  goal = rows[0]!.id;
});
afterAll(async () => { if (!dir) return; await db.close(); server.kill(); await server.exited; rmSync(dir, { recursive: true, force: true }); });

const proofOf = (c: ClaimResult): LeaseProof => ({ taskId: c.task.id, deliveryId: c.deliveryId, fence: c.fence, expectedVersion: c.task.version });
const make = (title: string, extra: Record<string, unknown> = {}) => core.createTask(gm, { title, context: 'aging fixture', executorRole: 'engineering', reviewerRole: 'qa', goalId: String(goal.id), idempotencyKey: `aging-task-${++count}`, ...extra } as never);
const backdate = (task: TaskView, action: string, h: number) =>
  db.db.query('UPDATE audit SET at = $at WHERE task = $task AND action = $action;', { at: hours(h), task: new RecordId('task', task.id), action });
const evidence = () => ({ text: 'fixture evidence long enough to be accepted by the task service validation', idempotencyKey: `aging-evidence-${++count}` });
async function gateTask(title: string) { const t = await make(title, { reviewerRole: 'owner' }); const c = await core.claim(eng, t.id); await core.submit(eng, proofOf(c), evidence()); return t; }
async function questionTask(title: string) { const t = await make(title); const c = await core.claim(eng, t.id); await core.block(eng, proofOf(c), 'owner', evidence()); return t; }
const dispatcher = (notified: string[]) => {
  const d = new Dispatcher({ workforce: { config: async () => DEFAULT_CONFIG, defs: async () => [{ role: 'engineering', provider: 'codex', enabled: true }], providerHealth: async () => new Map() } as never, quota: async () => [{ provider: 'codex', lowestPct: 0, fetchedAt: new Date().toISOString() }] as never, owner, paseo: {} as never, env: {} as never, notify: async (_title, text) => { notified.push(text); } });
  return d as unknown as { ownerAging(now: number, report: { notices: string[] }): Promise<void>; dailyBrief(now: number, cfg: typeof DEFAULT_CONFIG, report: { notices: string[] }): Promise<void> };
};

run('waiting items report how long they wait and which downstream tasks they hold up', async () => {
  const gate = await gateTask('最终验收'); await backdate(gate, 'submit', 30);
  const second = await make('收尾任务', { dependencies: [gate.id] }); await make('上线任务', { dependencies: [second.id] });
  const question = await questionTask('客户反馈如何收集'); await backdate(question, 'block', 5);
  const items = await owner.waitingOnOwner();
  const byId = new Map(items.map(i => [i.taskId, i]));
  expect(byId.get(gate.id)).toMatchObject({ kind: 'gate', goal: '两位律师试用', downstream: 2 });
  expect(Date.now() - byId.get(gate.id)!.sinceMs).toBeGreaterThan(29.9 * 3_600_000);
  expect(byId.get(question.id)).toMatchObject({ kind: 'question', downstream: 0 });
  expect((Date.now() - byId.get(question.id)!.sinceMs) / 3_600_000).toBeCloseTo(5, 0);
});

run('aging raises one reminder per level, forces a popup from 24h, and clears once the owner decides', async () => {
  const notified: string[] = []; const report = { notices: [] as string[] }; const d = dispatcher(notified);
  const now = Math.floor(Date.now() / 1000);
  await d.ownerAging(now, report);
  const keys = (await owner.openNotices()).filter(n => n.key.startsWith('aging:'));
  expect(keys.some(k => k.key.endsWith(':2') && k.text.includes('最终验收') && k.text.includes('卡住下游 2 个任务'))).toBe(true);
  expect(keys.some(k => k.key.endsWith(':1') && k.text.includes('客户反馈如何收集'))).toBe(true);
  expect(notified.some(t => t.includes('最终验收'))).toBe(true);
  const before = notified.length; await d.ownerAging(now + 301, report);
  expect(notified.length).toBe(before);
  const gate = (await owner.inbox()).gates.find(g => g.task.title === '最终验收')!;
  await owner.decide({ taskId: gate.task.id, decision: 'approve', note: 'ok', source: 'test', key: 'aging-approve' });
  await d.ownerAging(now + 700, report);
  expect((await owner.openNotices()).some(n => n.key.startsWith('aging:') && n.text.includes('最终验收'))).toBe(false);
});

run('the daily brief flags stuck work, is sent once per day and survives a restart', async () => {
  const done = await make('前置任务'); const c = await core.claim(eng, done.id); await core.submit(eng, proofOf(c), evidence());
  await db.db.query("UPDATE $t SET state = 'done';", { t: new RecordId('task', done.id) });
  const orphan = await make('依赖已完成却仍 blocked', { dependencies: [done.id] });
  await db.db.query("UPDATE $t SET state = 'blocked';", { t: new RecordId('task', orphan.id) });
  const idle = await make('没人领的活'); await backdate(idle, 'create', 3);
  const notified: string[] = []; const report = { notices: [] as string[] };
  const now = Math.floor(Date.now() / 1000), cfg = { ...DEFAULT_CONFIG, ownerBriefHour: 0 };
  await dispatcher(notified).dailyBrief(now, cfg, report);
  const brief = (await owner.openNotices()).find(n => n.key === `brief:${localDate(new Date(now * 1000))}`)!;
  for (const part of ['每日简报', '【异常卡滞】', '依赖已完成却仍 blocked', '依赖都已完成', '没人领的活', '就绪 1', 'engineering：当前没有任何可用编制（codex 额度不足', '【员工流动】近24小时新建实例']) expect(brief.text).toContain(part);
  expect(notified).toHaveLength(1); expect(notified[0]).toStartWith('每日简报'); expect(notified[0]).not.toContain('\n');
  await dispatcher(notified).dailyBrief(now + 60, cfg, report);
  expect(notified).toHaveLength(1);
  await dispatcher(notified).dailyBrief(now, { ...cfg, ownerBriefHour: -1 }, report);
  expect((await owner.openNotices()).filter(n => n.key.startsWith('brief:'))).toHaveLength(1);
});
