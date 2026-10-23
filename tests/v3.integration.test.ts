import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordId } from 'surrealdb';
import { loadDatabaseConfig } from '../src/config.ts';
import { CompanyDatabase } from '../src/database.ts';
import { createHash } from 'node:crypto';
import { depUnsatisfiedFor, RESOLVE_DEP_SQL, SurrealCompanyCore } from '../src/core.ts';
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
const credDir = mkdtempSync(join(tmpdir(), 'sck-v3-test-'));
const workforce = new Workforce(database, credDir);
const core = new SurrealCompanyCore(database, { workforce });
const enrollment = new LocalEnrollmentAdmin(database);
const owner = new OwnerDesk(database);
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

test('revoked lease: a same-role colleague is refused until gm takes over; the takeover keeps history and fences the old session', async () => {
  const t = await core.createTask(tokens.gm, { title: 'Handover task', context: 'synthetic', executorRole: 'engineering',
    reviewerRole: 'qa', idempotencyKey: key() });
  const first = await core.claim(tokens['eng-a'], t.id);
  const cp = await core.checkpoint(tokens['eng-a'], proofOf(first), { text: '已完成接口草稿与数据结构，下一步编写 tests/api.test.ts 的单元测试。', idempotencyKey: key() });
  await database.db.query(`UPDATE employee SET paseo_agent_id = 'sess-eng-a', provider = 'codex' WHERE id = $e;`,
    { e: new RecordId('employee', 't-eng-a') });
  // A leftover agent id makes the dispatcher adopt t-eng-a as a live instance and retire it, so every exit clears it.
  try {
    expect(await workforce.revokeLease(t.id, 't-eng-a', '会话额度耗尽', '【交接包】最后日志：写到 tests/api.test.ts')).toBe(true);
    expect(await task(t.id)).toMatchObject({ state: 'ready', handover: true, previousEmployee: 't-eng-a', implementer: 't-eng-a' });
    await expect(core.submit(tokens['eng-a'], proofOf(first, cp.version), { text: 'Stale session writes must fail.', idempotencyKey: key() }))
      .rejects.toBeDefined();
    // The first execute claim bound eng-a as the implementer, so a same-role colleague cannot take the code by claiming.
    await expect(core.claim(tokens['eng-b'], t.id)).rejects.toMatchObject({ code: 'forbidden' });
    // Only gm can hand over; a colleague's attempt to take over is refused by capability.
    const expectedVersion = (await task(t.id)).version;
    await expect(core.implementerTakeover(tokens['eng-b'], { taskId: t.id, toEmployee: 't-eng-b', expectedVersion,
      reason: '同岗位员工自行尝试接手', idempotencyKey: key() })).rejects.toMatchObject({ code: 'forbidden' });
    const taken = await core.implementerTakeover(tokens.gm, { taskId: t.id, toEmployee: 't-eng-b', expectedVersion,
      reason: '原实现者会话额度耗尽，经理指定 eng-b 接手', idempotencyKey: key() });
    expect(taken).toMatchObject({ state: 'ready', implementer: 't-eng-b' });
    const second = await core.claim(tokens['eng-b'], t.id);
    expect(second.fence).toBe(first.fence + 1);
    // Successor sees the predecessor's Paseo session id and can pull its full transcript.
    expect(second.predecessors).toEqual(expect.arrayContaining([
      expect.objectContaining({ employee: 't-eng-a', agentId: 'sess-eng-a', provider: 'codex' })]));
    expect(second.predecessors?.map(p => p.employee)).not.toContain('t-eng-b');
    expect(second.history.map(h => h.action)).toEqual(expect.arrayContaining(['claim', 'checkpoint', 'revoked', 'implementer_takeover']));
    expect(second.history.find(h => h.action === 'revoked')?.evidence).toContain('tests/api.test.ts');
    const submitted = await core.submit(tokens['eng-b'], proofOf(second), { text: 'Continued from handover.', idempotencyKey: key() });
    expect(submitted.handover).toBeUndefined();
  } finally {
    await database.db.query(`UPDATE employee SET paseo_agent_id = NONE, provider = NONE WHERE id = $e;`,
      { e: new RecordId('employee', 't-eng-a') });
  }
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
  reloaded: string[] = [];
  async list() { return new Map([...this.agents].map(([id, a]) => [id, { id, status: a.status }])); }
  async status(id: string) { const a = this.agents.get(id); return a ? { status: a.status, pendingPermissions: 0 } : undefined; }
  async lastError(id: string) { return this.agents.get(id)?.error ?? ''; }
  async logsTail(id: string) { return `[Shell] git commit -m wip (agent ${id})`; }
  async lastInputTokens(id: string) { return this.agents.get(id)?.inputTokens; }
  async archive(id: string) { this.archived.push(id); const a = this.agents.get(id); if (a) a.status = 'archived'; }
  async listWorkspaces() { return []; }
  async listProjects() { return []; }
  async archiveWorkspace(_id: string) {}
  async deleteProject(_id: string) {}
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
  async reload(agentId: string) { this.agents.get(agentId)!.status = 'idle'; this.reloaded.push(agentId); }
  set(id: string, status: string, error = '') { const a = this.agents.get(id)!; a.status = status; a.error = error; }
}

test('dispatcher: spawn from defs, a bound implementer is not replaced when its subscription runs out, budget pause, probe recovery', async () => {
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
  // Codex is the bound implementer, so no other engineer is woken for the code work; the lease waits in ready.
  expect(report.woke).toHaveLength(0);
  expect(await task(t.id)).toMatchObject({ state: 'ready', implementer: codexInst.employee, handover: true });
  const history = await core.history(tokens.gm, t.id);
  expect(history.find(h => h.action === 'revoked')?.evidence).toContain('git commit -m wip');
  // The verdict names every effective reason from the same pass: the exhausted bound session, and the spawn gate on others.
  const verdict = dispatcher.dispatchVerdicts().find(v => v.taskId === t.id && v.phase === 'execute')!;
  expect(verdict).toMatchObject({ dispatchable: false, feasible: true, eligibleCount: 0 });
  expect(verdict.reasons.map(r => r.code)).toEqual(['implementer_mismatch', 'quota']);
  expect(verdict.reasons.find(r => r.code === 'quota')?.candidates).toEqual([codexInst.employee]);
  // A fresh episode waits for the five-minute window; the stale error state must not keep extending the cooldown.
  expect(report.notices).not.toContain(`dispatch-blocked:${t.id}:execute`);
  expect((await dispatcher.tick()).exhausted).toEqual([]);

  // Five minutes into the episode the owner gets one notice for the task and phase; repeated ticks keep one open item.
  await database.db.query('UPDATE $t SET dispatch_blocked_since = time::unix(time::now()) - 400;', { t: new RecordId('task', t.id) });
  report = await dispatcher.tick();
  expect(report.notices).toContain(`dispatch-blocked:${t.id}:execute`);
  for (let i = 0; i < 9; i++) await dispatcher.tick();
  expect((await owner.openNotices()).filter(n => n.key === `dispatch-blocked:${t.id}:execute`)).toHaveLength(1);

  // Grok has no session in this scenario, so its subscription is marked exhausted directly. Every subscription is
  // now out: one budget notice, dispatch paused.
  await workforce.markExhausted('grok', 'Rate limit reached, try again later');
  const bump = await core.createTask(tokens.gm, { title: 'Budget probe', context: 'synthetic', executorRole: 'engineering',
    reviewerRole: 'qa', idempotencyKey: key() });
  report = await dispatcher.tick();
  expect(report.skipped).toBe('budget');
  expect(report.notices).toContain('budget');
  expect((await dispatcher.tick()).notices).not.toContain('budget');
  expect(notices.filter(n => n.includes('所有订阅')).length).toBe(1);

  // Probe recovery: the bound implementer resumes its own task, and dispatching it clears the episode notice.
  await database.db.query("UPDATE provider_health:codex SET until = 0;");
  report = await dispatcher.tick();
  expect(report.skipped).toBeUndefined();
  expect(report.woke.map(w => w.employee)).toEqual([codexInst.employee]);
  expect(report.woke[0].task).toBe(t.id);
  expect((await owner.openNotices()).some(n => n.key === `dispatch-blocked:${t.id}:execute`)).toBe(false);
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

test('a task blocked while doing resumes to its bound implementer; a colleague cannot claim the code meanwhile', async () => {
  const t = await core.createTask(tokens.gm, { title: '阻塞后恢复', context: '验证恢复后由绑定实现者重新领取', executorRole: 'engineering',
    reviewerRole: 'engineering', idempotencyKey: key() });
  const held = await core.claim(tokens['eng-a'], t.id);
  await core.block(tokens['eng-a'], proofOf(held), 'gm', { text: '缺少一个前置信息，需要经理协调补充后再恢复本任务继续执行。', idempotencyKey: key() });
  const resumed = await core.resume(tokens.gm, t.id, { text: '经理决定：按原方案继续执行，缺少的前置信息已经补充完整。', idempotencyKey: key() });
  expect(resumed.state).toBe('ready');
  // AC04: the first execute claim bound eng-a as implementer, so the resumed code work stays with eng-a; AC06: a colleague is refused.
  await expect(core.claim(tokens['eng-b'], t.id)).rejects.toMatchObject({ code: 'forbidden' });
  const reb = await core.claim(tokens['eng-a'], t.id);
  expect(reb.task.state).toBe('doing');
  await core.submit(tokens['eng-a'], proofOf(reb), { text: 'Resumed and delivered after the block.', idempotencyKey: key() });
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
  await workforce.retire((await workforce.insts()).find(i => i.def === 'qa-codex')!.id, 'defer 测试清理', 'manual');
});


test('review-phase gm block becomes a formal dependency wait and restores review with the original submission intact', async () => {
  await database.db.query("UPDATE task SET state = 'done', evaluated_at = time::now() WHERE state != 'done';");
  await database.db.query('DELETE provider_health;');
  await database.db.query('UPDATE employee_def SET enabled = false, error_streak = 0;');
  await database.db.query("UPSERT company_meta:config MERGE { redispatch_minutes: 15, max_running: 8, eval_enabled: false, provider_max: { codex: 8, grok: 8, devin: 8 } };");
  const goal = await owner.createGoal({ text: 'QA复核依赖等待', source: 'owner:test', key: key(), tier: 'quick' });
  const gate = await core.createTask(tokens.gm, { title: '新head前置', context: '新 head 独立工程复核与运营批准完成前，QA 不得重复实测。', executorRole: 'engineering', reviewerRole: 'engineering', goalId: goal.id, idempotencyKey: key() });
  const qaTask = await core.createTask(tokens.gm, { title: 'QA复核等待', context: 'QA 在 review 阶段真实 report_blocker，等待新 head 前置完成。', executorRole: 'engineering', reviewerRole: 'qa', goalId: goal.id, idempotencyKey: key() });
  const qaB = await enrollment.enroll('t-qa-b', 'qa', ['execute', 'review']);
  const submitted = await core.claim(tokens['eng-a'], qaTask.id);
  await core.submit(tokens['eng-a'], proofOf(submitted), { text: '工程提交复核：生产实测记录、边界结果与原始断言均已写入证据。', idempotencyKey: key() });
  const blockedBy = await core.claim(qaB, qaTask.id);
  await core.block(qaB, proofOf(blockedBy), 'gm', { text: '新 head 尚无独立工程复核和运营新批准，QA 不能重复实测；请经理挂正式依赖。', idempotencyKey: key() });
  const before = await task(qaTask.id);
  const beforeHistory = await core.history(tokens.gm, qaTask.id);
  expect(before).toMatchObject({ state: 'blocked', blockedTo: 'gm', submittedBy: 't-eng-a', implementer: 't-eng-a' });
  const beforeVersion = before.version;
  const input = { taskId: qaTask.id, dependencies: [gate.id], text: '把 QA 的真实复核阻塞转为正式依赖等待：前置完成前不派 QA、不派实现、不重复叫醒经理。', idempotencyKey: key(), expectedVersion: beforeVersion };
  await expect(core.deferTaskUntil(tokens.gm, { ...input, idempotencyKey: key(), expectedVersion: beforeVersion - 1 }))
    .rejects.toMatchObject({ code: 'conflict' });
  const deferred = await core.deferTaskUntil(tokens.gm, input);
  expect(deferred).toMatchObject({ state: 'blocked', blockedTo: undefined, resumeState: 'review', submittedBy: 't-eng-a', implementer: 't-eng-a', dependencies: [gate.id] });
  expect(deferred.version).toBe(beforeVersion + 1);
  // Same key + same payload replays; same key + different payload conflicts; a stale version is refused.
  expect(await core.deferTaskUntil(tokens.gm, input)).toMatchObject({ version: deferred.version });
  await expect(core.deferTaskUntil(tokens.gm, { ...input, text: '同一幂等键但业务理由不同，必须冲突而不是重放。' }))
    .rejects.toMatchObject({ code: 'conflict' });
  // After a successful defer the row is no longer a gm block, so a new key cannot defer it again.
  await expect(core.deferTaskUntil(tokens.gm, { ...input, idempotencyKey: key() }))
    .rejects.toMatchObject({ code: 'invalid' });

  // The wait only adds the dependency: the original context, submitter, implementer and every prior audit row stay byte-for-byte intact.
  const afterDefer = await task(qaTask.id);
  expect(afterDefer.context).toBe(before.context);
  expect(afterDefer.submittedBy).toBe(before.submittedBy);
  expect(afterDefer.implementer).toBe(before.implementer);
  const afterHistory = await core.history(tokens.gm, qaTask.id);
  expect(afterHistory.slice(0, beforeHistory.length)).toEqual(beforeHistory);
  expect(afterHistory.at(-1)).toMatchObject({ action: 'deferred', actor: 't-gm' });
  expect(afterHistory.at(-1)?.evidence).toContain('来源phase=review');
  expect(afterHistory.at(-1)?.evidence).toContain('恢复阶段=review');
  const [[deferAudit]] = await database.db.query<[[{ source_phase: string; restore_phase: string; result: string; operator: string; dependencies_after: unknown[] }]]>(
    "SELECT source_phase, restore_phase, result, operator, dependencies_after, at FROM audit WHERE task = $task AND action = 'deferred' ORDER BY at DESC LIMIT 1;",
    { task: new RecordId('task', qaTask.id) });
  expect(deferAudit).toMatchObject({ source_phase: 'review', restore_phase: 'review', result: 'blocked', operator: 't-gm' });
  expect(deferAudit.dependencies_after).toHaveLength(1);
  const [[deferOutbox]] = await database.db.query<[[{ payload: { source_phase: string; restore_phase: string; operator: string } }]]>(
    "SELECT payload, sequence FROM outbox WHERE task = $task AND kind = 'deferred' ORDER BY sequence DESC LIMIT 1;",
    { task: new RecordId('task', qaTask.id) });
  expect(deferOutbox.payload).toMatchObject({ source_phase: 'review', restore_phase: 'review', operator: 't-gm' });

  // A manager resume before the dependency is ready must preserve the review target, not clear it into a generic ready/unlock path.
  const early = await core.resume(tokens.gm, qaTask.id, { text: '经理确认前置仍未完成，显式恢复不得丢失 review 目标阶段。', idempotencyKey: key() });
  expect(early).toMatchObject({ state: 'blocked', blockedTo: undefined, resumeState: 'review', submittedBy: 't-eng-a', implementer: 't-eng-a' });
  // A fresh core on the same database sees the same wait (restart persistence), and the dispatcher neither wakes qa nor the manager.
  const fresh = new SurrealCompanyCore(database, { workforce });
  expect(await fresh.getTask(tokens.gm, qaTask.id)).toMatchObject({ state: 'blocked', resumeState: 'review' });
  const paseo = new FakePaseo();
  const dispatcher = new Dispatcher({ workforce, owner, paseo, env: { opsRepo: '/ops', sckBin: '/bin/sck', paseoBin: '/bin/paseo' }, rand: () => 0 });
  await workforce.upsertDef('qa-codex', { role: 'qa', provider: 'codex', model: 'gpt-6.1-sol', thinking: 'medium', maxInstances: 1 });
  let report = await dispatcher.tick();
  expect(report.woke.some(w => w.task === qaTask.id)).toBe(false);

  // The last prerequisite finishes: review comes back, not ready/done/accepted, and the old review proof cannot write.
  await execute(tokens['eng-b'], gate.id, '新 head 前置完成：独立工程复核与运营批准已落库，等待合入。');
  await review(tokens['eng-a'], gate.id);
  const restored = await task(qaTask.id);
  expect(restored).toMatchObject({ state: 'review', blockedTo: undefined, submittedBy: 't-eng-a', implementer: 't-eng-a' });
  expect(restored.resumeState).toBeUndefined();
  await expect(core.accept(qaB, proofOf(blockedBy), { text: '旧 review 租约证明不能越过依赖等待写入。', idempotencyKey: key() })).rejects.toBeDefined();
  const [[unlockAudit]] = await database.db.query<[[{ source_phase: string; restore_phase: string }]]>(
    "SELECT source_phase, restore_phase, at FROM audit WHERE task = $task AND action = 'dependency_unlocked' ORDER BY at DESC LIMIT 1;",
    { task: new RecordId('task', qaTask.id) });
  expect(unlockAudit).toMatchObject({ source_phase: 'review', restore_phase: 'review' });
  // The submitter still cannot review its own delivery; the lease transaction reports self_review before role routing.
  await expect(core.claim(tokens['eng-a'], qaTask.id)).rejects.toMatchObject({ code: 'self_review' });

  // The dispatcher wakes the original reviewer role once; a second tick inside the redispatch window does not create another effective dispatch.
  report = await dispatcher.tick();
  const woke = report.woke.find(w => w.task === qaTask.id)!;
  expect(woke.spawned).toBe(true);
  expect(woke.employee.startsWith('qa-')).toBe(true);
  report = await dispatcher.tick();
  expect(report.woke.some(w => w.task === qaTask.id)).toBe(false);
  const reviewerToken = readFileSync(join(credDir, `${woke.employee}.token`), 'utf8');
  const reviewClaim = await core.claim(reviewerToken, qaTask.id);
  expect(reviewClaim.task.state).toBe('review');
  await core.accept(reviewerToken, proofOf(reviewClaim), { text: '独立复核通过：原始提交与证据未被等待状态改写。', idempotencyKey: key() });
  expect((await task(qaTask.id)).state).toBe('done');

  // A qa submitter is still barred from reviewing its own restored review, even with the same reviewer role.
  const selfTask = await core.createTask(tokens.gm, { title: 'QA自审拒绝', context: '复核恢复后提交者仍不能自验的合成用例。', executorRole: 'qa', reviewerRole: 'qa', goalId: goal.id, idempotencyKey: key() });
  const selfSubmit = await core.claim(tokens.qa, selfTask.id);
  await core.submit(tokens.qa, proofOf(selfSubmit), { text: 'QA 自审用例提交：此处只验证服务端拒绝自验，不声称内容通过。', idempotencyKey: key() });
  const selfBlock = await core.claim(qaB, selfTask.id);
  await core.block(qaB, proofOf(selfBlock), 'gm', { text: 'QA 自审用例阻塞：等待已完成前置后恢复 review。', idempotencyKey: key() });
  const selfDeferred = await core.deferTaskUntil(tokens.gm, { taskId: selfTask.id, dependencies: [gate.id], text: 'QA 自审用例转为正式依赖等待，前置已完成所以应立即恢复 review。', idempotencyKey: key() });
  expect(selfDeferred).toMatchObject({ state: 'review', blockedTo: undefined, submittedBy: 't-qa' });
  await expect(core.claim(tokens.qa, selfTask.id)).rejects.toMatchObject({ code: 'self_review' });

  await database.db.query("UPDATE employee_def SET enabled = false WHERE id = 'qa-codex';");
  const inst = (await workforce.insts()).find(i => i.def === 'qa-codex');
  if (inst) await workforce.retire(inst.id, 'review wait 测试清理', 'manual');
});


test('RW06 cross-version: the pre-RW06 unlock misdispatches a review wait (old-red); the audited restore keeps review and the view names the wait (new-green)', async () => {
  await database.db.query("UPDATE task SET state = 'done', evaluated_at = time::now() WHERE state != 'done';");
  await database.db.query("UPSERT company_meta:config MERGE { redispatch_minutes: 15, max_running: 8, eval_enabled: false };");
  const goal = await owner.createGoal({ text: 'RW06 跨版本对照', source: 'owner:test', key: key(), tier: 'quick' });
  const gate = await core.createTask(tokens.gm, { title: 'RW06 前置门', context: '前置完成前，下面两条复核等待保持 blocked。', executorRole: 'engineering', reviewerRole: 'engineering', goalId: goal.id, idempotencyKey: key() });
  const qaB = await enrollment.enroll('t-qa-c', 'qa', ['execute', 'review']);
  const waitTask = (title: string) => core.createTask(tokens.gm, { title, context: '合成用例：复核阶段阻塞转为正式依赖等待，用于旧红/新绿对照。', executorRole: 'engineering', reviewerRole: 'qa', goalId: goal.id, idempotencyKey: key() });
  const oldRed = await waitTask('RW06 旧版对照');
  const newGreen = await waitTask('RW06 新版对照');
  for (const t of [oldRed, newGreen]) {
    const submitted = await core.claim(tokens['eng-a'], t.id);
    await core.submit(tokens['eng-a'], proofOf(submitted), { text: '工程提交复核：旧红与新绿对照用例的原始交付。', idempotencyKey: key() });
    const blocked = await core.claim(qaB, t.id);
    await core.block(qaB, proofOf(blocked), 'gm', { text: '前置未完成，先挂正式依赖等待，避免误派工程。', idempotencyKey: key() });
    // C3: the manager-blocked view is distinguishable before the wait is formalised.
    // A manager gate on a review-phase task is a manager wait that still names the review phase and reviewer role.
    expect((await task(t.id)).waiting).toMatchObject({ kind: 'manager', resumeState: 'review', role: 'qa' });
    await core.deferTaskUntil(tokens.gm, { taskId: t.id, dependencies: [gate.id], text: '转为正式依赖等待：前置完成前不派复核、不派实现。', idempotencyKey: key() });
    // C3: the dependency wait names the review phase and the reviewing role, not the execute phase.
    expect((await task(t.id)).waiting).toEqual({ kind: 'dependency', resumeState: 'review', role: 'qa', dependenciesCount: 1 });
  }

  // Old-red (the pre-RW06 unlock in 475b5c2): a hard-written ready instead of the phase restore. Keep it as a safety fixture: the
  // product drill reproduced exactly this misdispatch, and the switch guard refuses releases that would do it again.
  await database.db.query("UPDATE ONLY $task SET state = 'ready', resume_state = NONE, resume_role = NONE, current_employee = NONE, delivery_id = NONE, lease_expires_at = NONE, version += 1;", { task: new RecordId('task', oldRed.id) });
  expect((await task(oldRed.id)).state).toBe('ready');
  const misdispatched = await core.claim(tokens['eng-a'], oldRed.id);
  expect(misdispatched.task.state).toBe('doing'); // the wrong execute dispatch the old unlock allows
  // Fixture cleanup: end the misdispatch lease through the ordinary release, then park that row as void so it cannot affect later tests.
  await core.release(tokens['eng-a'], proofOf(misdispatched), { text: '对照夹具：结束旧红误派产生的租约，释放实现人占用的活动任务。', idempotencyKey: key() });
  await database.db.query("UPDATE ONLY $task SET state = 'void', version += 1;", { task: new RecordId('task', oldRed.id) });

  // New-green: the prerequisite finishes through the audited path, and the review wait comes back as review.
  await execute(tokens['eng-b'], gate.id, '前置完成：独立工程复核与运营批准均已落库，可以解锁下游。');
  await review(tokens['eng-a'], gate.id);
  const restored = await task(newGreen.id);
  expect(restored).toMatchObject({ state: 'review', submittedBy: 't-eng-a', implementer: 't-eng-a' });
  expect(restored.waiting).toBeUndefined();
  expect(restored.resumeState).toBeUndefined();
  // The restore did not leak an execute dispatch: another engineer cannot take the code, and the original implementer is the submitter.
  await expect(core.claim(tokens['eng-b'], newGreen.id)).rejects.toMatchObject({ code: 'forbidden' });
  await expect(core.claim(tokens['eng-a'], newGreen.id)).rejects.toMatchObject({ code: 'self_review' });
  const qaClaim = await core.claim(tokens.qa, newGreen.id);
  expect(qaClaim.task.state).toBe('review');
  // A downstream task waiting on the restored one stays blocked: the restore is not an isolation/unlock.
  const downstream = await core.createTask(tokens.gm, { title: 'RW06 下游', context: '依赖复核任务完成，复核尚在进行时必须保持 blocked。', executorRole: 'engineering', reviewerRole: 'qa', goalId: goal.id, dependencies: [newGreen.id], idempotencyKey: key() });
  expect((await task(downstream.id)).state).toBe('blocked');
  expect((await task(downstream.id)).waiting).toMatchObject({ kind: 'dependency' });
  await core.accept(tokens.qa, proofOf(qaClaim), { text: '独立复核通过：复核等待恢复后按原提交验收。', idempotencyKey: key() });
  expect((await task(newGreen.id)).state).toBe('done');
  expect((await task(downstream.id)).state).not.toBe('blocked'); // the ordinary unlock path still works once the dependency is done
});

// RW06 C2: the product drill reproduced the misdispatch with the pre-RW06 code at 475b5c2. This case runs that commit's own
// unlock statement, extracted from the commit (its digest is pinned so the fixture is provably the old code, not a hand-written
// equivalent), with its two SQL helpers expanded by the same builders a runtime would use. Skipped where the clone has no such
// history (CI shallow checkouts); it runs on a full clone and in this review's local runs.
const OLD_475 = '475b5c244f35922baf845325687c42ede82dcf10';
const OLD_475_UNLOCK_SHA256 = '271b11a40af7735a9003fee5a4128afbf1ab50c31482834606c1e91adb050aaa';
const old475Available = (() => {
  try { return Bun.spawnSync(['git', 'cat-file', '-e', `${OLD_475}^{commit}`], { cwd: join(import.meta.dir, '..') }).exitCode === 0; } catch { return false; }
})();

test.skipIf(!old475Available)('RW06 real old code: the 475 unlock statement writes ready and lets an execute claim through', async () => {
  const shown = Bun.spawnSync(['git', 'show', `${OLD_475}:src/core.ts`], { cwd: join(import.meta.dir, '..') });
  const oldSource = shown.stdout.toString();
  const match = /export const UNLOCK_CHILDREN_SQL = `([\s\S]*?)`;/.exec(oldSource);
  expect(match).not.toBeNull();
  const template = match![1];
  expect(createHash('sha256').update(template).digest('hex')).toBe(OLD_475_UNLOCK_SHA256);
  expect(template).not.toContain('$restore_phase'); // the old statement hard-writes ready
  expect(template).toContain("state = 'ready'");
  const oldSql = template
    .replace("${RESOLVE_DEP_SQL('$child.dependencies', '$c_dep')}", RESOLVE_DEP_SQL('$child.dependencies', '$c_dep'))
    .replace("${depUnsatisfiedFor('$child')}", depUnsatisfiedFor('$child'));

  await database.db.query("UPDATE task SET state = 'done', evaluated_at = time::now() WHERE state != 'done';");
  const goal = await owner.createGoal({ text: 'RW06 真实旧代码对照', source: 'owner:test', key: key(), tier: 'quick' });
  const gate = await core.createTask(tokens.gm, { title: '旧代码前置', context: '前置未完成，复核等待保持 blocked，用于真实旧代码对照。', executorRole: 'engineering', reviewerRole: 'engineering', goalId: goal.id, idempotencyKey: key() });
  const waiting = await core.createTask(tokens.gm, { title: '旧代码复核等待', context: '复核阶段阻塞转为依赖等待后，用旧提交自身的解锁语句完成前置。', executorRole: 'engineering', reviewerRole: 'qa', goalId: goal.id, idempotencyKey: key() });
  const submitted = await core.claim(tokens['eng-a'], waiting.id);
  await core.submit(tokens['eng-a'], proofOf(submitted), { text: '工程提交复核：真实旧代码对照的原始交付与证据。', idempotencyKey: key() });
  const qaC = await enrollment.enroll('t-qa-oldcode', 'qa', ['execute', 'review']);
  const blocked = await core.claim(qaC, waiting.id);
  await core.block(qaC, proofOf(blocked), 'gm', { text: '前置未完成，先转正式依赖等待，再用旧代码完成前置。', idempotencyKey: key() });
  await core.deferTaskUntil(tokens.gm, { taskId: waiting.id, dependencies: [gate.id], text: '转为正式依赖等待：前置完成前不派复核与实现。', idempotencyKey: key() });
  // Finish the prerequisite out of band (a status flip, no core transition), so the only unlock statement that runs is the old
  // one under test — the new code's unlock would restore review before the old statement could see the wait.
  await database.db.query("UPDATE ONLY $gate SET state = 'done', version += 1;", { gate: new RecordId('task', gate.id) });
  expect((await task(waiting.id)).state).toBe('blocked');
  const gm = await core.authenticate(tokens.gm);
  await database.db.query(`BEGIN; LET $task = $taskRef; LET $actor = $actorRef; ${oldSql} COMMIT;`, {
    taskRef: new RecordId('task', gate.id), actorRef: new RecordId('employee', gm.employeeId),
  });
  // Old-red: the old unlock writes ready and an execute claim is accepted — the misdispatch the product reproduced.
  expect((await task(waiting.id)).state).toBe('ready');
  // The product drill saw the ORIGINAL implementer's execute claim go through on the wrongly-ready row; the implementer binding is
  // what makes that the visible misdispatch.
  const misdispatched = await core.claim(tokens['eng-a'], waiting.id);
  expect(misdispatched.task.state).toBe('doing');
  await core.release(tokens['eng-a'], proofOf(misdispatched), { text: '真实旧代码对照夹具：结束误派租约并释放活动任务。', idempotencyKey: key() });
  await database.db.query("UPDATE ONLY $task SET state = 'void', version += 1;", { task: new RecordId('task', waiting.id) });
});

test('review wait concurrency, void dependencies and cycle attempts stay fail closed', async () => {
  await database.db.query("UPDATE task SET state = 'done', evaluated_at = time::now() WHERE state != 'done';");
  await database.db.query('DELETE provider_health;');
  await database.db.query('UPDATE employee_def SET enabled = false, error_streak = 0;');
  await database.db.query("UPSERT company_meta:config MERGE { redispatch_minutes: 15, max_running: 8, eval_enabled: false, provider_max: { codex: 8, grok: 8, devin: 8 } };");
  const goal = await owner.createGoal({ text: '复核等待并发与void', source: 'owner:test', key: key(), tier: 'quick' });
  const mkGate = (title: string) => core.createTask(tokens.gm, { title, context: '合成前置：用于复核依赖等待的并发与 void 用例。', executorRole: 'engineering', reviewerRole: 'engineering', goalId: goal.id, idempotencyKey: key() });
  const mkReview = async (title: string) => {
    const t = await core.createTask(tokens.gm, { title, context: '合成复核任务：用于复核依赖等待的并发与 void 用例。', executorRole: 'engineering', reviewerRole: 'qa', goalId: goal.id, idempotencyKey: key() });
    const c = await core.claim(tokens['eng-a'], t.id);
    await core.submit(tokens['eng-a'], proofOf(c), { text: `${title} 提交证据：合成用例包含完整提交与测试断言。`, idempotencyKey: key() });
    const r = await core.claim(tokens.qa, t.id);
    await core.block(tokens.qa, proofOf(r), 'gm', { text: `${title} 复核阻塞：等待经理转为正式依赖。`, idempotencyKey: key() });
    return t;
  };
  const gate1 = await mkGate('并发前置甲');
  const gate2 = await mkGate('并发前置乙');
  const concurrent = await mkReview('并发复核等待');
  const beforeConcurrent = await task(concurrent.id);
  const deferOne = core.deferTaskUntil(tokens.gm, { taskId: concurrent.id, dependencies: [gate1.id], text: '并发经理请求甲：把复核阻塞转为正式依赖等待。', idempotencyKey: key(), expectedVersion: beforeConcurrent.version });
  const deferTwo = core.deferTaskUntil(tokens.gm, { taskId: concurrent.id, dependencies: [gate2.id], text: '并发经理请求乙：把复核阻塞转为正式依赖等待。', idempotencyKey: key(), expectedVersion: beforeConcurrent.version });
  const settled = await Promise.allSettled([deferOne, deferTwo]);
  expect(settled.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect(settled.filter(r => r.status === 'rejected')).toHaveLength(1);
  const concurrentAfter = await task(concurrent.id);
  expect(concurrentAfter).toMatchObject({ state: 'blocked', blockedTo: undefined, resumeState: 'review' });
  expect([gate1.id, gate2.id].filter(id => concurrentAfter.dependencies.includes(id))).toHaveLength(1);
  expect((await core.history(tokens.gm, concurrent.id)).filter(h => h.action === 'deferred')).toHaveLength(1);
  expect(concurrentAfter.version).toBe(beforeConcurrent.version + 1);

  // A void non-owner dependency counts as satisfied, but it restores review, never done/accepted.
  const voidGate = await mkGate('void前置');
  await core.retireTask(tokens.gm, { taskId: voidGate.id, text: '作废合成前置；void 只表示不再等待，不表示真人批准。', idempotencyKey: key(), expectedVersion: voidGate.version });
  const voidReview = await mkReview('void依赖复核');
  const voidDeferred = await core.deferTaskUntil(tokens.gm, { taskId: voidReview.id, dependencies: [voidGate.id], text: '依赖已作废：应恢复原 review 阶段，不能当作验收通过。', idempotencyKey: key() });
  expect(voidDeferred).toMatchObject({ state: 'review', blockedTo: undefined, submittedBy: 't-eng-a', implementer: 't-eng-a' });
  expect(voidDeferred.state).not.toBe('done');

  // An owner gate that was voided is not human approval: the dependent stays blocked.
  const ownerGate = await core.createTask(tokens.gm, { title: 'owner前置', context: 'owner gate void 不是批准的合成用例。', executorRole: 'engineering', reviewerRole: 'owner', goalId: goal.id, idempotencyKey: key() });
  const ownerReview = await mkReview('owner前置依赖复核');
  await core.retireTask(tokens.gm, { taskId: ownerGate.id, text: '作废 owner 前置；void owner gate 不能当作老板批准。', idempotencyKey: key(), expectedVersion: ownerGate.version });
  const ownerDeferred = await core.deferTaskUntil(tokens.gm, { taskId: ownerReview.id, dependencies: [ownerGate.id], text: 'owner gate 已作废但仍未获真人批准：复核任务必须保持 blocked。', idempotencyKey: key() });
  expect(ownerDeferred).toMatchObject({ state: 'blocked', blockedTo: undefined, resumeState: 'review' });

  // A submitter snapshot that no longer matches the latest submit audit fails closed.
  const snapshot = await mkReview('提交快照不一致');
  await database.db.query("UPDATE $task SET submitted_by = 't-eng-b';", { task: new RecordId('task', snapshot.id) });
  await expect(core.deferTaskUntil(tokens.gm, { taskId: snapshot.id, dependencies: [gate1.id], text: '提交快照与历史不一致时必须失败关闭，不能猜测原提交。', idempotencyKey: key() }))
    .rejects.toMatchObject({ code: 'invalid' });
  expect(await task(snapshot.id)).toMatchObject({ state: 'blocked', blockedTo: 'gm' });

  // A review-phase task can wait on another gm-blocked review task, but the reverse edge is a cycle.
  const cycleA = await mkReview('复核环A');
  const cycleB = await mkReview('复核环B');
  await core.deferTaskUntil(tokens.gm, { taskId: cycleA.id, dependencies: [cycleB.id], text: '复核环A先等待复核环B，用于验证反向依赖成环被拒绝。', idempotencyKey: key() });
  await expect(core.deferTaskUntil(tokens.gm, { taskId: cycleB.id, dependencies: [cycleA.id], text: '复核环B反向等待复核环A，必须被依赖环检测拒绝。', idempotencyKey: key() }))
    .rejects.toMatchObject({ code: 'invalid' });
  expect(await task(cycleB.id)).toMatchObject({ state: 'blocked', blockedTo: 'gm' });

  // A raw dependency that resolves to a superseded lineage tip must still be checked for a back-edge.
  const resolvedCycle = await mkReview('解析后环任务');
  const rawDep = await core.createTask(tokens.gm, { title: '解析前旧稿', context: 'superseded lineage fixture', executorRole: 'engineering', reviewerRole: 'engineering', goalId: goal.id, idempotencyKey: key() });
  const tipDep = await core.createTask(tokens.gm, { title: '解析后新稿', context: 'superseded lineage tip fixture', executorRole: 'engineering', reviewerRole: 'engineering', goalId: goal.id, dependencies: [resolvedCycle.id], idempotencyKey: key() });
  await database.db.query("UPDATE $raw SET superseded_by = $tip, lineage = $raw; UPDATE $tip SET lineage = $raw;", { raw: new RecordId('task', rawDep.id), tip: new RecordId('task', tipDep.id) });
  await expect(core.deferTaskUntil(tokens.gm, { taskId: resolvedCycle.id, dependencies: [rawDep.id], text: '原始依赖解析到新 tip 后若回指本任务，必须按解析后环拒绝。', idempotencyKey: key() }))
    .rejects.toMatchObject({ code: 'invalid' });
  expect(await task(resolvedCycle.id)).toMatchObject({ state: 'blocked', blockedTo: 'gm' });

  // Concurrent reverse defers must not create a cycle even when both pre-reads see a clean graph.
  const concurrentA = await mkReview('并发环A');
  const concurrentB = await mkReview('并发环B');
  const concurrentAVersion = (await task(concurrentA.id)).version;
  const concurrentBVersion = (await task(concurrentB.id)).version;
  const cycleSettled = await Promise.allSettled([
    core.deferTaskUntil(tokens.gm, { taskId: concurrentA.id, dependencies: [concurrentB.id], text: '并发环甲：A 等待 B，用于验证并发反向依赖不能成环。', idempotencyKey: key(), expectedVersion: concurrentAVersion }),
    core.deferTaskUntil(tokens.gm, { taskId: concurrentB.id, dependencies: [concurrentA.id], text: '并发环乙：B 等待 A，用于验证并发反向依赖不能成环。', idempotencyKey: key(), expectedVersion: concurrentBVersion }),
  ]);
  const afterA = await task(concurrentA.id);
  const afterB = await task(concurrentB.id);
  expect(cycleSettled.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect(afterA.dependencies.includes(concurrentB.id) && afterB.dependencies.includes(concurrentA.id)).toBe(false);
});

test('defer_task_until refuses non-gm, owner gates, live leases, unprovable/cross-role review history, cycles, cross-goal and stale versions', async () => {
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

  // Review-phase blocks are in scope only with a provable original submit; deleting the
  // submit audit from this synthetic task must make defer fail closed and touch nothing.
  expect(await workforce.revokeLease(leased.id, 't-eng-a', 'defer 测试：释放 eng-a', '【交接包】测试交接。')).toBe(true);
  const reviewTask = await mk('review期阻塞');
  const reviewDoing = await core.claim(tokens['eng-a'], reviewTask.id);
  await core.submit(tokens['eng-a'], proofOf(reviewDoing), { text: '实现完成，提交评审：交付证据、测试结果与遗留事项都已写明。', idempotencyKey: key() });
  const reviewer = await core.claim(tokens['eng-b'], reviewTask.id);
  await core.block(tokens['eng-b'], proofOf(reviewer), 'gm', { text: '评审发现方向问题，需要经理先做产品决定。', idempotencyKey: key() });
  const reviewVersion = (await task(reviewTask.id)).version;
  await database.db.query("DELETE audit WHERE task = $task AND action = 'submit';", { task: new RecordId('task', reviewTask.id) });
  await expect(core.deferTaskUntil(tokens.gm, { taskId: reviewTask.id, dependencies: [depReady.id], text: reason, idempotencyKey: key() }))
    .rejects.toMatchObject({ code: 'invalid' });
  expect(await task(reviewTask.id)).toMatchObject({ state: 'blocked', blockedTo: 'gm', version: reviewVersion });

  // A review block whose recorded role disagrees with reviewer_role is cross-role and refused.
  const crossTask = await mk('跨角色复核阻塞');
  const crossDoing = await core.claim(tokens['eng-a'], crossTask.id);
  await core.submit(tokens['eng-a'], proofOf(crossDoing), { text: '实现完成，提交评审：用于跨角色拒绝用例。', idempotencyKey: key() });
  const crossReviewer = await core.claim(tokens['eng-b'], crossTask.id);
  await core.block(tokens['eng-b'], proofOf(crossReviewer), 'gm', { text: '评审阻塞：该合成任务用于验证跨角色复核阻塞会被拒绝。', idempotencyKey: key() });
  await database.db.query("UPDATE $task SET resume_role = 'qa';", { task: new RecordId('task', crossTask.id) });
  await expect(core.deferTaskUntil(tokens.gm, { taskId: crossTask.id, dependencies: [depReady.id], text: reason, idempotencyKey: key() }))
    .rejects.toMatchObject({ code: 'invalid' });

  // An owner review gate can never be turned into an ordinary dependency wait, even if the row was moved to gm by hand.
  const ownerReview = await core.createTask(tokens.gm, { title: 'owner复核阻塞', context: 'owner review gate must stay outside defer', executorRole: 'engineering', reviewerRole: 'owner', idempotencyKey: key() });
  const ownerDoing = await core.claim(tokens['eng-a'], ownerReview.id);
  await core.submit(tokens['eng-a'], proofOf(ownerDoing), { text: '实现完成，提交老板复核：用于 owner gate 拒绝用例。', idempotencyKey: key() });
  await database.db.query("UPDATE $task SET state = 'blocked', blocked_to = 'gm', resume_state = 'review', resume_role = 'owner';", { task: new RecordId('task', ownerReview.id) });
  await expect(core.deferTaskUntil(tokens.gm, { taskId: ownerReview.id, dependencies: [depReady.id], text: reason, idempotencyKey: key() }))
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
  // 实现任务的后续复核岗位是 product：执行派工前需要一个可派的 product 席位（R1）。
  await workforce.upsertDef('product-codex', { role: 'product', provider: 'codex', model: 'gpt-6.1-sol', thinking: 'medium', maxInstances: 1 });
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
  await workforce.upsertDef('product-codex', { role: 'product', provider: 'codex', model: 'gpt-6.1-sol', thinking: 'medium', maxInstances: 1 });
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

test('dispatcher: review hard-excludes authors but falls back to claim-only prior holders', async () => {
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

  // Review 再派工：E1（提交者+作者）硬回避，E2（复核过的前持有人、仅 claim 未提交）
  // 降为兜底候选——两个编制满员无法新开时，E2 以降权身份接住复核而非死等。
  report = await dispatcher.tick();
  const rewoke = report.woke.find(w => w.task === t.id)!;
  expect(rewoke.employee).toBe(reviewer.employee);
  expect(rewoke.spawned).toBe(false);
  expect((await task(t.id)).state).toBe('review');
});

test('dispatcher: an unreadable contributor history holds review and fresh execute, and both resume when it recovers', async () => {
  await database.db.query("UPDATE task SET state = 'done', evaluated_at = time::now() WHERE state != 'done';");
  await database.db.query('DELETE provider_health;');
  await database.db.query('DELETE owner_notice;');
  await database.db.query('UPDATE employee SET retired = true WHERE retired = false;');
  await database.db.query('UPDATE employee_def SET enabled = false, error_streak = 0;');
  await database.db.query("UPSERT company_meta:config MERGE { redispatch_minutes: 15, max_running: 8, eval_enabled: false, provider_max: { codex: 8, grok: 8, devin: 8 } };");
  await workforce.upsertDef('engineering-codex', { role: 'engineering', provider: 'codex', model: 'gpt-6.1-sol', thinking: 'medium', maxInstances: 1 });
  await workforce.upsertDef('engineering-grok', { role: 'engineering', provider: 'grok', model: 'grok-4.7', thinking: 'medium', maxInstances: 1 });
  const paseo = new FakePaseo();
  // t2 的复核岗位是 qa：执行派工前需要一个可派的 qa 席位（R1）。
  await workforce.upsertDef('qa-codex', { role: 'qa', provider: 'codex', model: 'gpt-6.1-sol', thinking: 'medium', maxInstances: 1 });
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

  // Review 派给非作者 E2；E2 领取复核（review 阶段 claim 记为复核人而非作者）后租约被收回。
  report = await dispatcher.tick();
  const reviewer = report.woke.find(w => w.task === t.id)!;
  expect(reviewer.spawned).toBe(true);
  const reviewerAgent = [...paseo.agents.keys()][1];
  const reviewClaim = await core.claim(tokenOf(reviewer.employee), t.id);
  await workforce.revokeLease(t.id, reviewer.employee, '会话中断（测试模拟）', '交接包');
  paseo.set(reviewerAgent, 'idle');

  // 贡献者历史读取失败：回避名单未知 → fail-closed。review 留在队列，E2 不得在名单未知时被派回；
  // owner 收件箱即刻通知（unknown 即刻可见）；Jev 不参与该 review 的选人。
  // execute 同样 fail-closed（AC04）：新工程任务的实现者绑定读不到，不派给猜测的候选，待历史恢复后再派。
  const t2 = await core.createTask(tokens.gm, { title: '执行连续性', context: 'synthetic', executorRole: 'engineering',
    reviewerRole: 'qa', idempotencyKey: key() });
  const savedContributors = workforce.contributors.bind(workforce);
  workforce.contributors = async () => { throw new Error('synthetic contributor history read failure'); };
  try {
    report = await dispatcher.tick();
    expect(report.woke.map(w => w.task)).not.toContain(t.id);
    expect(report.woke.map(w => w.task)).not.toContain(t2.id);
    expect(report.notices).toContain(`dispatch-blocked:${t.id}:review`);
    expect(report.notices).toContain(`dispatch-blocked:${t2.id}:execute`);
    expect(jevDispatches.filter(d => d.purpose === 'review' && d.taskId === t.id)).toHaveLength(0);
  } finally {
    workforce.contributors = savedContributors;
  }
  expect((await task(t.id)).state).toBe('review');

  // 读取恢复：失败通知自动清除，回避名单生效——E1（作者）硬回避；
  // E2（只复核、从未写代码）仍是合格复核人，复核派回 E2 继续而非死等。
  report = await dispatcher.tick();
  expect((await owner.openNotices()).some(n => n.key === `dispatch-blocked:${t.id}:review`)).toBe(false);
  const rewoke = report.woke.find(w => w.task === t.id)!;
  expect(rewoke.employee).toBe(reviewer.employee);
  expect(rewoke.spawned).toBe(false);
  // The fresh execute task is dispatched once its history reads again, and its episode notice clears.
  expect(report.woke.map(w => w.task)).toContain(t2.id);
  expect((await owner.openNotices()).some(n => n.key === `dispatch-blocked:${t2.id}:execute`)).toBe(false);
  // Jev 若参与选人，候选里不出现作者；经手人可保留（带 prior 标记）。
  for (const d of jevDispatches.filter(d => d.taskId === t.id)) {
    expect(Object.keys(d.candidates ?? [])).not.toContain(exec.employee);
  }
  expect((await task(t.id)).state).toBe('review');
});

test('dispatcher: native Factory is preferred, full capacity falls back to Claude, and staffing never asks Jev', async () => {
  await database.db.query("UPDATE task SET state='done',evaluated_at=time::now() WHERE state!='done';DELETE provider_health;UPDATE employee SET retired=true WHERE retired=false;UPDATE employee_def SET enabled=false;");
  await database.db.query("UPSERT company_meta:config MERGE {redispatch_minutes:15,max_running:8,eval_enabled:false,provider_max:{claude:8,`factory-droid`:1},jev_decisions:true,jev_notify_triage:false};");
  await workforce.upsertDef('engineering-claude',{role:'engineering',provider:'claude',model:'group/sck-haiku',maxInstances:2,quotaLimited:false});
  await workforce.upsertDef('engineering-factory',{role:'engineering',provider:'factory-droid',model:'claude-haiku-5-5',maxInstances:1,quotaLimited:true});
  await workforce.upsertDef('qa-claude',{role:'qa',provider:'claude',model:'group/sck-haiku',maxInstances:2,quotaLimited:false});
  const defs=await workforce.defs();
  const claude=await workforce.spawnInst(defs.find(d=>d.id==='engineering-claude')!);
  await workforce.bind(claude.id,{agentId:'staff-claude-agent',cwd:'/ops'});
  const factory=await workforce.spawnInst(defs.find(d=>d.id==='engineering-factory')!);
  await workforce.bind(factory.id,{agentId:'staff-factory-agent',cwd:'/ops'});
  const paseo=new FakePaseo();paseo.agents.set('staff-claude-agent',{status:'idle',error:''});paseo.agents.set('staff-factory-agent',{status:'idle',error:''});
  let calls=0;
  const dispatcher=new Dispatcher({workforce,owner,paseo,env:{opsRepo:'/ops',sckBin:'/bin/sck',paseoBin:'/bin/paseo'},rand:()=>0,
    jev:{model:'spy',ask:async()=>{calls++;throw Error('staffing must not ask Jev');}},
    quota:async()=>[{provider:'factory-droid',sessionPct:90,weeklyPct:90,status:'available'}]});
  const first=await core.createTask(tokens.gm,{title:'Factory priority first',context:'Synthetic regression',executorRole:'engineering',reviewerRole:'qa',idempotencyKey:key()});
  const second=await core.createTask(tokens.gm,{title:'Claude capacity fallback',context:'Synthetic regression',executorRole:'engineering',reviewerRole:'qa',idempotencyKey:key()});
  const report=await dispatcher.tick();
  expect(report.woke.find(w=>w.task===first.id)?.employee).toBe(factory.id);
  expect(report.woke.find(w=>w.task===second.id)?.employee).toBe(claude.id);
  expect(calls).toBe(0);expect(report.decisions.some(d=>d.startsWith('staff:'))).toBe(false);
});

test('dispatcher: quota below floor blocks a provider until the snapshot recovers', async () => {
  await database.db.query("UPDATE task SET state = 'done', evaluated_at = time::now() WHERE state != 'done';");
  await database.db.query('DELETE provider_health;');
  await database.db.query('UPDATE employee SET retired = true WHERE retired = false;');
  await database.db.query('UPDATE employee_def SET enabled = false;');
  await database.db.query("UPSERT company_meta:config MERGE { redispatch_minutes: 15, max_running: 8, eval_enabled: false, provider_max: { codex: 8, grok: 8, devin: 8 }, quota_floor_pct: 8 };");
  await workforce.upsertDef('engineering-grok', { role: 'engineering', provider: 'grok', model: 'grok-4.7', thinking: 'medium', maxInstances: 1 });
  const paseo = new FakePaseo();
  // 复核岗位同样走 grok 额度熔断：qa 席位存在即保留复核路径（R1），预算暂停语义不变。
  await workforce.upsertDef('qa-grok', { role: 'qa', provider: 'grok', model: 'grok-4.7', thinking: 'medium', maxInstances: 1 });
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
  await database.db.query('UPDATE $def SET enabled=true;', {def:new RecordId('employee_def',engDef.id)}); // isolate rotation from earlier disabled-roster fixtures
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
  // Retire leftover employees from earlier tests: their agent ids belong to a previous FakePaseo,
  // so this pass would read them as missing sessions and archive ids that collide with fresh spawns.
  await database.db.query('UPDATE employee SET retired = true WHERE retired = false;');
  await database.db.query('UPDATE employee_def SET enabled = false;');
  await database.db.query("UPSERT company_meta:config MERGE { redispatch_minutes: 15, max_running: 4, session_max_wakes: 0, session_max_input_k: 0 };");
  await workforce.upsertDef('engineering-codex', { role: 'engineering', provider: 'codex', model: 'auto:sol', thinking: 'medium', maxInstances: 2, priority: 10 });
  const paseo = new FakePaseo();
  const notices: string[] = [];
  const slots: Record<string, string> = { 'codex:sol': 'gpt-6.1-sol' };
  const dispatcher = new Dispatcher({ workforce, owner, paseo, env: { opsRepo: '/ops', sckBin: '/bin/sck', paseoBin: '/bin/paseo' },
    rand: () => 0, notify: async (_t, text) => { notices.push(text); }, models: async () => ({ ...slots }),
    realignAgent: async (agentId, model) => { paseo.reloaded.push(`${agentId}:${model}`); return true; } });
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

  // Phase 3: inst1 goes idle → the pass realigns it to the current model in place (model drift is
  // never a retirement), and task3 is woken on a session already serving that model — no spawn.
  paseo.set(agent1, 'idle');
  paseo.set([...paseo.agents][1][0], 'idle');
  await mkTask('slot 任务三');
  report = await dispatcher.tick();
  expect(report.realigned).toContain(inst1);
  expect(report.retired).not.toContain(inst1);
  expect(paseo.archived).not.toContain(agent1);
  expect(paseo.reloaded).toContain(`${agent1}:gpt-6.2-sol`);
  expect(report.woke).toHaveLength(1);
  expect(report.woke[0].spawned).toBe(false);

  // Phase 4: slot resolution disappears (provider listModels failing) → defs cannot spawn
  // and the owner is told; the existing current-model instance still serves work.
  paseo.set([...paseo.agents][1][0], 'idle');
  delete slots['codex:sol'];
  // 模型槽位消失后 codex 编制不能新开；第二个工程席位保留独立复核路径，inst2 仍可执行（R1）。
  await workforce.upsertDef('engineering-grok', { role: 'engineering', provider: 'grok', model: 'grok-4.7', thinking: 'medium', maxInstances: 1 });
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

test('discipline tracks: project vocabulary, dispatch filter, cross-track claim denial', async () => {
  await database.db.query("UPDATE task SET state = 'done', evaluated_at = time::now() WHERE state != 'done';");
  await database.db.query('DELETE provider_health;');
  await database.db.query('UPDATE employee SET retired = true WHERE retired = false;');
  await database.db.query('UPDATE employee_def SET enabled = false;');
  await database.db.query("UPSERT company_meta:config MERGE { redispatch_minutes: 15, max_running: 8, eval_enabled: false, provider_max: { codex: 8, grok: 8, devin: 8 } };");

  // Project vocabulary: 编剧/角色设计/分镜 as the project's own track names.
  const store = new ProjectStore(database.db);
  await store.upsert({ id: 'anime', name: 'Anime line', repoPath: '/repo/anime', release: '合入即发布',
    disciplines: [{ name: '编剧', description: '剧本与对白' }, { name: '角色设计' }, { name: '分镜' }], envs: [] });
  expect((await store.get('anime'))!.disciplines!.map(d => d.name)).toEqual(['编剧', '角色设计', '分镜']);
  const goal = await owner.createGoal({ text: '产线试点目标', source: 'owner:test', key: key(), tier: 'standard', project: 'anime' });
  // Triage instantiates flow tasks under the goal; park them so they do not enter the dispatch assertions below.
  await database.db.query("UPDATE task SET state = 'done' WHERE goal = $goal;", { goal: new RecordId('goal', goal.id) });

  // Non-vocabulary discipline is rejected only when the project defines a vocabulary.
  await expect(core.createTask(tokens.gm, { title: '错轨任务', context: 'synthetic', executorRole: 'ai-content',
    reviewerRole: 'gm', discipline: '配音', goalId: goal.id, idempotencyKey: key() }))
    .rejects.toMatchObject({ code: 'invalid' });
  // No goal/project: free-form value is allowed.
  const free = await core.createTask(tokens.gm, { title: '自由轨任务', context: 'synthetic', executorRole: 'engineering',
    reviewerRole: 'qa', discipline: '自定义轨', idempotencyKey: key() });
  expect(free.discipline).toBe('自定义轨');

  // Delivery chain: only the implementation leg carries the discipline.
  const chain = await core.createDelivery(tokens.gm, { goalId: goal.id, title: '产线交付链',
    spec: '二十字以上的交付规格说明：剧本、角色、分镜', discipline: '编剧', idempotencyKey: key() });
  expect(chain.map(t => t.discipline)).toEqual(['编剧', undefined, undefined]);

  // Defs: writer covers 编剧, artist covers 角色设计/分镜 (2 seats), any accepts everything.
  await workforce.upsertDef('content-writer', { role: 'ai-content', provider: 'codex', model: 'gpt-6.1-sol', tracks: ['编剧'], priority: 10 });
  await workforce.upsertDef('content-artist', { role: 'ai-content', provider: 'grok', model: 'grok-4.7', tracks: ['角色设计', '分镜'], maxInstances: 2, priority: 20 });
  await workforce.upsertDef('content-any', { role: 'ai-content', provider: 'devin', model: 'swe-2', priority: 30 });

  const mk = (title: string, discipline?: string) => core.createTask(tokens.gm, { title, context: 'synthetic',
    executorRole: 'ai-content', reviewerRole: 'gm', discipline, goalId: goal.id, idempotencyKey: key() });
  const writerTask = await mk('写剧本', '编剧');
  const storyboardTask = await mk('画分镜', '分镜');
  const designTask = await mk('角色设定', '角色设计');
  const untrackedTask = await mk('无轨任务');

  const paseo = new FakePaseo();
  const dispatcher = new Dispatcher({ workforce, owner, paseo, env: { opsRepo: '/ops', sckBin: '/bin/sck', paseoBin: '/bin/paseo' },
    rand: () => 0, notify: async () => {} });
  const report = await dispatcher.tick();
  const byTask = new Map(report.woke.map(w => [w.task, w.employee]));
  // Track-covered tasks go to their own defs; the untracked task falls through to the all-tracks def.
  expect(byTask.get(writerTask.id)!.startsWith('content-writer-')).toBe(true);
  expect(byTask.get(storyboardTask.id)!.startsWith('content-artist-')).toBe(true);
  expect(byTask.get(designTask.id)!.startsWith('content-artist-')).toBe(true);
  expect(byTask.get(untrackedTask.id)!.startsWith('content-any-')).toBe(true);
  const tokenOf = (employee: string) => readFileSync(join(credDir, `${employee}.token`), 'utf8');

  // Cross-track direct claim is explicitly refused; the same task is claimable by its own track.
  await expect(core.claim(tokenOf(byTask.get(storyboardTask.id)!), writerTask.id))
    .rejects.toMatchObject({ code: 'forbidden', message: 'Employee definition does not cover the task discipline' });
  const claim = await core.claim(tokenOf(byTask.get(writerTask.id)!), writerTask.id);
  expect(claim.task.discipline).toBe('编剧');
  // Empty tracks accept any discipline; employees without a def (fixed identities) are unrestricted.
  await core.claim(tokenOf(byTask.get(untrackedTask.id)!), storyboardTask.id);
  const aiToken = await enrollment.enroll('t-ai-anytrack', 'ai-content', ['execute', 'review']);
  await core.claim(aiToken, designTask.id);
});

test('screenwriter: required-track create_task, claim gating with and without a covering def', async () => {
  // create_task 端：必配轨岗位（REQUIRED_TRACKS）缺轨/错轨显式 invalid，编剧轨任务正常接受。
  await expect(core.createTask(tokens.gm, { title: '剧本 v1（缺轨）', context: 'synthetic',
    executorRole: 'screenwriter', reviewerRole: 'gm', idempotencyKey: key() }))
    .rejects.toMatchObject({ code: 'invalid', message: 'executorRole screenwriter requires discipline=编剧' });
  await expect(core.createTask(tokens.gm, { title: '剧本 v1（错轨）', context: 'synthetic',
    executorRole: 'screenwriter', reviewerRole: 'gm', discipline: '分镜', idempotencyKey: key() }))
    .rejects.toMatchObject({ code: 'invalid' });
  const scripted = await core.createTask(tokens.gm, { title: '剧本 v1', context: 'synthetic',
    executorRole: 'screenwriter', reviewerRole: 'gm', discipline: '编剧', idempotencyKey: key() });
  expect(scripted.discipline).toBe('编剧');

  await workforce.upsertDef('screenwriter-agy', { role: 'screenwriter', provider: 'antigravity', model: 'gemini-3.7-flash-medium', tracks: ['编剧'] });
  const def = (await workforce.defs()).find(d => d.id === 'screenwriter-agy')!;
  const inst = await workforce.spawnInst(def);
  const token = inst.credential!; // credential-less sessions: minted in memory, never written to a file

  // claim 端：存量错轨任务（模拟旁路写入）对编剧编制显式 forbidden。
  await database.db.query('UPDATE $id SET discipline = "分镜";', { id: new RecordId('task', scripted.id) });
  await expect(core.claim(token, scripted.id))
    .rejects.toMatchObject({ code: 'forbidden', message: 'Employee definition does not cover the task discipline' });
  await database.db.query('UPDATE $id SET discipline = "编剧";', { id: new RecordId('task', scripted.id) });
  const claim = await core.claim(token, scripted.id);
  expect(claim.task.discipline).toBe('编剧');
  await core.submit(token, proofOf(claim, claim.task.version), { text: '剧本 v1 初稿完成：故事大纲、分场与角色小传已写入任务目录，等待验收。', idempotencyKey: key() });

  // 空 tracks 对必配轨岗位不再视为全接：无轨编制的 screenwriter 领编剧任务 forbidden。
  await workforce.upsertDef('screenwriter-notrack', { role: 'screenwriter', provider: 'antigravity', model: 'gemini-3.7-flash-medium' });
  const bareDef = (await workforce.defs()).find(d => d.id === 'screenwriter-notrack')!;
  const bare = await workforce.spawnInst(bareDef);
  const next = await core.createTask(tokens.gm, { title: '剧本 v2', context: 'synthetic',
    executorRole: 'screenwriter', reviewerRole: 'gm', discipline: '编剧', idempotencyKey: key() });
  await expect(core.claim(bare.credential!, next.id)).rejects.toMatchObject({ code: 'forbidden' });

  // 固定身份（无 def）的 screenwriter 同样 forbidden：必配轨要求编制显式覆盖。
  const fixed = await enrollment.enroll('t-sw-fixed', 'screenwriter', ['execute', 'review']);
  await expect(core.claim(fixed, next.id)).rejects.toMatchObject({ code: 'forbidden' });

  // 无轨任务对其它岗位保持原语义：普通岗位照常领取（fresh 身份，不受前序测试租约影响）。
  const plain = await core.createTask(tokens.gm, { title: '普通工程任务', context: 'synthetic',
    executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: key() });
  await core.claim(await enrollment.enroll('t-eng-fresh', 'engineering', ['execute', 'review']), plain.id);
});

test('manage tools: def_list/def_ensure/project_disciplines_update are manage-only, audited and surgical', async () => {
  // 无 manage 能力的岗位一律 forbidden（def_list 只读也一样）。
  await expect(core.listDefs(tokens['eng-a'])).rejects.toMatchObject({ code: 'forbidden' });
  await expect(core.ensureDef(tokens['eng-a'], { id: 'screenwriter-x', role: 'screenwriter', provider: 'antigravity', model: 'gemini-3.7-flash-medium' }))
    .rejects.toMatchObject({ code: 'forbidden' });
  await expect(core.updateProjectDisciplines(tokens['eng-a'], { project: 'disc-proj', disciplines: [] }))
    .rejects.toMatchObject({ code: 'forbidden' });

  // def_ensure：创建带轨编制 → 不传 tracks 保留 → [] 清轨 → enabled=false 停用；非法 role invalid。
  await core.ensureDef(tokens.gm, { id: 'screenwriter-second', role: 'screenwriter', provider: 'antigravity', model: 'gemini-3.7-flash-medium', tracks: ['编剧'], weight: 50 });
  expect((await workforce.defs()).find(d => d.id === 'screenwriter-second')).toMatchObject({ role: 'screenwriter', provider: 'antigravity', tracks: ['编剧'], enabled: true, weight: 50 });
  await core.ensureDef(tokens.gm, { id: 'screenwriter-second', role: 'screenwriter', provider: 'antigravity', model: 'gemini-3.7-flash-medium' });
  expect((await workforce.defs()).find(d => d.id === 'screenwriter-second')!.tracks).toEqual(['编剧']);
  await core.ensureDef(tokens.gm, { id: 'screenwriter-second', role: 'screenwriter', provider: 'antigravity', model: 'gemini-3.7-flash-medium', tracks: [], enabled: false });
  const cleared = (await workforce.defs()).find(d => d.id === 'screenwriter-second')!;
  expect(cleared.tracks).toEqual([]);
  expect(cleared.enabled).toBe(false);
  await expect(core.ensureDef(tokens.gm, { id: 'bogus-def', role: 'no-such-role' as never, provider: 'antigravity', model: 'x' }))
    .rejects.toMatchObject({ code: 'invalid' });

  // project_disciplines_update：只改 disciplines，其余字段不动；名字唯一非空；项目必须存在。
  const projects = new ProjectStore(database.db);
  await projects.upsert({ id: 'disc-proj', name: '词表项目', repoPath: '/repo/disc-proj', release: 'manual', envs: [] });
  const updated = await core.updateProjectDisciplines(tokens.gm, { project: 'disc-proj', disciplines: [{ name: '编剧', description: '剧本与分场' }, { name: '角色设计' }] });
  expect(updated.repoPath).toBe('/repo/disc-proj');
  expect(updated.disciplines!.map(d => d.name)).toEqual(['编剧', '角色设计']);
  await expect(core.updateProjectDisciplines(tokens.gm, { project: 'disc-proj', disciplines: [{ name: '编剧' }, { name: '编剧' }] }))
    .rejects.toMatchObject({ code: 'invalid' });
  await expect(core.updateProjectDisciplines(tokens.gm, { project: 'no-such-proj', disciplines: [] }))
    .rejects.toMatchObject({ code: 'not_found' });

  // 两类写入均落审计（3 次 def_ensure + 1 次 project_disciplines_update 成功；被拒调用不落）。
  const [[auditRow]] = await database.db.query<[[{ n: number }]]>(
    "SELECT count() AS n FROM audit WHERE action IN ['def_ensure', 'project_disciplines_update'] GROUP ALL;");
  expect(auditRow.n).toBeGreaterThanOrEqual(4);

  // def_list 返回管理视图（编制对 gm 可见，含种子编剧轨）。
  const listed = (await core.listDefs(tokens.gm)).find(d => d.id === 'screenwriter-agy');
  expect(listed).toMatchObject({ role: 'screenwriter', provider: 'antigravity', tracks: ['编剧'], enabled: true });
});

test('quota gate: bad reset times are refused; a valid one keeps gm quiet until the reset, then one notice', async () => {
  await database.db.query("UPDATE task SET state = 'done' WHERE state != 'done';");
  await database.db.query("UPSERT company_meta:config MERGE { redispatch_minutes: 15, max_running: 4 };");
  await workforce.upsertDef('gm-codex', { role: 'gm', provider: 'codex', model: 'gpt-6.1-sol', thinking: 'medium', priority: 10 });
  const paseo = new FakePaseo();
  const dispatcher = new Dispatcher({ workforce, owner, paseo, env: { opsRepo: '/ops', sckBin: '/bin/sck', paseoBin: '/bin/paseo' },
    rand: () => 0, notify: async () => {} });
  const t = await core.createTask(tokens.gm, { title: 'Quota gate', context: 'synthetic', executorRole: 'engineering',
    reviewerRole: 'qa', idempotencyKey: key() });
  // A fresh holder: earlier tests in this file leave eng-a with an active task.
  const holder = await enrollment.enroll(`t-quota-${key()}`, 'engineering', ['execute', 'review']);
  const claim = await core.claim(holder, t.id);
  const evidence = () => ({ text: 'Synthetic quota block: subscription limit reached.', idempotencyKey: key() });
  const taskRow = async () => {
    const [rows] = await database.db.query<[Array<{ state: string; blocked_to?: string; quota_resets_at?: number | null }>]>(
      'SELECT state, blocked_to, quota_resets_at FROM task WHERE id = $t;', { t: new RecordId('task', t.id) });
    return rows[0];
  };
  const idleAll = () => { for (const agent of paseo.agents.keys()) paseo.set(agent, 'idle'); };

  // A bare clock time is refused before the transition: the task stays with its holder.
  await expect(core.block(holder, proofOf(claim), 'gm', evidence(), '2026-10-18T10:12:00'))
    .rejects.toThrow('explicit timezone offset');
  expect(await taskRow()).toMatchObject({ state: 'doing' });

  const resetAt = new Date(Date.now() + 3600_000).toISOString();
  await core.block(holder, proofOf(claim), 'gm', evidence(), resetAt);
  expect(await taskRow()).toMatchObject({ state: 'blocked', blocked_to: 'gm', quota_resets_at: Math.floor(Date.parse(resetAt) / 1000) });

  // gm hears about the block once.
  let report = await dispatcher.tick();
  expect(report.woke.map(w => w.task)).toContain(t.id);

  // Inside the gate the 15-minute redispatch does not re-announce the same version.
  await database.db.query('UPDATE dispatch SET at = at - 7200 WHERE task = $task;', { task: t.id });
  // The GM turn is idle; simulate the same elapsed interval for the durable wake attempt so
  // the conservative turn-end grace sees a provable end rather than a just-started session.
  await database.db.query("UPDATE dispatch SET started_at = $past, external_started_at = $past WHERE task = $task AND purpose = 'gm-manager-wake';",
    { task: t.id, past: Math.floor(Date.now() / 1000) - 7200 });
  idleAll();
  report = await dispatcher.tick();
  expect(report.woke.map(w => w.task)).not.toContain(t.id);

  // The reset instant passes: gm gets exactly one notice to resume, then the cadence is quiet again.
  await database.db.query('UPDATE ONLY $task SET quota_resets_at = $past;',
    { task: new RecordId('task', t.id), past: Math.floor(Date.now() / 1000) - 60 });
  idleAll();
  report = await dispatcher.tick();
  expect(report.woke.map(w => w.task)).toContain(t.id);
  idleAll();
  report = await dispatcher.tick();
  expect(report.woke.map(w => w.task)).not.toContain(t.id);
});

test('MR02 real fork: two dispatchers can obtain only one in-flight manager wake and one external action', async () => {
  await database.db.query("UPDATE task SET state = 'done', evaluated_at = time::now() WHERE state != 'done';");
  await database.db.query('DELETE provider_health;');
  await database.db.query('UPDATE employee_def SET enabled = false, error_streak = 0;');
  await database.db.query('UPDATE employee SET retired = true WHERE retired = false;');
  await database.db.query("UPSERT company_meta:config MERGE { redispatch_minutes: 15, max_running: 8, eval_enabled: false, provider_max: { codex: 8 }, minFreeMemMb: 0, minFreeDiskMb: 0, artifactReclaimEnabled: false, blockLoopLimit: 0 };");
  const taskId = crypto.randomUUID();
  const taskRef = new RecordId('task', taskId);
  await database.db.query(`CREATE ONLY $task CONTENT {
      title: 'MR02 real fork', context: 'synthetic ambiguous implementer', state: 'ready',
      executor_role: 'engineering', reviewer_role: 'engineering', dependencies: [], version: 1, fence: 0,
      submitted_by: NONE, current_employee: NONE, delivery_id: NONE, lease_expires_at: NONE,
      resume_role: NONE, resume_state: 'ready', blocked_to: NONE, kind: 'task', created_at: time::now() };
    CREATE audit CONTENT { task: $task, actor: $a, action: 'claim', phase: 'execute', version: 1, at: time::now() };
    CREATE audit CONTENT { task: $task, actor: $b, action: 'claim', phase: 'execute', version: 1, at: time::now() };`,
    { task: taskRef, a: new RecordId('employee', 't-eng-a'), b: new RecordId('employee', 't-eng-b') });
  await workforce.upsertDef('engineering-codex', { role: 'engineering', provider: 'codex', model: 'gpt-6.1-sol', thinking: 'medium', maxInstances: 1 });
  await workforce.upsertDef('gm-codex', { role: 'gm', provider: 'codex', model: 'gpt-6.1-sol', thinking: 'medium', maxInstances: 2 });
  const paseo = new FakePaseo();
  const makeDispatcher = () => new Dispatcher({ workforce, owner, paseo,
    env: { opsRepo: '/ops', sckBin: '/bin/sck', paseoBin: '/bin/paseo' }, rand: () => 0, notify: async () => {} });
  const [first, second] = await Promise.all([makeDispatcher().tick(), makeDispatcher().tick()]);
  const woke = [...first.woke, ...second.woke].filter(w => w.task === taskId);
  expect(woke).toHaveLength(1);
  expect((await workforce.openManagerActions()).filter(a => a.taskId === taskId)).toHaveLength(1);
  const wakes = (await workforce.openManagerWakes()).filter(w => w.taskId === taskId);
  expect(wakes).toHaveLength(1);
  expect(['pending', 'running']).toContain(wakes[0]!.state);
  const externalActions = () => [...paseo.agents.values()].filter(a => a.spawn?.prompt.includes(taskId)).length
    + paseo.sent.filter(s => s.prompt.includes(taskId)).length;
  expect(externalActions()).toBe(1);
  // Restart a fresh dispatcher after the throttle window: the running owner still holds the episode.
  await database.db.query("UPDATE dispatch SET at = $past WHERE task = $task AND string::starts_with(purpose, 'gm-manager-action:');", { task: taskId, past: Math.floor(Date.now() / 1000) - 7200 });
  const restarted = await makeDispatcher().tick();
  expect(restarted.woke.filter(w => w.task === taskId)).toHaveLength(0);
  expect((await workforce.openManagerWakes()).filter(w => w.taskId === taskId)).toHaveLength(1);
  expect(externalActions()).toBe(1);
});
