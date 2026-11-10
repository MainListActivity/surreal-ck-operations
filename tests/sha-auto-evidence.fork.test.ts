// 软件线按 sha 自动验收证据（spec 阶段三）：submit 只给 sha，系统在该任务代码仓的 GitHub remote
// 查成功完成的 Actions run，自动为每个 required machine criterion 记录证据。run 列表与 adapter
// 都是注入的确定性替身，不需要网络。
import { afterAll, beforeAll, beforeEach, expect, setDefaultTimeout, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordId } from 'surrealdb';
import { loadDatabaseConfig } from '../src/config.ts';
import { CompanyDatabase } from '../src/database.ts';
import { SurrealCompanyCore } from '../src/core.ts';
import { LocalEnrollmentAdmin } from '../src/enrollment.ts';
import { Workforce } from '../src/workforce.ts';
import type { AcceptanceSourceAdapter, AcceptanceSourceInput, AcceptanceVerifyResult } from '../src/acceptance.ts';
import type { ClaimResult, TaskView } from '../src/contracts.ts';

setDefaultTimeout(120_000);
const fork = process.env.RUN_SCK_WORKTREE_FORK_TESTS === '1' ? test : test.skip;
const NS = 'sck_sha_evidence_test';
const database = new CompanyDatabase({ ...loadDatabaseConfig(), namespace: NS, database: 'control_plane' });
const credDir = mkdtempSync(join(tmpdir(), 'sck-sha-evidence-'));
const repoDir = mkdtempSync(join(tmpdir(), 'sck-sha-repo-'));
const workforce = new Workforce(database);
const enrollment = new LocalEnrollmentAdmin(database);
const tokens: Record<string, string> = {};
const key = () => crypto.randomUUID();
const SHA = 'a'.repeat(40);

class FakeAdapter implements AcceptanceSourceAdapter {
  /** runUrl run-id → result; absent means the adapter fails that run. */
  runs = new Map<string, { ok: boolean; reason?: string }>();
  async verify(input: AcceptanceSourceInput): Promise<AcceptanceVerifyResult> {
    const runId = /\/actions\/runs\/(\d+)/.exec(input.runUrl)?.[1] ?? '0';
    const run = this.runs.get(runId);
    if (!run?.ok) return { ok: false, reason: run?.reason ?? 'run not found' };
    return { ok: true, sha: input.sha, at: new Date().toISOString(),
      ...(input.environment !== undefined ? { environment: input.environment } : {}),
      source: { provider: 'github-actions', runUrl: input.runUrl, runId } };
  }
}
const adapter = new FakeAdapter();
let listed: string[] = [];
let listedCalls: Array<{ slug: string; sha: string }> = [];
const core = new SurrealCompanyCore(database, { acceptance: {
  adapter, runs: async (slug, sha) => { listedCalls.push({ slug, sha }); return listed; } } });
const proofOf = (c: ClaimResult) => ({ taskId: c.task.id, deliveryId: c.deliveryId, fence: c.fence, expectedVersion: c.task.version });
const machine = (id: string) => ({ id, kind: 'machine' as const, required: true, layer: 'ci' as const, evidence: 'ci-run' as const, verify: 'ci' as const, risk: 'code' as const });

beforeAll(async () => {
  await database.connect();
  await database.db.query(`DEFINE NAMESPACE IF NOT EXISTS ${NS};`);
  await database.db.use({ namespace: NS });
  await database.db.query('REMOVE DATABASE IF EXISTS control_plane;');
  await database.bootstrap();
  for (const [name, role, caps] of [
    ['owner', 'owner', ['execute', 'review', 'manage']],
    ['eng-a', 'engineering', ['execute', 'review']], ['eng-b', 'engineering', ['execute', 'review']],
  ] as const) tokens[name] = await enrollment.enroll(`t-${name}`, role, caps);
  execSync('git init -q && git remote add origin https://github.com/MainListActivity/sha-fixture.git', { cwd: repoDir });
  await database.db.query('CREATE project:sha_fixture CONTENT { name: \'sha-fixture\', repo_path: $repo };', { repo: repoDir });
}, 30_000);
afterAll(async () => { await database.close(); rmSync(credDir, { recursive: true, force: true }); rmSync(repoDir, { recursive: true, force: true }); });
beforeEach(async () => {
  await database.db.query('UPDATE employee SET active_task = NONE;');
  adapter.runs.clear(); adapter.runs.set('11', { ok: true });
  listed = ['https://github.com/MainListActivity/sha-fixture/actions/runs/11'];
  listedCalls = [];
  const gate = await core.acceptanceGate(tokens.owner);
  if (!gate.enabled) await core.setAcceptanceGate(tokens.owner, { enabled: true, reason: 'sha 测试启用门禁', expectedVersion: gate.version, idempotencyKey: key() });
});
const codeTask = async (): Promise<TaskView> => core.createTask(tokens.owner, {
  executorRole: 'engineering', reviewerRole: 'engineering', workIntent: { kind: 'code' }, codeRepoPath: repoDir,
  project: 'sha_fixture', title: 'sha 自动证据任务', context: '按 sha 自动验收证据。', acceptanceCriteria: [machine('AC-CI-1'), machine('AC-CI-2')], idempotencyKey: key(),
} as never);

