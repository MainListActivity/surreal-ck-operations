// SYS02 acceptance gate on the isolated company fork. It exercises the unified evaluator through the real core, owner desk,
// Jev path, owner command path and the real CI probe runner; the source adapter is deterministic so no network is needed.
import { afterAll, beforeAll, beforeEach, expect, setDefaultTimeout, test } from 'bun:test';
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
import { runProbe } from '../scripts/acceptance-probe.ts';
import type { AcceptanceSourceAdapter, AcceptanceSourceInput, AcceptanceVerifyResult } from '../src/acceptance.ts';
import type { AcceptanceCriterion, AcceptanceEvidenceInput, ClaimResult, TaskView } from '../src/contracts.ts';

setDefaultTimeout(180_000);
const fork = process.env.RUN_SCK_WORKTREE_FORK_TESTS === '1' ? test : test.skip;
const NS = 'sck_acceptance_gate_test';
const database = new CompanyDatabase({ ...loadDatabaseConfig(), namespace: NS, database: 'control_plane' });
const credDir = mkdtempSync(join(tmpdir(), 'sck-acceptance-gate-'));
const workforce = new Workforce(database, credDir);
const owner = new OwnerDesk(database);
const enrollment = new LocalEnrollmentAdmin(database);
const tokens: Record<string, string> = {};
const key = () => crypto.randomUUID();

type FakeArtifactRecord = { probe?: string; runId?: string | number; jobId?: string; readAt?: string; inProgress?: boolean; observationHash?: string; result?: string; target?: string; kind?: string };

class FakeAcceptanceAdapter implements AcceptanceSourceAdapter {
  runs = new Map<string, { headSha: string; conclusion: string; createdAt: string; updatedAt: string; workflowName?: string }>();
  artifacts = new Map<string, { expired: boolean; head: string; runId?: string; record?: FakeArtifactRecord }>();
  /** When false the adapter returns no verified environment, like a CI source with no deployment record. */
  environmentVerified = true;
  setRun(id: string, headSha: string, over: Partial<{ conclusion: string; createdAt: string; updatedAt: string }> = {}) {
    this.runs.set(id, {
      headSha, conclusion: 'success',
      createdAt: new Date(Date.now() - 60_000).toISOString(), updatedAt: new Date(Date.now() + 60_000).toISOString(), ...over,
    });
  }
  async verify(input: AcceptanceSourceInput): Promise<AcceptanceVerifyResult> {
    const runId = /\/actions\/runs\/(\d+)\/?$/.exec(input.runUrl)?.[1];
    const run = runId ? this.runs.get(runId) : undefined;
    if (!run) return { ok: false, reason: 'run not found' };
    if (run.headSha !== input.sha) return { ok: false, reason: 'head mismatch' };
    if (run.conclusion !== 'success') return { ok: false, reason: 'run not successful' };
    let at = run.updatedAt;
    let verifiedProbe: Record<string, unknown> | undefined;
    if (input.probe) {
      // A probe is verified from its CI artifact record, not from the caller's window-shaped claim.
      if (!input.artifactId) return { ok: false, reason: 'probe artifact missing' };
      const artifact = this.artifacts.get(input.artifactId);
      if (!artifact) return { ok: false, reason: 'artifact not found' };
      if (artifact.expired) return { ok: false, reason: 'artifact expired' };
      if (artifact.head !== input.sha) return { ok: false, reason: 'artifact head mismatch' };
      if (artifact.runId !== undefined && artifact.runId !== runId) return { ok: false, reason: 'artifact run mismatch' };
      const record = artifact.record;
      if (!record) return { ok: false, reason: 'artifact record missing' };
      if (record.probe !== 'acceptance' || String(record.runId) !== runId || record.inProgress !== true || record.result !== 'ok') {
        return { ok: false, reason: 'artifact record not from this run' };
      }
      if (typeof record.observationHash !== 'string' || !/^[0-9a-f]{64}$/.test(record.observationHash)) {
        return { ok: false, reason: 'artifact record hash invalid' };
      }
      const read = Date.parse(String(record.readAt));
      if (!(Date.parse(run.createdAt) <= read && read <= Date.parse(run.updatedAt))) return { ok: false, reason: 'artifact record outside the run window' };
      if (input.probe.runId !== String(record.runId) || input.probe.inProgress !== record.inProgress ||
          input.probe.observationHash !== record.observationHash || Date.parse(input.probe.readAt) !== read) {
        return { ok: false, reason: 'probe record does not match the artifact' };
      }
      at = String(record.readAt);
      verifiedProbe = record;
    } else if (input.artifactId) {
      const artifact = this.artifacts.get(input.artifactId);
      if (!artifact) return { ok: false, reason: 'artifact not found' };
      if (artifact.expired) return { ok: false, reason: 'artifact expired' };
      if (artifact.head !== input.sha) return { ok: false, reason: 'artifact head mismatch' };
    }
    const environment = this.environmentVerified ? input.environment : undefined;
    return {
      ok: true, sha: input.sha, at,
      ...(environment !== undefined ? { environment } : {}),
      source: { provider: 'github-actions', runUrl: input.runUrl, runId,
        ...(environment !== undefined ? { environment } : {}),
        ...(verifiedProbe ? { probe: verifiedProbe } : {}), ...(input.artifactId ? { artifactId: input.artifactId } : {}) },
    };
  }
}

const fake = new FakeAcceptanceAdapter();
const core = new SurrealCompanyCore(database, { acceptance: { adapter: fake } });

const machine = (over: Partial<AcceptanceCriterion> = {}): AcceptanceCriterion =>
  ({ id: 'AC-1', kind: 'machine', required: true, layer: 'ci', evidence: 'ci-run', verify: 'ci', risk: 'code', ...over });
