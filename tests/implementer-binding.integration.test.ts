import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordId } from 'surrealdb';
import { loadDatabaseConfig } from '../src/config.ts';
import { CompanyDatabase } from '../src/database.ts';
import { SurrealCompanyCore } from '../src/core.ts';
import { LocalEnrollmentAdmin } from '../src/enrollment.ts';
import { Workforce } from '../src/workforce.ts';
import type { ClaimResult, TaskView } from '../src/contracts.ts';

// AC06 on the real core: the rework loop, every author recused, races, and takeover refusals.
// Own namespace, so nothing here shares state with the v3 integration file.
const NS = 'sck_agent_company_test_ac06';
const database = new CompanyDatabase({ ...loadDatabaseConfig(), namespace: NS, database: 'control_plane' });
setDefaultTimeout(180_000);
const credDir = mkdtempSync(join(tmpdir(), 'sck-ac06-test-'));
const workforce = new Workforce(database, credDir);
const core = new SurrealCompanyCore(database, { workforce });
const enrollment = new LocalEnrollmentAdmin(database);
const tokens: Record<string, string> = {};

beforeAll(async () => {
  await database.connect();
  // This namespace is owned by this test file only; start from an empty database every run.
  await database.db.query(`DEFINE NAMESPACE IF NOT EXISTS ${NS};`);
  await database.db.use({ namespace: NS });
  await database.db.query('REMOVE DATABASE IF EXISTS control_plane;');
  await database.bootstrap();
  for (const [name, role, caps] of [
    ['owner', 'owner', ['execute', 'review', 'manage']], ['gm2', 'owner', ['execute', 'review', 'manage']],
    ['eng-a', 'engineering', ['execute', 'review']], ['eng-b', 'engineering', ['execute', 'review']],
    ['eng-c', 'engineering', ['execute', 'review']], ['qa', 'qa', ['execute', 'review']],
  ] as const) tokens[name] = await enrollment.enroll(`t-${name}`, role, caps);
});

afterAll(async () => {
  await database.close();
  rmSync(credDir, { recursive: true, force: true });
});

const key = () => crypto.randomUUID();
const proofOf = (c: ClaimResult | { task: TaskView; deliveryId: string; fence: number }, version = c.task.version) =>
  ({ taskId: c.task.id, deliveryId: c.deliveryId, fence: c.fence, expectedVersion: version });
const task = async (id: string) => core.getTask(tokens.owner, id);
const DELIVERY = 'Synthetic delivery evidence for the AC06 implementer binding test.';
const REVIEW = 'Independent synthetic review evidence for the AC06 implementer binding test.';
const newTask = (title: string) => core.createTask(tokens.owner, { title, context: 'synthetic AC06 case', executorRole: 'engineering',
  reviewerRole: 'engineering', idempotencyKey: key() });
async function deliver(token: string, taskId: string) {
  const claim = await core.claim(token, taskId);
  return core.submit(token, proofOf(claim), { text: DELIVERY, idempotencyKey: key() });
}
async function review(token: string, taskId: string, decision: 'accept' | 'return' = 'accept') {
  const claim = await core.claim(token, taskId);
  const evidence = { text: REVIEW, idempotencyKey: key() };
  return decision === 'accept' ? core.accept(token, proofOf(claim), evidence) : core.returnTask(token, proofOf(claim), evidence);
}

test('AC06 rework loop A->B->A->B: B returns the work to A, cannot claim the code, and the author set stays {A}', async () => {
  const t = await newTask('AC06 返工闭环');
  await deliver(tokens['eng-a'], t.id);
  await review(tokens['eng-b'], t.id, 'return');
  expect(await task(t.id)).toMatchObject({ state: 'ready', implementer: 't-eng-a' });
  // The returned code work is A's; B reviewed it and must not quietly take it over.
  await expect(core.claim(tokens['eng-b'], t.id)).rejects.toMatchObject({ code: 'forbidden' });
  await deliver(tokens['eng-a'], t.id);
  await review(tokens['eng-b'], t.id, 'accept');
  expect(await task(t.id)).toMatchObject({ state: 'done', implementer: 't-eng-a' });
  const facts = await workforce.contributors(t.id);
  expect(facts.authors).toEqual(['t-eng-a']);
  expect(facts.excluded).toEqual(['t-eng-a']);
  expect(facts.reviewers).toEqual(['t-eng-b']);
});

