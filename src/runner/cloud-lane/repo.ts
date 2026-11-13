/**
 * 云端通道的仓库助手：识别 GitHub 工作树、保证分支在远端、创建/查找 PR、快进本地。
 * 所有命令经注入的 exec 运行，测试里全部替身化，不碰真实 git/gh。
 */

export interface ExecResult { code: number; stdout: string; stderr: string }
export type ExecFn = (cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number }) => Promise<ExecResult>;

export interface RepoInfo {
  /** owner/repo */
  slug: string;
  owner: string;
  repo: string;
  branch: string;
  defaultBranch: string;
}

const GH_REMOTE = /github\.com[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/;

async function must(exec: ExecFn, cmd: string, args: string[], cwd: string, what: string): Promise<string> {
  const r = await exec(cmd, args, { cwd });
  if (r.code !== 0) throw new Error(`${what}失败：${(r.stderr || r.stdout).trim().slice(0, 400)}`);
  return r.stdout.trim();
}

/** cwd 是 GitHub 工作树时返回仓库信息；否则 undefined（员工按非代码任务受阻处理）。 */
export async function repoInfo(exec: ExecFn, cwd: string): Promise<RepoInfo | undefined> {
  const inside = await exec('git', ['rev-parse', '--is-inside-work-tree'], { cwd });
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') return undefined;
  const remote = await exec('git', ['remote', 'get-url', 'origin'], { cwd });
  const match = GH_REMOTE.exec(remote.stdout.trim());
  if (remote.code !== 0 || !match) return undefined;
  const branch = (await must(exec, 'git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwd, '读取当前分支')) || 'HEAD';
  let defaultBranch = '';
  const view = await exec('gh', ['repo', 'view', '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'], { cwd });
  if (view.code === 0 && view.stdout.trim()) defaultBranch = view.stdout.trim();
  if (!defaultBranch) {
    const head = await exec('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd });
    if (head.code === 0 && head.stdout.trim()) defaultBranch = head.stdout.trim().replace(/^origin\//, '');
  }
  if (!defaultBranch) defaultBranch = 'main';
  return { slug: `${match[1]}/${match[2]}`, owner: match[1]!, repo: match[2]!, branch, defaultBranch };
}

/** 分支不在 origin 上时先推上去；云端 agent 只能看远端分支。 */
export async function ensureBranchOnOrigin(exec: ExecFn, cwd: string, branch: string): Promise<void> {
  const remote = await exec('git', ['ls-remote', '--heads', 'origin', branch], { cwd });
  if (remote.code !== 0) throw new Error(`查询远端分支失败：${remote.stderr.trim().slice(0, 300)}`);
  if (remote.stdout.trim()) return;
  await must(exec, 'git', ['push', '-u', 'origin', branch], cwd, '推送分支到 origin');
}

/** 任务分支已有 PR 返回其 URL，否则创建一条。 */
export async function ensurePullRequest(exec: ExecFn, cwd: string, repo: RepoInfo, title: string, body: string): Promise<string> {
  const list = await exec('gh', ['pr', 'list', '--head', repo.branch, '--json', 'url', '--limit', '1'], { cwd });
  if (list.code === 0) {
    try {
      const rows = JSON.parse(list.stdout) as Array<{ url?: string }>;
      if (rows[0]?.url) return rows[0].url;
    } catch { /* 按列表为空继续创建 */ }
  }
  const created = await exec('gh', ['pr', 'create', '--base', repo.defaultBranch, '--head', repo.branch,
    '--title', title, '--body', body], { cwd });
  if (created.code !== 0) throw new Error(`创建 PR 失败：${created.stderr.trim().slice(0, 400)}`);
  const url = created.stdout.trim().split(/\s+/).find(part => part.startsWith('http'));
  if (!url) throw new Error('创建 PR 失败：输出中没有 PR 链接');
  return url;
}

/** 云端 agent 直接在远端分支上提交后，把本地工作树快进到远端；非快进即报错（绝不 reset）。 */
export async function fetchAndFastForward(exec: ExecFn, cwd: string, branch: string): Promise<string> {
  await must(exec, 'git', ['fetch', 'origin', branch], cwd, '拉取远端分支');
  const merge = await exec('git', ['merge', '--ff-only', 'FETCH_HEAD'], { cwd });
  if (merge.code !== 0) throw new Error(`本地分支与云端结果不能快进合并（可能已有本地改动）：${merge.stderr.trim().slice(0, 300)}`);
  return must(exec, 'git', ['rev-parse', 'HEAD'], cwd, '读取本地 HEAD');
}
