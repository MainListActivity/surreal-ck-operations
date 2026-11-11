import { expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordId } from 'surrealdb';
import { CompanyDatabase } from '../src/database.ts';
import { SurrealCompanyCore } from '../src/core.ts';
import { LocalEnrollmentAdmin } from '../src/enrollment.ts';
import { readBoard, renderContextFor, writeBoardView, type BoardView, type OwnerBoard } from '../src/board.ts';
import { OutboundMessageStore } from '../src/outbound-messages.ts';
import { dispatchText, renderMessage } from '../src/outbound-render.ts';

// 老板看板的消息数据在真实公司 fork 上的验证：全部未发消息（messages）、排队项的草稿（unassigned[].message）、
// 员工卡片的译文状态（outbox[].translation：缺译、已译、原文已改、语言不同、没有语言）。只读，不写看板之外的状态。
const run = process.env.RUN_SCK_CHANNEL_FORK_TESTS === '1' ? test : test.skip;
const ROOT_PASSWORD = 'isolated-board-messages-test-only';
const SCK = '/fixture/sck';
setDefaultTimeout(120_000);

async function startFork(name: string) {
  const dir = mkdtempSync(join(tmpdir(), `board-messages-${name}-`));
  const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('fixture') });
  const port = reservation.port!; reservation.stop(true);
  const child = Bun.spawn([join(homedir(), '.surrealdb/surreal'), 'start', '--bind', `127.0.0.1:${port}`, '--user', 'root', '--pass', ROOT_PASSWORD,
    '--log', 'error', `rocksdb:${dir}/database`], { stdout: 'ignore', stderr: 'ignore' });
  const db = new CompanyDatabase({ url: `ws://127.0.0.1:${port}/rpc`, rootUser: 'root', rootPassword: ROOT_PASSWORD,
    namespace: `isolated_board_messages_${name.replaceAll('-', '_')}`, database: 'control_plane' });
  const close = async () => { await db.close(); child.kill(); await child.exited; rmSync(dir, { recursive: true, force: true }); };
  try {
    let ready = false;
    for (let n = 0; n < 100; n++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) { ready = true; break; } } catch {} await Bun.sleep(25); }
    expect(ready).toBe(true);
    await db.connect(); await db.bootstrap();
    const core = new SurrealCompanyCore(db);
    const gm = await new LocalEnrollmentAdmin(db).enroll('fixture-owner-board-messages', 'owner', ['execute', 'review', 'manage']);
    return { dir, db, surreal: db.db, core, gm, close };
  } catch (error) {
    await close();
    throw error;
  }
}

type Fork = Awaited<ReturnType<typeof startFork>>;

const nowSec = () => Math.floor(Date.now() / 1000);