test('AC06 all authors excluded: A and B both wrote the task, neither may review it, and a controlled fourth engineer does', async () => {
  const t = await newTask('AC06 全员回避');
  await deliver(tokens['eng-a'], t.id);
  await review(tokens['eng-b'], t.id, 'return');
  // B is a reviewer, so the takeover needs a named replacement reviewer who is independent of every author.
  const taken = await core.implementerTakeover(tokens.owner, { taskId: t.id, toEmployee: 't-eng-b', replacementReviewer: 't-eng-c',
    expectedVersion: (await task(t.id)).version, reason: '经理指定 eng-b 接手代码，eng-c 作为独立复核人', idempotencyKey: key() });
  expect(taken).toMatchObject({ implementer: 't-eng-b', state: 'ready' });
  await deliver(tokens['eng-b'], t.id);
  await expect(core.claim(tokens['eng-a'], t.id)).rejects.toMatchObject({ code: 'self_review' });
  await expect(core.claim(tokens['eng-b'], t.id)).rejects.toMatchObject({ code: 'self_review' });
  await review(tokens['eng-c'], t.id, 'accept');
  expect(await task(t.id)).toMatchObject({ state: 'done', implementer: 't-eng-b' });
  const facts = await workforce.contributors(t.id);
  expect(facts.authors).toEqual(['t-eng-a', 't-eng-b']);
  expect(facts.excluded).toEqual(['t-eng-a', 't-eng-b']);
  expect(facts.reviewers).toEqual(['t-eng-c']);
});

test('AC06 concurrent first claims: exactly one employee wins and binds the implementer', async () => {
  const t = await newTask('AC06 并发认领');
  const results = await Promise.allSettled([core.claim(tokens['eng-a'], t.id), core.claim(tokens['eng-b'], t.id)]);
  const won = results.flatMap(r => r.status === 'fulfilled' ? [r.value] : []);
  const lost = results.flatMap(r => r.status === 'rejected' ? [r.reason as { code?: string }] : []);
  expect(won).toHaveLength(1);
  expect(lost).toHaveLength(1);
  expect(['already_claimed', 'forbidden', 'conflict']).toContain(lost[0]!.code ?? '');
  const holder = await task(t.id);
  expect(holder).toMatchObject({ state: 'doing' });
  const implementer = holder.implementer ?? '';
  expect(['t-eng-a', 't-eng-b']).toContain(implementer);
  expect(holder.currentEmployee).toBe(implementer);
  // Clean finish: the winner delivers, and the other engineer, who never wrote code, reviews and accepts.
  const winner = implementer === 't-eng-a' ? 'eng-a' : 'eng-b';
  const other = winner === 'eng-a' ? 'eng-b' : 'eng-a';
  await core.submit(tokens[winner]!, proofOf(won[0]!), { text: DELIVERY, idempotencyKey: key() });
  await review(tokens[other]!, t.id, 'accept');
  expect(await task(t.id)).toMatchObject({ state: 'done' });
});

test('AC06 two managers take over at once: one takeover lands on the version, the other sees it moved', async () => {
  const t = await newTask('AC06 双经理接手');
  await core.claim(tokens['eng-a'], t.id);
  await workforce.revokeLease(t.id, 't-eng-a', '会话额度耗尽（测试）', '【交接包】双经理接手前的最后状态');
  const before = await task(t.id);
  const expectedVersion = before.version;
  const results = await Promise.allSettled([
    core.implementerTakeover(tokens.owner, { taskId: t.id, toEmployee: 't-eng-b', expectedVersion, reason: 'gm 甲指定 eng-b 接手代码', idempotencyKey: key() }),
    core.implementerTakeover(tokens.owner2, { taskId: t.id, toEmployee: 't-eng-c', expectedVersion, reason: 'gm 乙指定 eng-c 接手代码', idempotencyKey: key() }),
  ]);
  const won = results.flatMap(r => r.status === 'fulfilled' ? [r.value] : []);
  const lost = results.flatMap(r => r.status === 'rejected' ? [r.reason as { code?: string }] : []);
  expect(won).toHaveLength(1);
  expect(lost).toHaveLength(1);
  expect(lost[0]!.code).toBe('conflict');
  expect(await task(t.id)).toMatchObject({ state: 'ready', implementer: won[0]!.implementer, version: expectedVersion + 1 });
});

