/**
 * SYS02 N1-R: the source association between a CI evidence run and the deployment that certified the target
 * environment.
 *
 * Three independent checks, all required:
 *
 *  1. **Authorization** — only a trusted deployment workflow may certify an environment. A generic CI run (a quality
 *     gate, a channel build) proves that the commit builds; it says nothing about what was deployed where.
 *  2. **Causation** — the deployment must be *produced by this run*. GitHub records the producing run in the
 *     deployment's status: `log_url` / `target_url` point at `.../actions/runs/<runId>/job/<jobId>`. The deployment
 *     and its success status must name the evidence run.
 *  3. **Job identity** — when a deploy job is named, that job is read back from the repository and must belong to
 *     this run and this head. A job id that resolves to another run is refused.
 *
 * Why all three: "same head, same environment name, close in time" proves nothing — a successful generic CI run and
 * an unrelated failed deployment of the same commit share all three. That was the N1-R hole. The run link is the
 * fact that cannot be borrowed, so a borrowed deployment fails even when its workflow would have been trusted.
 *
 * Fail-closed rules, each of which is a rejection and never a warning:
 *
 *  - A reference that names **another** run — in the record or in any status — is a contradiction, and no
 *    corroborating channel rescues it. A deployment that says "run 999 produced me" fails even when a status of the
 *    same deployment points at run 100.
 *  - Only the URL shape `/actions/runs/<id>[/job/<id>]` counts as a link. A bare number in free text (a status
 *    `description`, a deployment `task`/`ref`) is writable by whoever created it and is never a link.
 *  - The success terminal state must be read, and it must belong to this run — unless the record itself names the
 *    run, in which case the success must name no other run.
 *  - A named job that cannot be read back, or that belongs to another run or head, fails the association.
 *
 * Everything here is pure: the caller supplies the records it read and a reader for the repository's jobs; the
 * function decides. The caller may not pass in a verdict, a label or a payload it asserts — only raw records.
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
  workflow_run?: { id?: number | string | null; url?: string | null } | null;
  task?: string | null;
  description?: string | null;
  ref?: string | null;
}

/** A deployment status record as read from `repos/{owner}/{repo}/deployments/{id}/statuses`. */
export interface DeploymentStatusRecord {
  state?: string | null;
  environment?: string | null;
  created_at?: string | null;
  /** The log of the deployment; a workflow-backed deployment points at the run and job that produced it. */
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

/** A job as read from `repos/{owner}/{repo}/actions/jobs/{jobId}`. */
export interface JobRecord {
  runId?: string | null;
  headSha?: string | null;
  name?: string | null;
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

/** The Actions run/job link, the only shape GitHub writes for a workflow-backed deployment. */
const RUN_LINK = /\/actions\/runs\/(\d+)(?:\/job\/(\d+))?/g;

/** Every run/job link inside a free-text value. A bare number is not a link, and never read as one. */
function linkReferences(value: unknown): RunReference[] {
  if (typeof value !== 'string') return [];
  const out: RunReference[] = [];
  for (const match of value.matchAll(RUN_LINK)) {
    out.push({ runId: match[1]!, ...(match[2] ? { jobId: match[2] } : {}) });
  }
  return out;
}

/**
 * The run ids a *structured* field names. A payload key (`run_id`, `workflow_run.id`) is written by the deployment's
 * creator too, but it is a declared field rather than prose, so a bare id counts — while a free-text field accepts
 * only the link shape.
 */
function fieldRunIds(value: unknown): string[] {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return [String(value)];
  if (typeof value !== 'string') return [];
  if (/^\d+$/.test(value)) return [value];
  return linkReferences(value).map(reference => reference.runId);
}

/** The job ids a structured field names. */
function fieldJobIds(value: unknown): string[] {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return [String(value)];
  if (typeof value !== 'string') return [];
  if (/^\d+$/.test(value)) return [value];
  return linkReferences(value).flatMap(reference => (reference.jobId ? [reference.jobId] : []));
}

/**
 * The runs and jobs a deployment record names.
 *
 * `payload` run/job keys and `workflow_run` are declared fields; `task`/`ref`/`description` are free text and only
 * contribute a link. Nothing here decides anything on its own — a record reference is one side of the association,
 * and a reference to a *different* run is a contradiction the caller must refuse.
 */
export function recordReferences(deployment: DeploymentRecord): { runIds: Set<string>; jobIds: Set<string> } {
  const runIds = new Set<string>();
  const jobIds = new Set<string>();
  const payload = deployment.payload;
  if (payload && typeof payload === 'object') {
    const fields = payload as Record<string, unknown>;
    for (const key of ['run_id', 'runId', 'deployment_run_id', 'deploymentRunId', 'workflow_run_id', 'workflowRunId', 'run']) {
      for (const id of fieldRunIds(fields[key])) runIds.add(id);
    }
    for (const key of ['url', 'run_url', 'runUrl', 'log_url', 'logUrl']) {
      for (const reference of linkReferences(fields[key])) {
        runIds.add(reference.runId);
        if (reference.jobId) jobIds.add(reference.jobId);
      }
    }
    for (const key of ['job_id', 'jobId', 'deployment_job_id', 'deploymentJobId']) {
      for (const id of fieldJobIds(fields[key])) jobIds.add(id);
    }
  }
  const workflowRun = deployment.workflow_run;
  if (workflowRun) {
    for (const id of fieldRunIds(workflowRun.id)) runIds.add(id);
    for (const reference of linkReferences(workflowRun.url)) {
      runIds.add(reference.runId);
      if (reference.jobId) jobIds.add(reference.jobId);
    }
  }
  for (const value of [deployment.task, deployment.ref, deployment.description]) {
    for (const reference of linkReferences(value)) {
      runIds.add(reference.runId);
      if (reference.jobId) jobIds.add(reference.jobId);
    }
  }
  return { runIds, jobIds };
}

/**
 * The run/job a deployment status points at. Only the URL fields count: a real GitHub deployment status links the
 * producing run in `log_url`/`target_url`, while `description` is free text the creator writes.
 */
export function statusReferences(status: DeploymentStatusRecord): RunReference[] {
  const out: RunReference[] = [];
  for (const url of [status.log_url, status.target_url, status.environment_url]) out.push(...linkReferences(url));
  return out;
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
    /** The job of the producing run, when one was named and read back as this run's and this head's. */
    deploymentJobId?: string;
    /** True when at least one named job was read back and matched this run and head. */
    jobVerified?: boolean;
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
 * `jobOf` reads a job of the repository; it is required as soon as a record names a job.
 */
export async function associateDeploymentSource(input: {
  run: EvidenceRun;
  environment: string;
  deployments: readonly DeploymentRecord[];
  statusesOf: (deployment: DeploymentRecord) => Promise<readonly DeploymentStatusRecord[]>;
  jobOf?: (jobId: string) => Promise<JobRecord>;
}): Promise<DeploymentSourceVerdict> {
  const { run, environment, deployments, statusesOf, jobOf } = input;
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

  const refused: string[] = [];
  for (const deployment of deployments) {
    const id = deployment.id === undefined || deployment.id === null ? '' : String(deployment.id);
    const label = `deployment ${id || '?'}`;
    const reject = (why: string): string => `${label} ${why}`;
    // The head must be present and equal. A missing sha is unknown, not a wildcard.
    if (deployment.sha === undefined || deployment.sha === null || deployment.sha === '') {
      refused.push(reject('has no sha'));
      continue;
    }
    if (deployment.sha !== run.headSha) {
      refused.push(reject('has another head'));
      continue;
    }
    if ((deployment.environment ?? deployment.original_environment ?? '') !== environment) {
      refused.push(reject('has another environment'));
      continue;
    }
    const created = Date.parse(deployment.created_at ?? '');
    if (!Number.isFinite(created) || created < windowStart || created > windowEnd) {
      refused.push(reject('was created outside the CI run window'));
      continue;
    }
    let statuses: readonly DeploymentStatusRecord[];
    try {
      statuses = await statusesOf(deployment);
    } catch (error) {
      return { ok: false, reason: `the ${label} statuses could not be read: ${(error as Error).message.slice(0, 120)}` };
    }
    if (!statuses.length) {
      refused.push(reject('has no status'));
      continue;
    }
    // 2. Causation. Every run either side names must be this run: a record that says another run produced this
    //    deployment is a contradiction, and a status that points at another run belongs to that other run — neither
    //    can be rescued by the other channel.
    const record = recordReferences(deployment);
    const statusLinks = statuses.flatMap(statusReferences);
    const foreignRun = [...record.runIds].find(id => id !== run.runId) ?? statusLinks.find(reference => reference.runId !== run.runId)?.runId;
    if (foreignRun !== undefined) {
      refused.push(reject(`names another run ${foreignRun}`));
      continue;
    }
    // 3. Job identity, before the link decision: a job id is only an assertion until it is read back, and a job that
    //    reads back as this run's job on this head is itself a causal link — server-side truth, not caller prose. So
    //    every named job is verified first, and the verified set counts as a channel below.
    const jobIds = new Set<string>(record.jobIds);
    for (const reference of statusLinks) if (reference.jobId) jobIds.add(reference.jobId);
    const verifiedJobs = new Set<string>();
    let unverified: string | undefined;
    for (const jobId of jobIds) {
      if (!jobOf) { unverified = `${label} names job ${jobId} but the deployment jobs cannot be read`; break; }
      let job: JobRecord;
      try {
        job = await jobOf(jobId);
      } catch (error) {
        return { ok: false, reason: `the ${label} job ${jobId} could not be read: ${(error as Error).message.slice(0, 120)}` };
      }
      if (String(job.runId ?? '') !== run.runId) {
        unverified = reject(`job ${jobId} belongs to run ${job.runId ?? '?'}, not run ${run.runId}`);
        break;
      }
      if ((job.headSha ?? '') !== deployment.sha) {
        unverified = reject(`job ${jobId} is not from head ${deployment.sha}`);
        break;
      }
      verifiedJobs.add(jobId);
    }
    if (unverified !== undefined) {
      refused.push(unverified);
      continue;
    }
    // 2. Causation. The deployment is causally linked when any channel establishes it: the record names this run, a
    //    status of this deployment names this run, or a named job read back as this run's job on this head. A record
    //    that names *another* run was already refused above, and no channel rescues it.
    const recordNamesRun = record.runIds.has(run.runId);
    const successful = (status: DeploymentStatusRecord) => SUCCESS_DEPLOYMENT_STATES.includes((status.state ?? '').toLowerCase());
    const linkedSuccess = statuses.find(status => successful(status) && statusReferences(status).some(reference => reference.runId === run.runId));
    const statesOf = () => statuses.map(status => (status.state ?? 'unknown').toLowerCase()).join(', ') || 'none';
    if (!recordNamesRun && !linkedSuccess && !verifiedJobs.size) {
      refused.push(reject(`has no successful status for run ${run.runId} (states: ${statesOf()})`));
      continue;
    }
    const success = linkedSuccess ?? statuses.find(successful);
    if (!success) {
      refused.push(reject(`has no successful status for run ${run.runId} (states: ${statesOf()})`));
      continue;
    }
    const at = success.created_at ?? deployment.created_at ?? new Date().toISOString();
    // The success cannot predate the deployment it reports.
    if (Date.parse(at) < created) {
      refused.push(reject('success status predates the deployment'));
      continue;
    }
    const statusJob = statusReferences(success).find(reference => reference.jobId)?.jobId;
    const jobId = statusJob ?? (verifiedJobs.size === 1 ? [...verifiedJobs][0] : undefined);
    return {
      ok: true,
      environment,
      deploymentId: id,
      status: (success.state ?? '').toLowerCase(),
      runId: run.runId,
      deploymentRunId: statusLinks.find(reference => reference.runId === run.runId)?.runId ?? run.runId,
      ...(jobId && verifiedJobs.has(jobId) ? { deploymentJobId: jobId } : {}),
      ...(verifiedJobs.size ? { jobVerified: true } : {}),
      workflowName: workflow,
      sha: deployment.sha,
      at,
    };
  }
  return { ok: false, reason: `no deployment of this run certifies environment ${environment}: ${refused.join('; ') || 'no candidate'}` };
}