const human = (over: Partial<AcceptanceCriterion> = {}): AcceptanceCriterion =>
  ({ id: 'AC-2', kind: 'human', required: true, layer: 'manual', evidence: 'review-signoff', verify: 'independent-review', risk: 'code', ...over });
const proofOf = (c: ClaimResult | { task: TaskView; deliveryId: string; fence: number }, version = c.task.version) =>
  ({ taskId: c.task.id, deliveryId: c.deliveryId, fence: c.fence, expectedVersion: version });
const goalFor = () => owner.createGoal({ text: 'SYS02 验收门测试目标', source: 'owner:test', key: key(), tier: 'quick' });
const recordEvidence = (token: string, taskId: string, acId: string, sha: string, runId: string, source: Partial<AcceptanceEvidenceInput['source']> = {}) =>
  core.recordAcceptanceEvidence(token, {
    taskId, acId, sha, source: { provider: 'github-actions', runUrl: `https://github.com/o/r/actions/runs/${runId}`, ...source },
    idempotencyKey: key(),
  });
const ensureGate = async (enabled = true) => {
  const current = await core.acceptanceGate(tokens.gm);
  if (current.enabled !== enabled) {
    await core.setAcceptanceGate(tokens.gm, { enabled, reason: 'SYS02 测试调整门禁范围', expectedVersion: current.version, idempotencyKey: key() });
  }
  return core.acceptanceGate(tokens.gm);
};

beforeAll(async () => {
  await database.connect();
  await database.db.query(`DEFINE NAMESPACE IF NOT EXISTS ${NS};`);
  await database.db.use({ namespace: NS });
  await database.db.query('REMOVE DATABASE IF EXISTS control_plane;');
  await database.bootstrap();
  for (const [name, role, caps] of [
    ['gm', 'gm', ['execute', 'review', 'manage']], ['product', 'product', ['execute', 'review', 'manage']],
    ['eng-a', 'engineering', ['execute', 'review']], ['eng-b', 'engineering', ['execute', 'review']],
    ['qa', 'qa', ['execute', 'review']],
  ] as const) tokens[name] = await enrollment.enroll(`t-${name}`, role, caps);
}, 30_000);
afterAll(async () => { await database.close(); rmSync(credDir, { recursive: true, force: true }); });
// The tests share one fork; clear the employee-side lease marker so a refused claim in one test cannot mask another.
beforeEach(async () => { await database.db.query('UPDATE employee SET active_task = NONE;'); });

fork('SYS02 AC01/AC06: criteria are versioned and required for new code deliveries; pre-gate rows are legacy', async () => {
  const goal = await goalFor();
  const before = await core.acceptanceGate(tokens.gm);
  expect(before.enabled).toBe(false);
  await expect(core.setAcceptanceGate(tokens.product, { enabled: true, reason: '非 gm', expectedVersion: before.version, idempotencyKey: key() }))
    .rejects.toMatchObject({ code: 'forbidden' });
  // A code task created while the gate is off is a legacy row after the gate is enabled.
  const legacy = await core.createTask(tokens.gm, { title: '旧代码任务', context: '门禁启用前创建', executorRole: 'engineering',
    reviewerRole: 'engineering', workIntent: { kind: 'code' }, idempotencyKey: key() });
  expect(legacy.acceptanceCriteria).toBeUndefined();
  const enabled = await core.setAcceptanceGate(tokens.gm, { enabled: true, reason: 'SYS02 测试启用 code-deliveries', expectedVersion: before.version, idempotencyKey: key() });
  expect(enabled).toMatchObject({ enabled: true, version: before.version + 1 });
  await expect(core.setAcceptanceGate(tokens.gm, { enabled: false, reason: 'stale', expectedVersion: before.version, idempotencyKey: key() }))
    .rejects.toMatchObject({ code: 'conflict' });
  // C1: a new code task without caller criteria gets the server baseline; it is not silently exempt.
  const baselineTask = await core.createTask(tokens.gm, { title: '缺 criteria', context: '启用后创建的新代码任务', executorRole: 'engineering',
    reviewerRole: 'engineering', workIntent: { kind: 'code' }, idempotencyKey: key() });
  expect(baselineTask.acceptanceCriteria?.map(c => c.id)).toEqual(['AC-BASE-IMPL-1', 'AC-BASE-IMPL-2']);
  await expect(core.createDelivery(tokens.gm, { goalId: goal.id, title: '重复 id', spec: '重复 AC 必须被拒绝，不能静默去重。',
    acceptanceCriteria: [machine({ id: 'AC-1' }), machine({ id: 'AC-1' })], idempotencyKey: key() }))
    .rejects.toMatchObject({ code: 'invalid' });
  const [impl, release, deploy] = await core.createDelivery(tokens.gm, { goalId: goal.id, title: 'SYS02 链', spec: '三腿共享版本化 criteria，按 legs 分配。',
    acceptanceCriteria: [machine({ id: 'AC-1' }), human({ id: 'AC-2', legs: ['implement'] })], idempotencyKey: key() });
  expect(impl.acceptanceCriteria?.map(c => c.id)).toEqual(['AC-1', 'AC-2']);
  expect(release.acceptanceCriteria?.map(c => c.id)).toEqual(['AC-1', 'AC-BASE-RELEASE-2']);
  expect(deploy.acceptanceCriteria?.map(c => c.id)).toEqual(['AC-1', 'AC-BASE-DEPLOY-1', 'AC-BASE-DEPLOY-2']);
  expect(impl.acceptanceChain).toBe(release.acceptanceChain);
  // The legacy row keeps the old path: submit and accept without criteria after the gate is enabled.
  const claim = await core.claim(tokens['eng-a'], legacy.id);
  await core.submit(tokens['eng-a'], proofOf(claim), { text: '旧任务在门禁启用后提交：legacy 保留旧路径。', idempotencyKey: key() });
  const review = await core.claim(tokens['eng-b'], legacy.id);
  await core.accept(tokens['eng-b'], proofOf(review), { text: '独立复核旧任务，legacy 不伪造满足。', idempotencyKey: key() });
  expect((await core.getTask(tokens.gm, legacy.id)).state).toBe('done');
});

