/**
 * Read-only release diagnosis for the CK pipeline (roadmap M3).
 *
 * It answers one question from facts that can be re-checked by hand: for this exact commit, what did the GitHub
 * Actions checks and deployment stages do, and does the live public release say it is running that commit? It never
 * reads logs, never treats a successful workflow (or a skipped stage) as a deployment, and never infers a root cause
 * from a failed stage.
 *
 * The caller supplies only the already-authorized repository, commit and runtime-version URL. No vendor argument is
 * a repository, host, URL, command or credential, and every GitHub call is a fixed read-only `gh api`/`gh run view`.
 */
import { CompanyError } from '../core-errors.ts';
import { trustedDeploymentWorkflows } from '../deployment-source.ts';
import type { GhRunner } from '../pr-gate.ts';
import type { Fetcher } from './fetcher.ts';

/** The public artifact the CK web deployment writes; fixed on the environment's public origin. */
export const RELEASE_RUNTIME_VERSION_PATH = '/runtime-version.json';
const FULL_SHA = /^[a-f0-9]{40}$/;
const DEPLOYMENT_ID = /^(\d+)-(\d+)$/;
const FAILED_CONCLUSIONS = new Set(['failure', 'error', 'cancelled', 'timed_out', 'startup_failure', 'action_required']);
const MAX_RUNS = 12;
const MAX_ATTEMPTS = 3;

export interface StageReport {
  name: string;
  status?: string;
  conclusion?: string;
  startedAt?: string;
  completedAt?: string;
  url?: string;
  /** The first failed step, when the job reports one. The step body is never read. */
  failedStep?: string;
}

export interface AttemptReport {
  attempt: number;
  conclusion?: string;
  /** True when this attempt's jobs were read back. A missing read is unknown, never success. */
  read: boolean;
  stages: StageReport[];
  failedStage?: string;
  failedStep?: string;
  failedAt?: string;
  skippedStages: string[];
}

export interface RunReport {
  id: string;
  workflow: string;
  event?: string;
  status?: string;
  conclusion?: string;
  attempt: number;
  createdAt?: string;
  updatedAt?: string;
  url?: string;
  headSha?: string;
  headMatches: boolean;
  deployWorkflow: boolean;
  attempts: AttemptReport[];
}

export interface GithubReleaseRead {
  repo: string;
  sha: string;
  runs: RunReport[];
  /** True when more runs matched than were read; the caller never guesses the rest. */
  truncated: boolean;
}

export interface PublicRuntimeVersion {
  state: 'known' | 'unknown';
  url: string;
  checkedAt: string;
  sha?: string;
  deploymentId?: string;
  deploymentRunId?: string;
  deploymentAttempt?: number;
  reason?: string;
}

export interface OriginEvidence {
  configured: boolean;
  /** Always unknown: status/health are liveness, not a release identity. */
  state: 'unknown';
  reason: string;
  reachable: boolean | null;
  reads: { status: 'ok' | 'unavailable' | 'skipped'; health: 'ok' | 'unavailable' | 'skipped' };
  services?: Record<string, unknown>;
  checks?: Record<string, unknown>;
  errors?: { status?: string; health?: string };
  checkedAt: string;
}

export type ReleaseStatus =
  | 'deployed' | 'ci_failed' | 'deploy_failed' | 'deploy_skipped' | 'not_deployed' | 'in_progress' | 'unknown';

export interface ReleaseDiagnosisReport {
  repo: string;
  sha: string;
  checkedAt: string;
  status: ReleaseStatus;
  ci: {
    state: 'success' | 'failed' | 'running' | 'missing' | 'unknown';
    failedStage?: string;
    failedStep?: string;
    failedAt?: string;
    runs: RunReport[];
  };
  deploy: {
    state: 'verified' | 'failed' | 'skipped' | 'not_deployed' | 'unknown' | 'missing' | 'running';
    reason?: string;
    failedStage?: string;
    failedStep?: string;
    failedAt?: string;
    skippedStages: string[];
    verifiedRun?: { id: string; attempt: number; url?: string };
    runs: RunReport[];
  };
  runtimeVersion: PublicRuntimeVersion & { matchesTarget?: boolean };
  origin: OriginEvidence;
  links: { runs: string[]; jobs: string[]; runtimeVersion: string };
  /** Explicit limits so a reader cannot mistake a partial read for a full or causal one. */
  limits: { readOnly: true; logsRead: false; rootCause: 'not_inferred'; runsTruncated: boolean; ignoredHeadRuns: number };
}

