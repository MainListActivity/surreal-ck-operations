import { hostIO } from './host-io.ts';

export interface PrInfo {
  url: string;
  state: string;
  mergeable?: string;
  headRefName: string;
  /** The PR's actual head commit, when gh reported it; the acceptance gate binds to this. */
  headRefOid?: string;
  checks: Array<{ name: string; conclusion?: string; state?: string; detailsUrl?: string; infrastructureBlocked?: string }>;
}

export type GhRunner = (args: string[]) => Promise<string>;
/** The PR gate's verdict: a refusal reason, and the actual head of the task branch's own PR (B2). */
export interface SubmitVerdict { reason?: string; head?: string }
export type SubmitCheck = (input: { branch?: string; text: string }) => Promise<SubmitVerdict | undefined>;

const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;
const FAILED = new Set(['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'STARTUP_FAILURE']);

/**
 * GitHub refuses to start a job when the account's payments have failed or its spending limit is reached. That refusal
 * is infrastructure, never a result of the code under test: not one step of the job ran. The message is read from the
 * check run's own annotations and is honoured only for a job that executed no step at all, so a workflow cannot earn
 * the exemption by printing a matching annotation from a step that did run.
 */
const INFRASTRUCTURE_REFUSAL = /account payments have failed|spending limit|Billing & plans/i;
const PR_REPO = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/\d+/;
const JOB_IN_DETAILS = /\/job\/(\d+)\/?$/;

/** The refusal message GitHub wrote on one check run, or undefined when it is not a refusal or cannot be read. */
const refusalAnnotation = async (run: GhRunner, owner: string, repo: string, id: string): Promise<string | undefined> => {
  try {
    const raw = JSON.parse(await run(['api', `repos/${owner}/${repo}/check-runs/${id}/annotations`])) as Array<{ message?: unknown }>;
    const hit = (Array.isArray(raw) ? raw : []).map(item => item.message).find(text => typeof text === 'string' && INFRASTRUCTURE_REFUSAL.test(text));
    return typeof hit === 'string' ? hit : undefined;
  } catch { return undefined; }
};

/** The refusal behind one reported check, when GitHub never started its job. A check without a job link is never waived. */
const checkRefusal = async (run: GhRunner, owner: string, repo: string, check: { detailsUrl?: string }): Promise<string | undefined> => {
  const id = JOB_IN_DETAILS.exec(check.detailsUrl ?? '')?.[1];
  if (id === undefined) return undefined;
  const message = await refusalAnnotation(run, owner, repo, id);
  if (message === undefined) return undefined;
  let job: { steps?: unknown };
  try { job = JSON.parse(await run(['api', `repos/${owner}/${repo}/actions/jobs/${id}`])) as { steps?: unknown }; }
  catch { return undefined; }
  // Every step still shows up on a job that ran and failed; an empty list means the job never started.
  return Array.isArray(job.steps) && job.steps.length === 0 ? message : undefined;
};

/**
 * The refusal that stopped a whole run before any step ran, or undefined when the run really executed. Read by the
 * acceptance adapter: a run whose jobs never started judged no code, so its failure is not a failure of the delivery.
 * Any job that ran a step, any unreadable job list and any unreadable annotation all mean no exemption.
 */
export async function runInfrastructureRefusal(
  run: GhRunner, owner: string, repo: string, runId: string,
): Promise<{ message: string; jobs: string[] } | undefined> {
  let jobs: Array<{ id?: number | string; name?: unknown; steps?: unknown }>;
  try {
    const raw = JSON.parse(await run(['api', `repos/${owner}/${repo}/actions/runs/${runId}/jobs`])) as { jobs?: unknown };
    jobs = Array.isArray(raw.jobs) ? (raw.jobs as typeof jobs) : [];
  } catch { return undefined; }
  if (jobs.length === 0) return undefined;
  if (jobs.some(job => !Array.isArray(job.steps) || job.steps.length > 0)) return undefined;
  for (const job of jobs) {
    const id = job.id === undefined || job.id === null ? '' : String(job.id);
    if (id === '') continue;
    const message = await refusalAnnotation(run, owner, repo, id);
    if (message !== undefined) return { message, jobs: jobs.map(job => String(job.name ?? job.id ?? '?')) };
  }
  return undefined;
}

export const extractPrUrls = (text: string): string[] => [...new Set(text.match(PR_URL) ?? [])].slice(0, 5);

/**
 * Reasons a submitted PR cannot go to review. Only the PR that carries the task's own branch is judged:
 * evidence often links other PRs for context. Pending checks are not a failure; reviewers wait for those.
 */
export function judgePr(pr: PrInfo, branch: string | undefined): string | undefined {
  if (!branch || pr.headRefName !== branch) return undefined;
  if (pr.state === 'CLOSED') return `PR ${pr.url} 已关闭且未合并，不能作为交付：重开它，或换一个 PR 再提交。`;
  if (pr.mergeable === 'CONFLICTING') return `PR ${pr.url} 与主干有冲突：先把主干合进分支并解决冲突、推送后再提交。`;
  const failed = pr.checks.filter(c => c.infrastructureBlocked === undefined && (FAILED.has(c.conclusion ?? '') || FAILED.has(c.state ?? ''))).map(c => c.name);
  if (failed.length) return `PR ${pr.url} 的 CI 未通过（${[...new Set(failed)].join('、')}）：修复并确认通过后再提交。`;
  return undefined;
}

/** The gh CLI, run by the execution host. A non-zero exit rejects with the start of its stderr. */
export const ghCli: GhRunner = async args => {
  const { code, stdout, stderr } = await hostIO().proc.run('gh', args, {
    env: { ...process.env, PATH: `${process.env.PATH ?? ''}:/opt/homebrew/bin:/usr/local/bin` }, timeoutMs: 15_000,
  });
  if (code === 0) return stdout;
  throw new Error(stderr.slice(0, 200));
};

/** Looks the linked PRs up through gh; any lookup problem lets the submission through (the reviewer still checks). */
export function createSubmitCheck(run: GhRunner = ghCli): SubmitCheck {
  return async ({ branch, text }) => {
    if (!branch) return undefined;
    let own: SubmitVerdict | undefined;
    for (const url of extractPrUrls(text)) {
      let pr: PrInfo;
      try {
        const raw = JSON.parse(await run(['pr', 'view', url, '--json', 'state,mergeable,headRefName,headRefOid,statusCheckRollup'])) as
          { state: string; mergeable?: string; headRefName: string; headRefOid?: string; statusCheckRollup?: Array<{ name?: string; context?: string; conclusion?: string; state?: string; detailsUrl?: string }> };
        const checks: PrInfo['checks'] = (raw.statusCheckRollup ?? []).map(c => ({ name: c.name ?? c.context ?? '?', conclusion: c.conclusion, state: c.state, detailsUrl: c.detailsUrl }));
        // A check GitHub refused to start is infrastructure, not a failed test: ask GitHub for the refusal before judging it.
        const target = PR_REPO.exec(url);
        if (target?.[1] !== undefined && target[2] !== undefined) {
          for (const check of checks) {
            if (!FAILED.has(check.conclusion ?? '') && !FAILED.has(check.state ?? '')) continue;
            const refusal = await checkRefusal(run, target[1], target[2], check);
            if (refusal !== undefined) check.infrastructureBlocked = refusal;
          }
        }
        pr = { url, state: raw.state, mergeable: raw.mergeable, headRefName: raw.headRefName, headRefOid: raw.headRefOid, checks };
      } catch { continue; }
      const reason = judgePr(pr, branch);
      if (reason) return { reason };
      // Only the task branch's own PR names the head the acceptance gate is bound to; other linked PRs are context.
      if (!own && pr.headRefName === branch && pr.headRefOid) own = { head: pr.headRefOid };
    }
    return own;
  };
}