fork('SYS02 R1: pre-gate delivery legs stay legacy after enabling; post-gate deliveries still need evidence', async () => {
  await ensureGate(false);
  const goal = await goalFor();
  const [impl, release, deploy] = await core.createDelivery(tokens.gm, { goalId: goal.id, title: 'R1 legacy 链', spec: '门禁关闭期间创建的交付三腿在启用后保留旧路径。', idempotencyKey: key() });
  expect(impl.acceptanceLegacy).toBe(true);
  expect(release.acceptanceLegacy).toBe(true);
  expect(deploy.acceptanceLegacy).toBe(true);
  expect(impl.acceptanceCriteria?.length ?? 0).toBeGreaterThan(0);
  await ensureGate(true);
  const runLeg = async (task: TaskView, submitter: string, reviewer: string) => {
    const claim = await core.claim(submitter, task.id);
    await core.submit(submitter, proofOf(claim), { text: 'R1 legacy：启用前创建的交付腿在启用后提交，保留旧路径。', idempotencyKey: key() });
    const review = await core.claim(reviewer, task.id);
    await core.accept(reviewer, proofOf(review), { text: 'R1 legacy：独立复核放行，legacy 不伪造 SYS02 机器满足。', idempotencyKey: key() });
    expect((await core.getTask(tokens.gm, task.id)).state).toBe('done');
  };
  await runLeg(impl, tokens['eng-a'], tokens['eng-b']);
  await runLeg(release, tokens['eng-a'], tokens.product);
  await runLeg(deploy, tokens['eng-a'], tokens.qa);
  // A delivery created after enabling still needs machine evidence and is refused without it.
  const [post] = await core.createDelivery(tokens.gm, { goalId: goal.id, title: 'R1 post-gate', spec: '启用后创建的新交付仍必须补机器证据才能提交。', idempotencyKey: key() });
  const postClaim = await core.claim(tokens['eng-a'], post.id);
  await expect(core.submit(tokens['eng-a'], proofOf(postClaim), { text: '启用后新交付没有机器证据，提交必须被拒绝。', idempotencyKey: key(), acceptance: { sha: 'post-head' } }))
    .rejects.toMatchObject({ code: 'invalid' });
});

fork('SYS02 N1: the declared environment binds submit, accept and adapter-verified evidence', async () => {
  await ensureGate();
  const task = await core.createTask(tokens.gm, { title: 'N1 环境绑定', context: '受控任务声明 production，未知环境不得通配。',
    executorRole: 'engineering', reviewerRole: 'engineering', workIntent: { kind: 'code' },
    acceptanceEnvironment: 'production', idempotencyKey: key() });
  expect(task.acceptanceEnvironment).toBe('production');
  expect(task.acceptanceCriteria?.map(c => c.id)).toEqual(['AC-BASE-IMPL-1', 'AC-BASE-IMPL-2']);
  const claim = await core.claim(tokens['eng-a'], task.id);
  fake.setRun('9101', 'n1-head');
  // An adapter with no verified environment cannot satisfy the declared production.
  fake.environmentVerified = false;
  await expect(recordEvidence(tokens['eng-a'], task.id, 'AC-BASE-IMPL-1', 'n1-head', '9101')).rejects.toMatchObject({ code: 'invalid' });
  fake.environmentVerified = true;
  const evidence = await recordEvidence(tokens['eng-a'], task.id, 'AC-BASE-IMPL-1', 'n1-head', '9101');
  expect(evidence).toMatchObject({ environment: 'production', attempt: 1 });
  // Missing or wrong submit environments are refused; the declared one is accepted.
  await expect(core.submit(tokens['eng-a'], proofOf(claim), { text: '缺少环境声明的提交必须被拒绝，不能默认通关生产。', idempotencyKey: key(), acceptance: { sha: 'n1-head' } }))
    .rejects.toMatchObject({ code: 'invalid' });
  await expect(core.submit(tokens['eng-a'], proofOf(claim), { text: '错误环境的提交必须被拒绝，环境不能由执行者改标签。', idempotencyKey: key(), acceptance: { sha: 'n1-head', environment: 'staging' } }))
    .rejects.toMatchObject({ code: 'invalid' });
  expect((await core.submit(tokens['eng-a'], proofOf(claim), { text: '正确环境与机器证据齐备，提交独立复核，确认门禁接受该声明的 production 环境。', idempotencyKey: key(), acceptance: { sha: 'n1-head', environment: 'production' } })).state).toBe('review');
  // Accept strictness: a row whose environment was changed no longer matches the persisted target.
  const review = await core.claim(tokens['eng-b'], task.id);
  await database.db.query("UPDATE acceptance_evidence SET environment = 'staging' WHERE task = $task AND ac_id = 'AC-BASE-IMPL-1';", { task: new RecordId('task', task.id) });
  await expect(core.accept(tokens['eng-b'], proofOf(review), { text: '环境不匹配的证据不得通过独立复核，机器证据的环境必须与持久化的目标一致。', idempotencyKey: key() })).rejects.toMatchObject({ code: 'invalid' });
});

