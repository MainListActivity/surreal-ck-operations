import { expect, setDefaultTimeout, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordId } from 'surrealdb';
import { CompanyDatabase } from '../src/database.ts';
import { SurrealCompanyCore } from '../src/core.ts';
import { LocalEnrollmentAdmin } from '../src/enrollment.ts';
import { Workforce } from '../src/workforce.ts';
import { OutboundMessageStore } from '../src/outbound-messages.ts';

// 发件箱单草稿唯一性在真实公司 fork 上的回归：并发补稿不产生第二條未发送草稿；
// beginDispatchAttempt 事务内拒绝绕过扣住/老板已改正文的旧稿派发。
const run = process.env.RUN_SCK_CHANNEL_FORK_TESTS === '1' ? test : test.skip;
const ROOT_PASSWORD = 'isolated-outbound-draft-guard-test-only';
setDefaultTimeout(120_000);

async function startFork() {
  const dir = mkdtempSync(join(tmpdir(), 'outbound-draft-guard-'));
  const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('fixture') });
  const port = reservation.port!; reservation.stop(true);
  const child = Bun.spawn([join(homedir(), '.surrealdb/surreal'), 'start', '--bind', `127.0.0.1:${port}`, '--user', 'root', '--pass', ROOT_PASSWORD,
    '--log', 'error', `surrealkv:${dir}/database`], { stdout: 'ignore', stderr: 'ignore' });
  const config = { url: `ws://127.0.0.1:${port}/rpc`, rootUser: 'root', rootPassword: ROOT_PASSWORD,
    namespace: `outbound_draft_guard_${randomUUID().replaceAll('-', '')}`, database: 'control_plane' };
  const db = new CompanyDatabase(config), peers: CompanyDatabase[] = [];
  const close = async () => { await Promise.all([db, ...peers].map(db => db.close())); child.kill(); await child.exited; rmSync(dir, { recursive: true, force: true }); };
  try {
    let ready = false;
    for (let n = 0; n < 100; n++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) { ready = true; break; } } catch {} await Bun.sleep(25); }
    expect(ready).toBe(true);
    await db.connect(); await db.bootstrap();
    const core = new SurrealCompanyCore(db), wf = new Workforce(db), enrollment = new LocalEnrollmentAdmin(db);
    const owner = await enrollment.enroll('owner', 'owner', ['manage', 'execute', 'review']);
    const employee = await enrollment.enroll('synthetic', 'engineering', ['execute', 'review']);
    const peerStore = async () => {
      const peer = new CompanyDatabase(config); peers.push(peer); await peer.connect();
      await peer.db.use({ namespace: config.namespace, database: config.database });
      return new OutboundMessageStore(peer.db);
    };
    return { dir, db, surreal: db.db, core, wf, owner, employee, close, peerStore };
  } catch (error) {
    await close();
    throw error;
  }
}

type Fork = Awaited<ReturnType<typeof startFork>>;

const createTask = (w: Fork, title: string) => w.core.createTask(w.owner, { title, context: '合成数据：仅用于发件箱单草稿回归',
  executorRole: 'engineering', reviewerRole: 'qa', workIntent: { kind: 'read' }, idempotencyKey: randomUUID() });
const unsentOf = async (w: Fork, taskId: string, step = 'execute') => {
  const [rows] = await w.surreal.query<[Array<Record<string, unknown>>]>(
    "SELECT * FROM outbound_message WHERE task = $task AND step = $step AND state != 'sent';",
    { task: new RecordId('task', taskId), step });
  return rows ?? [];
};

