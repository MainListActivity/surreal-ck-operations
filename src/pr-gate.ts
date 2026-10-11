import { spawn } from 'node:child_process';

export interface PrInfo {
  url: string;
  state: string;
  mergeable?: string;
  headRefName: string;
  checks: Array<{ name: string; conclusion?: string; state?: string }>;
}

export type GhRunner = (args: string[]) => Promise<string>;
export type SubmitCheck = (input: { branch?: string; text: string }) => Promise<string | undefined>;

const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;
const FAILED = new Set(['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'STARTUP_FAILURE']);

export const extractPrUrls = (text: string): string[] => [...new Set(text.match(PR_URL) ?? [])].slice(0, 5);

/**
 * Reasons a submitted PR cannot go to review. Only the PR that carries the task's own branch is judged:
 * evidence often links other PRs for context. Pending checks are not a failure; reviewers wait for those.
 */
export function judgePr(pr: PrInfo, branch: string | undefined): string | undefined {
  if (!branch || pr.headRefName !== branch) return undefined;
  if (pr.state === 'CLOSED') return `PR ${pr.url} 已关闭且未合并，不能作为交付：重开它，或换一个 PR 再提交。`;
  if (pr.mergeable === 'CONFLICTING') return `PR ${pr.url} 与主干有冲突：先把主干合进分支并解决冲突、推送后再提交。`;
  const failed = pr.checks.filter(c => FAILED.has(c.conclusion ?? '') || FAILED.has(c.state ?? '')).map(c => c.name);
  if (failed.length) return `PR ${pr.url} 的 CI 未通过（${[...new Set(failed)].join('、')}）：修复并确认通过后再提交。`;
  return undefined;
}

const ghCli: GhRunner = args => new Promise((resolve, reject) => {
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
    for (const url of extractPrUrls(text)) {
      let pr: PrInfo;
      try {
        const raw = JSON.parse(await run(['pr', 'view', url, '--json', 'state,mergeable,headRefName,statusCheckRollup'])) as
          { state: string; mergeable?: string; headRefName: string; statusCheckRollup?: Array<{ name?: string; context?: string; conclusion?: string; state?: string }> };
        pr = { url, state: raw.state, mergeable: raw.mergeable, headRefName: raw.headRefName,
          checks: (raw.statusCheckRollup ?? []).map(c => ({ name: c.name ?? c.context ?? '?', conclusion: c.conclusion, state: c.state })) };
      } catch { continue; }
      const reason = judgePr(pr, branch);
      if (reason) return reason;
    }
    return undefined;
  };
}
