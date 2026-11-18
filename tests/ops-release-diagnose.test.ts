import { describe, expect, test } from 'bun:test';
import { OpsBroker, type OpsDeps } from '../src/ops/broker.ts';
import type { OriginRequest } from '../src/ops/origin.ts';
import type { GhRunner } from '../src/pr-gate.ts';
import type { Fetcher } from '../src/ops/fetcher.ts';
import { brokerConfig, FakeCompany, FakeWorld } from './support/ops-world.ts';

const REPO = 'MainListActivity/surreal_ck';
const SHA = '72de7f919f351b063bbe040d45341f9f2c7974ef';
const OTHER = 'aa23b0f00937e5e9dabf229490f992b0a684a113';
const ORIGIN = { host: 'origin.test', user: 'sckops', keyFile: '/keys/ops', knownHosts: '/keys/known_hosts' };

interface JobFixture {
  name: string;
  conclusion?: string;
  status?: string;
  steps?: Array<{ name: string; conclusion: string }>;
}
interface RunFixture {
  id: string;
  workflow: string;
  head?: string;
  runAttempt?: number;
  status?: string;
  conclusion?: string;
  jobs: Record<number, JobFixture[]>;
  event?: string;
  createdAt?: string;
  updatedAt?: string;
}

const job = (name: string, conclusion: string, steps?: Array<{ name: string; conclusion: string }>): JobFixture =>
  ({ name, conclusion, status: 'completed', ...(steps ? { steps: steps.map(step => ({ ...step, status: 'completed' })) } : {}) });

const apiJob = (fixture: JobFixture, runId: string): Record<string, unknown> => ({
  name: fixture.name, status: fixture.status ?? 'completed', conclusion: fixture.conclusion ?? 'success',
  started_at: '2026-11-18T08:24:22Z', completed_at: '2026-11-18T08:27:21Z',
  html_url: `https://github.com/${REPO}/actions/runs/${runId}/job/${fixture.name.replace(/\W+/g, '')}`,
  steps: (fixture.steps ?? []).map(step => ({ name: step.name, status: 'completed', conclusion: step.conclusion })),
});

/** A deterministic read-only gh: only the exact fixed reads the diagnosis is allowed to make. */
function fakeGh(runs: RunFixture[]): { run: GhRunner; calls: string[][] } {
  const calls: string[][] = [];
  const byId = new Map(runs.map(item => [item.id, item]));
  const runner: GhRunner = async args => {
    calls.push(args);
    if (args[0] === 'api' && args[1]?.startsWith(`repos/${REPO}/actions/runs?head_sha=`)) {
      return JSON.stringify({
        workflow_runs: runs.map(item => ({
          id: Number(item.id), head_sha: item.head ?? SHA, status: item.status ?? 'completed',
          conclusion: item.conclusion ?? 'success', run_attempt: item.runAttempt ?? 1,
          html_url: `https://github.com/${REPO}/actions/runs/${item.id}`,
          created_at: item.createdAt ?? '2026-11-18T08:24:20Z', updated_at: item.updatedAt ?? '2026-11-18T09:31:17Z',
          event: item.event ?? 'push',
        })),
      });
    }
    const view = /^run view (\d+)$/.exec(`${args[0]} ${args[1]} ${args[2]}`);
    if (view) {
      const item = byId.get(view[1]!);
      if (!item) throw new Error('no such run');
      return JSON.stringify({
        headSha: item.head ?? SHA, status: item.status ?? 'completed', conclusion: item.conclusion ?? 'success',
        workflowName: item.workflow, createdAt: item.createdAt ?? '2026-11-18T08:24:20Z',
        updatedAt: item.updatedAt ?? '2026-11-18T09:31:17Z',
        url: `https://github.com/${REPO}/actions/runs/${item.id}`, event: item.event ?? 'push',
      });
    }
    const jobs = new RegExp(`^repos/${REPO}/actions/runs/(\\d+)/attempts/(\\d+)/jobs\\?per_page=50$`).exec(args[1] ?? '');
    if (args[0] === 'api' && jobs) {
      const item = byId.get(jobs[1]!);
      if (!item) throw new Error('no such run');
      const fixtures = item.jobs[Number(jobs[2])];
      if (!fixtures) throw new Error('no such attempt');
      return JSON.stringify({ total_count: fixtures.length, jobs: fixtures.map(fixture => apiJob(fixture, item.id)) });
    }
    throw new Error(`unexpected gh read: ${args.join(' ')}`);
  };
  return { run: runner, calls };
}

