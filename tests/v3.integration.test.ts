import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordId } from 'surrealdb';
import { loadDatabaseConfig } from '../src/config.ts';
import { CompanyDatabase } from '../src/database.ts';
import { SurrealCompanyCore } from '../src/core.ts';
import { LocalEnrollmentAdmin } from '../src/enrollment.ts';
import { OwnerDesk } from '../src/owner.ts';
import { Workforce } from '../src/workforce.ts';
import { ProjectStore } from '../src/projects.ts';
import { Dispatcher } from '../src/dispatcher/dispatcher.ts';
import type { PaseoGateway, SpawnInput } from '../src/dispatcher/paseo.ts';
import type { ClaimResult, TaskView } from '../src/contracts.ts';
import type { JevClient } from '../src/dispatcher/jev.ts';

const NS = 'sck_agent_company_test_v3';
const database = new CompanyDatabase({ ...loadDatabaseConfig(), namespace: NS, database: 'control_plane' });
setDefaultTimeout(180_000);
const core = new SurrealCompanyCore(database);
const enrollment = new LocalEnrollmentAdmin(database);
const owner = new OwnerDesk(database);
const credDir = mkdtempSync(join(tmpdir(), 'sck-v3-test-'));
const workforce = new Workforce(database, credDir);
const tokens: Record<string, string> = {};

beforeAll(async () => {
  await database.connect();
  // This namespace is owned by this test file only; start from an empty database every run.
  await database.db.query(`DEFINE NAMESPACE IF NOT EXISTS ${NS};`);
  await database.db.use({ namespace: NS });
  await database.db.query('REMOVE DATABASE IF EXISTS control_plane;');
  await database.bootstrap();
  for (const [name, role, caps] of [
    ['gm', 'gm', ['execute', 'review', 'manage']], ['product', 'product', ['execute', 'review', 'manage']],
    ['eng-a', 'engineering', ['execute', 'review']], ['eng-b', 'engineering', ['execute', 'review']],
    ['qa', 'qa', ['execute', 'review']], ['eval', 'eval', []],
  ] as const) tokens[name] = await enrollment.enroll(`t-${name}`, role, caps);
});

afterAll(async () => {
  await database.close();
  rmSync(credDir, { recursive: true, force: true });
});

const key = () => crypto.randomUUID();
const proofOf = (c: ClaimResult | { task: TaskView; deliveryId: string; fence: number }, version = c.task.version) =>
  ({ taskId: c.task.id, deliveryId: c.deliveryId, fence: c.fence, expectedVersion: version });
async function execute(token: string, taskId: string, text = 'Synthetic delivery evidence for v3 test.') {
  const claim = await core.claim(token, taskId);
  return core.submit(token, proofOf(claim), { text, idempotencyKey: key() });
}
async function review(token: string, taskId: string, decision: 'accept' | 'return' = 'accept') {
  const claim = await core.claim(token, taskId);
  const evidence = { text: 'Independent synthetic review evidence.', idempotencyKey: key() };
  return decision === 'accept' ? core.accept(token, proofOf(claim), evidence) : core.returnTask(token, proofOf(claim), evidence);
}
const task = async (id: string) => core.getTask(tokens.gm, id);

