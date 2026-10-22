// QA 受限只读取证（SYS-DISP 7454fc89）的公司 fork 回归：真实 core/事务，不是纯函数 mock。
// 覆盖 GM 登记/撤销 scope、QA 本人凭证与浏览器受限会话读取、租约 holder/fence 绑定、同 goal/allowlist、
// 过期/撤销/跨 goal/错误角色、分页与 hash 续读、未知贡献 fail-closed、幂等与 CAS。
import { afterAll, beforeAll, beforeEach, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDatabaseConfig } from '../src/config.ts';
import { CompanyDatabase } from '../src/database.ts';
import { SurrealCompanyCore } from '../src/core.ts';
import { CompanyError } from '../src/core-errors.ts';
import { LocalEnrollmentAdmin } from '../src/enrollment.ts';
import { OwnerDesk } from '../src/owner.ts';

setDefaultTimeout(600_000);
const fork = process.env.RUN_SCK_WORKTREE_FORK_TESTS === '1' ? test : test.skip;
const NS = 'sck_qa_observation_test';
const database = new CompanyDatabase({ ...loadDatabaseConfig(), namespace: NS, database: 'control_plane' });
const credDir = mkdtempSync(join(tmpdir(), 'sck-qa-observation-'));
const owner = new OwnerDesk(database);
const enrollment = new LocalEnrollmentAdmin(database);
const core = new SurrealCompanyCore(database);
const tokens: Record<string, string> = {};
const key = () => `qa-${crypto.randomUUID()}`;
let goalId = '';
let deployId = '';
let subjectId = '';
let qaFence = 0;
let scopeId = '';

const proofOf = (claim: { task: { id: string; version: number }; deliveryId: string; fence: number }) =>
  ({ taskId: claim.task.id, deliveryId: claim.deliveryId, fence: claim.fence, expectedVersion: claim.task.version });
const expectRefused = async (promise: Promise<unknown>, code: CompanyError['code'], pattern: RegExp) => {
  const error = await promise.then(() => undefined, (reason: unknown) => reason);
  expect(error).toBeInstanceOf(CompanyError);
  expect((error as CompanyError).code).toBe(code);
  expect((error as CompanyError).message).toMatch(pattern);
};

beforeAll(async () => {
  await database.connect();
  await database.db.query(`DEFINE NAMESPACE IF NOT EXISTS ${NS};`);
  await database.db.use({ namespace: NS });
  await database.db.query('REMOVE DATABASE IF EXISTS control_plane;');
  await database.bootstrap();
  for (const [name, role, caps] of [
    ['gm', 'gm', ['execute', 'review', 'manage']],
    ['eng', 'engineering', ['execute', 'review']],
    ['qa', 'qa', ['execute', 'review']],
    ['qa2', 'qa', ['execute', 'review']],
  ] as const) tokens[name] = await enrollment.enroll(`qa-obs-${name}`, role, caps);
  const goal = await owner.createGoal({ text: 'QA 受限只读取证测试目标', source: 'owner:test', key: key(), tier: 'quick' });
  goalId = goal.id;
  const deploy = await core.createTask(tokens.gm, { goalId, title: '部署任务（QA 复核）', context: '部署任务上下文。', executorRole: 'engineering', reviewerRole: 'qa', kind: 'deploy', idempotencyKey: key() });
  deployId = deploy.id;
  const first = await core.claim(tokens.eng, deployId);
  await core.submit(tokens.eng, proofOf(first), { text: '部署任务已实现并通过本地验证，提交独立 QA 复核；本轮不部署、不启用门禁。', idempotencyKey: key() });
  const review = await core.claim(tokens.qa, deployId);
  qaFence = review.fence;
  const subject = await core.createTask(tokens.gm, { goalId, title: '被核验主体任务', context: '主体任务上下文：' + '中文🙂'.repeat(3000), executorRole: 'engineering', reviewerRole: 'product', kind: 'task', idempotencyKey: key() });
  subjectId = subject.id;
  // Legacy contribution row with no phase and no follow-up: the reader must keep it as unknown, not drop it.
  await database.db.query(`CREATE audit CONTENT { task: type::record('task', $task), action: 'checkpoint', actor: type::record('employee', 'legacy-unknown-author'), evidence: '旧贡献记录，无 phase', version: 1, at: time::now() };`, { task: subjectId });
  await database.db.query(`CREATE audit CONTENT { task: type::record('task', $task), action: 'checkpoint', actor: type::record('employee', 'eng-other'), evidence: $evidence, version: 2, at: time::now() };`, { task: subjectId, evidence: '审计证据'.repeat(200) });
  await database.db.query(`UPSERT company_meta:dispatch_observation CONTENT { at: $at, verdicts: $verdicts };`, {
    at: new Date().toISOString(),
    verdicts: [{ taskId: subjectId, phase: 'execute', dispatchable: false, workflowState: 'ready', eligibleCount: 0, feasible: false,
      summary: '无独立复核人选', checkedAt: new Date().toISOString(), waitingMinutes: 5,
      reasons: [{ code: 'author_recusal', text: '本任务作者不能复核', candidates: ['eng-other'], owner: 'gm',
        recovery: '经理增补独立复核人选', nextTrigger: '出现独立候选人选', basis: 'contribution-audit' }] }],
  });
  await database.db.query(`UPSERT company_meta:dispatch_observation_status CONTENT { at: $at, ok: true, error: '' };`, { at: new Date().toISOString() });
}, 120_000);
afterAll(async () => { await database.close(); rmSync(credDir, { recursive: true, force: true }); });
beforeEach(async () => {
  await database.db.query(`UPDATE type::record('task', $id) SET fence = $fence;`, { id: deployId, fence: qaFence });
});