fork('submit sha: a successful completed run records evidence for every required machine criterion and the submit passes', async () => {
  const task = await codeTask();
  const claim = await core.claim(tokens['eng-a'], task.id);
  const out = await core.submit(tokens['eng-a'], proofOf(claim), { text: '实现完成，CI 绿灯通过，按 sha 自动记录证据后提交。', sha: SHA, idempotencyKey: key() });
  expect(out.state).not.toBe('doing');
  expect(listedCalls).toEqual([{ slug: 'MainListActivity/sha-fixture', sha: SHA }]);
  const [rows] = await database.db.query<[Array<{ ac_id: string; sha: string }>]>('SELECT ac_id, sha FROM acceptance_evidence WHERE task = $t;', { t: new RecordId('task', task.id) });
  expect(rows.map(r => r.ac_id).sort()).toEqual(['AC-CI-1', 'AC-CI-2']);
  expect(rows.every(r => r.sha === SHA)).toBe(true);
});

fork('submit sha: no run, unfinished run or a failed run is rejected with the reason; manual record_acceptance_evidence still works', async () => {
  const task = await codeTask();
  const claim = await core.claim(tokens['eng-a'], task.id);
  listed = [];
  try { await core.submit(tokens['eng-a'], proofOf(claim), { text: '实现完成但 CI run 还没有成功完成，提交应被拒绝并说明原因。', sha: SHA, idempotencyKey: key() }); expect.unreachable('submit must reject'); }
  catch (error) { console.log('ERR1', (error as Error).message); expect(String((error as Error).message)).toContain('GitHub Actions run'); }
  // The runs lister returns a run the adapter rejects (in progress or failed conclusion).
  adapter.runs.clear(); adapter.runs.set('22', { ok: false, reason: 'run not successful' });
  listed = ['https://github.com/MainListActivity/sha-fixture/actions/runs/22'];
  try { await core.submit(tokens['eng-a'], proofOf(claim), { text: '实现完成但返回的 CI run 都不可用，提交应被拒绝并说明原因。', sha: SHA, idempotencyKey: key() }); expect.unreachable('submit must reject'); }
  catch (error) { console.log('ERR2', (error as Error).message); expect(String((error as Error).message)).toContain('AC-CI-1'); }
  // Manual evidence still satisfies the gate with no runs lookup needed.
  adapter.runs.set('33', { ok: true });
  await core.recordAcceptanceEvidence(tokens['eng-a'], {
    taskId: task.id, acId: 'AC-CI-1', sha: SHA, idempotencyKey: key(),
    source: { provider: 'github-actions', runUrl: 'https://github.com/MainListActivity/sha-fixture/actions/runs/33' } });
  await core.recordAcceptanceEvidence(tokens['eng-a'], {
    taskId: task.id, acId: 'AC-CI-2', sha: SHA, idempotencyKey: key(),
    source: { provider: 'github-actions', runUrl: 'https://github.com/MainListActivity/sha-fixture/actions/runs/33' } });
  listedCalls = [];
  const out = await core.submit(tokens['eng-a'], proofOf(claim), { text: '手动记录全部机器证据后再提交，应通过且不再查 run。', sha: SHA, idempotencyKey: key() });
  expect(out.state).not.toBe('doing');
  expect(listedCalls).toEqual([]);
});
