import { spawn } from 'node:child_process';

export interface PrInfo {
  url: string;
  state: string;
  mergeable?: string;
  headRefName: string;
  /** The PR's actual head commit, when gh reported it; the acceptance gate binds to this. */
  headRefOid?: string;
  checks: Array<{ name: string; conclusion?: string; state?: string }>;
}

export type GhRunner = (args: string[]) => Promise<string>;
/**
 * The PR gate's verdict.
 * - `reason` alone (no `ciFailed`): hard refuse (closed / conflicting).
 * - `reason` + `ciFailed` + `head`: CI red; core may substitute a host-verified managed-local-test
 *   record for owner-authorized tasks only. Pending checks are not failures.
 */
export interface SubmitVerdict {
  reason?: string;
  head?: string;
  /** Distinct failed check names when the only problem is CI red (substitutable under owner auth). */
  ciFailed?: string[];
  prUrl?: string;
}
export type SubmitCheck = (input: { branch?: string; text: string }) => Promise<SubmitVerdict | undefined>;

const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;
const FAILED = new Set(['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'STARTUP_FAILURE']);

export const extractPrUrls = (text: string): string[] => [...new Set(text.match(PR_URL) ?? [])].slice(0, 5);

export type PrJudgement =
  | { ok: true }
  | { ok: false; hard: true; reason: string }
  | { ok: false; hard: false; reason: string; failedChecks: string[] };

/**
 * Reasons a submitted PR cannot go to review. Only the PR that carries the task's own branch is judged:
 * evidence often links other PRs for context. Pending checks are not a failure; reviewers wait for those.
 * CI failures are soft (`hard: false`) so an owner-authorized managed-local-test record may substitute.
 */
export function judgePrDetailed(pr: PrInfo, branch: string | undefined): PrJudgement {
  if (!branch || pr.headRefName !== branch) return { ok: true };
  if (pr.state === 'CLOSED') {
    return { ok: false, hard: true, reason: `PR ${pr.url} 已关闭且未合并，不能作为交付：重开它，或换一个 PR 再提交。` };
  }
  if (pr.mergeable === 'CONFLICTING') {
    return { ok: false, hard: true, reason: `PR ${pr.url} 与主干有冲突：先把主干合进分支并解决冲突、推送后再提交。` };
  }
  const failed = [...new Set(pr.checks.filter(c => FAILED.has(c.conclusion ?? '') || FAILED.has(c.state ?? '')).map(c => c.name))];
  if (failed.length) {
    return {
      ok: false,
      hard: false,
      failedChecks: failed,
      reason: `PR ${pr.url} 的 CI 未通过（${failed.join('、')}）：修复并确认通过后再提交。`,
    };
  }
  return { ok: true };
}

/** String-form judgement kept for callers/tests that only need the refusal text. */
export function judgePr(pr: PrInfo, branch: string | undefined): string | undefined {
  const judged = judgePrDetailed(pr, branch);
  return judged.ok ? undefined : judged.reason;
}

export const ghCli: GhRunner = args => new Promise((resolve, reject) => {
  const child = spawn('gh', args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PATH: `${process.env.PATH ?? ''}:/opt/homebrew/bin:/usr/local/bin` } });
  let out = '', err = '';
  const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
  child.stdout.on('data', chunk => { out += chunk; });
  child.stderr.on('data', chunk => { err += chunk; });
  child.on('error', error => { clearTimeout(timer); reject(error); });
  child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(out) : reject(new Error(err.slice(0, 200))); });
});

/** Looks the linked PRs up through gh; any lookup problem lets the submission through (the reviewer still checks). */
export function createSubmitCheck(run: GhRunner = ghCli): SubmitCheck {
  return async ({ branch, text }) => {
    if (!branch) return undefined;
    let own: SubmitVerdict | undefined;
    for (const url of extractPrUrls(text)) {
      let pr: PrInfo;
      try {
        const raw = JSON.parse(await run(['pr', 'view', url, '--json', 'state,mergeable,headRefName,headRefOid,statusCheckRollup'])) as
          { state: string; mergeable?: string; headRefName: string; headRefOid?: string; statusCheckRollup?: Array<{ name?: string; context?: string; conclusion?: string; state?: string }> };
        pr = { url, state: raw.state, mergeable: raw.mergeable, headRefName: raw.headRefName, headRefOid: raw.headRefOid,
          checks: (raw.statusCheckRollup ?? []).map(c => ({ name: c.name ?? c.context ?? '?', conclusion: c.conclusion, state: c.state })) };
      } catch { continue; }
      const judged = judgePrDetailed(pr, branch);
      if (!judged.ok && judged.hard) return { reason: judged.reason };
      if (!judged.ok && !judged.hard) {
        // Soft CI failure: still name the PR head so a managed-local substitute can bind to it.
        return {
          reason: judged.reason,
          head: pr.headRefOid,
          ciFailed: judged.failedChecks,
          prUrl: pr.url,
        };
      }
      // Only the task branch's own PR names the head the acceptance gate is bound to; other linked PRs are context.
      if (!own && pr.headRefName === branch && pr.headRefOid) own = { head: pr.headRefOid };
    }
    return own;
  };
}
