/**
 * The GitHub Actions runs of one submitted sha, grouped by what they mean for a submit:
 * success verifies the work, waiting means CI has not finished yet (a normal wait), failed means CI ran and refused it.
 */
export interface ActionRuns {
  success: string[];
  /** Runs queued, in progress or not yet reported for the sha: CI is still running. */
  waiting: number;
  /** Completed runs whose conclusion is not success. */
  failed: string[];
}

const RUN_URL = /^https:\/\/github\.com\//;
const MAX_SUCCESS = 5;

/**
 * Reads the output of `gh api repos/<slug>/actions/runs?head_sha=<sha>` filtered by jq to one line per run:
 * `status<TAB>conclusion<TAB>html_url`. Lines that are not such a run are ignored.
 */
export function parseActionRuns(out: string): ActionRuns {
  const runs: ActionRuns = { success: [], waiting: 0, failed: [] };
  for (const line of out.split(/\r?\n/)) {
    const [status = '', conclusion = '', url = ''] = line.split('\t');
    if (!RUN_URL.test(url.trim())) continue;
    if (status.trim() !== 'completed') runs.waiting++;
    else if (conclusion.trim() === 'success') { if (runs.success.length < MAX_SUCCESS) runs.success.push(url.trim()); }
    else runs.failed.push(url.trim());
  }
  return runs;
}
