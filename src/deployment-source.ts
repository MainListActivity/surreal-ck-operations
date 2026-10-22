/**
 * SYS02 N1-R: the source association between a CI evidence run and the deployment that certified the target
 * environment.
 *
 * Two independent checks, both required:
 *
 *  1. **Authorization** — only a trusted deployment workflow may certify an environment. A generic CI run (a quality
 *     gate, a channel build) proves that the commit builds; it says nothing about what was deployed where.
 *  2. **Causation** — the deployment must be *produced by this run*. GitHub records the producing run in the
 *     deployment's status: `log_url` / `target_url` point at `.../actions/runs/<runId>/job/<jobId>`. The deployment
 *     and its success status must name the evidence run.
 *
 * Why both: "same head, same environment name, close in time" proves nothing — a successful generic CI run and an
 * unrelated failed deployment of the same commit share all three. That was the N1-R hole. The run link is the fact
 * that cannot be borrowed, so a borrowed deployment fails even when its workflow would have been trusted.
 *
 * Everything here is pure: the caller supplies the records it read; the function decides. The caller may not pass in
 * a verdict, a label or a payload it asserts — only raw records.
 */

/** A deployment record as read from `repos/{owner}/{repo}/deployments`. */
export interface DeploymentRecord {
  id?: number | string;
  /** The commit the deployment points at. Missing is *unknown*, never a wildcard. */
  sha?: string | null;
  environment?: string | null;
  original_environment?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  /** The status list of this deployment. */
  statuses_url?: string | null;
  /** Free-form deployment payload. Some integrations put the run reference here. */
  payload?: Record<string, unknown> | null;
  /** GitHub sets this for workflow-backed deployments. */
  workflow_run?: { id?: number | string | null } | null;
  task?: string | null;
  description?: string | null;
  ref?: string | null;
}

/** A deployment status record as read from `repos/{owner}/{repo}/deployments/{id}/statuses`. */
export interface DeploymentStatusRecord {
  state?: string | null;
  environment?: string | null;
  created_at?: string | null;
  /** The log of the deployment; a workflow-backed deployment points at the run that produced it. */
  log_url?: string | null;
  target_url?: string | null;
  environment_url?: string | null;
  description?: string | null;
  deployment_url?: string | null;
}

