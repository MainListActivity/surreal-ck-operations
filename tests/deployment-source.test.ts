// SYS02 N1-R: the source association between an evidence run and the deployment that certifies the environment.
//
// These cases drive the REAL createGithubActionsAdapter (only its gh transport is stubbed), so they exercise the
// production algorithm, not a fake. The trust boundary has three independent axes:
//   A. authorization — only a trusted deployment workflow may certify an environment;
//   B. causation    — the deployment and its success status must name the evidence run;
//   C. job identity  — a named deploy job must read back as this run's and this head's.
// A borrowed deployment must fail on B even when the workflow would have been trusted.
import { describe, expect, test } from 'bun:test';
import { createGithubActionsAdapter } from '../src/acceptance.ts';

const SHA = '7d17cfaeb30ec26b07ab82a0c0b24bed58ae4298';
const RUN = '100';
const OTHER_RUN = '999';
const TRUSTED = 'Deploy production';
const UNTRUSTED = 'Quality gate';
const RUN_URL = `https://github.com/o/r/actions/runs/${RUN}`;
const RUN_LINK = `https://github.com/o/r/actions/runs/${RUN}/job/4242`;

type Dep = Record<string, unknown>;
type Status = Record<string, unknown>;

/** A deployment produced by `runId`, with a status whose log_url points at that run's job. */
const deployment = (over: Dep = {}, statuses: Status[] = []): Dep => ({
  id: 900, environment: 'production', sha: SHA, created_at: '2026-10-21T23:00:30Z',
  statuses_url: 'https://api.github.com/repos/o/r/deployments/900/statuses',
  ...over,
});
const successStatus = (runId: string, over: Status = {}): Status => ({
  state: 'success', environment: 'production', created_at: '2026-10-21T23:01:00Z',
  log_url: `https://github.com/o/r/actions/runs/${runId}/job/4242`,
  target_url: `https://github.com/o/r/actions/runs/${runId}/job/4242`,
  ...over,
});