test('AC06 implementer takeover refusals: wrong phase, wrong target, same implementer, stale version, author as replacement reviewer', async () => {
  const t = await newTask('AC06 接手拒绝');
  await deliver(tokens['eng-a'], t.id);
  // In review the task is not in the execute phase, so a takeover is refused as moved.
  await expect(core.implementerTakeover(tokens.owner, { taskId: t.id, toEmployee: 't-eng-b', expectedVersion: (await task(t.id)).version,
    reason: '审验阶段不可接手代码', idempotencyKey: key() })).rejects.toMatchObject({ code: 'conflict' });
  await review(tokens['eng-b'], t.id, 'return');
  const version = (await task(t.id)).version;
  await expect(core.implementerTakeover(tokens.owner, { taskId: t.id, toEmployee: 't-qa', expectedVersion: version,
    reason: 'qa 不能写工程代码', idempotencyKey: key() })).rejects.toMatchObject({ code: 'invalid' });
  await expect(core.implementerTakeover(tokens.owner, { taskId: t.id, toEmployee: 't-eng-a', expectedVersion: version,
    reason: '实现者本人重复接手', idempotencyKey: key() })).rejects.toMatchObject({ code: 'invalid' });
  // A stale expectedVersion is a CAS miss. The target must pass the static checks first (a current reviewer is refused as invalid before
  // the version is compared), so the stale case uses eng-c, who never reviewed or wrote the task.
  await expect(core.implementerTakeover(tokens.owner, { taskId: t.id, toEmployee: 't-eng-c', expectedVersion: version - 1,
    reason: '版本号过期的接手请求', idempotencyKey: key() })).rejects.toMatchObject({ code: 'conflict' });
  // B is a reviewer, so the replacement must be independent: A is an author and cannot be it.
  await expect(core.implementerTakeover(tokens.owner, { taskId: t.id, toEmployee: 't-eng-b', replacementReviewer: 't-eng-a',
    expectedVersion: version, reason: '替代复核人不能是作者', idempotencyKey: key() })).rejects.toMatchObject({ code: 'invalid' });
  expect(await task(t.id)).toMatchObject({ state: 'ready', implementer: 't-eng-a' });
});

test('AC04 (R4): a block raised in review does not open the execute-phase takeover; a block raised in execute does', async () => {
  // Blocked in review: the phase that resumes is review, so a manager's takeover of code is refused and the bound implementer stays.
  const inReview = await newTask('AC04 复核阶段阻塞不可接手');
  await deliver(tokens['eng-a'], inReview.id);
  const reviewClaim = await core.claim(tokens['eng-b'], inReview.id);
  await core.block(tokens['eng-b'], proofOf(reviewClaim), 'owner', { text: 'SYNTHETIC review-phase block for the AC04 takeover refusal.', idempotencyKey: key() });
  const blocked = await task(inReview.id);
  expect(blocked).toMatchObject({ state: 'blocked', implementer: 't-eng-a' });
  await expect(core.implementerTakeover(tokens.owner, { taskId: inReview.id, toEmployee: 't-eng-c', expectedVersion: blocked.version,
    reason: 'SYNTHETIC takeover of a review-phase block, must be refused', idempotencyKey: key() })).rejects.toMatchObject({ code: 'conflict' });
  expect(await task(inReview.id)).toMatchObject({ state: 'blocked', implementer: 't-eng-a', version: blocked.version });
  // Blocked in execute: the phase that resumes is execute, so the same takeover is allowed.
  const inExecute = await newTask('AC04 执行阶段阻塞可接手');
  const first = await core.claim(tokens['eng-a'], inExecute.id);
  await core.block(tokens['eng-a'], proofOf(first), 'owner', { text: 'SYNTHETIC execute-phase block for the AC04 takeover allowance.', idempotencyKey: key() });
  const taken = await core.implementerTakeover(tokens.owner, { taskId: inExecute.id, toEmployee: 't-eng-b', expectedVersion: (await task(inExecute.id)).version,
    reason: 'SYNTHETIC takeover of an execute-phase block, allowed', idempotencyKey: key() });
  expect(taken).toMatchObject({ implementer: 't-eng-b', state: 'blocked' });
});