interface ApiRun {
  id?: number | string;
  head_sha?: string;
  status?: string;
  conclusion?: string | null;
  run_attempt?: number;
  html_url?: string;
  created_at?: string;
  updated_at?: string;
  event?: string;
}

interface RunView {
  headSha?: string;
  status?: string;
  conclusion?: string | null;
  workflowName?: string;
  createdAt?: string;
  updatedAt?: string;
  url?: string;
  event?: string;
}

interface ApiJob {
  name?: string;
  status?: string;
  conclusion?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  html_url?: string;
  steps?: Array<{ name?: string; status?: string; conclusion?: string | null }>;
}

const invalid = (message: string) => new CompanyError('invalid', message);

function shortFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, ' ').slice(0, 120) || 'unknown failure';
}

async function githubJson(run: GhRunner, path: string, what: string): Promise<unknown> {
  try {
    return JSON.parse(await run(['api', path]));
  } catch (error) {
    throw new CompanyError('upstream_error', `${what} could not be read from GitHub (${shortFailure(error)})`, true);
  }
}

const isFailed = (conclusion: string | null | undefined): boolean => FAILED_CONCLUSIONS.has((conclusion ?? '').toLowerCase());

function attemptConclusion(stages: StageReport[], read: boolean): string | undefined {
  if (!read) return undefined;
  if (stages.some(stage => isFailed(stage.conclusion))) return 'failure';
  if (stages.some(stage => (stage.status ?? 'completed') !== 'completed')) return undefined;
  if (stages.length && stages.every(stage => stage.conclusion === 'skipped')) return 'skipped';
  if (stages.length && stages.every(stage => stage.conclusion === 'success' || stage.conclusion === 'skipped')) return 'success';
  return undefined;
}

function stageOf(job: ApiJob): StageReport {
  const steps = Array.isArray(job.steps) ? job.steps : [];
  const failed = steps.find(step => isFailed(step.conclusion));
  return {
    name: typeof job.name === 'string' && job.name ? job.name : '?',
    ...(job.status ? { status: job.status } : {}),
    ...(job.conclusion ? { conclusion: job.conclusion } : {}),
    ...(job.started_at ? { startedAt: job.started_at } : {}),
    ...(job.completed_at ? { completedAt: job.completed_at } : {}),
    ...(job.html_url ? { url: job.html_url } : {}),
    ...(failed?.name ? { failedStep: failed.name } : {}),
  };
}

function attemptOf(attempt: number, jobs: ApiJob[], read: boolean): AttemptReport {
  const stages = jobs.map(stageOf);
  const failed = stages.find(stage => isFailed(stage.conclusion));
  const conclusion = attemptConclusion(stages, read);
  return {
    attempt,
    ...(conclusion ? { conclusion } : {}),
    read,
    stages,
    ...(failed ? { failedStage: failed.name } : {}),
    ...(failed?.failedStep ? { failedStep: failed.failedStep } : {}),
    ...(failed ? { failedAt: failed.completedAt ?? failed.startedAt } : {}),
    skippedStages: stages.filter(stage => stage.conclusion === 'skipped').map(stage => stage.name),
  };
}

/** The attempt a run's own state reports; earlier attempts are history. */
export function latestAttempt(run: RunReport): AttemptReport | undefined {
  return run.attempts.find(attempt => attempt.attempt === run.attempt) ?? run.attempts.at(-1);
}

/**
 * Reads every workflow run for one commit and the per-attempt jobs/stages of each. Fixed `gh` reads only: no PRs,
 * no logs, no artifacts, no caller-supplied URL or repository.
 */