fork('SYS02 N1: an executor cannot introduce an environment on a generic task', async () => {
  await ensureGate();
  const goal = await goalFor();
  const [impl] = await core.createDelivery(tokens.gm, { goalId: goal.id, title: 'N1 通用 CI', spec: '通用 CI 任务不得由提交方自行声明 production。', idempotencyKey: key() });
  expect(impl.acceptanceEnvironment).toBeUndefined();
  const claim = await core.claim(tokens['eng-a'], impl.id);
  fake.setRun('9103', 'n1-generic-head');
  await recordEvidence(tokens['eng-a'], impl.id, 'AC-BASE-IMPL-1', 'n1-generic-head', '9103');
  await expect(core.submit(tokens['eng-a'], proofOf(claim), { text: '通用任务上由执行者声明 production 必须被拒绝。', idempotencyKey: key(), acceptance: { sha: 'n1-generic-head', environment: 'production' } }))
    .rejects.toMatchObject({ code: 'invalid' });
});

fork('SYS02 N2: a returned attempt cannot reuse old machine evidence; re-recording binds the new attempt', async () => {
  await ensureGate();
  const goal = await goalFor();
  const [impl] = await core.createDelivery(tokens.gm, { goalId: goal.id, title: 'N2 attempt 链', spec: '退回后的新 attempt 不得静默复用旧机器证据。', idempotencyKey: key() });
  const first = await core.claim(tokens['eng-a'], impl.id);
  fake.setRun('9102', 'n2-head');
  const recorded = await recordEvidence(tokens['eng-a'], impl.id, 'AC-BASE-IMPL-1', 'n2-head', '9102');
  expect(recorded).toMatchObject({ attempt: 1 });
  expect(recorded.environment).toBeUndefined();
  await core.submit(tokens['eng-a'], proofOf(first), { text: '第一次提交已有可信机器证据，进入独立复核。', idempotencyKey: key(), acceptance: { sha: 'n2-head' } });
  const reviewer = await core.claim(tokens['eng-b'], impl.id);
  await core.returnTask(tokens['eng-b'], proofOf(reviewer), { text: '退回首次交付，要求新 attempt 重新验证机器证据。', idempotencyKey: key() });
  const second = await core.claim(tokens['eng-a'], impl.id);
  await expect(core.submit(tokens['eng-a'], proofOf(second), { text: '第二 attempt 未补机器证据，旧 attempt 的记录不得静默复用。', idempotencyKey: key(), acceptance: { sha: 'n2-head' } }))
    .rejects.toMatchObject({ code: 'invalid' });
  const renewed = await recordEvidence(tokens['eng-a'], impl.id, 'AC-BASE-IMPL-1', 'n2-head', '9102');
  expect(renewed).toMatchObject({ attempt: 2 });
  expect((await core.submit(tokens['eng-a'], proofOf(second), { text: '为本 attempt 补录可信机器证据后重新提交独立复核。', idempotencyKey: key(), acceptance: { sha: 'n2-head' } })).state).toBe('review');
  const review = await core.claim(tokens['eng-b'], impl.id);
  expect((await core.accept(tokens['eng-b'], proofOf(review), { text: '本次 attempt 的机器与人工证据齐备，独立复核通过。', idempotencyKey: key() })).state).toBe('done');
});

fork('SYS02 N2: a checkpoint between evidence and submit does not invalidate the attempt', async () => {
  await ensureGate();
  const goal = await goalFor();
  const [impl] = await core.createDelivery(tokens.gm, { goalId: goal.id, title: 'N2 checkpoint', spec: 'heartbeat/checkpoint 的版本变化不等于重新提交。', idempotencyKey: key() });
  const claim = await core.claim(tokens['eng-a'], impl.id);
  fake.setRun('9104', 'n2-checkpoint-head');
  await recordEvidence(tokens['eng-a'], impl.id, 'AC-BASE-IMPL-1', 'n2-checkpoint-head', '9104');
  const checkpoint = await core.checkpoint(tokens['eng-a'], proofOf(claim), { text: '检查点：任务版本前进，但这不是一次新的提交 attempt。', idempotencyKey: key() });
  expect(checkpoint.version).toBeGreaterThan(claim.task.version);
  const proof = { taskId: claim.task.id, deliveryId: claim.deliveryId, fence: claim.fence, expectedVersion: checkpoint.version };
  expect((await core.submit(tokens['eng-a'], proof, { text: '检查点后的提交仍使用同一 attempt，机器证据不应失效。', idempotencyKey: key(), acceptance: { sha: 'n2-checkpoint-head' } })).state).toBe('review');
});