test('program goal from a direct DB owner_command: scope, plan with deliveries, product acceptance, owner G3 with rework', async () => {
  await database.db.query("CREATE owner_command CONTENT { kind: 'goal', tier: 'program', text: '我要一个 B2C 商城\\n先做最小可用版本' };");
  let invalidRejected = false;
  try { await database.db.query("CREATE owner_command CONTENT { kind: 'drop-tables' };"); } catch { invalidRejected = true; }
  expect(invalidRejected).toBe(true);
  const applied = await owner.applyPending();
  expect(applied).toHaveLength(1);
  expect(applied[0].status).toBe('applied');
  const goal = (await owner.brief()).goals.find(g => g.title === '我要一个 B2C 商城')!;
  expect(goal).toMatchObject({ state: 'active', tier: 'program' });
  expect(await owner.applyPending()).toHaveLength(0);
  const tasks = goal.tasks as Required<typeof goal.tasks>;

  // Scope: product proposes, gm reviews; the owner is not involved.
  expect((await task(tasks.intake)).reviewerRole).toBe('gm');
  expect((await task(tasks.plan)).state).toBe('blocked');
  await execute(tokens.product, tasks.intake, '范围提案：目标用户、MVP 清单、明确不做、依赖与风险。');
  await review(tokens.gm, tasks.intake);
  expect((await owner.inbox()).gates).toHaveLength(0);

  // Plan: gm creates a delivery chain; product acceptance waits for all of it.
  const plan = await core.claim(tokens.gm, tasks.plan);
  const [impl, release, deploy] = await core.createDelivery(tokens.gm, { goalId: goal.id, title: '商品列表',
    spec: '实现商品列表页：展示名称、价格、库存；验收：生产打开列表能看到至少一件商品。', idempotencyKey: key() });
  expect([impl.kind, release.kind, deploy.kind]).toEqual(['task', 'release', 'deploy']);
  expect([release.reviewerRole, deploy.reviewerRole]).toEqual(['product', 'qa']);
  expect(release.dependencies).toEqual([impl.id]);
  const manual = await task(tasks.manual);
  expect(manual.dependencies).toEqual(expect.arrayContaining([tasks.plan, impl.id, release.id, deploy.id]));
  await core.submit(tokens.gm, proofOf(plan), { text: '任务图：商品列表交付链（实现→上线申请→合入部署与生产实测）。', idempotencyKey: key() });
  await review(tokens.product, tasks.plan);
  await execute(tokens['eng-a'], impl.id, '实现完成：PR 链接、分支、提交 SHA、测试通过，无数据库迁移。');
  await review(tokens['eng-b'], impl.id);
  await execute(tokens['eng-a'], release.id, '上线申请：PR 已复核，无迁移，回滚为重发上一提交。');
  await review(tokens.product, release.id);
  await execute(tokens['eng-a'], deploy.id, '已合入并由 CI 发布，生产 health 正常，版本为该提交。');
  await review(tokens.qa, deploy.id);
  expect((await task(tasks.manual)).state).toBe('ready');

  // Product acceptance → gm confirms → G3; owner rejects, gm reworks, G3 waits for the rework.
  await execute(tokens.product, tasks.manual, '验收记录：生产入口、验收步骤、qa 实测结论、已知限制、回滚方式。');
  await review(tokens.gm, tasks.manual);
  await execute(tokens.gm, tasks.acceptance, 'G3：已上线提交、入口链接、老板验收步骤、qa 与运营结论、回滚方式。');
  await owner.decide({ taskId: tasks.acceptance, decision: 'reject', note: '结算页缺少运费', source: 'owner:test', key: key() });
  const g3 = await core.claim(tokens.gm, tasks.acceptance);
  const fix = await core.createTask(tokens.gm, { title: '补充运费计算', context: '按老板意见返工', executorRole: 'engineering',
    reviewerRole: 'qa', goalId: goal.id, idempotencyKey: key() });
  expect((await task(tasks.acceptance)).state).toBe('blocked');
  await expect(core.submit(tokens.gm, proofOf(g3), { text: 'Old lease must not submit.', idempotencyKey: key() }))
    .rejects.toBeDefined();
  await execute(tokens['eng-b'], fix.id);
  await review(tokens.qa, fix.id);
  await execute(tokens.gm, tasks.acceptance, 'G3 v2：已按老板意见补充运费计算，已上线并通过生产实测。');
  expect((await owner.inbox()).gates.map(g => g.task.id)).toContain(tasks.acceptance);
  await owner.decide({ taskId: tasks.acceptance, decision: 'approve', note: '通过', source: 'owner:test', key: key() });
  const [[closed]] = await database.db.query<[[{ state: string }]]>('SELECT state FROM $goal;', { goal: new RecordId('goal', goal.id) });
  expect(closed.state).toBe('done');
});

test('quick goal: one delivery chain, qa reads a sealed secret in production, product acceptance closes it without the owner', async () => {
  process.env.SCK_SECRET_KEY = Buffer.alloc(32, 7).toString('base64');
  const store = new ProjectStore(database.db);
  await store.upsert({ id: 'demo', name: 'Demo', repoPath: '/repo/demo', release: '合入 main 后 CI 自动发布', rollback: '重发上一提交',
    redLines: ['改写或删除已有数据的迁移'], envs: [{ name: 'production', url: 'https://demo.example', healthUrl: 'https://demo.example/health' }] });
  await store.setSecret({ project: 'demo', env: 'production', name: 'QA_PASSWORD', value: 'hunter2', roles: ['qa'] }, Buffer.alloc(32, 7));
  const [[raw]] = await database.db.query<[[{ ciphertext: string }]]>("SELECT ciphertext FROM env_secret WHERE name = 'QA_PASSWORD';");
  expect(raw.ciphertext).not.toContain('hunter2');

  const goal = await owner.createGoal({ text: '修复登录页按钮错位', source: 'owner:test', key: key(), tier: 'quick', project: 'demo' });
  expect(goal).toMatchObject({ state: 'active', tier: 'quick', project: 'demo' });
  expect(goal.tasks.manual).toBe(goal.tasks.acceptance);
  const pending = (await core.listTasks(tokens.gm)).filter(t => t.goalId === goal.id);
  expect(pending.map(t => t.kind).sort()).toEqual(['deploy', 'release', 'task', 'task']);
  expect(pending.some(t => t.reviewerRole === 'owner' || ['ai-content', 'cs'].includes(t.executorRole))).toBe(false);
  const byKind = (kind: string) => pending.find(t => t.kind === kind && t.id !== goal.tasks.manual)!;
  const [impl, release, deploy] = [byKind('task'), byKind('release'), byKind('deploy')];

  const claim = await core.claim(tokens['eng-a'], impl.id);
  expect(claim.project).toMatchObject({ id: 'demo', repoPath: '/repo/demo', redLines: ['改写或删除已有数据的迁移'] });
  expect(claim.project!.envs[0].secrets).toEqual([{ name: 'QA_PASSWORD', roles: ['qa'] }]);
  await expect(core.getSecret(tokens['eng-a'], { taskId: impl.id, env: 'production', name: 'QA_PASSWORD' }))
    .rejects.toMatchObject({ code: 'forbidden' });
  await core.submit(tokens['eng-a'], proofOf(claim), { text: '实现完成：PR、分支、提交、测试通过，无迁移。', idempotencyKey: key() });
  await review(tokens['eng-b'], impl.id);
  await execute(tokens['eng-a'], release.id, '上线申请：PR 已复核，无迁移，回滚为重发上一提交。');
  await review(tokens.product, release.id);
  await execute(tokens['eng-a'], deploy.id, '已合入并由 CI 发布，生产 health 正常，版本为该提交。');
  await expect(core.getSecret(tokens.qa, { taskId: deploy.id, env: 'production', name: 'QA_PASSWORD' }))
    .rejects.toMatchObject({ code: 'forbidden' });
  const verify = await core.claim(tokens.qa, deploy.id);
  expect(await core.getSecret(tokens.qa, { taskId: deploy.id, env: 'production', name: 'QA_PASSWORD' })).toBe('hunter2');
  const history = await core.history(tokens.gm, deploy.id);
  expect(history.some(h => h.action === 'secret_read' && !h.evidence?.includes('hunter2'))).toBe(true);
  await core.accept(tokens.qa, proofOf(verify), { text: '生产实测：打开登录页 → 按钮对齐 → 登录成功。', idempotencyKey: key() });

  await execute(tokens.product, goal.tasks.manual!, '验收记录：生产入口、验收步骤、qa 实测结论、回滚方式。');
  await review(tokens.gm, goal.tasks.manual!);
  const [[closed]] = await database.db.query<[[{ state: string }]]>('SELECT state FROM $goal;', { goal: new RecordId('goal', goal.id) });
  expect(closed.state).toBe('done');
  expect((await owner.inbox()).gates.filter(g => g.task.goalId === goal.id)).toHaveLength(0);
});

