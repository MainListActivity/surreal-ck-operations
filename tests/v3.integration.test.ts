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
import { Dispatcher } from '../src/dispatcher/dispatcher.ts';
import type { PaseoGateway, SpawnInput } from '../src/dispatcher/paseo.ts';
import type { ClaimResult, TaskView } from '../src/contracts.ts';

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

test('goal from a direct DB owner_command runs through G1, planning, G2, manual and G3 with rework', async () => {
  await database.db.query("CREATE owner_command CONTENT { kind: 'goal', text: '我要一个 B2C 商城\\n先做最小可用版本' };");
  let invalidRejected = false;
  try { await database.db.query("CREATE owner_command CONTENT { kind: 'drop-tables' };"); } catch { invalidRejected = true; }
  expect(invalidRejected).toBe(true);
  const applied = await owner.applyPending();
  expect(applied).toHaveLength(1);
  expect(applied[0].status).toBe('applied');
  const goal = (await owner.brief()).goals.find(g => g.title === '我要一个 B2C 商城')!;
  expect(goal).toBeDefined();
  expect(await owner.applyPending()).toHaveLength(0);

  // G1: product proposes scope, owner rejects once then approves; nobody but the owner can accept a gate.
  expect((await task(goal.tasks.intake)).state).toBe('ready');
  expect((await task(goal.tasks.plan)).state).toBe('blocked');
  const g1 = await execute(tokens.product, goal.tasks.intake, 'G1 范围提案 v1：目标用户、MVP 清单、不做、假设、待拍板问题。');
  expect(g1).toMatchObject({ state: 'review', reviewerRole: 'owner' });
  await expect(core.claim(tokens.gm, goal.tasks.intake)).rejects.toMatchObject({ code: 'forbidden' });
  await owner.decide({ taskId: goal.tasks.intake, decision: 'reject', note: '先不做积分体系', source: 'owner:test', key: key() });
  const rework = await core.claim(tokens.product, goal.tasks.intake);
  expect(rework.history.some(h => h.action === 'owner_reject' && h.evidence?.includes('先不做积分体系'))).toBe(true);
  await core.submit(tokens.product, proofOf(rework), { text: 'G1 范围提案 v2：按老板意见去掉积分体系，其余范围不变。', idempotencyKey: key() });
  await database.db.query("CREATE owner_command CONTENT { kind: 'approve', task: $task, text: '同意' };", { task: goal.tasks.intake });
  await owner.applyPending();
  expect((await task(goal.tasks.intake)).state).toBe('done');

  // Planning: gm creates goal tasks, which the manual automatically waits for.
  const plan = await core.claim(tokens.gm, goal.tasks.plan);
  const build = await core.createTask(tokens.gm, { title: '实现商品列表', context: '实现并提交分支', executorRole: 'engineering',
    reviewerRole: 'qa', goalId: goal.id, idempotencyKey: key() });
  const g2 = await core.createTask(tokens.gm, { title: 'G2 上线支付沙箱', context: '需要老板批准注册外部账号', kind: 'gate',
    executorRole: 'product', reviewerRole: 'owner', goalId: goal.id, idempotencyKey: key() });
  const manual = await task(goal.tasks.manual);
  expect(manual.dependencies).toEqual(expect.arrayContaining([goal.tasks.plan, build.id, g2.id]));
  await core.submit(tokens.gm, proofOf(plan), { text: '任务图：实现商品列表（工程→测试）、G2 支付沙箱关口（运营→老板）。', idempotencyKey: key() });
  await review(tokens.product, goal.tasks.plan);
  expect((await task(goal.tasks.manual)).state).toBe('blocked');
  await execute(tokens['eng-a'], build.id);
  await review(tokens.qa, build.id);
  await execute(tokens.product, g2.id, 'G2 申请：注册支付沙箱账号，费用为 0，仅用于测试环境，风险可控。');
  expect((await task(goal.tasks.manual)).state).toBe('blocked');
  await owner.decide({ taskId: g2.id, decision: 'approve', note: '', source: 'owner:test', key: key() });
  expect((await task(goal.tasks.manual)).state).toBe('ready');

  // Manual → qa verifies → G3; owner rejects, gm creates rework which re-blocks G3 and drops gm's own lease.
  await execute(tokens.product, goal.tasks.manual, '真人验收操作手册：打开网址、登录测试账号、下单、核对预期结果、失败回退步骤。');
  await review(tokens.qa, goal.tasks.manual);
  await execute(tokens.gm, goal.tasks.acceptance, 'G3 最终验收申请：交付清单、验收手册路径、测试员工的实际操作结论。');
  await owner.decide({ taskId: goal.tasks.acceptance, decision: 'reject', note: '结算页缺少运费', source: 'owner:test', key: key() });
  const g3 = await core.claim(tokens.gm, goal.tasks.acceptance);
  const fix = await core.createTask(tokens.gm, { title: '补充运费计算', context: '按老板意见返工', executorRole: 'engineering',
    reviewerRole: 'qa', goalId: goal.id, idempotencyKey: key() });
  expect((await task(goal.tasks.acceptance)).state).toBe('blocked');
  await expect(core.submit(tokens.gm, proofOf(g3), { text: 'Old lease must not submit.', idempotencyKey: key() }))
    .rejects.toBeDefined();
  await execute(tokens['eng-b'], fix.id);
  await review(tokens.qa, fix.id);
  await execute(tokens.gm, goal.tasks.acceptance, 'G3 最终验收申请 v2：已按老板意见补充运费计算并通过测试验收。');
  expect((await owner.inbox()).gates.map(g => g.task.id)).toContain(goal.tasks.acceptance);
  await owner.decide({ taskId: goal.tasks.acceptance, decision: 'approve', note: '通过', source: 'owner:test', key: key() });
  const [[closed]] = await database.db.query<[[{ state: string }]]>('SELECT state FROM $goal;', { goal: new RecordId('goal', goal.id) });
  expect(closed.state).toBe('done');
});

test('gm may relay owner conversation; other roles may not', async () => {
  const goal = await core.relayGoal(tokens.gm, { text: '做一个 TODO 网页', ownerQuote: '老板：做一个 TODO 网页', idempotencyKey: key() });
  expect((await core.history(tokens.gm, goal.tasks.intake))[0].actor).toBe('gm-relay:t-gm');
  await expect(core.relayGoal(tokens['eng-a'], { text: 'x x', ownerQuote: 'fake', idempotencyKey: key() }))
    .rejects.toMatchObject({ code: 'forbidden' });
  await core.relayDirection(tokens.gm, { text: '先服务律师团队', ownerQuote: '老板：先服务律师团队', idempotencyKey: key() });
  expect((await core.companyBrief(tokens['eng-a'])).directions[0].text).toBe('先服务律师团队');
  await execute(tokens.product, goal.tasks.intake);
  const decided = await core.relayOwnerDecision(tokens.gm, { taskId: goal.tasks.intake, decision: 'approve', note: '可以',
    ownerQuote: '老板：G1 可以', idempotencyKey: key() });
  expect(decided.state).toBe('done');
  const history = await core.history(tokens.gm, goal.tasks.intake);
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