fork('SYS02 C1: custom optional or human-only criteria cannot remove the server baseline; zero evidence cannot reach review', async () => {
  await ensureGate();
  const goal = await goalFor();
  const [impl] = await core.createDelivery(tokens.gm, { goalId: goal.id, title: 'C1 基线', spec: '自定义可选机器 AC 不得移除必需基线；零证据不得进入 review。',
    acceptanceCriteria: [{ id: 'AC-OPTIONAL', kind: 'machine', required: false, layer: 'ci', evidence: 'ci-run', verify: 'ci' }], idempotencyKey: key() });
  expect(impl.acceptanceCriteria?.map(c => c.id)).toEqual(['AC-OPTIONAL', 'AC-BASE-IMPL-1', 'AC-BASE-IMPL-2']);
  const claim = await core.claim(tokens['eng-a'], impl.id);
  await expect(core.submit(tokens['eng-a'], proofOf(claim), { text: '零可信机器证据的提交必须被服务端基线拒绝，不能进入复核。', idempotencyKey: key(), acceptance: { sha: 'optional-head' } }))
    .rejects.toMatchObject({ code: 'invalid' });
  expect((await core.getTask(tokens.gm, impl.id)).state).toBe('doing');
  await expect(core.createDelivery(tokens.gm, { goalId: goal.id, title: 'C1 降级', spec: '同 ID 的 required:false 不得覆盖服务端基线。',
    acceptanceCriteria: [{ id: 'AC-BASE-IMPL-1', kind: 'machine', required: false, layer: 'ci', evidence: 'ci-run', verify: 'ci' }], idempotencyKey: key() }))
    .rejects.toMatchObject({ code: 'invalid' });
  const [humanOnly] = await core.createDelivery(tokens.gm, { goalId: goal.id, title: 'C1 仅人工', spec: '仅人工 AC 的集合仍必须补上必需机器 AC。',
    acceptanceCriteria: [human({ id: 'AC-H' })], idempotencyKey: key() });
  expect(humanOnly.acceptanceCriteria?.map(c => c.id)).toContain('AC-BASE-IMPL-1');
  const [emptyCriteria] = await core.createDelivery(tokens.gm, { goalId: goal.id, title: 'C1 空 criteria', spec: '无自定义 criteria 的新代码交付必须得到服务端基线，不能是空集。', idempotencyKey: key() });
  expect(emptyCriteria.acceptanceCriteria?.map(c => c.id)).toEqual(['AC-BASE-IMPL-1', 'AC-BASE-IMPL-2']);
  fake.setRun('12', 'optional-head');
  await recordEvidence(tokens['eng-a'], impl.id, 'AC-BASE-IMPL-1', 'optional-head', '12');
  await core.submit(tokens['eng-a'], proofOf(claim), { text: '补上可信 CI 证据后重新提交，等待独立复核签署人工基线。', idempotencyKey: key(), acceptance: { sha: 'optional-head' } });
  const review = await core.claim(tokens['eng-b'], impl.id);
  expect((await core.accept(tokens['eng-b'], proofOf(review), { text: '独立复核签署人工基线，确认机器证据绑定当前 head。', idempotencyKey: key() })).state).toBe('done');
});

fork('SYS02 AC02/AC03: evidence is server-verified and head-bound; submit and independent accept call the same evaluator', async () => {
  await ensureGate();
  const goal = await goalFor();
  const [impl] = await core.createDelivery(tokens.gm, { goalId: goal.id, title: '证据链', spec: '机器证据必须来自可信 run，人工 AC 由独立复核签署。',
    acceptanceCriteria: [machine(), human()], idempotencyKey: key() });
  const claim = await core.claim(tokens['eng-a'], impl.id);
  // A caller that does not hold the task lease and is not gm cannot write evidence.
  await expect(recordEvidence(tokens['eng-b'], impl.id, 'AC-1', 'head-1', '1')).rejects.toMatchObject({ code: 'forbidden' });
  fake.setRun('1', 'head-1');
  // No evidence yet: submit is refused with the unmet machine AC.
  await expect(core.submit(tokens['eng-a'], proofOf(claim), { text: '实现完成，但尚未记录可信证据，提交应被门禁拒绝。', idempotencyKey: key(), acceptance: { sha: 'head-1' } }))
    .rejects.toMatchObject({ code: 'invalid' });
  // The adapter refuses a run whose head is not the submitted SHA.
  await expect(recordEvidence(tokens['eng-a'], impl.id, 'AC-1', 'old-head', '1')).rejects.toMatchObject({ code: 'invalid' });
  const evidence = await recordEvidence(tokens['eng-a'], impl.id, 'AC-1', 'head-1', '1');
  expect(evidence).toMatchObject({ verified: true, verifier: 'github-actions', sha: 'head-1', evidenceType: 'ci-run' });
  // Old-head submission is refused even though a run exists.
  await expect(core.submit(tokens['eng-a'], proofOf(claim), { text: '旧 head 不能复用证据，提交必须被门禁拒绝。', idempotencyKey: key(), acceptance: { sha: 'head-2' } }))
    .rejects.toMatchObject({ code: 'invalid' });
  const submitted = await core.submit(tokens['eng-a'], proofOf(claim), { text: '实现完成，机器证据已核验，提交独立复核。', idempotencyKey: key(), acceptance: { sha: 'head-1' } });
  expect(submitted).toMatchObject({ state: 'review', acceptanceHead: 'head-1', acceptanceAttempt: 1 });
  // A synthetic self-accept is refused by the evaluator before any lease check.
  const review = await core.claim(tokens['eng-b'], impl.id);
  await expect(core.accept(tokens['eng-a'], proofOf(review), { text: '同人自验必须被拒绝，独立复核人才能签署人工 AC。', idempotencyKey: key() }))
    .rejects.toMatchObject({ code: 'invalid' });
  const accepted = await core.accept(tokens['eng-b'], proofOf(review), { text: '独立复核通过：机器与人工 AC 均满足。', idempotencyKey: key() });
  expect(accepted.state).toBe('done');
  const [rows] = await database.db.query<[Array<{ ac_id: string; kind: string; verifier: string; actor: string; task_version: number }>]>(
    'SELECT ac_id, kind, verifier, actor, task_version FROM acceptance_evidence WHERE task = $task ORDER BY ac_id;', { task: new RecordId('task', impl.id) });
  expect(rows.map(r => [r.ac_id, r.kind, r.verifier])).toEqual([['AC-1', 'machine', 'github-actions'], ['AC-2', 'human', 'reviewer']]);
  expect(rows.find(r => r.ac_id === 'AC-2')).toMatchObject({ actor: 't-eng-b', task_version: accepted.version });
  const status = await core.acceptanceStatus(tokens.gm, { taskId: impl.id });
  expect(status.verdict).toMatchObject({ ok: true, legacy: false });
});