fork('grant + read: GM scope lets QA read an allowlisted task it cannot read directly', async () => {
  await expectRefused(core.getTask(tokens.qa, subjectId), 'forbidden', /Task access denied/);
  const scope = await core.qaObservationGrant(tokens.gm, {
    goalId, deploymentTaskId: deployId, qaEmployee: 'qa-obs-qa', leaseFence: qaFence,
    subjects: [deployId, subjectId], expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    reason: 'QA 独立验收取证', idempotencyKey: key(),
  });
  scopeId = scope.id;
  expect(scope.status).toBe('active');
  expect(scope.subjects).toContain(subjectId);
  const read = await core.qaObservationRead({ credential: tokens.qa }, { taskId: subjectId });
  expect(read.task?.id).toBe(subjectId);
  expect(read.contextOmitted).toBe(true);
  expect(read.contextBytes ?? 0).toBeGreaterThan(0);
  expect(read.contribution?.unknown.length).toBeGreaterThan(0);
  expect(read.dispatch?.available).toBe(true);
  expect(read.dispatch?.verdicts?.[0]?.reasons?.[0]?.code).toBe('author_recusal');
  expect(read.meta.scope.id).toBe(scope.id);
  expect(read.meta.dataSource).toBe('live');
  expect(read.meta.instanceAt.length).toBeGreaterThan(0);
  const goal = await core.qaObservationRead({ credential: tokens.qa }, { goalId });
  expect(goal.goal?.total).toBeGreaterThanOrEqual(2);
});

