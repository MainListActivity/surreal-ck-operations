// SYS02 N1-R: the source association between an evidence run and the deployment that certifies the environment.
//
// These cases drive the REAL createGithubActionsAdapter (only its gh transport is stubbed), so they exercise the
// production algorithm, not a fake. The trust boundary has two independent axes:
//   A. authorization — only a trusted deployment workflow may certify an environment;
//   B. causation    — the deployment and its success status must name the evidence run.
// A borrowed deployment must fail on B even when the workflow would have been trusted.
import { describe, expect, test } from 'bun:test';
import { createGithubActionsAdapter } from '../src/acceptance.ts';

const SHA = '7d17cfaeb30ec26b07ab82a0c0b24bed58ae4298';
const RUN = '100';
const OTHER_RUN = '999';
const TRUSTED = 'Deploy production';
const UNTRUSTED = 'Quality gate';
const RUN_URL = `https://github.com/o/r/actions/runs/${RUN}`;

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

/** The gh transport stub: run view, deployments list, deployment statuses. */
const transport = (opts: {
  workflowName?: string;
  conclusion?: string;
  deployments?: Dep[];
  statuses?: Record<string, Status[]>;
  deploymentsError?: string;
}) => {
  const calls: string[][] = [];
  const run = async (args: string[]) => {
    calls.push(args);
    if (args[0] === 'run' && args[1] === 'view') {
      return JSON.stringify({
        headSha: SHA, status: 'completed', conclusion: opts.conclusion ?? 'success',
        workflowName: opts.workflowName ?? TRUSTED,
        createdAt: '2026-10-21T23:00:00Z', updatedAt: '2026-10-21T23:02:00Z',
      });
    }
    if (args[0] === 'api' && String(args[1]).includes('/deployments?')) {
      if (opts.deploymentsError) throw new Error(opts.deploymentsError);
      return JSON.stringify(opts.deployments ?? []);
    }
    if (args[0] === 'api' && String(args[1]).includes('/statuses')) {
      const id = /\/deployments\/(\d+)\/statuses/.exec(String(args[1]))?.[1] ?? '';
      return JSON.stringify(opts.statuses?.[id] ?? []);
    }
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  return { run, calls };
};

const input = (over: Record<string, unknown> = {}) => ({
  provider: 'github-actions' as const, runUrl: RUN_URL, sha: SHA, environment: 'production', verify: 'deploy-run', ...over,
});

describe('N1-R: the deployment source association', () => {
  test('POSITIVE: a trusted workflow whose deployment status names this run certifies the environment', async () => {
    const t = transport({
      deployments: [deployment()],
      statuses: { '900': [successStatus(RUN)] },
    });
    const verdict = await createGithubActionsAdapter(t.run).verify(input());
    expect(verdict).toMatchObject({ ok: true, environment: 'production' });
    // The source keeps the traceable identifiers, not just the environment string.
    const source = (verdict as { source: Record<string, unknown> }).source;
    expect(source).toMatchObject({ runId: RUN, workflowName: TRUSTED, environment: 'production' });
    expect(source.deployment).toMatchObject({ deploymentId: '900', status: 'success', deploymentRunId: RUN });
    // The deployment's status list was actually read (the product's log recorded statusReads=0 as the defect).
    expect(t.calls.filter(c => c.join(' ').includes('/statuses')).length).toBe(1);
  });

  test('NEGATIVE A: a generic CI workflow cannot certify an environment', async () => {
    const t = transport({
      workflowName: UNTRUSTED,
      deployments: [deployment()],
      statuses: { '900': [successStatus(RUN)] },
    });
    const verdict = await createGithubActionsAdapter(t.run).verify(input());
    expect(verdict.ok).toBe(false);
    expect(String((verdict as { reason: string }).reason)).toContain('not trusted');
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
    expect(String((verdict as { reason: string }).reason)).toMatch(/does not reference the evidence run|no successful status/);
  });

  test('NEGATIVE B2: a deployment of this run whose status is a failure is refused', async () => {
    const t = transport({
      deployments: [deployment()],
      statuses: { '900': [successStatus(RUN, { state: 'failure' })] },
    });
    const verdict = await createGithubActionsAdapter(t.run).verify(input());
    expect(verdict.ok).toBe(false);
    expect(String((verdict as { reason: string }).reason)).toContain('no successful status');
  });

  test('NEGATIVE B3: a deployment of this run with a pending/in_progress status is refused', async () => {
    const t = transport({
      deployments: [deployment()],
      statuses: { '900': [successStatus(RUN, { state: 'in_progress' })] },
    });
    const verdict = await createGithubActionsAdapter(t.run).verify(input());
    expect(verdict.ok).toBe(false);
  });

  test('NEGATIVE B4: a deployment with no status at all is refused', async () => {
    const t = transport({ deployments: [deployment()], statuses: { '900': [] } });
    const verdict = await createGithubActionsAdapter(t.run).verify(input());
    expect(verdict.ok).toBe(false);
    expect(String((verdict as { reason: string }).reason)).toContain('no status');
  });

  test('NEGATIVE C: a deployment without a sha is unknown, not a wildcard', async () => {
    const t = transport({
      deployments: [deployment({ sha: undefined })],
      statuses: { '900': [successStatus(RUN)] },
    });
    const verdict = await createGithubActionsAdapter(t.run).verify(input());
    expect(verdict.ok).toBe(false);
    expect(String((verdict as { reason: string }).reason)).toContain('no sha');
  });

  test('NEGATIVE C2: a deployment of another head is refused', async () => {
    const t = transport({
      deployments: [deployment({ sha: 'other-head' })],
      statuses: { '900': [successStatus(RUN)] },
    });
    const verdict = await createGithubActionsAdapter(t.run).verify(input());
    expect(verdict.ok).toBe(false);
    expect(String((verdict as { reason: string }).reason)).toContain('another head');
  });

  test('NEGATIVE C3: a deployment of another environment is refused', async () => {
    const t = transport({
      deployments: [deployment({ environment: 'staging' })],
      statuses: { '900': [successStatus(RUN)] },
    });
    const verdict = await createGithubActionsAdapter(t.run).verify(input());
    expect(verdict.ok).toBe(false);
    expect(String((verdict as { reason: string }).reason)).toContain('another environment');
  });

  test('NEGATIVE C4: a deployment outside the run window is refused', async () => {
    const t = transport({
      deployments: [deployment({ created_at: '2026-10-21T23:05:00Z' })],
      statuses: { '900': [successStatus(RUN)] },
    });
    const verdict = await createGithubActionsAdapter(t.run).verify(input());
    expect(verdict.ok).toBe(false);
    expect(String((verdict as { reason: string }).reason)).toContain('outside the CI run window');
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
    expect(String((verdict as { reason: string }).reason)).toContain('could not be verified');
  });

  test('NEGATIVE E2: an unreadable status list fails closed (no silent success)', async () => {
    const run = async (args: string[]) => {
      if (args[0] === 'run' && args[1] === 'view') {
        return JSON.stringify({ headSha: SHA, status: 'completed', conclusion: 'success', workflowName: TRUSTED, createdAt: '2026-10-21T23:00:00Z', updatedAt: '2026-10-21T23:02:00Z' });
      }
      if (args[0] === 'api' && String(args[1]).includes('/deployments?')) return JSON.stringify([deployment()]);
      if (args[0] === 'api' && String(args[1]).includes('/statuses')) throw new Error('HTTP 500');
      throw new Error(`unexpected gh ${args.join(' ')}`);
    };
    const verdict = await createGithubActionsAdapter(run).verify(input());
    expect(verdict.ok).toBe(false);
    expect(String((verdict as { reason: string }).reason)).toContain('statuses could not be read');
  });

  test('NEGATIVE F: a statuses url of another repository is never read', async () => {
    const t = transport({
      deployments: [deployment({ statuses_url: 'https://api.github.com/repos/other/repo/deployments/900/statuses' })],
      statuses: { '900': [successStatus(RUN)] },
    });
    const verdict = await createGithubActionsAdapter(t.run).verify(input());
    expect(verdict.ok).toBe(false);
    expect(String((verdict as { reason: string }).reason)).toContain('another repository');
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