fork('SYS02 AC05: report.md auto-submit and a missing head cannot bypass the submit gate', async () => {
  await ensureGate();
  const goal = await goalFor();
  const [impl] = await core.createDelivery(tokens.gm, { goalId: goal.id, title: 'report.md 链路', spec: 'report.md 只是 evidence.text，不能替代结构化证据。',
    acceptanceCriteria: [machine()], idempotencyKey: key() });
  const claim = await core.claim(tokens['eng-a'], impl.id);
  await expect(core.submit(tokens['eng-a'], proofOf(claim), { text: 'report.md 自动提交时只有文本，没有 acceptance.head 与可信 run。', idempotencyKey: key() }))
    .rejects.toMatchObject({ code: 'invalid' });
  expect((await core.getTask(tokens.gm, impl.id)).state).toBe('doing');
  // Release the kept lease: a refused submit must not leave the employee leased and cascade into later tests.
  await core.release(tokens['eng-a'], proofOf(claim), { text: '测试清理：被拒后释放租约，后续用例从干净状态开始。', idempotencyKey: key() });
});

fork('SYS02 AC03/AC05: the release baseline requires a human sign-off, so Jev cannot auto-approve a machine-only release', async () => {
  await ensureGate();
  // A standalone release task is ready. A create_delivery release leg waits for its implementation leg, which is not this test.
  const release = await core.createTask(tokens.gm, { title: 'Jev 机器链', context: 'release 只有机器 AC 时 Jev 可自动批准。',
    kind: 'release', executorRole: 'engineering', reviewerRole: 'product', acceptanceCriteria: [machine({ id: 'AC-1' })], idempotencyKey: key() });
  const claim = await core.claim(tokens['eng-a'], release.id);
  fake.setRun('2', 'rel-head');
  await recordEvidence(tokens['eng-a'], release.id, 'AC-1', 'rel-head', '2');
  await core.submit(tokens['eng-a'], proofOf(claim), { text: '上线申请：本 release 只有机器 AC，CI 已通过，无人工签署要求。', idempotencyKey: key(), acceptance: { sha: 'rel-head' } });
  const before = await core.getTask(tokens.gm, release.id);
  // The server release baseline adds AC-BASE-RELEASE-2 (human independent sign-off): Jev is a machine actor and is blocked.
  expect(await workforce.jevAccept(release.id, before.version, 'Jev 测试：release 基线含人工签署。')).toBe(false);
  expect((await core.getTask(tokens.gm, release.id)).state).toBe('review');
  expect((await core.history(tokens.gm, release.id)).some(h => h.action === 'jev_acceptance_blocked')).toBe(true);
  const humanRelease = await core.createTask(tokens.gm, { title: 'Jev 人工链', context: 'release 带人工 AC，Jev 必须交运营。',
    kind: 'release', executorRole: 'engineering', reviewerRole: 'product',
    acceptanceCriteria: [machine({ id: 'AC-1' }), human({ id: 'AC-9' })], idempotencyKey: key() });
  const claim2 = await core.claim(tokens['eng-a'], humanRelease.id);
  fake.setRun('3', 'rel2-head');
  await recordEvidence(tokens['eng-a'], humanRelease.id, 'AC-1', 'rel2-head', '3');
  await core.submit(tokens['eng-a'], proofOf(claim2), { text: '上线申请：本 release 含人工验收 AC，必须由运营签署，Jev 不得自动批准。', idempotencyKey: key(), acceptance: { sha: 'rel2-head' } });
  const before2 = await core.getTask(tokens.gm, humanRelease.id);
  expect(await workforce.jevAccept(humanRelease.id, before2.version, 'Jev 测试：存在人工 AC。')).toBe(false);
  expect((await core.getTask(tokens.gm, humanRelease.id)).state).toBe('review');
  expect((await core.history(tokens.gm, humanRelease.id)).some(h => h.action === 'jev_acceptance_blocked')).toBe(true);
});

fork('SYS02 AC03/AC06: the owner gate refuses an out-of-band review without machine evidence, then the owner signs', async () => {
  await ensureGate();
  const gateTask = await core.createTask(tokens.gm, { title: 'SYS02 老板关口', context: '老板关心口不能靠一行 review 绕过。', kind: 'gate',
    executorRole: 'gm', reviewerRole: 'owner', acceptanceCriteria: [machine()], idempotencyKey: key() });
  await database.db.query("UPDATE $task SET state = 'review', submitted_by = $who, acceptance_head = 'gate-head';",
    { task: new RecordId('task', gateTask.id), who: 't-gm' });
  await expect(owner.decide({ taskId: gateTask.id, decision: 'approve', note: '通过', source: 'owner:test', key: key() }))
    .rejects.toMatchObject({ code: 'invalid' });
  fake.setRun('4', 'gate-head');
  await recordEvidence(tokens.gm, gateTask.id, 'AC-1', 'gate-head', '4');
  expect((await owner.decide({ taskId: gateTask.id, decision: 'approve', note: '通过', source: 'owner:test', key: key() })).state).toBe('done');
  // The owner CLI path writes an owner_command; applyPending calls the same decide gate.
  const second = await core.createTask(tokens.gm, { title: 'SYS02 老板关口 2', context: 'owner CLI 同源。', kind: 'gate',
    executorRole: 'gm', reviewerRole: 'owner', acceptanceCriteria: [human({ id: 'AC-1' })], idempotencyKey: key() });
  await database.db.query("UPDATE $task SET state = 'review', submitted_by = $who;", { task: new RecordId('task', second.id), who: 't-gm' });
  await database.db.query("CREATE owner_command CONTENT { kind: 'approve', task: $task, text: '通过', source: 'cli', status: 'pending' };", { task: second.id });
  const applied = await owner.applyPending();
  expect(applied.some(row => row.status === 'applied')).toBe(true);
  expect((await core.getTask(tokens.gm, second.id)).state).toBe('done');
});