fork('scope negatives: wrong role/fence/goal/allowlist, revoke CAS, expiry and lease change fail closed', async () => {
  await expectRefused(core.qaObservationRead({ credential: tokens.qa2 }, { taskId: subjectId }), 'forbidden', /no active QA observation scope/);
  await expectRefused(core.qaObservationGrant(tokens.gm, {
    goalId, deploymentTaskId: deployId, qaEmployee: 'qa-obs-qa', leaseFence: qaFence + 1,
    subjects: [subjectId], expiresAt: new Date(Date.now() + 3_600_000).toISOString(), reason: '错误 fence', idempotencyKey: key(),
  }), 'invalid', /holder or fence/);
  const other = await core.createTask(tokens.gm, { goalId, title: '未列入 allowlist 的任务', context: '未列入。', executorRole: 'engineering', reviewerRole: 'product', kind: 'task', idempotencyKey: key() });
  await expectRefused(core.qaObservationRead({ credential: tokens.qa }, { scopeId, taskId: other.id }), 'forbidden', /outside the QA observation scope/);
  const revoked = await core.qaObservationRevoke(tokens.gm, { scopeId, expectedVersion: 1, reason: '验收完成后撤销该只读范围', idempotencyKey: key() });
  expect(revoked.status).toBe('revoked');
  await expectRefused(core.qaObservationRead({ credential: tokens.qa }, { scopeId, taskId: subjectId }), 'forbidden', /revoked/);
  await expectRefused(core.qaObservationRevoke(tokens.gm, { scopeId, expectedVersion: 1, reason: '使用过期版本撤销', idempotencyKey: key() }), 'conflict', /version changed/);
  const expiring = await core.qaObservationGrant(tokens.gm, {
    goalId, deploymentTaskId: deployId, qaEmployee: 'qa-obs-qa', leaseFence: qaFence, subjects: [subjectId],
    expiresAt: new Date(Date.now() + 120_000).toISOString(), reason: '过期测试 scope', idempotencyKey: key(),
  });
  await database.db.query(`UPDATE type::record('qa_observation_scope', $id) SET expires_at = $past;`, { id: expiring.id, past: new Date(Date.now() - 60_000).toISOString() });
  await expectRefused(core.qaObservationRead({ credential: tokens.qa }, { scopeId: expiring.id, taskId: subjectId }), 'forbidden', /expired/);
  const goal2 = await owner.createGoal({ text: '第二个目标', source: 'owner:test', key: key(), tier: 'quick' });
  const otherGoalTask = await core.createTask(tokens.gm, { goalId: goal2.id, title: '跨目标任务', context: '跨目标。', executorRole: 'engineering', reviewerRole: 'product', kind: 'task', idempotencyKey: key() });
  await expectRefused(core.qaObservationGrant(tokens.gm, {
    goalId, deploymentTaskId: deployId, qaEmployee: 'qa-obs-qa', leaseFence: qaFence, subjects: [otherGoalTask.id],
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(), reason: '跨目标的负例范围检查', idempotencyKey: key(),
  }), 'invalid', /not in the scope goal/);
  const leaseScope = await core.qaObservationGrant(tokens.gm, {
    goalId, deploymentTaskId: deployId, qaEmployee: 'qa-obs-qa', leaseFence: qaFence, subjects: [subjectId],
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(), reason: '租约变化负例范围', idempotencyKey: key(),
  });
  await database.db.query(`UPDATE type::record('task', $id) SET fence = fence + 1;`, { id: deployId });
  await expectRefused(core.qaObservationRead({ credential: tokens.qa }, { scopeId: leaseScope.id, taskId: subjectId }), 'forbidden', /lease changed/);
  await database.db.query(`UPDATE type::record('task', $id) SET fence = $fence;`, { id: deployId, fence: qaFence });
});

fork('session login, idempotency replay, timeline paging and text segments', async () => {
  const fixed = `fixed-${crypto.randomUUID()}`;
  const first = await core.qaObservationGrant(tokens.gm, {
    goalId, deploymentTaskId: deployId, qaEmployee: 'qa-obs-qa', leaseFence: qaFence, subjects: [subjectId],
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(), reason: '会话与分页测试范围', idempotencyKey: fixed,
  });
  const replay = await core.qaObservationGrant(tokens.gm, {
    goalId, deploymentTaskId: deployId, qaEmployee: 'qa-obs-qa', leaseFence: qaFence, subjects: [subjectId],
    expiresAt: first.expiresAt, reason: '会话与分页测试范围', idempotencyKey: fixed,
  });
  expect(replay.id).toBe(first.id);
  await expectRefused(core.qaObservationGrant(tokens.gm, {
    goalId, deploymentTaskId: deployId, qaEmployee: 'qa-obs-qa', leaseFence: qaFence, subjects: [subjectId],
    expiresAt: new Date(Date.now() + 7_200_000).toISOString(), reason: '同键但不同载荷负例', idempotencyKey: fixed,
  }), 'conflict', /different input/);
  const session = await core.qaObservationSession(tokens.qa, { scopeId: first.id });
  expect(session.code.length).toBeGreaterThan(20);
  const login = await core.qaObservationLogin(session.code);
  expect(login.token.length).toBeGreaterThan(20);
  await expectRefused(core.qaObservationLogin(session.code), 'forbidden', /already used/);
  const tokenRead = await core.qaObservationRead({ token: login.token }, { taskId: subjectId });
  expect(tokenRead.task?.id).toBe(subjectId);
  await expectRefused(core.qaObservationRead({ token: login.token }, { taskId: 'not-in-scope' }), 'forbidden', /outside the QA observation scope/);
  const page1 = await core.qaObservationTimeline({ credential: tokens.qa }, { scopeId: first.id, taskId: subjectId, pageSize: 1 });
  expect(page1.history.length).toBe(1);
  expect(page1.page.hasMore).toBe(true);
  expect(page1.page.nextCursor).toBeDefined();
  const page2 = await core.qaObservationTimeline({ credential: tokens.qa }, { scopeId: first.id, taskId: subjectId, pageSize: 1, cursor: page1.page.nextCursor });
  expect(page2.history.length).toBe(1);
  expect(page2.history[0]?.auditId).not.toBe(page1.history[0]?.auditId);
  const context1 = await core.qaObservationText({ credential: tokens.qa }, { scopeId: first.id, taskId: subjectId, field: 'context', offset: 0, limit: 64 });
  expect(context1.totalBytes).toBeGreaterThan(64);
  expect(context1.nextOffset).not.toBeNull();
  const context2 = await core.qaObservationText({ credential: tokens.qa }, { scopeId: first.id, taskId: subjectId, field: 'context', offset: context1.nextOffset!, limit: 64, expectSha256: context1.sha256 });
  expect(('主体任务上下文：' + '中文🙂'.repeat(3000)).startsWith(context1.text + context2.text)).toBe(true);
  await expectRefused(core.qaObservationText({ credential: tokens.qa }, { scopeId: first.id, taskId: subjectId, field: 'context', offset: context1.nextOffset!, limit: 64, expectSha256: 'f'.repeat(64) }), 'conflict', /changed/);
  const evidenceEntry = page1.history[0]!;
  expect(evidenceEntry.auditId).toBeDefined();
  const evidence = await core.qaObservationText({ credential: tokens.qa }, { scopeId: first.id, taskId: subjectId, field: 'evidence', auditId: evidenceEntry.auditId!, offset: 0, limit: 64 });
  expect(evidence.totalBytes).toBeGreaterThan(0);
});

