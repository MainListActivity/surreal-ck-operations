export interface GitWorktree { path: string; branch?: string; isMain: boolean }

/** The sweeper's only view of git; faked in tests. */
export interface GitGateway {
  worktrees(repo: string): Promise<GitWorktree[]>;
  /** Removes a worktree without --force: git refuses when it has uncommitted or untracked changes. */
  removeWorktree(repo: string, path: string): Promise<{ ok: boolean; reason?: string }>;
  /** Deletes a branch only if it is fully merged (git branch -d). */
  deleteMergedBranch(repo: string, branch: string): Promise<boolean>;
  prune(repo: string): Promise<void>;
}

export interface SweepResult { removed: string[]; kept: Array<{ path: string; reason: string }>; branchesDeleted: string[] }

const TASK_BRANCH = /^task\/([0-9a-f]{8})$/;

/** Removes the worktree of every finished task (branch task/<id8>); anything else is left alone. */
export async function sweepWorktrees(git: GitGateway, repos: string[], doneIds: string[]): Promise<SweepResult> {
  const done = new Set(doneIds.map(id => id.slice(0, 8)));
  const result: SweepResult = { removed: [], kept: [], branchesDeleted: [] };
  for (const repo of new Set(repos)) {
    let list: GitWorktree[];
    try { list = await git.worktrees(repo); } catch { continue; }
    let touched = false;
    for (const wt of list) {
      const id8 = wt.branch ? TASK_BRANCH.exec(wt.branch)?.[1] : undefined;
      if (wt.isMain || !id8 || !done.has(id8)) continue;
      const out = await git.removeWorktree(repo, wt.path);
      if (!out.ok) { result.kept.push({ path: wt.path, reason: out.reason ?? 'unknown' }); continue; }
      touched = true;
      result.removed.push(wt.path);
      if (await git.deleteMergedBranch(repo, wt.branch!)) result.branchesDeleted.push(wt.branch!);
    }
    if (touched) await git.prune(repo);
  }
  return result;
}

export function createGitCli(): GitGateway {
  const git = async (repo: string, args: string[]) => {
    const child = Bun.spawn(['git', '-C', repo, ...args], { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { out, err: err.trim(), code };
  };
  return {
    async worktrees(repo) {
      const { out, code, err } = await git(repo, ['worktree', 'list', '--porcelain']);
      if (code !== 0) throw new Error(err);
      return out.split('\n\n').filter(Boolean).map((block, index) => {
        const lines = block.split('\n');
        const path = lines.find(l => l.startsWith('worktree '))!.slice(9);
        const branch = lines.find(l => l.startsWith('branch '))?.slice(7).replace(/^refs\/heads\//, '');
        return { path, branch, isMain: index === 0 };
      });
    },
    async removeWorktree(repo, path) {
      const { code, err } = await git(repo, ['worktree', 'remove', path]);
      return code === 0 ? { ok: true } : { ok: false, reason: err.split('\n')[0].slice(0, 200) };
    },
    async deleteMergedBranch(repo, branch) {
      return (await git(repo, ['branch', '-d', branch])).code === 0;
    },
    async prune(repo) { await git(repo, ['worktree', 'prune']); },
  };
}
