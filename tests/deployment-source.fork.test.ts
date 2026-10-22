// SYS02 N1-R: the full core path with the REAL adapter.
//
// The negative side is covered by the product's counter-example (a borrowed failed deployment must not certify the
// environment). This file proves the positive side on the same real core: a trusted deployment workflow whose
// deployment and success status name the evidence run produces a verified machine evidence, the task reaches review,
// and a NON-author reviewer accepts it. It also proves the source keeps the traceable identifiers.
import { afterAll, beforeAll, beforeEach, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDatabaseConfig } from '../src/config.ts';
import { CompanyDatabase } from '../src/database.ts';
import { SurrealCompanyCore } from '../src/core.ts';
import { LocalEnrollmentAdmin } from '../src/enrollment.ts';
import { OwnerDesk } from '../src/owner.ts';
import { createGithubActionsAdapter } from '../src/acceptance.ts';
import { id } from '../src/core.ts';
import type { ClaimResult } from '../src/contracts.ts';

setDefaultTimeout(180_000);
const NS = 'sck_n1r_core_1f462a97';
// The same guard the release gate's fork file uses: the case runs only when a fork run is requested.
const fork = process.env.RUN_SCK_CHANNEL_FORK_TESTS === '1' || process.env.RUN_SCK_WORKTREE_FORK_TESTS === '1' ? test : test.skip;
const database = new CompanyDatabase({ ...loadDatabaseConfig(), namespace: NS, database: 'control_plane' });
const credDir = mkdtempSync(join(tmpdir(), 'sck-n1r-core-'));
const enrollment = new LocalEnrollmentAdmin(database);
const owner = new OwnerDesk(database);
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
  if (args[0] === 'api' && String(args[1]).includes('/statuses')) {
    return JSON.stringify([{
      state: 'success', environment: 'production', created_at: '2026-10-21T23:01:00Z',
      log_url: `https://github.com/o/r/actions/runs/${RUN}/job/4242`,
      target_url: `https://github.com/o/r/actions/runs/${RUN}/job/4242`,
    }]);
  }
  throw new Error(`unexpected gh ${args.join(' ')}`);
};

const core = new SurrealCompanyCore(database, { acceptance: { adapter: createGithubActionsAdapter(gh) } });
const proofOf = (c: ClaimResult) => ({ taskId: c.task.id, deliveryId: c.deliveryId, fence: c.fence, expectedVersion: c.task.version });

beforeAll(async () => {
  await database.connect();
  await database.db.query(`DEFINE NAMESPACE IF NOT EXISTS ${NS};`);
  await database.db.use({ namespace: NS });
  await database.db.query('REMOVE DATABASE IF EXISTS control_plane;');
  await database.bootstrap();
  for (const [n, r, c] of [['gm','gm',['execute','review','manage']], ['eng-a','engineering',['execute','review']], ['qa','qa',['execute','review']]] as const)
    tokens[n] = await enrollment.enroll(`t-${n}`, r, c);
  const gate = await core.acceptanceGate(tokens.gm);
  await core.setAcceptanceGate(tokens.gm, { enabled: true, reason: 'N1-R core positive', expectedVersion: gate.version, idempotencyKey: key() });
}, 30_000);
afterAll(async () => { await database.close(); rmSync(credDir, { recursive: true, force: true }); });
beforeEach(async () => { await database.db.query('UPDATE employee SET active_task = NONE;'); });

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
});