test('implementer takeover refuses a target bound to another goal workspace: it could never be dispatched the task', async () => {
  const t = await newTask('跨目标工作区接手');
  await deliver(tokens['eng-a'], t.id);
  await review(tokens['eng-b'], t.id, 'return');
  const version = (await task(t.id)).version;
  await database.db.query("UPDATE employee:⟨t-eng-c⟩ SET workspace_scope = 'other-goal';");
  try {
    await expect(core.implementerTakeover(tokens.owner, { taskId: t.id, toEmployee: 't-eng-c', expectedVersion: version,
      reason: '目标工作区不一致的接手', idempotencyKey: key() })).rejects.toMatchObject({ code: 'invalid' });
    expect(await task(t.id)).toMatchObject({ implementer: 't-eng-a' });
    // The same employee in the task's own workspace (no goal: maintenance) is accepted.
    await database.db.query("UPDATE employee:⟨t-eng-c⟩ SET workspace_scope = 'maintenance';");
    await expect(core.implementerTakeover(tokens.owner, { taskId: t.id, toEmployee: 't-eng-c', expectedVersion: version,
      reason: '同一工作区的接手', idempotencyKey: key() })).resolves.toMatchObject({ implementer: 't-eng-c' });
  } finally {
    await database.db.query('UPDATE employee:⟨t-eng-c⟩ SET workspace_scope = NONE;');
  }
});


test('takeover refuses a different repository and a retired successor without changing the task', async () => {
  const t = await newTask('同目标错误仓库接手回归');
  await database.db.query("UPDATE employee:⟨t-eng-c⟩ SET workspace_repo = '/wrong-repo'; UPDATE ONLY $task SET code_repo_path = '/right-repo';", {task: new RecordId('task',t.id)});
  try {
    for (const system of [false, true]) {
      const input = {taskId:t.id,toEmployee:'t-eng-c',expectedVersion:t.version,reason:'错误仓库不能成为接手负责人',idempotencyKey:key()};
      await expect(system ? core.systemImplementerTakeover(input) : core.implementerTakeover(tokens.owner,input)).rejects.toMatchObject({code:'invalid'});
      expect((await task(t.id)).version).toBe(t.version);
    }
    await database.db.query("UPDATE employee:⟨t-eng-c⟩ SET workspace_repo = '/right-repo', retired = true;");
    await expect(core.implementerTakeover(tokens.owner,{taskId:t.id,toEmployee:'t-eng-c',expectedVersion:t.version,reason:'退役员工不能成为接手负责人',idempotencyKey:key()})).rejects.toMatchObject({code:'invalid'});
  } finally { await database.db.query('UPDATE employee:⟨t-eng-c⟩ SET workspace_repo = NONE, retired = false;'); }
});


