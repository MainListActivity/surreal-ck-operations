import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordId } from 'surrealdb';
import { loadDatabaseConfig } from '../src/config.ts';
import { CompanyDatabase } from '../src/database.ts';
import { SurrealCompanyCore } from '../src/core.ts';
import { LocalEnrollmentAdmin } from '../src/enrollment.ts';
import { OwnerDesk } from '../src/owner.ts';
import { Workforce } from '../src/workforce.ts';
import type { ClaimResult, CreateTask, TaskView } from '../src/contracts.ts';

// Screenplay-revision edges: a real owner rejection lets gm/product atomically supersede an
// owner-reviewed screenwriter draft with its next version; normal dependents on ANY version of
// the lineage resolve to the chain tip and stay blocked until the owner approves the tip.
const NS = 'sck_agent_company_test_scr';
const database = new CompanyDatabase({ ...loadDatabaseConfig(), namespace: NS, database: 'control_plane' });
setDefaultTimeout(120_000);
const credDir = mkdtempSync(join(tmpdir(), 'sck-scr-test-'));
const workforce = new Workforce(database, credDir);
const core = new SurrealCompanyCore(database, { workforce });
const enrollment = new LocalEnrollmentAdmin(database);
const owner = new OwnerDesk(database);
const tokens: Record<string, string> = {};
let swToken = '';

beforeAll(async () => {
  await database.connect();
  await database.db.query(`DEFINE NAMESPACE IF NOT EXISTS ${NS};`);
  await database.db.use({ namespace: NS });
  await database.db.query('REMOVE DATABASE IF EXISTS control_plane;');
  await database.bootstrap();
  for (const [name, role, caps] of [
    ['owner', 'owner', ['execute', 'review', 'manage']],
    ['product', 'product', ['execute', 'review', 'manage']],
    ['eng', 'engineering', ['execute', 'review']],
    ['qa', 'qa', ['execute', 'review']],
  ] as const) tokens[name] = await enrollment.enroll(`scr-${name}`, role, caps);
  await workforce.upsertDef('sw-codex', { role: 'screenwriter', provider: 'codex', model: 'fixture', tracks: ['编剧'] });
  const inst = await workforce.spawnInst((await workforce.defs()).find(d => d.id === 'sw-codex')!);
  swToken = inst.credential!;
});

afterAll(async () => {
  await database.close();
  rmSync(credDir, { recursive: true, force: true });
});

const key = () => crypto.randomUUID();
const proofOf = (c: ClaimResult | { task: TaskView; deliveryId: string; fence: number }) =>
  ({ taskId: c.task.id, deliveryId: c.deliveryId, fence: c.fence, expectedVersion: c.task.version });
const task = (id: string) => core.getTask(tokens.owner, id);
const auditActions = async (taskId: string) => {
  const [rows] = await database.db.query<[Array<{ action: string }>]>(
    'SELECT action FROM audit WHERE task = $t;', { t: new RecordId('task', taskId) });
  return rows.map(r => r.action);
};
const outboxKinds = async (taskId: string) => {
  const [rows] = await database.db.query<[Array<{ kind: string }>]>(
    'SELECT kind FROM outbox WHERE task = $t;', { t: new RecordId('task', taskId) });
  return rows.map(r => r.kind);
};

const draft = (title: string, goalId?: string) => core.createTask(tokens.owner, {
  title, context: '剧本稿：分场大纲、角色小传与对白初稿。', executorRole: 'screenwriter', reviewerRole: 'owner',
  discipline: '编剧', goalId, idempotencyKey: key(),
});
const revise = (token: string, input: Partial<CreateTask> & { revises: string; title: string }) =>
  core.createTask(token, {
    context: '修订要点：按老板驳回意见逐条修订，重写动机线并补角色小传。',
    executorRole: 'screenwriter', reviewerRole: 'owner', discipline: '编剧', idempotencyKey: key(),
    ...input,
  });