const runtimeFetch = (body: string, status = 200, contentType = 'application/json'): Fetcher => async () =>
  new Response(body, { status, headers: { 'content-type': contentType } });

const unknownRuntime: Fetcher = async () => new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });

interface RigOptions {
  runs: RunFixture[];
  runtime?: Fetcher;
  origin?: typeof ORIGIN;
  originAgent?: (origin: typeof ORIGIN, request: OriginRequest) => Promise<Record<string, unknown>>;
  repo?: string | null;
  envUrl?: string;
}

function rig(options: RigOptions) {
  const world = new FakeWorld();
  const company = new FakeCompany();
  company.env('demo', 'production', brokerConfig({ ...(options.origin ? { origin: options.origin } : {}) }),
    options.envUrl ? { url: options.envUrl } : {});
  const gh = fakeGh(options.runs);
  const broker = new OpsBroker({
    core: company.core as never,
    projects: company.projects as never,
    secretKey: () => Buffer.alloc(32),
    fetch: options.runtime ?? runtimeFetch(JSON.stringify({ sha: SHA, deploymentId: '44276693580-1' })),
    now: world.now,
    gh: gh.run,
    projectRepoSlug: async () => (options.repo === undefined ? REPO : (options.repo ?? undefined)),
    originAgent: options.originAgent ?? (async () => ({ ok: true })),
    sleep: async (ms: number) => { world.clock += ms; },
  } as OpsDeps);
  return { world, company, broker, calls: gh.calls, qa: company.lease('qa-1', 'qa', 'task-1') };
}

async function call(r: ReturnType<typeof rig>, args: Record<string, unknown>, as: { cred?: string; task?: string } = {}) {
  return await r.broker.call(as.cred ?? r.qa, as.task ?? 'task-1', 'ops_release_diagnose', args) as Record<string, any>;
}

async function failure(promise: Promise<unknown>) {
  try { await promise; } catch (error) { return error as Error & { code: string }; }
  throw new Error('expected the call to fail');
}

const successJobs = (workflow: string): Record<number, JobFixture[]> => ({
  1: [
    job('Validate configuration', 'success'),
    job(workflow === 'Deploy production' ? 'Hono origin' : 'Quality gate', 'success', [
      { name: 'Lint', conclusion: 'success' }, { name: 'Test', conclusion: 'success' },
    ]),
    ...(workflow === 'Deploy production' ? [job('Cloudflare production', 'success')] : []),
  ],
});