test('gm may relay owner conversation; other roles may not', async () => {
  const goal = await core.relayGoal(tokens.gm, { text: '做一个 TODO 网页', ownerQuote: '老板：做一个 TODO 网页', idempotencyKey: key(), tier: 'standard' });
  expect((await core.history(tokens.gm, goal.tasks.plan!))[0].actor).toBe('triage:gm-relay:t-gm 指定');
  const untiered = await core.relayGoal(tokens.gm, { text: '做一个博客', ownerQuote: '老板：做一个博客', idempotencyKey: key() });
  expect(untiered).toMatchObject({ state: 'triage', tasks: {} });
  expect((await core.triageGoal(tokens.gm, { goalId: untiered.id, tier: 'quick', reason: '单页面小需求' })).tier).toBe('quick');
  await expect(core.triageGoal(tokens.product, { goalId: untiered.id, tier: 'quick', reason: 'not mine' }))
    .rejects.toMatchObject({ code: 'forbidden' });
  await expect(core.relayGoal(tokens['eng-a'], { text: 'x x', ownerQuote: 'fake', idempotencyKey: key() }))
    .rejects.toMatchObject({ code: 'forbidden' });
  await core.relayDirection(tokens.gm, { text: '先服务律师团队', ownerQuote: '老板：先服务律师团队', idempotencyKey: key() });
  expect((await core.companyBrief(tokens['eng-a'])).directions[0].text).toBe('先服务律师团队');
  const gate = await core.createTask(tokens.gm, { title: '付费域名', context: '需要老板批准购买域名', kind: 'gate',
    executorRole: 'product', reviewerRole: 'owner', idempotencyKey: key() });
  await execute(tokens.product, gate.id, '申请购买域名 todo.example，年费约 10 美元。');
  const decided = await core.relayOwnerDecision(tokens.gm, { taskId: gate.id, decision: 'approve', note: '可以',
    ownerQuote: '老板：域名可以买', idempotencyKey: key() });
  expect(decided.state).toBe('done');
  const history = await core.history(tokens.gm, gate.id);
  expect(history.at(-1)).toMatchObject({ action: 'owner_approve', actor: 'gm-relay:t-gm' });
});

test('revoked lease hands over to a same-role employee with history; old session is fenced out', async () => {
  const t = await core.createTask(tokens.gm, { title: 'Handover task', context: 'synthetic', executorRole: 'engineering',
    reviewerRole: 'qa', idempotencyKey: key() });
  const first = await core.claim(tokens['eng-a'], t.id);
  const cp = await core.checkpoint(tokens['eng-a'], proofOf(first), { text: '已完成接口草稿与数据结构，下一步编写 tests/api.test.ts 的单元测试。', idempotencyKey: key() });
  expect(await workforce.revokeLease(t.id, 't-eng-a', '会话额度耗尽', '【交接包】最后日志：写到 tests/api.test.ts')).toBe(true);
  expect(await task(t.id)).toMatchObject({ state: 'ready', handover: true, previousEmployee: 't-eng-a' });
  await expect(core.submit(tokens['eng-a'], proofOf(first, cp.version), { text: 'Stale session writes must fail.', idempotencyKey: key() }))
    .rejects.toBeDefined();
  const second = await core.claim(tokens['eng-b'], t.id);
  expect(second.fence).toBe(first.fence + 1);
  expect(second.history.map(h => h.action)).toEqual(expect.arrayContaining(['claim', 'checkpoint', 'revoked']));
  expect(second.history.find(h => h.action === 'revoked')?.evidence).toContain('tests/api.test.ts');
  const submitted = await core.submit(tokens['eng-b'], proofOf(second), { text: 'Continued from handover.', idempotencyKey: key() });
  expect(submitted.handover).toBeUndefined();
  // A long review (e.g. walking through the acceptance manual) can checkpoint too, and hands over the same way.
  const reviewer = await core.claim(tokens.qa, t.id);
  const reviewCp = await core.checkpoint(tokens.qa, proofOf(reviewer), { text: '已按手册完成第 1-3 步，第 4 步待验证支付回调。', idempotencyKey: key() });
  expect(reviewCp.state).toBe('review');
  expect(await workforce.revokeLease(t.id, 't-qa', '验收员会话中断', '【交接包】停在第 4 步')).toBe(true);
  expect((await task(t.id)).state).toBe('review');
});