export async function readGithubRelease(repo: string, sha: string, run: GhRunner): Promise<GithubReleaseRead> {
  if (!FULL_SHA.test(sha)) throw invalid('sha must be a full 40-character lowercase commit id');
  const listed = await githubJson(run, `repos/${repo}/actions/runs?head_sha=${sha}&per_page=50`, 'the workflow runs') as
    { workflow_runs?: unknown };
  const all = Array.isArray(listed.workflow_runs) ? (listed.workflow_runs as ApiRun[]) : [];
  const ordered = all
    .filter(item => item && item.id !== undefined && item.id !== null)
    .sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')) || Number(a.id) - Number(b.id));
  const picked = ordered.slice(0, MAX_RUNS);

  const runs: RunReport[] = [];
  for (const item of picked) {
    const id = String(item.id);
    let view: RunView;
    try {
      view = JSON.parse(await run(['run', 'view', id, '--repo', repo,
        '--json', 'headSha,status,conclusion,workflowName,createdAt,updatedAt,url,event'])) as RunView;
    } catch (error) {
      throw new CompanyError('upstream_error', `workflow run ${id} could not be read from GitHub (${shortFailure(error)})`, true);
    }
    const headSha = view.headSha ?? item.head_sha;
    const reportedAttempt = Math.max(1, Number(item.run_attempt ?? 1));
    const firstAttempt = Math.max(1, reportedAttempt - MAX_ATTEMPTS + 1);
    const attempts: AttemptReport[] = [];
    for (let attempt = firstAttempt; attempt <= reportedAttempt; attempt++) {
      let jobs: ApiJob[] = [];
      let read = true;
      try {
        const payload = await githubJson(run, `repos/${repo}/actions/runs/${id}/attempts/${attempt}/jobs?per_page=50`,
          `the jobs of workflow run ${id} attempt ${attempt}`) as { jobs?: unknown };
        jobs = Array.isArray(payload.jobs) ? (payload.jobs as ApiJob[]) : [];
      } catch {
        read = false;
      }
      attempts.push(attemptOf(attempt, jobs, read));
    }
    const workflow = view.workflowName ?? '';
    runs.push({
      id,
      workflow,
      ...(view.event ?? item.event ? { event: view.event ?? item.event } : {}),
      ...(view.status ?? item.status ? { status: view.status ?? item.status } : {}),
      ...(view.conclusion ?? item.conclusion ? { conclusion: view.conclusion ?? item.conclusion ?? undefined } : {}),
      attempt: reportedAttempt,
      ...(view.createdAt ?? item.created_at ? { createdAt: view.createdAt ?? item.created_at } : {}),
      ...(view.updatedAt ?? item.updated_at ? { updatedAt: view.updatedAt ?? item.updated_at } : {}),
      ...(view.url ?? item.html_url ? { url: view.url ?? item.html_url } : {}),
      ...(headSha ? { headSha } : {}),
      headMatches: headSha === sha,
      deployWorkflow: workflow !== '' && trustedDeploymentWorkflows().includes(workflow),
      attempts,
    });
  }
  return { repo, sha, runs, truncated: ordered.length > picked.length };
}

/** Reads the public runtime-version artifact. Any doubt (network, shape, a different content type) is explicitly unknown. */
export async function readPublicRuntimeVersion(input: {
  url: string; fetch: Fetcher; now: () => number;
}): Promise<PublicRuntimeVersion> {
  const checkedAt = new Date(input.now()).toISOString();
  const unknown = (reason: string): PublicRuntimeVersion => ({ state: 'unknown', url: input.url, checkedAt, reason });
  let response: Response;
  try {
    response = await input.fetch(input.url, {
      redirect: 'error', cache: 'no-store', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8_000),
    });
  } catch (error) {
    return unknown(`the public runtime-version artifact was unreachable (${(error as Error).name || 'network error'})`);
  }
  if (!response.ok) return unknown(`the public runtime-version artifact answered HTTP ${response.status}`);
  if (!(response.headers.get('content-type') ?? '').includes('application/json')) {
    return unknown('the public runtime-version artifact is not JSON');
  }
  let body: unknown;
  try {
    body = JSON.parse((await response.text()).slice(0, 4_096));
  } catch {
    return unknown('the public runtime-version artifact is not valid JSON');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return unknown('the public runtime-version artifact has no object body');
  const fields = body as Record<string, unknown>;
  const sha = typeof fields.sha === 'string' ? fields.sha : '';
  const deploymentId = typeof fields.deploymentId === 'string' ? fields.deploymentId : '';
  const deployment = DEPLOYMENT_ID.exec(deploymentId);
  if (!FULL_SHA.test(sha) || !deployment) return unknown('the public runtime-version artifact does not name a commit and deployment');
  return {
    state: 'known', url: input.url, checkedAt, sha, deploymentId,
    deploymentRunId: deployment[1]!, deploymentAttempt: Number(deployment[2]),
  };
}