const mass = (deps: string[], goalId?: string) => core.createTask(tokens.owner, {
  title: '量产分镜', context: '依赖剧本稿的铺量产出任务。', executorRole: 'asset-production',
  reviewerRole: 'owner', dependencies: deps, goalId, idempotencyKey: key(),
});
const submitDraft = async (taskId: string, token = swToken) => {
  const claim = await core.claim(token, taskId);
  return core.submit(token, proofOf(claim), { text: '剧本稿交付：分场大纲、对白与角色小传完成。', idempotencyKey: key() });
};
const reject = (taskId: string) => owner.decide({ taskId, decision: 'reject', note: '老板驳回：第二幕动机不足。', source: 'owner:test', key: key() });
const approve = (taskId: string) => owner.decide({ taskId, decision: 'approve', note: '老板批准。', source: 'owner:test', key: key() });

test('a+b: real owner rejection opens the controlled revision edge; dependents on any version wait for the tip', async () => {
  const v1 = await draft('动画剧本 v1');
  const before = await mass([v1.id]); // dependent existed before the supersede
  expect(before.state).toBe('blocked');

  // No legal edge before a real rejection: not submitted yet, then pending review.
  await expect(revise(tokens.owner, { revises: v1.id, title: '动画剧本 v2' })).rejects.toThrow();
  await submitDraft(v1.id);
  await expect(revise(tokens.owner, { revises: v1.id, title: '动画剧本 v2' })).rejects.toThrow();
  await reject(v1.id);
  expect((await task(v1.id)).state).toBe('ready');
  // Both genuine events may fall within one JS millisecond. Keep the database's ns ordering.
  await database.db.query(`UPDATE audit SET at=<datetime>'2026-01-01T00:00:00.123000001Z' WHERE task=$task AND action='submit';
    UPDATE audit SET at=<datetime>'2026-01-01T00:00:00.123000002Z' WHERE task=$task AND action='owner_reject';`,{task:new RecordId('task',v1.id)});

  // Legal revision: same call is idempotent, product could do it too.
  const v2 = await revise(tokens.owner, { revises: v1.id, title: '动画剧本 v2' });
  expect(v2).toMatchObject({ state: 'ready', revises: v1.id, lineage: v1.id, revisionNo: 2 });
  expect((await task(v1.id))).toMatchObject({ state: 'void', supersededBy: v2.id });
  expect(await auditActions(v1.id)).toContain('superseded');
  expect(await auditActions(v1.id)).not.toContain('accept');
  expect(await outboxKinds(v1.id)).toContain('superseded');
  // The service stamps the lineage + real rejection audit into context.
  const v2full = await task(v2.id);
  expect(v2full.context).toContain(`谱系：task:${v1.id}`);
  expect(v2full.context).toMatch(/驳回审计：audit:/);

  // Dependents on the old id, on the new id, on both, or created after the supersede all
  // resolve to the unapproved tip and stay blocked; claim refuses.
  expect((await task(before.id)).state).toBe('blocked');
  const afterOld = await mass([v1.id]);
  const afterNew = await mass([v2.id]);
  const both = await mass([v1.id, v2.id]);
  for (const m of [afterOld, afterNew, both]) expect(m.state).toBe('blocked');
  await expect(core.claim(tokens.eng, before.id)).rejects.toThrow();
  const resumed = await core.resume(tokens.owner, before.id, { text: '经理复核：依赖解析到谱系最新版，仍等老板批准新稿。', idempotencyKey: key() });
  expect(resumed.state).toBe('blocked');

  // A revision carrying its own unfinished dependency starts blocked and unlocks through it.
  const gate = await core.createTask(tokens.owner, { title: '分镜风格确认', context: '工程小任务：确认分镜风格基线后再放行。', executorRole: 'engineering', reviewerRole: 'owner', idempotencyKey: key() });
  const w1 = await draft('短片剧本 v1');
  await submitDraft(w1.id);
  await reject(w1.id);
  const w2 = await revise(tokens.product, { revises: w1.id, title: '短片剧本 v2', dependencies: [gate.id] });
  expect(w2.state).toBe('blocked');
  const gc = await core.claim(tokens.eng, gate.id);
  await core.submit(tokens.eng, proofOf(gc), { text: '风格确认完成：基线纪要已产出并同步给经理验收。', idempotencyKey: key() });
  const gr = await core.claim(tokens.owner, gate.id);
  await core.accept(tokens.owner, proofOf(gr), { text: '验收通过：风格基线纪要完整可用，可以放行后续剧本修订。', idempotencyKey: key() });
  expect((await task(w2.id)).state).toBe('ready');

  // Owner approves the tip: every dependent on any lineage version unlocks.
  await submitDraft(v2.id);
  await approve(v2.id);
  for (const m of [before, afterOld, afterNew, both]) expect((await task(m.id)).state).toBe('ready');
});

