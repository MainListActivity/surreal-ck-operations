import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordId } from 'surrealdb';
import { CompanyDatabase } from '../src/database.ts';
import { SurrealCompanyCore } from '../src/core.ts';
import { LocalEnrollmentAdmin } from '../src/enrollment.ts';
import { isDuplicateNote, LaneNoteStore, NOTE_MAX_ACTIVE } from '../src/lane-notes.ts';
import { OutboundMessageStore } from '../src/outbound-messages.ts';
import { ownerApi } from '../src/owner-api.ts';
import { saveRoute } from '../src/routes.ts';
import { Workforce } from '../src/workforce.ts';

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

run('a returned attempt loses its executor lessons and the returning review\'s notes; a void task loses all', async () => {
  const t = await task('退回的任务', 'alpha');
  const c = await core.claim(eng, t.id);
  await core.submit(eng, proof(c), evidence({ learned: ['被否定的做法'] }));
  await core.returnTask(qa, proof(await core.claim(qa, t.id)), evidence({ learned: ['退回时的标准'] }));
  await notes.settle();
  const rework = await core.claim(eng, t.id);
  await core.submit(eng, proof(rework), evidence({ learned: ['返工后的做法'] }));
  await core.accept(qa, proof(await core.claim(qa, t.id)), evidence({ learned: ['通过时的标准'] }));
  await notes.settle();
  expect(await texts('alpha:engineering')).not.toContain('被否定的做法');
  expect(await texts('alpha:engineering')).toContain('返工后的做法');
  // 只有通过的那次 review 提出的笔记生效；退回那一轮的复核笔记直接丢弃。
  expect(await texts('alpha:qa')).not.toContain('退回时的标准');
  expect(await texts('alpha:qa')).toContain('通过时的标准');

  const dead = await task('作废的任务', 'alpha');
  await core.submit(eng, proof(await core.claim(eng, dead.id)), evidence({ learned: ['作废任务的经验'] }));
  await db.db.query(`UPDATE $t SET state = 'void';`, { t: new RecordId('task', dead.id) });
  expect((await notes.settle()).discarded).toBe(1);
  expect(await texts('alpha:engineering')).not.toContain('作废任务的经验');
});