/** The run the evidence came from, as read from `gh run view`. */
export interface EvidenceRun {
  runId: string;
  headSha?: string | null;
  workflowName?: string | null;
  conclusion?: string | null;
  status?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

/**
 * The workflows allowed to certify a target environment. A run from any other workflow keeps "no environment fact":
 * it may still be a valid generic CI proof, but it never becomes production evidence.
 *
 * These are the real deployment workflow names of the release pipelines this system reads
 * (`Deploy production`, `Deploy origin`, `Deploy origin (manual)`). A new deployment pipeline adds its name here;
 * the check is a list on purpose, so an unvetted workflow cannot certify an environment by accident.
 */
export const TRUSTED_DEPLOYMENT_WORKFLOWS: readonly string[] = [
  'Deploy production',
  'Deploy origin',
  'Deploy origin (manual)',
];

/**
 * The effective trust list: the built-in defaults, plus any workflow named in `SCK_TRUSTED_DEPLOYMENT_WORKFLOWS`
 * (comma separated). The list is additive on purpose: an operator may add a new deployment pipeline, but the
 * built-ins stay, and a workflow that is on neither list certifies nothing. An empty or unreadable variable adds
 * nothing.
 */
export function trustedDeploymentWorkflows(env: Record<string, string | undefined> = process.env): readonly string[] {
  const extra = (env.SCK_TRUSTED_DEPLOYMENT_WORKFLOWS ?? '')
    .split(',')
    .map(name => name.trim())
    .filter(name => name.length > 0);
  return extra.length ? [...TRUSTED_DEPLOYMENT_WORKFLOWS, ...extra] : TRUSTED_DEPLOYMENT_WORKFLOWS;
}

/** The deployment states that count as a successful terminal state. */
export const SUCCESS_DEPLOYMENT_STATES: readonly string[] = ['success', 'active'];

/** The run and job a record points at. */
export interface RunReference {
  runId: string;
  jobId?: string;
}

/** The run ids a value points at, read from every place GitHub may carry it. */
function collectRunIds(value: unknown, into: Set<string>): void {
  if (value === null || value === undefined) return;
  if (typeof value === 'number' && Number.isSafeInteger(value)) { into.add(String(value)); return; }
  if (typeof value === 'string') {
    if (/^\d+$/.test(value)) { into.add(value); return; }
    for (const match of value.matchAll(/\/actions\/runs\/(\d+)/g)) into.add(match[1]!);
  }
}

/** The run a deployment record references, from its payload, its workflow_run and its task/ref/description. */
export function deploymentRunIds(deployment: DeploymentRecord): Set<string> {
  const ids = new Set<string>();
  const payload = deployment.payload;
  if (payload && typeof payload === 'object') {
    for (const key of ['run_id', 'runId', 'deployment_run_id', 'deploymentRunId', 'workflow_run_id', 'workflowRunId', 'run']) {
      collectRunIds((payload as Record<string, unknown>)[key], ids);
    }
    for (const key of ['url', 'run_url', 'runUrl', 'log_url', 'logUrl']) {
      collectRunIds((payload as Record<string, unknown>)[key], ids);
    }
  }
  collectRunIds(deployment.workflow_run?.id, ids);
  collectRunIds(deployment.task, ids);
  collectRunIds(deployment.ref, ids);
  collectRunIds(deployment.description, ids);
  return ids;
}

/** The run and job a deployment status references, from its log/target/environment urls. */
export function statusRunReference(status: DeploymentStatusRecord): RunReference | undefined {
  for (const url of [status.log_url, status.target_url, status.environment_url, status.description]) {
    if (typeof url !== 'string') continue;
    const run = /\/actions\/runs\/(\d+)/.exec(url);
    if (!run) continue;
    const job = /\/actions\/runs\/(\d+)\/job\/(\d+)/.exec(url);
    return { runId: run[1]!, ...(job ? { jobId: job[2]! } : {}) };
  }
  return undefined;
}

/** Every run id a deployment status references. */
export function statusRunIds(status: DeploymentStatusRecord): Set<string> {
  const ids = new Set<string>();
  for (const url of [status.log_url, status.target_url, status.environment_url, status.description]) collectRunIds(url, ids);
  return ids;
}

/** The outcome of the source association. */
export type DeploymentSourceVerdict =
  | {
    ok: true;
    environment: string;
    /** The deployment that certified it. */
    deploymentId: string;
    /** The success state that was read. */
    status: string;
    /** The run the evidence came from. */
    runId: string;
    /** The run the deployment's status pointed at. It must be the same run. */
    deploymentRunId: string;
    /** The job of the producing run, when the status named one. */
    deploymentJobId?: string;
    /** The workflow that produced the evidence run. */
    workflowName: string;
    /** The deployment's head. */
    sha: string;
    /** When the success status was created. */
    at: string;
  }
  | { ok: false; reason: string };

/**
 * Decides whether a deployment may certify the target environment for this evidence run.
 *
 * `statusesOf` reads the status list of a deployment. It takes the deployment as its argument, so the caller can
 * only read the statuses of the deployment being judged — a status of another deployment can never be substituted.
 */
export async function associateDeploymentSource(input: {
  run: EvidenceRun;
  environment: string;
  deployments: readonly DeploymentRecord[];
  statusesOf: (deployment: DeploymentRecord) => Promise<readonly DeploymentStatusRecord[]>;
}): Promise<DeploymentSourceVerdict> {
  const { run, environment, deployments, statusesOf } = input;
  // 1. Authorization: only a trusted deployment workflow may certify an environment.
  const workflow = run.workflowName ?? '';
  if (!trustedDeploymentWorkflows().includes(workflow)) {
    return { ok: false, reason: `the workflow ${workflow || '?'} is not trusted to certify an environment` };
  }
  if (run.conclusion !== 'success') {
    return { ok: false, reason: `the CI run is not successful (conclusion ${run.conclusion ?? 'unknown'})` };
  }
  const windowStart = Date.parse(run.createdAt ?? '');
  const windowEnd = Date.parse(run.updatedAt ?? '');
  if (!Number.isFinite(windowStart) || !Number.isFinite(windowEnd)) {
    return { ok: false, reason: 'the CI run window is unknown' };
  }

  const rejected: string[] = [];
  for (const deployment of deployments) {
    const id = deployment.id === undefined || deployment.id === null ? '' : String(deployment.id);
    const label = `deployment ${id || '?'}`;
    // The head must be present and equal. A missing sha is unknown, not a wildcard.
    if (deployment.sha === undefined || deployment.sha === null || deployment.sha === '') {
      rejected.push(`${label} has no sha`);
      continue;
    }
    if (deployment.sha !== run.headSha) {
      rejected.push(`${label} has another head`);
      continue;
    }
    if ((deployment.environment ?? deployment.original_environment ?? '') !== environment) {
      rejected.push(`${label} has another environment`);
      continue;
    }
    const created = Date.parse(deployment.created_at ?? '');
    if (!Number.isFinite(created) || created < windowStart || created > windowEnd) {
      rejected.push(`${label} was created outside the CI run window`);
      continue;
    }
    // 2. Causation: the deployment must name this run. The link may sit in the deployment record (a payload
    //    reference, as some integrations put it there) or in its status — for a real GitHub deployment the record
    //    itself carries no run reference and the status' log_url/target_url is what names the producing run.
    let statuses: readonly DeploymentStatusRecord[];
    try {
      statuses = await statusesOf(deployment);
    } catch (error) {
      return { ok: false, reason: `the ${label} statuses could not be read: ${(error as Error).message.slice(0, 120)}` };
    }
    if (!statuses.length) {
      rejected.push(`${label} has no status`);
      continue;
    }
    // The link must hold for the deployment as a whole: the record may name the run, and so must the status that
    // reports the outcome. A deployment whose status names a different run was produced by that other run.
    const recordReferences = deploymentRunIds(deployment);
    const linkedStatuses = statuses.filter(status => statusRunIds(status).has(run.runId));
    if (!recordReferences.has(run.runId) && !linkedStatuses.length) {
      rejected.push(`${label} does not reference the evidence run ${run.runId}`);
      continue;
    }
    // The success must be a terminal state that also names this run.
    const success = linkedStatuses.find(status => SUCCESS_DEPLOYMENT_STATES.includes((status.state ?? '').toLowerCase()));
    if (!success) {
      const states = statuses.map(status => (status.state ?? 'unknown').toLowerCase()).join(', ') || 'none';
      rejected.push(`${label} has no successful status for run ${run.runId} (states: ${states})`);
      continue;
    }
    const at = success.created_at ?? deployment.created_at ?? new Date().toISOString();
    // The success cannot predate the deployment it reports.
    if (Date.parse(at) < created) {
      rejected.push(`${label} success status predates the deployment`);
      continue;
    }
    const reference = statusRunReference(success);
    return {
      ok: true,
      environment,
      deploymentId: id,
      status: (success.state ?? '').toLowerCase(),
      runId: run.runId,
      deploymentRunId: reference?.runId ?? run.runId,
      ...(reference?.jobId ? { deploymentJobId: reference.jobId } : {}),
      workflowName: workflow,
      sha: deployment.sha,
      at,
    };
  }
  return { ok: false, reason: `no deployment of this run certifies environment ${environment}: ${rejected.join('; ') || 'no candidate'}` };
}
