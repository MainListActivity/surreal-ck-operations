import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    ['gm', 'gm', ['execute', 'review', 'manage']], ['gm2', 'gm', ['execute', 'review', 'manage']],
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
const task = async (id: string) => core.getTask(tokens.gm, id);
const DELIVERY = 'Synthetic delivery evidence for the AC06 implementer binding test.';
const REVIEW = 'Independent synthetic review evidence for the AC06 implementer binding test.';
const newTask = (title: string) => core.createTask(tokens.gm, { title, context: 'synthetic AC06 case', executorRole: 'engineering',
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
  const taken = await core.implementerTakeover(tokens.gm, { taskId: t.id, toEmployee: 't-eng-b', replacementReviewer: 't-eng-c',
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
    core.implementerTakeover(tokens.gm, { taskId: t.id, toEmployee: 't-eng-b', expectedVersion, reason: 'gm 甲指定 eng-b 接手代码', idempotencyKey: key() }),
    core.implementerTakeover(tokens.gm2, { taskId: t.id, toEmployee: 't-eng-c', expectedVersion, reason: 'gm 乙指定 eng-c 接手代码', idempotencyKey: key() }),
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
  await expect(core.implementerTakeover(tokens.gm, { taskId: t.id, toEmployee: 't-eng-b', expectedVersion: (await task(t.id)).version,
    reason: '审验阶段不可接手代码', idempotencyKey: key() })).rejects.toMatchObject({ code: 'conflict' });
  await review(tokens['eng-b'], t.id, 'return');
  const version = (await task(t.id)).version;
  await expect(core.implementerTakeover(tokens.gm, { taskId: t.id, toEmployee: 't-qa', expectedVersion: version,
    reason: 'qa 不能写工程代码', idempotencyKey: key() })).rejects.toMatchObject({ code: 'invalid' });
  await expect(core.implementerTakeover(tokens.gm, { taskId: t.id, toEmployee: 't-eng-a', expectedVersion: version,
    reason: '实现者本人重复接手', idempotencyKey: key() })).rejects.toMatchObject({ code: 'invalid' });
  // A stale expectedVersion is a CAS miss. The target must pass the static checks first (a current reviewer is refused as invalid before
  // the version is compared), so the stale case uses eng-c, who never reviewed or wrote the task.
  await expect(core.implementerTakeover(tokens.gm, { taskId: t.id, toEmployee: 't-eng-c', expectedVersion: version - 1,
    reason: '版本号过期的接手请求', idempotencyKey: key() })).rejects.toMatchObject({ code: 'conflict' });
  // B is a reviewer, so the replacement must be independent: A is an author and cannot be it.
  await expect(core.implementerTakeover(tokens.gm, { taskId: t.id, toEmployee: 't-eng-b', replacementReviewer: 't-eng-a',
    expectedVersion: version, reason: '替代复核人不能是作者', idempotencyKey: key() })).rejects.toMatchObject({ code: 'invalid' });
  expect(await task(t.id)).toMatchObject({ state: 'ready', implementer: 't-eng-a' });
});

test('AC04 (R4): a block raised in review does not open the execute-phase takeover; a block raised in execute does', async () => {
  // Blocked in review: the phase that resumes is review, so a manager's takeover of code is refused and the bound implementer stays.
  const inReview = await newTask('AC04 复核阶段阻塞不可接手');
  await deliver(tokens['eng-a'], inReview.id);
  const reviewClaim = await core.claim(tokens['eng-b'], inReview.id);
  await core.block(tokens['eng-b'], proofOf(reviewClaim), 'gm', { text: 'SYNTHETIC review-phase block for the AC04 takeover refusal.', idempotencyKey: key() });
  const blocked = await task(inReview.id);
  expect(blocked).toMatchObject({ state: 'blocked', implementer: 't-eng-a' });
  await expect(core.implementerTakeover(tokens.gm, { taskId: inReview.id, toEmployee: 't-eng-c', expectedVersion: blocked.version,
    reason: 'SYNTHETIC takeover of a review-phase block, must be refused', idempotencyKey: key() })).rejects.toMatchObject({ code: 'conflict' });
  expect(await task(inReview.id)).toMatchObject({ state: 'blocked', implementer: 't-eng-a', version: blocked.version });
  // Blocked in execute: the phase that resumes is execute, so the same takeover is allowed.
  const inExecute = await newTask('AC04 执行阶段阻塞可接手');
  const first = await core.claim(tokens['eng-a'], inExecute.id);
  await core.block(tokens['eng-a'], proofOf(first), 'gm', { text: 'SYNTHETIC execute-phase block for the AC04 takeover allowance.', idempotencyKey: key() });
  const taken = await core.implementerTakeover(tokens.gm, { taskId: inExecute.id, toEmployee: 't-eng-b', expectedVersion: (await task(inExecute.id)).version,
    reason: 'SYNTHETIC takeover of an execute-phase block, allowed', idempotencyKey: key() });
  expect(taken).toMatchObject({ implementer: 't-eng-b', state: 'blocked' });
});