test('c: v1→v2→v3 chain keeps dependents of every version blocked until the owner approves v3', async () => {
  const w1 = await draft('连载剧本 v1');
  await submitDraft(w1.id);
  await reject(w1.id);
  const depV1 = await mass([w1.id]);
  const w2 = await revise(tokens.owner, { revises: w1.id, title: '连载剧本 v2' });
  await submitDraft(w2.id);
  await reject(w2.id);
  const depV2 = await mass([w2.id]);
  const w3 = await revise(tokens.owner, { revises: w2.id, title: '连载剧本 v3' });
  const depV3 = await mass([w3.id]);
  const depMixed = await mass([w1.id, w3.id]);

  expect(w3).toMatchObject({ revises: w2.id, lineage: w1.id, revisionNo: 3 });
  expect((await task(w1.id))).toMatchObject({ state: 'void', supersededBy: w2.id });
  expect((await task(w2.id))).toMatchObject({ state: 'void', supersededBy: w3.id });
  for (const m of [depV1, depV2, depV3, depMixed]) expect(m.state).toBe('blocked');
  await expect(core.claim(tokens.eng, depV2.id)).rejects.toThrow();

  // Only a real owner approve on the tip releases the whole fan-out.
  await submitDraft(w3.id);
  await approve(w3.id);
  for (const m of [depV1, depV2, depV3, depMixed]) expect((await task(m.id)).state).toBe('ready');
});

