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
import { SEED_DEFS } from '../src/seed.ts';
import { Workforce } from '../src/workforce.ts';
import { ProjectStore } from '../src/projects.ts';
import { OpsBroker } from '../src/ops/broker.ts';
import { Dispatcher } from '../src/dispatcher/dispatcher.ts';
import type { PaseoGateway, SpawnInput } from '../src/dispatcher/paseo.ts';
import type { ClaimResult, TaskView } from '../src/contracts.ts';
import type { JevClient } from '../src/dispatcher/jev.ts';
import { brokerConfig, FakeWorld } from './support/ops-world.ts';

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
  // quick chain is merged: 实现+上线申请 (release) → 合入部署与生产实测 (deploy) → 运营验收 (task).
  expect(pending.map(t => t.kind).sort()).toEqual(['deploy', 'release', 'task']);
  expect(pending.some(t => t.reviewerRole === 'owner' || ['ai-content', 'cs'].includes(t.executorRole))).toBe(false);
  const byKind = (kind: string) => pending.find(t => t.kind === kind && t.id !== goal.tasks.manual)!;
  const [ship, deploy] = [byKind('release'), byKind('deploy')];
  expect(ship.executorRole).toBe('engineering');
  expect(ship.reviewerRole).toBe('product');

  const claim = await core.claim(tokens['eng-a'], ship.id);
  expect(claim.project).toMatchObject({ id: 'demo', repoPath: '/repo/demo', redLines: ['改写或删除已有数据的迁移'] });
  // Employees see the inventory of sealed credential names, never a value; claim carries no secrets and no broker settings.
  expect(claim.project!.envs[0].secrets).toEqual([{ name: 'QA_PASSWORD', roles: ['qa'] }]);
  expect('secrets' in claim).toBe(false);
  expect(JSON.stringify(claim)).not.toContain('hunter2');
  expect(JSON.stringify(claim)).not.toContain('client-ck-1234');
  await core.submit(tokens['eng-a'], proofOf(claim), { text: '实现+上线申请：PR、分支、提交、测试通过，无迁移，回滚为重发上一提交。', idempotencyKey: key() });
  await review(tokens.product, ship.id);
  await execute(tokens['eng-a'], deploy.id, '已合入并由 CI 发布，生产 health 正常，版本为该提交。');
  const verify = await core.claim(tokens.qa, deploy.id);
  expect('secrets' in verify).toBe(false);
  expect(JSON.stringify(verify)).not.toContain('hunter2');

  // The ops broker acts for the lease holder only, opens the legacy sealed password itself and audits every step.
  const world = new FakeWorld();
  const broker = new OpsBroker({
    core, projects: store, secretKey: () => Buffer.alloc(32, 7), controlEnv: () => ({ cloudflareToken: 'cf', cloudflareAccountId: 'acct' }),
    fetch: world.fetch, now: world.now, d1: () => world.d1, queryAsUser: world.queryAsUser,
  });
  await expect(broker.call(tokens.qa, deploy.id, 'ops_info')).rejects.toMatchObject({ code: 'not_configured' }); // no broker settings yet
  await store.setBroker('demo', 'production', brokerConfig({ limits: { workspacesPerDay: 1, accountsPerDay: 5 } }));
  await expect(broker.call(tokens['eng-a'], deploy.id, 'ops_info')).rejects.toMatchObject({ code: 'forbidden' }); // not the holder
  await expect(broker.call(tokens.qa, ship.id, 'ops_info')).rejects.toMatchObject({ code: 'forbidden' }); // not this task's lease
  const info = await broker.call(tokens.qa, deploy.id, 'ops_info') as { accounts: Array<{ alias: string; username: string }> };
  expect(info.accounts).toEqual([{ alias: 'QA', username: 'sck-qa' }]);

  const login = await broker.call(tokens.qa, deploy.id, 'ops_login', { alias: 'qa' }) as { session: string; username: string; accountResult?: string };
  // The legacy sealed QA_PASSWORD became the IdP account's password: the fake IdP verified it during this login.
  expect(login).toMatchObject({ username: 'sck-qa', accountResult: 'created' });
  expect(await store.readSealed('demo', 'production', 'QA_PASSWORD', Buffer.alloc(32, 7))).toBe('hunter2');
  await broker.call(tokens.qa, deploy.id, 'ops_workspace_ensure', { session: login.session, slug: 'sck-demo', name: 'Demo' });
  // Quota counted from real audit rows across the project's tasks.
  await expect(broker.call(tokens.qa, deploy.id, 'ops_workspace_ensure', { session: login.session, slug: 'sck-demo-2', name: 'Demo 2' }))
    .rejects.toMatchObject({ code: 'limit_reached' });
  await broker.call(tokens.qa, deploy.id, 'ops_member_list', { session: login.session, slug: 'sck-demo' });
  expect(await core.opsCount('demo', 'ops_workspace_create', 3600)).toBe(1);
  expect(await core.opsCount('other-project', 'ops_workspace_create', 3600)).toBe(0);

  const scope = await core.opsScope(tokens.qa, deploy.id);
  expect(scope).toMatchObject({ taskId: deploy.id, project: 'demo', actor: { employeeId: 't-qa', role: 'qa' } });
  await expect(core.auditOps(scope, 'checkpoint', 'forged')).rejects.toMatchObject({ code: 'invalid' });
  await core.auditOps(scope, 'ops_note', 'x'.repeat(2000));

  const history = await core.history(tokens.gm, deploy.id);
  expect(history.map(h => h.action)).toEqual(expect.arrayContaining(['ops_account_create', 'ops_login', 'ops_workspace_create', 'ops_error', 'ops_note']));
  expect(history.map(h => h.action)).not.toContain('ops_call'); // routine reads stay out of handover history
  const [[quiet]] = await database.db.query<[[{ n: number }]]>("SELECT count() AS n FROM audit WHERE task = $task AND action = 'ops_call' GROUP ALL;", { task: new RecordId('task', deploy.id) });
  expect(quiet.n).toBeGreaterThanOrEqual(1);
  expect(history.find(h => h.action === 'ops_note')!.evidence!.length).toBeLessThanOrEqual(600);
  const trail = JSON.stringify(history);
  for (const secret of ['hunter2', ...world.tokens]) expect(trail).not.toContain(secret);

  await core.accept(tokens.qa, proofOf(verify), { text: '生产实测：打开登录页 → 按钮对齐 → 登录成功。', idempotencyKey: key() });
  // The lease is gone, so the broker is too.
  await expect(broker.call(tokens.qa, deploy.id, 'ops_info')).rejects.toMatchObject({ code: 'forbidden' });

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

test('instruct owner_command lands as a ready gm task carrying the owner text, idempotent on replay', async () => {
  await database.db.query("CREATE owner_command CONTENT { kind: 'instruct', text: '盘一下上周的交付质量，给我一份简报' };");
  const applied = await owner.applyPending();
  const instruct = applied.find(r => r.kind === 'instruct');
  expect(instruct).toMatchObject({ status: 'applied' });
  expect(instruct!.result).toMatch(/^task=/);
  const taskId = instruct!.result!.slice(5);
  const t = await core.getTask(tokens.gm, taskId);
  expect(t).toMatchObject({ state: 'ready', executorRole: 'gm', reviewerRole: 'product' });
  expect(t.context).toContain('盘一下上周的交付质量');
  // Re-apply of the same command id must not duplicate the task.
  await database.db.query("UPDATE owner_command SET status = 'pending' WHERE kind = 'instruct';");
  const again = await owner.applyPending();
  expect(again.find(r => r.kind === 'instruct')!.result).toBe(`task=${taskId}`);
});