class FakePaseo implements PaseoGateway {
  agents = new Map<string, { status: string; error: string; spawn?: SpawnInput }>();
  sent: Array<{ agentId: string; prompt: string }> = [];
  async list() { return new Map([...this.agents].map(([id, a]) => [id, { id, status: a.status }])); }
  async status(id: string) { const a = this.agents.get(id); return a ? { status: a.status, pendingPermissions: 0 } : undefined; }
  async lastError(id: string) { return this.agents.get(id)?.error ?? ''; }
  async logsTail(id: string) { return `[Shell] git commit -m wip (agent ${id})`; }
  async spawn(input: SpawnInput) {
    const id = `agent-${this.agents.size + 1}`;
    this.agents.set(id, { status: 'running', error: '', spawn: input });
    return id;
  }
  async send(agentId: string, prompt: string) {
    this.agents.get(agentId)!.status = 'running';
    this.sent.push({ agentId, prompt });
  }
  async stop(agentId: string) { this.agents.get(agentId)!.status = 'idle'; }
  set(id: string, status: string, error = '') { const a = this.agents.get(id)!; a.status = status; a.error = error; }
}

test('dispatcher: spawn from defs, fail over on exhausted subscription, budget pause, probe recovery, no self review', async () => {
  // Isolate from tasks created by earlier tests in this file.
  await database.db.query("UPDATE task SET state = 'done' WHERE state != 'done';");
  await database.db.query("UPSERT company_meta:config MERGE { redispatch_minutes: 15, max_running: 4 };");
  await workforce.upsertDef('engineering-codex', { role: 'engineering', provider: 'codex', model: 'gpt-6-sol', thinking: 'medium', priority: 10 });
  await workforce.upsertDef('engineering-grok', { role: 'engineering', provider: 'grok', model: 'grok-4.7', thinking: 'medium', priority: 20 });
  const paseo = new FakePaseo();
  const notices: string[] = [];
  const dispatcher = new Dispatcher({ workforce, owner, paseo, env: { opsRepo: '/ops', sckBin: '/bin/sck' },
    rand: () => 0, notify: async (_t, text) => { notices.push(text); } });
  const tokenOf = (employee: string) => readFileSync(join(credDir, `${employee}.token`), 'utf8');

  const t = await core.createTask(tokens.gm, { title: 'Dispatch me', context: 'synthetic', executorRole: 'engineering',
    reviewerRole: 'engineering', idempotencyKey: key() });
  let report = await dispatcher.tick();
  expect(report.woke).toHaveLength(1);
  const codexInst = report.woke[0];
  expect(codexInst).toMatchObject({ task: t.id, spawned: true });
  expect(codexInst.employee.startsWith('engineering-codex-')).toBe(true);
  const [codexAgent, spawned] = [...paseo.agents][0];
  expect(spawned.spawn).toMatchObject({ provider: 'codex', model: 'gpt-6-sol', mode: 'full-access' });
  expect(spawned.spawn!.prompt).toContain(`"taskId":"${t.id}"`);
  expect(spawned.spawn!.prompt).not.toContain(tokenOf(codexInst.employee));
  expect((await dispatcher.tick()).woke).toHaveLength(0);

  // The spawned employee claims and checkpoints; then its subscription runs out mid-task.
  const claim = await core.claim(tokenOf(codexInst.employee), t.id);
  await core.checkpoint(tokenOf(codexInst.employee), proofOf(claim), { text: '完成一半：接口已实现，下一步补充单元测试并提交到任务分支。', idempotencyKey: key() });
  paseo.set(codexAgent, 'error', 'Your workspace is out of credits. Add credits to continue.');
  report = await dispatcher.tick();
  expect(report.exhausted).toEqual(['codex']);
  expect(report.revoked).toEqual([t.id]);
  expect(report.woke).toHaveLength(1);
  expect(report.woke[0].employee.startsWith('engineering-grok-')).toBe(true);
  const grokAgent = [...paseo.agents.keys()][1];
  expect(paseo.agents.get(grokAgent)!.spawn!.prompt).toContain('接手续做');
  const history = await core.history(tokens.gm, t.id);
  expect(history.find(h => h.action === 'revoked')?.evidence).toContain('git commit -m wip');
  // The stale error state must not keep extending the cooldown.
  expect((await dispatcher.tick()).exhausted).toEqual([]);

  // Grok employee continues and submits; review must go to someone other than the submitter.
  const grokEmployee = report.woke[0].employee;
  const takeover = await core.claim(tokenOf(grokEmployee), t.id);
  expect(takeover.task.handover).toBe(true);
  await core.submit(tokenOf(grokEmployee), proofOf(takeover), { text: 'Finished after takeover.', idempotencyKey: key() });
  paseo.set(grokAgent, 'idle');
  report = await dispatcher.tick();
  // Only candidates: the submitter (excluded) and the exhausted codex instance; nobody is available.
  expect(report.woke).toHaveLength(0);
  expect(report.notices).toContain('staff:engineering');

  // Grok also runs out: every subscription is exhausted → one budget notice, dispatch paused.
  paseo.set(grokAgent, 'error', 'Rate limit reached, try again later');
  const bump = await core.createTask(tokens.gm, { title: 'Budget probe', context: 'synthetic', executorRole: 'engineering',
    reviewerRole: 'qa', idempotencyKey: key() });
  report = await dispatcher.tick();
  expect(report.skipped).toBe('budget');
  expect(report.notices).toContain('budget');
  expect((await dispatcher.tick()).notices).not.toContain('budget');
  expect(notices.filter(n => n.includes('所有订阅')).length).toBe(1);

  // Codex cooldown passes: the exhausted codex instance is probed with the review, and a clean turn heals codex.
  await database.db.query("UPDATE provider_health:codex SET until = 0;");
  report = await dispatcher.tick();
  expect(report.skipped).toBeUndefined();
  expect(report.woke.map(w => w.employee)).toEqual([codexInst.employee]);
  expect(report.woke[0].task).toBe(t.id);
  expect(paseo.sent.at(-1)!.prompt).toContain('独立验收');
  paseo.set(codexAgent, 'idle');
  await dispatcher.tick();
  expect((await workforce.providerHealth()).get('codex')?.state).toBe('healthy');
  expect((await owner.openNotices()).some(n => n.key === 'budget')).toBe(false);
  expect(bump.state).toBe('ready');
});

