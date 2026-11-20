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
  server = Bun.spawn([join(homedir(), '.surrealdb/surreal'), 'start', '--bind', `127.0.0.1:${port}`, '--user', 'root', '--pass', 'fixture-only', `surrealkv:${join(dir, 'db')}`], { stdout: 'ignore', stderr: 'ignore' });
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

run('第 2 步后半：退回的完工分析写进返工消息；把握不足扣住一次；限时等分析；同一轮重派照上次发的来', async () => {
  const { analyzeTurns } = await import('../src/turn-analysis.ts');
  const store = new OutboundMessageStore(db.db);
  const mk = async (title: string) => { const t = await core.createTask(gm, { title, context: '给订单列表加导出', requirement: '给订单列表加导出', acceptanceText: '老板能下载到 CSV',
    executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: key() } as never); await store.createTaskDrafts(t.id, 'engineering', 'qa', false); return t; };
  const draftOf = async (id: string, step = 'rework') => (await store.list(id, false)).find(m => m.step === step)!;
  const send = async (id: string) => { const p = await store.prepareSend(id, 'rework', 'lanes-eng'); await store.markSent(p!.message.id, 'lanes-eng', p!.body); return p!.body; };
  const returned = async (id: string, text: string) => { await core.submit(eng, proof(await core.claim(eng, id)), evidence({ text: '执行端自动收集的工作结果：\n导出做完了，页面上点导出可以下载。' }));
    await core.returnTask(qa, proof(await core.claim(qa, id)), evidence({ text })); };
  const seen: Array<{ action: string; result: string; submitted?: string }> = [];
  const model = (confidence: string, next = '上一轮导出报 500。先修接口，再在页面上点一次导出确认能下载。') => (async (input: { action: string; result: string; submitted?: string }) => {
    seen.push(input); return { status: input.action === 'return' ? 'rejected' : 'partial', summary: '导出报 500', needs: [], next, confidence }; }) as never;
  const drain = async (analyze: never) => { for (let i = 0; i < 20; i++) if (!(await analyzeTurns(db.db, analyze)).analyzed) break; };
  const LEAD = '上一轮的情况（系统读退回意见后整理的，与退回意见原文不一致时以原文为准）：\n上一轮导出报 500。先修接口，再在页面上点一次导出确认能下载。';
  await drain(model('high')); // 清掉库里别的任务的待分析结果，并留下心跳。

  // 分析任务在跑、退回刚发生、分析还没出来：返工消息等着，不发，也不是扣住。
  const a = await mk('导出订单 A');
  await returned(a.id, '第 1 条不成立：导出按钮点了没有下载，控制台报 500。');
  await store.ensureQueuedDrafts([a.id]);
  expect(await store.awaitingAnalysis(a.id, 'rework')).toBe(true);
  expect(await store.awaitingAnalysis(a.id, 'review')).toBe(false);
  expect(await store.prepareSend(a.id, 'rework', 'lanes-eng')).toBeNull();
  expect(await store.isHeld(a.id, 'rework')).toBe(false);
  // 把握足的分析出来：写进返工消息，直接发；交给模型的结果不带执行端的说明行。
  await drain(model('high'));
  expect(seen.filter(s => s.action === 'return' && s.result.includes('控制台报 500')).at(-1)!.submitted).toBe('导出做完了，页面上点导出可以下载。');
  await store.ensureQueuedDrafts([a.id]);
  expect((await draftOf(a.id)).body).toBe(`上一轮被退回，先修复 findings/round-NN.md 里的问题。\n\n${LEAD}\n\n${(await draftOf(a.id, 'execute')).body}`);
  expect(await store.awaitingAnalysis(a.id, 'rework')).toBe(false);
  const sentA = await send(a.id);
  expect(sentA).toContain(LEAD);
  // 同一轮重派：照上次发的来。
  await store.ensureQueuedDrafts([a.id]);
  expect((await draftOf(a.id)).body).toBe(sentA);

  // 把握不足：写进正文并扣住等老板看；老板放行后不再因同一份分析扣住。
  const b = await mk('导出订单 B');
  await returned(b.id, '第 1 条不成立：下载到的文件是空的，一行数据都没有。');
  await drain(model('low'));
  await store.ensureQueuedDrafts([b.id]);
  const heldB = await draftOf(b.id);
  expect(heldB).toMatchObject({ hold: true, state: 'held', holdReason: '完工分析把握不足' });
  expect(heldB.body).toContain(LEAD);
  expect(await store.prepareSend(b.id, 'rework', 'lanes-eng')).toBeNull();
  await store.setHold(heldB.id, false, 'owner');
  await store.ensureQueuedDrafts([b.id]);
  expect(await send(b.id)).toContain(LEAD);

  // 关了自动扣住：把握不足的分析不写进正文，照常发。
  const c = await mk('导出订单 C');
  await returned(c.id, '第 1 条不成立：导出的列少了金额，和页面列表对不上。');
  await drain(model('low'));
  await db.db.query('UPSERT company_meta:config MERGE { auto_hold: false };');
  await store.ensureQueuedDrafts([c.id]);
  await db.db.query('UPSERT company_meta:config MERGE { auto_hold: true };');
  expect(await draftOf(c.id)).toMatchObject({ hold: false });
  expect((await draftOf(c.id)).body).not.toContain('上一轮的情况');
  await store.ensureQueuedDrafts([c.id]);
  expect(await send(c.id)).not.toContain('上一轮的情况');

  // 等不到：分析失败过一次就不等；发出之后迟到的分析不再加进同一轮的重派。
  const d = await mk('导出订单 D');
  await returned(d.id, '第 1 条不成立：导出超时，等了一分钟没有任何下载。');
  await store.ensureQueuedDrafts([d.id]);
  expect(await store.awaitingAnalysis(d.id, 'rework')).toBe(true);
  for (let i = 0; i < 6; i++) await analyzeTurns(db.db, (async () => ({ status: 'bad' })) as never);
  expect(await store.awaitingAnalysis(d.id, 'rework')).toBe(false);
  const sentD = await send(d.id);
  expect(sentD).not.toContain('上一轮的情况');
  await drain(model('high'));
  for (let i = 0; i < 4; i++) await analyzeTurns(db.db, model('high'), Date.now() + 11 * 60_000);
  await store.ensureQueuedDrafts([d.id]);
  expect((await draftOf(d.id)).body).toBe(sentD);

  // 等过了时限（退回已超过 4 分钟）：不等。
  const f = await mk('导出订单 F');
  await returned(f.id, '第 1 条不成立：导出的文件名是乱码，打不开。');
  await store.ensureQueuedDrafts([f.id]);
  expect(await store.awaitingAnalysis(f.id, 'rework')).toBe(true);
  await db.db.query("UPDATE audit SET at = time::now() - 5m WHERE task = $task AND action = 'return';", { task: new RecordId('task', f.id) });
  expect(await store.awaitingAnalysis(f.id, 'rework')).toBe(false);
  expect(await store.prepareSend(f.id, 'rework', 'lanes-eng')).not.toBeNull();

  // 分析任务没在跑（没有心跳）：不等。
  const e = await mk('导出订单 E');
  await returned(e.id, '第 1 条不成立：导出的时间是 UTC，页面上是北京时间。');
  await db.db.query('DELETE company_meta:analysis;');
  await store.ensureQueuedDrafts([e.id]);
  expect(await store.awaitingAnalysis(e.id, 'rework')).toBe(false);
  // 老板改过的字面正文跨回合原样保留，不能再自动删改其中的复盘段。
  await drain(model('high'));
  await store.ensureQueuedDrafts([e.id]);
  const edited = await store.edit((await draftOf(e.id)).id, `${(await draftOf(e.id)).body}\n\n老板补充：时间用北京时间。`, 'owner');
  expect(edited.body).toContain(LEAD);
  await send(e.id);
  await returned(e.id, '仍不成立：文件名里的日期还是 UTC，和文件内容不一致。');
  await drain(model('high', '上一轮文件名日期仍是 UTC。先改文件名的日期。'));
  await store.ensureQueuedDrafts([e.id]);
  const second = await draftOf(e.id);
  expect(second.body).toBe(edited.body);
  expect(second.bodyVerbatim).toBe(true);
  expect(second.bodyEdited).toBe(true);
  expect(second.body).toContain('老板补充：时间用北京时间。');
  expect(second.hold).toBe(true); // 第二轮返工照旧扣住。
});