fork('SYS02 AC04: a real in-progress probe satisfies a runtime AC; a post-job or mock record does not', async () => {
  await ensureGate();
  const goal = await goalFor();
  const [impl] = await core.createDelivery(tokens.gm, { goalId: goal.id, title: '运行中探针', spec: '运行中可读必须由真实 CI 探针在作业进行中取回。',
    acceptanceCriteria: [{ id: 'AC-1', kind: 'machine', required: true, layer: 'runtime', evidence: 'probe', verify: 'probe:running-channel' }],
    idempotencyKey: key() });
  const claim = await core.claim(tokens['eng-a'], impl.id);
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('channel-ok') });
  try {
    fake.setRun('5', 'probe-head');
    await recordEvidence(tokens['eng-a'], impl.id, 'AC-BASE-IMPL-1', 'probe-head', '5');
    const record = await runProbe({ kind: 'url', target: `http://127.0.0.1:${server.port}/` }, { GITHUB_RUN_ID: '5', GITHUB_JOB: 'probe' });
    expect(record).toMatchObject({ runId: '5', inProgress: true });
    fake.artifacts.set('probe-artifact', { expired: false, head: 'probe-head', runId: '5', record });
    const evidence = await core.recordAcceptanceEvidence(tokens['eng-a'], {
      taskId: impl.id, acId: 'AC-1', sha: 'probe-head',
      source: { provider: 'github-actions', runUrl: 'https://github.com/o/r/actions/runs/5', artifactId: 'probe-artifact', probe: record }, idempotencyKey: key(),
    });
    expect(evidence).toMatchObject({ verified: true, evidenceType: 'probe' });
    // A caller cannot forge a window-shaped record without the CI artifact that carries it.
    const forged = { ...record, observationHash: 'd'.repeat(64) };
    await expect(core.recordAcceptanceEvidence(tokens['eng-a'], {
      taskId: impl.id, acId: 'AC-1', sha: 'probe-head',
      source: { provider: 'github-actions', runUrl: 'https://github.com/o/r/actions/runs/5', probe: forged }, idempotencyKey: key(),
    })).rejects.toMatchObject({ code: 'invalid' });
    // The artifact record must agree with the caller record.
    fake.artifacts.set('probe-mismatch', { expired: false, head: 'probe-head', runId: '5', record: { ...record, observationHash: 'e'.repeat(64) } });
    await expect(core.recordAcceptanceEvidence(tokens['eng-a'], {
      taskId: impl.id, acId: 'AC-1', sha: 'probe-head',
      source: { provider: 'github-actions', runUrl: 'https://github.com/o/r/actions/runs/5', artifactId: 'probe-mismatch', probe: record }, idempotencyKey: key(),
    })).rejects.toMatchObject({ code: 'invalid' });
    // The artifact must belong to the same run.
    fake.artifacts.set('probe-other-run', { expired: false, head: 'probe-head', runId: '6', record });
    await expect(core.recordAcceptanceEvidence(tokens['eng-a'], {
      taskId: impl.id, acId: 'AC-1', sha: 'probe-head',
      source: { provider: 'github-actions', runUrl: 'https://github.com/o/r/actions/runs/5', artifactId: 'probe-other-run', probe: record }, idempotencyKey: key(),
    })).rejects.toMatchObject({ code: 'invalid' });
    const late = { ...record, readAt: new Date(Date.now() + 120_000).toISOString() };
    await expect(core.recordAcceptanceEvidence(tokens['eng-a'], {
      taskId: impl.id, acId: 'AC-1', sha: 'probe-head',
      source: { provider: 'github-actions', runUrl: 'https://github.com/o/r/actions/runs/5', artifactId: 'probe-artifact', probe: late }, idempotencyKey: key(),
    })).rejects.toMatchObject({ code: 'invalid' });
    const mock = { ...record, runId: '999' };
    await expect(core.recordAcceptanceEvidence(tokens['eng-a'], {
      taskId: impl.id, acId: 'AC-1', sha: 'probe-head',
      source: { provider: 'github-actions', runUrl: 'https://github.com/o/r/actions/runs/999', artifactId: 'probe-artifact', probe: mock }, idempotencyKey: key(),
    })).rejects.toMatchObject({ code: 'invalid' });
    const tampered = { ...record, observationHash: 'not-a-sha256' };
    await expect(core.recordAcceptanceEvidence(tokens['eng-a'], {
      taskId: impl.id, acId: 'AC-1', sha: 'probe-head',
      source: { provider: 'github-actions', runUrl: 'https://github.com/o/r/actions/runs/5', artifactId: 'probe-artifact', probe: tampered }, idempotencyKey: key(),
    })).rejects.toMatchObject({ code: 'invalid' });
    expect((await core.submit(tokens['eng-a'], proofOf(claim), { text: '运行中通道探针已由真实 CI 作业取回并绑定提交 head，提交独立复核。', idempotencyKey: key(), acceptance: { sha: 'probe-head' } })).state).toBe('review');
  } finally { server.stop(true); }
});