test('independent cleanup is gated atomically at creation, claim and both takeover paths', async () => {
  const source = await newTask('原执行人的补偿核查来源');
  await deliver(tokens['eng-a'],source.id);
  const t = await core.createTask(tokens.owner,{title:'独立核查原任务',context:'结构化隔离，不依赖员工阅读正文',executorRole:'engineering',reviewerRole:'qa',workIntent:{kind:'read'},
    independence:{stages:['execute'],sources:[source.id],mode:'execute_handlers',reason:'原执行人不得复核自己的操作'},idempotencyKey:key()});
  expect(t.independence).toMatchObject({revision:1,sources:[source.id],stages:['execute']});
  await expect(core.claim(tokens['eng-a'],t.id)).rejects.toMatchObject({code:'forbidden'});
  for(const system of [false,true]) {
    const input={taskId:t.id,toEmployee:'t-eng-a',expectedVersion:t.version,reason:'禁止通过接手绕过独立性约束',idempotencyKey:key()};
    await expect(system?core.systemImplementerTakeover(input):core.implementerTakeover(tokens.owner,input)).rejects.toMatchObject({code:'forbidden'});
  }
  expect((await task(t.id)).version).toBe(t.version);
  const moved=await core.implementerTakeover(tokens.owner,{taskId:t.id,toEmployee:'t-eng-c',expectedVersion:t.version,reason:'交给未参与源任务的独立工程员工',idempotencyKey:key()});
  const auto=await core.createTask(tokens.owner,{title:'系统接替也须执行来源栅栏',context:'自动接替事务实测',executorRole:'engineering',reviewerRole:'qa',independence:{stages:['execute'],sources:[source.id],mode:'execute_handlers',reason:'系统接替同样隔离来源作者'},idempotencyKey:key()});
  await expect(core.systemImplementerTakeover({taskId:auto.id,toEmployee:'t-eng-b',expectedVersion:auto.version,reason:'交给无来源贡献的合法独立员工'})).resolves.toMatchObject({implementer:'t-eng-b'});
  const [sourceGuard]=await database.db.query<[number]>('RETURN (SELECT VALUE independence_guard FROM ONLY $source);',{source:new RecordId('task',source.id)});
  expect(sourceGuard).toBe((await task(source.id)).version);
  expect(moved.implementer).toBe('t-eng-c');
  await expect(core.claim(tokens['eng-c'],t.id)).resolves.toMatchObject({task:{state:'doing',implementer:'t-eng-c'}});
});

test('invalid independent source refuses creation without leaking a runnable task',async()=>{
 const title='不存在来源不得创建可抢领的独立任务';
 await expect(core.createTask(tokens.owner,{title,context:'不存在来源',executorRole:'engineering',reviewerRole:'qa',independence:{stages:['execute'],sources:['missing-source'],mode:'execute_handlers',reason:'必须存在来源'},idempotencyKey:key()})).rejects.toMatchObject({code:'invalid'});
 const [rows]=await database.db.query<[unknown[]]>('SELECT id FROM task WHERE title=$title;',{title});
 expect(rows).toEqual([]);
});

test('direct claim cannot bypass repository routing even with a matching role',async()=>{
 const t=await newTask('直接领取也遵守仓库资格');
 await database.db.query("UPDATE employee:⟨t-eng-c⟩ SET workspace_repo='/wrong-repo'; UPDATE ONLY $task SET code_repo_path='/right-repo';",{task:new RecordId('task',t.id)});
 try{ await expect(core.claim(tokens['eng-c'],t.id)).rejects.toMatchObject({code:'forbidden'}); }
 finally{ await database.db.query('UPDATE employee:⟨t-eng-c⟩ SET workspace_repo=NONE;'); }
 expect((await task(t.id)).state).toBe('ready');
});


test('source changes after admission refuse both takeover transactions without binding a stale successor',async()=>{
 const source=await newTask('接手来源版本并发变化');
 const t=await core.createTask(tokens.owner,{title:'异人接手版本栅栏',context:'source变化拒绝陈旧授权',executorRole:'engineering',reviewerRole:'qa',independence:{stages:['execute'],sources:[source.id],mode:'execute_handlers',reason:'来源贡献必须在提交时仍有效'},idempotencyKey:key()});
 const racing=new SurrealCompanyCore(database,{workforce,contributionReadHook:async()=>{await database.db.query('UPDATE ONLY $source SET version += 1;',{source:new RecordId('task',source.id)});}});
 for(const system of [false,true]){
  const input={taskId:t.id,toEmployee:'t-eng-b',expectedVersion:t.version,reason:'并发来源修改必须拒绝整笔接手',idempotencyKey:key()};
  await expect(system?racing.systemImplementerTakeover(input):racing.implementerTakeover(tokens.owner,input)).rejects.toMatchObject({code:'conflict'});
  expect(await task(t.id)).toMatchObject({version:t.version,state:'ready'});
  expect((await task(t.id)).implementer).toBeUndefined();
 }
});