test('dispatcher: owner gates raise one notification each and resolve once decided', async () => {
  await database.db.query("UPDATE task SET state = 'done' WHERE state != 'done';");
  const paseo = new FakePaseo();
  const notified: string[] = [];
  const dispatcher = new Dispatcher({ workforce, owner, paseo, env: { opsRepo: '/ops', sckBin: '/bin/sck' },
    rand: () => 0, notify: async (_t, text) => { notified.push(text); } });
  const gate = await core.createTask(tokens.gm, { title: 'G2 购买域名', context: 'synthetic gate', kind: 'gate',
    executorRole: 'product', reviewerRole: 'owner', idempotencyKey: key() });
  await execute(tokens.product, gate.id, 'G2 申请：购买域名 example.test，年费 10 元，用于演示环境。');
  await dispatcher.tick();
  await dispatcher.tick();
  expect(notified.filter(n => n.includes('G2 购买域名'))).toHaveLength(1);
  await owner.decide({ taskId: gate.id, decision: 'approve', note: '', source: 'owner:test', key: key() });
  await dispatcher.tick();
  expect((await owner.openNotices()).some(n => n.key.startsWith(`gate:${gate.id}`))).toBe(false);
});

test('eval role records scorecards for task participants and rolls them into def averages', async () => {
  await database.db.query('UPDATE task SET evaluated_at = time::now() WHERE evaluated_at = NONE;');
  await workforce.upsertDef('engineering-evaltarget', { role: 'engineering', provider: 'grok', model: 'grok-4.7',
    thinking: 'medium', weight: 10 });
  const def = (await workforce.defs()).find(d => d.id === 'engineering-evaltarget')!;
  const inst = await workforce.spawnInst(def);
  const instToken = readFileSync(join(credDir, `${inst.id}.token`), 'utf8');

  const t = await core.createTask(tokens.gm, { title: 'Scored task', context: 'synthetic', executorRole: 'engineering',
    reviewerRole: 'qa', idempotencyKey: key() });
  const claim = await core.claim(instToken, t.id);
  const cp = await core.checkpoint(instToken, proofOf(claim), { text: '完成了数据结构设计，下一步提交实现分支并自测。', idempotencyKey: key() });
  await core.submit(instToken, proofOf(claim, cp.version), { text: '实现完毕，代码已提交到任务专属分支，等待独立验收。', idempotencyKey: key() });
  await review(tokens.qa, t.id);
  expect((await task(t.id)).state).toBe('done');

  // Only the eval role may record scores; every scored employee must be a real participant.
  await expect(core.recordScore(tokens.qa, { taskId: t.id, summary: 'x', scores: [] }))
    .rejects.toMatchObject({ code: 'forbidden' });
  await expect(core.recordScore(tokens.eval, { taskId: t.id, summary: 'x', scores: [
    { employee: 'nobody', quality: 4, evidence: 4, discipline: 4, timeliness: 4, overall: 4 },
  ] })).rejects.toMatchObject({ code: 'invalid' });

  const res = await core.recordScore(tokens.eval, { taskId: t.id, summary: '执行顺畅，验收一次通过。', scores: [
    { employee: inst.id, quality: 4, evidence: 4, discipline: 5, timeliness: 4, overall: 4.5, notes: 'checkpoint 及时' },
    { employee: 't-qa', quality: 4, evidence: 4, discipline: 4, timeliness: 5, overall: 4, notes: '验收独立' },
  ] });
  expect(res.recorded).toBe(2);
  expect(res.participants).toEqual(expect.arrayContaining([inst.id, 't-qa']));

  const [[card]] = await database.db.query<[[{ overall: number; metrics: { checkpoints: number } }]]>(
    'SELECT overall, metrics FROM scorecard WHERE task = $task AND employee = $emp;',
    { task: new RecordId('task', t.id), emp: inst.id });
  expect(card.overall).toBe(4.5);
  expect(card.metrics.checkpoints).toBe(1);

  const updated = (await workforce.defs()).find(d => d.id === 'engineering-evaltarget')!;
  expect(updated.avgScore).toBe(4.5);
  expect(updated.scored).toBe(1);
  const [[marked]] = await database.db.query<[[{ evaluated_at?: unknown }]]>(
    'SELECT evaluated_at FROM $t;', { t: new RecordId('task', t.id) });
  expect(marked.evaluated_at).toBeDefined();
});