/** The gh transport stub: run view, deployments list, deployment statuses, and the repository's jobs. */
const transport = (opts: {
  workflowName?: string;
  conclusion?: string;
  deployments?: Dep[];
  statuses?: Record<string, Status[]>;
  deploymentsError?: string;
  statusesError?: string;
  /** The jobs the repository reports, keyed by job id. 4242 defaults to this run's job on this head. */
  jobs?: Record<string, { runId?: string | number | null; headSha?: string | null }>;
  jobsError?: string;
}) => {
  const calls: string[][] = [];
  const jobs = opts.jobs ?? { '4242': { runId: RUN, headSha: SHA } };
  const run = async (args: string[]) => {
    calls.push(args);
    const path = String(args[1] ?? '');
    if (args[0] === 'run' && args[1] === 'view') {
      return JSON.stringify({
        headSha: SHA, status: 'completed', conclusion: opts.conclusion ?? 'success',
        workflowName: opts.workflowName ?? TRUSTED,
        createdAt: '2026-10-21T23:00:00Z', updatedAt: '2026-10-21T23:02:00Z',
      });
    }
    if (args[0] === 'api' && path.includes('/deployments?')) {
      if (opts.deploymentsError) throw new Error(opts.deploymentsError);
      return JSON.stringify(opts.deployments ?? []);
    }
    if (args[0] === 'api' && path.includes('/actions/jobs/')) {
      if (opts.jobsError) throw new Error(opts.jobsError);
      const jobId = /\/actions\/jobs\/(\d+)/.exec(path)?.[1] ?? '';
      const job = jobs[jobId];
      // An unknown job id is a 404, not a pass: the caller must fail closed on it.
      if (!job) throw new Error('HTTP 404');
      return JSON.stringify({ run_id: job.runId ?? null, head_sha: job.headSha ?? null });
    }
    if (args[0] === 'api' && path.includes('/statuses')) {
      if (opts.statusesError) throw new Error(opts.statusesError);
      const id = /\/deployments\/(\d+)\/statuses/.exec(path)?.[1] ?? '';
      return JSON.stringify(opts.statuses?.[id] ?? []);
    }
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  return { run, calls };
};

const input = (over: Record<string, unknown> = {}) => ({
  provider: 'github-actions' as const, runUrl: RUN_URL, sha: SHA, environment: 'production', verify: 'deploy-run', ...over,
});

const reasonOf = (verdict: unknown) => String((verdict as { reason?: string }).reason ?? '');
const sourceOf = (verdict: unknown) => (verdict as { source: Record<string, any> }).source;

describe('N1-R: the deployment source association', () => {
  test('POSITIVE: a trusted workflow whose deployment status names this run certifies the environment', async () => {
    const t = transport({
      deployments: [deployment()],
      statuses: { '900': [successStatus(RUN)] },
    });
    const verdict = await createGithubActionsAdapter(t.run).verify(input());
    expect(verdict).toMatchObject({ ok: true, environment: 'production' });
    // The source keeps the traceable identifiers, not just the environment string.
    const source = sourceOf(verdict);
    expect(source).toMatchObject({ runId: RUN, workflowName: TRUSTED, environment: 'production' });
    expect(source.deployment).toMatchObject({ deploymentId: '900', status: 'success', deploymentRunId: RUN });
    // A5: the job the success status names is read back from the repository and recorded as verified.
    expect(source.deployment).toMatchObject({ deploymentJobId: '4242', jobVerified: true });
    expect(t.calls.some(c => c.join(' ').includes('/actions/jobs/4242'))).toBe(true);
    // The deployment's status list was actually read (the product's log recorded statusReads=0 as the defect).
    expect(t.calls.filter(c => c.join(' ').includes('/statuses')).length).toBe(1);
  });

  test('POSITIVE record channel: a record that names this run\'s job link certifies without a status link', async () => {
    // The record side is a real channel: `payload`/`workflow_run`/`description` links count, so a deployment whose
    // status carries no URL fields still certifies when the record itself names the run and job.
    const t = transport({
      deployments: [deployment({ payload: { run_url: RUN_LINK } })],
      statuses: { '900': [successStatus(RUN, { log_url: null, target_url: null })] },
    });
    const verdict = await createGithubActionsAdapter(t.run).verify(input());
    expect(verdict.ok).toBe(true);
    expect(sourceOf(verdict).deployment).toMatchObject({ deploymentRunId: RUN, deploymentJobId: '4242', jobVerified: true });
  });

  test('POSITIVE workflow_run: the structured workflow_run field of the deployment names this run', async () => {
    const t = transport({
      deployments: [deployment({ workflow_run: { id: Number(RUN), url: RUN_URL } })],
      statuses: { '900': [successStatus(RUN, { log_url: null, target_url: null })] },
    });
    const verdict = await createGithubActionsAdapter(t.run).verify(input());
    expect(verdict.ok).toBe(true);
    expect(sourceOf(verdict).deployment).toMatchObject({ deploymentRunId: RUN });
  });

  test('NEGATIVE A: a generic CI workflow cannot certify an environment', async () => {
    const t = transport({
      workflowName: UNTRUSTED,
      deployments: [deployment()],
      statuses: { '900': [successStatus(RUN)] },
    });
    const verdict = await createGithubActionsAdapter(t.run).verify(input());
    expect(verdict.ok).toBe(false);
    expect(reasonOf(verdict)).toContain('not trusted');
  });

  test('NEGATIVE A1: a record that names another run is refused even when its status names this run', async () => {
    // The A1 rescue hole: the record says run 999 produced this deployment, the status points at run 100. The
    // contradiction must fail closed — a corroborating channel never rescues a record that names another run.
    const t = transport({
      workflowName: TRUSTED,
      deployments: [deployment({ payload: { run_id: Number(OTHER_RUN) } })],
      statuses: { '900': [successStatus(RUN)] },
    });
    const verdict = await createGithubActionsAdapter(t.run).verify(input());
    expect(verdict.ok).toBe(false);
    expect(reasonOf(verdict)).toContain(`names another run ${OTHER_RUN}`);
    expect(reasonOf(verdict)).not.toContain('no successful status');
  });

  test('NEGATIVE A1b: a structured workflow_run naming another run is refused', async () => {
    const t = transport({
      deployments: [deployment({ workflow_run: { id: Number(OTHER_RUN) } })],
      statuses: { '900': [successStatus(RUN)] },
    });
    const verdict = await createGithubActionsAdapter(t.run).verify(input());
    expect(verdict.ok).toBe(false);
    expect(reasonOf(verdict)).toContain(`names another run ${OTHER_RUN}`);
  });

  test('NEGATIVE A1c: a status that names another run is refused even when the record names this run', async () => {
    const t = transport({
      deployments: [deployment({ payload: { run_id: Number(RUN) } })],
      statuses: { '900': [successStatus(OTHER_RUN)] },
    });
    const verdict = await createGithubActionsAdapter(t.run).verify(input());
    expect(verdict.ok).toBe(false);
    expect(reasonOf(verdict)).toContain(`names another run ${OTHER_RUN}`);
  });

  test('NEGATIVE A2: a bare number in a status description is not a run link', async () => {
    // The A2 hole: free text is caller-writable, so `description: '100'` must not be read as a link to run 100.
    const t = transport({
      deployments: [deployment()],
      statuses: { '900': [successStatus(RUN, { log_url: null, target_url: null, environment_url: null, description: RUN })] },
    });
    const verdict = await createGithubActionsAdapter(t.run).verify(input());
    expect(verdict.ok).toBe(false);
    expect(reasonOf(verdict)).toContain('has no successful status for run 100');
  });

  test('NEGATIVE A2b: a bare number in the record\'s free text is neither a link nor a contradiction', async () => {
    // Neither proof nor contradiction: the deployment fails for lack of a link, and the prose number names no run.
    const noLink = transport({
      deployments: [deployment({ task: RUN })],
      statuses: { '900': [successStatus(RUN, { log_url: null, target_url: null, environment_url: null })] },
    });
    const refused = await createGithubActionsAdapter(noLink.run).verify(input());
    expect(refused.ok).toBe(false);
    expect(reasonOf(refused)).toContain(`has no successful status for run ${RUN}`);
    // A prose mention of another number is not read as a run reference, so a correct status link still passes.
    const prose = transport({
      deployments: [deployment({ description: `deployment ${OTHER_RUN} refreshed` })],
      statuses: { '900': [successStatus(RUN)] },
    });
    const verdict = await createGithubActionsAdapter(prose.run).verify(input());
    expect(verdict.ok).toBe(true);
  });

  test('NEGATIVE B: a trusted workflow still cannot borrow another run\'s deployment', async () => {
    // The product's counter-example, with the workflow made trusted: the run link is what stops the borrow.
    const t = transport({
      workflowName: TRUSTED,
      deployments: [deployment({ payload: { run_id: OTHER_RUN, note: 'different workflow run; deployment failed' } })],
      statuses: { '900': [successStatus(OTHER_RUN, { state: 'failure' })] },
    });
    const verdict = await createGithubActionsAdapter(t.run).verify(input());
    expect(verdict.ok).toBe(false);
    expect(reasonOf(verdict)).toMatch(new RegExp(`names another run|does not reference the evidence run|no successful status`));
  });

  test('NEGATIVE B2: a deployment of this run whose status is a failure is refused', async () => {
    const t = transport({
      deployments: [deployment()],
      statuses: { '900': [successStatus(RUN, { state: 'failure' })] },
    });
    const verdict = await createGithubActionsAdapter(t.run).verify(input());
    expect(verdict.ok).toBe(false);
    expect(reasonOf(verdict)).toContain('no successful status');
  });

  test('NEGATIVE B3: a deployment of this run with a pending/in_progress status is refused', async () => {
    const t = transport({
      deployments: [deployment()],
      statuses: { '900': [successStatus(RUN, { state: 'in_progress' })] },
    });
    const verdict = await createGithubActionsAdapter(t.run).verify(input());
    expect(verdict.ok).toBe(false);
    expect(reasonOf(verdict)).toContain('no successful status');
  });

  test('NEGATIVE B3b: a status with an unknown state is refused', async () => {
    const t = transport({
      deployments: [deployment()],
      statuses: { '900': [successStatus(RUN, { state: null })] },
    });
    const verdict = await createGithubActionsAdapter(t.run).verify(input());
    expect(verdict.ok).toBe(false);
    expect(reasonOf(verdict)).toContain('no successful status');
  });

  test('NEGATIVE B3c: a success status older than the deployment is refused', async () => {
    const t = transport({
      deployments: [deployment()],
      statuses: { '900': [successStatus(RUN, { created_at: '2026-10-21T22:00:00Z' })] },
    });
    const verdict = await createGithubActionsAdapter(t.run).verify(input());
    expect(verdict.ok).toBe(false);
    expect(reasonOf(verdict)).toContain('predates the deployment');
  });

  test('NEGATIVE B4: a deployment with no status at all is refused', async () => {
    const t = transport({ deployments: [deployment()], statuses: { '900': [] } });
    const verdict = await createGithubActionsAdapter(t.run).verify(input());
    expect(verdict.ok).toBe(false);
    expect(reasonOf(verdict)).toContain('no status');
  });

  test('NEGATIVE C: a deployment without a sha is unknown, not a wildcard', async () => {
    const t = transport({
      deployments: [deployment({ sha: undefined })],
      statuses: { '900': [successStatus(RUN)] },
    });
    const verdict = await createGithubActionsAdapter(t.run).verify(input());
    expect(verdict.ok).toBe(false);
    expect(reasonOf(verdict)).toContain('no sha');
  });

  test('NEGATIVE C2: a deployment of another head is refused', async () => {
    const t = transport({
      deployments: [deployment({ sha: 'other-head' })],
      statuses: { '900': [successStatus(RUN)] },
    });
    const verdict = await createGithubActionsAdapter(t.run).verify(input());
    expect(verdict.ok).toBe(false);
    expect(reasonOf(verdict)).toContain('another head');
  });

  test('NEGATIVE C3: a deployment of another environment is refused', async () => {
    const t = transport({
      deployments: [deployment({ environment: 'staging' })],
      statuses: { '900': [successStatus(RUN)] },
    });
    const verdict = await createGithubActionsAdapter(t.run).verify(input());
    expect(verdict.ok).toBe(false);
    expect(reasonOf(verdict)).toContain('another environment');
  });

  test('NEGATIVE C4: a deployment outside the run window is refused', async () => {
    const t = transport({
      deployments: [deployment({ created_at: '2026-10-21T23:05:00Z' })],
      statuses: { '900': [successStatus(RUN)] },
    });
    const verdict = await createGithubActionsAdapter(t.run).verify(input());
    expect(verdict.ok).toBe(false);
    expect(reasonOf(verdict)).toContain('outside the CI run window');
  });

  test('NEGATIVE D: a failed run cannot certify anything', async () => {
    const t = transport({
      conclusion: 'failure',
      deployments: [deployment()],
      statuses: { '900': [successStatus(RUN)] },
    });
    const verdict = await createGithubActionsAdapter(t.run).verify(input());
    expect(verdict.ok).toBe(false);
  });

  test('NEGATIVE E: an unreadable deployment list fails closed', async () => {
    const t = transport({ deploymentsError: 'HTTP 503' });
    const verdict = await createGithubActionsAdapter(t.run).verify(input());
    expect(verdict.ok).toBe(false);
    expect(reasonOf(verdict)).toContain('could not be verified');
  });

  test('NEGATIVE E2: an unreadable status list fails closed (no silent success)', async () => {
    const t = transport({ deployments: [deployment()], statusesError: 'HTTP 500' });
    const verdict = await createGithubActionsAdapter(t.run).verify(input());
    expect(verdict.ok).toBe(false);
    expect(reasonOf(verdict)).toContain('statuses could not be read');
  });

  test('NEGATIVE F: a statuses url of another repository is never read', async () => {
    const t = transport({
      deployments: [deployment({ statuses_url: 'https://api.github.com/repos/other/repo/deployments/900/statuses' })],
      statuses: { '900': [successStatus(RUN)] },
    });
    const verdict = await createGithubActionsAdapter(t.run).verify(input());
    expect(verdict.ok).toBe(false);
    expect(reasonOf(verdict)).toContain('another repository');
  });

  test('NEGATIVE A5a: a named job that belongs to another run is refused', async () => {
    // The job axis: the status link says job 4242, the repository says job 4242 belongs to run 999. Same downstream
    // symptom as a borrowed run link, so the job must participate in the decision.
    const t = transport({
      deployments: [deployment()],
      statuses: { '900': [successStatus(RUN)] },
      jobs: { '4242': { runId: OTHER_RUN, headSha: SHA } },
    });
    const verdict = await createGithubActionsAdapter(t.run).verify(input());
    expect(verdict.ok).toBe(false);
    expect(reasonOf(verdict)).toContain(`job 4242 belongs to run ${OTHER_RUN}, not run ${RUN}`);
  });

  test('NEGATIVE A5b: a named job from another head is refused', async () => {
    const t = transport({
      deployments: [deployment()],
      statuses: { '900': [successStatus(RUN)] },
      jobs: { '4242': { runId: RUN, headSha: 'other-head' } },
    });
    const verdict = await createGithubActionsAdapter(t.run).verify(input());
    expect(verdict.ok).toBe(false);
    expect(reasonOf(verdict)).toContain('is not from head');
  });

  test('NEGATIVE A5c: a named job that cannot be read fails closed', async () => {
    const t = transport({ deployments: [deployment()], statuses: { '900': [successStatus(RUN)] }, jobsError: 'HTTP 503' });
    const verdict = await createGithubActionsAdapter(t.run).verify(input());
    expect(verdict.ok).toBe(false);
    expect(reasonOf(verdict)).toContain('job 4242 could not be read');
  });

  test('NEGATIVE A5d: an unknown job id fails closed (a 404 is never a pass)', async () => {
    const t = transport({
      deployments: [deployment({ payload: { job_id: 5555 } })],
      statuses: { '900': [successStatus(RUN, { log_url: null, target_url: null })] },
    });
    const verdict = await createGithubActionsAdapter(t.run).verify(input());
    expect(verdict.ok).toBe(false);
    expect(reasonOf(verdict)).toContain('job 5555 could not be read');
  });

  test('NEGATIVE A5e: a job of another run named by the record is refused', async () => {
    const t = transport({
      deployments: [deployment({ payload: { deployment_job_id: 7777 } })],
      statuses: { '900': [successStatus(RUN, { log_url: null, target_url: null })] },
      jobs: { '7777': { runId: OTHER_RUN, headSha: SHA } },
    });
    const verdict = await createGithubActionsAdapter(t.run).verify(input());
    expect(verdict.ok).toBe(false);
    expect(reasonOf(verdict)).toContain(`job 7777 belongs to run ${OTHER_RUN}`);
  });

  test('GENERIC CI: a criterion that declares no environment keeps no environment fact', async () => {
    const t = transport({ deployments: [deployment()], statuses: { '900': [successStatus(RUN)] } });
    const verdict = await createGithubActionsAdapter(t.run).verify(input({ environment: undefined }));
    expect(verdict.ok).toBe(true);
    expect((verdict as { environment?: string }).environment).toBeUndefined();
    // A generic CI proof never reads deployments at all.
    expect(t.calls.filter(c => c.join(' ').includes('/deployments')).length).toBe(0);
  });
});