fork('SYS02 AC05: an expired artifact is refused; a live artifact of the same head is accepted', async () => {
  await ensureGate();
  const goal = await goalFor();
  const [impl] = await core.createDelivery(tokens.gm, { goalId: goal.id, title: 'artifact 证据', spec: 'artifact 必须未过期且属于同一 head。',
    acceptanceCriteria: [{ id: 'AC-1', kind: 'machine', required: true, layer: 'ci', evidence: 'artifact', verify: 'artifact', risk: 'packaging' }],
    idempotencyKey: key() });
  const claim = await core.claim(tokens['eng-a'], impl.id);
  fake.setRun('7', 'artifact-head');
  await recordEvidence(tokens['eng-a'], impl.id, 'AC-BASE-IMPL-1', 'artifact-head', '7');
  fake.artifacts.set('a1', { expired: true, head: 'artifact-head' });
  await expect(core.recordAcceptanceEvidence(tokens['eng-a'], {
    taskId: impl.id, acId: 'AC-1', sha: 'artifact-head',
    source: { provider: 'github-actions', runUrl: 'https://github.com/o/r/actions/runs/7', artifactId: 'a1' }, idempotencyKey: key(),
  })).rejects.toMatchObject({ code: 'invalid' });
  fake.artifacts.set('a1', { expired: false, head: 'artifact-head' });
  expect((await core.recordAcceptanceEvidence(tokens['eng-a'], {
    taskId: impl.id, acId: 'AC-1', sha: 'artifact-head',
    source: { provider: 'github-actions', runUrl: 'https://github.com/o/r/actions/runs/7', artifactId: 'a1' }, idempotencyKey: key(),
  })).verified).toBe(true);
  expect((await core.submit(tokens['eng-a'], proofOf(claim), { text: 'artifact 证据已核验，提交独立复核。', idempotencyKey: key(), acceptance: { sha: 'artifact-head' } })).state).toBe('review');
});

fork('SYS02 AC02/AC03: the PR gate head is authoritative; an old declared head with old evidence is refused', async () => {
  await ensureGate();
  const gated = new SurrealCompanyCore(database, { acceptance: { adapter: fake }, submitCheck: async () => ({ head: 'pr-head' }) });
  const goal = await goalFor();
  const [impl] = await gated.createDelivery(tokens.gm, { goalId: goal.id, title: 'B2 head 链', spec: '提交的 acceptance head 必须等于 PR 门禁核验的实际 head。',
    acceptanceCriteria: [machine()], idempotencyKey: key() });
  const claim = await gated.claim(tokens['eng-a'], impl.id);
  fake.setRun('8', 'old-head');
  await recordEvidence(tokens['eng-a'], impl.id, 'AC-1', 'old-head', '8');
  await expect(gated.submit(tokens['eng-a'], proofOf(claim), { text: '旧 head 与旧证据必须被拒绝，不能复用旧 CI。', idempotencyKey: key(), acceptance: { sha: 'old-head' } }))
    .rejects.toMatchObject({ code: 'conflict' });
  fake.setRun('9', 'pr-head');
  await recordEvidence(tokens['eng-a'], impl.id, 'AC-1', 'pr-head', '9');
  const submitted = await gated.submit(tokens['eng-a'], proofOf(claim), { text: 'PR 门禁 head 与证据一致，提交独立复核。', idempotencyKey: key(), acceptance: { sha: 'pr-head' } });
  expect(submitted).toMatchObject({ state: 'review', acceptanceHead: 'pr-head' });
});

fork('RB01: the new state is additive; an old reader sees the old states, and the rollback boundary is explicit', async () => {
  await ensureGate();
  const goal = await goalFor();
  const [impl] = await core.createDelivery(tokens.gm, { goalId: goal.id, title: 'RB01 链路', spec: '回滚演练：旧阅读器忽略新字段；旧门禁关闭时可绕过，必须排空。',
    acceptanceCriteria: [machine(), human()], idempotencyKey: key() });
  const claim = await core.claim(tokens['eng-a'], impl.id);
  fake.setRun('6', 'rb-head');
  await recordEvidence(tokens['eng-a'], impl.id, 'AC-1', 'rb-head', '6');
  await core.submit(tokens['eng-a'], proofOf(claim), { text: 'RB01：进入 review，等待独立复核。', idempotencyKey: key(), acceptance: { sha: 'rb-head' } });
  // An old-release reader selects only the fields it knows; the new fields are invisible and the state is unchanged.
  const [oldRows] = await database.db.query<[Array<Record<string, unknown>>]>(
    'SELECT id, title, state, version, executor_role, reviewer_role, kind FROM $task;', { task: new RecordId('task', impl.id) });
  expect(oldRows[0]).toMatchObject({ state: 'review' });
  expect('acceptance_criteria' in oldRows[0]!).toBe(false);
  const supervised = (await workforce.tasks()).find(task => task.id === impl.id);
  expect(supervised?.state).toBe('review');
  // The old gate path has no evaluator; disabling the gate reproduces it. The boundary is why the release application
  // must not roll back over an in-flight gated task: the row is still accepted without the new evidence check.
  const current = await core.acceptanceGate(tokens.gm);
  await core.setAcceptanceGate(tokens.gm, { enabled: false, reason: 'RB01 隔离 fork 回滚演练', expectedVersion: current.version, idempotencyKey: key() });
  const review = await core.claim(tokens['eng-b'], impl.id);
  expect((await core.accept(tokens['eng-b'], proofOf(review), { text: '旧版路径在门禁关闭后接受；这正是必须排空的回滚边界。', idempotencyKey: key() })).state).toBe('done');
  expect((await core.getTask(tokens.gm, impl.id)).state).toBe('done');
});