run('a task approved after two returns keeps only the passing round\'s five notes per lane and fresh drafts', async () => {
  const project = 'rounds';
  await db.db.query(`CREATE project:rounds CONTENT { name: 'rounds', repo_path: '/tmp/rounds-fixture' };`);
  const t = await task('两次退回后通过', project);
  const occupiedEng = `${project}:engineering`;
  const occupiedQa = `${project}:qa`;
  const existingTree = '合入核对用树对比：合并提交的 tree 应与已验证 HEAD 的 tree 相同，并以远端主干为准。';
  const restatedScreenshot = '截图证据要晚于最后一次 UI 源提交，并对照提交的 HEAD 核对时间顺序。';
  const existingQa = '截图证据的时间必须晚于最后一次 UI 源提交，并与提交的 HEAD 对应。';
  const restatedQa = '截图证据要晚于最后一次 UI 源提交，并对照提交的 HEAD 核对时间顺序。';
  const dupExecute = '返工后的做法';
  const dupReview = '通过时的标准';
  await notes.add(occupiedEng, existingTree, 'owner:test', { pinned: true });
  await notes.add(occupiedEng, '截图证据的时间必须晚于最后一次 UI 源提交，并与提交的 HEAD 对应。', 'owner:test');
  await notes.add(occupiedQa, existingQa, 'owner:test', { pinned: true });
  const beforeEng = await notes.list(occupiedEng);
  const beforeQa = await notes.list(occupiedQa);
  const beforeIds = new Set([...beforeEng, ...beforeQa].map(note => note.id));
  // 每轮执行与复核各提 5 条；通过那一轮另含 2 条与已有笔记重复的样本（完全重复与换说法），断言它们不新增。
  const rounds = [
    { execute: ['先跑冒烟测试再改实现，避免带病返工', '报错先看堆栈最内层的故障点', '提交前确认工作树没有多余文件', '改动只碰任务授权的仓库路径', '复现问题先写最小用例'],
      review: ['日志写进任务证据后再排查，别只看终端', '并发问题先查共享状态的生命周期', '依赖升级先确认锁文件同步', '接口改动先搜全部调用方', '验收脚本要在干净环境重跑一次'] },
    { execute: ['合入前确认分支基于最新主干', '提交信息写清改动与验证方式', '最终提交上重跑完整测试', '发布说明按契约长度自查', '收尾删除临时脚本与产物'],
      review: ['验收第 1 条先看老板要的结果', '截图要与最终提交对应', '复验失败要写明具体命令', '退回意见按可执行步骤写', '核对变更文件清单'] },
  ];
  const passing = {
    execute: ['核对测试汇总行与失败名单', '检查版本号三处同步', '检查新增测试能在旧代码上失败', '确认没有生产安装动作', '确认证据链接可读'],
    review: ['复核通过也要留下关键证据', '对照验收标准逐条记录结论', '检查提交树与远程一致', '确认工作区已清理', '记录遗留风险与后续建议'],
  };
  const finalSubmit = [...passing.execute.slice(0, 2), existingTree, restatedScreenshot, dupExecute];
  const finalReview = [...passing.review.slice(0, 2), existingQa, restatedQa, dupReview];
  for (const round of rounds) {
    await core.submit(eng, proof(await core.claim(eng, t.id)), evidence({ learned: round.execute }));
    await core.returnTask(qa, proof(await core.claim(qa, t.id)), evidence({ learned: round.review }));
  }
  await core.submit(eng, proof(await core.claim(eng, t.id)), evidence({ learned: finalSubmit }));
  await core.accept(qa, proof(await core.claim(qa, t.id)), evidence({ learned: finalReview }));
  await notes.settle();

  // 控制台「线的笔记」：两次退回和两次失败的复核都不生效；每线只新增通过那一轮的非重复条目（最多 5 条）。
  const ownerNotes = (await ownerApi({ db, core, owner: {}, workforce: {}, messages: new OutboundMessageStore(db.db), opsRepo: '/tmp/ops' } as never,
    { command: 'note.list' }, 'web') as { notes: Array<{ id: string; lane: string; text: string; state: string }> }).notes;
  const fresh = ownerNotes.filter(note => !beforeIds.has(note.id) && note.state === 'active');
  const expectedFresh: Record<string, string[]> = {
    [occupiedEng]: [...passing.execute.slice(0, 2), dupExecute],
    [occupiedQa]: [...passing.review.slice(0, 2), dupReview],
  };
  for (const lane of [occupiedEng, occupiedQa]) {
    const added = fresh.filter(note => note.lane === lane);
    const expected = expectedFresh[lane]!;
    expect(added).toHaveLength(expected.length);
    expect(added.map(note => note.text).sort()).toEqual([...expected].sort());
    for (const [i, a] of expected.entries()) for (const [j, b] of expected.entries()) {
      if (i !== j) expect(isDuplicateNote(a, [b])).toBe(false);
    }
  }
  const discarded = [
    ...rounds.flatMap(round => [...round.execute, ...round.review]),
    existingTree, restatedScreenshot,
    existingQa, restatedQa,
  ];
  for (const text of discarded) expect(fresh.some(note => note.text === text)).toBe(false);

  // 控制台「待发消息」：新建代码任务使用新模板；已经存在、尚未发送的草稿保持原文。
  const legacy = '老板编辑过的旧草稿：合入并发布到生产，按验收标准在生产逐条自验';
  const messageStore = new OutboundMessageStore(db.db);
  // 已经存在、尚未发送的草稿不会被新规则改写，老板可能编辑过。
  const oldDraftTask = await core.createTask(gm, { title: '旧草稿任务', context: 'fixture', executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: key() } as never);
  const oldDrafts = await messageStore.createTaskDrafts(oldDraftTask.id, 'engineering', 'qa', true,
    { execute: legacy, review: legacy });
  const freshTask = await core.createTask(gm, {
    title: '新建代码任务', context: '实现验收标准', requirement: '实现验收标准', acceptanceText: '老板能看到结果',
    executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: key(),
  } as never);
  await messageStore.createTaskDrafts(freshTask.id, 'engineering', 'qa', true);
  const [rows] = await db.db.query<[Array<{ step: string; body: string }>]>(
    'SELECT step, body, created_at FROM outbound_message WHERE task = $task ORDER BY created_at;', { task: new RecordId('task', freshTask.id) });
  const execute = rows.find(row => row.step === 'execute')!.body;
  const review = rows.find(row => row.step === 'review')!.body;
  for (const body of [execute, review]) {
    expect(body).not.toContain('发布到生产');
    expect(body).not.toContain('在生产复验');
    expect(body).not.toContain('在生产逐条自验');
  }
  expect((await ownerApi({ db, core, owner: {}, workforce: {}, messages: messageStore, opsRepo: '/tmp/ops' } as never,
    { command: 'message.list', taskId: freshTask.id }, 'web') as { messages: { body: string }[] }).messages).toHaveLength(2);
  // 正文就是任务卡：做什么、可以用、验证三段。
  expect(execute).toStartWith('实现验收标准\n\n可以用：\n');
  expect(execute).toContain('验证：\n老板能看到结果\n在最终提交上逐条自验，');
  expect(execute).not.toContain('升级卡');
  expect(review).toStartWith('独立复验《新建代码任务》的交付');
  expect(review).toContain('先查第 1 条（老板视角的结果）');
  // 任务卡是事实来源：改了说明和资源，没改过的草稿跟着变；老板改过的那条保持原样。
  const api = (input: Record<string, unknown>) => ownerApi({ db, core, owner: {}, workforce: {}, messages: messageStore, opsRepo: '/tmp/ops' } as never, input, 'web');
  // 扣住、放行不算改正文：被扣住的草稿照样跟着任务卡变（0.13.11 把 edited_by 当成改过正文，扣住后就不再重算）。
  for (const draft of await messageStore.list(freshTask.id)) await messageStore.setHold(draft.id, true, 'owner');
  const reviewDraft = (await messageStore.list(freshTask.id)).find(m => m.step === 'review')!;
  await messageStore.edit(reviewDraft.id, '老板亲手改的复核消息', 'owner');
  await api({ command: 'task.update', taskId: freshTask.id, requirement: '实现新的验收标准', resources: '参考 src/export.ts' });
  const refreshed = await messageStore.list(freshTask.id);
  expect(refreshed.find(m => m.step === 'execute')!.body).toStartWith('实现新的验收标准\n\n可以用：\n参考 src/export.ts\n');
  expect(refreshed.find(m => m.step === 'review')!.body).toBe('老板亲手改的复核消息');
  // 重派：按任务卡组装且没改过的已发正文重新组装；老板改过的已发正文原样沿用。
  await db.db.query("UPDATE outbound_message SET state = 'sent', sent_at = time::now() WHERE task = $task;", { task: new RecordId('task', freshTask.id) });
  await api({ command: 'task.update', taskId: freshTask.id, requirement: '第三版说明' });
  await messageStore.ensureQueuedDrafts([freshTask.id]);
  const requeued = (await messageStore.list(freshTask.id, false)).find(m => m.step === 'execute')!;
  expect(requeued.body).toStartWith('第三版说明\n\n可以用：');
  await db.db.query("UPDATE $task SET state = 'review';", { task: new RecordId('task', freshTask.id) });
  await messageStore.ensureQueuedDrafts([freshTask.id]);
  expect((await messageStore.list(freshTask.id, false)).find(m => m.step === 'review')!.body).toBe('老板亲手改的复核消息');
  expect(oldDrafts.map(draft => draft.body)).toEqual([`先读 notes.md。${legacy}`, `先读 notes.md。${legacy}`]);
  expect((await messageStore.list(oldDraftTask.id)).map(draft => draft.body))
    .toEqual([`先读 notes.md。${legacy}`, `先读 notes.md。${legacy}`]);
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

run('one lane allows exactly 30 effective notes, including pinned ones; full lanes queue proposals', async () => {
  const mine = await notes.add('cap:qa', '老板手写', 'owner:test');
  expect(mine.state).toBe('active');
  const seed = await notes.add('cap:qa', '种子经验', 'seed', { proposed: true });
  expect(await texts('cap:qa')).toEqual(['老板手写']);
  await notes.settle();
  expect(await texts('cap:qa')).toEqual(['老板手写']); // No source task: only the owner activates it.
  await notes.activate(seed.id);
  expect(await texts('cap:qa')).toEqual(['种子经验', '老板手写']);
  await notes.edit(seed.id, '种子经验改');
  await notes.remove(mine.id);
  expect(await texts('cap:qa')).toEqual(['种子经验改']);
  await expect(notes.activate(seed.id)).rejects.toMatchObject({ code: 'conflict' });

  // 恰好 30 条生效笔记（包含置顶）就封顶；note.add 被拒，新提议继续排队并报 fullLanes。
  await notes.pin(seed.id, true);
  for (let i = 1; i < NOTE_MAX_ACTIVE; i++) {
    await notes.add('cap:qa', `已生效笔记 ${i}`, 'owner:test');
  }
  expect((await notes.active('cap:qa')).length).toBe(NOTE_MAX_ACTIVE);
  expect((await notes.active('cap:qa')).some(note => note.pinned)).toBe(true);
  await expect(notes.add('cap:qa', '放不下', 'owner:test')).rejects.toThrow('上限');
  await expect(ownerApi({ db, core, owner: {}, workforce: {}, messages: new OutboundMessageStore(db.db), opsRepo: '/tmp/ops' } as never,
    { command: 'note.add', lane: 'cap:qa', text: '老板控制台也不能超上限' }, 'web')).rejects.toThrow('上限');

  const done = await core.createTask(gm, { title: '满线的任务', context: 'fixture', executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: key() } as never);
  await db.db.query(`UPDATE $t SET state = 'done';`, { t: new RecordId('task', done.id) });
  await notes.propose('cap:qa', done.id, 'execute', ['排队经验'], 'fixture');
  expect((await notes.settle()).fullLanes).toEqual(['cap:qa']);
  expect((await notes.list('cap:qa')).find(n => n.text === '排队经验')?.state).toBe('proposed');
  expect((await notes.active('cap:qa')).length).toBe(NOTE_MAX_ACTIVE);
});

run('a route template reaches the task drafts, with the notes pointer added', async () => {
  await saveRoute(db.db, { type: 'lane-tpl', label: 'tpl', executor_role: 'engineering', reviewer_role: 'qa', code: false, execute_body: '按模板执行 task.md', review_body: '先读 notes.md 再按模板复核', hold: false, enabled: true }, 'test');
  const t = await core.createTask(gm, { type: 'lane-tpl', title: '模板任务', context: 'fixture', idempotencyKey: key() } as never);
  const [rows] = await db.db.query<[Array<{ step: string; body: string }>]>('SELECT step, body FROM outbound_message WHERE task = $t;', { t: new RecordId('task', t.id) });
  expect(rows.find(r => r.step === 'execute')?.body).toBe('先读 notes.md。按模板执行 task.md');
  expect(rows.find(r => r.step === 'review')?.body).toBe('先读 notes.md 再按模板复核');
});

run('a claim records the session\'s lane, task and phase; facts report task states', async () => {
  const wf = new Workforce(db);
  const parent = await task('父任务记录', 'alpha');
  const c = await core.claim(eng, parent.id);
  const seen = async (who: string) => (await db.db.select<{ lane?: string; last_task?: RecordId; last_phase?: string }>(new RecordId('employee', who)))!;
  expect(await seen('lanes-eng')).toMatchObject({ lane: 'alpha:engineering', last_phase: 'execute' });
  expect(String((await seen('lanes-eng')).last_task?.id)).toBe(parent.id);
  await core.submit(eng, proof(c), evidence());
  const r = await core.claim(qa, parent.id);
  expect(await seen('lanes-qa')).toMatchObject({ lane: 'alpha:qa', last_phase: 'review' });
  await core.accept(qa, proof(r), evidence());
  const facts = await wf.sessionTaskFacts([parent.id, 'missing-task']);
  expect(facts.states.get(parent.id)).toBe('done');
  expect(facts.states.has('missing-task')).toBe(false);
});

run('a chain keeps one workspace record at its root and is finished only when every task is', async () => {
  const wf = new Workforce(db);
  const root = await task('目标根任务');
  const child = await core.createTask(gm, { title: '子任务', context: 'fixture', executorRole: 'engineering', reviewerRole: 'qa', parent: root.id, requirement: 'fixture', acceptanceText: 'fixture', idempotencyKey: key() } as never);
  expect(await wf.chainRoot(child.id)).toEqual({ id: root.id, title: '目标根任务', workspaces: [] });
  await wf.saveChainWorkspaces(root.id, [{ cwd: '/repo', id: 'wks_1' }]);
  expect((await wf.chainRoot(child.id)).workspaces).toEqual([{ cwd: '/repo', id: 'wks_1' }]);
  expect((await wf.finishedChains()).map(c => c.id)).not.toContain(root.id);
  await db.db.query(`UPDATE task SET state = 'done' WHERE id IN $ids;`, { ids: [new RecordId('task', root.id), new RecordId('task', child.id)] });
  expect((await wf.finishedChains()).map(c => c.id)).toContain(root.id);
  await wf.saveChainWorkspaces(root.id, []);
  expect((await wf.finishedChains()).map(c => c.id)).not.toContain(root.id);
  expect((await wf.chainRoot(child.id)).workspaces).toEqual([]);
});

run('progress reads a real chain out of the audit trail', async () => {
  const { readProgress } = await import('../src/task-progress.ts');
  const t = await task('进度读取');
  const c = await core.claim(eng, t.id);
  await core.submit(eng, proof(c), evidence());
  const r = await core.claim(qa, t.id);
  await core.returnTask(qa, proof(r), evidence());
  const c2 = await core.claim(eng, t.id);
  await core.submit(eng, proof(c2), evidence());
  const r2 = await core.claim(qa, t.id);
  await core.accept(qa, proof(r2), evidence());
  const chain = (await readProgress(db.db)).chains.find(x => x.root === t.id)!;
  expect(chain.counts.done).toBe(1);
  expect(chain.forecast.remainingMinutes).toBe(0);
  expect(chain.defects).toHaveLength(1);
  expect(chain.defects[0]!.state).toBe('fixed');
  expect(chain.defects[0]!.problem.length).toBeGreaterThan(0);
  expect(chain.defects[0]!.fix!.length).toBeGreaterThan(0);
});

run('第 2 步：老板的答复随恢复消息带给员工；第二轮返工先扣住；完工分析只记录', async () => {
  const { OwnerDesk } = await import('../src/owner.ts');
  const { analyzeTurns, turnAnalysesOf } = await import('../src/turn-analysis.ts');
  const { latestAnswer } = await import('../src/dispatcher/brief.ts');
  const store = new OutboundMessageStore(db.db);
  const desk = new OwnerDesk(db);
  const t = await core.createTask(gm, { title: '导出订单', context: '给订单列表加导出', requirement: '给订单列表加导出', acceptanceText: '老板能下载到 CSV',
    executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: key() } as never);
  await store.createTaskDrafts(t.id, 'engineering', 'qa', true);
  const draftOf = async (step: string) => (await store.list(t.id, false)).find(m => m.step === step)!;
  expect((await draftOf('execute')).body).toStartWith('给订单列表加导出\n\n可以用：');

  // 受阻 → 老板答复：以前答复只进审计，员工收到的还是原来那条消息。
  const c1 = await core.claim(eng, t.id);
  await core.block(eng, proof(c1), 'owner', { text: '执行端自动收集的工作结果：\n工作结果：受阻\n缺演示环境的管理员账号，登录不了后台。', idempotencyKey: key() });
  await desk.decide({ taskId: t.id, decision: 'reply', note: '账号用 test_kit 领，角色选 admin。', source: 'web', key: key() });
  const resumed = await core.claim(eng, t.id);
  expect(latestAnswer(resumed.history)).toEqual({ blocker: '缺演示环境的管理员账号，登录不了后台。', reply: '账号用 test_kit 领，角色选 admin。' });
  await core.release(eng, proof(resumed), { text: '【通道回滚】fixture：供应商明确失败，保留任务阶段，等待通道恢复后重派。', idempotencyKey: key() });
  // 发出前重算：草稿开头带上受阻原因和老板原话。
  const sent = await store.prepareSend(t.id, 'execute', 'lanes-eng');
  expect(sent!.body).toStartWith('上一轮你报告受阻：缺演示环境的管理员账号，登录不了后台。\n老板答复：\n账号用 test_kit 领，角色选 admin。\n按答复接着做。\n\n给订单列表加导出');
  await store.markSent(sent!.message.id, 'lanes-eng', sent!.body);

  // 提交之后答复已被消化：复核消息不带它。
  const c2 = await core.claim(eng, t.id);
  await core.submit(eng, proof(c2), evidence());
  await store.refreshDrafts(t.id);
  expect((await draftOf('review')).body).toStartWith('独立复验《导出订单》的交付');

  // 第一轮退回：返工草稿不扣。
  await core.returnTask(qa, proof(await core.claim(qa, t.id)), evidence({ text: '第 1 条不成立：导出按钮点了没有下载，控制台报 500。' }));
  await store.ensureQueuedDrafts([t.id]);
  expect((await draftOf('rework')).hold).toBe(false);
  const rework1 = await store.prepareSend(t.id, 'rework', 'lanes-eng');
  await store.markSent(rework1!.message.id, 'lanes-eng', rework1!.body);
  // 同一轮的重派（租约过期）也不扣。
  await store.ensureQueuedDrafts([t.id]);
  expect((await draftOf('rework')).hold).toBe(false);
  await db.db.query("UPDATE outbound_message SET state = 'sent', sent_at = time::now() WHERE task = $task AND step = 'rework';", { task: new RecordId('task', t.id) });

  // 第二轮退回：返工草稿按规则扣住并写明原因；老板放行后原因清掉。
  const c3 = await core.claim(eng, t.id);
  await core.submit(eng, proof(c3), evidence());
  await core.returnTask(qa, proof(await core.claim(qa, t.id)), evidence({ text: '仍然不成立：CSV 下载到了，但列头是英文，与页面不一致。' }));
  await store.ensureQueuedDrafts([t.id]);
  const held = await draftOf('rework');
  expect(held).toMatchObject({ hold: true, state: 'held', holdReason: '第 2 轮返工' });
  expect(held.editedBy).toBeUndefined();
  expect(await store.holdReason(t.id, 'rework')).toBe('第 2 轮返工');
  expect(await store.prepareSend(t.id, 'rework', 'lanes-eng')).toBeNull();
  expect((await store.setHold(held.id, false, 'owner')).holdReason).toBeUndefined();
  // auto_hold = false 关掉系统扣住。
  await db.db.query('UPSERT company_meta:config MERGE { auto_hold: false };');
  expect(await store.holdForPolicy(held.id, 'x')).toBe(false);
  await db.db.query('UPSERT company_meta:config MERGE { auto_hold: true };');

  // 完工分析：每轮最多两条，一条结果一条分析；不合格的模型输出记失败，三次后放弃；不改任何草稿。
  const before = (await store.list(t.id)).map(m => `${m.id}:${m.body}`);
  const seen: Array<{ action: string; result: string; submitted?: string }> = [];
  const good = async (input: { action: string; result: string; submitted?: string }) => { seen.push(input);
    return { status: input.action === 'block' ? 'blocked' : input.action === 'submit' ? 'partial' : 'rejected', summary: '列头与页面不一致', needs: ['页面列名的中文对照'], next: '上一轮列头是英文。先把列头改成页面上的中文列名。', confidence: 'high' }; };
  let total = 0;
  for (let round = 0; round < 12; round++) { const r = await analyzeTurns(db.db, good as never); total += r.analyzed; expect(r.analyzed).toBeLessThanOrEqual(2); if (!r.analyzed) break; }
  expect(total).toBeGreaterThanOrEqual(5); // 本任务：block、submit×2、return×2（库里别的任务的结果也会被分析）。
  expect(seen.some(s => s.result.startsWith('【通道回滚】'))).toBe(false);
  const mine = seen.filter(s => s.action === 'return' && s.result.includes('列头是英文'));
  expect(mine).toHaveLength(1);
  expect(mine[0]!.submitted).toContain('fixture evidence');
  const [audits] = await db.db.query<[Array<{ id: RecordId; action: string }>]>('SELECT id, action, at FROM audit WHERE task = $task ORDER BY at;', { task: new RecordId('task', t.id) });
  const analyses = await turnAnalysesOf(db.db, audits);
  expect(Object.keys(analyses)).toHaveLength(audits.filter(a => ['submit', 'return', 'block'].includes(a.action)).length);
  expect(Object.values(analyses)[0]).toMatchObject({ summary: '列头与页面不一致', needs: ['页面列名的中文对照'], confidence: 'high' });
  expect((await analyzeTurns(db.db, good as never)).analyzed).toBe(0); // 已分析的不重复。
  expect((await store.list(t.id)).map(m => `${m.id}:${m.body}`)).toEqual(before);

  // 新结果 + 不合格输出：记失败，不产生结论。
  const c4 = await core.claim(eng, t.id);
  await core.submit(eng, proof(c4), evidence({ text: `很长的结果 ${'x'.repeat(13_000)}` }));
  expect(await analyzeTurns(db.db, (async () => ({ status: 'done', summary: '', confidence: 'sure' })) as never)).toEqual({ analyzed: 0, failed: 1 });
  // 失败留下诊断：哪一步、什么类别、多久；不含模型正文。
  const [diag] = await db.db.query<[Array<{ error: string; attempts: number; elapsed_ms: number }>]>(
    'SELECT error, attempts, elapsed_ms FROM turn_analysis WHERE task = $task AND summary = NONE;', { task: new RecordId('task', t.id) });
  expect(diag).toEqual([expect.objectContaining({ error: 'validate: invalid 完工分析的完成情况无效', attempts: 1 })]);
  expect(diag[0]!.elapsed_ms).toBeGreaterThanOrEqual(0);
  // 重试间隔过后再试；这次合格，但原文被截断，把握强制记为不足。
  expect((await analyzeTurns(db.db, good as never)).analyzed).toBe(0);
  expect((await analyzeTurns(db.db, good as never, Date.now() + 11 * 60_000)).analyzed).toBe(1);
  const [last] = await db.db.query<[Array<{ confidence: string; low_reason: string }>]>(
    "SELECT confidence, low_reason, at FROM turn_analysis WHERE task = $task AND low_reason != NONE;", { task: new RecordId('task', t.id) });
  expect(last).toEqual([expect.objectContaining({ confidence: 'low', low_reason: '结果原文过长，模型只看了前一部分' })]);
});

run('自定义正文的任务（需求流水线、路线、老板改过的）受阻后重派，也带上老板的答复，再次受阻不叠两段', async () => {
  const { OwnerDesk } = await import('../src/owner.ts');
  const store = new OutboundMessageStore(db.db);
  const desk = new OwnerDesk(db);
  const t = await core.createTask(gm, { title: '核对实施计划', context: '核对计划', requirement: '核对计划', acceptanceText: '计划可执行',
    executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: key() } as never);
  const custom = '先读 notes.md。按流水线的自定义正文核对计划。';
  await store.createTaskDrafts(t.id, 'engineering', 'qa', false, { execute: custom, review: custom });
  const send = async (step: 'execute' | 'review') => { const p = await store.prepareSend(t.id, step, 'lanes-eng'); await store.markSent(p!.message.id, 'lanes-eng', p!.body); return p!.body; };
  expect(await send('execute')).toBe(custom);

  const c1 = await core.claim(eng, t.id);
  await core.block(eng, proof(c1), 'owner', { text: '工作结果：受阻\n计划里的仓库地址打不开，无法核对。', idempotencyKey: key() });
  await desk.decide({ taskId: t.id, decision: 'reply', note: '仓库换成 MainListActivity/surreal_ck。', source: 'web', key: key() });
  await store.ensureQueuedDrafts([t.id]);
  const lead1 = '上一轮你报告受阻：计划里的仓库地址打不开，无法核对。\n老板答复：\n仓库换成 MainListActivity/surreal_ck。\n按答复接着做。';
  expect(await send('execute')).toBe(`${lead1}\n\n${custom}`);
  // 还没轮到的复核草稿不带执行岗受阻的答复。
  expect((await store.list(t.id, false)).find(m => m.step === 'review')!.body).toBe(custom);

  // 再次受阻、再次答复：换成新的那段，不叠在旧的后面。
  const c2 = await core.claim(eng, t.id);
  await core.block(eng, proof(c2), 'owner', { text: '工作结果：受阻\n新仓库没有读权限，克隆时返回 403，无法继续核对。', idempotencyKey: key() });
  await desk.decide({ taskId: t.id, decision: 'reply', note: '已加权限，重试。', source: 'web', key: key() });
  expect(await send('execute')).toBe(`上一轮你报告受阻：新仓库没有读权限，克隆时返回 403，无法继续核对。\n老板答复：\n已加权限，重试。\n按答复接着做。\n\n${custom}`);

  // 有了工作结果之后的重派（退回前的同一步）不再带答复。
  const c3 = await core.claim(eng, t.id);
  await core.submit(eng, proof(c3), evidence());
  await core.release(qa, proof(await core.claim(qa, t.id)), { text: '【通道回滚】fixture：供应商明确失败，保留任务阶段，等待通道恢复后重派。', idempotencyKey: key() });
  expect(await send('review')).toBe(custom);
});