test('d: every illegal revision shape is refused; owner void without a pointer never satisfies', async () => {
  const v1 = await draft('正剧剧本 v1');
  await submitDraft(v1.id);
  await reject(v1.id);

  // actor/capability: an executor with no manage capability cannot create a revision edge.
  await expect(revise(tokens.eng, { revises: v1.id, title: '正剧剧本 v2' })).rejects.toThrow();
  // input shape: wrong executor / reviewer / track / kind.
  await expect(revise(tokens.owner, { revises: v1.id, title: '正剧剧本 v2', executorRole: 'engineering' as never })).rejects.toThrow();
  await expect(revise(tokens.owner, { revises: v1.id, title: '正剧剧本 v2', reviewerRole: 'owner' as never })).rejects.toThrow();
  await expect(revise(tokens.owner, { revises: v1.id, title: '正剧剧本 v2', discipline: '美术' })).rejects.toThrow();
  await expect(revise(tokens.owner, { revises: v1.id, title: '正剧剧本 v2', kind: 'gate' })).rejects.toThrow();
  // target shape: an M-section (gm-reviewed) screenplay draft is not an owner draft.
  const mDraft = await core.createTask(tokens.owner, { title: '量产剧本 v1', context: '量产剧本文稿：M 段走 GM 验收的铺量剧本。', executorRole: 'screenwriter', reviewerRole: 'owner', discipline: '编剧', idempotencyKey: key() });
  await expect(revise(tokens.owner, { revises: mDraft.id, title: '量产剧本 v2' })).rejects.toThrow();
  // goal boundary: a revision must stay in the same goal.
  const goal = await owner.createGoal({ text: '独立剧本目标', source: 'owner:test', key: key(), tier: 'quick' });
  const g1 = await draft('目标内剧本 v1', goal.id);
  await submitDraft(g1.id);
  await reject(g1.id);
  await expect(revise(tokens.owner, { revises: g1.id, title: '目标内剧本 v2' })).rejects.toThrow();
  await expect(revise(tokens.owner, { revises: v1.id, title: '正剧剧本 v2', goalId: goal.id })).rejects.toThrow();
  // version marker and lineage-dep guards.
  await expect(revise(tokens.owner, { revises: v1.id, title: '正剧剧本' })).rejects.toThrow();
  await expect(revise(tokens.owner, { revises: v1.id, title: '正剧剧本 v2', dependencies: [v1.id] })).rejects.toThrow();
  // never-submitted draft, then a fabricated non-owner 'return' audit: still no legal edge.
  const fresh = await draft('冷启动剧本 v1');
  await expect(revise(tokens.owner, { revises: fresh.id, title: '冷启动剧本 v2' })).rejects.toThrow();
  await submitDraft(fresh.id);
  await database.db.query(
    "CREATE audit CONTENT { task: $t, actor: $a, action: 'return', evidence: '伪造员工退回意见', version: 2, at: time::now() };",
    { t: new RecordId('task', fresh.id), a: new RecordId('employee', 'scr-gm') });
  await database.db.query("UPDATE $t SET state = 'ready';", { t: new RecordId('task', fresh.id) });
  await expect(revise(tokens.owner, { revises: fresh.id, title: '冷启动剧本 v2' })).rejects.toThrow();
  // resubmitted pending-review and approved drafts cannot be superseded.
  const pend = await draft('待定剧本 v1');
  await submitDraft(pend.id);
  await reject(pend.id);
  await submitDraft(pend.id);
  expect((await task(pend.id)).state).toBe('review');
  await expect(revise(tokens.owner, { revises: pend.id, title: '待定剧本 v2' })).rejects.toThrow();
  const done = await draft('已批剧本 v1');
  await submitDraft(done.id);
  await approve(done.id);
  await expect(revise(tokens.owner, { revises: done.id, title: '已批剧本 v2' })).rejects.toThrow();
  // already superseded tip refuses a second edge.
  const sup = await draft('双重剧本 v1');
  await submitDraft(sup.id);
  await reject(sup.id);
  await revise(tokens.owner, { revises: sup.id, title: '双重剧本 v2' });
  await expect(revise(tokens.owner, { revises: sup.id, title: '双重剧本 v2' })).rejects.toThrow();

  // owner void without a superseded_by pointer never satisfies dependents (legacy/corrupt
  // fixture: retire would refuse while a live non-anchor dependent still points at it).
  const orphan = await core.createTask(tokens.owner, { title: '老板关口原型', context: '概念原型：P 段老板 demo 验收素材稿。', executorRole: 'concept-design', reviewerRole: 'owner', idempotencyKey: key() });
  const dep = await mass([orphan.id]);
  await database.db.query("UPDATE $t SET state = 'void';", { t: new RecordId('task', orphan.id) });
  expect((await task(orphan.id)).state).toBe('void');
  expect((await task(dep.id)).state).toBe('blocked');
  // bypass attempt: a mass-production task depending on the void draft is never created ready.
  const bypass = await mass([v1.id]);
  expect(bypass.state).toBe('blocked');
  const bypassMixed = await mass([orphan.id, dep.id]);
  expect(bypassMixed.state).toBe('blocked');
});