test('dispatcher assigns an eval judge for finished tasks and stops once evaluated', async () => {
  await database.db.query("UPDATE task SET state = 'done' WHERE state != 'done';");
  await database.db.query('UPDATE task SET evaluated_at = time::now() WHERE evaluated_at = NONE;');
  await database.db.query('DELETE provider_health;');
  await workforce.upsertDef('eval-grok', { role: 'eval', provider: 'grok', model: 'grok-4.7', thinking: 'medium', weight: 60 });
  const paseo = new FakePaseo();
  const dispatcher = new Dispatcher({ workforce, owner, paseo, env: { opsRepo: '/ops', sckBin: '/bin/sck' }, rand: () => 0 });

  const t = await core.createTask(tokens.gm, { title: 'Needs judging', context: 'synthetic', executorRole: 'engineering',
    reviewerRole: 'qa', idempotencyKey: key() });
  await execute(tokens['eng-a'], t.id);
  await review(tokens.qa, t.id);

  const report = await dispatcher.tick();
  expect(report.evals).toEqual([t.id]);
  const evalInst = report.woke[0].employee;
  expect(evalInst.startsWith('eval-grok-')).toBe(true);
  const evalAgent = [...paseo.agents.keys()][0];
  expect(paseo.agents.get(evalAgent)!.spawn!.prompt).toContain('绩效评审');
  expect(paseo.agents.get(evalAgent)!.spawn!.prompt).toContain(t.id);

  // Inside the redispatch window nothing is sent again; once scores land the task is done for good.
  expect((await dispatcher.tick()).evals).toEqual([]);
  const evalToken = readFileSync(join(credDir, `${evalInst}.token`), 'utf8');
  const res = await core.recordScore(evalToken, { taskId: t.id, summary: '本轮顺畅。', scores: [
    { employee: 't-eng-a', quality: 4, evidence: 4, discipline: 4, timeliness: 4, overall: 4 },
    { employee: 't-qa', quality: 5, evidence: 5, discipline: 5, timeliness: 5, overall: 5 },
  ] });
  expect(res.recorded).toBe(2);
  await database.db.query('UPDATE dispatch SET at = 0;');
  expect((await dispatcher.tick()).evals).toEqual([]);
});

test('dispatcher: jev scores finished tasks in one call; low confidence escalates to the llm judge', async () => {
  await database.db.query("UPDATE task SET state = 'done' WHERE state != 'done';");
  await database.db.query('UPDATE task SET evaluated_at = time::now() WHERE evaluated_at = NONE;');
  await database.db.query('DELETE provider_health;');
  const paseo = new FakePaseo();
  const notices: string[] = [];
  const questions: string[][] = [];
  const jev: JevClient = {
    model: 'jev-test',
    async ask(_state: unknown, qs) {
      questions.push(Object.keys(qs));
      const answers: Record<string, unknown> = {};
      for (const [q, spec] of Object.entries(qs)) {
        if (spec.type === 'score') answers[q] = { type: 'score', score: 4.2, confidence: 0.93, probabilities: { '4': 0.9 } };
        else if (q === 'urgent') answers[q] = { type: 'noul', noul: 0.2 };
        else if (spec.type === 'noul') answers[q] = { type: 'noul', noul: q === 'p0_flag' ? 0.8 : 0.1 };
        else answers[q] = { type: 'choice', choice: Object.keys(spec.criteria ?? {})[0], confidence: 0.9 };
      }
      return { model: 'jev-test', answers } as never;
    },
  };
  const dispatcher = new Dispatcher({ workforce, owner, paseo, env: { opsRepo: '/ops', sckBin: '/bin/sck' },
    rand: () => 0, jev, notify: async (_t, text) => { notices.push(text); } });

  const t = await core.createTask(tokens.gm, { title: 'Jev judged task', context: 'synthetic', executorRole: 'engineering',
    reviewerRole: 'qa', idempotencyKey: key() });
  await execute(tokens['eng-a'], t.id);
  await review(tokens.qa, t.id);

  const report = await dispatcher.tick();
  expect(report.evals).toEqual([t.id]);
  expect(report.woke).toHaveLength(0);                       // no LLM judge session needed
  const evalCalls = questions.filter(keys => keys.includes('p0_quality'));
  expect(evalCalls).toHaveLength(1);                         // one Jev round trip for the whole task
  expect(evalCalls[0]).toEqual(expect.arrayContaining(['p0_quality', 'p0_overall', 'p0_flag', 'p1_flag', 'top']));

  const [[row]] = await database.db.query<[[{ evaluated_at?: unknown; eval_via?: string }]]>(
    'SELECT evaluated_at, eval_via FROM $t;', { t: new RecordId('task', t.id) });
  expect(row.evaluated_at).toBeDefined();
  expect(row.eval_via).toBe('jev');
  const [cards] = await database.db.query<[Array<{ employee: string; judge?: string; confidence?: number; flagged?: boolean; overall: number }>]>(
    'SELECT employee, judge, confidence, flagged, overall FROM scorecard WHERE task = $t;', { t: new RecordId('task', t.id) });
  expect(cards).toHaveLength(3);                                  // gm created the task and is a participant too
  expect(cards.every(c => c.judge === 'jev' && (c.confidence ?? 0) > 0.9 && c.overall === 4.2)).toBe(true);
  expect(cards.find(c => c.employee === 't-eng-a')?.flagged).toBe(true);
  // The flagged employee produced an owner inbox notice, but Jev triaged it as non-urgent: no desktop popup.
  expect((await owner.openNotices()).some(n => n.key === `eval-flag:${t.id}:t-eng-a`)).toBe(true);
  expect(notices).toHaveLength(0);
  expect((await dispatcher.tick()).evals).toEqual([]);

  // Low-confidence verdicts escalate to an LLM eval employee instead of recording.
  const shaky: JevClient = { model: 'jev-test', ask: async (_s: unknown, qs) => {
    const answers: Record<string, unknown> = {};
    for (const [q, spec] of Object.entries(qs)) {
      if (spec.type === 'score') answers[q] = { type: 'score', score: 3, confidence: 0.2 };
      else if (spec.type === 'noul') answers[q] = { type: 'noul', noul: 0.1 };
      else answers[q] = { type: 'choice', choice: 'x', confidence: 0.2 };
    }
    return { model: 'jev-test', answers } as never;
  } };
  const dispatcher2 = new Dispatcher({ workforce, owner, paseo, env: { opsRepo: '/ops', sckBin: '/bin/sck' },
    rand: () => 0, jev: shaky });
  await workforce.upsertDef('eval-grok', { role: 'eval', provider: 'grok', model: 'grok-4.7', thinking: 'medium', weight: 60 });
  const t2 = await core.createTask(tokens.gm, { title: 'Hard to judge', context: 'synthetic', executorRole: 'engineering',
    reviewerRole: 'qa', idempotencyKey: key() });
  await execute(tokens['eng-a'], t2.id);
  await review(tokens.qa, t2.id);
  const report2 = await dispatcher2.tick();
  expect(report2.evals).toEqual([t2.id]);
  expect(report2.woke[0].employee.startsWith('eval-')).toBe(true);   // escalated to the LLM judge
  const [[row2]] = await database.db.query<[[{ evaluated_at?: unknown; eval_attempts?: number }]]>(
    'SELECT evaluated_at, eval_attempts FROM $t;', { t: new RecordId('task', t2.id) });
  expect(row2.evaluated_at).toBeUndefined();
  expect(row2.eval_attempts).toBe(1);
});

