// SYS02 N1-R: the full core path with the REAL adapter.
//
// The negative side is covered by the product's counter-example (a borrowed failed deployment must not certify the
// environment), by a borrowed deploy job, and by the unit negatives in tests/deployment-source.test.ts. This file
// proves the positive side on the same real core: a trusted deployment workflow whose deployment and success status
// name the evidence run produces a verified machine evidence, the task reaches review, and a NON-author reviewer
// accepts it. It also proves the source keeps the traceable identifiers, including the verified deploy job.
import { afterAll, beforeAll, beforeEach, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompanyDatabase } from '../src/database.ts';
import { SurrealCompanyCore } from '../src/core.ts';
import { LocalEnrollmentAdmin } from '../src/enrollment.ts';
import { OwnerDesk } from '../src/owner.ts';
import { createGithubActionsAdapter } from '../src/acceptance.ts';
import { id } from '../src/core.ts';
import type { ClaimResult } from '../src/contracts.ts';

setDefaultTimeout(180_000);
const NS = 'sck_n1r_core_1f462a97';
const forkEnv = process.env.RUN_SCK_CHANNEL_FORK_TESTS === '1' || process.env.RUN_SCK_WORKTREE_FORK_TESTS === '1';
// The same guard the release gate's fork file uses: the cases run only when a fork run is requested. A plain bridge run
// has no fork environment, so this file must build nothing at import time — and it brings its own isolated database,
// the way the other fork suites do, so it never reads or touches the product database.
const fork = forkEnv ? test : test.skip;
const dir = mkdtempSync(join(tmpdir(), 'sck-n1r-core-'));
let server: ReturnType<typeof Bun.spawn> | undefined;
let database: CompanyDatabase;
let core: SurrealCompanyCore;
let owner: OwnerDesk;
const tokens: Record<string, string> = {};
const key = () => crypto.randomUUID();

const SHA = '7d17cfaeb30ec26b07ab82a0c0b24bed58ae4298';
const RUN = '100';
const RUN_URL = `https://github.com/o/r/actions/runs/${RUN}`;

/** The gh transport: a trusted deploy workflow, a deployment of this run, and a success status naming this run's job. */
const gh = async (args: string[]): Promise<string> => {
  if (args[0] === 'run' && args[1] === 'view') {
    return JSON.stringify({
      headSha: SHA, status: 'completed', conclusion: 'success', workflowName: 'Deploy production',
      createdAt: '2026-10-21T23:00:00Z', updatedAt: '2026-10-21T23:02:00Z',
    });
  }
  if (args[0] === 'api' && String(args[1]).includes('/deployments?')) {
    return JSON.stringify([{
      id: 900, environment: 'production', sha: SHA, created_at: '2026-10-21T23:00:30Z',
      statuses_url: 'https://api.github.com/repos/o/r/deployments/900/statuses',
    }]);
  }
  if (args[0] === 'api' && String(args[1]).includes('/actions/jobs/')) {
    // The job the deployment status names, as the repository reports it: this run, this head.
    return JSON.stringify({ run_id: Number(RUN), head_sha: SHA });
  }
  if (args[0] === 'api' && String(args[1]).includes('/statuses')) {
    return JSON.stringify([{
      state: 'success', environment: 'production', created_at: '2026-10-21T23:01:00Z',
      log_url: `https://github.com/o/r/actions/runs/${RUN}/job/4242`,
      target_url: `https://github.com/o/r/actions/runs/${RUN}/job/4242`,
    }]);
  }
  throw new Error(`unexpected gh ${args.join(' ')}`);
};

const proofOf = (c: ClaimResult) => ({ taskId: c.task.id, deliveryId: c.deliveryId, fence: c.fence, expectedVersion: c.task.version });