fork('goal summary fails closed when dispatch observation/status is missing, partial or stale', async () => {
  const scope = await core.qaObservationGrant(tokens.gm, {
    goalId, deploymentTaskId: deployId, qaEmployee: 'qa-obs-qa', leaseFence: qaFence, subjects: [subjectId],
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(), reason: '目标完整性负例范围', idempotencyKey: key(),
  });
  const readGoal = () => core.qaObservationRead({ credential: tokens.qa }, { scopeId: scope.id, goalId });
  await database.db.query('DELETE company_meta:dispatch_observation; DELETE company_meta:dispatch_observation_status;');
  let read = await readGoal();
  expect(read.meta.completeness.dispatchComplete).toBe(false);
  expect(read.goal?.dispatchComplete).toBe(false);
  expect(read.goal?.undispatchable).toBeUndefined();
  const at = new Date().toISOString();
  await database.db.query('UPSERT company_meta:dispatch_observation CONTENT { at: $at, verdicts: $verdicts, complete: true, originalVerdicts: 1, originalReasons: 1 };',
    { at, verdicts: [{ taskId: subjectId, phase: 'execute', dispatchable: false, reasons: [] }] });
  read = await readGoal();
  expect(read.meta.completeness.dispatchComplete).toBe(false); // a complete observation with no trusted save status is unknown
  await database.db.query("UPSERT company_meta:dispatch_observation_status CONTENT { at: $at, ok: true, error: '' };", { at });
  read = await readGoal();
  expect(read.meta.completeness.dispatchComplete).toBe(true);
  expect(read.goal?.undispatchable).toBe(1);
  await database.db.query("UPDATE company_meta:dispatch_observation SET complete = false, verdicts = [], reason = 'partial';");
  read = await readGoal();
  expect(read.meta.completeness.dispatchComplete).toBe(false);
  expect(read.goal?.undispatchable).toBeUndefined();
  await database.db.query('UPDATE company_meta:dispatch_observation SET complete = true, verdicts = $verdicts;',
    { verdicts: [{ taskId: subjectId, phase: 'execute', dispatchable: false, reasons: [] }] });
  await database.db.query("UPSERT company_meta:dispatch_observation_status CONTENT { at: $at, ok: false, error: 'write failed' };", { at });
  read = await readGoal();
  expect(read.meta.completeness.dispatchComplete).toBe(false);
  expect(read.goal?.dispatchReason).toMatch(/stale/);
});