test('dispatcher: jev api failures retry then fall back to the llm judge', async () => {
  await database.db.query("UPDATE task SET state = 'done' WHERE state != 'done';");
  await database.db.query('UPDATE task SET evaluated_at = time::now() WHERE evaluated_at = NONE;');
  await database.db.query('DELETE provider_health;');
  const paseo = new FakePaseo();
  let attempts = 0;
  const broken: JevClient = { model: 'jev-test', ask: async () => { attempts++; throw new Error('jev api down'); } };
  const dispatcher = new Dispatcher({ workforce, owner, paseo, env: { opsRepo: '/ops', sckBin: '/bin/sck' },
    rand: () => 0, jev: broken });
  await workforce.upsertDef('eval-grok', { role: 'eval', provider: 'grok', model: 'grok-4.7', thinking: 'medium', weight: 60 });
  await workforce.upsertDef('eval-codex', { role: 'eval', provider: 'codex', model: 'gpt-6-sol', thinking: 'low', weight: 30 });

  const t = await core.createTask(tokens.gm, { title: 'Jev unreachable', context: 'synthetic', executorRole: 'engineering',
    reviewerRole: 'qa', idempotencyKey: key() });
  await execute(tokens['eng-a'], t.id);
  await review(tokens.qa, t.id);

  for (let i = 0; i < 2; i++) {
    const report = await dispatcher.tick();
    expect(report.evals).toEqual([]);
    expect(report.woke).toHaveLength(0);                     // still retrying, no LLM judge yet
  }
  const report3 = await dispatcher.tick();                   // attempt 3 fails → escalate immediately
  expect(attempts).toBe(3);
  expect(report3.woke[0].employee.startsWith('eval-')).toBe(true);
});