run('第 3 步：消息链按父子关系排出已发、下一条、稍后与等前一张任务的消息；只读', async () => {
  const { readMessageChains } = await import('../src/message-chain.ts');
  const store = new OutboundMessageStore(db.db);
  const mk = async (title: string, parent?: string) => { const t = await core.createTask(gm, { title, context: '消息链夹具任务', requirement: '消息链夹具任务',
    acceptanceText: '能看到结果', executorRole: 'engineering', reviewerRole: 'qa', parent, idempotencyKey: key() } as never);
    await store.createTaskDrafts(t.id, 'engineering', 'qa', false); return t; };
  const root = await mk('消息链根任务'), child = await mk('消息链后继任务', root.id);
  const count = async () => (await db.db.query<[Array<{ n: number }>]>('SELECT count() AS n FROM outbound_message GROUP ALL;'))[0]![0]!.n;
  const before = await count();
  const chainOf = async () => (await readMessageChains(db.db)).find(c => c.id === root.id)!;
  expect((await chainOf()).rows.map(r => `${r.status}:${r.title}:${r.step}`)).toEqual([
    'next:消息链根任务:execute', 'later:消息链根任务:review', 'waiting:消息链后继任务:execute', 'waiting:消息链后继任务:review']);
  expect((await chainOf()).rows[2]!.when).toBe('等《消息链根任务》完成后发');
  expect((await chainOf()).rows[0]).toMatchObject({ fixed: false, hold: false, role: 'engineering' });
  // 发出执行消息、老板扣住并改写复核消息：链上如实反映，已发的不带正文。
  const sent = await store.prepareSend(root.id, 'execute', 'lanes-eng');
  await store.markSent(sent!.message.id, 'lanes-eng', sent!.body);
  const review = (await store.list(root.id, false)).find(m => m.step === 'review')!;
  await store.edit(review.id, '老板写定的复核消息', 'owner');
  await store.setHold(review.id, true, 'owner');
  const chain = await chainOf();
  expect(chain.rows.slice(0, 2).map(r => `${r.status}:${r.step}`)).toEqual(['sent:execute', 'held:review']);
  expect(chain.rows[0]).toMatchObject({ sentTo: 'lanes-eng', when: '已发出' });
  expect(chain.rows[0]!.body).toBeUndefined();
  expect(chain.rows[1]).toMatchObject({ fixed: true, body: '老板写定的复核消息', when: '已扣住，等你放行' });
  expect(await count()).toBe(before); // 读消息链不写库。
  expect(child.state).toBe('planned');
});