run('owner board messages: every unsent message, queued drafts, and the holder and outbox translation states', async () => {
  const w = await startFork('board');
  try {
    const create = (title: string, key: string) => w.core.createTask(w.gm, { title, context: '合成数据：仅用于看板消息回归测试',
      executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: key });
    const holder = await create('Board Message A', 'board-messages-a');
    const queued = await create('Board Message B', 'board-messages-b');
    const bare = await create('Board Message C', 'board-messages-c');
    const finished = await create('Board Message D', 'board-messages-d');
    const store = new OutboundMessageStore(w.surreal);
    for (const task of [holder, queued, finished]) await store.createTaskDrafts(task.id, 'engineering', 'qa', false);
    // C has no draft at all; D is done (closed) but still holds unsent messages.
    await w.surreal.query('DELETE outbound_message WHERE task = $task;', { task: new RecordId('task', bare.id) });
    await w.surreal.query("UPDATE $task SET state = 'done';", { task: new RecordId('task', finished.id) });

    // Employees: emp_ja speaks Japanese, emp_plain has no language. emp_ja holds task A.
    await w.surreal.query("CREATE employee:emp_ja CONTENT { role: 'engineering', paseo_agent_id: 'agent-emp-ja', lane: 'company:engineering' };");
    await w.surreal.query("CREATE employee:emp_plain CONTENT { role: 'engineering', paseo_agent_id: 'agent-emp-plain', lane: 'company:engineering' };");
    await w.surreal.query("CREATE agent_policy CONTENT { agent: 'emp_ja', lang: 'ja', updated_by: 'owner:test' };");
    await w.surreal.query("UPDATE $task SET current_employee = $emp, state = 'doing', lease_expires_at = $exp;",
      { task: new RecordId('task', holder.id), emp: new RecordId('employee', 'emp_ja'), exp: nowSec() + 600 });

    // The queue: B has a draft, C has none. Both wait for the employees' next rows; B is in both employees' next lists.
    const view: BoardView = {
      at: Date.now(), env: { sckBin: SCK, opsRepo: w.dir },
      queue: [
        { taskId: queued.id, title: 'Board Message B', phase: 'execute', role: 'engineering', blocked: false, eligible: true, body: '' },
        { taskId: bare.id, title: 'Board Message C', phase: 'execute', role: 'engineering', blocked: false, eligible: true, body: '' },
      ],
      employees: {
        emp_ja: { commDir: '/comm/emp_ja', next: [{ taskId: queued.id, title: 'Board Message B', phase: 'execute', eligible: true, body: '' }] },
        emp_plain: { commDir: '/comm/emp_plain', next: [{ taskId: queued.id, title: 'Board Message B', phase: 'execute', eligible: true, body: '' }] },
      },
    };
    await writeBoardView(w.surreal, view);

    const unsentOf = async (taskId: string) => store.list(taskId, false);
    const aExecute = (await unsentOf(holder.id)).find(m => m.step === 'execute')!;
    const aReview = (await unsentOf(holder.id)).find(m => m.step === 'review')!;
    const bExecute = (await unsentOf(queued.id)).find(m => m.step === 'execute')!;

    // 1. Before any translation: the messages list has every unsent message (A, B, D), the holder's translation is missing, the queued
    //    item shows its stored draft with no employee, and emp_plain's row has no translation at all.
    let board: OwnerBoard = await readBoard(w.surreal, { now: Date.now() });
    const unsentIds = (await w.surreal.query<[Array<{ id: unknown }>]>("SELECT id FROM outbound_message WHERE state != 'sent';"))[0]!
      .map(row => String((row.id as { id: unknown }).id));
    expect(board.messages.map(m => m.messageId).sort()).toEqual([...unsentIds].sort());
    expect(board.messages.length).toBe(6);
    expect(board.messages.some(m => m.taskId === finished.id)).toBe(true);
    const titles = board.messages.map(m => m.title);
    expect(titles).toEqual([...titles].sort());

    const holderExecute = board.messages.find(m => m.messageId === aExecute.id)!;
    expect(holderExecute).toMatchObject({ employeeId: 'emp_ja', state: 'draft', hold: false, editable: true });
    // 没选过语言的消息跟着收件员工走：emp_ja 的默认语言是日语。
    expect(holderExecute.lang).toBe('ja');
    expect(holderExecute.translation).toEqual({ lang: 'ja', status: 'missing' });
    const queuedRow = board.messages.find(m => m.messageId === bExecute.id)!;
    expect(queuedRow.employeeId).toBeUndefined();
    expect(queuedRow.translation).toBeUndefined();

    const unassignedB = board.unassigned.find(row => row.taskId === queued.id)!;
    expect(unassignedB.message).toMatchObject({ messageId: bExecute.id, step: 'execute', body: bExecute.body, editable: true });
    expect(unassignedB.message!.employeeId).toBeUndefined();
    expect(unassignedB.message!.translation).toBeUndefined();
    expect(board.unassigned.find(row => row.taskId === bare.id)!.message).toBeUndefined();

    const outboxB = (id: string) => board.employees.find(row => row.id === id)!.outbox.find(row => row.taskId === queued.id)!;
    expect(outboxB('emp_ja').translation).toEqual({ lang: 'ja', status: 'missing' });
    expect('translation' in outboxB('emp_plain')).toBe(false);

    // 2. Translate A's execute message and B's execute message to Japanese, and A's review message to English.
    await store.setTranslation(aExecute.id, 'ja', 'JA-A 执行说明', aExecute.body, 'owner:test');
    await store.setTranslation(bExecute.id, 'ja', 'JA-B: task.md を読む', bExecute.body, 'owner:test');
    await store.setTranslation(aReview.id, 'en', 'EN review', aReview.body, 'owner:test');
    board = await readBoard(w.surreal, { now: Date.now() });
    expect(board.messages.find(m => m.messageId === aExecute.id)!.translation).toEqual({ lang: 'ja', status: 'ready', text: 'JA-A 执行说明' });
    // The message list shows the stored translation, unrendered; the employee's row shows the rendered dispatch text.
    expect(board.messages.find(m => m.messageId === aExecute.id)!.lang).toBe('ja');
    // A review translated to English is not Japanese: the holder sees it as missing.
    expect(board.messages.find(m => m.messageId === aReview.id)).toMatchObject({ lang: 'ja', translation: { lang: 'ja', status: 'missing' } });
    // The outbox shows the rendered translation: the comm dir is named the way a dispatch names it.
    const ctx = renderContextFor(view, 'emp_ja', { taskId: queued.id, step: 'execute', acceptanceCriteria: undefined })!;
    expect(outboxB('emp_ja').translation).toEqual({ lang: 'ja', status: 'ready', text: dispatchText(renderMessage('JA-B: task.md を読む', ctx)) });
    expect(outboxB('emp_ja').translation!.text).toBe('JA-B: /comm/emp_ja/task.md を読む');
    expect(outboxB('emp_plain').translation).toBeUndefined();
    // The queued item's own message keeps its stored body; the outbox keeps the rendered original body, as before.
    expect(board.unassigned.find(row => row.taskId === queued.id)!.message!.body).toBe(bExecute.body);

    // 3. The owner edits A's body: its translation is now stale, and the outbox of B goes stale on the same edit.
    await store.edit(aExecute.id, '改过的甲', 'owner:test');
    await store.edit(bExecute.id, '改过的乙', 'owner:test');
    board = await readBoard(w.surreal, { now: Date.now() });
    expect(board.messages.find(m => m.messageId === aExecute.id)!.translation).toEqual({ lang: 'ja', status: 'stale' });
    expect(outboxB('emp_ja').translation).toEqual({ lang: 'ja', status: 'stale' });
    expect(board.unassigned.find(row => row.taskId === queued.id)!.message!.body).toBe('改过的乙');

    // 4. A fresh translation of the edited body is ready again.
    await store.setTranslation(aExecute.id, 'ja', 'JA-A 改后', '改过的甲', 'owner:test');
    board = await readBoard(w.surreal, { now: Date.now() });
    expect(board.messages.find(m => m.messageId === aExecute.id)!.translation).toEqual({ lang: 'ja', status: 'ready', text: 'JA-A 改后' });

    // 5. Sent messages leave the board: sending A's execute message removes it from messages.
    await store.markSent(aExecute.id, 'emp_ja', 'JA-A 改后');
    board = await readBoard(w.surreal, { now: Date.now() });
    expect(board.messages.some(m => m.messageId === aExecute.id)).toBe(false);
    expect(board.messages.some(m => m.messageId === aReview.id)).toBe(true);
  } finally {
    await w.close();
  }
});