describe('ops release diagnosis', () => {
  test('a live deployment is verified only when the public runtime version names the deploy run and its stages all passed', async () => {
    const r = rig({
      runs: [
        { id: '44266682999', workflow: 'Quality gate', jobs: successJobs('Quality gate') },
        { id: '44276693580', workflow: 'Deploy production', runAttempt: 1, jobs: successJobs('Deploy production') },
      ],
      origin: ORIGIN,
      originAgent: async (_origin, request) => request.op === 'status'
        ? { ok: true, services: { 'surreal-ck-hono': { active: 'active', sub: 'running' } } }
        : { ok: true, checks: { 'surreal-ck-hono': { reachable: true, status: 200, body: 'ok' } } },
    });
    const report = await call(r, { sha: SHA });
    expect(report.status).toBe('deployed');
    expect(report.repo).toBe(REPO);
    expect(report.sha).toBe(SHA);
    expect(report.ci.state).toBe('success');
    expect(report.deploy.state).toBe('verified');
    expect(report.deploy.verifiedRun).toEqual({ id: '44276693580', attempt: 1, url: `https://github.com/${REPO}/actions/runs/44276693580` });
    expect(report.runtimeVersion).toMatchObject({ state: 'known', sha: SHA, deploymentId: '44276693580-1', matchesTarget: true });
    // The origin answers, but its probes carry no release identity: the release fact stays unknown there.
    expect(report.origin.state).toBe('unknown');
    expect(report.origin.reads).toEqual({ status: 'ok', health: 'ok' });
    expect(report.origin.services).toBeDefined();
    expect(report.origin.checks).toEqual({ 'surreal-ck-hono': { reachable: true, status: 200 } });
    expect(report.links.runs.length).toBeGreaterThan(0);
    expect(report.links.runtimeVersion).toBe('https://app.test/runtime-version.json');
    expect(r.company.audits.map(a => a.evidence)).toContain(`ops_release_diagnose repo=${REPO} sha=${SHA} ci=success deploy=verified status=deployed`);
  });

  test('a successful deploy workflow whose stages were skipped is not a deployment', async () => {
    const r = rig({
      runs: [
        { id: '44266682999', workflow: 'Quality gate', jobs: successJobs('Quality gate') },
        {
          id: '44267127836', workflow: 'Deploy production', conclusion: 'success', jobs: {
            1: [job('Validate production configuration', 'success'), job('Hono origin', 'skipped'), job('Cloudflare production', 'skipped')],
          },
        },
      ],
      runtime: unknownRuntime,
    });
    const report = await call(r, { sha: SHA });
    expect(report.status).toBe('deploy_skipped');
    expect(report.deploy.state).toBe('skipped');
    expect(report.deploy.verifiedRun).toBeUndefined();
    expect(report.deploy.skippedStages).toEqual(['Hono origin', 'Cloudflare production']);
    expect(report.runtimeVersion.state).toBe('unknown');
  });

  test('attempt one failing and attempt two passing keeps the full SHA, the failed stage and the passing run', async () => {
    const r = rig({
      runs: [
        {
          id: '44266682999', workflow: 'Quality gate', runAttempt: 2,
          jobs: {
            1: [job('Quality gate', 'failure', [{ name: 'Lint', conclusion: 'success' }, { name: 'Test', conclusion: 'failure' }])],
            2: [job('Quality gate', 'success', [{ name: 'Lint', conclusion: 'success' }, { name: 'Test', conclusion: 'success' }])],
          },
        },
        { id: '44276693580', workflow: 'Deploy production', jobs: successJobs('Deploy production') },
      ],
    });
    const report = await call(r, { sha: SHA });
    expect(report.sha).toBe(SHA);
    expect(report.ci.state).toBe('success');
    const first = report.ci.runs[0].attempts.find((attempt: any) => attempt.attempt === 1);
    expect(first).toMatchObject({ conclusion: 'failure', failedStage: 'Quality gate', failedStep: 'Test' });
    expect(first.failedAt).toBe('2026-11-18T08:27:21Z');
    expect(report.ci.runs[0].attempts.find((attempt: any) => attempt.attempt === 2).conclusion).toBe('success');
    expect(report.status).toBe('deployed');
  });

  test('a public runtime version naming another commit is not this deployment', async () => {
    const r = rig({
      runs: [{ id: '44276693580', workflow: 'Deploy production', jobs: successJobs('Deploy production') }],
      runtime: runtimeFetch(JSON.stringify({ sha: OTHER, deploymentId: '44197789340-1' })),
    });
    const report = await call(r, { sha: SHA });
    expect(report.deploy.state).toBe('not_deployed');
    expect(report.status).toBe('not_deployed');
    expect(report.runtimeVersion.matchesTarget).toBe(false);
    expect(report.deploy.reason).toContain(OTHER);
  });

  test('an unreadable public runtime version leaves the deployment unknown, never successful', async () => {
    const r = rig({
      runs: [{ id: '44276693580', workflow: 'Deploy production', jobs: successJobs('Deploy production') }],
      runtime: unknownRuntime,
    });
    const report = await call(r, { sha: SHA });
    expect(report.deploy.state).toBe('unknown');
    expect(report.status).toBe('unknown');
    expect(report.runtimeVersion.state).toBe('unknown');
    expect(report.deploy.reason).toContain('live release is unknown');
  });

  test('a runtime deployment id that names no read run stays unknown', async () => {
    const r = rig({
      runs: [{ id: '44276693580', workflow: 'Deploy production', jobs: successJobs('Deploy production') }],
      runtime: runtimeFetch(JSON.stringify({ sha: SHA, deploymentId: '99999999999-1' })),
    });
    const report = await call(r, { sha: SHA });
    expect(report.runtimeVersion.state).toBe('known');
    expect(report.runtimeVersion.matchesTarget).toBe(true);
    expect(report.deploy.state).toBe('unknown');
  });

  test('a failed deployment stage is reported with its stage, time and link', async () => {
    const r = rig({
      runs: [{
        id: '44197789340', workflow: 'Deploy production', head: OTHER, conclusion: 'failure', jobs: {
          1: [
            job('Validate production configuration', 'success'),
            job('Hono origin / Hono origin (systemd)', 'failure', [{ name: 'Deploy origin', conclusion: 'failure' }]),
            job('Cloudflare production', 'skipped'),
          ],
        },
      }],
      runtime: unknownRuntime,
    });
    const report = await call(r, { sha: OTHER });
    expect(report.status).toBe('deploy_failed');
    expect(report.deploy.state).toBe('failed');
    expect(report.deploy.failedStage).toBe('Hono origin / Hono origin (systemd)');
    expect(report.deploy.failedStep).toBe('Deploy origin');
    expect(report.deploy.failedAt).toBe('2026-11-18T08:27:21Z');
    expect(report.limits.rootCause).toBe('not_inferred');
  });

  test('the origin being unreachable is explicit unknown and does not hide a verified deployment', async () => {
    const r = rig({
      runs: [{ id: '44276693580', workflow: 'Deploy production', jobs: successJobs('Deploy production') }],
      origin: ORIGIN,
      originAgent: async () => { throw new Error('ssh: connect to host origin.test port 22: Connection refused'); },
    });
    const report = await call(r, { sha: SHA });
    expect(report.status).toBe('deployed');
    expect(report.origin.state).toBe('unknown');
    expect(report.origin.reads).toEqual({ status: 'unavailable', health: 'unavailable' });
    expect(report.origin.reachable).toBeNull();
  });

  test('an environment without an origin host says unknown instead of failing the diagnosis', async () => {
    const r = rig({ runs: [{ id: '44276693580', workflow: 'Deploy production', jobs: successJobs('Deploy production') }] });
    const report = await call(r, { sha: SHA });
    expect(report.origin).toMatchObject({ configured: false, state: 'unknown', reads: { status: 'skipped', health: 'skipped' } });
  });

  test('a run whose head is another commit is never counted for this sha', async () => {
    const r = rig({ runs: [{ id: '44276693580', workflow: 'Deploy production', head: OTHER, jobs: successJobs('Deploy production') }] });
    const report = await call(r, { sha: SHA });
    expect(report.ci.state).toBe('missing');
    expect(report.deploy.state).toBe('missing');
    expect(report.status).toBe('unknown');
    expect(report.limits.ignoredHeadRuns).toBe(1);
  });

  test('repository, URL, host, command and credentials cannot be chosen by the caller', async () => {
    const r = rig({ runs: [] });
    for (const args of [
      { sha: SHA, repo: 'evil/evil' }, { sha: SHA, repository: 'evil/evil' }, { sha: SHA, url: 'https://evil.test/x' },
      { sha: SHA, host: 'evil.test' }, { sha: SHA, command: 'rm -rf /' }, { sha: SHA, token: 'secret' },
      { sha: SHA, credentials: 'x' }, { sha: SHA, origin: 'evil.test' },
    ]) {
      const error = await failure(call(r, args));
      expect(error.code).toBe('invalid');
    }
    expect(r.calls).toHaveLength(0);
  });

  test('a short or uppercase sha is refused before any read', async () => {
    const r = rig({ runs: [] });
    for (const sha of ['72de7f9', SHA.toUpperCase(), '']) {
      expect((await failure(call(r, { sha }))).code).toBe('invalid');
    }
    expect(r.calls).toHaveLength(0);
  });

  test('an unknown environment, a project without a repository and no live lease are refused', async () => {
    const r = rig({ runs: [] });
    expect((await failure(call(r, { sha: SHA, env: 'staging' }))).code).toBe('not_configured');
    expect(r.calls).toHaveLength(0);
    const noRepo = rig({ runs: [], repo: null });
    expect((await failure(call(noRepo, { sha: SHA }))).code).toBe('not_configured');
    expect(noRepo.calls).toHaveLength(0);
    r.company.endLease('qa-1');
    expect((await failure(call(r, { sha: SHA }))).code).toBe('forbidden');
    expect(r.calls).toHaveLength(0);
  });

  test('every GitHub read is a fixed check/deploy metadata read, never a log', async () => {
    const r = rig({ runs: [{ id: '44276693580', workflow: 'Deploy production', jobs: successJobs('Deploy production') }] });
    await call(r, { sha: SHA });
    expect(r.calls.length).toBeGreaterThan(0);
    for (const args of r.calls) {
      expect(args).not.toContain('--log');
      expect(args[0] === 'api' || (args[0] === 'run' && args[1] === 'view')).toBe(true);
      if (args[0] === 'api') expect(args[1]).toMatch(new RegExp(`^repos/${REPO}/actions/runs`));
    }
  });
});