test('revoked lease hands over to a same-role employee with history; old session is fenced out', async () => {
  const t = await core.createTask(tokens.gm, { title: 'Handover task', context: 'synthetic', executorRole: 'engineering',
    reviewerRole: 'qa', idempotencyKey: key() });
  const first = await core.claim(tokens['eng-a'], t.id);
  const cp = await core.checkpoint(tokens['eng-a'], proofOf(first), { text: '已完成接口草稿与数据结构，下一步编写 tests/api.test.ts 的单元测试。', idempotencyKey: key() });
  await database.db.query(`UPDATE employee SET paseo_agent_id = 'sess-eng-a', provider = 'codex' WHERE id = $e;`,
    { e: new RecordId('employee', 't-eng-a') });
  expect(await workforce.revokeLease(t.id, 't-eng-a', '会话额度耗尽', '【交接包】最后日志：写到 tests/api.test.ts')).toBe(true);
  expect(await task(t.id)).toMatchObject({ state: 'ready', handover: true, previousEmployee: 't-eng-a' });
  await expect(core.submit(tokens['eng-a'], proofOf(first, cp.version), { text: 'Stale session writes must fail.', idempotencyKey: key() }))
    .rejects.toBeDefined();
  const second = await core.claim(tokens['eng-b'], t.id);
  expect(second.fence).toBe(first.fence + 1);
  // Successor sees the predecessor's Paseo session id and can pull its full transcript.
  expect(second.predecessors).toEqual(expect.arrayContaining([
    expect.objectContaining({ employee: 't-eng-a', agentId: 'sess-eng-a', provider: 'codex' })]));
  expect(second.predecessors?.map(p => p.employee)).not.toContain('t-eng-b');
  // Restore invisibility: an agent id on a seeded employee would make the dispatcher adopt it as an instance.
  await database.db.query(`UPDATE employee SET paseo_agent_id = NONE, provider = NONE WHERE id = $e;`,
    { e: new RecordId('employee', 't-eng-a') });
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
  agents = new Map<string, { status: string; error: string; spawn?: SpawnInput; inputTokens?: number }>();
  sent: Array<{ agentId: string; prompt: string }> = [];
  archived: string[] = [];
  async list() { return new Map([...this.agents].map(([id, a]) => [id, { id, status: a.status }])); }
  async status(id: string) { const a = this.agents.get(id); return a ? { status: a.status, pendingPermissions: 0 } : undefined; }
  async lastError(id: string) { return this.agents.get(id)?.error ?? ''; }
  async logsTail(id: string) { return `[Shell] git commit -m wip (agent ${id})`; }
  async lastInputTokens(id: string) { return this.agents.get(id)?.inputTokens; }
  async archive(id: string) { this.archived.push(id); const a = this.agents.get(id); if (a) a.status = 'archived'; }
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
  await workforce.upsertDef('engineering-codex', { role: 'engineering', provider: 'codex', model: 'gpt-6.1-sol', thinking: 'medium', priority: 10 });
  await workforce.upsertDef('engineering-grok', { role: 'engineering', provider: 'grok', model: 'grok-4.7', thinking: 'medium', priority: 20 });
  const paseo = new FakePaseo();
  const notices: string[] = [];
  const dispatcher = new Dispatcher({ workforce, owner, paseo, env: { opsRepo: '/ops', sckBin: '/bin/sck', paseoBin: '/bin/paseo' },
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
  expect(spawned.spawn).toMatchObject({ provider: 'codex', model: 'gpt-6.1-sol', mode: 'full-access', workspaceTitle: 'SCK · engineering-codex' });
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

  // Codex cooldown passes. The review of t can no longer probe the exhausted codex instance:
  // it claimed this task earlier, so contributor recusal keeps former executors out of review
  // candidates (both defs are full, so nothing can spawn either). The review waits in queue,
  // and probe recovery happens through the queued execute work (bump) instead.
  await database.db.query("UPDATE provider_health:codex SET until = 0;");
  report = await dispatcher.tick();
  expect(report.skipped).toBeUndefined();
  expect(report.woke.map(w => w.task)).not.toContain(t.id);
  expect(report.woke.map(w => w.employee)).toEqual([codexInst.employee]);
  expect(report.woke[0].task).toBe(bump.id);
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
  const dispatcher = new Dispatcher({ workforce, owner, paseo, env: { opsRepo: '/ops', sckBin: '/bin/sck', paseoBin: '/bin/paseo' },
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
  const instToken = inst.credential!; // credential-less sessions: minted in memory, never written to a file

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
  const dispatcher = new Dispatcher({ workforce, owner, paseo, env: { opsRepo: '/ops', sckBin: '/bin/sck', paseoBin: '/bin/paseo' }, rand: () => 0 });

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
  const dispatcher = new Dispatcher({ workforce, owner, paseo, env: { opsRepo: '/ops', sckBin: '/bin/sck', paseoBin: '/bin/paseo' },
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
  const dispatcher2 = new Dispatcher({ workforce, owner, paseo, env: { opsRepo: '/ops', sckBin: '/bin/sck', paseoBin: '/bin/paseo' },
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
  const dispatcher = new Dispatcher({ workforce, owner, paseo, env: { opsRepo: '/ops', sckBin: '/bin/sck', paseoBin: '/bin/paseo' },
    rand: () => 0, jev: broken });
  await workforce.upsertDef('eval-grok', { role: 'eval', provider: 'grok', model: 'grok-4.7', thinking: 'medium', weight: 60 });
  await workforce.upsertDef('eval-codex', { role: 'eval', provider: 'codex', model: 'gpt-6.1-sol', thinking: 'low', weight: 30 });

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
  await workforce.upsertDef('gm-codex', { role: 'gm', provider: 'codex', model: 'gpt-6.1-sol', thinking: 'high', maxInstances: 2 });
  await workforce.upsertDef('product-codex', { role: 'product', provider: 'codex', model: 'gpt-6.1-sol', thinking: 'medium', maxInstances: 2 });
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
  const dispatcher = new Dispatcher({ workforce, owner, paseo, env: { opsRepo: '/ops', sckBin: '/bin/sck', paseoBin: '/bin/paseo' }, rand: () => 0, jev });

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
  // quick 链已合并：实现+上线申请是同一个 release 任务，工程提交后 Jev 直接做上线判断。
  const triaged = (await owner.brief()).goals.find(g => g.id === quick.id)!;
  const chain = (await core.listTasks(tokens.gm)).filter(t => t.goalId === quick.id && t.id !== triaged.tasks.manual);
  const ship = chain.find(t => t.kind === 'release')!, deploy = chain.find(t => t.kind === 'deploy')!;
  await execute(tokens['eng-a'], ship.id, '实现+上线申请：PR、分支、提交、测试通过，无迁移，回滚为重发上一提交。');
  report = await dispatcher.tick();
  expect(report.decisions).toContain(`release:${ship.id}`);
  expect(await task(ship.id)).toMatchObject({ state: 'done' });
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
  const reb = await core.claim(tokens['eng-b'], t.id);
  expect(reb.task.state).toBe('doing');
  await core.submit(tokens['eng-b'], proofOf(reb), { text: 'Resumed and delivered after the block.', idempotencyKey: key() });
});

test('a task whose dependencies are already done is created ready', async () => {
  const dep = await core.createTask(tokens.gm, { title: '已完成的前置', context: '前置任务', executorRole: 'engineering',
    reviewerRole: 'engineering', idempotencyKey: key() });
  await execute(tokens['eng-a'], dep.id, '前置任务已完成，提供足够长度的交付证据文本。');
  await review(tokens['eng-b'], dep.id);
  const child = await core.createTask(tokens.gm, { title: '依赖已完成的后续', context: '后续任务', executorRole: 'engineering',
    reviewerRole: 'engineering', dependencies: [dep.id], idempotencyKey: key() });
  expect(child.state).toBe('ready');
});

test('gm defers a gm-blocked execute task onto dependencies: manager wake stops, the gate finishing resumes it for qa', async () => {
  await database.db.query("UPDATE task SET state = 'done', evaluated_at = time::now() WHERE state != 'done';");
  await database.db.query('DELETE provider_health;');
  await database.db.query("UPSERT company_meta:config MERGE { redispatch_minutes: 15, max_running: 8, eval_enabled: false, provider_max: { codex: 8, grok: 8, devin: 8 } };");
  await database.db.query('UPDATE employee_def SET enabled = false;');
  await new ProjectStore(database.db).upsert({ id: 'deferproj', name: 'DF', repoPath: '/repo/defer', release: 'CI', envs: [{ name: 'production' }] });
  const goal = await owner.createGoal({ text: '经理依赖等待', source: 'owner:test', key: key(), tier: 'quick', project: 'deferproj' });
  const gate = await core.createTask(tokens.gm, { title: '恢复门槛', context: '三项修复部署全部完成的前置任务', executorRole: 'engineering',
    reviewerRole: 'engineering', goalId: goal.id, idempotencyKey: key() });
  const qaTask = await core.createTask(tokens.gm, { title: '原QA生产实测', context: '被gm阻塞的执行任务，等待恢复门槛', executorRole: 'qa',
    reviewerRole: 'qa', goalId: goal.id, idempotencyKey: key() });
  const held = await core.claim(tokens.qa, qaTask.id);
  await core.block(tokens.qa, proofOf(held), 'gm', { text: '上游三链仍在进行中，本任务暂不能重复测试，请经理安排依赖等待。', idempotencyKey: key() });
  const beforeVersion = (await task(qaTask.id)).version;
  expect(await task(qaTask.id)).toMatchObject({ state: 'blocked', blockedTo: 'gm' });

  // defer merges the dependency, clears the gm flag and keeps the task out of the work queues.
  const input = { taskId: qaTask.id, dependencies: [gate.id],
    text: '等待恢复门槛 46da040f 的三项修复部署完成后自动恢复，原QA不重复测试。', idempotencyKey: key() };
  const deferred = await core.deferTaskUntil(tokens.gm, input);
  expect(deferred.state).toBe('blocked');
  expect(deferred.blockedTo).toBeUndefined();
  expect(deferred.dependencies).toEqual([gate.id]);
  expect(deferred.version).toBe(beforeVersion + 1);
  const deferredHistory = await core.history(tokens.gm, qaTask.id);
  expect(deferredHistory.at(-1)).toMatchObject({ action: 'deferred', actor: 't-gm' });
  expect(deferredHistory.at(-1)?.evidence).toContain('恢复阶段=doing');
  expect(deferredHistory.at(-1)?.evidence).toContain(`after=[${gate.id}]`);
  // Same key + same payload replays without bumping the version; same key + different payload conflicts.
  expect(await core.deferTaskUntil(tokens.gm, input)).toMatchObject({ version: deferred.version });
  await expect(core.deferTaskUntil(tokens.gm, { ...input, text: '同样的幂等键但理由不同，必须拒绝而不是重放。' }))
    .rejects.toMatchObject({ code: 'conflict' });

  // The dispatcher neither wakes the manager for the task nor dispatches it as qa work.
  const paseo = new FakePaseo();
  const dispatcher = new Dispatcher({ workforce, owner, paseo, env: { opsRepo: '/ops', sckBin: '/bin/sck', paseoBin: '/bin/paseo' }, rand: () => 0 });
  const report = await dispatcher.tick();
  expect(report.woke.some(w => w.task === qaTask.id)).toBe(false);

  // When the gate finishes, UNLOCK_SQL resumes the deferred task and the dispatcher dispatches it to qa.
  await execute(tokens['eng-a'], gate.id, '门槛交付：三项修复部署完成，提供足够长度的交付证据文本。');
  await review(tokens['eng-b'], gate.id);
  const unlocked = await task(qaTask.id);
  expect(unlocked).toMatchObject({ state: 'ready', blockedTo: undefined });
  await workforce.upsertDef('qa-codex', { role: 'qa', provider: 'codex', model: 'gpt-6.1-sol', thinking: 'medium', maxInstances: 2 });
  const resumed = await dispatcher.tick();
  expect(resumed.woke.find(w => w.task === qaTask.id)?.spawned).toBe(true);
  // Cleanup so later tests do not inherit a live qa def or a stray idle instance.
  await database.db.query("UPDATE employee_def SET enabled = false WHERE id = 'qa-codex';");
  await workforce.retire((await workforce.insts()).find(i => i.def === 'qa-codex')!.id, 'defer 测试清理');
});

test('defer_task_until refuses non-gm, owner blocks, review blocks, live leases, cycles, cross-goal and stale versions', async () => {
  const mk = async (title: string, goalId?: string) => core.createTask(tokens.gm, { title, context: 'defer 拒绝矩阵用例',
    executorRole: 'engineering', reviewerRole: 'engineering', goalId, idempotencyKey: key() });
  const reason = '业务理由：依赖尚未完成，需要转为依赖等待而不是重复叫醒经理。';
  const depReady = await mk('就绪依赖');

  // A live lease (state doing) is not a gm block.
  const leased = await mk('租约未释放');
  await core.claim(tokens['eng-a'], leased.id);
  await expect(core.deferTaskUntil(tokens.gm, { taskId: leased.id, dependencies: [depReady.id], text: reason, idempotencyKey: key() }))
    .rejects.toMatchObject({ code: 'invalid' });

  // Owner-gate blocks and review-phase blocks stay out of scope.
  const ownerBlocked = await mk('owner关口阻塞');
  const ownerHold = await core.claim(tokens['eng-b'], ownerBlocked.id);
  await core.block(tokens['eng-b'], proofOf(ownerHold), 'owner', { text: '需要老板决定付费事项才能继续执行本任务。', idempotencyKey: key() });
  await expect(core.deferTaskUntil(tokens.gm, { taskId: ownerBlocked.id, dependencies: [depReady.id], text: reason, idempotencyKey: key() }))
    .rejects.toMatchObject({ code: 'invalid' });

  // Review-phase blocks: release eng-a's lease first so it can take the task to review.
  expect(await workforce.revokeLease(leased.id, 't-eng-a', 'defer 测试：释放 eng-a', '【交接包】测试交接。')).toBe(true);
  const reviewTask = await mk('review期阻塞');
  const reviewDoing = await core.claim(tokens['eng-a'], reviewTask.id);
  await core.submit(tokens['eng-a'], proofOf(reviewDoing), { text: '实现完成，提交评审：交付证据、测试结果与遗留事项都已写明。', idempotencyKey: key() });
  const reviewer = await core.claim(tokens['eng-b'], reviewTask.id);
  await core.block(tokens['eng-b'], proofOf(reviewer), 'gm', { text: '评审发现方向问题，需要经理先做产品决定。', idempotencyKey: key() });
  await expect(core.deferTaskUntil(tokens.gm, { taskId: reviewTask.id, dependencies: [depReady.id], text: reason, idempotencyKey: key() }))
    .rejects.toMatchObject({ code: 'invalid' });

  // A gm-blocked task: self, missing, cycle, cross-goal and stale versions are all refused.
  const blocked = await mk('gm阻塞任务');
  const blockedHold = await core.claim(tokens['eng-b'], blocked.id);
  await core.block(tokens['eng-b'], proofOf(blockedHold), 'gm', { text: '等待外部条件，请经理把本任务转为依赖等待。', idempotencyKey: key() });
  await expect(core.deferTaskUntil(tokens.gm, { taskId: blocked.id, dependencies: [blocked.id], text: reason, idempotencyKey: key() }))
    .rejects.toMatchObject({ code: 'invalid' });
  await expect(core.deferTaskUntil(tokens.gm, { taskId: blocked.id, dependencies: ['00000000-0000-4000-8000-000000000000'], text: reason, idempotencyKey: key() }))
    .rejects.toMatchObject({ code: 'not_found' });
  await expect(core.deferTaskUntil(tokens.gm, { taskId: blocked.id, dependencies: [depReady.id], text: reason, idempotencyKey: key(), expectedVersion: 999 }))
    .rejects.toMatchObject({ code: 'conflict' });
  await expect(core.deferTaskUntil(tokens.product, { taskId: blocked.id, dependencies: [depReady.id], text: reason, idempotencyKey: key() }))
    .rejects.toMatchObject({ code: 'forbidden' });

  // Direct cycle: a waits on b, then b must not wait back on a.
  const a = await mk('环检测A');
  const b = await mk('环检测B');
  const aHold = await core.claim(tokens['eng-b'], a.id);
  await core.block(tokens['eng-b'], proofOf(aHold), 'gm', { text: '环检测用例：a 先转为依赖等待，稍后尝试 b 反向等待制造环。', idempotencyKey: key() });
  await core.deferTaskUntil(tokens.gm, { taskId: a.id, dependencies: [b.id], text: reason, idempotencyKey: key() });
  const bHold = await core.claim(tokens['eng-b'], b.id);
  await core.block(tokens['eng-b'], proofOf(bHold), 'gm', { text: '环检测用例：b 再转为依赖等待，应当被环检测直接拒绝。', idempotencyKey: key() });
  await expect(core.deferTaskUntil(tokens.gm, { taskId: b.id, dependencies: [a.id], text: reason, idempotencyKey: key() }))
    .rejects.toMatchObject({ code: 'invalid' });

  // Dependencies must live inside the task's own goal.
  const goalA = await owner.createGoal({ text: '目标甲', source: 'owner:test', key: key(), tier: 'quick' });
  const goalB = await owner.createGoal({ text: '目标乙', source: 'owner:test', key: key(), tier: 'quick' });
  const inA = (await core.listTasks(tokens.gm)).find(t => t.goalId === goalA.id)!;
  const inB = (await core.listTasks(tokens.gm)).find(t => t.goalId === goalB.id)!;
  await expect(core.deferTaskUntil(tokens.gm, { taskId: blocked.id, dependencies: [inA.id], text: reason, idempotencyKey: key() }))
    .rejects.toMatchObject({ code: 'invalid' });
  // The refused call touched nothing: goalB's tasks never gained the blocked task as a dependency.
  expect((await core.listTasks(tokens.gm)).filter(t => t.goalId === goalB.id).every(t => !t.dependencies.includes(blocked.id))).toBeTrue();
});

test('dispatcher spawns instances in the workspace of the goal project and only reuses them for that project', async () => {
  await database.db.query("UPDATE task SET state = 'done', evaluated_at = time::now() WHERE state != 'done';");
  await database.db.query('DELETE provider_health;');
  await database.db.query("UPSERT company_meta:config MERGE { redispatch_minutes: 15, max_running: 8, eval_enabled: false, provider_max: { codex: 8, grok: 8, devin: 8 } };");
  await database.db.query("UPDATE employee_def SET enabled = false WHERE role = 'engineering';");
  await workforce.upsertDef('engineering-codex', { role: 'engineering', provider: 'codex', model: 'gpt-6.1-sol', thinking: 'medium', maxInstances: 4 });
  await new ProjectStore(database.db).upsert({ id: 'wsproj', name: 'WS', repoPath: '/repo/wsproj', release: 'CI', envs: [{ name: 'production' }] });
  const goal = await owner.createGoal({ text: '工作区归属测试', source: 'owner:test', key: key(), tier: 'quick', project: 'wsproj' });
  const impl = (await core.listTasks(tokens.gm)).find(t => t.goalId === goal.id && t.state === 'ready')!;
  const paseo = new FakePaseo();
  const dispatcher = new Dispatcher({ workforce, owner, paseo, env: { opsRepo: '/ops', sckBin: '/bin/sck', paseoBin: '/bin/paseo' }, rand: () => 0 });
  const report = await dispatcher.tick();
  expect(report.woke.find(w => w.task === impl.id)?.spawned).toBe(true);
  const spawn = [...paseo.agents.values()].find(a => a.spawn?.prompt.includes(impl.id))!.spawn!;
  expect(spawn).toMatchObject({ cwd: '/repo/wsproj', workspaceTitle: 'SCK · engineering-codex' });
  const inst = (await workforce.insts()).find(i => i.cwd === '/repo/wsproj')!;
  expect(inst.role).toBe('engineering');
});

test('dispatcher still spawns for a project when the def is at capacity in another project', async () => {
  await database.db.query("UPDATE task SET state = 'done', evaluated_at = time::now() WHERE state != 'done';");
  await database.db.query('DELETE provider_health;');
  await database.db.query("UPSERT company_meta:config MERGE { redispatch_minutes: 15, max_running: 8, eval_enabled: false, provider_max: { codex: 8, grok: 8, devin: 8 } };");
  await workforce.upsertDef('engineering-devin', { role: 'engineering', provider: 'devin', model: 'swe-2-high', thinking: 'high', maxInstances: 1 });
  const opsInst = await workforce.spawnInst((await workforce.defs()).find(d => d.id === 'engineering-devin')!);
  await workforce.bind(opsInst.id, { agentId: 'ops-eng-agent', cwd: '/ops' });
  await new ProjectStore(database.db).upsert({ id: 'wsproj2', name: 'WS2', repoPath: '/repo/wsproj2', release: 'CI', envs: [{ name: 'production' }] });
  const goal = await owner.createGoal({ text: '跨项目编制', source: 'owner:test', key: key(), tier: 'quick', project: 'wsproj2' });
  const impl = (await core.listTasks(tokens.gm)).find(t => t.goalId === goal.id && t.state === 'ready')!;
  const paseo = new FakePaseo();
  paseo.agents.set('ops-eng-agent', { status: 'idle', error: '' });
  const dispatcher = new Dispatcher({ workforce, owner, paseo, env: { opsRepo: '/ops', sckBin: '/bin/sck', paseoBin: '/bin/paseo' }, rand: () => 0 });
  const report = await dispatcher.tick();
  expect(report.woke.find(w => w.task === impl.id)?.spawned).toBe(true);
  const spawn = [...paseo.agents.values()].find(a => a.spawn?.prompt.includes(impl.id))!.spawn!;
  expect(spawn.cwd).toBe('/repo/wsproj2');
});

test('dispatcher: a returned task goes back to its submitter for rework, review still skips the submitter', async () => {
  await database.db.query("UPDATE task SET state = 'done', evaluated_at = time::now() WHERE state != 'done';");
  await database.db.query('DELETE provider_health;');
  await database.db.query('UPDATE employee SET retired = true WHERE retired = false;');
  await database.db.query('UPDATE employee_def SET enabled = true, error_streak = 0;');
  await database.db.query("UPSERT company_meta:config MERGE { redispatch_minutes: 15, max_running: 8, eval_enabled: false, provider_max: { codex: 8, grok: 8, devin: 8 } };");
  await workforce.upsertDef('engineering-codex', { role: 'engineering', provider: 'codex', model: 'gpt-6.1-sol', thinking: 'medium', maxInstances: 1 });
  await workforce.upsertDef('qa-codex', { role: 'qa', provider: 'codex', model: 'gpt-6.1-sol', thinking: 'medium', maxInstances: 1 });
  const paseo = new FakePaseo();
  const dispatcher = new Dispatcher({ workforce, owner, paseo, env: { opsRepo: '/ops', sckBin: '/bin/sck', paseoBin: '/bin/paseo' }, rand: () => 0 });
  const tokenOf = (employee: string) => readFileSync(join(credDir, `${employee}.token`), 'utf8');

  const t = await core.createTask(tokens.gm, { title: '返工回到提交者', context: 'synthetic', executorRole: 'engineering',
    reviewerRole: 'qa', idempotencyKey: key() });
  let report = await dispatcher.tick();
  const execInst = report.woke.find(w => w.task === t.id)!;
  expect(execInst.spawned).toBe(true);
  const execAgent = [...paseo.agents.keys()][0];

  const claim = await core.claim(tokenOf(execInst.employee), t.id);
  await core.submit(tokenOf(execInst.employee), proofOf(claim), { text: '实现完成：功能已提交到任务分支，测试通过，等待独立验收。', idempotencyKey: key() });
  paseo.set(execAgent, 'idle');

  // Review must be spawned/dispatched to someone other than the submitter.
  report = await dispatcher.tick();
  const reviewInst = report.woke.find(w => w.task === t.id)!;
  expect(reviewInst.employee).not.toBe(execInst.employee);
  expect(reviewInst.employee.startsWith('qa-')).toBe(true);
  const qaAgent = [...paseo.agents.keys()][1];

  const qaClaim = await core.claim(tokenOf(reviewInst.employee), t.id);
  await core.returnTask(tokenOf(reviewInst.employee), proofOf(qaClaim), { text: '验收退回：仍有一项生产实测未执行，需要返工补齐后再交。', idempotencyKey: key() });
  paseo.set(qaAgent, 'idle');

  // The rework goes back to the submitter, who has the context; def is at capacity so nothing else could be picked.
  report = await dispatcher.tick();
  const rework = report.woke.find(w => w.task === t.id);
  expect(rework?.employee).toBe(execInst.employee);
});

test('dispatcher: review skips every task contributor and waits in queue when everyone contributed', async () => {
  await database.db.query("UPDATE task SET state = 'done', evaluated_at = time::now() WHERE state != 'done';");
  await database.db.query('DELETE provider_health;');
  await database.db.query('DELETE owner_notice;');
  await database.db.query('UPDATE employee SET retired = true WHERE retired = false;');
  // 先停用全部编制：早前测试留下的 enabled def（空位）会让「全员贡献者」场景新开出非贡献者实例。
  await database.db.query('UPDATE employee_def SET enabled = false, error_streak = 0;');
  await database.db.query("UPSERT company_meta:config MERGE { redispatch_minutes: 15, max_running: 8, eval_enabled: false, provider_max: { codex: 8, grok: 8, devin: 8 } };");
  await workforce.upsertDef('engineering-codex', { role: 'engineering', provider: 'codex', model: 'gpt-6.1-sol', thinking: 'medium', maxInstances: 1 });
  await workforce.upsertDef('engineering-grok', { role: 'engineering', provider: 'grok', model: 'grok-4.7', thinking: 'medium', maxInstances: 1 });
  const paseo = new FakePaseo();
  const notified: string[] = [];
  const dispatcher = new Dispatcher({ workforce, owner, paseo, env: { opsRepo: '/ops', sckBin: '/bin/sck', paseoBin: '/bin/paseo' },
    rand: () => 0, notify: async (_t, text) => { notified.push(text); } });
  const tokenOf = (employee: string) => readFileSync(join(credDir, `${employee}.token`), 'utf8');

  const t = await core.createTask(tokens.gm, { title: '贡献者回避验收', context: 'synthetic', executorRole: 'engineering',
    reviewerRole: 'engineering', idempotencyKey: key() });
  // E1 实现并提交：audit 记下 claim + submit，E1 成为贡献者与提交者。
  let report = await dispatcher.tick();
  const exec = report.woke.find(w => w.task === t.id)!;
  expect(exec.spawned).toBe(true);
  const execAgent = [...paseo.agents.keys()][0];
  const claim = await core.claim(tokenOf(exec.employee), t.id);
  await core.submit(tokenOf(exec.employee), proofOf(claim), { text: '实现完成：代码在任务分支，测试通过，等待独立验收。', idempotencyKey: key() });
  paseo.set(execAgent, 'idle');

  // Review 派给非贡献者 E2（另一编制新开）；E1（提交者+作者）被排除。
  report = await dispatcher.tick();
  const reviewer = report.woke.find(w => w.task === t.id)!;
  expect(reviewer.employee).not.toBe(exec.employee);
  expect(reviewer.spawned).toBe(true);
  const reviewerAgent = [...paseo.agents.keys()][1];

  // E2 领取复核（audit 记下 claim，E2 也成为贡献者）；租约被收回后 review 仍在队列。
  const reviewClaim = await core.claim(tokenOf(reviewer.employee), t.id);
  await workforce.revokeLease(t.id, reviewer.employee, '会话中断（测试模拟）', '交接包');
  paseo.set(reviewerAgent, 'idle');

  // Review 再派工：E1（提交者+作者）与 E2（复核过的前持有人、非提交人）都被回避，
  // 两个编制均满员无法新开非贡献者 → 任务留在队列，通知里写明回避原因。
  report = await dispatcher.tick();
  expect(report.woke.map(w => w.task)).not.toContain(t.id);
  const staffNotice = (await owner.openNotices()).find(n => n.key === 'staff:engineering');
  expect(staffNotice?.text).toContain('任务贡献者已回避');
  expect((await task(t.id)).state).toBe('review');
});

test('dispatcher: review stays queued while contributor history read fails and resumes when it recovers', async () => {
  await database.db.query("UPDATE task SET state = 'done', evaluated_at = time::now() WHERE state != 'done';");
  await database.db.query('DELETE provider_health;');
  await database.db.query('DELETE owner_notice;');
  await database.db.query('UPDATE employee SET retired = true WHERE retired = false;');
  await database.db.query('UPDATE employee_def SET enabled = false, error_streak = 0;');
  await database.db.query("UPSERT company_meta:config MERGE { redispatch_minutes: 15, max_running: 8, eval_enabled: false, provider_max: { codex: 8, grok: 8, devin: 8 } };");
  await workforce.upsertDef('engineering-codex', { role: 'engineering', provider: 'codex', model: 'gpt-6.1-sol', thinking: 'medium', maxInstances: 1 });
  await workforce.upsertDef('engineering-grok', { role: 'engineering', provider: 'grok', model: 'grok-4.7', thinking: 'medium', maxInstances: 1 });
  const paseo = new FakePaseo();
  // Jev 派工咨询记录：异常读取期间 review 不得进入 Jev 选人（fail-closed）；恢复后候选也不得含贡献者。
  const jevDispatches: Array<{ purpose?: string; taskId?: string; candidates?: Record<string, string> }> = [];
  const jev: JevClient = {
    model: 'jev-test',
    async ask(state: unknown) {
      const d = (state as { dispatch?: { purpose?: string; task?: { id?: string }; candidates?: Record<string, string> } }).dispatch;
      if (d) jevDispatches.push({ purpose: d.purpose, taskId: d.task?.id, candidates: d.candidates });
      return { model: 'jev-test', answers: {} } as never; // 无有效 pick → 加权兜底
    },
  };
  const dispatcher = new Dispatcher({ workforce, owner, paseo, env: { opsRepo: '/ops', sckBin: '/bin/sck', paseoBin: '/bin/paseo' },
    rand: () => 0, jev, notify: async () => {} });
  const tokenOf = (employee: string) => readFileSync(join(credDir, `${employee}.token`), 'utf8');

  const t = await core.createTask(tokens.gm, { title: '历史读取失败验收', context: 'synthetic', executorRole: 'engineering',
    reviewerRole: 'engineering', idempotencyKey: key() });
  // E1 实现并提交：作者+提交者。
  let report = await dispatcher.tick();
  const exec = report.woke.find(w => w.task === t.id)!;
  expect(exec.spawned).toBe(true);
  const execAgent = [...paseo.agents.keys()][0];
  const claim = await core.claim(tokenOf(exec.employee), t.id);
  await core.submit(tokenOf(exec.employee), proofOf(claim), { text: '实现完成：代码在任务分支，测试通过，等待独立验收。', idempotencyKey: key() });
  paseo.set(execAgent, 'idle');

  // Review 派给非贡献者 E2；E2 领取（audit 记下 claim，成为非提交人贡献者）后租约被收回。
  report = await dispatcher.tick();
  const reviewer = report.woke.find(w => w.task === t.id)!;
  expect(reviewer.spawned).toBe(true);
  const reviewerAgent = [...paseo.agents.keys()][1];
  const reviewClaim = await core.claim(tokenOf(reviewer.employee), t.id);
  await workforce.revokeLease(t.id, reviewer.employee, '会话中断（测试模拟）', '交接包');
  paseo.set(reviewerAgent, 'idle');

  // 贡献者历史读取失败：回避名单未知 → fail-closed。E2（非提交人前持有人）不得被重新唤醒，
  // review 留在队列，owner 收件箱通知说明读取失败；Jev 不参与该 review 的选人；execute 派工不受影响。
  const savedEvalState = workforce.evalState.bind(workforce);
  workforce.evalState = async () => { throw new Error('synthetic contributor history read failure'); };
  try {
    const t2 = await core.createTask(tokens.gm, { title: '执行连续性', context: 'synthetic', executorRole: 'engineering',
      reviewerRole: 'qa', idempotencyKey: key() });
    report = await dispatcher.tick();
    expect(report.woke.map(w => w.task)).not.toContain(t.id);
    expect(report.woke.map(w => w.task)).toContain(t2.id);
    expect(report.notices).toContain(`contributors:${t.id}`);
    expect(jevDispatches.filter(d => d.purpose === 'review' && d.taskId === t.id)).toHaveLength(0);
  } finally {
    workforce.evalState = savedEvalState;
  }
  expect((await task(t.id)).state).toBe('review');

  // 读取恢复：失败通知自动清除，回避名单重新生效——两个编制均满员，任务继续等待非贡献者。
  report = await dispatcher.tick();
  expect(report.woke.map(w => w.task)).not.toContain(t.id);
  expect((await owner.openNotices()).some(n => n.key === `contributors:${t.id}`)).toBe(false);
  const staffNotice = (await owner.openNotices()).find(n => n.key === 'staff:engineering');
  expect(staffNotice?.text).toContain('任务贡献者已回避');

  // 有空位可新开非贡献者实例时恢复正常派工；Jev 若参与选人，候选里也不出现贡献者。
  await workforce.upsertDef('engineering-codex', { role: 'engineering', provider: 'codex', model: 'gpt-6.1-sol', thinking: 'medium', maxInstances: 2 });
  await workforce.upsertDef('engineering-grok', { role: 'engineering', provider: 'grok', model: 'grok-4.7', thinking: 'medium', maxInstances: 2 });
  report = await dispatcher.tick();
  const safe = report.woke.find(w => w.task === t.id);
  expect(safe?.spawned).toBe(true);
  expect([exec.employee, reviewer.employee]).not.toContain(safe!.employee);
  for (const d of jevDispatches.filter(d => d.taskId === t.id)) {
    expect(Object.keys(d.candidates ?? [])).not.toContain(exec.employee);
    expect(Object.keys(d.candidates ?? [])).not.toContain(reviewer.employee);
  }
  expect((await task(t.id)).state).toBe('review');
});

test('dispatcher: jev picks among eligible employees using quota and score context', async () => {
  await database.db.query("UPDATE task SET state = 'done', evaluated_at = time::now() WHERE state != 'done';");
  await database.db.query('DELETE provider_health;');
  await database.db.query('UPDATE employee SET retired = true WHERE retired = false;');
  await database.db.query('UPDATE employee_def SET enabled = true, error_streak = 0;');
  await database.db.query("UPSERT company_meta:config MERGE { redispatch_minutes: 15, max_running: 8, eval_enabled: false, provider_max: { codex: 8, grok: 8, devin: 8 }, jev_pick_confidence: 0.5 };");
  await workforce.upsertDef('engineering-devin', { role: 'engineering', provider: 'devin', model: 'swe-2-high', thinking: 'high', maxInstances: 2 });
  await workforce.upsertDef('engineering-grok', { role: 'engineering', provider: 'grok', model: 'grok-4.7', thinking: 'medium', maxInstances: 2 });
  const defs = await workforce.defs();
  const instA = await workforce.spawnInst(defs.find(d => d.id === 'engineering-devin')!);
  await workforce.bind(instA.id, { agentId: 'staff-a-agent', cwd: '/ops' });
  const instB = await workforce.spawnInst(defs.find(d => d.id === 'engineering-grok')!);
  await workforce.bind(instB.id, { agentId: 'staff-b-agent', cwd: '/ops' });
  const paseo = new FakePaseo();
  paseo.agents.set('staff-a-agent', { status: 'idle', error: '' });
  paseo.agents.set('staff-b-agent', { status: 'idle', error: '' });
  const states: Array<{ dispatch?: { candidates?: Record<string, string> } }> = [];
  const jev: JevClient = {
    model: 'jev-test',
    async ask(state: unknown, _qs) {
      states.push(state as never);
      // Always picks instB — after it is assigned for task 1 it drops out of task 2's
      // eligible set, which exercises the fallback to weighted dispatch.
      return { model: 'jev-test', answers: { pick: { type: 'choice', choice: instB.id, confidence: 0.92 } } } as never;
    },
  };
  const dispatcher = new Dispatcher({
    workforce, owner, paseo, env: { opsRepo: '/ops', sckBin: '/bin/sck', paseoBin: '/bin/paseo' },
    rand: () => 0, jev,
    quota: async () => [
      { provider: 'devin', summary: '余额 $0.1/$10', status: 'available' },
      { provider: 'grok', summary: '5h 剩余 90%', status: 'available' },
    ],
  });
  const t1 = await core.createTask(tokens.gm, { title: 'Jev 选人任务一', context: '生产变更，需要可靠执行', executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: key() });
  const t2 = await core.createTask(tokens.gm, { title: 'Jev 选人任务二', context: '常规实现', executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: key() });
  const report = await dispatcher.tick();
  expect(report.woke.find(w => w.task === t1.id)?.employee).toBe(instB.id);
  expect(report.decisions.some(d => d.startsWith(`staff:${t1.id}=${instB.id}`))).toBe(true);
  // instB was already assigned this tick, so Jev's repeated pick was ineligible → weighted fallback → instA.
  expect(report.woke.find(w => w.task === t2.id)?.employee).toBe(instA.id);
  expect(report.decisions.some(d => d.startsWith(`staff:${t2.id}=weighted`))).toBe(true);
  // The choice payload carried every candidate with its quota summary.
  const candidates = states[0]?.dispatch?.candidates ?? {};
  expect(Object.keys(candidates)).toEqual(expect.arrayContaining([instA.id, instB.id, 'spawn:engineering-devin', 'spawn:engineering-grok']));
  expect(Object.values(candidates).join(' ')).toContain('剩余 90%');
  expect(Object.values(candidates).join(' ')).toContain('绩效');
});

test('dispatcher: quota below floor blocks a provider until the snapshot recovers', async () => {
  await database.db.query("UPDATE task SET state = 'done', evaluated_at = time::now() WHERE state != 'done';");
  await database.db.query('DELETE provider_health;');
  await database.db.query('UPDATE employee SET retired = true WHERE retired = false;');
  await database.db.query('UPDATE employee_def SET enabled = false;');
  await database.db.query("UPSERT company_meta:config MERGE { redispatch_minutes: 15, max_running: 8, eval_enabled: false, provider_max: { codex: 8, grok: 8, devin: 8 }, quota_floor_pct: 8 };");
  await workforce.upsertDef('engineering-grok', { role: 'engineering', provider: 'grok', model: 'grok-4.7', thinking: 'medium', maxInstances: 1 });
  const paseo = new FakePaseo();
  let lowestPct: number | undefined = 3;
  let sessionPct: number | undefined;
  let weeklyPct: number | undefined;
  const dispatcher = new Dispatcher({ workforce, owner, paseo, env: { opsRepo: '/ops', sckBin: '/bin/sck', paseoBin: '/bin/paseo' },
    rand: () => 0, quota: async () => [{ provider: 'grok', summary: '余额剩 3%', lowestPct, sessionPct, weeklyPct, status: 'available', fetchedAt: new Date().toISOString() }] });

  const t = await core.createTask(tokens.gm, { title: '额度熔断', context: 'synthetic', executorRole: 'engineering',
    reviewerRole: 'qa', idempotencyKey: key() });
  let report = await dispatcher.tick();
  // grok reports 3% remaining: the only enabled provider is blocked, so dispatch pauses as 'budget'
  // instead of spending a spawn attempt that would just 402.
  expect(report.woke).toHaveLength(0);
  expect(report.skipped).toBe('budget');
  expect(report.notices).toContain('budget');
  expect(paseo.agents.size).toBe(0);

  // Quota recovers → the floor no longer blocks and the task dispatches normally.
  lowestPct = 40;
  await database.db.query('DELETE owner_notice;');
  report = await dispatcher.tick();
  expect(report.woke).toHaveLength(1);
  expect(report.woke[0].task).toBe(t.id);

  // Split floors: a low WEEKLY window does not block under the 2% weekly floor,
  // while a low SESSION window still blocks under the 8% floor.
  for (const [id, a] of paseo.agents) paseo.agents.set(id, { ...a, status: 'idle' });
  lowestPct = undefined;
  sessionPct = 100; weeklyPct = 7;
  const t2 = await core.createTask(tokens.gm, { title: '周额度低于8但高于2不阻断', context: 'synthetic', executorRole: 'engineering',
    reviewerRole: 'qa', idempotencyKey: key() });
  report = await dispatcher.tick();
  expect(report.woke.map(w => w.task)).toContain(t2.id);

  weeklyPct = 1;
  const t3 = await core.createTask(tokens.gm, { title: '周额度低于2阻断', context: 'synthetic', executorRole: 'engineering',
    reviewerRole: 'qa', idempotencyKey: key() });
  report = await dispatcher.tick();
  expect(report.woke.map(w => w.task)).not.toContain(t3.id);

  sessionPct = 5; weeklyPct = 50;
  const t4 = await core.createTask(tokens.gm, { title: '短窗口低于8阻断', context: 'synthetic', executorRole: 'engineering',
    reviewerRole: 'qa', idempotencyKey: key() });
  report = await dispatcher.tick();
  expect(report.woke.map(w => w.task)).not.toContain(t4.id);
});

test('dispatcher: idle sessions past the wake/context limits are rotated out', async () => {
  await database.db.query("UPDATE task SET state = 'done', evaluated_at = time::now() WHERE state != 'done';");
  await database.db.query('DELETE provider_health;');
  await database.db.query('UPDATE employee SET retired = true WHERE retired = false;');
  await database.db.query("UPSERT company_meta:config MERGE { redispatch_minutes: 15, max_running: 8, eval_enabled: false, provider_max: { codex: 8, grok: 8, devin: 8 }, session_max_wakes: 5, session_max_input_k: 150 };");
  const defs = await workforce.defs();
  const engDef = defs.find(d => d.role === 'engineering')!;
  const paseo = new FakePaseo();
  const dispatcher = new Dispatcher({ workforce, owner, paseo, env: { opsRepo: '/ops', sckBin: '/bin/sck', paseoBin: '/bin/paseo' }, rand: () => 0 });

  const stale = await workforce.spawnInst(engDef);
  await workforce.bind(stale.id, { agentId: 'rotate-stale', cwd: '/ops' });
  await database.db.query('UPDATE $e SET wake_count = 6;', { e: new RecordId('employee', stale.id) });
  const fat = await workforce.spawnInst(engDef);
  await workforce.bind(fat.id, { agentId: 'rotate-fat', cwd: '/ops' });
  await database.db.query('UPDATE $e SET wake_count = 4;', { e: new RecordId('employee', fat.id) });
  const fresh = await workforce.spawnInst(engDef);
  await workforce.bind(fresh.id, { agentId: 'rotate-fresh', cwd: '/ops' });
  paseo.agents.set('rotate-stale', { status: 'idle', error: '' });
  paseo.agents.set('rotate-fat', { status: 'idle', error: '', inputTokens: 220_000 });
  paseo.agents.set('rotate-fresh', { status: 'idle', error: '', inputTokens: 30_000 });

  const report = await dispatcher.tick();
  // wake_count ≥ 5 retires on count alone; 4 wakes but 220k input retires on context size; fresh stays.
  expect(report.retired).toEqual(expect.arrayContaining([stale.id, fat.id]));
  expect(report.retired).not.toContain(fresh.id);
  expect(paseo.archived).toEqual(expect.arrayContaining(['rotate-stale', 'rotate-fat']));
  expect(paseo.archived).not.toContain('rotate-fresh');
  const live = await workforce.insts();
  expect(live.map(i => i.id)).toContain(fresh.id);
  expect(live.map(i => i.id)).not.toContain(stale.id);
});

test('dispatcher: quick-goal task is scored by jev even at low confidence (no llm judge)', async () => {
  await database.db.query("UPDATE task SET state = 'done', evaluated_at = time::now() WHERE state != 'done';");
  await database.db.query('UPDATE task SET evaluated_at = time::now() WHERE evaluated_at = NONE;');
  await database.db.query('DELETE provider_health;');
  await database.db.query('UPDATE employee SET retired = true WHERE retired = false;');
  await database.db.query("UPSERT company_meta:config MERGE { redispatch_minutes: 15, max_running: 8, eval_enabled: true, eval_engine: 'auto', provider_max: { codex: 8, grok: 8, devin: 8 }, session_max_wakes: 0, session_max_input_k: 0 };");
  await workforce.upsertDef('eval-grok', { role: 'eval', provider: 'grok', model: 'grok-4.7', thinking: 'medium', weight: 60 });
  await new ProjectStore(database.db).upsert({ id: 'quickproj', name: 'QP', repoPath: '/repo/quickproj', release: 'CI', envs: [{ name: 'production' }] });
  const goal = await owner.createGoal({ text: 'quick 评审测试', source: 'owner:test', key: key(), tier: 'quick', project: 'quickproj' });
  const ship = (await core.listTasks(tokens.gm)).find(t => t.goalId === goal.id && t.kind === 'release')!;
  await execute(tokens['eng-a'], ship.id, '实现+上线申请：PR、分支、提交、测试通过，无迁移，回滚为重发上一提交。');
  await review(tokens.product, ship.id);
  await database.db.query('UPDATE $t SET evaluated_at = NONE;', { t: new RecordId('task', ship.id) });

  const shaky: JevClient = { model: 'jev-test', ask: async (_s: unknown, qs) => {
    const answers: Record<string, unknown> = {};
    for (const [q, spec] of Object.entries(qs)) {
      if (spec.type === 'score') answers[q] = { type: 'score', score: 3, confidence: 0.2 };
      else if (spec.type === 'noul') answers[q] = { type: 'noul', noul: 0.1 };
      else answers[q] = { type: 'choice', choice: 'x', confidence: 0.2 };
    }
    return { model: 'jev-test', answers } as never;
  } };
  const paseo = new FakePaseo();
  const dispatcher = new Dispatcher({ workforce, owner, paseo, env: { opsRepo: '/ops', sckBin: '/bin/sck', paseoBin: '/bin/paseo' }, rand: () => 0, jev: shaky });

  const report = await dispatcher.tick();
  expect(report.evals).toEqual([ship.id]);
  expect(report.woke.filter(w => w.employee.startsWith('eval-'))).toHaveLength(0);   // no LLM judge session
  const [[row]] = await database.db.query<[[{ evaluated_at?: unknown; eval_via?: string }]]>(
    'SELECT evaluated_at, eval_via FROM $t;', { t: new RecordId('task', ship.id) });
  expect(row.evaluated_at).toBeDefined();
  expect(row.eval_via).toBe('jev');
});

test('checkpoint limit rejects chatter and heartbeat still renews the lease', async () => {
  const t = await core.createTask(tokens.gm, { title: 'checkpoint 上限', context: 'synthetic', executorRole: 'engineering',
    reviewerRole: 'engineering', idempotencyKey: key() });
  const claim = await core.claim(tokens['eng-a'], t.id);
  let proof = proofOf(claim);
  for (let i = 0; i < 6; i++) {
    const next = await core.checkpoint(tokens['eng-a'], proof, { text: `第 ${i + 1} 阶段进展记录，内容足够长以通过校验。`, idempotencyKey: key() });
    proof = { taskId: t.id, deliveryId: claim.deliveryId, fence: claim.fence, expectedVersion: next.version };
  }
  await expect(core.checkpoint(tokens['eng-a'], proof, { text: '第七次 checkpoint 应该被限额拒绝，要求改用 submit。', idempotencyKey: key() }))
    .rejects.toMatchObject({ code: 'checkpoint_limit' });
  const renewed = await core.heartbeat(tokens['eng-a'], proof);
  expect(renewed.task.state).toBe('doing');
});

test('model slots: auto defs resolve to newest family model; stale idle instances rotate out before dispatch', async () => {
  await database.db.query("UPDATE task SET state = 'done' WHERE state != 'done';");
  await database.db.query('UPDATE employee_def SET enabled = false;');
  await database.db.query("UPSERT company_meta:config MERGE { redispatch_minutes: 15, max_running: 4, session_max_wakes: 0, session_max_input_k: 0 };");
  await workforce.upsertDef('engineering-codex', { role: 'engineering', provider: 'codex', model: 'auto:sol', thinking: 'medium', maxInstances: 2, priority: 10 });
  const paseo = new FakePaseo();
  const notices: string[] = [];
  const slots: Record<string, string> = { 'codex:sol': 'gpt-6.1-sol' };
  const dispatcher = new Dispatcher({ workforce, owner, paseo, env: { opsRepo: '/ops', sckBin: '/bin/sck', paseoBin: '/bin/paseo' },
    rand: () => 0, notify: async (_t, text) => { notices.push(text); }, models: async () => ({ ...slots }) });
  const mkTask = (title: string) => core.createTask(tokens.gm, { title, context: 'synthetic', executorRole: 'engineering',
    reviewerRole: 'engineering', idempotencyKey: key() });

  // Phase 1: auto:sol resolves to the listed model; the instance records the concrete id.
  await mkTask('slot 任务一');
  let report = await dispatcher.tick();
  expect(report.woke).toHaveLength(1);
  const inst1 = report.woke[0].employee;
  expect([...paseo.agents][0][1].spawn).toMatchObject({ provider: 'codex', model: 'gpt-6.1-sol' });
  const [[e1]] = await database.db.query<[[{ model?: string }]]>('SELECT model FROM $e;', { e: new RecordId('employee', inst1) });
  expect(e1.model).toBe('gpt-6.1-sol');

  // Phase 2: upstream publishes gpt-6.2-sol while inst1 is busy → it survives the tick
  // and finishes its session; the next task spawns a fresh instance on 6.2.
  slots['codex:sol'] = 'gpt-6.2-sol';
  const agent1 = [...paseo.agents][0][0];
  paseo.set(agent1, 'running');
  await mkTask('slot 任务二');
  report = await dispatcher.tick();
  expect(report.retired).not.toContain(inst1);
  expect(report.woke).toHaveLength(1);
  const inst2 = report.woke[0].employee;
  expect(inst2).not.toBe(inst1);
  expect(paseo.agents.get([...paseo.agents][1][0])!.spawn).toMatchObject({ model: 'gpt-6.2-sol' });

  // Phase 3: inst1 goes idle → next tick retires it BEFORE dispatch; task3 reuses inst2
  // (already on the current model) rather than spawning again.
  paseo.set(agent1, 'idle');
  paseo.set([...paseo.agents][1][0], 'idle');
  await mkTask('slot 任务三');
  report = await dispatcher.tick();
  expect(report.retired).toContain(inst1);
  expect(paseo.archived).toContain(agent1);
  expect(report.woke).toHaveLength(1);
  expect(report.woke[0]).toMatchObject({ employee: inst2, spawned: false });
  expect(notices.some(n => n.includes('gpt-6.2-sol'))).toBe(true);

  // Phase 4: slot resolution disappears (provider listModels failing) → defs cannot spawn
  // and the owner is told; the existing current-model instance still serves work.
  paseo.set([...paseo.agents][1][0], 'idle');
  delete slots['codex:sol'];
  await mkTask('slot 任务四');
  report = await dispatcher.tick();
  expect(report.woke.filter(w => w.spawned)).toHaveLength(0);
  expect(report.woke).toHaveLength(1); // inst2 still reusable on last-known model
  expect(notices.some(n => n.includes('模型槽位无法解析'))).toBe(true);
});

test('content line roles: concept-design / asset-production tasks only reach their own defs; cross-role claims denied', async () => {
  await database.db.query("UPDATE task SET state = 'done', evaluated_at = time::now() WHERE state != 'done';");
  await database.db.query('DELETE provider_health;');
  await database.db.query('UPDATE employee SET retired = true WHERE retired = false;');
  await database.db.query('UPDATE employee_def SET enabled = false;');
  await database.db.query("UPSERT company_meta:config MERGE { redispatch_minutes: 15, max_running: 8, eval_enabled: false, provider_max: { codex: 8, grok: 8, devin: 8 } };");
  // Both new roles plus an ai-content def that must never be picked for their tasks.
  await workforce.upsertDef('concept-design-grok', { role: 'concept-design', provider: 'grok', model: 'grok-4.7', thinking: 'medium' });
  await workforce.upsertDef('asset-production-grok', { role: 'asset-production', provider: 'grok', model: 'grok-4.7', thinking: 'medium' });
  await workforce.upsertDef('ai-content-grok', { role: 'ai-content', provider: 'grok', model: 'grok-4.7', thinking: 'medium' });
  // Seed rows cover the new roles on all three subscriptions, same shape as ai-content.
  expect(SEED_DEFS.filter(d => d.role === 'concept-design').map(d => d.provider).sort()).toEqual(['codex', 'devin', 'grok']);
  expect(SEED_DEFS.filter(d => d.role === 'asset-production').map(d => d.provider).sort()).toEqual(['codex', 'devin', 'grok']);
  const paseo = new FakePaseo();
  const dispatcher = new Dispatcher({ workforce, owner, paseo, env: { opsRepo: '/ops', sckBin: '/bin/sck', paseoBin: '/bin/paseo' }, rand: () => 0 });
  const tokenOf = (employee: string) => readFileSync(join(credDir, `${employee}.token`), 'utf8');

  const proto = await core.createTask(tokens.gm, { title: '概念原型 demo', context: 'synthetic',
    executorRole: 'concept-design', reviewerRole: 'gm', idempotencyKey: key() });
  const mass = await core.createTask(tokens.gm, { title: '量产素材批次', context: 'synthetic',
    executorRole: 'asset-production', reviewerRole: 'qa', idempotencyKey: key() });
  // eval is still not a taskable role.
  await expect(core.createTask(tokens.gm, { title: '评审伪装任务', context: 'synthetic',
    executorRole: 'eval', reviewerRole: 'qa', idempotencyKey: key() })).rejects.toMatchObject({ code: 'invalid' });

  const report = await dispatcher.tick();
  const byTask = new Map(report.woke.map(w => [w.task, w.employee]));
  expect(byTask.get(proto.id)!.startsWith('concept-design-')).toBe(true);
  expect(byTask.get(mass.id)!.startsWith('asset-production-')).toBe(true);
  const protoSpawn = [...paseo.agents.values()].find(a => a.spawn?.prompt.includes(proto.id))!.spawn!;
  expect(protoSpawn.prompt).toContain('agents/concept-design.md');
  expect(protoSpawn.labels?.role).toBe('concept-design');

  // 互不错派：原型任务拒绝量产岗与 ai-content 员工领取，量产任务同样拒绝原型岗。
  const aiToken = await enrollment.enroll('t-ai-content-x', 'ai-content', ['execute', 'review']);
  await expect(core.claim(aiToken, proto.id)).rejects.toMatchObject({ code: 'forbidden' });
  await expect(core.claim(tokenOf(byTask.get(mass.id)!), proto.id)).rejects.toMatchObject({ code: 'forbidden' });
  await expect(core.claim(tokenOf(byTask.get(proto.id)!), mass.id)).rejects.toMatchObject({ code: 'forbidden' });

  // The assigned prototype employee runs the normal claim → checkpoint → submit path.
  const protoEmployee = byTask.get(proto.id)!;
  const claim = await core.claim(tokenOf(protoEmployee), proto.id);
  expect(claim.task.state).toBe('doing');
  const cp = await core.checkpoint(tokenOf(protoEmployee), proofOf(claim), { text: '原型首页与样张已出，下一步补 demo 录屏。', idempotencyKey: key() });
  const submitted = await core.submit(tokenOf(protoEmployee), proofOf(claim, cp.version), { text: '原型交付：demo 入口与素材清单见证据。', idempotencyKey: key() });
  expect(submitted.state).toBe('review');
});