run('第 5 步：中止收回租约并请执行端停会话；暂停再把下一条消息扣住；插话随下一条消息带出一次', async () => {
  const { ownerApi } = await import('../src/owner-api.ts');
  const store = new OutboundMessageStore(db.db);
  const api = (input: Record<string, unknown>) => ownerApi({ db, core, owner: {}, workforce: new Workforce(db), messages: store, opsRepo: '/tmp/ops' } as never, input, 'web') as Promise<Record<string, unknown>>;
  const t = await core.createTask(gm, { title: '运行中控制', context: '给订单列表加导出', requirement: '给订单列表加导出', acceptanceText: '老板能下载到 CSV',
    executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: key() } as never);
  await store.createTaskDrafts(t.id, 'engineering', 'qa', false);
  const send = async (step: 'execute' | 'review') => { const p = await store.prepareSend(t.id, step, 'lanes-eng'); await store.markSent(p!.message.id, 'lanes-eng', p!.body); return p!.body; };
  const stateOf = async () => (await db.db.query<[Array<{ state: string; current_employee?: string }>]>('SELECT state, current_employee FROM $t;', { t: new RecordId('task', t.id) }))[0]![0]!;
  const stopFlag = async () => (await db.db.query<[Array<{ stop_requested?: { task?: string } }>]>('SELECT stop_requested FROM $e;', { e: new RecordId('employee', 'lanes-eng') }))[0]![0]?.stop_requested;
  await db.db.query("UPSERT $e SET role = 'engineering';", { e: new RecordId('employee', 'lanes-eng') });

  // 没有人在做：中止拒绝；插话先记下，下一条消息最前面带上老板的原话。
  await expect(api({ command: 'task.stop', taskId: t.id })).rejects.toThrow('任务当前没有在途执行');
  expect(await api({ command: 'task.interject', taskId: t.id, text: '列头用中文。' })).toEqual({ ok: true, interrupted: false });
  const first = await send('execute');
  expect(first).toStartWith('老板补充（上一轮进行中说的，按这个调整）：\n列头用中文。\n\n给订单列表加导出');
  // 还没轮到的复核草稿不带；带出一次即算送达，之后的消息不再带。
  expect((await store.list(t.id, false)).find(m => m.step === 'review')!.body).not.toContain('老板补充');

  // 进行中插话并立即打断：租约收回、任务回到队列、给执行端留下停会话的请求；重派的消息带着这句话，旧的那句不叠。
  await core.claim(eng, t.id);
  expect(await api({ command: 'task.interject', taskId: t.id, text: '金额保留两位小数。', interrupt: true })).toEqual({ ok: true, interrupted: true });
  expect(await stateOf()).toMatchObject({ state: 'ready' });
  expect((await stateOf()).current_employee).toBeUndefined();
  expect(await stopFlag()).toMatchObject({ task: t.id });
  await store.ensureQueuedDrafts([t.id]);
  const second = await send('execute');
  expect(second).toStartWith('老板补充（上一轮进行中说的，按这个调整）：\n金额保留两位小数。\n\n给订单列表加导出');
  expect(second).not.toContain('列头用中文');

  // 暂停：停掉这一轮，并把下一条消息扣住；放行即恢复，恢复的消息不再带已送达的插话。
  await core.claim(eng, t.id);
  const paused = await api({ command: 'task.stop', taskId: t.id, hold: true, note: '先等设计稿' });
  expect(paused).toMatchObject({ ok: true, employee: 'lanes-eng' });
  expect(await stateOf()).toMatchObject({ state: 'ready' });
  const held = (await store.list(t.id, false)).find(m => m.step === 'execute')!;
  expect(held).toMatchObject({ id: paused.heldMessage, hold: true, state: 'held' });
  expect(await store.prepareSend(t.id, 'execute', 'lanes-eng')).toBeNull();
  await api({ command: 'message.release', messageId: held.id });
  expect(await send('execute')).toStartWith('给订单列表加导出');
  // 员工先交了：复核消息不带插话也不算送达，之后被退回时返工消息带上。
  const working = await core.claim(eng, t.id);
  await api({ command: 'task.interject', taskId: t.id, text: '文件名带日期。' });
  await core.submit(eng, proof(working), evidence());
  expect(await send('review')).not.toContain('老板补充');
  await core.returnTask(qa, proof(await core.claim(qa, t.id)), evidence({ text: '【通道回滚】之外的真实退回：第 1 条不成立，下载的文件是空的。' }));
  await store.ensureQueuedDrafts([t.id]);
  const rework = await store.prepareSend(t.id, 'rework', 'lanes-eng');
  expect(rework!.body).toStartWith('老板补充（上一轮进行中说的，按这个调整）：\n文件名带日期。\n\n上一轮被退回');
  await store.markSent(rework!.message.id, 'lanes-eng', rework!.body);

  // 自定义正文（需求流水线、路线）的草稿不随任务卡重算，插话就地加在最前面；再插一句是换掉那一段，不叠。
  const custom = await core.createTask(gm, { title: '自定义正文任务', context: '核对计划', requirement: '核对计划', acceptanceText: '计划可执行',
    executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: key() } as never);
  await store.createTaskDrafts(custom.id, 'engineering', 'qa', false, { execute: '先读 notes.md。流水线的自定义正文。', review: '先读 notes.md。流水线的复核正文。' });
  await api({ command: 'task.interject', taskId: custom.id, text: '只看前两步。' });
  const draftsOf = async () => await store.list(custom.id, false);
  expect((await draftsOf()).find(m => m.step === 'execute')!.body).toBe('老板补充（上一轮进行中说的，按这个调整）：\n只看前两步。\n\n先读 notes.md。流水线的自定义正文。');
  expect((await draftsOf()).find(m => m.step === 'review')!.body).toBe('先读 notes.md。流水线的复核正文。');
  await api({ command: 'task.interject', taskId: custom.id, text: '第三步先不做。' });
  expect((await draftsOf()).find(m => m.step === 'execute')!.body).toBe('老板补充（上一轮进行中说的，按这个调整）：\n只看前两步。\n第三步先不做。\n\n先读 notes.md。流水线的自定义正文。');
  // 暂停一张没人在做的任务：只扣住下一条。
  expect(await api({ command: 'task.stop', taskId: custom.id, hold: true })).toMatchObject({ ok: false });
  expect((await draftsOf()).find(m => m.step === 'execute')!.hold).toBe(true);

  // 已结束的任务不能插话。
  const [audits] = await db.db.query<[Array<{ action: string }>]>("SELECT action, at FROM audit WHERE task = $t AND action IN ['revoked', 'owner_note'] ORDER BY at;", { t: new RecordId('task', t.id) });
  expect(audits.map(a => a.action)).toEqual(['owner_note', 'owner_note', 'revoked', 'revoked', 'owner_note']);
  await db.db.query("UPDATE $t SET state = 'done';", { t: new RecordId('task', t.id) });
  await expect(api({ command: 'task.interject', taskId: t.id, text: '再改一下' })).rejects.toThrow('任务已结束');
});