/**
 * The origin host's restricted status/health. It says whether the host and its services answer; it carries no release
 * identity, so the release state stays unknown even when every probe succeeds.
 */
export function originEvidence(input: {
  configured: boolean;
  status?: Record<string, unknown>;
  health?: Record<string, unknown>;
  statusError?: string;
  healthError?: string;
  now: () => number;
}): OriginEvidence {
  const checkedAt = new Date(input.now()).toISOString();
  if (!input.configured) {
    return {
      configured: false, state: 'unknown', reason: 'this environment has no origin host configured', reachable: null,
      reads: { status: 'skipped', health: 'skipped' }, checkedAt,
    };
  }
  const services = input.status && typeof input.status.services === 'object' && input.status.services !== null
    ? (input.status.services as Record<string, unknown>) : undefined;
  const rawChecks = input.health && typeof input.health.checks === 'object' && input.health.checks !== null
    ? (input.health.checks as Record<string, unknown>) : undefined;
  const checks = rawChecks === undefined ? undefined : Object.fromEntries(Object.entries(rawChecks).map(([name, value]) => {
    const item = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
    return [name, { reachable: item.reachable === true, ...(typeof item.status === 'number' ? { status: item.status } : {}) }];
  }));
  const reachableChecks = checks ? Object.values(checks).filter(item => (item as { reachable?: boolean }).reachable === true).length : 0;
  return {
    configured: true,
    state: 'unknown',
    reason: 'origin status and health report liveness only; they do not expose the running release identity',
    reachable: checks ? reachableChecks > 0 : null,
    reads: {
      status: input.status ? 'ok' : 'unavailable',
      health: input.health ? 'ok' : 'unavailable',
    },
    ...(services ? { services } : {}),
    ...(checks ? { checks } : {}),
    ...(input.statusError || input.healthError
      ? { errors: { ...(input.statusError ? { status: input.statusError } : {}), ...(input.healthError ? { health: input.healthError } : {}) } }
      : {}),
    checkedAt,
  };
}