test('dispatcher: jev triages goals, approves safe releases and reroutes owner questions; unsure cases stay with gm/product', async () => {
  await database.db.query("UPDATE task SET state = 'done', evaluated_at = time::now() WHERE state != 'done';");
  await database.db.query("UPDATE goal SET state = 'cancelled' WHERE state = 'triage';");
  await database.db.query('DELETE provider_health;');
  await database.db.query("UPSERT company_meta:config MERGE { redispatch_minutes: 15, max_running: 8, eval_enabled: false, provider_max: { codex: 8, grok: 8, devin: 8 } };");
  await workforce.upsertDef('gm-codex', { role: 'gm', provider: 'codex', model: 'gpt-6-sol', thinking: 'high', maxInstances: 2 });
  await workforce.upsertDef('product-codex', { role: 'product', provider: 'codex', model: 'gpt-6-sol', thinking: 'medium', maxInstances: 2 });
  const answers = { tier: 'quick', tierConfidence: 0.92, go: 0.9, redLine: 0.05, needsOwner: 0.1 };
  const asked: string[] = [];
  const jev: JevClient = {
    model: 'jev-test',
    async ask(_state, questions) {
      const out: Record<string, { type: 'choice' | 'noul'; choice?: string; noul?: number; confidence?: number }> = {};
      for (const q of Object.keys(questions)) {
        asked.push(q);
        if (q === 'tier') out.tier = { type: 'choice', choice: answers.tier, confidence: answers.tierConfidence };
        if (q === 'go') out.go = { type: 'noul', noul: answers.go };
        if (q === 'red_line') out.red_line = { type: 'noul', noul: answers.redLine };
        if (q === 'needs_owner') out.needs_owner = { type: 'noul', noul: answers.needsOwner };
        if (q === 'urgent') out.urgent = { type: 'noul', noul: 1 };
      }
      return { model: 'jev-test', answers: out };
    },
  };
  const paseo = new FakePaseo();
  const dispatcher = new Dispatcher({ workforce, owner, paseo, env: { opsRepo: '/ops', sckBin: '/bin/sck' }, rand: () => 0, jev });

  // Triage: confident → template instantiated; unsure → goal waits and gm is woken with the triage prompt.
  const quick = await owner.createGoal({ text: '修复导出按钮', source: 'owner:test', key: key() });
  expect(quick.state).toBe('triage');
  let report = await dispatcher.tick();
  expect(report.decisions).toContain(`triage:${quick.id}=quick`);
  answers.tier = 'program'; answers.tierConfidence = 0.4;
  const vague = await owner.createGoal({ text: '做一个知识库产品', source: 'owner:test', key: key() });
  report = await dispatcher.tick();
  expect(report.decisions.some(d => d.startsWith(`triage:${vague.id}`))).toBe(false);
  expect(report.woke.some(w => w.task === `goal:${vague.id}`)).toBe(true);
  expect([...paseo.agents.values()].some(a => a.spawn?.prompt.includes('【目标分级】') && a.spawn.prompt.includes(vague.id))).toBe(true);
  const tierQuestions = asked.filter(q => q === 'tier').length;
  await dispatcher.tick();
  expect(asked.filter(q => q === 'tier').length).toBe(tierQuestions);

  // Release: confident go → Jev accepts and deploy unlocks; unsure → advice in history, product decides.
  const triaged = (await owner.brief()).goals.find(g => g.id === quick.id)!;
  const chain = (await core.listTasks(tokens.gm)).filter(t => t.goalId === quick.id && t.id !== triaged.tasks.manual);
  const impl = chain.find(t => t.kind === 'task')!, release = chain.find(t => t.kind === 'release')!, deploy = chain.find(t => t.kind === 'deploy')!;
  await execute(tokens['eng-a'], impl.id, '实现完成：PR、分支、提交、测试通过，无迁移。');
  await review(tokens['eng-b'], impl.id);
  await execute(tokens['eng-a'], release.id, '上线申请：PR 已复核，无迁移，回滚为重发上一提交。');
  report = await dispatcher.tick();
  expect(report.decisions).toContain(`release:${release.id}`);
  expect(await task(release.id)).toMatchObject({ state: 'done' });
  expect((await task(deploy.id)).state).not.toBe('blocked');

  answers.go = 0.5;
  const [impl2, release2] = await core.createDelivery(tokens.gm, { goalId: quick.id, title: '导出格式',
    spec: '导出文件改为 xlsx；验收：生产导出能用 Excel 打开。', idempotencyKey: key() });
  await execute(tokens['eng-a'], impl2.id, '实现完成：PR、分支、提交、测试通过，含一个新增字段迁移。');
  await review(tokens['eng-b'], impl2.id);
  await execute(tokens['eng-a'], release2.id, '上线申请：新增字段迁移，回滚为重发上一提交并保留字段。');
  report = await dispatcher.tick();
  expect(report.decisions).not.toContain(`release:${release2.id}`);
  expect((await task(release2.id)).state).toBe('review');
  expect((await core.history(tokens.gm, release2.id)).some(h => h.action === 'jev_advice')).toBe(true);
  const goQuestions = asked.filter(q => q === 'go').length;
  await dispatcher.tick();
  expect(asked.filter(q => q === 'go').length).toBe(goQuestions);

  // Owner escalation: a question that is not owner-only is moved to gm once; raised again it stays with the owner.
  const ask = await core.createTask(tokens.gm, { title: '选择图表库', context: '选一个图表库', executorRole: 'product',
    reviewerRole: 'gm', idempotencyKey: key() });
  const held = await core.claim(tokens.product, ask.id);
  await core.block(tokens.product, proofOf(held), 'owner', { text: '请老板决定用 ECharts 还是 Chart.js。', idempotencyKey: key() });
  report = await dispatcher.tick();
  expect(report.decisions).toContain(`reroute:${ask.id}`);
  expect(await task(ask.id)).toMatchObject({ state: 'blocked', blockedTo: 'gm' });
  await core.resume(tokens.gm, ask.id, { text: '经理：先按原计划继续，确实需要老板时再升级。', idempotencyKey: key() });
  const again = await core.claim(tokens.product, ask.id);
  await core.block(tokens.product, proofOf(again), 'owner', { text: '经理确认需要老板决定：Chart.js 商业版需要购买授权，属于花钱事项。', idempotencyKey: key() });
  report = await dispatcher.tick();
  expect(report.decisions).not.toContain(`reroute:${ask.id}`);
  expect((await owner.inbox()).questions.map(q => q.task.id)).toContain(ask.id);
});

test('a task blocked while doing returns to ready on resume so the dispatcher can pick it up', async () => {
  const t = await core.createTask(tokens.gm, { title: '阻塞后恢复', context: '验证恢复后重新可领取', executorRole: 'engineering',
    reviewerRole: 'engineering', idempotencyKey: key() });
  const held = await core.claim(tokens['eng-a'], t.id);
  await core.block(tokens['eng-a'], proofOf(held), 'gm', { text: '缺少一个前置信息，需要经理协调补充后再恢复本任务继续执行。', idempotencyKey: key() });
  const resumed = await core.resume(tokens.gm, t.id, { text: '经理决定：按原方案继续执行，缺少的前置信息已经补充完整。', idempotencyKey: key() });
  expect(resumed.state).toBe('ready');
  expect((await core.claim(tokens['eng-b'], t.id)).task.state).toBe('doing');
});