test('e: idempotency, concurrency, fences, corrupt chains, anchor rollup and ordinary void semantics', async () => {
  // Idempotent replay returns the same revision; same key with a different payload conflicts.
  const v1 = await draft('幂等剧本 v1');
  await submitDraft(v1.id);
  await reject(v1.id);
  const idemKey = key();
  const first = await revise(tokens.owner, { revises: v1.id, title: '幂等剧本 v2', idempotencyKey: idemKey });
  const again = await revise(tokens.owner, { revises: v1.id, title: '幂等剧本 v2', idempotencyKey: idemKey });
  expect(again.id).toBe(first.id);
  await expect(revise(tokens.owner, { revises: v1.id, title: '幂等剧本 v9', idempotencyKey: idemKey })).rejects.toThrow();

  // Two concurrent revisions of the same tip: exactly one wins, the tip has one successor.
  const c1 = await draft('竞态剧本 v1');
  await submitDraft(c1.id);
  await reject(c1.id);
  const results = await Promise.allSettled([
    revise(tokens.owner, { revises: c1.id, title: '竞态剧本 v2', context: '修订要点 A：按老板意见重写开场动机线并铺垫转折。' }),
    revise(tokens.owner, { revises: c1.id, title: '竞态剧本 v2', context: '修订要点 B：按老板意见重写结尾动机线并回收伏笔。' }),
  ]);
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  const cw = await task(c1.id);
  expect(cw.state).toBe('void');
  expect(cw.supersededBy).toBeDefined();

  // Approve/supersede race: exactly one lands, the draft ends consistently terminal.
  const race = await draft('竞批剧本 v1');
  await submitDraft(race.id);
  const [approved, revised] = await Promise.allSettled([
    approve(race.id),
    revise(tokens.owner, { revises: race.id, title: '竞批剧本 v2' }),
  ]);
  expect([approved.status, revised.status].filter(s => s === 'fulfilled')).toHaveLength(1);
  const raceNow = await task(race.id);
  if (revised.status === 'fulfilled') {
    expect(raceNow).toMatchObject({ state: 'void', supersededBy: (revised as PromiseFulfilledResult<TaskView>).value.id });
  } else {
    expect(raceNow.state).toBe('done');
  }

  // Supersede kills the old lease: the previous holder's fence can no longer write.
  const held = await draft('作废剧本 v1');
  const stale = await core.claim(swToken, held.id);
  await core.submit(swToken, proofOf(stale), { text: '初稿提交，等待老板对第一幕节奏与人物动机给出验收意见。', idempotencyKey: key() });
  await reject(held.id);
  const reclaim = await core.claim(swToken, held.id);
  await revise(tokens.owner, { revises: held.id, title: '作废剧本 v2' });
  expect((await task(held.id)).state).toBe('void');
  await expect(core.submit(swToken, proofOf(reclaim), { text: '旧租约 fence 已随取代失效，不应再能写入交付。', idempotencyKey: key() })).rejects.toThrow();
  await expect(core.checkpoint(swToken, proofOf(reclaim), { text: '旧租约 checkpoint 同样因 fence 失效被拒。', idempotencyKey: key() })).rejects.toThrow();

  // Corrupt lineage stays conservatively blocked (no unbounded traversal, no bypass).
  const corruptId = crypto.randomUUID();
  const cycleA = crypto.randomUUID();
  const cycleB = crypto.randomUUID();
  await database.db.query(`
    CREATE ONLY $a CONTENT { title: '环A', context: 'x', executor_role: 'screenwriter', reviewer_role: 'owner',
      discipline: '编剧', dependencies: [], state: 'void', version: 1, fence: 0, kind: 'task',
      superseded_by: $b, lineage: $a, created_at: time::now() };
    CREATE ONLY $b CONTENT { title: '环B', context: 'x', executor_role: 'screenwriter', reviewer_role: 'owner',
      discipline: '编剧', dependencies: [], state: 'void', version: 1, fence: 0, kind: 'task',
      superseded_by: $a, lineage: $a, created_at: time::now() };
    CREATE ONLY $n CONTENT { title: '断链', context: 'x', executor_role: 'screenwriter', reviewer_role: 'owner',
      discipline: '编剧', dependencies: [], state: 'void', version: 1, fence: 0, kind: 'task',
      superseded_by: $b, created_at: time::now() };`,
    { a: new RecordId('task', cycleA), b: new RecordId('task', cycleB), n: new RecordId('task', corruptId) });
  const cycDep = await mass([cycleA]);
  const noLineageDep = await mass([corruptId]);
  expect(cycDep.state).toBe('blocked');
  expect(noLineageDep.state).toBe('blocked');
  // A fresh core on the same DB resolves identically (restart/replay consistency).
  const core2 = new SurrealCompanyCore(database, { workforce });
  const reDep = await core2.createTask(tokens.owner, { title: '重启视角量产', context: '依赖环上旧稿的量产任务应保持保守阻塞。', executorRole: 'asset-production', reviewerRole: 'owner', dependencies: [cycleA], idempotencyKey: key() });
  expect(reDep.state).toBe('blocked');
  const resumedCyc = await core2.resume(tokens.owner, cycDep.id, { text: '重评环上依赖：损坏谱系按保守规则仍应保持阻塞。', idempotencyKey: key() });
  expect(resumedCyc.state).toBe('blocked');

  // Anchor rollup regression: a goal-anchor dependent treats an owner void as satisfied,
  // while a live non-anchor dependent still blocks retiring the owner gate and its tip.
  const goal = await owner.createGoal({ text: '带锚点目标', source: 'owner:test', key: key(), tier: 'quick' });
  const gate = await core.createTask(tokens.owner, { title: '目标内原型', context: '概念原型：P 段老板 demo 验收素材稿。', executorRole: 'concept-design', reviewerRole: 'owner', goalId: goal.id, idempotencyKey: key() });
  const live = await core.createTask(tokens.owner, { title: '目标内量产', context: '依赖原型任务，老板批准前不得开工。', executorRole: 'asset-production', reviewerRole: 'owner', goalId: goal.id, dependencies: [gate.id], idempotencyKey: key() });
  await expect(core.retireTask(tokens.owner, { taskId: gate.id, text: '尝试作废仍有存活下游的老板关口任务，应被拒绝。', idempotencyKey: key() })).rejects.toThrow();
  const anchorDep = await core.createTask(tokens.owner, { title: '目标锚点汇总', context: '目标锚点汇总：rollup 簿记任务。', executorRole: 'product', reviewerRole: 'owner', goalId: goal.id, dependencies: [gate.id], idempotencyKey: key() });
  await database.db.query('UPDATE $g SET anchors = array::union(anchors ?? [], [$t]);', { g: new RecordId('goal', goal.id), t: new RecordId('task', anchorDep.id) });
  await core.retireTask(tokens.owner, { taskId: live.id, text: '先作废存活的下游任务，再放行关口任务作废。', idempotencyKey: key() });
  await core.retireTask(tokens.owner, { taskId: gate.id, text: '作废老板关口：锚点汇总任务按 rollup 规则应放行解锁。', idempotencyKey: key() });
  expect((await task(gate.id)).state).toBe('void');
  expect((await task(anchorDep.id)).state).toBe('ready');

  // Ordinary non-owner void still satisfies dependents (unchanged baseline semantics).
  const ordinary = await core.createTask(tokens.owner, { title: '普通前置', context: '普通前置任务：非老板验收的依赖前置。', executorRole: 'engineering', reviewerRole: 'owner', idempotencyKey: key() });
  const follower = await mass([ordinary.id]);
  expect(follower.state).toBe('blocked');
  await core.retireTask(tokens.owner, { taskId: ordinary.id, text: '作废普通前置任务：下游应按普通 void 规则解锁。', idempotencyKey: key() });
  expect((await task(follower.id)).state).toBe('ready');
});