run('老板页内改消息：原文比较防覆盖、发送后拒绝、兼容原编辑入口', async () => {
  const w=await startFork('edit-cas');
  try {
    const task=await w.core.createTask(w.gm,{title:'消息编辑比较',context:'仅隔离测试',executorRole:'engineering',reviewerRole:'qa',idempotencyKey:'edit-cas'});
    const store=new OutboundMessageStore(w.surreal);
    await store.createTaskDrafts(task.id,'engineering','qa',false);
    const message=(await store.list(task.id,false)).find(m=>m.step==='execute')!;
    expect((await store.edit(message.id,'老板修订正文','owner:test',message.body)).body).toBe('老板修订正文');
    await expect(store.edit(message.id,'过期页面的修改','owner:test',message.body)).rejects.toMatchObject({code:'conflict'});
    expect((await store.get(message.id))?.body).toBe('老板修订正文');
    await store.edit(message.id,'旧入口修改仍有效','owner:test');
    await store.markSent(message.id,'fixture-employee','旧入口修改仍有效');
    await expect(store.edit(message.id,'发送后不能改','owner:test','旧入口修改仍有效')).rejects.toThrow();
    await expect(store.edit('missing','不存在','owner:test','old')).rejects.toMatchObject({code:'not_found'});
  } finally {await w.close();}
});