beforeAll(async () => {
  if (!forkEnv) return;
  const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('fixture') });
  const port = reservation.port!; reservation.stop(true);
  const rootPassword = 'isolated-n1r-fork-only';
  server = Bun.spawn([join(homedir(), '.surrealdb/surreal'), 'start', '--bind', `127.0.0.1:${port}`, '--user', 'root', '--pass', rootPassword,
    '--log', 'error', `rocksdb:${dir}/db`], { stdout: 'ignore', stderr: 'ignore' });
  let ready = false;
  for (let n = 0; n < 160; n++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) { ready = true; break; } } catch {} await Bun.sleep(25); }
  if (!ready) throw new Error('the N1-R fork fixture did not become healthy');
  database = new CompanyDatabase({ url: `ws://127.0.0.1:${port}/rpc`, rootUser: 'root', rootPassword, namespace: NS, database: 'control_plane' });
  await database.connect();
  await database.bootstrap();
  const enrollment = new LocalEnrollmentAdmin(database);
  owner = new OwnerDesk(database);
  core = new SurrealCompanyCore(database, { acceptance: { adapter: createGithubActionsAdapter(gh) } });
  for (const [n, r, c] of [['gm','gm',['execute','review','manage']], ['eng-a','engineering',['execute','review']], ['qa','qa',['execute','review']]] as const)
    tokens[n] = await enrollment.enroll(`t-${n}`, r, c);
  const gate = await core.acceptanceGate(tokens.gm);
  await core.setAcceptanceGate(tokens.gm, { enabled: true, reason: 'N1-R core positive', expectedVersion: gate.version, idempotencyKey: key() });
}, 60_000);
afterAll(async () => {
  if (database) await database.close();
  if (server) { server.kill(); await server.exited; }
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(async () => { if (forkEnv) await database.db.query('UPDATE employee SET active_task = NONE;'); });

fork('N1-R positive: a trusted deployment of this run certifies the environment and a non-author accepts', async () => {
  const goal = await owner.createGoal({ text: 'N1-R 核心正例目标', source: 'owner:test', key: key(), tier: 'quick' });
  const task = await core.createTask(tokens.gm, {
    goalId: goal.id, title: 'N1-R 核心正例', context: '受信部署 workflow 的 deployment 与成功状态都指向本次证据 run。',
    kind: 'deploy', executorRole: 'engineering', reviewerRole: 'qa', acceptanceEnvironment: 'production', idempotencyKey: key(),
  } as never);
  const acId = (await core.getTask(tokens.gm, task.id)).acceptanceCriteria?.find(c => c.kind === 'machine')!.id;

  const claim = await core.claim(tokens['eng-a'], task.id);
  const recorded = await core.recordAcceptanceEvidence(tokens['eng-a'], {
    taskId: task.id, acId, sha: SHA, environment: 'production',
    source: { provider: 'github-actions', runUrl: RUN_URL }, idempotencyKey: key(),
  } as never);
  console.log('N1R_EVIDENCE', JSON.stringify({
    environment: recorded.environment, verified: recorded.verified,
    source: (recorded as unknown as { source?: unknown }).source,
  }));

  // The recorded source keeps the traceable deployment identifiers, not just the environment string.
  expect(recorded.environment).toBe('production');
  expect(recorded.verified).toBe(true);

  const submitted = await core.submit(tokens['eng-a'], proofOf(claim), {
    text: '提交 N1-R 核心正例：受信部署证据齐备，交独立 QA 验收。', idempotencyKey: key(),
    acceptance: { sha: SHA, environment: 'production' },
  });
  console.log('N1R_SUBMIT', JSON.stringify({ state: submitted.state }));
  expect(submitted.state).toBe('review');

  // A NON-author reviewer accepts it.
  const review = await core.claim(tokens.qa, task.id);
  const accepted = await core.accept(tokens.qa, proofOf(review), {
    text: '独立 QA 验收 N1-R 核心正例：来源关联与成功终态均已核。', idempotencyKey: key(),
  });
  console.log('N1R_ACCEPT', JSON.stringify({ state: accepted.state, attempt: accepted.acceptanceAttempt, env: accepted.acceptanceEnvironment }));
  expect(accepted.state).toBe('done');
  expect(accepted.acceptanceEnvironment).toBe('production');

  // The evidence row keeps the deployment trace.
  const [rows] = await database.db.query<[Array<{ source?: unknown; environment?: string }>]>(
    'SELECT source, environment FROM acceptance_evidence WHERE task = $task;', { task: id('task', task.id) } as never);
  const source = JSON.stringify(rows?.[0]?.source ?? {});
  console.log('N1R_SOURCE_FIELD', source);
  expect(source).toContain('900');
  expect(source).toContain('success');
  // A5: the job is part of the recorded trace and was read back from the repository.
  expect(source).toContain('4242');
  expect(source).toContain('jobVerified');
});

fork('N1-R refusal then recovery: the core refuses a borrowed deployment and a wrong job, then the same attempt passes with correct evidence', async () => {
  // One transport that can answer either way: which deployment/status it reports is switched between the calls.
  let mode: 'borrowed' | 'wrong-job' | 'correct' = 'borrowed';
  const ghSwitch = async (args: string[]): Promise<string> => {
    if (args[0] === 'run' && args[1] === 'view') {
      return JSON.stringify({
        headSha: SHA, status: 'completed', conclusion: 'success', workflowName: 'Deploy production',
        createdAt: '2026-10-21T23:00:00Z', updatedAt: '2026-10-21T23:02:00Z',
      });
    }
    if (args[0] === 'api' && String(args[1]).includes('/deployments?')) {
      // Both modes point at the same head and environment and sit in the same window: only the run link differs.
      return JSON.stringify([{
        id: 900, environment: 'production', sha: SHA, created_at: '2026-10-21T23:00:30Z',
        statuses_url: 'https://api.github.com/repos/o/r/deployments/900/statuses',
      }]);
    }
    if (args[0] === 'api' && String(args[1]).includes('/actions/jobs/')) {
      // The wrong-job mode borrows the deploy job of another run: the status link looks perfect, the job read-back is not.
      return JSON.stringify({ run_id: Number(mode === 'wrong-job' ? '999' : RUN), head_sha: SHA });
    }
    if (args[0] === 'api' && String(args[1]).includes('/statuses')) {
      const runId = mode === 'borrowed' ? '999' : RUN;
      const state = mode === 'borrowed' ? 'failure' : 'success';
      return JSON.stringify([{
        state, environment: 'production', created_at: '2026-10-21T23:01:00Z',
        log_url: `https://github.com/o/r/actions/runs/${runId}/job/4242`,
        target_url: `https://github.com/o/r/actions/runs/${runId}/job/4242`,
      }]);
    }
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  const switchCore = new SurrealCompanyCore(database, { acceptance: { adapter: createGithubActionsAdapter(ghSwitch) } });
  const goal = await owner.createGoal({ text: 'N1-R 拒绝后恢复目标', source: 'owner:test', key: key(), tier: 'quick' });
  const task = await switchCore.createTask(tokens.gm, {
    goalId: goal.id, title: 'N1-R 拒绝后恢复', context: '先借别的 run 的失败 deployment 与别的 run 的 job 各被拒一次，再补本 run 的正确证据并在同一 attempt 提交。',
    kind: 'deploy', executorRole: 'engineering', reviewerRole: 'qa', acceptanceEnvironment: 'production', idempotencyKey: key(),
  } as never);
  const acId = (await switchCore.getTask(tokens.gm, task.id)).acceptanceCriteria?.find(c => c.kind === 'machine')!.id;
  const claim = await switchCore.claim(tokens['eng-a'], task.id);
  const record = async () => switchCore.recordAcceptanceEvidence(tokens['eng-a'], {
    taskId: task.id, acId, sha: SHA, environment: 'production',
    source: { provider: 'github-actions', runUrl: RUN_URL }, idempotencyKey: key(),
  } as never);
  const refuse = async () => { try { await record(); return ''; } catch (error) { return String((error as Error).message); } };

  // 1. The borrowed (failed, other-run) deployment must be refused by the real core.
  const borrowed = await refuse();
  console.log('N1R_SWITCH_REFUSED', JSON.stringify({ borrowed }));
  expect(borrowed).toMatch(/names another run|does not reference the evidence run|no successful status/);

  // 2. A deployment whose status names THIS run's job, but whose job belongs to another run, must be refused too:
  //    the job participates in the decision, so a borrowed job is the same symptom as a borrowed run link.
  mode = 'wrong-job';
  const wrongJob = await refuse();
  console.log('N1R_SWITCH_WRONG_JOB', JSON.stringify({ wrongJob }));
  expect(wrongJob).toContain(`job 4242 belongs to run 999, not run ${RUN}`);

  // 3. Correct evidence in the SAME attempt: the task is still doing, the attempt has not advanced.
  mode = 'correct';
  const recorded = await record();
  expect(recorded.verified).toBe(true);
  const current = await switchCore.getTask(tokens.gm, task.id);
  expect(current.state).toBe('doing');
  const submitted = await switchCore.submit(tokens['eng-a'], {
    taskId: task.id, deliveryId: claim.deliveryId, fence: claim.fence, expectedVersion: current.version,
  }, { text: '提交 N1-R 恢复：本 attempt 已补正确部署证据，交独立 QA。', idempotencyKey: key(), acceptance: { sha: SHA, environment: 'production' } });
  expect(submitted.state).toBe('review');
  const review = await switchCore.claim(tokens.qa, task.id);
  const accepted = await switchCore.accept(tokens.qa, {
    taskId: task.id, deliveryId: review.deliveryId, fence: review.fence, expectedVersion: review.task.version,
  }, { text: '独立 QA 验收 N1-R 恢复：正确来源证据通过。', idempotencyKey: key() });
  console.log('N1R_SWITCH_ACCEPT', JSON.stringify({ state: accepted.state, attempt: accepted.acceptanceAttempt }));
  expect(accepted.state).toBe('done');
  expect(accepted.acceptanceAttempt).toBe(1);
});