/** Pure decision over the facts above. Workflow success alone, and a skipped stage, are never a deployment. */
export function summarizeRelease(input: {
  repo: string; sha: string; github: GithubReleaseRead; runtime: PublicRuntimeVersion; origin: OriginEvidence; now: () => number;
}): ReleaseDiagnosisReport {
  const { repo, sha, github, runtime, origin } = input;
  const usable = github.runs.filter(run => run.headMatches);
  const ciRuns = usable.filter(run => !run.deployWorkflow);
  const deployRuns = usable.filter(run => run.deployWorkflow);
  const latest = (run: RunReport): AttemptReport | undefined => latestAttempt(run);
  const latestByRun = (runs: RunReport[]) => runs.map(run => ({ run, attempt: latest(run) })).filter(item => item.attempt !== undefined) as
    Array<{ run: RunReport; attempt: AttemptReport }>;

  const ciLatest = latestByRun(ciRuns);
  const ciFailed = ciLatest.find(item => item.attempt.conclusion === 'failure' || item.attempt.failedStage !== undefined || item.run.conclusion === 'failure');
  const ciRunning = ciRuns.some(run => (run.status ?? '') !== 'completed') || ciLatest.some(item => item.attempt.conclusion === undefined && item.attempt.read);
  const ciState: ReleaseDiagnosisReport['ci']['state'] = ciFailed ? 'failed'
    : ciRunning ? 'running'
    : ciLatest.some(item => item.attempt.conclusion === 'success') ? 'success'
    : ciRuns.length ? 'unknown' : 'missing';
  const ci = {
    state: ciState,
    ...(ciFailed ? {
      failedStage: ciFailed.attempt.failedStage,
      ...(ciFailed.attempt.failedStep ? { failedStep: ciFailed.attempt.failedStep } : {}),
      ...(ciFailed.attempt.failedAt ?? ciFailed.run.updatedAt ? { failedAt: ciFailed.attempt.failedAt ?? ciFailed.run.updatedAt } : {}),
    } : {}),
    runs: ciRuns,
  } as ReleaseDiagnosisReport['ci'];

  const deployLatest = latestByRun(deployRuns);
  const verified = (() => {
    if (runtime.state !== 'known' || runtime.sha !== sha || !runtime.deploymentRunId) return undefined;
    const candidate = deployRuns.find(run => run.id === runtime.deploymentRunId);
    const attempt = candidate?.attempts.find(item => item.attempt === runtime.deploymentAttempt);
    if (!candidate || !attempt || !attempt.read) return undefined;
    // Every deployment stage must have concluded success: a skipped stage deployed nothing.
    if (!attempt.stages.length || attempt.stages.some(stage => stage.conclusion !== 'success')) return undefined;
    if (attempt.conclusion !== 'success') return undefined;
    return { run: candidate, attempt };
  })();

  const failed = deployLatest.find(item => item.attempt.conclusion === 'failure' || item.attempt.failedStage !== undefined || item.run.conclusion === 'failure');
  const deployRunning = deployRuns.some(run => (run.status ?? '') !== 'completed')
    || deployLatest.some(item => item.attempt.stages.some(stage => (stage.status ?? 'completed') !== 'completed'));
  const skippedStages = [...new Set(deployLatest.flatMap(item => item.attempt.skippedStages))];
  const allSkipped = deployLatest.length > 0 && deployLatest.every(item =>
    item.attempt.stages.length > 0 && item.attempt.stages.every(stage => stage.conclusion === 'skipped' || stage.conclusion === 'success')
    && item.attempt.stages.some(stage => stage.conclusion === 'skipped'));

  const deploy: ReleaseDiagnosisReport['deploy'] = verified
    ? {
      state: 'verified', skippedStages: verified.attempt.skippedStages,
      verifiedRun: { id: verified.run.id, attempt: verified.attempt.attempt, ...(verified.run.url ? { url: verified.run.url } : {}) },
      runs: deployRuns,
    }
    : failed
      ? {
        state: 'failed', skippedStages,
        ...(failed.attempt.failedStage ? { failedStage: failed.attempt.failedStage } : {}),
        ...(failed.attempt.failedStep ? { failedStep: failed.attempt.failedStep } : {}),
        ...(failed.attempt.failedAt ?? failed.run.updatedAt ? { failedAt: failed.attempt.failedAt ?? failed.run.updatedAt } : {}),
        runs: deployRuns,
      }
      : runtime.state === 'known' && runtime.sha !== sha
        ? { state: 'not_deployed', skippedStages, reason: `the public runtime version reports commit ${runtime.sha}, not ${sha}`, runs: deployRuns }
        : allSkipped
          ? { state: 'skipped', skippedStages, reason: 'every deployment stage was skipped; workflow success is not a deployment', runs: deployRuns }
          : deployRunning
            ? { state: 'running', skippedStages, runs: deployRuns }
            : deployRuns.length
              ? {
                state: 'unknown', skippedStages,
                reason: runtime.state === 'unknown'
                  ? `the deployment workflow completed but the live release is unknown: ${runtime.reason ?? 'no public runtime version'}`
                  : 'the deployment workflow completed but no public runtime version names it',
                runs: deployRuns,
              }
              : { state: 'missing', skippedStages: [], runs: deployRuns };

  const status: ReleaseStatus = deploy.state === 'verified' ? 'deployed'
    : ci.state === 'failed' ? 'ci_failed'
    : deploy.state === 'failed' ? 'deploy_failed'
    : ci.state === 'running' || deploy.state === 'running' ? 'in_progress'
    : deploy.state === 'not_deployed' ? 'not_deployed'
    : deploy.state === 'skipped' ? 'deploy_skipped'
    : 'unknown';

  const runs = [...ciRuns, ...deployRuns];
  const links = {
    runs: [...new Set(runs.flatMap(run => (run.url ? [run.url] : [])))],
    jobs: [...new Set(runs.flatMap(run => run.attempts.flatMap(attempt => attempt.stages.flatMap(stage => (stage.url ? [stage.url] : [])))))],
    runtimeVersion: runtime.url,
  };
  return {
    repo, sha, checkedAt: new Date(input.now()).toISOString(), status, ci, deploy,
    runtimeVersion: {
      ...runtime,
      ...(runtime.state === 'known' && runtime.sha !== undefined ? { matchesTarget: runtime.sha === sha } : {}),
    },
    origin, links,
    limits: { readOnly: true, logsRead: false, rootCause: 'not_inferred', runsTruncated: github.truncated, ignoredHeadRuns: github.runs.length - usable.length },
  };
}