run('并发补稿：同阶段已有扣住或老板改过正文的草稿时，ensureQueuedDrafts 绝不新建第二条，也不覆盖正文', async () => {
  const w = await startFork();
  try {
    const store = new OutboundMessageStore(w.surreal);

    // A. 老板扣住的草稿：并发补稿后仍只有一条，正文与 hold 原样。
    const heldTask = await createTask(w, 'Draft Guard Held');
    await store.createTaskDrafts(heldTask.id, 'engineering', 'qa', false);
    const heldDraft = (await unsentOf(w, heldTask.id)).find(row => row.step === 'execute')!;
    await store.setHold(String((heldDraft.id as { id: string }).id), true, 'owner:test');
    const heldBody = String(heldDraft.body);
    await Promise.all([store.ensureQueuedDrafts([heldTask.id]), store.ensureQueuedDrafts([heldTask.id])]);
    let rows = await unsentOf(w, heldTask.id);
    expect(rows.filter(row => row.step === 'execute')).toHaveLength(1);
    expect(rows[0]).toMatchObject({ body: heldBody, hold: true });

    // B. 老板改过正文的草稿：并发补稿不新建、不改写正文。
    const editedTask = await createTask(w, 'Draft Guard Edited');
    await store.createTaskDrafts(editedTask.id, 'engineering', 'qa', false);
    const editedDraft = (await unsentOf(w, editedTask.id)).find(row => row.step === 'execute')!;
    await store.edit(String((editedDraft.id as { id: string }).id), '老板自由改写的正文：先只做只读核对。', 'owner:test');
    await Promise.all([store.ensureQueuedDrafts([editedTask.id]), store.ensureQueuedDrafts([editedTask.id])]);
    rows = await unsentOf(w, editedTask.id);
    expect(rows.filter(row => row.step === 'execute')).toHaveLength(1);
    expect(rows[0]).toMatchObject({ body: '老板自由改写的正文：先只做只读核对。', body_edited: true });

    // C. 同阶段完全没有草稿：并发补稿只允许一条（事务守卫闭合竞态）。
    const emptyTask = await createTask(w, 'Draft Guard Empty');
    await w.surreal.query("DELETE outbound_message WHERE task = $task AND step = 'execute';", { task: new RecordId('task', emptyTask.id) });
    const callers = [store, ...await Promise.all(Array.from({ length: 3 }, () => w.peerStore()))];
    await Promise.all(Array.from({ length: 16 }, (_, i) => callers[i % callers.length]!.ensureQueuedDrafts([emptyTask.id])));
    rows = await unsentOf(w, emptyTask.id);
    expect(rows.filter(row => row.step === 'execute')).toHaveLength(1);
  } finally { await w.close(); }
});

run('beginDispatchAttempt 事务内核验：同阶段存在未发送的扣住/已改旧稿时立即拒绝派发', async () => {
  const w = await startFork();
  try {
    const store = new OutboundMessageStore(w.surreal);
    const task = await createTask(w, 'Dispatch Guard');
    const claim = await w.core.claim(w.employee, task.id);
    await store.createTaskDrafts(task.id, 'engineering', 'qa', false);
    const prepared = await store.prepareSend(task.id, 'execute', 'synthetic');
    expect(prepared).not.toBeNull();
    const body = prepared!.body;
    const input = { employee: 'synthetic', task: task.id, kind: 'spawn' as const, delivery: claim.deliveryId, fence: claim.fence,
      message: prepared!.message.id, body, bodyHash: createHash('sha256').update(body).digest('hex'),
      messageRevision: prepared!.message.dispatchRevision };

    // 独立覆盖 hold 与 body_edited，不能依赖两个标记同时存在。
    const rival = new RecordId('outbound_message', randomUUID());
    await w.surreal.query(`CREATE $rival CONTENT { task: $task, step: 'execute', role: 'engineering', body: '旧稿', state: 'held',
      hold: true, created_at: time::now() };`, { rival, task: new RecordId('task', task.id) });
    await expect(w.wf.beginDispatchAttempt({ ...input, request: randomUUID() })).rejects.toThrow(/dispatch draft conflict|failed transaction/);
    await w.surreal.query("UPDATE $rival SET hold = false;", { rival });
    await expect(w.wf.beginDispatchAttempt({ ...input, request: randomUUID() })).rejects.toThrow(/dispatch draft conflict|failed transaction/);
    await w.surreal.query("UPDATE $rival SET hold = false, state = 'draft', body_edited = true;", { rival });
    await expect(w.wf.beginDispatchAttempt({ ...input, request: randomUUID() })).rejects.toThrow(/dispatch draft conflict|failed transaction/);

    // 旧稿处理掉之后同一派发放行。
    await w.surreal.query("UPDATE $rival SET state = 'sent';", { rival });
    await w.wf.beginDispatchAttempt({ ...input, request: randomUUID() });
    expect(await w.wf.pendingDispatchAttempts()).toHaveLength(1);
  } finally { await w.close(); }
});